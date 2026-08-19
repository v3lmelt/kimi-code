import type { Session } from '@moonshot-ai/kimi-code-sdk';

import { AgentGroupComponent } from '../components/messages/agent-group';
import { StreamingPreviewComponent } from '../components/messages/streaming-preview';
import { currentWorkingTip } from '../components/chrome/working-tips';
import { CompactionComponent } from '../components/dialogs/compaction';
import { ReadGroupComponent } from '../components/messages/read-group';
import { ThinkingComponent } from '../components/messages/thinking';
import { ToolCallComponent } from '../components/messages/tool-call';
import { STREAMING_UI_FIRST_FLUSH_MS, STREAMING_UI_FLUSH_MS } from '../constant/streaming';
import { hasDispose } from '../utils/component-capabilities';
import { appendStreamingArgsPreview, parseStreamingArgs } from '../utils/event-payload';
import { notifyTerminalOnce } from '../utils/terminal-notification';
import { nextTranscriptId } from '../utils/transcript-id';
import type { TodoItem } from '../components/chrome/todo-panel';
import type {
  AppState,
  LivePaneState,
  QueuedMessage,
  ToolCallBlockData,
  ToolResultBlockData,
  TranscriptEntry,
} from '../types';
import type { TUIState } from '../tui-state';

const SEARCH_READ_TOOLS = new Set(['Read', 'Grep', 'Glob']);

function isSearchReadTool(name: string): boolean {
  return SEARCH_READ_TOOLS.has(name);
}

export interface StreamingUIHost {
  state: TUIState;
  session: Session | undefined;
  setAppState(patch: Partial<AppState>): void;
  patchLivePane(patch: Partial<LivePaneState>): void;
  resetLivePane(): void;
  updateActivityPane(): void;
  updateQueueDisplay(): void;
  requireSession(): Session;
  deferUserMessages: boolean;
  shiftQueuedMessage(): QueuedMessage | undefined;
  pushTranscriptEntry(entry: TranscriptEntry): void;
  appendTranscriptEntry(entry: TranscriptEntry, options?: { push?: boolean }): void;
  mergeCurrentTurnSteps(): void;
  mergeCompletedTurnAssistants(): void;
}

/** How long a completed tool call's `ran tool for Ns` stays on the status
 *  suffix before fading back to the normal usage row. */
const TOOL_RUN_SHOW_MS = 5_000;

export class StreamingUIController {
  private flushTimer: ReturnType<typeof setTimeout> | undefined;
  private lastFlushAt: number | undefined;
  private pendingAssistantFlush = false;
  private pendingThinkingFlush = false;
  readonly pendingToolCallFlushIds = new Set<string>();

  // ---------------------------------------------------------------------------
  // Streaming runtime state (private — accessed via semantic methods below)
  // ---------------------------------------------------------------------------

  private _currentTurnId: string | undefined = undefined;
  private _currentStep = 0;
  private _assistantDraft = '';
  private _thinkingDraft = '';
  private _streamingBlock: { component: StreamingPreviewComponent; entry: TranscriptEntry } | null = null;
  private _activeThinkingComponent: ThinkingComponent | undefined = undefined;
  /** Thinking state for the spinner status row: `'thinking'` while streaming,
   *  a duration in ms after it ends, or `null` when idle. */
  private _thinkingStatus: 'thinking' | number | null = null;
  private _thinkingStartedAtMs: number | undefined = undefined;
  private _activeCompactionBlock: CompactionComponent | undefined = undefined;
  private _activeToolCalls = new Map<string, ToolCallBlockData>();
  /** Wall-clock start of each in-flight tool call, kept beyond
   *  `ToolCallBlockData.streamingStartedAtMs` because a full `tool.call.started`
   *  event carries no start time. Feeds the spinner's tool-call timer suffix. */
  private _toolCallStartedAtMs = new Map<string, number>();
  /** Last completed tool call's run window, so the spinner can briefly show
   *  `ran tool for Ns` after a call finishes. */
  private _lastToolRun: { startedAtMs: number; endedAtMs: number } | undefined = undefined;
  private _streamingToolCallArguments = new Map<
    string,
    { name?: string; argumentsText: string; startedAtMs: number }
  >();
  private _pendingToolComponents = new Map<string, ToolCallComponent>();
  private _pendingAgentGroup: {
    readonly turnId: string | undefined;
    readonly step: number;
    solo?: ToolCallComponent;
    group?: AgentGroupComponent;
  } | null = null;
  private _pendingReadGroup: {
    readonly turnId: string | undefined;
    readonly step: number;
    solo?: ToolCallComponent;
    group?: ReadGroupComponent;
  } | null = null;

  constructor(private readonly host: StreamingUIHost) {}

