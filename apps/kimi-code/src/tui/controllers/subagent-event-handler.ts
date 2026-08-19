import type {
  BackgroundTaskInfo,
  Event,
} from '@moonshot-ai/kimi-code-sdk';
import type { Component } from '@moonshot-ai/pi-tui';

import {
  AgentSwarmProgressComponent,
  type AgentSwarmMemberSnapshot,
  agentSwarmDescriptionFromArgs,
  agentSwarmGridHeightForTerminalRows,
} from '../components/messages/agent-swarm-progress';
import {
  computeLatestActivity,
  parseArgsPreview,
  type FinishedSubCall,
  type OngoingSubCall,
  type ToolCallSubagentSnapshot,
} from '../components/messages/tool-call';
import { modelDisplayName } from '../components/dialogs/model-selector';
import { FAILURE_MARK, SUCCESS_MARK } from '../constant/symbols';
import { MAIN_AGENT_ID } from '../constant/kimi-tui';
import type {
  BackgroundAgentMetadata,
  RunningAgentSummary,
  ToolCallBlockData,
  ToolResultBlockData,
  TranscriptEntry,
} from '../types';
import type { WorkflowRunAgentStatus, WorkflowRunView } from '../utils/workflow-model';
import { formatBackgroundAgentTranscript } from '../utils/background-agent-status';
import {
  appendStreamingArgsPreview,
  argsRecord,
  serializeToolResultOutput,
} from '../utils/event-payload';
import { formatHookResultPlain } from '../utils/hook-result-format';
import { nextTranscriptId } from '../utils/transcript-id';
import { usageTotal } from '#/utils/usage/usage-format';
import type { SessionEventHost } from './session-event-handler';

/**
 * How many swarm members (or foreground subagents under one parent tool call)
 * the footer lists individually before collapsing into a single summary row
 * (see `collectRunningAgents`). At or below the limit each member gets its
 * own footer line; beyond it, one summary row.
 */
export const SWARM_MEMBER_LIMIT = 4;

/**
 * Phase-based activity fallback for footer rows. When neither the per-subagent
 * activity nor the card snapshot has a concrete activity yet, the row still
 * shows what the agent is doing so the footer never lists a bare name.
 */
const SUBAGENT_PHASE_ACTIVITY_FALLBACK: Record<RunningAgentSummary['phase'], string> = {
  running: 'working…',
  waiting: 'queued…',
  starting: 'starting…',
  done: 'done…',
  failed: 'failed…',
};

/**
 * Per-subagent activity state for footer rows. A single parent tool call can
 * host several subagents (e.g. a Workflow run fans out many agents under one
 * card), so the card-level `computeLatestActivity` snapshot cannot distinguish
 * them — mirror the same heuristic per subagent id here.
 */
interface SubagentActivity {
  /** In-flight tool calls keyed by the child's own tool-call id. */
  readonly ongoing: Map<string, OngoingSubCall>;
  /** Terminal tool calls; only the newest entry is read for the activity line. */
  readonly finished: FinishedSubCall[];
  /** Accumulated assistant/thinking/hook text, capped to bound memory. */
  text: string;
}

/** Cap for the per-subagent activity text buffer (keeps the tail line). */
const SUBAGENT_ACTIVITY_TEXT_MAX = 4_000;

export interface SubagentInfo {
  readonly parentToolCallId: string;
  readonly name: string;
  readonly description?: string;
  readonly runInBackground: boolean;
  readonly swarmIndex?: number;
  /** When the `subagent.spawned` event was observed, per agent. Distinct from
   *  the parent card's shared `subagentStartedAtMs` (last spawn wins), so
   *  workflow rows under one card can show each agent's own elapsed. */
  readonly startedAtMs: number;
}

export type SubagentLifecycleEvent = Event & { type: `subagent.${string}` };
type SubagentLifecycleEventOf<Type extends SubagentLifecycleEvent['type']> =
  SubagentLifecycleEvent & { type: Type };

export interface SubAgentEventHandlerDependencies {
  readonly backgroundTasks: ReadonlyMap<string, BackgroundTaskInfo>;
  readonly backgroundTaskTranscriptedTerminal: Set<string>;
  readonly syncBackgroundAgentBadge: () => void;
  /** Request a footer agent-row recompute after activity-ledger/token writes;
   *  the caller owns the throttle. */
  readonly syncRunningAgentsFooter: () => void;
}

function renderedRowsAfterChild(
  children: readonly Component[],
  child: Component,
  width: number,
): number {
  const childIndex = children.indexOf(child);
  if (childIndex < 0) return 0;
  return children
    .slice(childIndex + 1)
    .reduce((sum, component) => sum + component.render(width).length, 0);
}

/**
 * Like `renderedRowsAfterChild` but stops as soon as the accumulated row count
 * reaches `cap`, returning `cap`. The caller only needs to know whether the
 * rows after `child` fill the viewport, so this bounds the cost of the
 * visibility check as the transcript grows.
 */
function renderedRowsAfterChildUpTo(
  children: readonly Component[],
  child: Component,
  width: number,
  cap: number,
): number {
  const childIndex = children.indexOf(child);
  if (childIndex < 0) return 0;
  let rows = 0;
  for (let i = childIndex + 1; i < children.length; i += 1) {
    rows += children[i]!.render(width).length;
    if (rows >= cap) return cap;
  }
  return rows;
}

export class SubAgentEventHandler {
  readonly subagentInfo: Map<string, SubagentInfo> = new Map();
  private readonly agentSwarmProgress: Map<string, AgentSwarmProgressComponent> = new Map();
  backgroundAgentMetadata: Map<string, BackgroundAgentMetadata> = new Map();
  private readonly subagentActivity = new Map<string, SubagentActivity>();
  /** agentId → monotonic non-decreasing accumulated token count, fed by
   *  `agent.status.updated` (usage wins, context tokens fall back). Backs the
   *  workflow subagent rows' token counter. */
  readonly subagentTokenTotals: Map<string, number> = new Map();
  /** runId → parent Workflow tool call, claimed lazily in collectRunningAgents. */
  private readonly workflowRunParents = new Map<string, string>();
  /** Reentrancy guard for viewport-visibility re-evaluation: measuring a card
   *  renders sibling cards, whose own `availableGridHeight` callback would
   *  otherwise re-enter the same sync loop. */
  private syncingSwarmVisibility = false;

  constructor(
    private readonly host: SessionEventHost,
    private readonly deps: SubAgentEventHandlerDependencies,
  ) {}

  resetRuntimeState(): void {
    this.subagentInfo.clear();
    this.backgroundAgentMetadata.clear();
    this.subagentActivity.clear();
    this.subagentTokenTotals.clear();
    this.workflowRunParents.clear();
    this.clearAgentSwarmProgress();
  }

