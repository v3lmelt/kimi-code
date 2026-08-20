/**
 * `workflow` domain — shared types and the DSL global surface for the
 * Workflow orchestration engine.
 *
 * The Workflow engine is a Claude-style orchestration runtime: the model
 * authors a plain-JS script against a small deterministic DSL
 * (`meta` + `agent`/`parallel`/`pipeline`/`phase`/`log`/`args`/`budget`/
 * `workflow`), and the runtime executes it inside a `node:vm` sandbox,
 * fanning out real subagents through the existing swarm / Agent machinery.
 *
 * This module is the single source of truth for the contracts every other
 * workflow component implements against:
 *
 * - the LLM-facing Workflow tool input (`WorkflowToolInputSchema`);
 * - run identity, persistence metadata and progress events (`WorkflowRunId`,
 *   `WorkflowRunMeta`, `WorkflowProgressEvent`);
 * - the subagent options and the result contract (`WorkflowAgentOpts`,
 *   `WorkflowAgentResult`, parallel/pipeline semantics);
 * - the token-budget surface (`WorkflowBudget`);
 * - the DSL globals injected into the sandbox (`AgentFn`, `ParallelFn`,
 *   `PipelineFn`, `PhaseFn`, `LogFn`, `WorkflowFn`, `WorkflowSandboxGlobals`);
 * - the script-compile failure contract (`WorkflowCompileError`,
 *   `WorkflowCompileErrorCode`, `WorkflowDeterminismViolation`).
 *
 * Keep this module free of workflow *runtime* imports (it must stay
 * importable from both the sandbox-facing side and the host side); only
 * `zod` and pure type/const declarations live here.
 */

import { z } from 'zod';

/** Upper bound (bytes) for a workflow script source. Enforced at compile time. */
export const WORKFLOW_SCRIPT_MAX_BYTES = 512 * 1024;

/** A workflow run identifier. Always carries the `wf_` prefix. */
export type WorkflowRunId = `wf_${string}`;

/**
 * LLM-facing input of the `Workflow` tool (the Agent-scoped tool the model
 * uses to author and run a workflow). The tool returns immediately with
 * `{ task_id, run_id }` and runs the script in the background.
 *
 * `script` is the inline source. `scriptPath` is an alternative source the
 * tool may read from disk instead; `args` is the structured value exposed to
 * the script as the `args` global; `resumeFromRunId` replays a prior run's
 * journal and skips agents that already completed.
 */
export const WorkflowToolInputSchema = z
  .object({
    script: z
      .string()
      .min(1)
      .optional()
      .describe(
        'Inline plain-JS workflow script. Must start with `export const meta = {name, description, phases?}` ' +
          'as a pure literal, declare an entry point as `export async function main(...)`, and use only the ' +
          'injected globals agent/parallel/pipeline/phase/log/args/budget/workflow. The script must be ' +
          'deterministic: no Date.now/Math.random/new Date(), no require/import/process/fs/globalThis. ' +
          'Provide exactly one of `script` and `scriptPath`.',
      ),
    args: z
      .unknown()
      .optional()
      .describe('Structured arguments exposed to the script as the `args` global.'),
    scriptPath: z
      .string()
      .min(1)
      .optional()
      .describe(
        'Path to a script file under the session directory to load instead of the inline `script`. The path ' +
          'is normalized and cannot escape the session directory. Every invocation also persists the script ' +
          'under the session directory; edit that file and re-invoke with the same `scriptPath` to iterate ' +
          'without resending the full script. Provide exactly one of `script` and `scriptPath`.',
      ),
    resumeFromRunId: z
      .string()
      .regex(/^wf_/)
      .optional()
      .describe(
        'Workflow run ID to resume. Completed agent() calls with unchanged (prompt, opts) return cached ' +
          'results instantly; only edited or new calls re-run. The script may differ from the prior run — ' +
          'replay is keyed per agent() call, not per script.',
      ),
  })
  .strict()
  .superRefine((value, context) => {
    const hasScript = value.script !== undefined && value.script.trim().length > 0;
    const hasScriptPath = value.scriptPath !== undefined && value.scriptPath.trim().length > 0;
    if (hasScript === hasScriptPath) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Provide exactly one of `script` and `scriptPath`.',
        path: ['script'],
      });
    }
  });

