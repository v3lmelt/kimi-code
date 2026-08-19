/**
 * `toolExecutor` domain — `onBeforeExecuteTool` veto-event machinery.
 *
 * `BeforeToolExecuteEventImpl` is the per-fire event object listeners
 * adjudicate through; `BeforeToolExecuteEmitter` owns the listener registry,
 * the monotonic guard registry, and the multi-pass fire:
 *
 * 1. reorderable waterfall — each listener is awaited in registration order.
 *    A `veto(result)` with `isError: true` (a policy deny) wins on the spot
 *    and ends adjudication, while a `veto(result)` without `isError` is a
 *    reorderable short-circuit: it is captured (first one wins) but the loop
 *    keeps running, so the monotonic permission chain — a listener registered
 *    anywhere, e.g. the permission gate — always adjudicates and its deny can
 *    never be skipped by an earlier plugin success veto. `allow()` only
 *    records a pass flag and lets later listeners keep adjudicating.
 * 2. monotonic guard segment — guard listeners (a separate `onGuard`
 *    registry, not reorderable with the waterfall) run after the waterfall
 *    and before deferred adjudications. They answer with `guardDeny(result)`,
 *    which accepts only `isError: true` denials and is authoritative: a guard
 *    deny outranks any plugin short-circuit, so the permission chain always
 *    precedes a plugin's synthetic success.
 * 3. deferred adjudications — the captured plugin short-circuit is honored
 *    before the cold `waitUntil(factory)` factories (so a plugin short-circuit
 *    never triggers an approval round-trip), and the factories are then
 *    invoked one at a time; the first returned `veto` decides the call, while
 *    a returned `executionMetadata` joins the pass trace.
 *
 * Because the factories stay cold through the waterfall and guard passes, an
 * approval round-trip (the only side-effecting adjudication) can never start
 * while another listener would have denied the call. All statements throw once
 * the statement window closes (mirroring `AsyncEmitter`'s "waitUntil can NOT
 * be called asynchronously" rule): a late veto would otherwise be silently
 * ignored.
 */

import { Emitter } from '#/_base/event';
import { toDisposable, type IDisposable } from '#/_base/di/lifecycle';
import { BugIndicatingError } from '#/errors';
import type { ToolCall } from '#/kosong/contract/message';
import type { LLMRequestTrace } from '#/kosong/contract/requestTrace';
import type {
  ExecutableTool,
  ExecutableToolResult,
  RunnableToolExecution,
} from '#/tool/toolContract';

import type {
  BeforeExecuteDecision,
  BeforeToolExecuteEvent,
  ResolvedToolExecutionHookContext,
} from './toolHooks';

type PendingVetoFactory = () => Promise<BeforeExecuteDecision | undefined>;

interface GuardListenerEntry {
  readonly listener: (event: BeforeToolExecuteEvent) => unknown;
  readonly thisArg: unknown;
}

export function denyToolExecution(reason: string): ExecutableToolResult {
  return { output: reason, isError: true };
}

export class BeforeToolExecuteEventImpl implements BeforeToolExecuteEvent {
  readonly turnId: number;
  readonly signal: AbortSignal;
  readonly trace?: LLMRequestTrace;
  readonly toolCall: ToolCall;
  readonly toolCalls: readonly ToolCall[];
  readonly tool?: ExecutableTool | undefined;
  readonly args: unknown;
  readonly execution: RunnableToolExecution;

  private _vetoResult: ExecutableToolResult | undefined;
  private _guardDenyResult: ExecutableToolResult | undefined;
  private _finalAllowed = false;
  private _passMetadata: unknown;
  private readonly _pendingVetos: PendingVetoFactory[] = [];
  private _open = true;

  constructor(context: ResolvedToolExecutionHookContext) {
    this.turnId = context.turnId;
    this.signal = context.signal;
    this.trace = context.trace;
    this.toolCall = context.toolCall;
    this.toolCalls = context.toolCalls;
    this.tool = context.tool;
    this.args = context.args;
    this.execution = context.execution;
  }

  veto(result: ExecutableToolResult): void {
    this.assertOpen('veto');
    this._vetoResult ??= result;
  }

  guardDeny(result: ExecutableToolResult): void {
    this.assertOpen('guardDeny');
    if (result.isError !== true) {
      throw new BugIndicatingError('guardDeny requires an isError:true denial result');
    }
    this._guardDenyResult ??= result;
  }

