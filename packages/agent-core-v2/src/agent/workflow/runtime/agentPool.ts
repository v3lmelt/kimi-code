/**
 * `workflow.runtime` — AgentRunPool: the fan-out scheduler behind the
 * Workflow DSL's `parallel()` and `pipeline()` globals.
 *
 * The pool is an adapter over the existing session-swarm scheduler
 * (`AgentRunBatch` in `session/swarm/agentRunBatch.ts`), which already owns
 * burst launch, provider-rate-limit requeue/backoff, abort propagation and
 * user-cancellation settlement. The pool maps the Workflow DSL semantics onto
 * that machinery:
 *
 * - `parallel()` — one flat barrier batch. Every item's thunk is submitted as
 *   an independent spawn task; the batch resolves when all settle, preserving
 *   input order. A thunk that throws yields `null` for that slot; the call
 *   itself never rejects for item errors.
 * - `pipeline()` — NO barrier. Each item's stage chain is submitted as an
 *   independent spawn task; stages within a chain run strictly sequentially
 *   (`prevResult → next stage`). A throwing stage drops that item to `null`
 *   and skips its remaining stages.
 *
 * The "tasks" the pool schedules are plain closures (typically sandbox
 * functions authored by a workflow script that call `agent()` to spawn real
 * subagents), not subagent spawns themselves. Concurrency is clamped to
 * `min(16, max(2, cores - 2))` and the run's `AbortSignal` threads through
 * every batch. The pool exposes cloneable scheduler limits for the isolated
 * Worker and can abort all batches owned by a run.
 */

import os from 'node:os';

import {
  AgentRunBatch,
  type AgentRunAttemptHandle,
  type AgentRunAttemptOptions,
  type AgentRunBatchLauncher,
} from '#/session/swarm/agentRunBatch';
import type { SessionSwarmTask } from '#/session/swarm/sessionSwarm';

import type {
  WorkflowFanOutOpts,
  WorkflowPipelineOpts,
  WorkflowStageFn,
} from '../types';

/** Hard ceiling on how many items one `parallel()` / `pipeline()` call fans out. */
export const WORKFLOW_MAX_ITEMS_PER_FAN_OUT = 4096;

/** Default concurrency ramp for the fan-out scheduler. */
export const WORKFLOW_DEFAULT_MAX_CONCURRENCY = resolveMaxConcurrency();

/**
 * A single settled unit of work in a fan-out. `completed` items carry their
 * value; `failed` / `aborted` items carry no value (the DSL surfaces those as
 * `null`).
 */
export interface WorkflowPoolOutcome {
  readonly status: 'completed' | 'failed' | 'aborted';
  readonly value: unknown;
}

/** Options for constructing an `AgentRunPool`. */
export interface AgentRunPoolOptions {
  /** Run-level abort signal threaded through every batch the pool starts. */
  readonly signal?: AbortSignal;
  /** Default max concurrency for batches started without a per-call override. */
  readonly maxConcurrency?: number;
  /** Item cap for `parallel()` / `pipeline()`; defaults to 4096. */
  readonly maxItemsPerFanOut?: number;
}

export interface AgentRunPoolRuntimeConfig {
  readonly maxConcurrency: number;
  readonly maxItemsPerFanOut: number;
}

/** Thrown when a `parallel()` / `pipeline()` call exceeds the item cap. */
export class WorkflowItemCapExceededError extends Error {
  constructor(readonly cap: number) {
    super(
      `Workflow fan-out item budget exceeded: no more than ${String(cap)} items per parallel()/pipeline() call.`,
    );
    this.name = 'WorkflowItemCapExceededError';
  }
}

/** Internal per-task payload carried through the scheduler. */
export interface WorkflowPoolTaskData {
  readonly index: number;
  readonly run: (signal: AbortSignal) => Promise<unknown>;
}

/**
 * Fan-out scheduler for the Workflow DSL. Owns no subagent machinery itself —
 * the closures it schedules call `agent()` (the sandbox global) to spawn real
 * subagents, and the pool only decides *when* each closure runs.
 */
