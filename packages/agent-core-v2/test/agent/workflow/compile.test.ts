/**
 * `workflow.compile` — unit tests for the script compiler facade.
 *
 * Covers: valid scripts compile and expose meta + phase titles; the pure
 * literal preamble is enforced; nondeterminism (Date.now / Math.random /
 * new Date()) and sandbox-escape (process / fs / require / import / globalThis)
 * are rejected; the size cap is enforced; and TypeScript annotations surface
 * as plain-JS parse failures.
 */

import { describe, expect, it } from 'vitest';

import { compileWorkflowScript } from '#/agent/workflow/compile/index';
import { WORKFLOW_SCRIPT_MAX_BYTES } from '#/agent/workflow/types';

const VALID_SCRIPT = `
export const meta = {
  name: 'Sample workflow',
  description: 'Runs a two-phase orchestration end to end.',
  phases: [
    { title: 'gather', detail: 'Collect inputs' },
    { title: 'apply' },
  ],
  whenToUse: 'Multi-step work with subagents.',
};

export async function main() {
  const first = await agent('Gather the inputs', { phase: 'gather', label: 'collector' });
  log('collected', first.output);
  phase('apply');
  const results = await parallel(['a', 'b'], async (item, index) => {
    return agent(\`process \${item} #\${index}\`, { phase: 'apply' });
  });
  const chained = await pipeline([
    (prev) => agent(\`stage one on \${prev ?? 'none'}\`),
    (prev) => agent(\`stage two on \${prev.agentId}\`),
  ]);
  return { first, results, chained };
}
`;

function metaOnly(meta: string): string {
  return `export const meta = ${meta};\n`;
}

