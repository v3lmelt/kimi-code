/**
 * `toolExecutor` domain — `IAgentToolExecutorService` implementation.
 *
 * Resolves executable tools through `toolRegistry`, adjudicates tool calls
 * through the `onBeforeExecuteTool` veto event, awaits readiness work
 * through the `onWillExecuteTool` participation event, finalizes results
 * through the ordered `onDidExecuteTool` hook, publishes tool lifecycle
 * events through `event`, records telemetry through `telemetry`, truncates
 * oversized outputs through `toolResultTruncation`, and logs parse
 * diagnostics through `log`. The mutable dup-type tracking state
 * (`toolCallDupTypes`, `dupTypeTurnId`) is registered into `agentState`
 * (`IAgentStateService`) and read/written through it; the emitters, the hook
 * slot, and the describer/guard registration slots stay plain fields. Bound
 * at Agent scope.
 */

import { toDisposable } from '#/_base/di/lifecycle';
import { IInstantiationService } from '#/_base/di/instantiation';
import { LifecycleScope } from '#/app/scopes';
import { ScopeActivation, registerScopedService } from '#/_base/di/scope';
import { AsyncEmitter, type Event } from '#/_base/event';
import { defineState } from '#/_base/state/stateRegistry';
import { IConfigService } from '#/app/config/config';
import type { ContentPart, ToolCall } from '#/kosong/contract/message';
import type { ToolInputDisplay } from '@moonshot-ai/protocol';

import {
  compileToolArgsValidator,
  validateToolArgs,
  type JsonType,
  type ToolArgsValidator,
} from '#/tool/args-validator';
import { parseToolCallArguments } from '#/tool/tool-args-parse';
import { PathSecurityError } from '#/tool/path-access';
import { isAbortError, isUserCancellation } from '#/_base/utils/abort';
import { IEventBus } from '#/app/event/eventBus';
import {
  ToolAccesses,
  type ExecutableTool,
  type ExecutableToolResult,
  type RunnableToolExecution,
  type ToolExecution,
  type ToolResult,
  type ToolUpdate,
} from '#/tool/toolContract';
import type {
  BeforeToolExecuteEvent,
  ResolvedToolExecutionHookContext,
  ToolDidExecuteContext,
  ToolExecutionOutcome,
  WillExecuteToolEvent,
} from '#/agent/toolExecutor/toolHooks';
import { IAgentStateService } from '#/agent/state/agentState';
import { IAgentToolRegistryService } from '#/agent/toolRegistry/toolRegistry';
import { ILogService } from '#/_base/log/log';
import type { ToolCallEvent } from '#/app/telemetry/events';
import { ITelemetryService } from '#/app/telemetry/telemetry';
import { OrderedHookSlot } from '#/hooks';
import { IAgentToolResultTruncationService } from '#/agent/toolResultTruncation/toolResultTruncation';
import { BeforeToolExecuteEmitter } from './beforeToolExecuteEvent';
import {
  IAgentToolExecutorService,
  type MissingToolDescriber,
  type ToolCallGuard,
  type ToolCallDupType,
  type ToolExecutionResult,
  type ToolExecutorExecuteOptions,
  type UnavailableToolDescriber,
} from './toolExecutor';
import { ToolScheduler, isAbortedBeforeDispatchError } from './toolScheduler';
import { TOOL_EXECUTOR_SECTION, type ToolExecutorConfig } from './configSection';
import './toolExecutorEvents';

const ABORT_GRACE_MS = 2_000;
const TOOL_OUTPUT_EMPTY = 'Tool output is empty.';
const TOOL_OUTPUT_NON_TEXT = 'Tool returned non-text content.';
const TOOL_UI_PREVIEW_MAX_CHARS = 2_000;
const BASH_TOOL_NAME = 'Bash';

const validators = new WeakMap<ExecutableTool, ToolArgsValidator>();

export interface ToolExecutionTask {
  readonly accesses: ToolAccesses;
  readonly toolName?: string;
  readonly execute: (signal: AbortSignal) => Promise<ToolExecutionRunResult>;
}

export interface ToolExecutionRunResult {
  readonly result: ToolResult;
  readonly outcome: ToolExecutionOutcome;
}

interface TimedToolResult {
  readonly index: number;
  readonly result: ToolResult;
  readonly outcome: ToolExecutionOutcome;
  readonly durationMs: number;
}

type SettledTimedToolResult =
  | { readonly status: 'fulfilled'; readonly value: TimedToolResult }
  | { readonly status: 'rejected'; readonly index: number; readonly reason: unknown };