export class AgentRunPool {
  private readonly controller = new AbortController();
  private readonly signal: AbortSignal;
  private readonly defaultConcurrency: number;
  private readonly maxItems: number;
  private batchSequence = 0;
  private readonly activeBatches = new Set<Promise<unknown>>();
  private readonly activeAttempts = new Set<Promise<unknown>>();
  private unlinkExternalAbort: (() => void) | undefined;

  constructor(options: AgentRunPoolOptions = {}) {
    this.signal = this.controller.signal;
    if (options.signal !== undefined) {
      const onAbort = (): void => this.abort(options.signal?.reason);
      options.signal.addEventListener('abort', onAbort, { once: true });
      this.unlinkExternalAbort = () => options.signal?.removeEventListener('abort', onAbort);
      if (options.signal.aborted) this.abort(options.signal.reason);
    }
    this.defaultConcurrency =
      options.maxConcurrency === undefined
        ? WORKFLOW_DEFAULT_MAX_CONCURRENCY
        : resolveMaxConcurrency(options.maxConcurrency);
    this.maxItems = options.maxItemsPerFanOut ?? WORKFLOW_MAX_ITEMS_PER_FAN_OUT;
  }

  runtimeConfig(): AgentRunPoolRuntimeConfig {
    return { maxConcurrency: this.defaultConcurrency, maxItemsPerFanOut: this.maxItems };
  }

  abort(reason?: unknown): void {
    if (this.controller.signal.aborted) return;
    this.unlinkExternalAbort?.();
    this.unlinkExternalAbort = undefined;
    this.controller.abort(reason);
  }

  async waitForIdle(): Promise<void> {
    while (this.activeBatches.size > 0 || this.activeAttempts.size > 0) {
      await Promise.allSettled([...this.activeBatches, ...this.activeAttempts]);
    }
  }

  /**
   * Fan `fn` out over `items` concurrently with a barrier: resolves only when
   * every item has settled, preserving input order. A per-item throw yields
   * `null` for that element.
   */
  async parallel<I, O>(
    items: readonly I[],
    fn: (item: I, index: number) => Promise<O> | O,
    opts?: WorkflowFanOutOpts,
  ): Promise<readonly (O | null)[]> {
    this.assertItemCap(items.length);
    const closures = items.map(
      (item, index) => async (): Promise<unknown> => fn(item, index),
    );
    const outcomes = await this.runClosures(closures, opts);
    return outcomes.map((outcome) =>
      outcome.status === 'completed' ? (outcome.value as O) : null,
    );
  }

  /**
   * Run a linear chain of stages with no barrier. Each stage's output feeds
   * the next as `prevResult`; a throwing stage aborts the chain and resolves
   * that item to `null`. With `opts.items`, the chain runs once per item and
   * the resolved value is the array of per-item outcomes; without it, the
   * resolved value is the single chain outcome (`opts.input` seeds the first
   * stage's `prevResult`).
   */
  async pipeline<O>(
    stages: readonly WorkflowStageFn<unknown, unknown, O>[],
    opts?: WorkflowPipelineOpts,
  ): Promise<O | readonly (O | null)[] | null> {
    const seed = opts?.input;
    if (opts?.items === undefined) {
      return (await this.runChain(stages, seed, undefined, this.signal)) as O | null;
    }
    this.assertItemCap(opts.items.length);
    const closures = opts.items.map(
      (item) => (signal: AbortSignal): Promise<unknown> => this.runChain(stages, seed, item, signal),
    );
    const outcomes = await this.runClosures(closures, opts);
    return outcomes.map((outcome) =>
      outcome.status === 'completed' ? outcome.value : null,
    ) as readonly (O | null)[];
  }

