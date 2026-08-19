/**
 * `workflow.runtime` — the Workflow runtime executor.
 *
 * Executes a compiled workflow script inside a `node:vm` sandbox, fanning out
 * real subagent work through the host-provided spawn callback and the
 * `AgentRunPool`. The sandbox is deliberately sealed down:
 *
 * - the script is compiled as `vm.Script` (filename `workflow.js`) — no module
 *   loader, no `require`, no `import`;
 * - every DSL global (`agent` / `parallel` / `pipeline` / `phase` / `log` /
 *   `args` / `budget` / `workflow`) is installed non-enumerably via
 *   `Object.defineProperty` so `for...in` over the sandbox stays clean;
 * - `codeGeneration` is disabled on the context (`strings: false`,
 *   `wasm: false`), so `eval` / `new Function` / WebAssembly are unavailable;
 * - the top level of the script runs inside an `async` IIFE, so the script's
 *   entry point (`export async function main(...)`) is awaited and its return
 *   value resolves the run.
 *
 * The runtime enforces the workflow's hard budgets: a total agent counter
 * (default cap 1000, throw beyond), a one-level `workflow()` nesting guard
 * (a child `workflow()` call throws), and a `budget` object whose
 * `spent()` / `remaining()` are wired to real token accounting (tokens are
 * accumulated from every subagent completion reported through the spawn
 * callback). The per-`parallel()`/`pipeline()` item cap is enforced by the
 * `AgentRunPool`.
 */

import vm from 'node:vm';
import type { Program } from 'acorn';

import { grandTotal, type TokenUsage } from '#/kosong/contract/usage';

import { compileWorkflowScript } from '../compile/index';
import type {
  AgentFn,
  LogFn,
  ParallelFn,
  PhaseFn,
  PipelineFn,
  WorkflowAgentOpts,
  WorkflowAgentResult,
  WorkflowBudget,
  WorkflowFn,
  WorkflowPipelineOpts,
  WorkflowSandboxGlobals,
  WorkflowScriptMeta,
  WorkflowStageFn,
} from '../types';
import { WorkflowCompileError } from '../types';

import { AgentRunPool } from './agentPool';
import {
  WORKFLOW_DEFAULT_TIMEOUT_MS,
  WORKFLOW_SANDBOX_PRELUDE,
} from './sandboxHardening';

/** Filename the sandbox sees in stack traces / error messages. */
export const WORKFLOW_SANDBOX_FILENAME = 'workflow.js';

/** Default ceiling on the total number of agents one run may spawn. */
export const WORKFLOW_DEFAULT_AGENT_CAP = 1000;

/** Runtime error base for workflow execution failures. */
export class WorkflowRunError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WorkflowRunError';
  }
}

/** Thrown when a run exceeds the total agent budget ceiling. */
export class WorkflowAgentCapExceededError extends WorkflowRunError {
  constructor(readonly cap: number) {
    super(
      `Workflow agent budget ceiling exceeded: no more than ${String(cap)} agents may be spawned per workflow run.`,
    );
    this.name = 'WorkflowAgentCapExceededError';
  }
}

/** Thrown when a nested `workflow()` body calls `workflow()` again. */
export class WorkflowNestingExceededError extends WorkflowRunError {
  constructor() {
    super('workflow() may only be nested one level deep.');
    this.name = 'WorkflowNestingExceededError';
  }
}

/**
 * Thrown by `agent()` once the run's token budget is exhausted. In-flight
 * agents still complete and their results are preserved; only *new* spawns
 * are refused. A run only gets this hard stop when it has a real token target
 * (`budget.total > 0`) — with no target, the budget global is advisory and
 * the script's own `budget.remaining()` checks are the guardrail.
 */
export class WorkflowBudgetExceededError extends WorkflowRunError {
  constructor(
    readonly spent: number,
    readonly total: number,
  ) {
    super(
      `Workflow token budget exceeded (${spent.toLocaleString()} / ${total.toLocaleString()} tokens). ` +
        `Stopping further agent() calls. In-flight agents will complete; their results are preserved.`,
    );
    this.name = 'WorkflowBudgetExceededError';
  }
}

/**
 * Host-facing result of one `agent()` spawn. Carries the `WorkflowAgentResult`
 * the sandbox sees plus the subagent's `TokenUsage` so the runtime can feed
 * real token accounting into the `budget` global.
 */
export interface WorkflowAgentSpawnResult {
  readonly ok: boolean;
  readonly agentId: string;
  readonly output: unknown;
  readonly error?: string;
  readonly durationMs: number;
  readonly usage?: TokenUsage;
}

