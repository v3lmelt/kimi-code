/**
 * `workflow.runtime` — unit tests for the WorkflowRuntime sandbox executor.
 *
 * Covers: awaited `main()` return value, real token-budget accounting feeding
 * `budget.spent()` / `remaining()`, the agent budget ceiling throw, the
 * one-level `workflow()` nesting guard, sandbox hardening (code generation
 * disabled, non-enumerable globals), and progress callbacks (`phase` / `log`).
 */

import { describe, expect, it } from 'vitest';
import { grandTotal, type TokenUsage } from '#/kosong/contract/usage';

import { AgentRunPool } from '#/agent/workflow/runtime/agentPool';
import {
  WorkflowAgentCapExceededError,
  WorkflowBudgetExceededError,
  WorkflowNestingExceededError,
  WorkflowRunCancelledError,
  WorkflowRuntime,
  WorkflowTimeoutError,
  installWorkflowGlobals,
  type WorkflowAgentSpawnResult,
} from '#/agent/workflow/runtime/workflowRuntime';
import type { WorkflowAgentOpts, WorkflowSandboxGlobals } from '#/agent/workflow/types';

const SAMPLE_USAGE: TokenUsage = {
  inputOther: 100,
  output: 50,
  inputCacheRead: 0,
  inputCacheCreation: 0,
};

function spawnHost(): (prompt: string, opts: WorkflowAgentOpts | undefined) => Promise<WorkflowAgentSpawnResult> {
  let n = 0;
  return async (prompt, _opts) => {
    n += 1;
    return {
      ok: true,
      agentId: `a${String(n)}`,
      output: `out-${prompt}`,
      durationMs: 1,
      usage: SAMPLE_USAGE,
    };
  };
}

function runtimeFor(
  source: string,
  options: { agentCap?: number; tokenBudgetTotal?: number } = {},
): WorkflowRuntime {
  return new WorkflowRuntime({
    source,
    args: { from: 'test' },
    tokenBudgetTotal: options.tokenBudgetTotal ?? 1_000_000,
    agentCap: options.agentCap,
    agentSpawn: spawnHost(),
    pool: new AgentRunPool({ maxConcurrency: 4 }),
  });
}