  // ---------------------------------------------------------------------------
  // Turn context — read/write accessors
  // ---------------------------------------------------------------------------

  getTurnContext(): { turnId: string | undefined; step: number } {
    return { turnId: this._currentTurnId, step: this._currentStep };
  }

  /** Current thinking state for the spinner status row (see `_thinkingStatus`). */
  getThinkingStatus(): 'thinking' | number | null {
    return this._thinkingStatus;
  }

  /** Wall-clock start of the current thinking run, for the spinner's
   *  long-thinking intensity ramp / phrase ladder. `undefined` once thinking
   *  ends (use {@link getThinkingStatus} for the settled duration). */
  getThinkingStartedAtMs(): number | undefined {
    return this._thinkingStartedAtMs;
  }

  setTurnId(turnId: string | undefined): void {
    this._currentTurnId = turnId;
  }

  setStep(step: number): void {
    this._currentStep = step;
  }

  hasActiveTurn(): boolean {
    return this._currentTurnId !== undefined;
  }

  // ---------------------------------------------------------------------------
  // Text streaming — semantic write accessors
  // ---------------------------------------------------------------------------

  appendThinkingDelta(delta: string): void {
    this._thinkingDraft += delta;
    this.pendingThinkingFlush = true;
  }

  appendAssistantDelta(delta: string): void {
    if (this._streamingBlock === null) {
      this.onStreamingTextStart();
    }
    this._assistantDraft += delta;
    this.pendingAssistantFlush = true;
  }

  hasThinkingDraft(): boolean {
    return this._thinkingDraft.length > 0;
  }

  hasActiveThinkingComponent(): boolean {
    return this._activeThinkingComponent !== undefined;
  }

  hasStreamingBlock(): boolean {
    return this._streamingBlock !== null;
  }

  getStreamingBlockComponent(): StreamingPreviewComponent | undefined {
    return this._streamingBlock?.component;
  }

  clearAssistantDraft(): void {
    this._assistantDraft = '';
  }

  // ---------------------------------------------------------------------------
  // Tool call state — semantic accessors
  // ---------------------------------------------------------------------------

  getActiveToolCall(id: string): ToolCallBlockData | undefined {
    return this._activeToolCalls.get(id);
  }

  hasActiveToolCall(id: string): boolean {
    return this._activeToolCalls.has(id);
  }

  setActiveToolCall(id: string, toolCall: ToolCallBlockData): void {
    this._activeToolCalls.set(id, toolCall);
  }

  removeActiveToolCall(id: string): void {
    this._activeToolCalls.delete(id);
  }

  /** Timing for the spinner's tool-call suffix. Returns the in-flight call's
   *  start while one is running, otherwise the last completed call's run window
   *  if it finished within the last TOOL_RUN_SHOW_MS. */
  getToolCallTimerInfo(): { startedAtMs: number; endedAtMs: number | undefined } | undefined {
    let runningStart: number | undefined;
    for (const call of this._activeToolCalls.values()) {
      if (call.result !== undefined || call.truncated === true) continue;
      const start = this._toolCallStartedAtMs.get(call.id) ?? call.streamingStartedAtMs;
      if (start === undefined) continue;
      if (runningStart === undefined || start < runningStart) runningStart = start;
    }
    if (runningStart !== undefined) return { startedAtMs: runningStart, endedAtMs: undefined };
    const last = this._lastToolRun;
    if (last !== undefined && Date.now() - last.endedAtMs < TOOL_RUN_SHOW_MS) {
      return { startedAtMs: last.startedAtMs, endedAtMs: last.endedAtMs };
    }
    return undefined;
  }

  getToolComponent(id: string): ToolCallComponent | undefined {
    return this._pendingToolComponents.get(id);
  }

  removeToolComponent(id: string): void {
    this._pendingToolComponents.delete(id);
  }

  hasPendingAgentGroup(): boolean {
    return this._pendingAgentGroup !== null;
  }

  hasPendingReadGroup(): boolean {
    return this._pendingReadGroup !== null;
  }

  removeToolComponentIfInactive(toolCallId: string): void {
    if (!this._activeToolCalls.has(toolCallId)) {
      this._pendingToolComponents.delete(toolCallId);
    }
  }