export type WorkflowToolInput = z.infer<typeof WorkflowToolInputSchema>;

/**
 * Isolation requested for the subagents a workflow spawns.
 *
 * - `worktree`: requested worktree isolation; the current workflow host
 *   rejects this value because worktree creation is not implemented.
 * - `session`: subagents share the parent agent's session state.
 * - `none`: no isolation guarantee.
 */
export type WorkflowIsolation = 'worktree' | 'session' | 'none';

/** One declared phase of a workflow script's `meta`. */
export interface WorkflowPhaseMeta {
  readonly title: string;
  readonly detail?: string;
}

/**
 * The pure-literal `meta` object every workflow script must export first.
 * `name` and `description` are required; `phases` is the ordered list of
 * phases whose titles the compiler collects (see
 * `compile/index.ts` → `phaseTitles`) so runtime `phase()` calls can be
 * matched against declared phases.
 */
export interface WorkflowScriptMeta {
  readonly name: string;
  readonly description: string;
  readonly phases?: readonly WorkflowPhaseMeta[];
  readonly whenToUse?: string;
  readonly model?: string;
}

/** Lifecycle status of a workflow run. */
export type WorkflowRunStatus = 'running' | 'completed' | 'failed' | 'aborted';

/**
 * Persisted metadata for a workflow run, written to the run journal
 * (`<sessionDir>/workflows/<runId>/`). `scriptSha256` keys resume lookup.
 */
export interface WorkflowRunMeta {
  readonly runId: WorkflowRunId;
  readonly scriptSha256: string;
  readonly script: string;
  readonly name: string;
  readonly description: string;
  readonly phases?: readonly WorkflowPhaseMeta[];
  readonly args?: unknown;
  readonly status: WorkflowRunStatus;
  readonly createdAt: string;
  readonly updatedAt: string;
}

/**
 * Progress events a workflow run emits (via `wire` Ops and the run journal).
 * The `type` discriminates with the wire-event naming; the short forms are
 * `started`, `phase_changed`, `agent_spawned`, `agent_completed`, `completed`.
 */
export type WorkflowProgressEvent =
  | {
      readonly type: 'workflow.started';
      readonly runId: WorkflowRunId;
      readonly meta: WorkflowScriptMeta;
      readonly startedAt: string;
    }
  | {
      readonly type: 'workflow.phase_changed';
      readonly runId: WorkflowRunId;
      readonly phase: string;
    }
  | {
      readonly type: 'workflow.agent_spawned';
      readonly runId: WorkflowRunId;
      readonly agentId: string;
      readonly label?: string;
      readonly phase?: string;
    }
  | {
      readonly type: 'workflow.agent_completed';
      readonly runId: WorkflowRunId;
      readonly agentId: string;
      readonly ok: boolean;
      readonly durationMs: number;
      /** Display model of the subagent, when the spawn host reported one. */
      readonly model?: string;
      /** Total tokens the subagent consumed, when usage was reported. */
      readonly tokens?: number;
      /** One-line preview of the agent's output (whitespace-collapsed). */
      readonly summary?: string;
    }
  | {
      readonly type: 'workflow.log';
      readonly runId: WorkflowRunId;
      readonly message: string;
    }
  | {
      readonly type: 'workflow.completed';
      readonly runId: WorkflowRunId;
      readonly ok: boolean;
      readonly result?: unknown;
      readonly error?: string;
      /** Run totals for the terminal summary line. */
      readonly agentsSpawned?: number;
      readonly tokensSpent?: number;
      readonly durationMs?: number;
    };

/**
 * Structured-output schema accepted by `agent({ schema })` and threaded into
 * the subagent as a mandatory single-call `StructuredOutput` tool. It is a
 * JSON-schema-shaped plain object (the sandbox model passes data, not zod
 * instances).
 */