  routeChildAgentEvent(event: Event): boolean {
    if (isSubagentLifecycleEvent(event)) return false;

    const childAgentId = event.agentId;
    if (childAgentId === MAIN_AGENT_ID) return false;
    if (this.host.btwPanelController.routeEvent(event)) return true;

    const info = this.subagentInfo.get(childAgentId);
    if (info === undefined || info.parentToolCallId.length === 0) return true;

    const { parentToolCallId } = info;

    // The activity/token ledger is card-independent — a Workflow run keeps its
    // subagents alive after the launching turn ends (the card is cleared on
    // turn end), yet the footer workflow rows read this ledger for live
    // activity. Record it before the card checks so a missing card cannot
    // silence the footer.
    this.recordSubagentEventLedger(childAgentId, event);
    // Every routed child event can change the activity/token ledger; ask for a
    // footer recompute. The injected sync is throttled by the caller, so the
    // high-frequency `tool.progress` stdout/stderr bursts are fine to include.
    this.deps.syncRunningAgentsFooter();

    const swarmProgress = this.agentSwarmProgress.get(parentToolCallId);
    if (swarmProgress !== undefined) {
      this.applySubagentEventToSwarmProgress(swarmProgress, event, childAgentId);
      this.requestRender();
      return true;
    }

    const toolCall = this.host.streamingUI.getToolComponent(parentToolCallId);
    if (toolCall === undefined) return true;
    toolCall.setSubagentMeta(childAgentId, info.name);

    // Card-side rendering only — ledger writes live in
    // `recordSubagentEventLedger`, which runs even when the card is gone.

    if (event.type === 'hook.result') {
      toolCall.appendSubagentText(formatHookResultPlain(event), 'text');
    } else if (event.type === 'assistant.delta') {
      toolCall.appendSubagentText(event.delta, 'text');
    } else if (event.type === 'thinking.delta') {
      toolCall.appendSubagentText(event.delta, 'thinking');
    } else if (event.type === 'tool.call.started') {
      toolCall.appendSubToolCall({
        id: `${childAgentId}:${event.toolCallId}`,
        name: event.name,
        args: argsRecord(event.args),
      });
    } else if (event.type === 'tool.call.delta') {
      toolCall.appendSubToolCallDelta({
        id: `${childAgentId}:${event.toolCallId}`,
        name: event.name,
        argumentsPart: event.argumentsPart ?? null,
      });
    } else if (
      event.type === 'tool.progress' &&
      (event.update.kind === 'stdout' || event.update.kind === 'stderr') &&
      event.update.text !== undefined
    ) {
      toolCall.appendSubToolLiveOutput(`${childAgentId}:${event.toolCallId}`, event.update.text);
    } else if (event.type === 'tool.result') {
      toolCall.finishSubToolCall({
        tool_call_id: `${childAgentId}:${event.toolCallId}`,
        output: serializeToolResultOutput(event.output),
        is_error: event.isError,
      });
    } else if (event.type === 'agent.status.updated') {
      const usageObj = event.usage;
      const totalUsage = usageObj?.total ?? usageObj?.currentTurn;
      toolCall.updateSubagentMetrics({
        contextTokens: event.contextTokens,
        usage: totalUsage,
        // The bound model alias rides every child status update (emitted right
        // after spawn); surface it on the subagent card. `modelDisplayName`
        // falls back to the alias itself when the entry is unknown (e.g. the
        // synthesized `__secondary__` derived entry is missing).
        modelDisplay:
          event.model === undefined
            ? undefined
            : modelDisplayName(event.model, this.host.state.appState.availableModels[event.model]),
        effortDisplay: this.subagentEffortDisplay(event.thinkingEffort),
      });
    }
    return true;
  }

  /**
   * Fold one routed child event into the per-agent activity/token ledger.
   * Runs before any card check so the footer keeps live activity while a
   * Workflow run outlives its launching turn (the card is cleared on turn
   * end). Card-side rendering is the caller's responsibility.
   */
  private recordSubagentEventLedger(childAgentId: string, event: Event): void {
    if (event.type === 'hook.result') {
      this.recordSubagentText(childAgentId, formatHookResultPlain(event));
    } else if (event.type === 'assistant.delta') {
      this.recordSubagentText(childAgentId, event.delta);
    } else if (event.type === 'thinking.delta') {
      this.recordSubagentText(childAgentId, event.delta);
    } else if (event.type === 'tool.call.started') {
      this.recordSubagentToolCall(childAgentId, event.toolCallId, event.name, argsRecord(event.args));
    } else if (event.type === 'tool.call.delta') {
      this.recordSubagentToolCallDelta(
        childAgentId,
        event.toolCallId,
        event.name,
        event.argumentsPart ?? null,
      );
    } else if (event.type === 'tool.result') {
      this.recordSubagentToolResult(childAgentId, event.toolCallId, event.isError);
    } else if (event.type === 'agent.status.updated') {
      // Cumulative usage (input + output) wins so the footer count reflects
      // tokens actually consumed and stays monotonic; context tokens are only
      // a fallback until usage is reported (they measure the live window,
      // which shrinks on compaction). Mirrors `recordMemberUsage`.
      const usageObj = event.usage;
      const totalUsage = usageObj?.total ?? usageObj?.currentTurn;
      const totalTokens = usageTotal(totalUsage);
      const tokens =
        totalTokens > 0
          ? totalTokens
          : event.contextTokens !== undefined && event.contextTokens > 0
            ? event.contextTokens
            : 0;
      if (tokens > 0) {
        const previous = this.subagentTokenTotals.get(childAgentId) ?? 0;
        this.subagentTokenTotals.set(childAgentId, Math.max(previous, tokens));
      }
    }
  }

  handleLifecycleEvent(event: SubagentLifecycleEvent): void {
    switch (event.type) {
      case 'subagent.spawned':
        this.handleSubagentSpawned(event);
        return;
      case 'subagent.started':
        this.handleSubagentStarted(event);
        return;
      case 'subagent.suspended':
        this.handleSubagentSuspended(event);
        return;
      case 'subagent.completed':
        this.handleSubagentCompleted(event);
        return;
      case 'subagent.failed':
        this.handleSubagentFailed(event);
        return;
    }
  }

  clearAgentSwarmProgress(): void {
    for (const progress of this.agentSwarmProgress.values()) {
      progress.dispose();
    }
    this.agentSwarmProgress.clear();
    this.host.updateActivityPane();
  }

  hasAgentSwarmProgress(toolCallId: string): boolean {
    return this.agentSwarmProgress.has(toolCallId);
  }

  hasActiveAgentSwarmToolCall(): boolean {
    return Array.from(this.agentSwarmProgress.values()).some((progress) =>
      progress.isToolCallActive()
    );
  }

  syncAgentSwarmActivitySpinner(
    spinner: { renderInline(): string } | undefined,
  ): void {
    for (const progress of this.agentSwarmProgress.values()) {
      progress.setActivitySpinnerText(
        spinner === undefined ? undefined : () => spinner.renderInline(),
      );
    }
  }

  handleAgentSwarmToolCallStarted(
    toolCallId: string,
    args: Record<string, unknown>,
  ): void {
    const progress = this.ensureAgentSwarmProgress(toolCallId, args);
    progress.markInputComplete();
    this.requestRender();
  }

  handleAgentSwarmToolCallDelta(
    toolCallId: string,
    args: Record<string, unknown>,
    options: { readonly streamingArguments?: string | undefined },
  ): void {
    this.ensureAgentSwarmProgress(toolCallId, args, options);
    this.requestRender();
  }

  handleAgentSwarmToolResult(
    toolCallId: string,
    resultData: ToolResultBlockData,
    isError: boolean,
  ): void {
    const progress = this.agentSwarmProgress.get(toolCallId);
    if (progress === undefined) return;

    if (isError && isUserCancelledSubagentError(resultData.output)) {
      if (progress.isRequestStreaming()) {
        this.removeAgentSwarmProgress(toolCallId, progress);
      } else {
        progress.markToolCallEnded();
        progress.markActiveCancelled();
      }
    } else if (isError) {
      progress.markToolCallEnded();
      if (!progress.applyResult(resultData.output)) {
        progress.markSwarmFailed(resultData.output);
      }
    } else {
      progress.markToolCallEnded();
      progress.applyResult(resultData.output);
    }
    this.host.updateActivityPane();
    this.requestRender();
  }