  /**
   * Push the actual terminal status of a background agent task into the
   * matching `Agent` tool call component so its snapshot phase no longer
   * trusts the spawn-success ToolResult (which would otherwise label every
   * terminated bg agent — including `lost` ones — as `✓ Completed`).
   *
   * Resolution policy: an `args.agentId` is treated as authoritative — we
   * either find a card whose `getSubagentAgentId()` returns the same id
   * (in-memory metadata for live foreground, parsed from the spawn-success
   * `agent_id: ...` line for live backgrounded and replayed cards) or we
   * skip. We deliberately do NOT fall back to description match when
   * `agentId` is provided, because:
   *   - On resume, `applyTerminalBackgroundAgentStatuses` iterates every
   *     persisted terminal task, including ones whose tool calls fell
   *     outside the `REPLAY_TURN_LIMIT` window. A description fallback
   *     would let an old `lost` task stamp its status onto an unrelated
   *     recent Agent card that happens to share `args.description`.
   *   - During a live spawn / terminate race, the same card can briefly
   *     appear in both `_pendingToolComponents` and `transcriptContainer`,
   *     so a description match could double-visit the same component and
   *     mark itself ambiguous. agentId match short-circuits on the first
   *     hit and is immune.
   *
   * Description fallback is kept as a best-effort path only when
   * `agentId` is unknown — that is, on resume of pre-PR sessions whose
   * disk records pre-date `agent_id` persistence.
   *
   * Search scope includes both in-flight components and already-mounted
   * cards (some live in `transcriptContainer` standalone, others are
   * borrowed by an `AgentGroupComponent` and reachable only via
   * `getToolComponents()`).
   *
   * Returns true iff a component was found and updated.
   */
  applyBackgroundTaskTerminalStatus(args: {
    agentId?: string | undefined;
    description: string;
    status: 'completed' | 'failed' | 'timed_out' | 'killed' | 'lost';
    /**
     * Real failure message to surface on the card. Pass the `subagent.failed`
     * event's `error` for live crashes — it is far more useful than the
     * friendly generic the card falls back to. Omit on the resume / terminate
     * path where no real error is available.
     */
    errorText?: string | undefined;
  }): boolean {
    const useAgentIdOnly = args.agentId !== undefined;
    let agentIdMatch: ToolCallComponent | undefined;
    let descMatch: ToolCallComponent | undefined;
    let descAmbiguous = false;
    const visit = (tc: ToolCallComponent): void => {
      if (agentIdMatch !== undefined) return;
      if (useAgentIdOnly) {
        if (tc.getSubagentAgentId() === args.agentId) agentIdMatch = tc;
        return;
      }
      if (tc.getAgentToolDescription() !== args.description) return;
      if (descMatch !== undefined) {
        descAmbiguous = true;
        return;
      }
      descMatch = tc;
    };

    for (const tc of this._pendingToolComponents.values()) {
      visit(tc);
      if (agentIdMatch !== undefined) break;
    }
    if (agentIdMatch === undefined) {
      for (const child of this.host.state.transcriptContainer.children) {
        if (child instanceof ToolCallComponent) {
          visit(child);
        } else if (child instanceof AgentGroupComponent) {
          for (const tc of child.getToolComponents()) {
            visit(tc);
            if (agentIdMatch !== undefined) break;
          }
        }
        if (agentIdMatch !== undefined) break;
      }
    }
    const target = useAgentIdOnly
      ? agentIdMatch
      : descAmbiguous
        ? undefined
        : descMatch;
    if (target === undefined) return false;
    target.setBackgroundTaskTerminalStatus(args.status, { errorText: args.errorText });
    return true;
  }

  /**
   * Mark a foreground subagent card as detached-to-background (`◐ backgrounded`).
   * Routed from a `background.task.started` event whose `info.kind === 'agent'`,
   * keyed by `agentId`. Returns true iff a matching component was found.
   *
   * Gated to cards that are currently foreground-running: `background.task.started`
   * also fires for `Agent(run_in_background=true)` launches and for background
   * resumes, and those must not mutate older completed rows that happen to share
   * the same `agentId` (a resume's new card has no parsed `agent_id` yet, so the
   * search can otherwise hit the previous completed card).
   */
  markSubagentBackgrounded(agentId: string | undefined): boolean {
    if (agentId === undefined) return false;
    const visit = (tc: ToolCallComponent): boolean => {
      if (tc.getSubagentAgentId() !== agentId) return false;
      const phase = tc.getSubagentSnapshot().phase;
      if (phase !== 'running' && phase !== 'queued' && phase !== 'spawning') return false;
      tc.markBackgrounded();
      return true;
    };
    for (const tc of this._pendingToolComponents.values()) {
      if (visit(tc)) return true;
    }
    for (const child of this.host.state.transcriptContainer.children) {
      if (child instanceof ToolCallComponent) {
        if (visit(child)) return true;
      } else if (child instanceof AgentGroupComponent) {
        for (const tc of child.getToolComponents()) {
          if (visit(tc)) return true;
        }
      }
    }
    return false;
  }