export type WorkflowSchema = Record<string, unknown>;

/**
 * Options for a single `agent()` spawn. All fields are optional; the runtime
 * derives sensible defaults.
 *
 * - `label`: human-readable name shown in progress/UI (`workflow.agent_spawned`).
 * - `phase`: the workflow phase this agent belongs to; it must match a
 *   declared `meta.phases[].title`.
 * - `schema`: structured-output schema; enables `requiresStructuredOutput`
 *   on the subagent (single mandatory call, retry cap, terminal typed failure).
 * - `model`: model alias override for this subagent.
 * - `effort`: thinking-effort level for this subagent; forwarded to the
 *   subagent binding.
 * - `isolation`: `'session' | 'none'` are supported by the current same-session
 *   runtime. `'worktree'` is rejected explicitly because worktree creation is
 *   not implemented.
 * - `agentType`: subagent type (e.g. `coder`, `readonly`); defaults to the
 *   parent's type when omitted.
 */
export interface WorkflowAgentOpts {
  readonly label?: string;
  readonly phase?: string;
  readonly schema?: WorkflowSchema;
  readonly model?: string;
  readonly effort?: string;
  readonly isolation?: WorkflowIsolation;
  readonly agentType?: string;
}

/**
 * Result of one `agent()` spawn. The `output` field is the agent's final
 * text output, or its validated structured output when `schema` was given —
 * and is `null` whenever the agent was skipped (e.g. resume) or ended in a
 * terminal error (`ok === false`). Callers must treat `output === null` as
 * "no usable result", never as an empty-but-valid answer.
 */
export interface WorkflowAgentResult<T = unknown> {
  readonly ok: boolean;
  readonly agentId: string;
  readonly output: T | null;
  readonly error?: string;
  readonly durationMs: number;
}

/** Shared fan-out options for `parallel()` / `pipeline()`. */
export interface WorkflowFanOutOpts {
  /** Progress label for the fan-out (broadcast on `phase_changed`). */
  readonly phase?: string;
  /**
   * Cap on how many subagents run concurrently. The runtime clamps this to
   * `min(16, max(2, cores - 2))`.
   */
  readonly maxConcurrency?: number;
}

/**
 * One stage of a `pipeline()`. Stages run strictly sequentially — no barrier —
 * and the output of stage `i` is passed to stage `i + 1` as `prevResult`.
 * `originalItem` is the pipeline's input (or the matching element when
 * `opts.items` is given); `index` is the 0-based stage ordinal.
 *
 * Semantics: a stage that throws aborts the chain and the pipeline resolves
 * to `null` (per-item null-on-throw).
 */
export interface WorkflowStageFn<Prev = unknown, Item = unknown, Out = unknown> {
  (prevResult: Prev, originalItem: Item, index: number): Promise<Out> | Out;
}

/** Options for `pipeline()`. */
export interface WorkflowPipelineOpts extends WorkflowFanOutOpts {
  /** Seed value for the first stage's `prevResult`. */
  readonly input?: unknown;
  /** When given, the stage chain runs once per item with `originalItem` set. */
  readonly items?: readonly unknown[];
}

/** Nested-workflow call. `workflow()` may be passed a body function directly. */
export interface WorkflowFnCall {
  /** Sub-budget (tokens) scoped to the nested workflow. */
  readonly budget?: number;
  readonly isolation?: WorkflowIsolation;
  readonly fn: WorkflowFnBody;
}

/** Body of a nested `workflow()` — runs inside the same sandbox. */
export type WorkflowFnBody = () => unknown;

/**
 * The token budget the sandbox exposes as the `budget` global. `total` is fed
 * by real main-loop token accounting (input + output tokens across the run),
 * `spent()` returns tokens consumed so far, and `remaining()` is
 * `max(0, total - spent())`.
 */
export interface WorkflowBudget {
  readonly total: number;
  spent(): number;
  remaining(): number;
}