  markActiveAgentSwarmsCancelled(): void {
    let updated = false;
    for (const [toolCallId, progress] of this.agentSwarmProgress) {
      if (progress.isRequestStreaming()) {
        this.removeAgentSwarmProgress(toolCallId, progress);
        updated = true;
        continue;
      }
      progress.markActiveCancelled();
      updated = true;
    }
    if (updated) this.requestRender();
  }

  private handleSubagentSpawned(
    event: SubagentLifecycleEventOf<'subagent.spawned'>,
  ): void {
    this.rememberSubagent(event);

    if (event.runInBackground) {
      const meta = this.buildBackgroundAgentMetadata(event);
      this.backgroundAgentMetadata.set(event.subagentId, meta);
      this.appendBackgroundAgentEntry('started', meta);
      this.deps.syncBackgroundAgentBadge();
      return;
    }

    this.handleForegroundSubagentSpawned(event);
  }

  private handleSubagentStarted(
    event: SubagentLifecycleEventOf<'subagent.started'>,
  ): void {
    const info = this.subagentInfo.get(event.subagentId);
    if (info === undefined) return;
    if (!info.runInBackground) this.handleForegroundSubagentStarted(event, info);
  }

  private handleSubagentSuspended(
    event: SubagentLifecycleEventOf<'subagent.suspended'>,
  ): void {
    const info = this.subagentInfo.get(event.subagentId);
    if (info === undefined) return;
    if (!info.runInBackground) this.handleForegroundSubagentSuspended(event, info);
  }

  private handleSubagentCompleted(
    event: SubagentLifecycleEventOf<'subagent.completed'>,
  ): void {
    const backgroundMeta = this.backgroundAgentMetadata.get(event.subagentId);
    if (backgroundMeta !== undefined) {
      const taskId = this.findAgentTaskId(
        event.subagentId,
        backgroundMeta,
        this.deps.backgroundTasks,
      );
      this.backgroundAgentMetadata.delete(event.subagentId);
      this.deps.syncBackgroundAgentBadge();
      if (taskId !== undefined && this.deps.backgroundTaskTranscriptedTerminal.has(taskId)) {
        return;
      }
      if (taskId !== undefined) {
        this.deps.backgroundTaskTranscriptedTerminal.add(taskId);
      }
      const extras =
        event.resultSummary === undefined ? undefined : { resultSummary: event.resultSummary };
      this.appendBackgroundAgentEntry('completed', backgroundMeta, extras);
      return;
    }

    const info = this.subagentInfo.get(event.subagentId);
    if (info === undefined || info.runInBackground) return;
    this.subagentActivity.delete(event.subagentId);
    this.handleForegroundSubagentCompleted(event, info);
  }

  private handleSubagentFailed(
    event: SubagentLifecycleEventOf<'subagent.failed'>,
  ): void {
    const backgroundMeta = this.backgroundAgentMetadata.get(event.subagentId);
    if (backgroundMeta !== undefined) {
      const taskId = this.findAgentTaskId(
        event.subagentId,
        backgroundMeta,
        this.deps.backgroundTasks,
      );
      const task = taskId === undefined ? undefined : this.deps.backgroundTasks.get(taskId);
      this.backgroundAgentMetadata.delete(event.subagentId);
      this.deps.syncBackgroundAgentBadge();
      if (task?.kind === 'agent' && task.status === 'timed_out') {
        return;
      }
      this.host.streamingUI.applyBackgroundTaskTerminalStatus({
        agentId: event.subagentId,
        description: backgroundMeta.description ?? '',
        status: 'failed',
        errorText: event.error,
      });
      if (taskId !== undefined && this.deps.backgroundTaskTranscriptedTerminal.has(taskId)) {
        return;
      }
      if (taskId !== undefined) {
        this.deps.backgroundTaskTranscriptedTerminal.add(taskId);
      }
      this.appendBackgroundAgentEntry('failed', backgroundMeta, { error: event.error });
      return;
    }

    const info = this.subagentInfo.get(event.subagentId);
    if (info === undefined || info.runInBackground) return;
    this.subagentActivity.delete(event.subagentId);
    this.handleForegroundSubagentFailed(event, info);
  }

  private findAgentTaskId(
    subagentId: string,
    meta: BackgroundAgentMetadata,
    backgroundTasks: ReadonlyMap<string, BackgroundTaskInfo>,
  ): string | undefined {
    for (const info of backgroundTasks.values()) {
      if (info.kind !== 'agent') continue;
      if (info.agentId === subagentId) return info.taskId;
    }
    const description = meta.description ?? meta.agentName;
    if (description === undefined) return undefined;
    let match: string | undefined;
    for (const info of backgroundTasks.values()) {
      if (info.kind !== 'agent') continue;
      if (info.description !== description) continue;
      if (match !== undefined) return undefined;
      match = info.taskId;
    }
    return match;
  }

  private buildBackgroundAgentMetadata(
    event: SubagentLifecycleEventOf<'subagent.spawned'>,
  ): BackgroundAgentMetadata {
    const parent = this.host.streamingUI.getActiveToolCall(event.parentToolCallId);
    const description = parent?.args['description'] ?? event.description;
    return {
      agentId: event.subagentId,
      parentToolCallId: event.parentToolCallId,
      agentName: event.subagentName,
      description: typeof description === 'string' ? description : undefined,
      model: this.spawnedModelDisplay(event),
      effort: this.subagentEffortDisplay(event.thinkingEffort),
    };
  }

  private appendBackgroundAgentEntry(
    phase: 'started' | 'completed' | 'failed',
    meta: BackgroundAgentMetadata,
    extras: { resultSummary?: string; error?: string } | undefined = undefined,
  ): void {
    const status = formatBackgroundAgentTranscript(phase, meta, extras);
    const entry: TranscriptEntry = {
      id: nextTranscriptId(),
      kind: 'status',
      turnId: this.host.streamingUI.getTurnContext().turnId,
      renderMode: 'plain',
      content: status.headline,
      detail: status.detail,
      backgroundAgentStatus: status,
    };
    this.host.appendTranscriptEntry(entry);
  }

  private rememberSubagent(
    event: SubagentLifecycleEventOf<'subagent.spawned'>,
  ): void {
    this.subagentInfo.set(event.subagentId, {
      parentToolCallId: event.parentToolCallId,
      name: event.subagentName,
      description: event.description,
      runInBackground: event.runInBackground,
      swarmIndex: event.swarmIndex,
      startedAtMs: Date.now(),
    });
  }

  private handleForegroundSubagentSpawned(
    event: SubagentLifecycleEventOf<'subagent.spawned'>,
  ): void {
    // The spawned event carries the display-normalized bound alias (newer
    // cores) — show it at spawn instead of waiting for the child's first
    // status frame. The `agent.status.updated` channel below stays as the
    // in-run update/fallback path.
    const modelDisplay = this.spawnedModelDisplay(event);
    const effortDisplay = this.subagentEffortDisplay(event.thinkingEffort);
    if (this.updateAgentSwarmProgress(event.parentToolCallId, (progress) => {
      progress.registerSubagent({
        agentId: event.subagentId,
        swarmIndex: event.swarmIndex,
      });
      if (modelDisplay !== undefined) progress.setModelDisplay(modelDisplay);
      if (effortDisplay !== undefined) progress.setEffortDisplay(effortDisplay);
    })) {
      return;
    }

    let tc = this.getOrActivateToolComponent(event.parentToolCallId);
    tc ??= this.createStandaloneSubagentToolCall(event);
    if (tc === undefined) return;
    tc.onSubagentSpawned({
      agentId: event.subagentId,
      agentName: event.subagentName,
      runInBackground: event.runInBackground,
    });
    if (modelDisplay !== undefined || effortDisplay !== undefined) {
      tc.updateSubagentMetrics({ modelDisplay, effortDisplay });
    }
  }

