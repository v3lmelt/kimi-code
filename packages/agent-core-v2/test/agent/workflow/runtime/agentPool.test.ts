/**
 * `workflow.runtime` — unit tests for the AgentRunPool fan-out scheduler.
 *
 * Covers: `parallel()` barrier semantics with input-order preservation,
 * `pipeline()` no-barrier stage chaining, per-item null-on-throw (parallel
 * thunks and pipeline stages), the item budget ceiling, and the concurrency
 * ramp clamping.
 */

import { describe, expect, it } from 'vitest';

import {
  AgentRunPool,
  WorkflowItemCapExceededError,
  resolveMaxConcurrency,
  WORKFLOW_MAX_ITEMS_PER_FAN_OUT,
} from '#/agent/workflow/runtime/agentPool';

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void; reject: (error: unknown) => void } {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function flush(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

describe('AgentRunPool.parallel', () => {
  it('runs all items and resolves with results in input order (barrier)', async () => {
    const pool = new AgentRunPool({ maxConcurrency: 3 });
    const slow = deferred<string>();
    const fast = deferred<string>();

    const resultPromise = pool.parallel(['a', 'b'], (item) =>
      item === 'a' ? slow.promise : fast.promise,
    );

    fast.resolve('b-result');
    await flush();
    let settled = false;
    void resultPromise.then(() => {
      settled = true;
    });
    await flush();
    // Barrier: the whole call stays pending while one item is unfinished.
    expect(settled).toBe(false);

    slow.resolve('a-result');
    await expect(resultPromise).resolves.toEqual(['a-result', 'b-result']);
  });

  it('yields null for a throwing item without rejecting the call', async () => {
    const pool = new AgentRunPool({ maxConcurrency: 3 });
    const result = await pool.parallel(['a', 'b', 'c'], (item) => {
      if (item === 'b') throw new Error('boom');
      return item.toUpperCase();
    });
    expect(result).toEqual(['A', null, 'C']);
  });

  it('honours maxConcurrency as an upper bound on in-flight items', async () => {
    const pool = new AgentRunPool({ maxConcurrency: 2 });
    let active = 0;
    let peak = 0;
    const gates = [deferred<void>(), deferred<void>(), deferred<void>(), deferred<void>()];

    const promise = pool.parallel([0, 1, 2, 3], async (index) => {
      active += 1;
      peak = Math.max(peak, active);
      await gates[index]!.promise;
      active -= 1;
      return index;
    });

    await flush();
    // Only the first two items should have started.
    expect(active).toBe(2);

    for (const gate of gates) gate.resolve(undefined);
    await expect(promise).resolves.toEqual([0, 1, 2, 3]);
    expect(peak).toBeLessThanOrEqual(2);
  });

  it('enforces the item budget ceiling per call', async () => {
    const pool = new AgentRunPool({ maxConcurrency: 4 });
    const items = Array.from({ length: WORKFLOW_MAX_ITEMS_PER_FAN_OUT + 1 }, (_, i) => i);
    await expect(pool.parallel(items, async (item) => item)).rejects.toThrow(
      WorkflowItemCapExceededError,
    );
  });

  it('resolves immediately for an empty item list', async () => {
    const pool = new AgentRunPool({ maxConcurrency: 2 });
    await expect(pool.parallel([], async (item) => item)).resolves.toEqual([]);
  });

  it('waits for a launched closure to settle after the pool is aborted', async () => {
    const pool = new AgentRunPool({ maxConcurrency: 2 });
    const started = deferred<void>();
    const release = deferred<void>();
    const run = pool.parallel([0], async () => {
      started.resolve(undefined);
      await release.promise;
      return 'done';
    });

    await started.promise;
    pool.abort(new Error('workflow completed'));
    await expect(run).rejects.toThrow('workflow completed');

    let idle = false;
    const idlePromise = pool.waitForIdle().then(() => {
      idle = true;
    });
    await flush();
    expect(idle).toBe(false);
    release.resolve(undefined);
    await idlePromise;
    expect(idle).toBe(true);
  });
});

describe('AgentRunPool.pipeline', () => {
  it('chains stages with no barrier: each stage sees the previous output', async () => {
    const calls: Array<{ item: string; stage: number; prev: string | undefined }> = [];
    const pool = new AgentRunPool({ maxConcurrency: 3 });

    const result = await pool.pipeline<string>(
      [
        (prev, item, index) => {
          calls.push({ item: String(item), stage: index, prev: prev as string | undefined });
          return `${prev ?? 'seed'}-a`;
        },
        (prev, item, index) => {
          calls.push({ item: String(item), stage: index, prev: prev as string | undefined });
          return `${prev!}-b`;
        },
      ],
      { input: 'seed', items: ['x', 'y'] },
    );

    expect(result).toEqual(['seed-a-b', 'seed-a-b']);
    for (const item of ['x', 'y']) {
      const chain = calls
        .filter((call) => call.item === item)
        .sort((a, b) => a.stage - b.stage);
      expect(chain).toEqual([
        { item, stage: 0, prev: 'seed' },
        { item, stage: 1, prev: 'seed-a' },
      ]);
    }
  });

  it('drops an item to null and skips remaining stages when a stage throws', async () => {
    const calledStages: string[] = [];
    const pool = new AgentRunPool({ maxConcurrency: 3 });

    const result = await pool.pipeline<string>(
      [
        (prev, item) => {
          calledStages.push(`s0-${String(item)}`);
          return `v-${String(item)}`;
        },
        (prev, item) => {
          calledStages.push(`s1-${String(item)}`);
          if (item === 'b') throw new Error('boom');
          return `${String(prev)}!`;
        },
        (prev, item) => {
          calledStages.push(`s2-${String(item)}`);
          return `${String(prev)}?`;
        },
      ],
      { items: ['a', 'b', 'c'] },
    );

    expect(result).toEqual(['v-a!?', null, 'v-c!?']);
    expect(calledStages).not.toContain('s2-b');
  });

  it('runs a single chain and returns its final value when items are omitted', async () => {
    const pool = new AgentRunPool({ maxConcurrency: 2 });
    const result = await pool.pipeline<string>(
      [
        (prev) => `${prev ?? 'seed'}-one`,
        (prev) => `${String(prev)}-two`,
      ],
      { input: 'seed' },
    );
    expect(result).toBe('seed-one-two');
  });

  it('returns null when a single chain stage throws', async () => {
    const pool = new AgentRunPool({ maxConcurrency: 2 });
    const result = await pool.pipeline<string>(
      [
        (prev) => String(prev),
        () => {
          throw new Error('boom');
        },
        (prev) => `never-${String(prev)}`,
      ],
      { input: 'x' },
    );
    expect(result).toBeNull();
  });
});

describe('resolveMaxConcurrency', () => {
  it('clamps requested values into the min(16, max(2, cores - 2)) ramp', () => {
    expect(resolveMaxConcurrency(1)).toBeGreaterThanOrEqual(2);
    expect(resolveMaxConcurrency(100)).toBeLessThanOrEqual(16);
    expect(resolveMaxConcurrency(4)).toBe(4);
  });
});