  /** Registers a tool call that arrived via tool.call.started.
   *  Clears any pending streaming state for this id, updates or creates the
   *  component, and returns whether the call was new (no previous entry). */
  registerToolCall(toolCall: ToolCallBlockData): boolean {
    const existing = this._activeToolCalls.get(toolCall.id);
    this._activeToolCalls.set(toolCall.id, toolCall);
    this.pendingToolCallFlushIds.delete(toolCall.id);
    this._streamingToolCallArguments.delete(toolCall.id);
    // Stamp a start time the first time we see the call (a full
    // `tool.call.started` event carries none; a streaming preview may already
    // have set one, which we keep as the earliest).
    if (!this._toolCallStartedAtMs.has(toolCall.id)) {
      this._toolCallStartedAtMs.set(toolCall.id, toolCall.streamingStartedAtMs ?? Date.now());
    }
    const existingComponent = this._pendingToolComponents.get(toolCall.id);
    if (existingComponent !== undefined) {
      existingComponent.updateToolCall(toolCall);
    } else if (toolCall.name !== 'Agent' && toolCall.name !== 'AgentSwarm') {
      // The card is created only once the full tool call arrives (no streaming
      // preview), so create it here regardless of whether the streaming deltas
      // seeded `_activeToolCalls`.
      this.finalizeLiveTextBuffers('tool');
      this.onToolCallStart(toolCall);
    }
    return existing === undefined;
  }

  /** Accumulates a streaming tool-call argument delta. */
  accumulateToolCallDelta(
    id: string,
    eventName: string | undefined,
    argumentsPart: string | null | undefined,
  ): void {
    const existing = this._streamingToolCallArguments.get(id);
    const argumentsText = appendStreamingArgsPreview(existing?.argumentsText, argumentsPart);
    const name = eventName ?? existing?.name ?? this._activeToolCalls.get(id)?.name ?? 'Tool';
    const startedAtMs = existing?.startedAtMs ?? Date.now();
    this._streamingToolCallArguments.set(id, { name, argumentsText, startedAtMs });
    if (!this._toolCallStartedAtMs.has(id)) {
      this._toolCallStartedAtMs.set(id, startedAtMs);
    }
    this.pendingToolCallFlushIds.add(id);
  }

  getStreamingToolCallPreview(
    id: string,
  ): { name: string; args: Record<string, unknown>; argumentsText: string; startedAtMs: number } | undefined {
    const streaming = this._streamingToolCallArguments.get(id);
    if (streaming === undefined) return undefined;
    return {
      name: streaming.name ?? this._activeToolCalls.get(id)?.name ?? 'Tool',
      args: parseStreamingArgs(streaming.argumentsText),
      argumentsText: streaming.argumentsText,
      startedAtMs: streaming.startedAtMs,
    };
  }

  /** Completes a tool call: delivers the result and removes tracking state.
   *  Returns the matched ToolCallBlockData, or undefined if no call was tracked. */
  completeToolResult(toolCallId: string, result: ToolResultBlockData): ToolCallBlockData | undefined {
    const matchedCall = this._activeToolCalls.get(toolCallId);
    if (matchedCall !== undefined) {
      this.onToolCallEnd(toolCallId, result);
    }
    const startedAt = this._toolCallStartedAtMs.get(toolCallId) ?? matchedCall?.streamingStartedAtMs;
    if (startedAt !== undefined) {
      this._lastToolRun = { startedAtMs: startedAt, endedAtMs: Date.now() };
    }
    this._activeToolCalls.delete(toolCallId);
    this._toolCallStartedAtMs.delete(toolCallId);
    this._streamingToolCallArguments.delete(toolCallId);
    return matchedCall;
  }

  /** Marks in-flight tool calls as truncated when a step hits max_tokens.
   *  Returns the count of tool calls that were truncated. */
  markStepTruncated(turnId: string, step: number): number {
    let count = 0;
    for (const toolCall of this._activeToolCalls.values()) {
      if (toolCall.result !== undefined) continue;
      if (toolCall.streamingArguments === undefined) continue;
      if (toolCall.turnId !== turnId) continue;
      if (toolCall.step !== step) continue;
      toolCall.truncated = true;
      const component = this._pendingToolComponents.get(toolCall.id);
      if (component !== undefined) {
        component.updateToolCall(toolCall);
      } else if (toolCall.name !== 'Agent' && toolCall.name !== 'AgentSwarm') {
        // Streaming never created a card (A1), so mount a truncated card now —
        // otherwise a max_tokens-truncated call would be invisible.
        this.finalizeLiveTextBuffers('tool');
        this.onToolCallStart(toolCall);
      }
      count += 1;
    }
    this._streamingToolCallArguments.clear();
    return count;
  }

