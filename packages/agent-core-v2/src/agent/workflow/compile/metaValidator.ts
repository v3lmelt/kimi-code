/**
 * `workflow.compile` — meta validator.
 *
 * Enforces the script preamble contract: the FIRST statement must be
 * `export const meta = {...}` where the object is a pure literal — no
 * variable references, calls, spreads, computed keys, or template literals —
 * with `name` and `description` required. Extracts the `WorkflowScriptMeta`
 * and collects the declared phase-title set so the runtime can match
 * `phase()` calls against `meta.phases[].title`.
 */

import { type Node, type Program } from 'acorn';

import { WorkflowCompileError } from '#/agent/workflow/types';
import type { WorkflowPhaseMeta, WorkflowScriptMeta } from '#/agent/workflow/types';

/** Successful meta parse: the pure-literal meta plus the declared phase titles. */
export interface WorkflowMetaValidationResult {
  readonly meta: WorkflowScriptMeta;
  readonly phaseTitles: ReadonlySet<string>;
}

type AnyNode = Node & Record<string, unknown>;

/**
 * Validate that `ast.body[0]` is a pure-literal `export const meta = {...}`
 * and extract the meta. Throws `WorkflowCompileError` on any violation.
 */
export function validateWorkflowMeta(ast: Program): WorkflowMetaValidationResult {
  const first = ast.body[0];
  if (first === undefined) {
    throw new WorkflowCompileError({
      code: 'workflow.meta_invalid',
      message:
        'Workflow script must start with `export const meta = {name, description, phases?}`.',
      line: 1,
      column: 1,
    });
  }

  const objectExpr = metaObjectExpression(first as AnyNode);
  if (objectExpr === undefined) {
    throw new WorkflowCompileError({
      code: 'workflow.meta_invalid',
      message:
        'The first statement must be `export const meta = {...}` with a pure-literal object value.',
      line: lineOf(first),
      column: columnOf(first),
    });
  }

  assertPureLiteral(objectExpr);

  const raw = literalToValue(objectExpr);
  const meta = readMeta(raw);
  const phaseTitles = collectPhaseTitles(meta);
  return { meta, phaseTitles };
}

/** Returns the `ObjectExpression` behind `export const meta = {...}`, if any. */
function metaObjectExpression(statement: AnyNode): AnyNode | undefined {
  if (statement['type'] !== 'ExportNamedDeclaration') return undefined;
  const declaration = statement['declaration'] as AnyNode | undefined;
  if (declaration === undefined || declaration['type'] !== 'VariableDeclaration') return undefined;
  const declarations = declaration['declarations'] as readonly AnyNode[];
  if (declarations.length !== 1) return undefined;
  const declarator = declarations[0];
  if (declarator === undefined) return undefined;
  const id = declarator['id'] as AnyNode;
  if (id['type'] !== 'Identifier' || id['name'] !== 'meta') return undefined;
  const init = declarator['init'] as AnyNode | undefined;
  if (init === undefined || init['type'] !== 'ObjectExpression') return undefined;
  return init;
}

/**
 * Pure-literal check: literals, arrays of pure literals, and objects whose
 * properties are non-computed, keyed by an Identifier or a string Literal,
 * with pure-literal values. Spreads, computed keys, template literals,
 * identifiers-as-values, and method shorthand are all rejected.
 */
function assertPureLiteral(node: AnyNode): void {
  switch (node['type']) {
    case 'Literal':
      return;
    case 'ArrayExpression': {
      const elements = node['elements'] as readonly (AnyNode | null)[];
      elements.forEach((element, index) => {
        if (element === null || element['type'] === 'SpreadElement') {
          throw notPure(node, `meta array element ${index} is not a literal`);
        }
        assertPureLiteral(element);
      });
      return;
    }
    case 'ObjectExpression': {
      const properties = node['properties'] as readonly AnyNode[];
      properties.forEach((property) => {
        if (property['type'] !== 'Property') {
          throw notPure(property, 'meta object may not contain spread elements');
        }
        if (property['computed'] === true) {
          throw notPure(property, 'meta object keys must be literal (no computed keys)');
        }
        if (property['method'] === true) {
          throw notPure(property, 'meta object may not contain methods');
        }
        const key = property['key'] as AnyNode;
        const isStaticKey =
          (key['type'] === 'Identifier') ||
          (key['type'] === 'Literal' && typeof key['value'] === 'string');
        if (!isStaticKey) {
          throw notPure(key, 'meta object keys must be plain identifiers or string literals');
        }
        assertPureLiteral(property['value'] as AnyNode);
      });
      return;
    }
    case 'TemplateLiteral':
      throw notPure(node, 'meta must be a pure literal (no template literals)');
    default:
      throw notPure(
        node,
        `meta must be a pure literal; found a ${node['type']} (variables, calls, and spread are not allowed)`,
      );
  }
}