type SettledToolExecutionResult =
  | { readonly status: 'fulfilled'; readonly value: ToolExecutionResult }
  | { readonly status: 'rejected'; readonly reason: unknown };

type ToolExecutionResultPromise = Promise<SettledToolExecutionResult>;

type ToolExecutionStreamEvent =
  | { readonly type: 'timed'; readonly result: IteratorResult<TimedToolResult> }
  | { readonly type: 'timedRejected'; readonly reason: unknown }
  | {
      readonly type: 'finalized';
      readonly index: number;
      readonly promise: ToolExecutionResultPromise;
      readonly settled: SettledToolExecutionResult;
    };

export const toolExecutorToolCallDupTypesKey = defineState<Map<string, ToolCallDupType>>(
  'toolExecutor.toolCallDupTypes',
  () => new Map(),
);
export const toolExecutorDupTypeTurnIdKey = defineState<number | undefined>(
  'toolExecutor.dupTypeTurnId',
  () => undefined as number | undefined,
);

export class AgentToolExecutorService implements IAgentToolExecutorService {
  declare readonly _serviceBrand: undefined;

  private readonly beforeExecuteEmitter = new BeforeToolExecuteEmitter();
  readonly onBeforeExecuteTool: Event<BeforeToolExecuteEvent> = this.beforeExecuteEmitter.event;
  private readonly willExecuteEmitter = new AsyncEmitter<WillExecuteToolEvent>();
  readonly onWillExecuteTool: Event<WillExecuteToolEvent> = this.willExecuteEmitter.event;

  readonly hooks = {
    onDidExecuteTool: new OrderedHookSlot<ToolDidExecuteContext>(),
  };

  private missingToolDescriber: MissingToolDescriber | undefined;
  private unavailableToolDescriber: UnavailableToolDescriber | undefined;
  private toolCallGuard: ToolCallGuard | undefined;

  recordDupType(toolCallId: string, dupType: ToolCallDupType): void {
    this.toolCallDupTypes.set(toolCallId, dupType);
  }

  registerToolCallGuard(guard: ToolCallGuard) {
    this.toolCallGuard = guard;
    return toDisposable(() => {
      if (this.toolCallGuard === guard) this.toolCallGuard = undefined;
    });
  }

  registerUnavailableToolDescriber(describer: UnavailableToolDescriber) {
    this.unavailableToolDescriber = describer;
    return toDisposable(() => {
      if (this.unavailableToolDescriber === describer) this.unavailableToolDescriber = undefined;
    });
  }

  registerMissingToolDescriber(describer: MissingToolDescriber) {
    this.missingToolDescriber = describer;
    return toDisposable(() => {
      if (this.missingToolDescriber === describer) this.missingToolDescriber = undefined;
    });
  }

  constructor(
    @IAgentToolRegistryService private readonly toolRegistry: IAgentToolRegistryService,
    @IEventBus private readonly eventBus: IEventBus,
    @ITelemetryService private readonly telemetry: ITelemetryService,
    @IAgentToolResultTruncationService
    private readonly resultTruncation: IAgentToolResultTruncationService,
    @IAgentStateService private readonly states: IAgentStateService,
    @IInstantiationService private readonly instantiation: IInstantiationService,
    @ILogService private readonly log?: ILogService,
  ) {
    this.states.register(toolExecutorToolCallDupTypesKey);
    this.states.register(toolExecutorDupTypeTurnIdKey);
  }

  private get toolCallDupTypes(): Map<string, ToolCallDupType> {
    return this.states.get(toolExecutorToolCallDupTypesKey);
  }

  private get dupTypeTurnId(): number | undefined {
    return this.states.get(toolExecutorDupTypeTurnIdKey);
  }

  private set dupTypeTurnId(value: number | undefined) {
    this.states.set(toolExecutorDupTypeTurnIdKey, value);
  }

