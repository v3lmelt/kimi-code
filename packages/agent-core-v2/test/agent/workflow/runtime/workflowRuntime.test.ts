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
  WorkflowRuntime,
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
