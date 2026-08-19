/**
 * `toolExecutor` domain — tool-execution event and hook contexts.
 *
 * Defines the event objects and context records carried by
 * `IAgentToolExecutorService`'s execution-interception surface:
 *
 * - `onBeforeExecuteTool` (veto event, `BeforeToolExecuteEvent`): listeners
 *   answer with `veto(result)` (replace the execution with the given tool
 *   result — an `isError: true` result is a policy deny that wins on the spot
 *   and ends adjudication, anything else is a reorderable short-circuit that
 *   is captured but does not stop the loop, so the permission chain always
 *   adjudicates and its deny can never be skipped by an earlier plugin success
 *   veto; the first deny, and the first success, each win), `guardDeny(result)`
 *   (monotonic guard denial — must be `isError: true`; reserved for the
 *   non-reorderable permission gate, runs after the waterfall and before
 *   deferred adjudications, and is authoritative over any plugin
 *   short-circuit), `allow()` (records a pass flag; later listeners and
 *   deferred `waitUntil` adjudications still run, so a hook `allow()` cannot
 *   bypass settings `deny`/`ask` rules), `pass(metadata)` (pass with an
 *   `executionMetadata` trace, ends nothing), or `waitUntil(factory)` (defer
 *   an adjudication that needs external input — the fire side invokes the cold
 *   factory only when no deny vetoed and no plugin short-circuited, so an ask
 *   round-trip can never start while another listener would have denied the
 *   call). The waterfall is reorderable; the `guardDeny` segment is monotonic
 *   and non-reorderable — a plugin's synthetic success can never mask a policy
 *   deny. No ids.
 * - `onWillExecuteTool` (waitUntil participation event,
 *   `WillExecuteToolEvent`): listeners attach hot promises via
 *   `waitUntil(promise)`; the executor awaits all of them before dispatching
 *   an allowed call (e.g. MCP initial load).
 * - `hooks.onDidExecuteTool` (ordered hook slot, `ToolDidExecuteContext`):
 *   post-execution result finalization with the resolved execution's canonical
 *   resource accesses and an outcome describing whether the execution callback
 *   actually ran, kept as an `OrderedHookSlot`. Every call reaches it —
 *   including preflight-rejected ones (missing/unavailable tool, guard denial,
 *   invalid args), which arrive without `tool` or `accesses` set.
 *
 * Pure contract (types only); no scoped service.
 */

import type { IWaitUntil } from '#/_base/event';
import type { ToolCall } from '#/kosong/contract/message';
import type { LLMRequestTrace } from '#/kosong/contract/requestTrace';

import type {
  ExecutableTool,
  ExecutableToolResult,
  RunnableToolExecution,
  ToolAccesses,
} from '#/tool/toolContract';

export interface ToolExecutionHookContext {
  readonly turnId: number;
  readonly signal: AbortSignal;
  readonly trace?: LLMRequestTrace;
  readonly toolCall: ToolCall;
  readonly toolCalls: readonly ToolCall[];
  readonly tool?: ExecutableTool | undefined;
  readonly args: unknown;
}

export interface ResolvedToolExecutionHookContext extends ToolExecutionHookContext {
  readonly execution: RunnableToolExecution;
}

export interface BeforeExecuteDecision {
  readonly veto?: ExecutableToolResult;
  readonly executionMetadata?: unknown;
}

export interface BeforeToolExecuteEvent extends ResolvedToolExecutionHookContext {
  veto(result: ExecutableToolResult): void;
  guardDeny(result: ExecutableToolResult): void;
  allow(): void;
  pass(metadata?: unknown): void;
  waitUntil(factory: () => Promise<BeforeExecuteDecision | undefined>): void;
}

export interface WillExecuteToolEvent extends IWaitUntil {
  readonly turnId: number;
  readonly toolCall: ToolCall;
  readonly execution: RunnableToolExecution;
  readonly args: unknown;
}

export type ToolExecutionOutcome =
  | 'executed'
  | 'preflight-rejected'
  | 'resolution-failed'
  | 'vetoed'
  | 'aborted'
  | 'synthetic'
  | 'skipped';

export interface ToolDidExecuteContext extends ToolExecutionHookContext {
  readonly outcome: ToolExecutionOutcome;
  readonly accesses?: ToolAccesses;
  result: ExecutableToolResult;
  stopTurn?: boolean;
}