  /** Map the spawned event's bound alias to a display name via the loaded
   *  model catalog; falls back to the alias itself for unknown entries. */
  private spawnedModelDisplay(
    event: SubagentLifecycleEventOf<'subagent.spawned'>,
  ): string | undefined {
    if (event.model === undefined) return undefined;
    return modelDisplayName(event.model, this.host.state.appState.availableModels[event.model]);
  }

  /** Concrete effort levels are always shown; the boolean states carry no
   *  level information — 'off' (no thinking) and 'on' (generic thinking) are
   *  both hidden. */
  private subagentEffortDisplay(effort: string | undefined): string | undefined {
    if (effort === undefined || effort === 'off' || effort === 'on') return undefined;
    return effort;
  }

  private handleForegroundSubagentStarted(
    event: SubagentLifecycleEventOf<'subagent.started'>,
    info: SubagentInfo,
  ): void {
    if (this.updateAgentSwarmProgress(info.parentToolCallId, (progress) => {
      progress.markStarted(event.subagentId);
    })) {
      return;
    }

    const tc = this.getOrActivateToolComponent(info.parentToolCallId);
    if (tc === undefined) return;
    tc.onSubagentStarted({
      agentId: event.subagentId,
      agentName: info.name,
      runInBackground: info.runInBackground,
    });
  }

  private handleForegroundSubagentSuspended(
    event: SubagentLifecycleEventOf<'subagent.suspended'>,
    info: SubagentInfo,
  ): void {
    this.updateAgentSwarmProgress(info.parentToolCallId, (progress) => {
      progress.markSuspended({
        agentId: event.subagentId,
        reason: event.reason,
        swarmIndex: info.swarmIndex,
      });
    });
  }

  private handleForegroundSubagentCompleted(
    event: SubagentLifecycleEventOf<'subagent.completed'>,
    info: SubagentInfo,
  ): void {
    const { parentToolCallId } = info;
    if (this.updateAgentSwarmProgress(parentToolCallId, (progress) => {
      progress.markCompleted(event.subagentId, event.resultSummary);
    })) {
      this.host.streamingUI.removeToolComponentIfInactive(parentToolCallId);
      return;
    }

    const tc = this.host.streamingUI.getToolComponent(parentToolCallId);
    if (tc === undefined) return;
    tc.onSubagentCompleted({
      contextTokens: event.contextTokens,
      usage: event.usage,
      resultSummary: event.resultSummary,
    });
    this.host.streamingUI.removeToolComponentIfInactive(parentToolCallId);
  }

  private handleForegroundSubagentFailed(
    event: SubagentLifecycleEventOf<'subagent.failed'>,
    info: SubagentInfo,
  ): void {
    const { parentToolCallId } = info;
    if (this.updateAgentSwarmProgress(parentToolCallId, (progress) => {
      this.markAgentSwarmFailedOrCancelled(progress, event.subagentId, event.error);
    })) {
      this.host.streamingUI.removeToolComponentIfInactive(parentToolCallId);
      return;
    }

    const tc = this.host.streamingUI.getToolComponent(parentToolCallId);
    if (tc === undefined) return;
    tc.onSubagentFailed({ error: event.error });
    this.host.streamingUI.removeToolComponentIfInactive(parentToolCallId);
  }

  private applySubagentEventToSwarmProgress(
    progress: AgentSwarmProgressComponent,
    event: Event,
    subagentId: string,
  ): void {
    if (event.type === 'assistant.delta' || event.type === 'thinking.delta') {
      progress.appendModelDelta({ agentId: subagentId, delta: event.delta });
    } else if (event.type === 'tool.call.started') {
      progress.recordToolCall({ agentId: subagentId, toolCallId: event.toolCallId });
    } else if (event.type === 'agent.status.updated') {
      if (event.model !== undefined) {
        // The bound model alias rides every child status update (emitted right
        // after spawn). Swarm members share one binding, so the panel shows it
        // once in the header instead of per cell. `modelDisplayName` falls back
        // to the alias itself when the entry is unknown (e.g. the synthesized
        // `__secondary__` derived entry is missing).
        progress.setModelDisplay(
          modelDisplayName(event.model, this.host.state.appState.availableModels[event.model]),
        );
        const effortDisplay = this.subagentEffortDisplay(event.thinkingEffort);
        if (effortDisplay !== undefined) progress.setEffortDisplay(effortDisplay);
      }
      const usageObj = event.usage;
      const totalUsage = usageObj?.total ?? usageObj?.currentTurn;
      if (event.contextTokens !== undefined || totalUsage !== undefined) {
        progress.recordMemberUsage(subagentId, totalUsage, event.contextTokens);
      }
    }
  }

  private updateAgentSwarmProgress(
    parentToolCallId: string,
    update: (progress: AgentSwarmProgressComponent) => void,
  ): boolean {
    const progress = this.agentSwarmProgress.get(parentToolCallId);
    if (progress === undefined) return false;
    update(progress);
    this.requestRender();
    return true;
  }

  private ensureAgentSwarmProgress(
    toolCallId: string,
    args: Record<string, unknown>,
    options: { readonly streamingArguments?: string | undefined } = {},
  ): AgentSwarmProgressComponent {
    const existing = this.agentSwarmProgress.get(toolCallId);
    if (existing !== undefined) {
      existing.updateArgs(args, options);
      return existing;
    }

    const progress = new AgentSwarmProgressComponent({
      description: agentSwarmDescriptionFromArgs(args),
      availableGridHeight: () => {
        // Re-evaluated on every render pass (including terminal resizes, which
        // pi-tui turns into a requestRender → render loop without any event).
        this.syncAgentSwarmCardVisibility();
        return this.agentSwarmGridHeight();
      },
      requestRender: () => {
        this.requestRender();
      },
    });
    progress.updateArgs(args, options);
    this.agentSwarmProgress.set(toolCallId, progress);
    this.host.streamingUI.finalizeLiveTextBuffers('tool');
    this.host.state.transcriptContainer.addChild(progress);
    this.host.updateActivityPane();
    this.requestRender();
    return progress;
  }

  private removeAgentSwarmProgress(
    toolCallId: string,
    progress: AgentSwarmProgressComponent,
  ): void {
    this.agentSwarmProgress.delete(toolCallId);
    progress.dispose();
    const children = this.host.state.transcriptContainer.children;
    const index = children.indexOf(progress);
    if (index >= 0) {
      // Structural removal via removeChild keeps PARENT/version state consistent.
      this.host.state.transcriptContainer.removeChild(children[index]!);
    }
    this.host.updateActivityPane();
  }