  async *execute(
    calls: ToolCall[],
    options: ToolExecutorExecuteOptions,
  ): AsyncIterable<ToolExecutionResult> {
    if (calls.length === 0) return;
    if (options.turnId !== this.dupTypeTurnId) {
      this.dupTypeTurnId = options.turnId;
      this.toolCallDupTypes.clear();
    }

    const preflighted = calls.map((call) =>
      preflightToolCall(
        this.toolRegistry,
        call,
        this.toolCallGuard,
        this.unavailableToolDescriber,
        this.missingToolDescriber,
        this.log,
      ),
    );
    const preparedTasks: Array<{
      task: ToolExecutionTask;
      call: PreflightedToolCall;
      resolvedAccesses?: ToolAccesses;
      stopBatchAfterThis?: boolean;
    }> = [];

    let stopBatch = false;
    for (const call of preflighted) {
      if (stopBatch) {
        const skipped = this.prepareSkippedToolCall(call, options);
        preparedTasks.push({ ...skipped, call });
        continue;
      }

      const prepared = await this.prepareToolCall(call, calls, options);
      preparedTasks.push({
        task: prepared.task,
        call,
        resolvedAccesses: prepared.resolvedAccesses,
        stopBatchAfterThis: prepared.stopBatchAfterThis,
      });
      if (prepared.stopBatchAfterThis === true) {
        stopBatch = true;
      }
    }

    const timedResults = this.executeBatch(
      preparedTasks.map(({ task }) => task),
      options.signal,
    )[Symbol.asyncIterator]();
    let nextTimed: Promise<IteratorResult<TimedToolResult>> | undefined = timedResults.next();
    // Keyed by model call index so results commit in model order: a result is
    // only yielded once every earlier call's result is ready, even though
    // dispatch and finalization overlap in completion order.
    const finalizations = new Map<number, ToolExecutionResultPromise>();
    const committedByIndex = new Map<number, ToolExecutionResult>();
    let nextCommitIndex = 0;

    const flushReady = (): ToolExecutionResult | undefined => {
      const value = committedByIndex.get(nextCommitIndex);
      if (value === undefined) return undefined;
      committedByIndex.delete(nextCommitIndex);
      nextCommitIndex += 1;
      return value;
    };

    try {
      for (;;) {
        let ready = flushReady();
        while (ready !== undefined) {
          yield ready;
          ready = flushReady();
        }
        if (nextTimed === undefined && finalizations.size === 0) break;

        const candidates: Array<Promise<ToolExecutionStreamEvent>> = [];
        if (nextTimed !== undefined) {
          candidates.push(
            nextTimed.then(
              (result): ToolExecutionStreamEvent => ({ type: 'timed', result }),
              (reason): ToolExecutionStreamEvent => ({ type: 'timedRejected', reason }),
            ),
          );
        }
        for (const [index, promise] of finalizations) {
          candidates.push(
            promise.then((settled): ToolExecutionStreamEvent => ({
              type: 'finalized',
              index,
              promise,
              settled,
            })),
          );
        }

        const event = await Promise.race(candidates);
        if (event.type === 'timedRejected') {
          throw event.reason;
        }
        if (event.type === 'timed') {
          if (event.result.done === true) {
            nextTimed = undefined;
            continue;
          }

          const index = event.result.value.index;
          const finalization = this.finalizeTimedResult(
            preparedTasks[index]!,
            event.result.value,
            options,
          ).then(
            (value): SettledToolExecutionResult => ({ status: 'fulfilled', value }),
            (reason): SettledToolExecutionResult => ({ status: 'rejected', reason }),
          );
          finalizations.set(index, finalization);
          nextTimed = timedResults.next();
          continue;
        }

        finalizations.delete(event.index);
        if (event.settled.status === 'rejected') throw event.settled.reason;
        committedByIndex.set(event.index, event.settled.value);
      }
    } finally {
      await timedResults.return?.();
      await Promise.allSettled(finalizations);
    }
  }

  private async finalizeTimedResult(
    prepared: {
      readonly call: PreflightedToolCall;
      readonly resolvedAccesses?: ToolAccesses;
    },
    timedResult: TimedToolResult,
    options: ToolExecutorExecuteOptions,
  ): Promise<ToolExecutionResult> {
    const { call } = prepared;
    const rawResult = timedResult.result;
    const finalized = await this.finalizeToolResult(
      call,
      rawResult,
      options,
      timedResult.outcome,
      prepared.resolvedAccesses,
    );

    this.dispatchToolResult(call, finalized, options);
    this.trackToolCall(call, finalized, timedResult.durationMs, options);

    return {
      toolCallId: call.toolCall.id,
      toolName: call.toolName,
      result: finalized,
    };
  }

