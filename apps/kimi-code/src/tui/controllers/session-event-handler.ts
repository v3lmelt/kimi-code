import type { Component, Focusable } from '@moonshot-ai/pi-tui';
import type { WorkflowProgressEvent } from '@moonshot-ai/agent-core-v2';
import type {
  AgentStatusUpdatedEvent,
  AssistantDeltaEvent,
  BackgroundTaskInfo,
  BackgroundTaskStartedEvent,
  BackgroundTaskTerminatedEvent,
  CompactionCancelledEvent,
  CompactionCompletedEvent,
  CompactionStartedEvent,
  CronFiredEvent,
  ErrorEvent,
  Event,
  GoalChange,
  GoalUpdatedEvent,
  HookResultEvent,
  Session,
  SessionMetaUpdatedEvent,
  SkillActivatedEvent,
  PluginCommandActivatedEvent,
  ThinkingDeltaEvent,
  ToolCallDeltaEvent,
  ToolCallStartedEvent,
  ToolProgressEvent,
  ToolResultEvent,
  TurnEndedEvent,
  TurnStartedEvent,
  TurnStepCompletedEvent,
  TurnStepInterruptedEvent,
  TurnStepRetryingEvent,
  TurnStepStartedEvent,
  TurnStepUsageEvent,
  TokenUsage,
  WarningEvent,
} from '@moonshot-ai/kimi-code-sdk';

import { MoonLoader } from '../components/chrome/moon-loader';
import { buildGoalMarker } from '../components/messages/goal-markers';
import { StatusMessageComponent } from '../components/messages/status-message';
import {
  SwarmModeMarkerComponent,
  type SwarmModeMarkerState,
} from '../components/messages/swarm-markers';
import {
  OAUTH_LOGIN_REQUIRED_CODE,
  OAUTH_LOGIN_REQUIRED_STARTUP_NOTICE,
} from '../constant/kimi-tui';
import { buildGoalCompletionMessage } from '../utils/goal-completion';
import {
  argsRecord,
  formatErrorPayload,
  formatErrorMessage,
  isTodoItemShape,
  serializeToolResultOutput,
  stringValue,
} from '../utils/event-payload';
import {
  readGoalQueue,
  removeGoalQueueItem,
  restoreGoalQueueItem,
  type UpcomingGoal,
} from '../goal-queue-store';
import { formatBackgroundTaskTranscript } from '../utils/background-task-status';
import { estimateStreamedTokens } from '../utils/turn-usage';
import { formatHookResultMarkdown } from '../utils/hook-result-format';
import { McpOAuthAuthorizationUrlOpener } from '../utils/mcp-oauth';
import {
  formatMcpStartupStatusSummary,
  mcpServerStatusKey,
  type McpServerStatusSnapshot,
  selectMcpStartupStatusRows,
} from '../utils/mcp-server-status';
import { openUrl } from '#/utils/open-url';
import { currentTheme } from '#/tui/theme';
import type { ColorToken } from '#/tui/theme';
import { errorReportHintLine } from '../constant/feedback';
import { formatStepDebugTiming } from '#/utils/usage/debug-timing';
import { nextTranscriptId } from '../utils/transcript-id';
import type { BtwPanelController } from './btw-panel';
import { isPluginMcpToolName, PluginUpdateNotifier } from './plugin-update-notifier';
import type { StreamingUIController } from './streaming-ui';
import type { TasksBrowserController } from './tasks-browser';
import { SubAgentEventHandler } from './subagent-event-handler';
import type {
  AppState,
  LivePaneState,
  QueuedMessage,
  ToolCallBlockData,
  ToolResultBlockData,
  TranscriptEntry,
} from '../types';
import type { TUIState } from '../tui-state';
import { createGoal as startGoalCommand } from '../commands/goal';
import {
  applyWorkflowProgressEvent,
  extractWorkflowProgressEvent,
} from '../utils/workflow-model';

/**
 * Coalesces footer agent-row refreshes from high-frequency events
 * (`agent.status.updated` per subagent, background-task churn) into a 250ms
 * window. The footer's own 1s agent timer backstops the display, so the
 * worst-case staleness stays imperceptible.
 */
const FOOTER_SYNC_THROTTLE_MS = 250;

export interface SessionEventHost {
  state: TUIState;
  session: Session | undefined;
  aborted: boolean;
  sessionEventUnsubscribe: (() => void) | undefined;
  readonly streamingUI: StreamingUIController;

  requireSession(): Session;
  setAppState(patch: Partial<AppState>): void;
  patchLivePane(patch: Partial<LivePaneState>): void;
  resetLivePane(): void;
  showError(msg: string): void;
  showStatus(msg: string, color?: ColorToken): void;
  showNotice(title: string, detail?: string): void;
  updateActivityPane(): void;
  track(event: string, props?: Record<string, unknown>): void;
  recordSessionActivity(): void;
  noteStepUsage(usage: TokenUsage | undefined): void;
  noteCompactionFinished(): void;
  mountEditorReplacement(panel: Component & Focusable): void;
  restoreEditor(): void;
  restoreInputText(text: string): void;
  appendTranscriptEntry(entry: TranscriptEntry): void;
  handleShellOutput(event: { commandId: string; update: { kind: string; text?: string } }): void;
  handleShellStarted(event: { commandId: string; taskId: string }): void;
  sendNormalUserInput(text: string): void;
  updateTerminalTitle(): void;
  sendQueuedMessage(session: Session, item: QueuedMessage): void;
  shiftQueuedMessage(): QueuedMessage | undefined;
  readonly btwPanelController: BtwPanelController;
  readonly tasksBrowserController: TasksBrowserController;
}

export class SessionEventHandler {
  readonly subAgentEventHandler: SubAgentEventHandler;
  private readonly pluginUpdateNotifier: PluginUpdateNotifier;

  constructor(
    private readonly host: SessionEventHost,
    pluginUpdateNotifier?: PluginUpdateNotifier,
  ) {
    this.subAgentEventHandler = new SubAgentEventHandler(host, {
      backgroundTasks: this.backgroundTasks,
      backgroundTaskTranscriptedTerminal: this.backgroundTaskTranscriptedTerminal,
      syncBackgroundAgentBadge: () => {
        this.syncBackgroundTaskBadge();
      },
      syncRunningAgentsFooter: () => {
        this.syncRunningAgentsFooter();
      },
    });
    this.pluginUpdateNotifier =
      pluginUpdateNotifier ??
      new PluginUpdateNotifier({
        getSession: () => this.host.session,
        workDir: host.state.appState.workDir,
        notify: (message) => {
          this.host.showStatus(message, 'warning');
        },
      });
  }

  // Runtime state – owned by this handler, reset between sessions.
  backgroundTasks: Map<string, BackgroundTaskInfo> = new Map();
  private readonly workflowBackgroundTasks = new Map<string, { readonly status: string }>();
  backgroundTaskTranscriptedTerminal: Set<string> = new Set();