  private agentSwarmGridHeight(): number | undefined {
    const { state } = this.host;
    const terminalRows = state.ui.terminal.rows;
    const terminalColumns = state.ui.terminal.columns;
    if (!Number.isFinite(terminalColumns) || terminalColumns <= 0) {
      return agentSwarmGridHeightForTerminalRows(terminalRows);
    }

    const width = Math.floor(terminalColumns);
    const rowsAfterSwarm = renderedRowsAfterChild(
      state.ui.children,
      state.transcriptContainer,
      width,
    );
    return agentSwarmGridHeightForTerminalRows(terminalRows, rowsAfterSwarm);
  }

  /** True while the card's bottom edge is still on screen: everything rendered
   *  after the card (later transcript entries plus the chrome below it) has
   *  not yet filled the viewport height. pi-tui always renders the bottom
   *  `rows` lines, so the card is fully scrolled off the top exactly when the
   *  rows following it reach the viewport height. */
  private isAgentSwarmCardVisible(progress: AgentSwarmProgressComponent): boolean {
    const { state } = this.host;
    const rows = state.ui.terminal.rows;
    const columns = state.ui.terminal.columns;
    if (!Number.isFinite(rows) || rows <= 0) return true;
    if (!Number.isFinite(columns) || columns <= 0) return true;
    const width = Math.floor(columns);
    const rowsAfterCard =
      renderedRowsAfterChildUpTo(state.transcriptContainer.children, progress, width, rows) +
      renderedRowsAfterChildUpTo(state.ui.children, state.transcriptContainer, width, rows);
    return rowsAfterCard < rows;
  }

  /** Re-evaluate every swarm card's viewport visibility. `setViewportVisible`
   *  short-circuits on unchanged states, so repeated calls (per event, per
   *  120ms animation tick, per render pass) are cheap. */
  private syncAgentSwarmCardVisibility(): void {
    if (this.syncingSwarmVisibility) return;
    this.syncingSwarmVisibility = true;
    try {
      for (const progress of this.agentSwarmProgress.values()) {
        progress.setViewportVisible(this.isAgentSwarmCardVisible(progress));
      }
    } finally {
      this.syncingSwarmVisibility = false;
    }
  }

  private markAgentSwarmFailedOrCancelled(
    progress: AgentSwarmProgressComponent,
    subagentId: string,
    error: string,
  ): void {
    if (isUserCancelledSubagentError(error)) {
      progress.markCancelled(subagentId);
    } else {
      progress.markFailed(subagentId, error);
    }
  }

  private getOrActivateToolComponent(parentToolCallId: string) {
    let component = this.host.streamingUI.getToolComponent(parentToolCallId);
    if (component !== undefined) return component;
    const toolCall = this.host.streamingUI.getActiveToolCall(parentToolCallId);
    if (toolCall === undefined) return undefined;
    this.host.streamingUI.onToolCallStart(toolCall);
    return this.host.streamingUI.getToolComponent(parentToolCallId);
  }

  private createStandaloneSubagentToolCall(
    event: SubagentLifecycleEventOf<'subagent.spawned'>,
  ) {
    const description = event.description ?? `Run ${event.subagentName} agent`;
    const { turnId, step } = this.host.streamingUI.getTurnContext();
    const toolCall: ToolCallBlockData = {
      id: event.parentToolCallId,
      name: 'Agent',
      args: {
        description,
        subagent_type: event.subagentName,
      },
      description,
      step,
      turnId,
    };
    this.host.streamingUI.onToolCallStart(toolCall);
    return this.host.streamingUI.getToolComponent(event.parentToolCallId);
  }

  private ensureSubagentActivity(agentId: string): SubagentActivity {
    let state = this.subagentActivity.get(agentId);
    if (state === undefined) {
      state = { ongoing: new Map(), finished: [], text: '' };
      this.subagentActivity.set(agentId, state);
    }
    return state;
  }

  private recordSubagentText(agentId: string, delta: string): void {
    if (delta.length === 0) return;
    const state = this.ensureSubagentActivity(agentId);
    const next = state.text + delta;
    state.text =
      next.length > SUBAGENT_ACTIVITY_TEXT_MAX ? next.slice(-SUBAGENT_ACTIVITY_TEXT_MAX) : next;
  }

  private recordSubagentToolCall(
    agentId: string,
    toolCallId: string,
    name: string,
    args: Record<string, unknown>,
  ): void {
    const state = this.ensureSubagentActivity(agentId);
    state.ongoing.set(toolCallId, { name, args });
  }

  private recordSubagentToolCallDelta(
    agentId: string,
    toolCallId: string,
    name: string | undefined,
    argumentsPart: string | null,
  ): void {
    const state = this.ensureSubagentActivity(agentId);
    const existing = state.ongoing.get(toolCallId);
    const nextArgsText = appendStreamingArgsPreview(existing?.streamingArguments, argumentsPart);
    // Deliberately no parseArgsPreview here: the raw accumulated text is
    // parsed lazily once per footer sync (subagentActivityLine) or once at
    // result time — re-scanning the whole text on every delta would duplicate
    // the card's own per-delta parse of the same payload.
    state.ongoing.set(toolCallId, {
      name: name ?? existing?.name ?? 'Tool',
      args: existing?.args ?? {},
      streamingArguments: nextArgsText,
    });
  }

  private recordSubagentToolResult(
    agentId: string,
    toolCallId: string,
    isError: boolean | undefined,
  ): void {
    const state = this.subagentActivity.get(agentId);
    if (state === undefined) return;
    const ongoing = state.ongoing.get(toolCallId);
    if (ongoing === undefined) return;
    state.ongoing.delete(toolCallId);
    // The activity line only reads the newest finished call; keep one entry.
    state.finished.length = 0;
    // One final parse of the accumulated streamed args when present; a result
    // lands once per tool call, so this stays cheap.
    const args =
      ongoing.streamingArguments !== undefined
        ? parseArgsPreview(ongoing.streamingArguments)
        : ongoing.args;
    state.finished.push({ name: ongoing.name, args, output: '', isError: isError ?? false });
  }

  /**
   * Latest per-subagent activity line, mirroring the card's own heuristic
   * (ongoing tool call > finished tool call > last text line) so footer rows
   * stay distinct even when several subagents share one parent tool card.
   */
  private subagentActivityLine(agentId: string): string | undefined {
    const state = this.subagentActivity.get(agentId);
    if (state === undefined) return undefined;
    return computeLatestActivity(
      this.parseActivityOngoing(state.ongoing),
      state.finished,
      state.text,
    );
  }

  /**
   * Lazily parses streamed tool-arg text for the footer activity line. Runs
   * once per footer sync per subagent instead of once per stream delta; the
   * card side already parses the same text per delta for its own body. When
   * no entry carries streamed args, the input map is returned unchanged.
   */
  private parseActivityOngoing(
    ongoing: Map<string, OngoingSubCall>,
  ): Map<string, OngoingSubCall> {
    let hasStreamed = false;
    for (const call of ongoing.values()) {
      if (call.streamingArguments !== undefined) {
        hasStreamed = true;
        break;
      }
    }
    if (!hasStreamed) return ongoing;
    const parsed = new Map<string, OngoingSubCall>();
    for (const [toolCallId, call] of ongoing) {
      parsed.set(toolCallId, {
        name: call.name,
        args:
          call.streamingArguments !== undefined
            ? parseArgsPreview(call.streamingArguments)
            : call.args,
      });
    }
    return parsed;
  }