  /** Tears down replay-specific state after session history has been rendered. */
  cleanupAfterReplay(completedToolCallIds: Set<string>): void {
    this._activeToolCalls.clear();
    this._toolCallStartedAtMs.clear();
    this._lastToolRun = undefined;
    for (const toolCallId of completedToolCallIds) {
      this._pendingToolComponents.delete(toolCallId);
    }
    this._pendingAgentGroup = null;
    this._pendingReadGroup = null;
    this._currentTurnId = undefined;
    this._currentStep = 0;
    this._streamingToolCallArguments.clear();
    this.pendingToolCallFlushIds.clear();
    this.host.state.previewContainer.clear();
    this.host.state.ui.requestRender();
  }

  // ---------------------------------------------------------------------------
  // Dispose helpers (moved from KimiTUI)
  // ---------------------------------------------------------------------------

  disposeActiveThinkingComponent(): void {
    if (this._activeThinkingComponent !== undefined) {
      this._activeThinkingComponent.dispose();
      this._activeThinkingComponent = undefined;
    }
  }

  disposeAndClearPendingToolComponents(): void {
    for (const component of this._pendingToolComponents.values()) {
      if (hasDispose(component)) component.dispose();
    }
    this._pendingToolComponents.clear();
  }

  disposeActiveCompactionBlock(): void {
    if (this._activeCompactionBlock !== undefined) {
      this._activeCompactionBlock.dispose();
      this._activeCompactionBlock = undefined;
    }
  }

  // ---------------------------------------------------------------------------
  // Flush control
  // ---------------------------------------------------------------------------

  hasPending(): boolean {
    return (
      this.pendingAssistantFlush ||
      this.pendingThinkingFlush ||
      this.pendingToolCallFlushIds.size > 0
    );
  }

  clearFlushTimer(): void {
    if (this.flushTimer === undefined) return;
    clearTimeout(this.flushTimer);
    this.flushTimer = undefined;
  }

  private clearFlushTimerIfIdle(): void {
    if (this.hasPending()) return;
    this.clearFlushTimer();
  }

  discardPending(): void {
    this.clearFlushTimer();
    this.pendingAssistantFlush = false;
    this.pendingThinkingFlush = false;
    this.pendingToolCallFlushIds.clear();
  }

  scheduleFlush(): void {
    if (!this.hasPending()) return;
    if (this.flushTimer !== undefined) return;
    const delay =
      this.lastFlushAt === undefined
        ? STREAMING_UI_FIRST_FLUSH_MS
        : Math.max(0, STREAMING_UI_FLUSH_MS - (Date.now() - this.lastFlushAt));
    this.flushTimer = setTimeout(() => {
      this.flushTimer = undefined;
      this.flush();
    }, delay);
  }

  flushNow(): void {
    this.clearFlushTimer();
    this.flush();
  }

  private flush(): void {
    if (!this.hasPending()) return;
    this.lastFlushAt = Date.now();
    const shouldFlushThinking = this.pendingThinkingFlush;
    const shouldFlushAssistant = this.pendingAssistantFlush;
    const toolCallIds = [...this.pendingToolCallFlushIds];
    this.pendingThinkingFlush = false;
    this.pendingAssistantFlush = false;
    this.pendingToolCallFlushIds.clear();

    if (shouldFlushThinking && this._thinkingDraft.length > 0) {
      this.onThinkingUpdate(this._thinkingDraft);
    }
    if (shouldFlushAssistant) {
      this.onStreamingTextUpdate(this._assistantDraft);
    }
    for (const id of toolCallIds) {
      this.flushToolCallPreview(id);
    }
  }

  markAssistantDirty(): void {
    this.pendingAssistantFlush = true;
  }

  markThinkingDirty(): void {
    this.pendingThinkingFlush = true;
  }

  // ---------------------------------------------------------------------------
  // Text streaming
  // ---------------------------------------------------------------------------

  flushThinkingToTranscript(nextMode: LivePaneState['mode'] = 'idle'): void {
    this.flushNow();
    this._thinkingDraft = '';
    this.onThinkingEnd();
    this.host.patchLivePane({ mode: nextMode });
  }

  finalizeAssistantStream(): void {
    this.flushNow();
    if (this._streamingBlock !== null) {
      this.onStreamingTextEnd();
    }
    this._assistantDraft = '';
    this.host.updateActivityPane();
    this.host.state.ui.requestRender();
  }