  renderedSkillActivationIds: Set<string> = new Set();
  renderedPluginCommandActivationIds: Set<string> = new Set();
  renderedMcpServerStatusKeys: Map<string, string> = new Map();
  mcpServerStatusSpinners: Map<string, MoonLoader> = new Map();
  mcpServers: Map<string, McpServerStatusSnapshot> = new Map();
  private goalCompletionAwaitingClear = false;
  private goalCompletionTurnEnded = false;
  private currentTurnHasAssistantText = false;
  private estimatedOutputTokens = 0;
  /** Last wall-clock time the model produced any output (feeds stall detection). */
  private lastActivityAtMs = 0;
  /** In-flight step retry (from `turn.step.retrying`), surfaced on the spinner
   *  status row. Cleared once the step resumes, completes, or the turn ends. */
  private stepRetry:
    | {
        delayMs: number;
        failedAttempt: number;
        nextAttempt: number;
        maxAttempts: number;
        errorName: string;
      }
    | undefined = undefined;
  private pluginCommandTurns: Map<string, string> = new Map();
  private pluginMcpToolsUsedInTurn: Set<string> = new Set();
  private pendingModelBlockedFallback: GoalChange | undefined;
  private queuedGoalPromotionPending = false;
  private queuedGoalPromotionInFlight = false;
  private queuedGoalPromotionTimer: ReturnType<typeof setTimeout> | undefined;
  /** Pending throttled footer agent-row sync (see `syncRunningAgentsFooter`). */
  private footerSyncTimer: ReturnType<typeof setTimeout> | undefined;
  /** Latest in-flight step usage, coalesced into appState on a 250ms trailing timer. */
  private latestStepUsageLive: { input: number; output: number } | undefined;
  /** Pending throttled in-flight usage sync (see `syncTurnUsageFooter`). */
  private turnUsageSyncTimer: ReturnType<typeof setTimeout> | undefined;

  resetRuntimeState(): void {
    this.backgroundTasks.clear();
    this.backgroundTaskTranscriptedTerminal.clear();
    this.subAgentEventHandler.resetRuntimeState();
    this.renderedSkillActivationIds.clear();
    this.renderedPluginCommandActivationIds.clear();
    this.renderedMcpServerStatusKeys.clear();
    this.mcpServers.clear();
    this.goalCompletionAwaitingClear = false;
    this.goalCompletionTurnEnded = false;
    this.currentTurnHasAssistantText = false;
    this.estimatedOutputTokens = 0;
    this.lastActivityAtMs = 0;
    this.stepRetry = undefined;
    this.pluginCommandTurns.clear();
    this.pluginMcpToolsUsedInTurn.clear();
    this.pendingModelBlockedFallback = undefined;
    this.host.setAppState({ sessionCacheUsage: undefined });
    this.queuedGoalPromotionPending = false;
    this.queuedGoalPromotionInFlight = false;
    this.clearQueuedGoalPromotionTimer();
    this.clearFooterSyncTimer();
    this.clearTurnUsageTimer();
    this.latestStepUsageLive = undefined;
    this.stopAllMcpServerStatusSpinners();
  }

  clearAgentSwarmProgress(): void {
    this.subAgentEventHandler.clearAgentSwarmProgress();
  }

  hasActiveAgentSwarmToolCall(): boolean {
    return this.subAgentEventHandler.hasActiveAgentSwarmToolCall();
  }

  syncAgentSwarmActivitySpinner(spinner: MoonLoader | undefined): void {
    this.subAgentEventHandler.syncAgentSwarmActivitySpinner(spinner);
  }

  /**
   * Locally estimated output tokens of the in-flight step, fed from streamed
   * text so the spinner's ↓ counter ticks per frame the way Claude Code's
   * does. Read on each spinner frame by the status provider; the provider's
   * exact usage supersedes it via `turn.step.usage` / `turn.step.completed`.
   */
  getEstimatedOutputTokens(): number {
    return this.estimatedOutputTokens;
  }

  /** Last time the model streamed output (thinking/text/tool), for stall UI. */
  getLastActivityAtMs(): number {
    return this.lastActivityAtMs;
  }

  /** Live step-retry info for the spinner's retry/rate-limit status line. */
  getStepRetryStatus():
    | {
        delayMs: number;
        failedAttempt: number;
        nextAttempt: number;
        maxAttempts: number;
        errorName: string;
      }
    | undefined {
    return this.stepRetry;
  }

  startSubscription(): void {
    const { host } = this;
    const session = host.requireSession();
    const sendQueued = (item: QueuedMessage): void => {
      host.sendQueuedMessage(session, item);
    };
    host.sessionEventUnsubscribe?.();
    const mcpOAuthOpener = new McpOAuthAuthorizationUrlOpener(openUrl);
    const { sessionId } = host.state.appState;
    host.sessionEventUnsubscribe = session.onEvent((event) => {
      if (host.aborted) return;
      if (event.sessionId !== sessionId) return;
      if (event.type === 'tool.progress') {
        mcpOAuthOpener.handleToolProgress(event);
      }
      this.handleEvent(event, sendQueued);
    });
    void this.syncMcpServerStatusSnapshot(session);
  }

  async syncMcpServerStatusSnapshot(session: Session): Promise<void> {
    const { host } = this;
    let servers: readonly McpServerStatusSnapshot[];
    try {
      servers = await session.listMcpServers();
    } catch (error) {
      if (host.session !== session || host.aborted) return;
      const message = error instanceof Error ? error.message : String(error);
      host.showError(`Failed to sync MCP server status: ${message}`);
      return;
    }
    if (host.session !== session || host.state.appState.sessionId !== session.id) return;

    const visible = selectMcpStartupStatusRows(servers);
    const visibleNames = new Set(visible.map((server) => server.name));
    for (const server of visible) {
      if (this.renderedMcpServerStatusKeys.has(server.name)) continue;
      this.renderMcpServerStatus(server);
    }

    this.mcpServers.clear();
    for (const server of servers) {
      this.mcpServers.set(server.name, server);
    }
    const hidden: McpServerStatusSnapshot[] = [];
    for (const server of servers) {
      if (visibleNames.has(server.name)) continue;
      if (this.renderedMcpServerStatusKeys.has(server.name)) continue;
      this.renderedMcpServerStatusKeys.set(server.name, mcpServerStatusKey(server));
      hidden.push(server);
    }
    const summary = formatMcpStartupStatusSummary(servers);
    host.setAppState({ mcpServersSummary: summary || null });
  }