  /**
   * Collect currently-running agent summaries for the footer status area.
   * Foreground subagents are read from their tool-component snapshots; terminal
   * members are still counted toward a merged summary row so totals stay
   * stable, while backgrounded and swarm members are handled separately below.
   */
  collectRunningAgents(): RunningAgentSummary[] {
    const summaries: RunningAgentSummary[] = [];

    // Foreground subagents are grouped by their parent tool call so a single
    // fan-out card (e.g. a Workflow run) collapses into one summary row once
    // the group outgrows SWARM_MEMBER_LIMIT.
    const rowsByParent = new Map<string, RunningAgentSummary[]>();
    // In-flight workflow subagents keyed by their parent Workflow tool call;
    // rendered by the workflow-run rows further below.
    const workflowLiveByParent = new Map<string, WorkflowLiveAgent[]>();
    // The snapshot is per parent card, so compute it once per card and share
    // it across every member of the group (a workflow fanning out 20+ agents
    // under one card previously recomputed the same snapshot per member).
    const snapshotByParent = new Map<string, ToolCallSubagentSnapshot>();
    for (const [agentId, info] of this.subagentInfo.entries()) {
      if (info.runInBackground) continue;
      // Swarm members have no standalone ToolCallComponent snapshot; their
      // footer rows come from AgentSwarmProgressComponent below.
      if (info.swarmIndex !== undefined) continue;
      // Workflow-run subagents are rendered by the dedicated workflow rows
      // below (which carry per-agent activity from the same activity ledger);
      // skip them here so they do not double up under the workflow card. The
      // engine dispatches `workflow.agent_spawned` when the subagent actually
      // spawns (ahead of its completion), so in-flight agents are collected
      // here and handed to the workflow rows — otherwise the footer would be
      // blind to running agents until they finish. Classification covers both
      // the launch turn (the Workflow card is still active) and the background
      // run (the card is gone, but the run ledger records the agent).
      if (this.isWorkflowSubagent(agentId, info.parentToolCallId)) {
        let live = workflowLiveByParent.get(info.parentToolCallId);
        if (live === undefined) {
          live = [];
          workflowLiveByParent.set(info.parentToolCallId, live);
        }
        live.push({
          agentId,
          name: info.description ?? info.name,
          startedAtMs: info.startedAtMs,
        });
        continue;
      }

      const tc = this.host.streamingUI.getToolComponent(info.parentToolCallId);
      if (tc === undefined) continue;
      let snap = snapshotByParent.get(info.parentToolCallId);
      if (snap === undefined) {
        snap = tc.getSubagentSnapshot();
        snapshotByParent.set(info.parentToolCallId, snap);
      }
      // Backgrounded subagents are detached from this batch (Ctrl+B) and never
      // count toward it; terminal foreground subagents stay so a merged summary
      // can count them and keep the token total monotonic.
      if (snap.phase === 'backgrounded') continue;

      // Prefer the per-subagent description from the spawned event: a single
      // parent tool call can host several subagents (e.g. a Workflow run fans
      // out many agents under one card), and the card-level description would
      // otherwise render as N identical footer rows. When the subagent carries
      // its own description that differs from the card's, surface it as the
      // row name so it is clear what that subagent is doing.
      const cardDescription = snap.toolCallDescription;
      const hasOwnDescription = info.description !== undefined && info.description !== cardDescription;

      const phase =
        snap.phase === 'running'
          ? 'running'
          : snap.phase === 'queued'
            ? 'waiting'
            : snap.phase === 'done'
              ? 'done'
              : snap.phase === 'failed'
                ? 'failed'
                : 'starting';

      const row: RunningAgentSummary = {
        id: agentId,
        name: hasOwnDescription
          ? info.description!
          : (snap.agentName ?? info.name ?? 'agent'),
        description: hasOwnDescription ? undefined : (info.description ?? cardDescription),
        // Always show what the agent is doing: per-subagent activity first,
        // then the card snapshot, then a phase label as last resort.
        latestActivity:
          this.subagentActivityLine(agentId) ??
          snap.latestActivity ??
          SUBAGENT_PHASE_ACTIVITY_FALLBACK[phase],
        phase,
        startedAtMs: tc.getSubagentStartedAtMs() ?? Date.now(),
        tokens: snap.tokens,
      };
      let rows = rowsByParent.get(info.parentToolCallId);
      if (rows === undefined) {
        rows = [];
        rowsByParent.set(info.parentToolCallId, rows);
      }
      rows.push(row);
    }
    for (const [parentToolCallId, rows] of rowsByParent) {
      const active = rows.filter((row) => row.phase !== 'done' && row.phase !== 'failed');
      // Nothing left to do in this batch: drop the group entirely (matching
      // the swarm behavior once every member is terminal).
      if (active.length === 0) continue;
      // Beyond the limit the whole batch — terminal members included — collapses
      // into one summary row, so the working/done counts and the token total
      // stay monotonic instead of dropping member by member.
      if (rows.length > SWARM_MEMBER_LIMIT) {
        summaries.push(summarizeSubagentRows(rows, parentToolCallId));
      } else {
        summaries.push(...active);
      }
    }

    // Swarm members: individual footer rows up to SWARM_MEMBER_LIMIT, a single
    // summary row beyond that. The transcript grid still shows member detail;
    // the footer keeps a persistent overview while members run. Each member
    // row carries its item title plus the agent's live activity (what it is
    // actually doing), joined from the per-agent activity ledger.
    for (const [parentToolCallId, progress] of this.agentSwarmProgress) {
      summaries.push(
        ...collectSwarmRunningAgents(progress, parentToolCallId, (agentId) =>
          this.subagentActivityLine(agentId),
        ),
      );
    }

    for (const info of this.deps.backgroundTasks.values()) {
      if (info.status !== 'running') continue;
      if (info.kind === 'agent') {
        summaries.push({
          id: info.agentId ?? info.taskId,
          name: info.subagentType ?? 'agent',
          description: info.description,
          phase: 'running',
          startedAtMs: info.startedAt,
          tokens: 0,
        });
      } else if (info.kind === 'process') {
        // Background shell jobs have no token data; the row shows the task
        // description (falling back to the command) so the job stays visible.
        summaries.push({
          id: info.taskId,
          name: 'bash',
          description: info.description || info.command,
          phase: 'running',
          startedAtMs: info.startedAt,
          tokens: 0,
        });
      }
      // `question` tasks are rendered by the BTW panel, not the footer rows.
    }

    // Workflow runs are background tasks with `kind === 'workflow'`, which the
    // badge branches above skip — surface each active run as its own persistent
    // row so a running workflow is always visible with its current phase and
    // agent progress instead of hiding behind the `[N task running]` badge.
    // The run's subagents follow as their own rows (up to SWARM_MEMBER_LIMIT,
    // with a folded summary row beyond) so the footer shows who is doing what.
    for (const runId of this.workflowRunParents.keys()) {
      if (!this.host.state.appState.workflowRuns.some((run) => run.runId === runId && run.status === 'running')) {
        this.workflowRunParents.delete(runId);
      }
    }
    for (const run of this.host.state.appState.workflowRuns) {
      if (run.status !== 'running') continue;
      const started = Date.parse(run.startedAt);
      const startedAtMs = Number.isFinite(started) ? started : Date.now();
      // The engine dispatches `workflow.agent_spawned` when the subagent
      // actually spawns, so in-flight agents arrive here from the live
      // subagent registry (`workflowLiveAgentsForRun`) and terminal ones from
      // the run ledger. The displayed total counts both, keeping `n/m
      // complete` honest about the work still in flight.
      const liveAgents = this.workflowLiveAgentsForRun(run, workflowLiveByParent);
      const progress = `${String(run.completedAgents)}/${String(run.spawnedAgents + liveAgents.length)} complete`;
      summaries.push({
        id: `workflow:${run.runId}`,
        name: 'workflow',
        description: run.name,
        latestActivity:
          run.phase === undefined ? progress : `${progress} · ${run.phase}`,
        phase: 'running',
        startedAtMs,
        tokens: 0,
      });
      summaries.push(
        ...collectWorkflowRunAgents(
          run,
          startedAtMs,
          (agentId) => this.subagentActivityLine(agentId),
          liveAgents,
          (agentId) => this.subagentTokenTotals.get(agentId) ?? 0,
        ),
      );
    }

    return summaries;
  }