  private trackToolCall(
    call: PreflightedToolCall,
    result: ToolResult,
    durationMs: number,
    options: ToolExecutorExecuteOptions,
  ): void {
    const outcome = toolTelemetryOutcome(result);
    const toolCallId = call.toolCall.id;
    const dupType = this.toolCallDupTypes.get(toolCallId) ?? 'normal';
    this.toolCallDupTypes.delete(toolCallId);
    const properties: ToolCallEvent = {
      turn_id: options.turnId,
      tool_call_id: toolCallId,
      tool_name: call.toolName,
      outcome,
      duration_ms: durationMs,
      dup_type: dupType,
      trace_id: options.trace?.traceId,
    };
    if (result.isError === true) properties['error_type'] = toolTelemetryErrorType(outcome);
    this.telemetry.track2('tool_call', properties);
  }

  /** Resolves the bounded dispatch-pool bound from the `[tool_executor]`
   *  config section. `IConfigService` may be absent in minimal scopes (e.g.
   *  unit-test containers), in which case dispatch stays unbounded. */
  private resolveMaxParallelToolCalls(): number | undefined {
    try {
      return this.instantiation.invokeFunction((accessor) =>
        (accessor.get(IConfigService) as IConfigService | undefined)
          ?.get<ToolExecutorConfig>(TOOL_EXECUTOR_SECTION)
          ?.maxParallelToolCalls,
      );
    } catch {
      return undefined;
    }
  }

  private async prepareToolCall(
    call: PreflightedToolCall,
    allCalls: readonly ToolCall[],
    options: ToolExecutorExecuteOptions,
  ): Promise<{
    task: ToolExecutionTask;
    resolvedAccesses?: ToolAccesses;
    stopBatchAfterThis?: boolean;
  }> {
    const settleError = (
      args: unknown,
      output: string,
      outcome: Exclude<ToolExecutionOutcome, 'executed'>,
      displayFields?: ToolCallDisplayFields,
    ): { task: ToolExecutionTask } => {
      this.dispatchToolCall(call, args, options, displayFields);
      return {
        task: makeResolvedTask(makeErrorToolResult(call, args, output), outcome),
      };
    };

    const settleSynthetic = (
      args: unknown,
      result: ExecutableToolResult,
      outcome: Exclude<ToolExecutionOutcome, 'executed'>,
      displayFields?: ToolCallDisplayFields,
    ): {
      task: ToolExecutionTask;
      stopBatchAfterThis?: boolean;
    } => {
      const toolResult = this.normalizeAndMergeResult(result, call.toolName, undefined);
      this.dispatchToolCall(call, args, options, displayFields);
      return {
        task: makeResolvedTask(
          {
            toolCall: call.toolCall,
            toolName: call.toolName,
            args,
            result: toolResult,
            stopTurn: toolResult.stopTurn === true,
          },
          outcome,
        ),
        stopBatchAfterThis: toolResult.stopBatchAfterThis ?? toolResult.stopTurn,
      };
    };

    if (call.kind === 'rejected') {
      return settleError(call.args, call.output, 'preflight-rejected');
    }

    let execution: ToolExecution;
    try {
      execution = await call.tool.resolveExecution(call.args);
    } catch (error) {
      const output =
        error instanceof PathSecurityError
          ? error.message
          : `Tool "${call.toolName}" failed to resolve execution: ${errorMessage(error)}`;
      return settleError(call.args, output, 'resolution-failed');
    }

    const displayFields = toolCallDisplayFieldsFromExecution(execution);

    if (options.signal.aborted) {
      return settleError(
        call.args,
        abortedToolOutput(call.toolName, options.signal),
        'aborted',
        displayFields,
      );
    }

    if (execution.isError === true) {
      return settleSynthetic(call.args, execution, 'synthetic', displayFields);
    }

    const beforeContext = buildBeforeExecuteContext(call, execution, allCalls, options);
    const decision = await this.beforeExecuteEmitter.fireBeforeExecute(beforeContext);

    if (decision?.veto !== undefined) {
      return settleSynthetic(call.args, decision.veto, 'vetoed', displayFields);
    }

    const executionMetadata = decision?.executionMetadata;

    await this.willExecuteEmitter.fireAsync(
      {
        turnId: options.turnId,
        toolCall: call.toolCall,
        execution,
        args: call.args,
      },
      options.signal,
    );

    this.dispatchToolCall(call, call.args, options, displayFields);

    return {
      task: {
        accesses: execution.accesses ?? ToolAccesses.all(),
        toolName: call.toolName,
        execute: async (taskSignal) =>
          this.runSingleExecution(call, execution, executionMetadata, options, taskSignal),
      },
      resolvedAccesses: execution.accesses,
      stopBatchAfterThis: execution.stopBatchAfterThis,
    };
  }