  resetLiveText(): void {
    this.pendingAssistantFlush = false;
    this.pendingThinkingFlush = false;
    this.clearFlushTimerIfIdle();
    this._assistantDraft = '';
    if (this._streamingBlock !== null) {
      // Drop the partially-streamed entry from the transcript list; it was
      // pushed by onStreamingTextStart but never committed.
      const entry = this._streamingBlock.entry;
      const i = this.host.state.transcriptEntries.indexOf(entry);
      if (i >= 0) this.host.state.transcriptEntries.splice(i, 1);
    }
    this.host.state.previewContainer.clear();
    this._streamingBlock = null;
    this._thinkingDraft = '';
    this._thinkingStatus = null;
    this._thinkingStartedAtMs = undefined;
    this.disposeActiveThinkingComponent();
  }

  resetToolUi(): void {
    this.pendingToolCallFlushIds.clear();
    this.clearFlushTimerIfIdle();
    this._streamingToolCallArguments.clear();
    this.disposeAndClearPendingToolComponents();
    this._pendingAgentGroup = null;
    this._pendingReadGroup = null;
    this._thinkingStatus = null;
    this._thinkingStartedAtMs = undefined;
    this.resetToolCallState();
  }

  resetToolCallState(): void {
    this._activeToolCalls.clear();
    this._toolCallStartedAtMs.clear();
    this._lastToolRun = undefined;
  }

  finalizeLiveTextBuffers(nextMode: LivePaneState['mode'] = 'idle'): void {
    this.flushThinkingToTranscript(nextMode);
    this.finalizeAssistantStream();
  }

  finalizeTurn(sendQueued: (item: QueuedMessage) => void): void {
    const { state } = this.host;
    if (state.appState.streamingPhase === 'idle') return;
    this.host.deferUserMessages = false;
    const completedTurnKey =
      this._currentTurnId ?? `local:${String(state.appState.streamingStartTime)}`;
    this.finalizeLiveTextBuffers('idle');
    // The finished turn keeps only its conclusion-bearing tail; intermediate
    // chatter folds into the step summary.
    this.host.mergeCompletedTurnAssistants();
    this.resetToolCallState();
    this._currentTurnId = undefined;

    const next = this.host.shiftQueuedMessage();
    if (next !== undefined) {
      // The message is out of the queue but not yet sent. Mark the dispatch
      // pending *before* setAppState — that call synchronously retries
      // queued-goal promotion, which would otherwise see an empty queue and an
      // idle phase and start a goal ahead of this message.
      state.queuedMessageDispatchPending = true;
      this.host.setAppState({ streamingPhase: 'idle' });
      this.host.resetLivePane();
      setTimeout(() => {
        state.queuedMessageDispatchPending = false;
        sendQueued(next);
      }, 0);
      return;
    }

    this.host.setAppState({ streamingPhase: 'idle' });
    this.host.resetLivePane();
    notifyTerminalOnce(state, `turn-complete:${completedTurnKey}`, {
      title: 'Hasu task complete',
      body: state.appState.sessionTitle ?? undefined,
    });
  }

  // ---------------------------------------------------------------------------
  // Live Render Hooks
  // ---------------------------------------------------------------------------

  onStreamingTextStart(): void {
    const { state } = this.host;
    this._pendingAgentGroup = null;
    this._pendingReadGroup = null;
    const entry = {
      id: nextTranscriptId(),
      kind: 'assistant' as const,
      turnId: this._currentTurnId,
      renderMode: 'markdown' as const,
      content: '',
      modelText: true,
    };
    const component = new StreamingPreviewComponent();
    this._streamingBlock = { component, entry };
    this.host.pushTranscriptEntry(entry);
    state.previewContainer.clear();
    state.previewContainer.addChild(component);
    state.ui.requestRender();
  }

  onStreamingTextUpdate(fullText: string): void {
    const block = this._streamingBlock;
    if (block !== null) {
      block.entry.content = fullText;
      block.component.updateContent(fullText, { transient: true });
      this.host.state.ui.requestRender();
    }
  }

  onStreamingTextEnd(): void {
    const block = this._streamingBlock;
    if (block !== null) {
      block.component.updateContent(block.entry.content, { transient: false });
      this.host.state.previewContainer.clear();
      // The entry was already pushed by onStreamingTextStart (for `/copy`),
      // so mount the committed message without duplicating it in the list.
      this.host.appendTranscriptEntry(block.entry, { push: false });
    }
    this._streamingBlock = null;
  }