/** Options for constructing a `WorkflowRuntime`. */
export interface WorkflowRuntimeOptions {
  /** The workflow script source (compiled + validated at `run()`). */
  readonly source: string;
  /** Structured value exposed to the script as the `args` global. */
  readonly args?: unknown;
  /** Run-level abort signal threaded through every subagent spawn. */
  readonly signal?: AbortSignal;
  /** Token budget ceiling the `budget` global reports as `total`. */
  readonly tokenBudgetTotal: number;
  /**
   * Optional live budget source (REAL main-loop accounting). When provided it
   * overrides the default `budget` global: `total` and `spent()` come from the
   * host's `WorkflowBudget` (a `+500k`-style target and the agent's actual
   * consumption) instead of the static `tokenBudgetTotal` + subagent-only
   * counter.
   */
  readonly budget?: WorkflowBudget;
  /** Host spawn callback — creates/drives one real subagent. */
  readonly agentSpawn: (
    prompt: string,
    opts: WorkflowAgentOpts | undefined,
  ) => Promise<WorkflowAgentSpawnResult>;
  /** Fan-out scheduler behind `parallel()` / `pipeline()`. */
  readonly pool: AgentRunPool;
  /** Emitted on every `phase(title)` call (e.g. `workflow.phase_changed`). */
  readonly onPhaseChanged?: (title: string) => void;
  /** Emitted on every `log(...)` call with the stringified parts. */
  readonly onLog?: (parts: readonly unknown[]) => void;
  /**
   * Called with each subagent's `TokenUsage` so the host budget accounting can
   * fold subagent spend into its own `spent()` (the budget the script sees).
   */
  readonly onSubagentUsage?: (usage: TokenUsage) => void;
  /** Total agent budget ceiling; defaults to 1000. */
  readonly agentCap?: number;
  /**
   * Wall-clock bound (ms) for one `await`-free slice of script execution
   * (each synchronous stretch between awaits); defaults to 30s. Guards
   * against a script that pins the event loop (`while (true) {}`) without
   * bounding how long the workflow may await subagents overall.
   */
  readonly timeoutMs?: number;
}

/** The settled result of a workflow run. */
export interface WorkflowRunOutput {
  /** The value `main(...)` returned. */
  readonly result: unknown;
  /** The validated `meta` extracted from the script preamble. */
  readonly meta: WorkflowScriptMeta;
  /** How many agents the run spawned (cap-counted attempts). */
  readonly agentsSpawned: number;
  /** Tokens consumed by subagents, as reported through the spawn callback. */
  readonly tokensSpent: number;
}

/**
 * One-shot executor for a workflow script. Each instance is bound to the
 * source, spawn host and pool it was constructed with; `run()` creates a fresh
 * sandbox context, executes the script, awaits `main(...)`, and resolves with
 * the script's return value. `run()` may be called at most once per instance —
 * the caps and token counters are per-run state.
 */
export class WorkflowRuntime {
  private spentTokens = 0;
  private agentsSpawned = 0;
  private nestingDepth = 0;
  private readonly source: string;
  private readonly args: unknown;
  private readonly signal: AbortSignal | undefined;
  private readonly tokenBudgetTotal: number;
  private readonly externalBudget: WorkflowBudget | undefined;
  private readonly agentSpawn: WorkflowRuntimeOptions['agentSpawn'];
  private readonly pool: AgentRunPool;
  private readonly onPhaseChanged?: (title: string) => void;
  private readonly onLog?: (parts: readonly unknown[]) => void;
  private readonly onSubagentUsage?: (usage: TokenUsage) => void;
  private readonly agentCap: number;
  private readonly timeoutMs: number;

  constructor(options: WorkflowRuntimeOptions) {
    this.source = options.source;
    this.args = options.args;
    this.signal = options.signal;
    this.tokenBudgetTotal = options.tokenBudgetTotal;
    this.externalBudget = options.budget;
    this.agentSpawn = options.agentSpawn;
    this.pool = options.pool;
    this.onPhaseChanged = options.onPhaseChanged;
    this.onLog = options.onLog;
    this.onSubagentUsage = options.onSubagentUsage;
    this.agentCap = options.agentCap ?? WORKFLOW_DEFAULT_AGENT_CAP;
    this.timeoutMs = options.timeoutMs ?? WORKFLOW_DEFAULT_TIMEOUT_MS;
  }

  /**
   * Compile, sandbox and run the script. Compile failures throw
   * `WorkflowCompileError`; sandbox/DSL violations throw the documented
   * runtime errors; the script's own exceptions propagate as-is.
   */
  async run(): Promise<WorkflowRunOutput> {
    const compiled = compileWorkflowScript(this.source);
    if ('error' in compiled) throw compiled.error;
    const compiledSource = compiled.source;

    const wrapped = buildWrappedSource(compiledSource, compiled.ast);
    const context = this.createContext(compiled.meta);
    const script = new vm.Script(wrapped, { filename: WORKFLOW_SANDBOX_FILENAME });

    const result = await script.runInContext(context, {
      timeout: this.timeoutMs,
    });

    return {
      result,
      meta: compiled.meta,
      agentsSpawned: this.agentsSpawned,
      tokensSpent: this.spentTokens,
    };
  }