  private prepareSkippedToolCall(
    call: PreflightedToolCall,
    options: ToolExecutorExecuteOptions,
  ): { task: ToolExecutionTask } {
    const output = 'Tool skipped because a previous tool call stopped the turn.';
    this.dispatchToolCall(call, call.args, options);
    return {
      task: makeResolvedTask(makeErrorToolResult(call, call.args, output), 'skipped'),
    };
  }

  private async *executeBatch(
    tasks: ToolExecutionTask[],
    signal: AbortSignal,
  ): AsyncIterable<TimedToolResult> {
    const scheduler = new ToolScheduler<TimedToolResult>({
      maxParallel: this.resolveMaxParallelToolCalls(),
    });
    const allResults: Array<Promise<TimedToolResult>> = [];
    const pendingResults = new Map<number, Promise<SettledTimedToolResult>>();
    const siblingAbortController = new AbortController();

    for (let index = 0; index < tasks.length; index += 1) {
      const task = tasks[index]!;
      const pendingResult = scheduler.add({
        accesses: task.accesses,
        start: async () => {
          const startedAt = Date.now();
          const taskSignal = AbortSignal.any([signal, siblingAbortController.signal]);
          return {
            result: task.execute(taskSignal).then(({ result, outcome }) => ({
              index,
              result,
              outcome,
              durationMs: Math.max(0, Date.now() - startedAt),
            })),
          };
        },
      });
      allResults.push(pendingResult);
      pendingResults.set(
        index,
        pendingResult.then(
          (value): SettledTimedToolResult => ({ status: 'fulfilled', value }),
          (reason): SettledTimedToolResult => ({ status: 'rejected', index, reason }),
        ),
      );
    }

    // Settle never-dispatched (still queued) tasks so the batch never waits on
    // them: a batch abort or a sibling-abort classifies them as aborted-before-
    // dispatch instead of starting them against an already-aborted signal.
    if (signal.aborted) {
      scheduler.abort(signal);
    } else {
      signal.addEventListener('abort', () => scheduler.abort(signal), { once: true });
    }
    siblingAbortController.signal.addEventListener(
      'abort',
      () => scheduler.abort(siblingAbortController.signal),
      { once: true },
    );

    try {
      while (pendingResults.size > 0) {
        const settled = await Promise.race(pendingResults.values());
        const index = settled.status === 'fulfilled' ? settled.value.index : settled.index;
        pendingResults.delete(index);
        if (settled.status === 'rejected') {
          if (isAbortedBeforeDispatchError(settled.reason)) {
            yield {
              index,
              result: {
                output: abortedToolOutput(tasks[index]?.toolName ?? 'Tool', signal),
                isError: true,
              },
              outcome: 'aborted',
              durationMs: 0,
            };
            continue;
          }
          throw settled.reason;
        }
        if (
          tasks[index]?.toolName === BASH_TOOL_NAME &&
          settled.value.outcome === 'executed' &&
          settled.value.result.isError === true
        ) {
          siblingAbortController.abort();
        }
        yield settled.value;
      }
    } finally {
      await Promise.allSettled(allResults);
    }
  }

  private async runSingleExecution(
    call: RunnableToolCall,
    execution: RunnableToolExecution,
    metadata: unknown,
    options: ToolExecutorExecuteOptions,
    signal: AbortSignal,
  ): Promise<ToolExecutionRunResult> {
    if (signal.aborted) {
      return {
        result: makeErrorToolResult(
          call,
          call.args,
          abortedToolOutput(call.toolName, signal),
        ).result,
        outcome: 'aborted',
      };
    }

    let rawResult: ExecutableToolResult;
    try {
      const executePromise = execution.execute({
        turnId: options.turnId,
        toolCallId: call.toolCall.id,
        trace: options.trace,
        metadata,
        signal,
        onUpdate: (update) => {
          if (signal.aborted) return;
          this.dispatchToolProgress(call, update, options);
        },
      });
      rawResult = await raceWithAbortGrace(executePromise, signal, call.toolName);
    } catch (error) {
      const aborted = isAbortError(error) || signal.aborted;
      const output = aborted
        ? abortedToolOutput(call.toolName, signal)
        : `Tool "${call.toolName}" failed: ${errorMessage(error)}`;
      return {
        result: makeErrorToolResult(call, call.args, output).result,
        outcome: 'executed',
      };
    }

    return {
      result: this.normalizeAndMergeResult(rawResult, call.toolName, execution),
      outcome: 'executed',
    };
  }