describe('compileWorkflowScript', () => {
  it('compiles a valid script and exposes meta, phaseTitles and the AST', () => {
    const result = compileWorkflowScript(VALID_SCRIPT);
    expect('ast' in result).toBe(true);
    if (!('ast' in result)) return;

    expect(result.meta.name).toBe('Sample workflow');
    expect(result.meta.description).toBe('Runs a two-phase orchestration end to end.');
    expect(result.meta.whenToUse).toBe('Multi-step work with subagents.');
    expect(result.meta.phases).toEqual([
      { title: 'gather', detail: 'Collect inputs' },
      { title: 'apply' },
    ]);
    expect([...result.phaseTitles]).toEqual(['gather', 'apply']);
    expect(result.ast.type).toBe('Program');
    expect(result.source).toBe(VALID_SCRIPT);
  });

  it('rejects a meta that references a variable (not pure literal)', () => {
    const result = compileWorkflowScript(
      metaOnly(`{ name: SOME_CONST, description: 'x' }`),
    );
    expect('error' in result).toBe(true);
    if (!('error' in result)) return;
    expect(result.error.code).toBe('workflow.meta_not_pure_literal');
  });

  it('rejects a meta that uses a spread (not pure literal)', () => {
    const result = compileWorkflowScript(
      metaOnly(`{ name: 'a', description: 'b', ...EXTRA }`),
    );
    expect('error' in result).toBe(true);
    if (!('error' in result)) return;
    expect(result.error.code).toBe('workflow.meta_not_pure_literal');
  });

  it('rejects a meta that uses a template literal (not pure literal)', () => {
    const result = compileWorkflowScript(
      metaOnly(`{ name: 'a', description: 'b', phases: [{ title: \`hi\` }] }`),
    );
    expect('error' in result).toBe(true);
    if (!('error' in result)) return;
    expect(result.error.code).toBe('workflow.meta_not_pure_literal');
  });

  it('rejects a script whose first statement is not export const meta', () => {
    const result = compileWorkflowScript(`const x = 1;\nexport const meta = { name: 'a', description: 'b' };\n`);
    expect('error' in result).toBe(true);
    if (!('error' in result)) return;
    expect(result.error.code).toBe('workflow.meta_invalid');
  });

  it('rejects a meta missing the required description', () => {
    const result = compileWorkflowScript(metaOnly(`{ name: 'a' }`));
    expect('error' in result).toBe(true);
    if (!('error' in result)) return;
    expect(result.error.code).toBe('workflow.meta_invalid');
  });

  it.each(['Date.now()', 'Math.random()'])('rejects nondeterministic %s', (expression) => {
    const result = compileWorkflowScript(
      `${metaOnly(`{ name: 'a', description: 'b' }`)}export function main() { return ${expression}; }\n`,
    );
    expect('error' in result).toBe(true);
    if (!('error' in result)) return;
    expect(result.error.code).toBe('workflow.determinism_violation');
    expect(result.error.violations?.[0]?.kind).toBe(expression === 'Date.now()' ? 'Date.now' : 'Math.random');
  });

  it('rejects new Date() with no arguments', () => {
    const result = compileWorkflowScript(
      `${metaOnly(`{ name: 'a', description: 'b' }`)}export function main() { const t = new Date(); return t; }\n`,
    );
    expect('error' in result).toBe(true);
    if (!('error' in result)) return;
    expect(result.error.code).toBe('workflow.determinism_violation');
    expect(result.error.violations?.[0]?.kind).toBe('new Date');
  });

  it.each(['process.env', 'process.cwd()'])('rejects access to process via %s', (expression) => {
    const result = compileWorkflowScript(
      `${metaOnly(`{ name: 'a', description: 'b' }`)}export function main() { return ${expression}; }\n`,
    );
    expect('error' in result).toBe(true);
    if (!('error' in result)) return;
    expect(result.error.code).toBe('workflow.determinism_violation');
    expect(result.error.violations?.[0]?.kind).toBe('process');
  });

  it('rejects access to fs', () => {
    const result = compileWorkflowScript(
      `${metaOnly(`{ name: 'a', description: 'b' }`)}export function main() { return fs.readFileSync('/etc/passwd'); }\n`,
    );
    expect('error' in result).toBe(true);
    if (!('error' in result)) return;
    expect(result.error.code).toBe('workflow.determinism_violation');
    expect(result.error.violations?.[0]?.kind).toBe('fs');
  });

  it('rejects require() calls', () => {
    const result = compileWorkflowScript(
      `${metaOnly(`{ name: 'a', description: 'b' }`)}export function main() { return require('fs'); }\n`,
    );
    expect('error' in result).toBe(true);
    if (!('error' in result)) return;
    expect(result.error.code).toBe('workflow.determinism_violation');
    expect(result.error.violations?.[0]?.kind).toBe('require');
  });

  it('rejects dynamic import()', () => {
    const result = compileWorkflowScript(
      `${metaOnly(`{ name: 'a', description: 'b' }`)}export function main() { return import('fs'); }\n`,
    );
    expect('error' in result).toBe(true);
    if (!('error' in result)) return;
    expect(result.error.code).toBe('workflow.determinism_violation');
    expect(result.error.violations?.[0]?.kind).toBe('import');
  });

  it('rejects export * re-exports', () => {
    const result = compileWorkflowScript(
      `${metaOnly(`{ name: 'a', description: 'b' }`)}export * from 'fs';\n`,
    );
    expect('error' in result).toBe(true);
    if (!('error' in result)) return;
    expect(result.error.code).toBe('workflow.determinism_violation');
    expect(result.error.violations?.[0]?.kind).toBe('import');
  });

  it('rejects named re-exports from another module', () => {
    const result = compileWorkflowScript(
      `${metaOnly(`{ name: 'a', description: 'b' }`)}export { readFile } from 'fs';\n`,
    );
    expect('error' in result).toBe(true);
    if (!('error' in result)) return;
    expect(result.error.code).toBe('workflow.determinism_violation');
    expect(result.error.violations?.[0]?.kind).toBe('import');
  });

  it('rejects static import statements', () => {
    const result = compileWorkflowScript(
      `${metaOnly(`{ name: 'a', description: 'b' }`)}import fs from 'fs';\nexport function main() { return fs; }\n`,
    );
    expect('error' in result).toBe(true);
    if (!('error' in result)) return;
    expect(result.error.code).toBe('workflow.determinism_violation');
  });

  it('rejects access to globalThis', () => {
    const result = compileWorkflowScript(
      `${metaOnly(`{ name: 'a', description: 'b' }`)}export function main() { return globalThis.process; }\n`,
    );
    expect('error' in result).toBe(true);
    if (!('error' in result)) return;
    expect(result.error.code).toBe('workflow.determinism_violation');
    expect(result.error.violations?.[0]?.kind).toBe('globalThis');
  });

  it('does not flag an ordinary member property named like a host global', () => {
    const result = compileWorkflowScript(
      `${metaOnly(`{ name: 'a', description: 'b' }`)}export function main() { return obj.process; }\n`,
    );
    expect('ast' in result).toBe(true);
  });

  it('enforces the 512 KiB size cap', () => {
    const pad = '// padding\n'.repeat(Math.ceil(WORKFLOW_SCRIPT_MAX_BYTES / '// padding\n'.length) + 1);
    const oversized = `${metaOnly(`{ name: 'a', description: 'b' }`)}${pad}`;
    expect(Buffer.byteLength(oversized, 'utf8')).toBeGreaterThan(WORKFLOW_SCRIPT_MAX_BYTES);

    const result = compileWorkflowScript(oversized);
    expect('error' in result).toBe(true);
    if (!('error' in result)) return;
    expect(result.error.code).toBe('workflow.script_too_large');
  });

  it('rejects TypeScript annotations as non-plain-JS parse failures', () => {
    const result = compileWorkflowScript(
      `${metaOnly(`{ name: 'a', description: 'b' }`)}export function main(): number { return 1; }\n`,
    );
    expect('error' in result).toBe(true);
    if (!('error' in result)) return;
    expect(result.error.code).toBe('workflow.parse_failed');
  });

  it('rejects empty and non-JS source', () => {
    const empty = compileWorkflowScript('');
    expect('error' in empty).toBe(true);
    if (!('error' in empty)) return;
    expect(empty.error.code).toBe('workflow.meta_invalid');
  });
});