  /**
   * True when a subagent belongs to a workflow run: its parent card is the
   * in-flight Workflow tool call (covers the launch turn), or the agent has
   * landed in a running run's ledger. The ledger check is the durable signal —
   * after the launching turn ends the card is gone, but `workflow.agent_spawned`
   * has already recorded the agent in its run, so the agent stays on the
   * workflow rows for the whole run instead of being misread as a standalone
   * foreground subagent. Exact because agent ids enter a run ledger only
   * through the engine's own `workflow.agent_spawned` dispatch.
   */
  private isWorkflowSubagent(agentId: string, parentToolCallId: string): boolean {
    if (this.host.streamingUI.getActiveToolCall(parentToolCallId)?.name === 'Workflow') {
      return true;
    }
    for (const run of this.host.state.appState.workflowRuns) {
      if (run.status !== 'running') continue;
      if (run.agents.some((agent) => agent.agentId === agentId)) return true;
    }
    return false;
  }

  /**
   * Attribute the in-flight workflow subagents (keyed by their parent Workflow
   * tool call) to a run. The wire protocol carries no run↔tool-call link, so
   * the run lazily claims the first unclaimed Workflow card and the mapping is
   * kept stable for the run's lifetime — exact for a single concurrent
   * workflow, a stable display-only heuristic for several. Agents already
   * terminal in the run ledger are excluded so the overlap window between the
   * live registry and the ledger never renders an agent twice.
   */
  private workflowLiveAgentsForRun(
    run: WorkflowRunView,
    liveByParent: ReadonlyMap<string, readonly WorkflowLiveAgent[]>,
  ): readonly WorkflowLiveAgent[] {
    let parentToolCallId = this.workflowRunParents.get(run.runId);
    if (parentToolCallId === undefined) {
      const claimed = new Set(this.workflowRunParents.values());
      for (const candidate of liveByParent.keys()) {
        if (claimed.has(candidate)) continue;
        this.workflowRunParents.set(run.runId, candidate);
        parentToolCallId = candidate;
        break;
      }
      if (parentToolCallId === undefined) return [];
    }
    const ledgerIds = new Set(run.agents.map((agent) => agent.agentId));
    return (liveByParent.get(parentToolCallId) ?? []).filter(
      (agent) => !ledgerIds.has(agent.agentId),
    );
  }

  private requestRender(): void {
    this.syncAgentSwarmCardVisibility();
    this.host.state.ui.requestRender();
  }
}

function isSubagentLifecycleEvent(event: Event): event is SubagentLifecycleEvent {
  return (
    event.type === 'subagent.spawned' ||
    event.type === 'subagent.started' ||
    event.type === 'subagent.suspended' ||
    event.type === 'subagent.completed' ||
    event.type === 'subagent.failed'
  );
}

function isUserCancelledSubagentError(error: string): boolean {
  // Structured AgentSwarm results use outcome="aborted" and are parsed separately.
  switch (error.trim()) {
    case 'Aborted by the user':
    case 'The user manually interrupted this subagent batch.':
      return true;
    default:
      return false;
  }
}

function isTerminalSwarmPhase(phase: AgentSwarmMemberSnapshot['phase']): boolean {
  return phase === 'completed' || phase === 'failed' || phase === 'cancelled';
}

/**
 * Collapse a full swarm member list into the footer's one-line summary: an
 * active/total working count plus non-zero terminal counts, the earliest
 * member start (for the elapsed clock) and the summed member tokens.
 */
function summarizeSwarmMembers(
  members: readonly AgentSwarmMemberSnapshot[],
): { description: string; earliestStartedAtMs: number | undefined; tokens: number } {
  const active = members.filter((member) => !isTerminalSwarmPhase(member.phase)).length;
  const done = members.filter((member) => member.phase === 'completed').length;
  const failed = members.filter((member) => member.phase === 'failed').length;
  const parts = [`${active}/${members.length} working`];
  if (done > 0) parts.push(`${done} done`);
  if (failed > 0) parts.push(`${failed} failed`);
  let earliestStartedAtMs: number | undefined;
  for (const member of members) {
    if (member.startedAtMs === undefined) continue;
    if (earliestStartedAtMs === undefined || member.startedAtMs < earliestStartedAtMs) {
      earliestStartedAtMs = member.startedAtMs;
    }
  }
  return {
    description: parts.join(' · '),
    earliestStartedAtMs,
    tokens: members.reduce((sum, member) => sum + member.tokens, 0),
  };
}

/**
 * Collapse the foreground subagent rows sharing one parent tool call into the
 * footer's one-line summary — working/done/failed/queued/starting counts, the
 * earliest start (for the elapsed clock) and the summed tokens of every member
 * (terminal ones included, so the total only grows) — mirroring
 * `summarizeSwarmMembers`.
 */
function summarizeSubagentRows(
  rows: readonly RunningAgentSummary[],
  parentToolCallId: string,
): RunningAgentSummary {
  const working = rows.filter((row) => row.phase === 'running').length;
  const done = rows.filter((row) => row.phase === 'done').length;
  const failed = rows.filter((row) => row.phase === 'failed').length;
  const waiting = rows.filter((row) => row.phase === 'waiting').length;
  const starting = rows.filter((row) => row.phase === 'starting').length;
  const parts = [`${working}/${rows.length} working`];
  if (done > 0) parts.push(`${done} done`);
  if (failed > 0) parts.push(`${failed} failed`);
  if (waiting > 0) parts.push(`${waiting} queued`);
  if (starting > 0) parts.push(`${starting} starting`);
  return {
    id: `${parentToolCallId}:subagents`,
    name: 'subagents',
    description: parts.join(' · '),
    phase: 'running',
    startedAtMs: Math.min(...rows.map((row) => row.startedAtMs)),
    tokens: rows.reduce((sum, row) => sum + row.tokens, 0),
  };
}

/**
 * Footer summaries for one active swarm: one `RunningAgentSummary` per member
 * up to SWARM_MEMBER_LIMIT, plus a folded `swarm` summary row beyond that.
 * Terminal members stay visible with a status mark (✓/✗/⊘) instead of
 * dropping out, so the row set only grows while the swarm runs. When an
 * `activityLine` resolver is provided (the per-member activity ledger), the
 * row shows what the agent is actually doing under its item title. Exported
 * for direct unit testing against a real AgentSwarmProgressComponent.
 */
