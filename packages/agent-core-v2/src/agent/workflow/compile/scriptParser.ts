/**
 * `workflow.compile` — script parser: acorn front-end for the workflow
 * compiler.
 *
 * Enforces the source-size cap, rejects anything that is not plain JS
 * (TypeScript annotations and other supersets surface as acorn parse errors),
 * and returns the ESTree AST. Parsed as an ES module (`sourceType: 'module'`)
 * because every script begins with `export const meta = {...}` and must
 * declare `export async function main(...)`; the runtime executor strips the
 * top-level `export` keyword before compiling with `node:vm.Script`.
 */

import { parse, type Program } from 'acorn';

import { WORKFLOW_SCRIPT_MAX_BYTES, WorkflowCompileError } from '#/agent/workflow/types';

/** Successful parse: the original source plus the ESTree `Program` AST. */
export interface WorkflowParseResult {
  readonly source: string;
  readonly ast: Program;
}

/** Parse a workflow script, enforcing the size cap. Throws on any failure. */
export function parseWorkflowScript(source: string): WorkflowParseResult {
  const bytes = Buffer.byteLength(source, 'utf8');
  if (bytes > WORKFLOW_SCRIPT_MAX_BYTES) {
    throw new WorkflowCompileError({
      code: 'workflow.script_too_large',
      message:
        `Workflow script is ${bytes} bytes; the limit is ` +
        `${WORKFLOW_SCRIPT_MAX_BYTES} bytes (${WORKFLOW_SCRIPT_MAX_BYTES / 1024} KiB).`,
    });
  }

  let ast: Program;
  try {
    ast = parse(source, {
      ecmaVersion: 'latest',
      sourceType: 'module',
      locations: true,
    });
  } catch (error) {
    // acorn throws SyntaxError with `.loc` and a `(line:column)` suffix in the
    // message; normalise both non-syntax and syntax failures into a single
    // stable compile error.
    const loc = isAcornSyntaxError(error) ? error.loc : undefined;
    throw new WorkflowCompileError({
      code: 'workflow.parse_failed',
      message: `Workflow script is not valid plain JavaScript: ${messageOf(error)}`,
      line: loc?.line,
      column: loc?.column,
    });
  }

  return { source, ast };
}

interface AcornSyntaxError extends SyntaxError {
  readonly loc?: { readonly line: number; readonly column: number };
}

function isAcornSyntaxError(error: unknown): error is AcornSyntaxError {
  return error instanceof SyntaxError;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