  handleEvent(event: Event, sendQueued: (item: QueuedMessage) => void): void {
    if (this.subAgentEventHandler.routeChildAgentEvent(event)) {
      if (event.type === 'agent.status.updated') {
        this.syncRunningAgentsFooter();
      }
      return;
    }

    // The engine's `workflow.progress` wire event reaches the client through
    // the SDK event channel (a closed v1 union, hence the runtime extract).
    // Fold it into appState.workflowRuns so the /workflows command renders live
    // run progress without polling. Deliberately handled before the turn-scoped
    // block below: workflow runs are background tasks and may settle outside
    // any in-flight turn.
    const workflowProgress = extractWorkflowProgressEvent(event);
    if (workflowProgress !== undefined) {
      this.handleWorkflowProgress(workflowProgress);
      return;
    }

    if ('turnId' in event && event.turnId !== undefined) {
      this.host.streamingUI.setTurnId(String(event.turnId));
    }

    switch (event.type) {
      case 'turn.started': this.handleTurnBegin(event); break;
      case 'turn.ended': this.handleTurnEnd(event, sendQueued); break;
      case 'turn.step.started': this.handleStepBegin(event); break;
      case 'turn.step.interrupted': this.handleStepInterrupted(event); break;
      case 'turn.step.completed': this.handleStepCompleted(event); break;
      case 'turn.step.usage': this.handleStepUsage(event); break;
      case 'turn.step.retrying': this.handleStepRetrying(event); break;
      case 'tool.progress': this.handleToolProgress(event); break;
      case 'shell.output': this.host.handleShellOutput(event); break;
      case 'shell.started': this.host.handleShellStarted(event); break;
      case 'assistant.delta': this.handleAssistantDelta(event); break;
      case 'hook.result': this.handleHookResult(event); break;
      case 'thinking.delta': this.handleThinkingDelta(event); break;
      case 'tool.call.started': this.handleToolCall(event); break;
      case 'tool.call.delta': this.handleToolCallDelta(event); break;
      case 'tool.result': this.handleToolResult(event); break;
      case 'agent.status.updated': this.handleStatusUpdate(event); break;
      case 'session.meta.updated': this.handleSessionMetaChanged(event); break;
      case 'goal.updated': this.handleGoalUpdated(event); break;
      case 'skill.activated': this.handleSkillActivated(event); break;
      case 'plugin_command.activated': this.handlePluginCommandActivated(event); break;
      case 'error': this.handleSessionError(event); break;
      case 'warning': this.handleSessionWarning(event); break;
      case 'compaction.started': this.handleCompactionBegin(event); break;
      case 'compaction.completed': this.handleCompactionEnd(event, sendQueued); break;
      case 'compaction.blocked': break;
      case 'compaction.cancelled': this.handleCompactionCancel(event, sendQueued); break;
      case 'subagent.spawned':
      case 'subagent.started':
      case 'subagent.suspended':
      case 'subagent.completed':
      case 'subagent.failed':
        this.subAgentEventHandler.handleLifecycleEvent(event);
        this.syncRunningAgentsFooter();
        break;
      case 'background.task.started':
      case 'background.task.terminated':
        this.handleBackgroundTaskEvent(event); break;
      case 'cron.fired': this.handleCronFired(event); break;
      case 'mcp.server.status': this.renderMcpServerStatus(event.server); break;
      case 'tool.list.updated': break;
      default: break;
    }
  }

  stopAllMcpServerStatusSpinners(): void {
    for (const spinner of this.mcpServerStatusSpinners.values()) {
      spinner.stop();
    }
    this.mcpServerStatusSpinners.clear();
  }

  // ---------------------------------------------------------------------------
  // Private handlers
  // ---------------------------------------------------------------------------

  private handleTurnBegin(event: TurnStartedEvent): void {
    this.currentTurnHasAssistantText = false;
    this.estimatedOutputTokens = 0;
    if (event.origin?.kind === 'plugin_command') {
      this.pluginCommandTurns.set(String(event.turnId), event.origin.pluginId);
    }
    this.clearAgentSwarmProgress();
    this.host.streamingUI.resetToolUi();
    this.host.streamingUI.setStep(0);
    this.host.patchLivePane({
      mode: 'waiting',
      pendingApproval: null,
      pendingQuestion: null,
    });
    // Drop any leftover usage-coalesce timer from the previous turn so its
    // pending live value cannot bleed into the fresh turn's usage slot.
    this.clearTurnUsageTimer();
    this.latestStepUsageLive = undefined;
    this.host.setAppState({
      streamingPhase: 'waiting',
      streamingStartTime: Date.now(),
      turnUsage: { input: 0, output: 0, turnStartedAt: Date.now() },
    });
    this.syncRunningAgentsFooter();
  }

  private handleCronFired(event: CronFiredEvent): void {
    this.host.streamingUI.flushNow();
    this.host.appendTranscriptEntry({
      id: nextTranscriptId(),
      kind: 'cron',
      turnId: this.host.streamingUI.getTurnContext().turnId,
      renderMode: 'plain',
      content: event.prompt,
      cronData: {
        jobId: event.origin.jobId,
        cron: event.origin.cron,
        recurring: event.origin.recurring,
        coalescedCount: event.origin.coalescedCount,
        stale: event.origin.stale,
      },
    });
  }

  private handleTurnEnd(event: TurnEndedEvent, sendQueued: (item: QueuedMessage) => void): void {
    this.host.streamingUI.flushNow();
    this.stepRetry = undefined;
    if (event.reason === 'cancelled') {
      this.markActiveAgentSwarmsCancelled();
    }
    if (event.reason === 'failed' && event.error?.code === 'provider.filtered') {
      this.host.showStatus('Turn stopped: provider safety policy blocked the response.', 'error');
    }
    if (event.reason === 'blocked') {
      this.host.showStatus('Turn stopped: prompt hook blocked the request.', 'error');
    }
    const todos = this.host.state.todoPanel.getTodos();
    if (todos.length > 0 && todos.every((t) => t.status === 'done')) {
      this.host.streamingUI.setTodoList([]);
    }
    this.host.streamingUI.resetToolUi();
    this.host.streamingUI.finalizeTurn(sendQueued);
    this.clearTurnUsageTimer();
    this.latestStepUsageLive = undefined;
    // Fold the turn's settled output into the session-cumulative counter
    // (read before the clear) and reset the live slot in the same setAppState
    // so the AppState reference stays stable across the update.
    this.host.setAppState({
      turnUsage: undefined,
      sessionOutputTokens:
        (this.host.state.appState.sessionOutputTokens ?? 0) +
        (this.host.state.appState.turnUsage?.output ?? 0),
    });
    this.estimatedOutputTokens = 0;
    this.host.recordSessionActivity();
    this.renderPendingModelBlockedFallback();
    this.currentTurnHasAssistantText = false;
    this.goalCompletionTurnEnded = true;
    this.syncRunningAgentsFooter();
    // Plugin usage is reported once the whole turn's output has ended — but a
    // cancelled turn cut the output short, so skip the notice there.
    const reportPluginUsage = event.reason !== 'cancelled';
    const pluginCommandPluginId = this.pluginCommandTurns.get(String(event.turnId));
    if (pluginCommandPluginId !== undefined) {
      this.pluginCommandTurns.delete(String(event.turnId));
      if (reportPluginUsage) {
        void this.pluginUpdateNotifier.handlePluginCommandCompleted(pluginCommandPluginId);
      }
    }
    if (reportPluginUsage) {
      for (const toolName of this.pluginMcpToolsUsedInTurn) {
        void this.pluginUpdateNotifier.handleMcpToolCompleted(toolName);
      }
    }
    this.pluginMcpToolsUsedInTurn.clear();
    this.scheduleQueuedGoalPromotion();
  }