describe('WorkflowRuntime', () => {
  it('awaits main() and resolves with its return value', async () => {
    const runtime = runtimeFor(`
export const meta = { name: 'returns', description: 'x' };

export async function main() {
  const r = await agent('probe');
  return { got: r.output, id: r.agentId, argsSeen: args };
}
`);
    const output = await runtime.run();
    expect(output.result).toEqual({ got: 'out-probe', id: 'a1', argsSeen: { from: 'test' } });
    expect(output.meta.name).toBe('returns');
    expect(output.agentsSpawned).toBe(1);
  });

  it('preserves structured agent output across the Worker RPC boundary', async () => {
    const value = { answer: 'ok', nested: [1, { accepted: true }] };
    const runtime = new WorkflowRuntime({
      source: `
export const meta = { name: 'structured-rpc', description: 'x' };

export async function main() {
  const result = await agent('structured');
  return { ok: result.ok, output: result.output };
}
`,
      args: undefined,
      tokenBudgetTotal: 1_000,
      agentSpawn: async () => ({
        ok: true,
        agentId: 'structured-agent',
        output: value,
        durationMs: 1,
        usage: SAMPLE_USAGE,
      }),
      pool: new AgentRunPool({ maxConcurrency: 2 }),
    });

    await expect(runtime.run()).resolves.toMatchObject({
      result: { ok: true, output: value },
      tokensSpent: grandTotal(SAMPLE_USAGE),
    });
  });

  it('feeds real token accounting into budget.spent() / remaining()', async () => {
    const phases: string[] = [];
    const logs: unknown[][] = [];
    const runtime = new WorkflowRuntime({
      source: `
export const meta = { name: 'budget', description: 'x' };

export async function main() {
  const before = budget.spent();
  await agent('first');
  const after = budget.spent();
  phase('middle');
  log('hello', 42);
  return { total: budget.total, before, after, remaining: budget.remaining() };
}
`,
      args: undefined,
      tokenBudgetTotal: 1_000,
      agentSpawn: spawnHost(),
      pool: new AgentRunPool({ maxConcurrency: 2 }),
      onPhaseChanged: (title) => phases.push(title),
      onLog: (parts) => logs.push([...parts]),
    });

    const output = await runtime.run();
    // grandTotal({ inputOther: 100, output: 50, ... }) === 150
    expect(output.tokensSpent).toBe(150);
    expect(output.result).toEqual({
      total: 1_000,
      before: 0,
      after: 150,
      remaining: 850,
    });
    expect(phases).toEqual(['middle']);
    expect(logs).toEqual([['hello', 42]]);
  });

  it('delegates budget.total/spent to the host budget and reports subagent usage', async () => {
    let hostSpent = 0;
    const subagentUsages: TokenUsage[] = [];
    const externalBudget = {
      total: 10_000,
      spent: () => hostSpent,
      remaining: () => Math.max(0, 10_000 - hostSpent),
    };
    const runtime = new WorkflowRuntime({
      source: `
export const meta = { name: 'ext-budget', description: 'x' };

export async function main() {
  const before = budget.spent();
  await agent('first');
  return { total: budget.total, before, after: budget.spent(), remaining: budget.remaining() };
}
`,
      args: undefined,
      tokenBudgetTotal: 999,
      budget: externalBudget,
      onSubagentUsage: (usage) => {
        subagentUsages.push(usage);
        hostSpent += grandTotal(usage);
      },
      agentSpawn: spawnHost(),
      pool: new AgentRunPool({ maxConcurrency: 2 }),
    });

    const output = await runtime.run();

    // The script sees the host budget: total 10_000, spent driven by hostSpent.
    expect(output.result).toEqual({ total: 10_000, before: 0, after: 150, remaining: 9_850 });
    // Host folded the subagent usage back in.
    expect(subagentUsages).toHaveLength(1);
    expect(subagentUsages[0]).toEqual(SAMPLE_USAGE);
    // The run summary still reports the subagent-only spend.
    expect(output.tokensSpent).toBe(150);
  });

  it('throws past the agent budget ceiling (cap)', async () => {
    const runtime = runtimeFor(
      `
export const meta = { name: 'cap', description: 'x' };

export async function main() {
  await agent('a');
  await agent('b');
  await agent('c');
  return 'done';
}
`,
      { agentCap: 2 },
    );
    await expect(runtime.run()).rejects.toThrow(WorkflowAgentCapExceededError);
  });

  it('allows one level of workflow() nesting and runs the body', async () => {
    const runtime = runtimeFor(`
export const meta = { name: 'nest-ok', description: 'x' };

export async function main() {
  const inner = await workflow({ fn: async () => {
    const r = await agent('inner');
    return r.output;
  }, budget: 5_000 });
  return inner;
}
`);
    const output = await runtime.run();
    expect(output.result).toBe('out-inner');
  });

  it('enforces a nested workflow budget and rejects unsupported isolation', async () => {
    const budgetRuntime = runtimeFor(`
export const meta = { name: 'nested-budget', description: 'x' };

export async function main() {
  return await workflow({ budget: 150, fn: async () => {
    await agent('first');
    try {
      await agent('second');
      return 'unexpected';
    } catch (error) {
      return { total: budget.total, spent: budget.spent(), name: error.name };
    }
  }});
}
`);
    await expect(budgetRuntime.run()).resolves.toMatchObject({
      result: { total: 150, spent: 150, name: 'WorkflowBudgetExceededError' },
    });

    const isolationRuntime = runtimeFor(`
export const meta = { name: 'nested-isolation', description: 'x' };

export async function main() {
  try {
    await workflow({ isolation: 'worktree', fn: async () => 'never' });
    return 'unexpected';
  } catch (error) {
    return error.name;
  }
}
`);
    await expect(isolationRuntime.run()).resolves.toMatchObject({
      result: 'WorkflowIsolationUnsupportedError',
    });
  });

  it('rejects non-positive nested workflow budgets at the input boundary', async () => {
    const runtime = runtimeFor(`
export const meta = { name: 'invalid-nested-budget', description: 'x' };

export async function main() {
  const failures = [];
  for (const value of [0, -1]) {
    try {
      await workflow({ budget: value, fn: async () => 'unexpected' });
      failures.push({ value, accepted: true });
    } catch (error) {
      failures.push({ value, name: error.name, message: error.message });
    }
  }
  return failures;
}
`);
    await expect(runtime.run()).resolves.toMatchObject({
      result: [
        { value: 0, name: 'WorkflowRunError', message: 'workflow() budget must be a finite positive number.' },
        { value: -1, name: 'WorkflowRunError', message: 'workflow() budget must be a finite positive number.' },
      ],
    });
  });

  it('fans out parallel and pipeline through the sandbox globals', async () => {
    const runtime = runtimeFor(`
export const meta = { name: 'fanout', description: 'x' };

export async function main() {
  const parallelOut = await parallel(['p1', 'p2'], async (item) => {
    const r = await agent(item);
    return r.output;
  });
  const pipelineOut = await pipeline([
    async (prev) => {
      const r = await agent(String(prev ?? 'seed'));
      return r.output;
    },
    async (prev) => \`\${prev}-chained\`,
  ], { input: 'stage0' });
  return { parallelOut, pipelineOut };
}
`);
    const output = await runtime.run();
    expect(output.result).toEqual({
      parallelOut: ['out-p1', 'out-p2'],
      pipelineOut: 'out-stage0-chained',
    });
    expect(output.agentsSpawned).toBe(3);
  });

  it('throws when a nested workflow body calls workflow() again', async () => {
    const runtime = runtimeFor(`
export const meta = { name: 'nest-guard', description: 'x' };

export async function main() {
  return await workflow(async () => {
    return await workflow(async () => 'too deep');
  });
}
`);
    await expect(runtime.run()).rejects.toThrow(WorkflowNestingExceededError);
  });

  it('disables code generation inside the sandbox', async () => {
    const runtime = runtimeFor(`
export const meta = { name: 'sandbox', description: 'x' };

export async function main() {
  const fn = (() => {
    try {
      new Function('return 1');
      return 'available';
    } catch {
      return 'blocked';
    }
  })();
  const evalBlocked = (() => {
    try {
      return eval('1 + 1');
    } catch {
      return 'blocked';
    }
  })();
  return { fn, evalBlocked };
}
`);
    const output = await runtime.run();
    expect(output.result).toEqual({ fn: 'blocked', evalBlocked: 'blocked' });
  });

  it('rejects a script that violates the compile contract', async () => {
    const runtime = runtimeFor(`
export const meta = { name: 'bad', description: 'x' };

export async function main() {
  return Date.now();
}
`);
    await expect(runtime.run()).rejects.toMatchObject({ code: 'workflow.determinism_violation' });
  });

  it('breaks Date.now at runtime even via a static-analysis bypass (computed access)', async () => {
    const runtime = runtimeFor(`
export const meta = { name: 'bypass-date', description: 'x' };

export async function main() {
  try {
    return Date['now']();
  } catch (error) {
    return String(error.message).includes('non-deterministic') ? 'blocked' : 'unexpected: ' + error.message;
  }
}
`);
    const output = await runtime.run();
    expect(output.result).toBe('blocked');
  });

  it('breaks Math.random at runtime even via a static-analysis bypass (aliasing)', async () => {
    const runtime = runtimeFor(`
export const meta = { name: 'bypass-random', description: 'x' };

export async function main() {
  const m = Math;
  try {
    return m['ran' + 'dom']();
  } catch (error) {
    return String(error.message).includes('non-deterministic') ? 'blocked' : 'unexpected: ' + error.message;
  }
}
`);
    const output = await runtime.run();
    expect(output.result).toBe('blocked');
  });

  it('breaks zero-arg new Date() while keeping new Date(timestamp) usable', async () => {
    const runtime = runtimeFor(`
export const meta = { name: 'date-shim', description: 'x' };

export async function main() {
  const Ctor = Date;
  let zeroArg;
  try {
    // The compile-time check only sees literal new Date(); the runtime shim
    // must still reject the zero-arg construction.
    Reflect.construct(Ctor, []);
    zeroArg = 'available';
  } catch {
    zeroArg = 'blocked';
  }
  const fixed = new Date(0).getTime();
  const parsed = Date.parse('1970-01-01T00:00:00.000Z');
  return { zeroArg, fixed, parsed };
}
`);
    const output = await runtime.run();
    expect(output.result).toEqual({ zeroArg: 'blocked', fixed: 0, parsed: 0 });
  });

  it('keeps deterministic builtins blocked after computed-property assignments', async () => {
    const runtime = runtimeFor(`
export const meta = { name: 'immutable-hardening', description: 'x' };

export async function main() {
  const math = Math;
  const date = Date;
  const randomKey = 'ran' + 'dom';
  const nowKey = 'no' + 'w';
  try { math[randomKey] = () => 0.5; } catch {}
  try { date[nowKey] = () => 0; } catch {}
  try { Math = { [randomKey]: () => 0.5 }; } catch {}
  try { Date = function FakeDate() {}; } catch {}
  const call = (fn) => {
    try { return fn(); } catch (error) {
      return String(error.message).includes('non-deterministic') ? 'blocked' : 'unexpected';
    }
  };
  return {
    random: call(() => math[randomKey]()),
    now: call(() => date[nowKey]()),
    mathFrozen: Object.isFrozen(math),
    dateFrozen: Object.isFrozen(date),
    randomWritable: Object.getOwnPropertyDescriptor(math, randomKey).writable,
    nowWritable: Object.getOwnPropertyDescriptor(date, nowKey).writable,
  };
}
`);
    await expect(runtime.run()).resolves.toMatchObject({
      result: {
        random: 'blocked',
        now: 'blocked',
        mathFrozen: true,
        dateFrozen: true,
        randomWritable: false,
        nowWritable: false,
      },
    });
  });

  it('bounds an await-free slice that pins the event loop (timeout)', async () => {
    const runtime = new WorkflowRuntime({
      source: `
export const meta = { name: 'spin', description: 'x' };

export async function main() {
  let x = 0;
  while (true) { x += 1; }
  return x;
}
`,
      args: undefined,
      tokenBudgetTotal: 1_000,
      timeoutMs: 200,
      agentSpawn: spawnHost(),
      pool: new AgentRunPool({ maxConcurrency: 2 }),
    });
    await expect(runtime.run()).rejects.toThrow(/timed out/i);
  });

  it('terminates a later synchronous slice after an awaited agent call', async () => {
    const runtime = new WorkflowRuntime({
      source: `
export const meta = { name: 'post-await-spin', description: 'x' };

export async function main() {
  await agent('release');
  while (true) {}
}
`,
      args: undefined,
      tokenBudgetTotal: 1_000,
      timeoutMs: 100,
      agentSpawn: async () => ({ ok: true, agentId: 'a1', output: 'ok', durationMs: 1 }),
      pool: new AgentRunPool({ maxConcurrency: 2 }),
    });
    await expect(runtime.run()).rejects.toBeInstanceOf(WorkflowTimeoutError);
  });

  it('cancels only unfinished host RPCs after the Worker reports completion', async () => {
    let completedSignal: AbortSignal | undefined;
    let unfinishedSignal: AbortSignal | undefined;
    let unfinishedStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      unfinishedStarted = resolve;
    });
    const usageEvents: TokenUsage[] = [];
    const runtime = new WorkflowRuntime({
      source: `
export const meta = { name: 'fire-and-forget', description: 'x' };

export async function main() {
  const completed = await agent('completed');
  agent('unfinished');
  return completed.output;
}
`,
      args: undefined,
      tokenBudgetTotal: 1_000,
      onSubagentUsage: (usage) => usageEvents.push(usage),
      agentSpawn: async (prompt, _opts, signal) => {
        if (prompt === 'completed') {
          completedSignal = signal;
          return { ok: true, agentId: 'completed', output: 'done', durationMs: 1, usage: SAMPLE_USAGE };
        }
        unfinishedSignal = signal;
        unfinishedStarted();
        return await new Promise<never>((_resolve, reject) => {
          signal?.addEventListener('abort', () => reject(signal.reason), { once: true });
        });
      },
      pool: new AgentRunPool({ maxConcurrency: 2 }),
    });

    const run = runtime.run();
    await started;
    await expect(run).resolves.toMatchObject({ result: 'done', tokensSpent: grandTotal(SAMPLE_USAGE) });
    expect(completedSignal?.aborted).toBe(false);
    expect(unfinishedSignal?.aborted).toBe(true);
    expect(usageEvents).toEqual([SAMPLE_USAGE]);
    await Promise.resolve();
    expect(usageEvents).toHaveLength(1);
  });

  it('times out a microtask log flood without retaining every log entry', async () => {
    const samples: unknown[][] = [];
    const runtime = new WorkflowRuntime({
      source: `
export const meta = { name: 'log-flood', description: 'x' };

export async function main() {
  while (true) {
    log('flood');
    await Promise.resolve();
  }
}
`,
      args: undefined,
      tokenBudgetTotal: 1_000,
      timeoutMs: 80,
      onLog: (parts) => {
        if (samples.length < 4) samples.push([...parts]);
      },
      agentSpawn: async () => ({ ok: true, agentId: 'unused', output: null, durationMs: 1 }),
      pool: new AgentRunPool({ maxConcurrency: 2 }),
    });

    await expect(runtime.run()).rejects.toBeInstanceOf(WorkflowTimeoutError);
    expect(samples.length).toBeLessThanOrEqual(4);
  });

  it('keeps a long host agent RPC alive while Worker heartbeats continue', async () => {
    let started!: () => void;
    const rpcStarted = new Promise<void>((resolve) => {
      started = resolve;
    });
    let release!: () => void;
    const releaseRpc = new Promise<void>((resolve) => {
      release = resolve;
    });
    const runtime = new WorkflowRuntime({
      source: `
export const meta = { name: 'long-rpc', description: 'x' };

export async function main() {
  const result = await agent('slow');
  return result.output;
}
`,
      args: undefined,
      tokenBudgetTotal: 1_000,
      timeoutMs: 200,
      agentSpawn: async () => {
        started();
        await releaseRpc;
        return { ok: true, agentId: 'slow', output: 'released', durationMs: 1 };
      },
      pool: new AgentRunPool({ maxConcurrency: 2 }),
    });

    const run = runtime.run();
    await rpcStarted;
    await new Promise<void>((resolve) => setTimeout(resolve, 450));
    release();
    await expect(run).resolves.toMatchObject({ result: 'released' });
  });

  it('does not expose the Worker process through proxy function constructors', async () => {
    const runtime = runtimeFor(`
export const meta = { name: 'worker-boundary', description: 'x' };

export async function main() {
  const tryEscape = (run) => {
    try { return run(); } catch { return 'blocked'; }
  };
  return {
    objectEscape: tryEscape(() => ({})['constructor']['constructor']('return process')()),
    proxyEscape: tryEscape(() => agent.constructor('return process')()),
  };
}
`);
    const output = await runtime.run();
    expect(output.result).toEqual({ objectEscape: 'blocked', proxyEscape: 'blocked' });
  });

  it('terminates and settles the Worker when the run is cancelled', async () => {
    const controller = new AbortController();
    let spawnStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      spawnStarted = resolve;
    });
    const runtime = new WorkflowRuntime({
      source: `
export const meta = { name: 'cancel', description: 'x' };

export async function main() {
  await agent('wait');
  return 'never';
}
`,
      args: undefined,
      signal: controller.signal,
      tokenBudgetTotal: 1_000,
      agentSpawn: async () => {
        spawnStarted();
        await new Promise<never>((_resolve, reject) => {
          controller.signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
        });
        return { ok: true, agentId: 'never', output: null, durationMs: 1 };
      },
      pool: new AgentRunPool({ maxConcurrency: 2 }),
    });
    const run = runtime.run();
    await started;
    controller.abort();
    await expect(run).rejects.toBeInstanceOf(WorkflowRunCancelledError);
  });

  it('aborts an in-flight host RPC when a Worker-side host callback fails', async () => {
    let rpcSignal: AbortSignal | undefined;
    let rpcSettled = false;
    const runtime = new WorkflowRuntime({
      source: `
export const meta = { name: 'host-callback-failure', description: 'x' };

export async function main() {
  const pending = agent('wait');
  phase('boom');
  return await pending;
}
`,
      args: undefined,
      signal: undefined,
      tokenBudgetTotal: 1_000,
      onPhaseChanged: () => {
        throw new Error('phase callback failed');
      },
      agentSpawn: async (_prompt, _opts, signal) => {
        rpcSignal = signal;
        return await new Promise<WorkflowAgentSpawnResult>((_resolve, reject) => {
          signal?.addEventListener(
            'abort',
            () => {
              rpcSettled = true;
              reject(signal.reason);
            },
            { once: true },
          );
        });
      },
      pool: new AgentRunPool({ maxConcurrency: 2 }),
    });

    await expect(runtime.run()).rejects.toThrow('phase callback failed');
    expect(rpcSignal?.aborted).toBe(true);
    expect(rpcSettled).toBe(true);
  });

  it('hard-stops new agent() calls once the token budget is exhausted', async () => {
    const runtime = runtimeFor(
      `
export const meta = { name: 'budget-cap', description: 'x' };

export async function main() {
  await agent('a');
  await agent('b');
  return 'done';
}
`,
      // One agent costs 150 tokens (SAMPLE_USAGE); the second call must throw.
      { tokenBudgetTotal: 150 },
    );
    await expect(runtime.run()).rejects.toThrow(WorkflowBudgetExceededError);
  });

  it('does not hard-stop when the budget total is zero (advisory only)', async () => {
    const runtime = runtimeFor(
      `
export const meta = { name: 'budget-advisory', description: 'x' };

export async function main() {
  await agent('a');
  await agent('b');
  return 'done';
}
`,
      { tokenBudgetTotal: 0 },
    );
    const output = await runtime.run();
    expect(output.result).toBe('done');
  });
});

describe('installWorkflowGlobals', () => {
  it('installs globals non-enumerably and non-configurably', () => {
    const context: Record<string, unknown> = {};
    const globals = {
      agent: async () => ({}) as unknown,
      args: { x: 1 },
    } as unknown as WorkflowSandboxGlobals;

    installWorkflowGlobals(context, globals);

    expect(Object.keys(context)).toEqual([]);
    expect(context['agent']).toBe(globals.agent);
    expect(context['args']).toEqual({ x: 1 });
  });
});