  allow(): void {
    this.assertOpen('allow');
    this._finalAllowed = true;
  }

  pass(metadata?: unknown): void {
    this.assertOpen('pass');
    this._passMetadata ??= metadata;
  }

  waitUntil(factory: PendingVetoFactory): void {
    this.assertOpen('waitUntil');
    this._pendingVetos.push(factory);
  }

  /** Internal: clears the plugin veto so the waterfall can continue past a
   * short-circuit and let the monotonic permission chain still adjudicate. */
  resetVeto(): void {
    this._vetoResult = undefined;
  }

  get vetoResult(): ExecutableToolResult | undefined {
    return this._vetoResult;
  }

  get guardDenyResult(): ExecutableToolResult | undefined {
    return this._guardDenyResult;
  }

  get finalAllowed(): boolean {
    return this._finalAllowed;
  }

  get passMetadata(): unknown {
    return this._passMetadata;
  }

  get pendingVetos(): readonly PendingVetoFactory[] {
    return this._pendingVetos;
  }

  closeRegistration(): void {
    this._open = false;
  }

  private assertOpen(statement: string): void {
    if (!this._open) {
      throw new BugIndicatingError(`${statement} can NOT be called asynchronously`);
    }
  }
}

export class BeforeToolExecuteEmitter extends Emitter<BeforeToolExecuteEvent> {
  private _guardListeners: Set<GuardListenerEntry> | undefined;

  /**
   * Registers a monotonic guard listener. Guard listeners run after the
   * waterfall and before deferred adjudications, and answer with
   * `event.guardDeny(result)` — an `isError: true` denial that is
   * authoritative and cannot be overridden by a plugin short-circuit.
   */
  onGuard(listener: (event: BeforeToolExecuteEvent) => unknown, thisArg?: unknown): IDisposable {
    this._guardListeners ??= new Set();
    const entry: GuardListenerEntry = { listener, thisArg };
    this._guardListeners.add(entry);
    return toDisposable(() => {
      this._guardListeners?.delete(entry);
    });
  }

  override dispose(): void {
    super.dispose();
    this._guardListeners?.clear();
    this._guardListeners = undefined;
  }

  async fireBeforeExecute(
    context: ResolvedToolExecutionHookContext,
  ): Promise<BeforeExecuteDecision | undefined> {
    const hasListeners = this._listeners !== undefined && this._listeners.size > 0;
    const hasGuards = this._guardListeners !== undefined && this._guardListeners.size > 0;
    if (this.isDisposed || (!hasListeners && !hasGuards)) {
      return undefined;
    }

    const event = new BeforeToolExecuteEventImpl(context);

    // Phase 1 — reorderable waterfall. A deny (`isError`) veto is final; a
    // success veto is captured as a reorderable short-circuit while the loop
    // keeps running, so the monotonic permission chain (a listener registered
    // anywhere) always adjudicates and its deny can never be skipped by an
    // earlier plugin success veto.
    let shortCircuit: ExecutableToolResult | undefined;
    if (hasListeners) {
      for (const entry of Array.from(this._listeners!)) {
        await entry.listener.call(entry.thisArg, event);
        const veto = event.vetoResult;
        if (veto === undefined) continue;
        if (veto.isError === true) return { veto };
        shortCircuit ??= veto;
        event.resetVeto();
      }
    }

    // Phase 2 — monotonic guard segment (non-reorderable). Runs after the
    // waterfall and before deferred adjudications; a guard deny is
    // authoritative over any plugin short-circuit.
    if (hasGuards) {
      for (const entry of Array.from(this._guardListeners!)) {
        await entry.listener.call(entry.thisArg, event);
        if (event.guardDenyResult !== undefined) return { veto: event.guardDenyResult };
      }
    }
    event.closeRegistration();

    // Phase 3 — the plugin short-circuit is honored before deferred
    // adjudications, so a plugin success short-circuit never triggers an
    // approval round-trip.
    if (shortCircuit !== undefined) return { veto: shortCircuit };

    // Phase 4 — deferred adjudications (approval round-trips).
    let passMetadata = event.passMetadata;
    for (const factory of event.pendingVetos) {
      const decision = await factory();
      if (decision?.veto !== undefined) return { veto: decision.veto };
      passMetadata ??= decision?.executionMetadata;
    }
    return passMetadata === undefined ? undefined : { executionMetadata: passMetadata };
  }
}