  private normalizeAndMergeResult(
    rawResult: unknown,
    toolName: string,
    execution: RunnableToolExecution | undefined,
  ): ToolResult {
    const coerced = coerceToolResult(rawResult, toolName);
    const normalized = normalizeToolResult(coerced);
    return {
      ...normalized,
      description: execution?.description ?? normalized.description,
      display: execution?.display ?? normalized.display,
      approvalRule: execution?.approvalRule,
      stopBatchAfterThis: normalized.stopBatchAfterThis ?? execution?.stopBatchAfterThis,
      delivery: coerced.delivery,
    };
  }

  private dispatchToolCall(
    call: PreflightedToolCall,
    args: unknown,
    options: ToolExecutorExecuteOptions,
    displayFields?: ToolCallDisplayFields,
  ): void {
    this.eventBus.publish({
      type: 'tool.call.started',
      turnId: options.turnId,
      toolCallId: call.toolCall.id,
      name: call.toolName,
      args,
      description: displayFields?.description,
      display: displayFields?.display,
    });
    options.onToolCall?.({
      toolCallId: call.toolCall.id,
      name: call.toolName,
      args,
    });
  }

  private dispatchToolResult(
    call: PreflightedToolCall,
    result: ToolResult,
    options: ToolExecutorExecuteOptions,
  ): void {
    const { uiPreview, truncated } = buildUiPreview(result.output);
    this.eventBus.publish({
      type: 'tool.result',
      turnId: options.turnId,
      toolCallId: call.toolCall.id,
      uiPreview,
      truncated,
      output: uiPreview,
      isError: result.isError,
    });
  }

  private dispatchToolProgress(
    call: RunnableToolCall,
    update: ToolUpdate,
    options: ToolExecutorExecuteOptions,
  ): void {
    this.eventBus.publish({
      type: 'tool.progress',
      turnId: options.turnId,
      toolCallId: call.toolCall.id,
      update,
    });
  }

  private async finalizeToolResult(
    call: PreflightedToolCall,
    result: ToolResult,
    options: ToolExecutorExecuteOptions,
    outcome: ToolExecutionOutcome,
    resolvedAccesses?: ToolAccesses,
  ): Promise<ToolResult> {
    const didCtx: ToolDidExecuteContext = {
      turnId: options.turnId,
      signal: options.signal,
      trace: options.trace,
      toolCall: call.toolCall,
      toolCalls: [call.toolCall],
      tool: call.kind === 'runnable' ? call.tool : undefined,
      args: call.args,
      outcome,
      accesses: resolvedAccesses,
      result: result as ExecutableToolResult,
    };

    try {
      await this.hooks.onDidExecuteTool.run(didCtx);
    } catch (error) {
      const aborted = isAbortError(error) || options.signal.aborted;
      const output = aborted
        ? `Tool "${call.toolName}" aborted during onDidExecuteTool hook.`
        : `onDidExecuteTool hook failed for "${call.toolName}": ${errorMessage(error)}`;
      return {
        output,
        isError: true,
        description: result.description,
        display: result.display,
        approvalRule: result.approvalRule,
      };
    }

    const coercedResult = coerceToolResult(didCtx.result, call.toolName);
    const effectiveResult = normalizeToolResult(coercedResult);
    const finalResult: ToolResult = {
      ...effectiveResult,
      description: result.description,
      display: result.display,
      approvalRule: result.approvalRule,
      stopTurn:
        result.stopTurn === true ||
        didCtx.stopTurn === true ||
        effectiveResult.stopTurn === true,
      stopBatchAfterThis: result.stopBatchAfterThis,
      delivery: coercedResult.delivery,
    };
    return this.resultTruncation.truncateForModel({
      toolName: call.toolName,
      toolCallId: call.toolCall.id,
      result: finalResult,
    });
  }
}

interface RunnableToolCall {
  readonly kind: 'runnable';
  readonly toolCall: ToolCall;
  readonly toolName: string;
  readonly tool: ExecutableTool;
  readonly args: unknown;
}

interface RejectedToolCall {
  readonly kind: 'rejected';
  readonly toolCall: ToolCall;
  readonly toolName: string;
  readonly args: unknown;
  readonly output: string;
}

type PreflightedToolCall = RunnableToolCall | RejectedToolCall;

interface PreparedToolResult {
  readonly toolCall: ToolCall;
  readonly toolName: string;
  readonly args: unknown;
  readonly result: ToolResult;
  readonly stopTurn?: boolean;
}