  private handleStepBegin(event: TurnStepStartedEvent): void {
    this.estimatedOutputTokens = 0;
    this.stepRetry = undefined;
    this.host.streamingUI.flushNow();
    this.host.streamingUI.setStep(event.step);
    this.host.streamingUI.resetToolUi();
    this.host.streamingUI.finalizeLiveTextBuffers('waiting');
    this.host.patchLivePane({
      mode: 'waiting',
      pendingApproval: null,
      pendingQuestion: null,
    });
    this.host.setAppState({
      streamingPhase: 'waiting',
      streamingStartTime: Date.now(),
    });
  }

  private accumulateTurnUsage(usage: TokenUsage | undefined): void {
    if (usage === undefined) return;
    const current = this.host.state.appState.turnUsage;
    if (current === undefined) return;
    this.host.setAppState({
      turnUsage: {
        // `input` is deliberately not accumulated: it is the full context of
        // each step request (system + history + tools), not tokens produced
        // this turn, and no display reads it — the footer and spinner only
        // show output. Summing it per step would inflate it by the context
        // size on every step. `live.input` is still replaced per step below.
        input: current.input,
        output: current.output + usage.output,
        turnStartedAt: current.turnStartedAt,
      },
    });
  }

  /**
   * Fold a completed step's exact usage into the session-cumulative cache
   * counters that feed the footer's cache-hit-rate slot. Unlike
   * {@link accumulateTurnUsage} the input split is kept: the hit rate is
   * cache-read over all input tokens, so the three input buckets must be
   * summed across steps (output is not needed for the rate).
   */
  private accumulateSessionCacheUsage(usage: TokenUsage | undefined): void {
    if (usage === undefined) return;
    const current = this.host.state.appState.sessionCacheUsage;
    this.host.setAppState({
      sessionCacheUsage: {
        inputOther: (current?.inputOther ?? 0) + usage.inputOther,
        inputCacheRead: (current?.inputCacheRead ?? 0) + usage.inputCacheRead,
        inputCacheCreation: (current?.inputCacheCreation ?? 0) + usage.inputCacheCreation,
      },
    });
  }

  /**
   * The event's usage is cumulative for the in-flight step, so it replaces
   * (not accumulates into) the live slot; the settled totals stay untouched
   * until the step completes. Pushed through a 250ms trailing throttle (see
   * {@link syncTurnUsageFooter}) because `turn.step.usage` fires repeatedly
   * while streaming and every event used to re-render the whole footer.
   */
  private handleStepUsage(event: TurnStepUsageEvent): void {
    const current = this.host.state.appState.turnUsage;
    if (current === undefined) return;
    this.latestStepUsageLive = {
      input:
        event.usage.inputOther + event.usage.inputCacheRead + event.usage.inputCacheCreation,
      output: event.usage.output,
    };
    this.syncTurnUsageFooter();
  }

  /**
   * Trailing 250ms throttle for the in-flight usage slot, mirroring
   * `syncRunningAgentsFooter`: a burst of usage events coalesces into one
   * appState push, while the timer still renders the last event of the burst
   * after the stream pauses. The coalesced apply re-reads
   * `latestStepUsageLive`, so the final applied value always equals the last
   * event received.
   */
  private syncTurnUsageFooter(): void {
    if (this.turnUsageSyncTimer !== undefined) return;
    this.turnUsageSyncTimer = setTimeout(() => {
      this.turnUsageSyncTimer = undefined;
      const current = this.host.state.appState.turnUsage;
      const live = this.latestStepUsageLive;
      if (current === undefined || live === undefined) return;
      this.latestStepUsageLive = undefined;
      this.host.setAppState({
        turnUsage: {
          ...current,
          live,
        },
      });
    }, FOOTER_SYNC_THROTTLE_MS);
  }

  private clearTurnUsageTimer(): void {
    if (this.turnUsageSyncTimer === undefined) return;
    clearTimeout(this.turnUsageSyncTimer);
    this.turnUsageSyncTimer = undefined;
  }

  /** Surfaces the in-flight step retry on the spinner status row so the user
   *  sees it waiting out the delay (e.g. rate limits / transient provider
   *  errors) instead of a silent spinner. */
  private handleStepRetrying(event: TurnStepRetryingEvent): void {
    this.stepRetry = {
      delayMs: event.delayMs,
      failedAttempt: event.failedAttempt,
      nextAttempt: event.nextAttempt,
      maxAttempts: event.maxAttempts,
      errorName: event.errorName,
    };
    this.host.state.ui.requestRender();
  }

  private handleStepCompleted(event: TurnStepCompletedEvent): void {
    this.host.streamingUI.flushNow();
    this.stepRetry = undefined;
    this.host.noteStepUsage(event.usage);
    this.accumulateTurnUsage(event.usage);
    this.accumulateSessionCacheUsage(event.usage);
    this.estimatedOutputTokens = 0;
    this.maybeShowDebugTiming(event);

    if (event.providerFinishReason === 'filtered') {
      this.host.showNotice(
        'Provider safety policy blocked the response.',
        `The model output was filtered (${event.rawFinishReason ?? 'content_filter'}).`,
      );
      return;
    }

    if (event.finishReason !== 'max_tokens') return;

    const truncatedCount = this.host.streamingUI.markStepTruncated(
      String(event.turnId),
      event.step,
    );

    const title =
      truncatedCount > 0
        ? 'Model hit max_tokens — tool call was truncated before it could run.'
        : 'Model hit max_tokens — no tool call was emitted.';
    const detail = this.isAnthropicSessionActive()
      ? 'If this limit is wrong for your model, set `max_output_size` on the model alias in your hasu config.'
      : undefined;
    this.host.showNotice(title, detail);
  }

  private maybeShowDebugTiming(event: TurnStepCompletedEvent): void {
    if (process.env['KIMI_CODE_DEBUG'] !== '1') return;
    const text = formatStepDebugTiming(event);
    if (text === undefined) return;
    this.host.appendTranscriptEntry({
      id: nextTranscriptId(),
      kind: 'status',
      turnId: String(event.turnId),
      renderMode: 'plain',
      content: text,
    });
  }

  private markActiveAgentSwarmsCancelled(): void {
    this.subAgentEventHandler.markActiveAgentSwarmsCancelled();
  }

  private isAnthropicSessionActive(): boolean {
    const { state } = this.host;
    const model = state.appState.availableModels[state.appState.model];
    if (model === undefined) return false;
    if (model.protocol === 'anthropic') return true;
    return state.appState.availableProviders[model.provider]?.type === 'anthropic';
  }

  private handleStepInterrupted(event: TurnStepInterruptedEvent): void {
    this.host.streamingUI.flushNow();
    this.stepRetry = undefined;
    this.host.streamingUI.resetToolUi();
    this.host.streamingUI.finalizeLiveTextBuffers('idle');
    const reason = event.reason;
    if (reason === 'error') return;
    if (reason === 'aborted' || reason === undefined || reason === '') {
      this.markActiveAgentSwarmsCancelled();
      if (event.message === undefined || event.message === '') {
        this.host.showStatus('Interrupted by user', 'error');
      } else {
        this.host.showError(event.message);
      }
      return;
    }
    this.host.showError(
      reason === 'max_steps'
        ? 'reached per-turn step limit (max_steps)'
        : `step interrupted (${reason})`,
    );
  }