  onThinkingUpdate(fullText: string): void {
    // Skip thinking that carries nothing visible — empty (e.g. encrypted
    // reasoning) or whitespace-only (a model occasionally streams a single
    // space as thinking). Session replay funnels through here as well, so a
    // stored whitespace-only think part never becomes a bare bullet line.
    if (fullText.trim().length === 0 && this._activeThinkingComponent === undefined) return;
    const { state } = this.host;
    if (this._activeThinkingComponent === undefined) {
      this._pendingAgentGroup = null;
      this._pendingReadGroup = null;
      this._thinkingStartedAtMs = Date.now();
      this._thinkingStatus = 'thinking';
      this._activeThinkingComponent = new ThinkingComponent(
        fullText,
        true,
        'live',
        state.ui,
        state.appState.hideThinking === true,
      );
      if (state.toolOutputExpanded) this._activeThinkingComponent.setExpanded(true);
      state.transcriptContainer.addChild(this._activeThinkingComponent);
    } else {
      this._activeThinkingComponent.setText(fullText);
      this._activeThinkingComponent.setCollapse(state.appState.hideThinking === true);
    }
    state.ui.requestRender();
  }

  onThinkingEnd(): void {
    if (this._activeThinkingComponent === undefined) return;
    this._activeThinkingComponent.finalize();
    this._activeThinkingComponent = undefined;
    if (this._thinkingStartedAtMs !== undefined) {
      this._thinkingStatus = Date.now() - this._thinkingStartedAtMs;
      this._thinkingStartedAtMs = undefined;
    }
    this.host.state.ui.requestRender();
    this.host.mergeCurrentTurnSteps();
  }

  onToolCallStart(toolCall: ToolCallBlockData): void {
    if (toolCall.name === 'AskUserQuestion') return;

    const { state } = this.host;
    const tc = new ToolCallComponent(
      toolCall,
      undefined,
      state.ui,
      state.appState.workDir,
    );
    if (state.toolOutputExpanded) tc.setExpanded(true);
    this._pendingToolComponents.set(toolCall.id, tc);

    if (toolCall.name !== 'Agent') this._pendingAgentGroup = null;
    if (!isSearchReadTool(toolCall.name)) this._pendingReadGroup = null;

    let handled = this.tryAttachAgentToolCall(toolCall, tc);
    if (!handled) handled = this.tryAttachSearchReadToolCall(toolCall, tc);
    if (!handled) {
      state.transcriptContainer.addChild(tc);
      state.ui.requestRender();
    }

    if (toolCall.name === 'ExitPlanMode' && typeof toolCall.args['plan'] !== 'string') {
      const session = this.host.requireSession();
      void (async () => {
        try {
          const plan = await session.getPlan();
          tc.setPlanInfo(plan === null ? {} : { plan: plan.content, path: plan.path });
        } catch {
          tc.setPlanInfo({});
        }
      })();
    }
  }

  onToolCallEnd(toolCallId: string, result: ToolResultBlockData): void {
    const { state } = this.host;
    const matchedCall = this._activeToolCalls.get(toolCallId);
    const tc = this._pendingToolComponents.get(toolCallId);
    if (tc) {
      tc.setResult(result);
      this._pendingToolComponents.delete(toolCallId);
      state.ui.requestRender();
      this.host.mergeCurrentTurnSteps();
      return;
    }

    if (matchedCall?.name === 'AskUserQuestion') {
      const completed = new ToolCallComponent(
        matchedCall,
        result,
        state.ui,
        state.appState.workDir,
      );
      if (state.toolOutputExpanded) completed.setExpanded(true);
      state.transcriptContainer.addChild(completed);
      state.ui.requestRender();
    }
    this.host.mergeCurrentTurnSteps();
  }

  setTodoList(todos: readonly TodoItem[]): void {
    const { state } = this.host;
    state.todoPanel.setTodos(todos);
    state.todoPanelContainer.clear();
    if (!state.todoPanel.isEmpty()) {
      state.todoPanelContainer.addChild(state.todoPanel);
    }
    state.ui.requestRender();
  }

  beginCompaction(instruction?: string): void {
    const { state } = this.host;
    if (this._activeCompactionBlock !== undefined) {
      this._activeCompactionBlock.markDone();
      this._activeCompactionBlock = undefined;
    }
    const block = new CompactionComponent(state.ui, instruction, currentWorkingTip()?.text);
    this._activeCompactionBlock = block;
    state.transcriptContainer.addChild(block);
    if (state.toolOutputExpanded) {
      block.setExpanded(true);
    }
    state.ui.requestRender();
  }

  endCompaction(tokensBefore?: number, tokensAfter?: number, summary?: string): void {
    const block = this._activeCompactionBlock;
    if (block === undefined) return;
    block.markDone(tokensBefore, tokensAfter, summary);
    this._activeCompactionBlock = undefined;
    this.host.state.ui.requestRender();
  }

  cancelCompaction(): void {
    const block = this._activeCompactionBlock;
    if (block === undefined) return;
    block.markCanceled();
    this._activeCompactionBlock = undefined;
    this.host.state.ui.requestRender();
  }

  // ---------------------------------------------------------------------------
  // Tool call grouping
  // ---------------------------------------------------------------------------