type ToolCallDisplayFields = { description?: string | undefined; display?: ToolInputDisplay | undefined };

function buildBeforeExecuteContext(
  call: RunnableToolCall,
  execution: RunnableToolExecution,
  allCalls: readonly ToolCall[],
  options: ToolExecutorExecuteOptions,
): ResolvedToolExecutionHookContext {
  return {
    turnId: options.turnId,
    signal: options.signal,
    trace: options.trace,
    toolCall: call.toolCall,
    toolCalls: allCalls,
    tool: call.tool,
    args: call.args,
    execution,
  };
}

function preflightToolCall(
  toolRegistry: IAgentToolRegistryService,
  toolCall: ToolCall,
  guard: ToolCallGuard | undefined,
  describeUnavailableTool: UnavailableToolDescriber | undefined,
  describeMissingTool: MissingToolDescriber | undefined,
  log?: ILogService,
): PreflightedToolCall {
  const toolName = toolCall.name;
  const parsedArgs = parseToolCallArguments(toolCall.arguments);
  if (parsedArgs.parseFailed) {
    log?.debug('tool args JSON parse failed', {
      toolName,
      toolCallId: toolCall.id,
      rawLength: typeof toolCall.arguments === 'string' ? toolCall.arguments.length : 0,
      error: parsedArgs.error,
    });
  }
  const tool = toolRegistry.resolve(toolName);
  if (tool === undefined) {
    return {
      kind: 'rejected',
      toolCall,
      toolName,
      args: parsedArgs.data,
      output: describeMissingTool?.(toolName) ?? `Tool "${toolName}" not found`,
    };
  }
  const source = toolRegistry.list().find((entry) => entry.name === toolName)?.source ?? 'builtin';
  const denied = guard?.({ name: toolName, source });
  if (denied !== undefined) {
    return {
      kind: 'rejected',
      toolCall,
      toolName,
      args: parsedArgs.data,
      output: denied,
    };
  }
  const unavailable = describeUnavailableTool?.(toolName);
  if (unavailable !== undefined) {
    return {
      kind: 'rejected',
      toolCall,
      toolName,
      args: parsedArgs.data,
      output: unavailable,
    };
  }
  const validationError = validateExecutableToolArgs(tool, parsedArgs.data);
  if (validationError !== null) {
    return {
      kind: 'rejected',
      toolCall,
      toolName,
      args: parsedArgs.data,
      output: `Invalid args for tool "${toolName}": ${validationError}`,
    };
  }
  return { kind: 'runnable', toolCall, toolName, tool, args: parsedArgs.data };
}

function validateExecutableToolArgs(tool: ExecutableTool, args: unknown): string | null {
  let validator = validators.get(tool);
  if (validator === undefined) {
    try {
      validator = compileToolArgsValidator(tool.parameters);
      validators.set(tool, validator);
    } catch (error) {
      return error instanceof Error ? error.message : String(error);
    }
  }
  return validateToolArgs(validator, args as JsonType);
}

function toolCallDisplayFieldsFromExecution(
  execution: ToolExecution,
): ToolCallDisplayFields | undefined {
  if (execution.isError === true) return undefined;
  const description = execution.description;
  const display = execution.display;
  return {
    description: description !== undefined && description.length > 0 ? description : undefined,
    display,
  };
}

function makeResolvedTask(
  result: PreparedToolResult,
  outcome: ToolExecutionOutcome,
): ToolExecutionTask {
  return {
    accesses: ToolAccesses.none(),
    toolName: result.toolName,
    execute: async () => ({ result: result.result, outcome }),
  };
}

function makeErrorToolResult(
  call: PreflightedToolCall,
  args: unknown,
  output: string,
): PreparedToolResult {
  return {
    toolCall: call.toolCall,
    toolName: call.toolName,
    args,
    result: { output, isError: true },
  };
}

function coerceToolResult(value: unknown, toolName: string): ExecutableToolResult {
  if (value === null || value === undefined) {
    return { output: `Tool "${toolName}" returned no result.`, isError: true };
  }
  if (typeof value !== 'object') {
    return {
      output: `Tool "${toolName}" returned a ${typeof value} instead of a tool result.`,
      isError: true,
    };
  }
  const candidate = value as { output?: unknown };
  if (typeof candidate.output !== 'string' && !Array.isArray(candidate.output)) {
    return {
      output: `Tool "${toolName}" returned a result with a missing or malformed "output" field.`,
      isError: true,
    };
  }
  return value as ExecutableToolResult;
}