  private handleThinkingDelta(event: ThinkingDeltaEvent): void {
    const { state, streamingUI } = this.host;
    this.estimatedOutputTokens += estimateStreamedTokens(event.delta);
    this.lastActivityAtMs = Date.now();
    // Encrypted / redacted reasoning (e.g. Kimi over the Anthropic-compatible
    // protocol) streams thinking deltas whose visible text is empty — only an
    // opaque signature rides along. Models also occasionally stream whitespace-
    // only thinking (e.g. a single space). Such deltas carry nothing to render,
    // so switching into the `thinking` pane mode here would stop the "waiting"
    // moon spinner while no ThinkingComponent is ever created (it needs visible
    // text), leaving a blank, spinner-less gap until the first real text/tool
    // token arrives. Keep the moon up until actual thinking text shows up.
    if (event.delta.trim().length === 0 && !streamingUI.hasThinkingDraft()) return;
    streamingUI.appendThinkingDelta(event.delta);
    this.host.patchLivePane({ mode: 'idle' });
    if (state.appState.streamingPhase !== 'thinking') {
      this.host.setAppState({ streamingPhase: 'thinking', streamingStartTime: Date.now() });
    }
    streamingUI.scheduleFlush();
  }

  private handleAssistantDelta(event: AssistantDeltaEvent): void {
    const { state, streamingUI } = this.host;
    this.estimatedOutputTokens += estimateStreamedTokens(event.delta);
    this.lastActivityAtMs = Date.now();
    if (streamingUI.hasThinkingDraft()) {
      streamingUI.flushThinkingToTranscript('idle');
    }

    if (event.delta.trim().length > 0) {
      this.currentTurnHasAssistantText = true;
      this.pendingModelBlockedFallback = undefined;
    }
    streamingUI.appendAssistantDelta(event.delta);

    this.host.patchLivePane({
      mode: 'idle',
      pendingApproval: null,
      pendingQuestion: null,
    });
    if (state.appState.streamingPhase !== 'composing') {
      this.host.setAppState({ streamingPhase: 'composing', streamingStartTime: Date.now() });
    }
    streamingUI.scheduleFlush();
  }

  private handleHookResult(event: HookResultEvent): void {
    this.host.streamingUI.flushNow();
    if (this.host.streamingUI.hasThinkingDraft()) {
      this.host.streamingUI.flushThinkingToTranscript('idle');
    }
    this.host.streamingUI.finalizeAssistantStream();
    if (event.content.trim().length > 0) {
      this.currentTurnHasAssistantText = true;
      this.pendingModelBlockedFallback = undefined;
    }
    this.host.appendTranscriptEntry({
      id: nextTranscriptId(),
      kind: 'assistant',
      turnId: String(event.turnId),
      renderMode: 'markdown',
      content: formatHookResultMarkdown(event),
    });
    this.host.patchLivePane({
      mode: 'idle',
      pendingApproval: null,
      pendingQuestion: null,
    });
  }

  private handleToolCall(event: ToolCallStartedEvent): void {
    const { streamingUI } = this.host;
    streamingUI.flushNow();
    const { turnId, step } = streamingUI.getTurnContext();
    const toolCall: ToolCallBlockData = {
      id: event.toolCallId,
      name: event.name,
      args: argsRecord(event.args),
      description: event.description,
      display: event.display,
      step,
      turnId,
    };
    streamingUI.registerToolCall(toolCall);
    if (event.name === 'AgentSwarm') {
      this.subAgentEventHandler.handleAgentSwarmToolCallStarted(event.toolCallId, toolCall.args);
    }
    this.host.patchLivePane({
      mode: 'tool',
      pendingApproval: null,
      pendingQuestion: null,
    });
  }

  private handleToolCallDelta(event: ToolCallDeltaEvent): void {
    this.estimatedOutputTokens += estimateStreamedTokens(event.argumentsPart ?? '');
    this.lastActivityAtMs = Date.now();
    if (event.toolCallId.length === 0) return;
    const { state, streamingUI } = this.host;
    streamingUI.accumulateToolCallDelta(event.toolCallId, event.name, event.argumentsPart);
    const preview = streamingUI.getStreamingToolCallPreview(event.toolCallId);
    if (
      preview !== undefined &&
      (preview.name === 'AgentSwarm' || this.subAgentEventHandler.hasAgentSwarmProgress(event.toolCallId))
    ) {
      this.subAgentEventHandler.handleAgentSwarmToolCallDelta(event.toolCallId, preview.args, {
        streamingArguments: preview.argumentsText,
      });
    }

    this.host.patchLivePane({
      mode: 'tool',
      pendingApproval: null,
      pendingQuestion: null,
    });
    if (state.appState.streamingPhase !== 'composing') {
      this.host.setAppState({ streamingPhase: 'composing', streamingStartTime: Date.now() });
    }
    streamingUI.scheduleFlush();
  }

  private handleToolProgress(event: ToolProgressEvent): void {
    this.lastActivityAtMs = Date.now();
    const text = event.update.text;
    if (text === undefined || text.length === 0) return;
    const tc = this.host.streamingUI.getToolComponent(event.toolCallId);
    if (tc === undefined) return;
    if (event.update.kind === 'status') {
      tc.appendProgress(text);
      return;
    }
    if (event.update.kind === 'stdout' || event.update.kind === 'stderr') {
      tc.appendLiveOutput(text);
    }
  }

  private handleToolResult(event: ToolResultEvent): void {
    const { streamingUI } = this.host;
    this.lastActivityAtMs = Date.now();
    streamingUI.flushNow();
    const resultData: ToolResultBlockData = {
      tool_call_id: event.toolCallId,
      output: serializeToolResultOutput(event.output),
      is_error: event.isError,
      synthetic: event.synthetic,
    };
    const matchedCall = streamingUI.completeToolResult(event.toolCallId, resultData);
    if (matchedCall !== undefined && isPluginMcpToolName(matchedCall.name)) {
      // Buffer plugin MCP usage for the turn; the update notice fires once the
      // whole turn's output has ended (see handleTurnEnd).
      this.pluginMcpToolsUsedInTurn.add(matchedCall.name);
    }
    this.subAgentEventHandler.handleAgentSwarmToolResult(
      event.toolCallId,
      resultData,
      event.isError === true,
    );
    if (matchedCall !== undefined && matchedCall.name === 'TodoList' && !event.isError) {
      const rawTodos = (matchedCall.args as { todos?: unknown }).todos;
      if (Array.isArray(rawTodos)) {
        const sanitized = rawTodos
          .filter((todo): todo is { title: string; status: 'pending' | 'in_progress' | 'done' } =>
            isTodoItemShape(todo),
          )
          .map((t) => ({ title: t.title, status: t.status }));
        streamingUI.setTodoList(sanitized);
      }
    }
    this.host.patchLivePane({ mode: 'waiting' });
  }