/** Convert an already-validated pure literal node to a plain JS value. */
function literalToValue(node: AnyNode): unknown {
  switch (node['type']) {
    case 'Literal':
      return node['value'];
    case 'ArrayExpression': {
      const elements = node['elements'] as readonly (AnyNode | null)[];
      return elements.map((element) => (element === null ? null : literalToValue(element)));
    }
    case 'ObjectExpression': {
      const out: Record<string, unknown> = {};
      const properties = node['properties'] as readonly AnyNode[];
      for (const property of properties) {
        const key = property['key'] as AnyNode;
        const name =
          key['type'] === 'Identifier' ? (key['name'] as string) : (key['value'] as string);
        out[name] = literalToValue(property['value'] as AnyNode);
      }
      return out;
    }
    default:
      // Unreachable: assertPureLiteral ran first.
      return undefined;
  }
}

function readMeta(raw: unknown): WorkflowScriptMeta {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new WorkflowCompileError({
      code: 'workflow.meta_invalid',
      message: '`meta` must be an object literal.',
    });
  }
  const record = raw as Record<string, unknown>;
  const name = readRequiredString(record, 'name');
  const description = readRequiredString(record, 'description');
  const phases = readPhases(record);
  const whenToUse = readOptionalString(record, 'whenToUse');
  const model = readOptionalString(record, 'model');

  return {
    name,
    description,
    ...(phases !== undefined ? { phases } : {}),
    ...(whenToUse !== undefined ? { whenToUse } : {}),
    ...(model !== undefined ? { model } : {}),
  };
}

function readRequiredString(record: Record<string, unknown>, key: string): string {
  const value = record[key];
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new WorkflowCompileError({
      code: 'workflow.meta_invalid',
      message: `\`meta.${key}\` is required and must be a non-empty string.`,
    });
  }
  return value;
}

function readOptionalString(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  if (value === undefined) return undefined;
  if (typeof value !== 'string') {
    throw new WorkflowCompileError({
      code: 'workflow.meta_invalid',
      message: `\`meta.${key}\` must be a string when present.`,
    });
  }
  return value;
}

function readPhases(record: Record<string, unknown>): readonly WorkflowPhaseMeta[] | undefined {
  const value = record['phases'];
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) {
    throw new WorkflowCompileError({
      code: 'workflow.meta_invalid',
      message: '`meta.phases` must be an array of `{title, detail?}` objects when present.',
    });
  }
  return value.map((entry, index) => {
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
      throw new WorkflowCompileError({
        code: 'workflow.meta_invalid',
        message: `\`meta.phases[${index}]\` must be an object with a \`title\`.`,
      });
    }
    const phase = entry as Record<string, unknown>;
    const title = phase['title'];
    if (typeof title !== 'string' || title.trim().length === 0) {
      throw new WorkflowCompileError({
        code: 'workflow.meta_invalid',
        message: `\`meta.phases[${index}].title\` is required and must be a non-empty string.`,
      });
    }
    const detail = phase['detail'];
    if (detail !== undefined && typeof detail !== 'string') {
      throw new WorkflowCompileError({
        code: 'workflow.meta_invalid',
        message: `\`meta.phases[${index}].detail\` must be a string when present.`,
      });
    }
    const out: WorkflowPhaseMeta = detail !== undefined ? { title, detail } : { title };
    return out;
  });
}

function collectPhaseTitles(meta: WorkflowScriptMeta): ReadonlySet<string> {
  const titles = new Set<string>();
  for (const phase of meta.phases ?? []) {
    titles.add(phase.title);
  }
  return titles;
}

function notPure(node: AnyNode, message: string): WorkflowCompileError {
  return new WorkflowCompileError({
    code: 'workflow.meta_not_pure_literal',
    message,
    line: lineOf(node),
    column: columnOf(node),
  });
}

function lineOf(node: Node): number | undefined {
  return node.loc?.start.line;
}

function columnOf(node: Node): number | undefined {
  return node.loc?.start.column;
}