  private flushToolCallPreview(id: string): void {
    const streaming = this._streamingToolCallArguments.get(id);
    if (streaming === undefined) return;
    const toolCall: ToolCallBlockData = {
      id,
      name: streaming.name ?? this._activeToolCalls.get(id)?.name ?? 'Tool',
      args: parseStreamingArgs(streaming.argumentsText),
      streamingArguments: streaming.argumentsText,
      streamingStartedAtMs: streaming.startedAtMs,
      step: this._currentStep,
      turnId: this._currentTurnId,
    };
    this._activeToolCalls.set(id, toolCall);

    if (this._thinkingDraft.length > 0 || this._streamingBlock !== null) {
      this.finalizeLiveTextBuffers('tool');
    }

    // No component creation during streaming: the card pops in fully-formed at
    // `tool.call.started` (see registerToolCall).
  }

  private tryAttachAgentToolCall(toolCall: ToolCallBlockData, tc: ToolCallComponent): boolean {
    const { state } = this.host;
    if (toolCall.name !== 'Agent') {
      this._pendingAgentGroup = null;
      return false;
    }

    const step = toolCall.step ?? this._currentStep;
    const turnId = toolCall.turnId ?? this._currentTurnId;
    const pending = this._pendingAgentGroup;

    if (pending !== null && (pending.step !== step || pending.turnId !== turnId)) {
      this._pendingAgentGroup = null;
    }

    const cur = this._pendingAgentGroup;
    if (cur === null) {
      this._pendingAgentGroup = { step, turnId, solo: tc };
      state.transcriptContainer.addChild(tc);
      state.ui.requestRender();
      return true;
    }

    if (cur.group !== undefined) {
      cur.group.attach(toolCall.id, tc);
      return true;
    }

    const solo = cur.solo;
    if (solo === undefined) {
      this._pendingAgentGroup = { step, turnId, solo: tc };
      state.transcriptContainer.addChild(tc);
      state.ui.requestRender();
      return true;
    }
    const group = this.upgradeSoloAgentToGroup(solo);
    group.attach(toolCall.id, tc);
    this._pendingAgentGroup = { step, turnId, group };
    state.ui.requestRender();
    return true;
  }

  private upgradeSoloAgentToGroup(solo: ToolCallComponent): AgentGroupComponent {
    const { state } = this.host;
    const group = new AgentGroupComponent(state.ui);
    const children = state.transcriptContainer.children;
    const idx = children.indexOf(solo);
    if (idx >= 0) {
      // In-place replacement rewires PARENT/version state via replaceChild
      // without a tree-wide invalidate.
      state.transcriptContainer.replaceChild(idx, group);
    } else {
      state.transcriptContainer.addChild(group);
    }
    group.attach(solo.toolCallView.id, solo);
    return group;
  }

  private tryAttachSearchReadToolCall(toolCall: ToolCallBlockData, tc: ToolCallComponent): boolean {
    const { state } = this.host;
    if (!isSearchReadTool(toolCall.name)) {
      this._pendingReadGroup = null;
      return false;
    }

    const step = toolCall.step ?? this._currentStep;
    const turnId = toolCall.turnId ?? this._currentTurnId;
    const pending = this._pendingReadGroup;

    if (pending !== null && (pending.step !== step || pending.turnId !== turnId)) {
      this._pendingReadGroup = null;
    }

    const cur = this._pendingReadGroup;
    if (cur === null) {
      this._pendingReadGroup = { step, turnId, solo: tc };
      state.transcriptContainer.addChild(tc);
      state.ui.requestRender();
      return true;
    }

    if (cur.group !== undefined) {
      cur.group.attach(toolCall.id, tc);
      return true;
    }

    const solo = cur.solo;
    if (solo === undefined) {
      this._pendingReadGroup = { step, turnId, solo: tc };
      state.transcriptContainer.addChild(tc);
      state.ui.requestRender();
      return true;
    }
    const group = this.upgradeSoloReadToGroup(solo);
    group.attach(toolCall.id, tc);
    this._pendingReadGroup = { step, turnId, group };
    state.ui.requestRender();
    return true;
  }

  private upgradeSoloReadToGroup(solo: ToolCallComponent): ReadGroupComponent {
    const { state } = this.host;
    const group = new ReadGroupComponent(state.ui);
    const children = state.transcriptContainer.children;
    const idx = children.indexOf(solo);
    if (idx >= 0) {
      // In-place replacement rewires PARENT/version state via replaceChild
      // without a tree-wide invalidate.
      state.transcriptContainer.replaceChild(idx, group);
    } else {
      state.transcriptContainer.addChild(group);
    }
    group.attach(solo.toolCallView.id, solo);
    return group;
  }
}