  private handleStatusUpdate(event: AgentStatusUpdatedEvent): void {
    const shouldRenderSwarmEnded =
      event.swarmMode === false &&
      this.host.state.appState.swarmMode &&
      this.host.state.swarmModeEntry === 'task';
    const patch: Partial<AppState> = {};
    if (event.contextUsage !== undefined) patch.contextUsage = event.contextUsage;
    if (event.contextTokens !== undefined) patch.contextTokens = event.contextTokens;
    if (event.maxContextTokens !== undefined) patch.maxContextTokens = event.maxContextTokens;
    if (event.planMode !== undefined) patch.planMode = event.planMode;
    if (event.swarmMode !== undefined) patch.swarmMode = event.swarmMode;
    if (event.ultracode !== undefined) patch.ultracode = event.ultracode;
    if (event.permission !== undefined) {
      patch.permissionMode = event.permission;
    }
    if (event.model !== undefined) patch.model = event.model;
    if (event.thinkingEffort !== undefined) patch.thinkingEffort = event.thinkingEffort;
    if (Object.keys(patch).length > 0) this.host.setAppState(patch);
    if (event.swarmMode === false) {
      this.host.state.swarmModeEntry = undefined;
      if (shouldRenderSwarmEnded) {
        this.renderSwarmModeMarker('ended');
      }
    }
    this.syncRunningAgentsFooter();
  }

  private renderSwarmModeMarker(state: SwarmModeMarkerState): void {
    this.host.state.transcriptContainer.addChild(
      new SwarmModeMarkerComponent(state),
    );
    this.host.state.ui.requestRender();
  }

  /**
   * Fold one `workflow.progress` event into `appState.workflowRuns`. The
   * reducer returns the same array reference when the event changes nothing
   * (unknown run, phase re-entry, late terminal settle), so `setAppState`'s
   * reference-equality gate skips redundant renders.
   */
  private handleWorkflowProgress(progress: WorkflowProgressEvent): void {
    const current = this.host.state.appState.workflowRuns;
    const next = applyWorkflowProgressEvent(current, progress);
    if (next === current) return;
    this.host.setAppState({ workflowRuns: next });
    this.syncBackgroundTaskBadge();
    // The footer workflow rows read this ledger — without a sync they would
    // keep showing the snapshot from whichever unrelated event last triggered
    // a recompute.
    this.syncRunningAgentsFooter();
  }

  private handleGoalUpdated(event: GoalUpdatedEvent): void {
    this.host.setAppState({ goal: event.snapshot });
    if (event.snapshot === null && this.goalCompletionAwaitingClear) {
      this.goalCompletionAwaitingClear = false;
      this.queuedGoalPromotionPending = true;
      this.scheduleQueuedGoalPromotion();
    }
    if (event.snapshot === null) {
      this.pendingModelBlockedFallback = undefined;
    }
    const change = event.change;
    if (change === undefined) return;
    const { state } = this.host;

    // Completion -> the box disappears (snapshot cleared on the follow-up null
    // update) and a deterministic completion message lands in the transcript.
    // Resume renders the same text from the durable goal completion replay
    // record, so live and replayed completion cards stay identical.
    if (change.kind === 'completion' && event.snapshot !== null) {
      this.pendingModelBlockedFallback = undefined;
      this.goalCompletionAwaitingClear = true;
      this.goalCompletionTurnEnded = false;
      this.host.appendTranscriptEntry({
        id: nextTranscriptId(),
        kind: 'assistant',
        renderMode: 'markdown',
        content: buildGoalCompletionMessage(event.snapshot),
      });
      state.ui.requestRender();
      return;
    }

    // Lifecycle change (pause / resume / blocked) -> a low-profile,
    // ctrl+o-expandable marker.
    if (change.kind === 'lifecycle' && change.status === 'blocked') {
      void this.notifyQueuedGoalWaitingOnBlocked();
      if (change.actor === 'model' || change.reason === undefined) {
        this.pendingModelBlockedFallback = this.currentTurnHasAssistantText
          ? undefined
          : change;
        return;
      }
      this.pendingModelBlockedFallback = undefined;
    } else if (change.kind === 'lifecycle') {
      this.pendingModelBlockedFallback = undefined;
    }
    const marker = buildGoalMarker(change, state.toolOutputExpanded, change.actor);
    if (marker !== null) {
      state.transcriptContainer.addChild(marker);
      state.ui.requestRender();
    }
  }

  private renderPendingModelBlockedFallback(): void {
    const change = this.pendingModelBlockedFallback;
    if (change === undefined) return;
    this.pendingModelBlockedFallback = undefined;
    const { state } = this.host;
    const marker = buildGoalMarker(change, state.toolOutputExpanded, 'model');
    if (marker !== null) {
      state.transcriptContainer.addChild(marker);
      state.ui.requestRender();
    }
  }

  private scheduleQueuedGoalPromotion(): void {
    if (!this.queuedGoalPromotionPending || !this.goalCompletionTurnEnded) return;
    if (this.queuedGoalPromotionInFlight) return;
    if (this.queuedGoalPromotionTimer !== undefined) return;
    this.queuedGoalPromotionTimer = setTimeout(() => {
      this.queuedGoalPromotionTimer = undefined;
      if (!this.queuedGoalPromotionPending || !this.goalCompletionTurnEnded) return;
      if (this.queuedGoalPromotionInFlight) return;
      if (!this.isReadyForQueuedGoalPromotion()) {
        return;
      }
      this.queuedGoalPromotionInFlight = true;
      void this.promoteNextQueuedGoal()
        .then((complete) => {
          if (complete) {
            this.queuedGoalPromotionPending = false;
            this.goalCompletionTurnEnded = false;
            return;
          }
          this.goalCompletionTurnEnded = false;
        })
        .finally(() => {
          this.queuedGoalPromotionInFlight = false;
          this.scheduleQueuedGoalPromotion();
        });
    }, 0);
  }

  private clearQueuedGoalPromotionTimer(): void {
    if (this.queuedGoalPromotionTimer === undefined) return;
    clearTimeout(this.queuedGoalPromotionTimer);
    this.queuedGoalPromotionTimer = undefined;
  }

  requestQueuedGoalPromotion(): void {
    this.queuedGoalPromotionPending = true;
    this.goalCompletionTurnEnded = true;
    this.scheduleQueuedGoalPromotion();
  }

  retryQueuedGoalPromotion(): void {
    this.scheduleQueuedGoalPromotion();
  }

  private isReadyForQueuedGoalPromotion(session?: Session): boolean {
    return (
      (session === undefined || this.host.session === session) &&
      !this.host.aborted &&
      this.host.state.appState.streamingPhase === 'idle' &&
      this.host.state.queuedMessages.length === 0 &&
      !this.host.state.queuedMessageDispatchPending
    );
  }