export function collectSwarmRunningAgents(
  progress: AgentSwarmProgressComponent,
  parentToolCallId: string,
  activityLine?: (agentId: string) => string | undefined,
): RunningAgentSummary[] {
  if (!progress.isToolCallActive()) return [];
  const members = progress.getMemberSnapshots();
  if (members.length === 0) return [];

  const rows = members.slice(0, SWARM_MEMBER_LIMIT).map((member): RunningAgentSummary => ({
    id: `${parentToolCallId}:${member.id}`,
    name: member.id,
    description: swarmMemberDescription(member),
    latestActivity:
      member.agentId !== undefined ? activityLine?.(member.agentId) : undefined,
    phase: swarmMemberPhase(member.phase),
    startedAtMs: member.startedAtMs ?? Date.now(),
    tokens: member.tokens,
  }));

  if (members.length <= SWARM_MEMBER_LIMIT) return rows;

  const summary = summarizeSwarmMembers(members);
  rows.push({
    id: `${parentToolCallId}:swarm`,
    name: 'swarm',
    description: summary.description,
    phase: 'running',
    startedAtMs: summary.earliestStartedAtMs ?? Date.now(),
    tokens: summary.tokens,
  });
  return rows;
}

/**
 * Member row label: the item's leading title when one can be recognized —
 * a bracket pair (`【...】` / `[...]`), the first line, then the first
 * sentence — falling back to the item text itself. Keeps footer rows from
 * filling with long prompt bodies; the transcript card still shows the full
 * item. Exported for direct unit testing.
 */
export function swarmItemLabel(itemText: string): string {
  const trimmed = itemText.trim();
  if (trimmed.length === 0) return '';
  // Bracket pair — the most explicit title signal in a prompt.
  const bracket = /^【[^】]+】|^\[[^\]]+\]/.exec(trimmed);
  if (bracket !== null) return bracket[0];
  // First line: multi-line prompts usually lead with a heading.
  const firstLine = trimmed.split('\n')[0]!.trim();
  if (firstLine !== trimmed) return firstLine;
  // First sentence, bounded by terminal punctuation. English full stops are
  // only boundaries when followed by whitespace/end so file extensions
  // (`a.ts`) and version numbers are not cut mid-token.
  const sentence = /^.*?[。！？…]|^.*?[!?](?=\s|$)|^.*?\.(?=\s|$)/.exec(trimmed);
  if (sentence !== null) return sentence[0].trim();
  return trimmed;
}

/** Member row activity: the short item label, suffixed with a status mark
 *  once the member reaches a terminal phase. */
function swarmMemberDescription(member: AgentSwarmMemberSnapshot): string {
  const status = swarmMemberStatusText(member.phase);
  const label = swarmItemLabel(member.itemText);
  if (status === undefined) return label;
  return label.length > 0 ? `${label} · ${status}` : status;
}

function swarmMemberStatusText(phase: AgentSwarmMemberSnapshot['phase']): string | undefined {
  switch (phase) {
    case 'completed':
      return `${SUCCESS_MARK}done`;
    case 'failed':
      return `${FAILURE_MARK}failed`;
    case 'cancelled':
      return '⊘ cancelled';
    default:
      return undefined;
  }
}

function swarmMemberPhase(phase: AgentSwarmMemberSnapshot['phase']): RunningAgentSummary['phase'] {
  switch (phase) {
    case 'completed':
      return 'done';
    case 'failed':
    case 'cancelled':
      return 'failed';
    case 'running':
      return 'running';
    default:
      return 'waiting';
  }
}

/**
 * A workflow subagent still in flight. The engine ledger only learns about an
 * agent once it finishes, so running agents are supplied from the live
 * subagent registry via this shape and merged into the run's footer rows.
 */
export interface WorkflowLiveAgent {
  readonly agentId: string;
  readonly name: string;
  readonly startedAtMs: number;
}

/**
 * Footer rows for the subagents of one running workflow run: each agent gets
 * its own line up to SWARM_MEMBER_LIMIT, with a single folded summary row
 * beyond that (mirroring the swarm rows). In-flight agents (`liveAgents`)
 * come first so what is running right now is always visible; terminal agents
 * stay visible with a status mark, so the footer shows who has finished
 * instead of dropping rows one by one. When an `activityLine` resolver is
 * provided (the per-agent activity ledger — workflow subagents are real
 * subagents, so their tool calls land there), the row shows what the agent is
 * actually doing. A `tokensForAgent` resolver supplies the row token counter
 * (0 when absent); the folded summary row sums the tokens of the members it
 * covers, so the collapsed display still totals the whole batch. Exported for
 * direct unit testing.
 */
export function collectWorkflowRunAgents(
  run: WorkflowRunView,
  runStartedAtMs: number,
  activityLine?: (agentId: string) => string | undefined,
  liveAgents: readonly WorkflowLiveAgent[] = [],
  tokensForAgent?: (agentId: string) => number,
): RunningAgentSummary[] {
  const agents = run.agents;
  if (agents.length === 0 && liveAgents.length === 0) return [];

  const liveRows = liveAgents.map((agent): RunningAgentSummary => ({
    id: `workflow:${run.runId}:${agent.agentId}`,
    name: agent.name,
    description: workflowAgentStatusText('running'),
    latestActivity: activityLine?.(agent.agentId),
    phase: 'running',
    startedAtMs: agent.startedAtMs,
    tokens: tokensForAgent?.(agent.agentId) ?? 0,
  }));

  const ledgerRows = agents.map((agent): RunningAgentSummary => ({
    id: `workflow:${run.runId}:${agent.agentId}`,
    name: agent.label ?? agent.agentId,
    description: workflowAgentStatusText(agent.status),
    latestActivity: activityLine?.(agent.agentId),
    phase: workflowAgentPhase(agent.status),
    // Terminal agents show their own duration through the footer's elapsed
    // clock: back-date the row so now - startedAtMs ≈ durationMs.
    startedAtMs: agent.durationMs === undefined ? runStartedAtMs : Date.now() - agent.durationMs,
    tokens: tokensForAgent?.(agent.agentId) ?? 0,
  }));

  const total = liveAgents.length + agents.length;
  const rows = [...liveRows, ...ledgerRows].slice(0, SWARM_MEMBER_LIMIT);
  if (total <= SWARM_MEMBER_LIMIT) return rows;

  const working =
    liveAgents.length + agents.filter((agent) => agent.status === 'running').length;
  const done = agents.filter((agent) => agent.status === 'completed').length;
  const failed = agents.filter((agent) => agent.status === 'failed').length;
  const parts = [`${working}/${total} working`];
  if (done > 0) parts.push(`${done} done`);
  if (failed > 0) parts.push(`${failed} failed`);
  rows.push({
    id: `workflow:${run.runId}:summary`,
    name: 'workflow agents',
    description: parts.join(' · '),
    phase: 'running',
    startedAtMs: runStartedAtMs,
    // Sum the covered members' tokens so the folded row keeps the batch total
    // visible alongside the first SWARM_MEMBER_LIMIT detail rows.
    tokens: [...liveRows, ...ledgerRows]
      .slice(SWARM_MEMBER_LIMIT)
      .reduce((sum, row) => sum + row.tokens, 0),
  });
  return rows;
}

function workflowAgentPhase(status: WorkflowRunAgentStatus): RunningAgentSummary['phase'] {
  switch (status) {
    case 'completed':
      return 'done';
    case 'failed':
    case 'aborted':
      return 'failed';
    case 'running':
      return 'running';
  }
}

function workflowAgentStatusText(status: WorkflowRunAgentStatus): string {
  switch (status) {
    case 'running':
      return 'working…';
    case 'completed':
      return `${SUCCESS_MARK}done`;
    case 'failed':
      return `${FAILURE_MARK}failed`;
    case 'aborted':
      return '⊘ aborted';
  }
}