  /**
   * Run the per-item closures through one `AgentRunBatch`. Every item is an
   * independent spawn task; the batch owns concurrency, burst launch,
   * rate-limit requeue and abort settlement. Resolves with per-item outcomes
   * in input order — never rejects for item errors (abort failures propagate
   * via the batch, which the DSL surfaces as a run failure).
   */
  private async runClosures(
    closures: ReadonlyArray<(signal: AbortSignal) => Promise<unknown>>,
    opts: WorkflowFanOutOpts | undefined,
  ): Promise<readonly WorkflowPoolOutcome[]> {
    const count = closures.length;
    this.assertItemCap(count);
    if (count === 0) return [];

    const values: unknown[] = new Array<unknown>(count);
    const batchId = this.batchSequence++;
    const tasks: SessionSwarmTask<WorkflowPoolTaskData>[] = closures.map((run, index) => ({
      kind: 'spawn',
      data: { index, run },
      profileName: 'workflow',
      parentToolCallId: `workflow-pool-${String(batchId)}`,
      prompt: '',
      description: '',
      runInBackground: false,
      swarmIndex: index,
      signal: this.signal,
    }));

    const launcher: AgentRunBatchLauncher = {
      spawn: (attempt) => this.attempt(attempt, closures, values),
      resume: (_agentId, attempt) => this.attempt(attempt, closures, values),
      retry: (_agentId, attempt) => this.attempt(attempt, closures, values),
    };

    const maxConcurrency =
      opts?.maxConcurrency === undefined
        ? this.defaultConcurrency
        : resolveMaxConcurrency(opts.maxConcurrency);
    const batch = new AgentRunBatch(launcher, tasks, { maxConcurrency });
    const running = batch.run();
    this.activeBatches.add(running);
    let results: Awaited<typeof running>;
    try {
      results = await running;
    } finally {
      this.activeBatches.delete(running);
    }

    return results.map((result, index) => {
      if (result.status === 'completed') {
        return { status: 'completed' as const, value: values[index] };
      }
      if (result.status === 'aborted') {
        return { status: 'aborted' as const, value: undefined };
      }
      return { status: 'failed' as const, value: undefined };
    });
  }

  /** Run a single pipeline stage chain; a throwing stage yields `null`. */
  private async runChain(
    stages: readonly WorkflowStageFn<unknown, unknown, unknown>[],
    seed: unknown,
    item: unknown,
    signal: AbortSignal | undefined,
  ): Promise<unknown> {
    let prev = seed;
    for (let index = 0; index < stages.length; index++) {
      signal?.throwIfAborted();
      const stage = stages[index];
      if (stage === undefined) break;
      try {
        prev = await stage(prev, item, index);
      } catch {
        signal?.throwIfAborted();
        return null;
      }
    }
    return prev;
  }

  /** The scheduler-launcher half of a fan-out task: run one closure. */
  private async attempt(
    attempt: AgentRunAttemptOptions,
    closures: ReadonlyArray<(signal: AbortSignal) => Promise<unknown>>,
    values: unknown[],
  ): Promise<AgentRunAttemptHandle> {
    const index = attempt.swarmIndex ?? 0;
    const closure = closures[index];
    const agentId = `wf-${String(index)}`;
    attempt.onReady?.();
    const completion = (async () => {
      if (closure === undefined) {
        throw new Error(`Workflow fan-out task ${String(index)} has no runner.`);
      }
      const value = await closure(attempt.signal);
      values[index] = value;
      return { result: 'ok' };
    })();
    const trackedCompletion = completion.finally(() => {
      this.activeAttempts.delete(trackedCompletion);
    });
    this.activeAttempts.add(trackedCompletion);
    return { agentId, profileName: 'workflow', completion: trackedCompletion };
  }

  private assertItemCap(count: number): void {
    if (count > this.maxItems) {
      throw new WorkflowItemCapExceededError(this.maxItems);
    }
  }
}

/**
 * Resolve a fan-out concurrency value, clamped to
 * `min(16, max(2, cores - 2))`. `undefined` resolves to the default ramp.
 */
export function resolveMaxConcurrency(requested?: number): number {
  const cores =
    typeof os.cpus === 'function' ? os.cpus().length : DEFAULT_CORE_COUNT_FALLBACK;
  const ceiling = Math.min(16, Math.max(2, cores - 2));
  if (requested === undefined) return ceiling;
  if (!Number.isInteger(requested) || requested < 1) return ceiling;
  return Math.max(2, Math.min(requested, ceiling));
}

const DEFAULT_CORE_COUNT_FALLBACK = 4;