/**
 * DSL: `agent(prompt, opts?)` — spawn one subagent and await its result.
 * The result's `output` is `null` when the agent was skipped or errored.
 */
export type AgentFn = (
  prompt: string,
  opts?: WorkflowAgentOpts,
) => Promise<WorkflowAgentResult>;

/**
 * DSL: `parallel(items, fn, opts?)` — fan `fn` out over `items` concurrently
 * with a barrier: resolves only when every item has settled, preserving input
 * order. A per-item throw yields `null` for that element (callers distinguish
 * "no result" from a value via the element being `null`).
 */
export type ParallelFn = <I, O>(
  items: readonly I[],
  fn: (item: I, index: number) => Promise<O> | O,
  opts?: WorkflowFanOutOpts,
) => Promise<readonly (O | null)[]>;

/**
 * DSL: `pipeline(stages, opts?)` — run a linear chain of stages with no
 * barrier; each stage's output feeds the next as `prevResult`. A throwing
 * stage aborts the chain and the pipeline resolves to `null`.
 */
export type PipelineFn = <O>(
  stages: readonly WorkflowStageFn<unknown, unknown, O>[],
  opts?: WorkflowPipelineOpts,
) => Promise<O | null>;

/**
 * DSL: `phase(title)` — emit a `workflow.phase_changed` progress event.
 * Titles are matched against `meta.phases[].title` when declared.
 */
export type PhaseFn = (title: string) => void;

/**
 * DSL: `log(...parts)` — append a line to the run journal (and mirror to the
 * session log). Values are stringified.
 */
export type LogFn = (...parts: readonly unknown[]) => void;

/**
 * DSL: `workflow(fn | {fn, budget?, isolation?})` — run a nested workflow body
 * inside the same sandbox, with an optional scoped sub-budget. Nesting is
 * limited to one level by the runtime.
 */
export type WorkflowFn = (spec: WorkflowFnBody | WorkflowFnCall) => Promise<unknown>;

/**
 * The full set of globals the runtime defines on the sandbox context for a
 * workflow script. Globals are installed non-enumerably via
 * `Object.defineProperty` so `for...in` over globalThis stays clean.
 */
export interface WorkflowSandboxGlobals {
  readonly agent: AgentFn;
  readonly parallel: ParallelFn;
  readonly pipeline: PipelineFn;
  readonly phase: PhaseFn;
  readonly log: LogFn;
  readonly args: unknown;
  readonly budget: WorkflowBudget;
  readonly workflow: WorkflowFn;
}

/** Why a workflow script failed to compile. */
export type WorkflowCompileErrorCode =
  | 'workflow.script_too_large'
  | 'workflow.parse_failed'
  | 'workflow.meta_invalid'
  | 'workflow.meta_not_pure_literal'
  | 'workflow.determinism_violation';

/** A single determinism/sandbox-contract violation found by the compiler. */
export interface WorkflowDeterminismViolation {
  readonly kind:
    | 'Date.now'
    | 'Math.random'
    | 'new Date'
    | 'require'
    | 'import'
    | 'process'
    | 'fs'
    | 'globalThis';
  readonly message: string;
  readonly line: number;
  readonly column: number;
}

/**
 * Compile failure thrown by the script compiler and returned (as `{error}`)
 * by the `compileWorkflowScript` facade. Carries a stable `code`, an optional
 * source position, and — for determinism rejections — the full violation list.
 */
export class WorkflowCompileError extends Error {
  readonly code: WorkflowCompileErrorCode;
  readonly line?: number;
  readonly column?: number;
  readonly violations?: readonly WorkflowDeterminismViolation[];

  constructor(opts: {
    readonly code: WorkflowCompileErrorCode;
    readonly message: string;
    readonly line?: number;
    readonly column?: number;
    readonly violations?: readonly WorkflowDeterminismViolation[];
  }) {
    super(opts.message);
    this.name = 'WorkflowCompileError';
    this.code = opts.code;
    this.line = opts.line;
    this.column = opts.column;
    this.violations = opts.violations;
  }
}