  private createContext(meta: WorkflowScriptMeta): vm.Context {
    const context: Record<string, unknown> = {};
    installWorkflowGlobals(context, this.buildGlobals(meta));
    const sandbox = vm.createContext(context, {
      codeGeneration: { strings: false, wasm: false },
    });
    // Defense in depth behind the compile-time determinism check: break
    // Date.now/Math.random/new Date() inside the sandbox so a static-analysis
    // bypass fails loudly instead of silently breaking resume caching.
    new vm.Script(WORKFLOW_SANDBOX_PRELUDE, { filename: 'workflow-prelude.js' }).runInContext(
      sandbox,
    );
    return sandbox;
  }

  private buildGlobals(_meta: WorkflowScriptMeta): WorkflowSandboxGlobals {
    const budget: WorkflowBudget =
      this.externalBudget ?? {
        total: this.tokenBudgetTotal,
        spent: () => this.spentTokens,
        remaining: () => Math.max(0, this.tokenBudgetTotal - this.spentTokens),
      };

    const agent: AgentFn = async (prompt, opts) => {
      this.signal?.throwIfAborted();
      if (this.agentsSpawned >= this.agentCap) {
        throw new WorkflowAgentCapExceededError(this.agentCap);
      }
      const budgetTotal = budget.total;
      if (budgetTotal > 0) {
        const spent = budget.spent();
        if (spent >= budgetTotal) {
          throw new WorkflowBudgetExceededError(spent, budgetTotal);
        }
      }
      this.agentsSpawned += 1;
      const outcome = await this.agentSpawn(prompt, opts);
      if (outcome.usage !== undefined) {
        this.spentTokens += grandTotal(outcome.usage);
        this.onSubagentUsage?.(outcome.usage);
      }
      const result: WorkflowAgentResult = {
        ok: outcome.ok,
        agentId: outcome.agentId,
        output: outcome.output,
        durationMs: outcome.durationMs,
        ...(outcome.error !== undefined ? { error: outcome.error } : {}),
      };
      return result;
    };

    const parallel: ParallelFn = async (items, fn, opts) => this.pool.parallel(items, fn, opts);

    const pipeline: PipelineFn = async <O>(
      stages: readonly WorkflowStageFn<unknown, unknown, O>[],
      opts?: WorkflowPipelineOpts,
    ): Promise<O | null> => (await this.pool.pipeline<O>(stages, opts)) as O | null;

    const phase: PhaseFn = (title) => {
      this.onPhaseChanged?.(title);
    };

    const log: LogFn = (...parts) => {
      this.onLog?.(parts);
    };

    const workflow: WorkflowFn = async (spec) => {
      if (this.nestingDepth >= 1) {
        throw new WorkflowNestingExceededError();
      }
      const body = typeof spec === 'function' ? spec : spec.fn;
      this.nestingDepth += 1;
      try {
        return await body();
      } finally {
        this.nestingDepth -= 1;
      }
    };

    return { agent, parallel, pipeline, phase, log, args: this.args, budget, workflow };
  }
}

/**
 * Build the source handed to `node:vm.Script`: strip the top-level `export`
 * keyword (the script is authored as an ES module but `vm.Script` runs in
 * script mode) and wrap it in an async IIFE that awaits the `main` entry point
 * with the `args` global.
 */
export function buildWrappedSource(source: string, ast: Program): string {
  const stripped = stripExports(source, ast);
  return `(async () => {\n'use strict';\n${stripped}\nreturn await main(args);\n})()\n`;
}

/**
 * Install the DSL globals onto a sandbox context non-enumerably. Every global
 * is a non-enumerable, non-configurable own property so `for...in` /
 * `Object.keys` over the sandbox's global object stays clean while bare
 * identifiers (`agent`, `args`, …) still resolve.
 */
export function installWorkflowGlobals(
  context: Record<string, unknown>,
  globals: WorkflowSandboxGlobals,
): void {
  for (const name of Object.keys(globals)) {
    Object.defineProperty(context, name, {
      value: globals[name as keyof WorkflowSandboxGlobals],
      enumerable: false,
      configurable: false,
      writable: true,
    });
  }
}

/**
 * Remove the `export ` keyword from every top-level export declaration so the
 * source becomes valid script-mode code. `export` is 6 characters; the single
 * separating space/tab is dropped too. Offsets come from the parsed AST, so
 * `export` inside strings/comments is never touched.
 */
export function stripExports(source: string, ast: Program): string {
  const exports = ast.body.filter(
    (node) => node.type === 'ExportNamedDeclaration' || node.type === 'ExportDefaultDeclaration',
  );
  let stripped = source;
  for (const node of exports.reverse() as readonly { readonly start: number }[]) {
    const start = node.start;
    const after = source[start + 'export'.length];
    const skip = after === ' ' || after === '\t' ? 1 : 0;
    stripped = stripped.slice(0, start) + stripped.slice(start + 'export'.length + skip);
  }
  return stripped;
}
