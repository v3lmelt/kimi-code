/**
 * `workflow.compile` — facade.
 *
 * `compileWorkflowScript(source)` is the single entry point of the workflow
 * script compiler: parse (size cap + plain-JS check), validate the pure
 * `meta` preamble, and scan for determinism / sandbox-contract violations.
 * It never throws for script-authored problems — it returns either a
 * successful compile (`{ ast, meta, phaseTitles }`) or a `{ error }` with a
 * stable `WorkflowCompileError`.
 *
 * The returned `phaseTitles` set lets the runtime executor match `phase()`
 * calls against `meta.phases[].title`; `ast` lets callers inspect the
 * validated program (e.g. to locate `main` or strip `export` before
 * `node:vm` compilation).
 */

import { type Program } from 'acorn';

import type { WorkflowScriptMeta } from '#/agent/workflow/types';
import { WorkflowCompileError } from '#/agent/workflow/types';

import { detectWorkflowViolations } from './determinismValidator';
import { validateWorkflowMeta } from './metaValidator';
import { parseWorkflowScript } from './scriptParser';

export {
  assertWorkflowGraphCompileError,
  compileWorkflowAuthoring,
  compileWorkflowDag,
  compileWorkflowGraph,
  compileWorkflowGraphResult,
  type CompiledWorkflowGraph,
  type WorkflowAuthoringCompileResult,
  type WorkflowAuthoringCompileSuccess,
  type WorkflowGraphCompileOptions,
} from './graphCompiler';

/** A successful compile: the validated AST, meta, and declared phase titles. */
export interface WorkflowCompileSuccess {
  readonly source: string;
  readonly ast: Program;
  readonly meta: WorkflowScriptMeta;
  readonly phaseTitles: ReadonlySet<string>;
}

/** A rejected compile, with the stable failure reason. */
export interface WorkflowCompileFailure {
  readonly error: WorkflowCompileError;
}

export type WorkflowCompileResult = WorkflowCompileSuccess | WorkflowCompileFailure;

/**
 * Compile a workflow script. Returns a discriminated result; for a clean
 * script the `ast` discriminator is present, otherwise `error`.
 */
export function compileWorkflowScript(source: string): WorkflowCompileResult {
  try {
    const { ast } = parseWorkflowScript(source);

    const { meta, phaseTitles } = validateWorkflowMeta(ast);

    const violations = detectWorkflowViolations(ast);
    if (violations.length > 0) {
      return {
        error: new WorkflowCompileError({
          code: 'workflow.determinism_violation',
          message:
            `Script violates the determinism / sandbox contract ` +
            `(${violations.length} violation${violations.length === 1 ? '' : 's'}).`,
          violations,
        }),
      };
    }

    return { source, ast, meta, phaseTitles };
  } catch (error) {
    if (error instanceof WorkflowCompileError) {
      return { error };
    }
    throw error;
  }
}