  private async promoteNextQueuedGoal(): Promise<boolean> {
    const { host } = this;
    const session = host.session;
    if (session === undefined || host.aborted) return true;

    let queue;
    try {
      queue = await readGoalQueue(session);
    } catch (error) {
      host.showError(`Failed to read upcoming goals: ${formatErrorMessage(error)}`);
      return false;
    }
    if (host.session !== session || host.aborted) return true;

    const next = queue.goals[0];
    if (next === undefined) return true;

    if (!this.isReadyForQueuedGoalPromotion(session)) return false;

    const started = await startGoalCommand(
      host,
      { kind: 'create', objective: next.objective, replace: false },
      next.objective,
      {
        beforeSend: async () => {
          if (!this.isReadyForQueuedGoalPromotion(session)) {
            await this.cancelStartedQueuedGoal(session);
            return false;
          }
          try {
            await removeGoalQueueItem(session, { goalId: next.id });
          } catch (error) {
            host.showError(
              `Queued goal started, but could not be removed from the queue: ${formatErrorMessage(error)}`,
            );
            await this.cancelStartedQueuedGoal(session);
            return false;
          }
          if (this.isReadyForQueuedGoalPromotion(session)) {
            return true;
          }
          await this.restoreAndCancelStartedQueuedGoal(session, next);
          return false;
        },
        sendInput: (objective) => {
          host.sendQueuedMessage(session, { text: objective });
        },
      },
    );
    return started || host.session !== session || host.aborted;
  }

  private async restoreAndCancelStartedQueuedGoal(
    session: Session,
    goal: UpcomingGoal,
  ): Promise<void> {
    try {
      await restoreGoalQueueItem(session, goal);
    } catch (error) {
      this.host.showError(`Queued goal could not be restored: ${formatErrorMessage(error)}`);
    }
    await this.cancelStartedQueuedGoal(session);
  }

  private async cancelStartedQueuedGoal(session: Session): Promise<void> {
    try {
      await session.cancelGoal();
    } catch (error) {
      this.host.showError(`Queued goal could not be cancelled: ${formatErrorMessage(error)}`);
    }
  }

  private async notifyQueuedGoalWaitingOnBlocked(): Promise<void> {
    const { host } = this;
    const session = host.session;
    if (session === undefined || host.aborted) return;

    let hasQueuedGoal = false;
    try {
      const queue = await readGoalQueue(session);
      hasQueuedGoal = queue.goals.length > 0;
    } catch {
      return;
    }
    if (!hasQueuedGoal || host.session !== session || host.aborted) return;

    host.showNotice(
      'Goal blocked.',
      'The next queued goal will start only after this goal is complete.',
    );
  }

  private handleSessionMetaChanged(event: SessionMetaUpdatedEvent): void {
    const title = event.title ?? stringValue(event.patch?.['title']);
    if (title !== undefined) {
      this.host.setAppState({ sessionTitle: title });
      this.host.updateTerminalTitle();
    }
  }

  private handleSessionError(event: ErrorEvent): void {
    this.host.streamingUI.flushNow();
    this.host.streamingUI.resetToolUi();
    this.host.streamingUI.finalizeLiveTextBuffers('idle');
    if (event.code === OAUTH_LOGIN_REQUIRED_CODE) {
      this.host.showError(OAUTH_LOGIN_REQUIRED_STARTUP_NOTICE);
      return;
    }
    this.host.showError(formatErrorPayload(event));
    const sessionId = this.host.state.appState.sessionId;
    if (sessionId.length > 0) {
      this.host.showStatus(errorReportHintLine());
    }
  }

  private handleSessionWarning(event: WarningEvent): void {
    this.host.showStatus(`Warning: ${event.message}`, 'warning');
  }

  private renderMcpServerStatus(server: McpServerStatusSnapshot): void {
    const key = mcpServerStatusKey(server);
    if (this.renderedMcpServerStatusKeys.get(server.name) === key) return;
    this.renderedMcpServerStatusKeys.set(server.name, key);
    this.mcpServers.set(server.name, server);
    const summary = formatMcpStartupStatusSummary([...this.mcpServers.values()]);
    this.host.setAppState({ mcpServersSummary: summary || null });

    switch (server.status) {
      case 'connected': {
        const toolStr = `${server.toolCount} tool${server.toolCount === 1 ? '' : 's'}`;
        const message = `MCP server "${server.name}" connected · ${toolStr} (${server.transport})`;
        this.finalizeMcpServerStatusRow(server.name, message, 'success');
        return;
      }
      case 'failed': {
        const message = `MCP server "${server.name}" failed${server.error !== undefined ? `: ${server.error}` : ''}`;
        this.finalizeMcpServerStatusRow(server.name, message, 'error');
        return;
      }
      case 'needs-auth': {
        const message = `MCP server "${server.name}" needs OAuth — run /mcp-config login ${server.name}`;
        this.finalizeMcpServerStatusRow(server.name, message, 'warning');
        return;
      }
      case 'disabled':
        this.finalizeMcpServerStatusRow(
          server.name,
          `MCP server "${server.name}" disabled`,
          'textMuted',
        );
        return;
      case 'removed':
        this.finalizeMcpServerStatusRow(
          server.name,
          `MCP server "${server.name}" removed`,
          'textMuted',
        );
        return;
      case 'pending':
        this.showMcpServerStatusSpinner(server.name);
        return;
    }
  }

  private showMcpServerStatusSpinner(name: string): void {
    const { state } = this.host;
    const label = `MCP server "${name}" connecting…`;
    const existing = this.mcpServerStatusSpinners.get(name);
    if (existing !== undefined) {
      existing.setLabel(label);
      return;
    }
    const tint = (s: string): string => currentTheme.fg('textMuted', s);
    const spinner = new MoonLoader(state.ui, 'braille', tint, label);
    state.transcriptContainer.addChild(spinner);
    this.mcpServerStatusSpinners.set(name, spinner);
    state.ui.requestRender();
  }

  private finalizeMcpServerStatusRow(name: string, message: string, color: ColorToken): void {
    const { state } = this.host;
    const spinner = this.mcpServerStatusSpinners.get(name);
    if (spinner === undefined) {
      this.host.showStatus(message, color);
      return;
    }
    spinner.stop();
    const status = new StatusMessageComponent(message, color);
    const children = state.transcriptContainer.children;
    const idx = children.indexOf(spinner);
    if (idx >= 0) {
      // In-place replacement rewires PARENT/version state via replaceChild
      // without a tree-wide invalidate.
      state.transcriptContainer.replaceChild(idx, status);
    } else {
      state.transcriptContainer.addChild(status);
    }
    this.mcpServerStatusSpinners.delete(name);
    state.ui.requestRender();
  }

  private handleSkillActivated(event: SkillActivatedEvent): void {
    if (this.renderedSkillActivationIds.has(event.activationId)) return;
    this.renderedSkillActivationIds.add(event.activationId);
    this.host.appendTranscriptEntry({
      id: nextTranscriptId(),
      kind: 'skill_activation',
      turnId: undefined,
      renderMode: 'plain',
      content: `Activated skill: ${event.skillName}`,
      skillActivationId: event.activationId,
      skillName: event.skillName,
      skillArgs: event.skillArgs,
      skillTrigger: event.trigger,
    });
  }

  private handlePluginCommandActivated(event: PluginCommandActivatedEvent): void {
    if (this.renderedPluginCommandActivationIds.has(event.activationId)) return;
    this.renderedPluginCommandActivationIds.add(event.activationId);
    this.host.appendTranscriptEntry({
      id: nextTranscriptId(),
      kind: 'plugin_command',
      turnId: undefined,
      renderMode: 'plain',
      content: `/${event.pluginId}:${event.commandName}`,
      pluginCommandData: {
        activationId: event.activationId,
        pluginId: event.pluginId,
        commandName: event.commandName,
        args: event.commandArgs,
        trigger: event.trigger,
      },
    });
  }

