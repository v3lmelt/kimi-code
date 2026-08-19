/**
 * Stateful execution scheduler for tool calls in one model step.
 *
 * The scheduler owns only execution ordering:
 *   - tasks with non-conflicting resource accesses may overlap
 *   - tasks with conflicting resource accesses wait for the conflicting active tasks
 *   - an optional bounded rolling pool (`maxParallel`) limits how many tasks run at once
 *   - every task records its model call sequence (the order it was added); callers
 *     decide whether to drain results in provider order or completion order
 *   - `abort` settles never-dispatched (still queued) tasks with an
 *     `AbortedBeforeDispatchError` so no caller waits on a task that never ran
 */

import { ToolAccesses } from '#/tool/toolContract';

/** Error produced when a tool call is settled without ever being dispatched —
 *  it was still queued (blocked on a conflicting active task or the bounded
 *  pool) when the batch aborted. The executor synthesizes an aborted result. */
export class AbortedBeforeDispatchError extends Error {
  override readonly cause?: unknown;

  constructor(cause?: unknown) {
    super('Tool call aborted before dispatch');
    this.name = 'AbortedBeforeDispatchError';
    this.cause = cause;
  }
}

export function isAbortedBeforeDispatchError(error: unknown): boolean {
  return error instanceof AbortedBeforeDispatchError;
}

export interface ToolCallTask<Result> {
  readonly accesses: ToolAccesses;
  readonly start: () => Promise<{ readonly result: Promise<Result> }>;
}

export interface ToolSchedulerOptions {
  /** Bounded rolling pool: at most this many tasks run concurrently. When set
   *  and reached, new tasks queue until an active task finishes. `undefined`
   *  keeps the previous unbounded dispatch (access-conflict scheduling only). */
  readonly maxParallel?: number;
}

interface ScheduledToolCallTask<Result> extends ToolCallTask<Result> {
  readonly result: ControlledPromise<Result>;
  /** Model call ordinal (order of `add`). Results commit in this order. */
  readonly sequence: number;
}

type ControlledPromise<Result> = Promise<Result> & {
  readonly resolve: (value: Result | PromiseLike<Result>) => void;
  readonly reject: (reason?: unknown) => void;
};

export class ToolScheduler<Result> {
  private readonly activeTasks: Array<ScheduledToolCallTask<Result>> = [];
  private queuedTasks: Array<ScheduledToolCallTask<Result>> = [];
  private readonly maxParallel: number | undefined;
  private nextSequence = 0;
  private aborted = false;

  constructor(options: ToolSchedulerOptions = {}) {
    this.maxParallel =
      options.maxParallel !== undefined && options.maxParallel > 0
        ? options.maxParallel
        : undefined;
  }

  add(task: ToolCallTask<Result>): Promise<Result> {
    const result = createControlledPromise<Result>();
    void result.catch(() => undefined);

    const scheduledTask: ScheduledToolCallTask<Result> = {
      ...task,
      result,
      sequence: this.nextSequence,
    };
    this.nextSequence += 1;

    if (this.aborted) {
      result.reject(new AbortedBeforeDispatchError());
      return result;
    }
    if (this.isBlocked(task, this.queuedTasks) || this.atCapacity()) {
      this.queuedTasks.push(scheduledTask);
    } else {
      this.start(scheduledTask);
    }

    return result;
  }

  /** Aborts the scheduler: queued (never-dispatched) tasks reject with an
   *  `AbortedBeforeDispatchError`; active tasks keep running and settle via
   *  their own abort signals. */
  abort(cause?: unknown): void {
    if (this.aborted) return;
    this.aborted = true;
    for (const task of this.queuedTasks) {
      task.result.reject(new AbortedBeforeDispatchError(cause));
    }
    this.queuedTasks = [];
  }

  private isBlocked(
    task: ToolCallTask<Result>,
    queuedBefore: readonly ToolCallTask<Result>[],
  ): boolean {
    return (
      this.conflictsWithAny(task, this.activeTasks) || this.conflictsWithAny(task, queuedBefore)
    );
  }

  private conflictsWithAny(
    task: ToolCallTask<Result>,
    candidates: readonly ToolCallTask<Result>[],
  ): boolean {
    return candidates.some((candidate) =>
      ToolAccesses.conflict(task.accesses, candidate.accesses),
    );
  }

  private atCapacity(): boolean {
    return this.maxParallel !== undefined && this.activeTasks.length >= this.maxParallel;
  }

  private start(task: ScheduledToolCallTask<Result>): void {
    this.activeTasks.push(task);
    let started: Promise<{ readonly result: Promise<Result> }>;
    try {
      started = task.start();
    } catch (error) {
      task.result.reject(error);
      this.finish(task);
      return;
    }

    void started
      .then(({ result }) => result)
      .then(task.result.resolve, task.result.reject)
      .finally(() => {
        this.finish(task);
      });
  }

  private finish(task: ScheduledToolCallTask<Result>): void {
    const index = this.activeTasks.indexOf(task);
    if (index >= 0) this.activeTasks.splice(index, 1);
    this.startQueuedTasks();
  }

  private startQueuedTasks(): void {
    const stillQueued: Array<ScheduledToolCallTask<Result>> = [];
    for (const task of this.queuedTasks) {
      if (this.isBlocked(task, stillQueued) || this.atCapacity()) {
        stillQueued.push(task);
      } else {
        this.start(task);
      }
    }
    this.queuedTasks = stillQueued;
  }
}

function createControlledPromise<Result>(): ControlledPromise<Result> {
  let resolve!: (value: Result | PromiseLike<Result>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<Result>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  }) as ControlledPromise<Result>;
  return Object.assign(promise, { resolve, reject });
}