function normalizeToolResult(result: ExecutableToolResult): ToolResult {
  let output: ToolResult['output'];
  if (typeof result.output === 'string') {
    output = result.output.length > 0 ? result.output : TOOL_OUTPUT_EMPTY;
  } else if (result.output.length === 0) {
    output = TOOL_OUTPUT_EMPTY;
  } else {
    const hasMediaBlock = result.output.some(isMediaContentPart);
    if (hasMediaBlock) {
      const hasNonEmptyText = result.output.some(
        (part) => part.type === 'text' && part.text.length > 0,
      );
      output = hasNonEmptyText
        ? result.output
        : [{ type: 'text', text: TOOL_OUTPUT_NON_TEXT }, ...result.output];
    } else {
      const textJoined = result.output
        .filter((part): part is Extract<ContentPart, { type: 'text' }> => part.type === 'text')
        .map((part) => part.text)
        .join('');
      output = textJoined.length > 0 ? textJoined : TOOL_OUTPUT_EMPTY;
    }
  }
  const base: {
    output: ToolResult['output'];
    stopTurn?: boolean;
    truncated?: true;
    note?: string;
  } = { output, stopTurn: result.stopTurn };
  if (result.truncated === true) base.truncated = true;
  if (typeof result.note === 'string' && result.note.length > 0) base.note = result.note;
  if (result.isError === true) {
    return {
      ...base,
      isError: true,
    };
  }
  return base;
}

function toolTelemetryOutcome(result: ToolResult): 'success' | 'error' | 'cancelled' {
  if (result.isError !== true) return 'success';
  const text = toolOutputText(result.output).toLowerCase();
  return text.includes('aborted') ||
    text.includes('cancelled') ||
    text.includes('manually interrupted')
    ? 'cancelled'
    : 'error';
}

function toolTelemetryErrorType(outcome: 'success' | 'error' | 'cancelled'): 'cancelled' | 'error' {
  if (outcome === 'cancelled') return 'cancelled';
  return 'error';
}

function toolOutputText(output: ToolResult['output']): string {
  if (typeof output === 'string') return output;
  return output
    .filter((part): part is Extract<ContentPart, { type: 'text' }> => part.type === 'text')
    .map((part) => part.text)
    .join('');
}

function buildUiPreview(
  output: ToolResult['output'],
): { uiPreview: string; truncated: boolean } {
  const text = toolOutputText(output) || TOOL_OUTPUT_NON_TEXT;
  if (text.length <= TOOL_UI_PREVIEW_MAX_CHARS) {
    return { uiPreview: text, truncated: false };
  }
  return { uiPreview: text.slice(0, TOOL_UI_PREVIEW_MAX_CHARS), truncated: true };
}

function isMediaContentPart(part: ContentPart): boolean {
  return part.type === 'image_url' || part.type === 'audio_url' || part.type === 'video_url';
}

function abortedToolOutput(toolName: string, signal: AbortSignal): string {
  if (isUserCancellation(signal.reason)) {
    return `The user manually interrupted "${toolName}" (and anything else running at the same time). This was a deliberate user action, not a system error, timeout, or capacity limit. Do not retry automatically or guess at the cause — wait for the user's next instruction.`;
  }
  return `Tool "${toolName}" was aborted`;
}

async function raceWithAbortGrace<Result>(
  executePromise: Promise<Result>,
  signal: AbortSignal,
  toolName: string,
): Promise<Result> {
  let graceTimer: ReturnType<typeof setTimeout> | undefined;
  let onAbort: (() => void) | undefined;

  const graceSentinel: Promise<Result> = new Promise((resolve) => {
    const armTimer = (): void => {
      graceTimer = setTimeout(() => {
        resolve({
          output: abortedToolOutput(toolName, signal),
          isError: true,
        } as unknown as Result);
      }, ABORT_GRACE_MS);
    };
    if (signal.aborted) {
      armTimer();
    } else {
      onAbort = armTimer;
      signal.addEventListener('abort', onAbort, { once: true });
    }
  });

  try {
    return await Promise.race([executePromise, graceSentinel]);
  } finally {
    if (graceTimer !== undefined) clearTimeout(graceTimer);
    if (onAbort !== undefined) {
      try {
        signal.removeEventListener('abort', onAbort);
      } catch {
      }
    }
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

registerScopedService(
  LifecycleScope.Agent,
  IAgentToolExecutorService,
  AgentToolExecutorService,
  ScopeActivation.OnScopeCreated,
  'toolExecutor',
);