  private handleCompactionBegin(event: CompactionStartedEvent): void {
    this.host.streamingUI.finalizeLiveTextBuffers('waiting');
    this.host.setAppState({
      isCompacting: true,
      streamingPhase: 'waiting',
      streamingStartTime: Date.now(),
    });
    this.host.streamingUI.beginCompaction(event.instruction);
  }

  private handleCompactionEnd(
    event: CompactionCompletedEvent,
    sendQueued: (item: QueuedMessage) => void,
  ): void {
    this.host.streamingUI.endCompaction(
      event.result.tokensBefore,
      event.result.tokensAfter,
      event.result.summary,
    );
    // A completed compaction just refreshed and shrank the cached context —
    // count it as activity so the next submit isn't judged against the
    // pre-compaction timestamp, and reset the cache-break baseline (the drop
    // is expected). Cancellations do neither: the context was not cut.
    this.host.recordSessionActivity();
    this.host.noteCompactionFinished();
    this.finishCompaction(sendQueued);
  }

  private handleCompactionCancel(
    _event: CompactionCancelledEvent,
    sendQueued: (item: QueuedMessage) => void,
  ): void {
    this.host.streamingUI.cancelCompaction();
    this.finishCompaction(sendQueued);
  }

  private finishCompaction(sendQueued: (item: QueuedMessage) => void): void {
    const hasActiveTurn = this.host.streamingUI.hasActiveTurn();
    if (!hasActiveTurn) {
      const next = this.host.shiftQueuedMessage();
      if (next !== undefined) {
        this.host.state.queuedMessageDispatchPending = true;
      }
      this.host.setAppState({
        isCompacting: false,
        streamingPhase: 'idle',
      });
      this.host.resetLivePane();
      if (next !== undefined) {
        setTimeout(() => {
          this.host.state.queuedMessageDispatchPending = false;
          sendQueued(next);
        }, 0);
      }
    } else {
      this.host.setAppState({ isCompacting: false });
    }
  }

  // ---------------------------------------------------------------------------
  // Background task lifecycle
  // ---------------------------------------------------------------------------

  private handleBackgroundTaskEvent(
    event: BackgroundTaskStartedEvent | BackgroundTaskTerminatedEvent,
  ): void {
    const { state } = this.host;
    const { info } = event;
    // Workflow runs publish their own progress stream and TUI ledger. Track
    // only their lifecycle for the footer badge; the background-task browser
    // and transcript cards accept the legacy process/agent/question union.
    if (info.kind === 'workflow') {
      this.workflowBackgroundTasks.set(info.taskId, info);
      this.syncBackgroundTaskBadge();
      this.syncRunningAgentsFooter();
      return;
    }
    const previous = this.backgroundTasks.get(info.taskId);
    this.backgroundTasks.set(info.taskId, info);

    const viewer = state.tasksBrowser?.viewer;
    if (viewer !== undefined && viewer.taskId === info.taskId) {
      void this.host.tasksBrowserController.refreshOutputViewer({ silent: true });
    }

    const isTerminal =
      info.status === 'completed' ||
      info.status === 'failed' ||
      info.status === 'timed_out' ||
      info.status === 'killed' ||
      info.status === 'lost';

    if (event.type === 'background.task.started') {
      if (info.kind === 'agent') {
        // A foreground subagent detached via Ctrl+B: flip its card to
        // `◐ backgrounded` so it doesn't look like it completed.
        this.host.streamingUI.markSubagentBackgrounded(info.agentId);
        this.syncBackgroundTaskBadge();
        this.syncRunningAgentsFooter();
        this.host.tasksBrowserController.repaint();
        return;
      }
      this.appendBackgroundTaskEntry(info);
      this.syncBackgroundTaskBadge();
      this.syncRunningAgentsFooter();
      this.host.tasksBrowserController.repaint();
      return;
    }

    if (event.type === 'background.task.terminated' && isTerminal) {
      if (info.kind === 'agent') {
        // The Agent tool's spawn-success ToolResult is not an error, so the
        // parent toolCall card would otherwise render `✓ Completed` for any
        // terminated bg agent — including `lost` / `failed` / `killed`.
        // Push the actual terminal status so the card matches reality.
        this.host.streamingUI.applyBackgroundTaskTerminalStatus({
          agentId: info.agentId,
          description: info.description,
          status: info.status,
        });
      }
      if (!this.backgroundTaskTranscriptedTerminal.has(info.taskId)) {
        if (info.kind === 'process' || info.kind === 'question') {
          this.appendBackgroundTaskEntry(info);
        }
        this.backgroundTaskTranscriptedTerminal.add(info.taskId);
      }
      this.syncBackgroundTaskBadge();
      this.syncRunningAgentsFooter();
      this.host.tasksBrowserController.repaint();
      return;
    }

    if (previous?.status !== info.status) {
      this.syncBackgroundTaskBadge();
      this.syncRunningAgentsFooter();
    }
    this.host.tasksBrowserController.repaint();
  }

  private appendBackgroundTaskEntry(info: BackgroundTaskInfo): void {
    const status = formatBackgroundTaskTranscript(info);
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

  private syncBackgroundTaskBadge(): void {
    const { state } = this.host;
    let bashTasks = 0;
    let agentTasks = 0;
    let workflowTasks = 0;
    for (const info of this.workflowBackgroundTasks.values()) {
      if (info.status === 'running') workflowTasks += 1;
    }
    for (const info of this.backgroundTasks.values()) {
      if (
        info.status === 'completed' ||
        info.status === 'failed' ||
        info.status === 'timed_out' ||
        info.status === 'killed' ||
        info.status === 'lost'
      ) {
        continue;
      }
      if (info.kind === 'agent') {
        agentTasks += 1;
      } else {
        bashTasks += 1;
      }
    }
    state.footer.setBackgroundCounts({ bashTasks, agentTasks, workflowTasks });
    state.ui.requestRender();
  }

  /**
   * Throttled footer agent-row refresh. `agent.status.updated` (main and
   * subagents) and background-task events fire far more often than the footer
   * needs a recompute — 20+ parallel subagents can emit hundreds of events
   * per second, each previously re-reading every card snapshot. The trailing
   * timer coalesces a burst into one sync per FOOTER_SYNC_THROTTLE_MS and
   * still renders the last event of a burst after the stream pauses.
   */
  private syncRunningAgentsFooter(): void {
    if (this.footerSyncTimer !== undefined) return;
    this.footerSyncTimer = setTimeout(() => {
      this.footerSyncTimer = undefined;
      this.host.state.footer.setRunningAgents(this.subAgentEventHandler.collectRunningAgents());
      this.host.state.ui.requestRender();
    }, FOOTER_SYNC_THROTTLE_MS);
  }

  private clearFooterSyncTimer(): void {
    if (this.footerSyncTimer === undefined) return;
    clearTimeout(this.footerSyncTimer);
    this.footerSyncTimer = undefined;
  }
}
