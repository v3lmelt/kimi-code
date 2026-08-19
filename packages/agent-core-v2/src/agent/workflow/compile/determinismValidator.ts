/**
 * `workflow.compile` — determinism / sandbox-contract validator.
 *
 * Walks the parsed AST statically and reports every construct that would make
 * a workflow script non-deterministic or escape the `node:vm` sandbox:
 *
 * - `Date.now()` and `Math.random()` member accesses;
 * - zero-argument `new Date()`;
 * - `require(...)` calls and dynamic `import(...)` / static `import ... from`;
 * - access to the forbidden host globals `process`, `fs`, `globalThis`.
 *
 * Returns a list of violations (empty when the script is clean). The facade
 * turns a non-empty list into a `workflow.determinism_violation` compile
 * error.
 */

import { type Node, type Program } from 'acorn';

import type { WorkflowDeterminismViolation } from '#/agent/workflow/types';

type AnyNode = Node & Record<string, unknown>;

/** Host globals that must never be reachable from inside the sandbox. */
const FORBIDDEN_GLOBALS = new Set(['process', 'fs', 'globalThis']);

/** Collect every determinism / sandbox-contract violation in the script. */
export function detectWorkflowViolations(ast: Program): readonly WorkflowDeterminismViolation[] {
  const violations: WorkflowDeterminismViolation[] = [];
  traverse(ast, undefined, undefined, (node, parent, key) => {
    check(node, parent, key, violations);
  });
  return violations;
}

function check(
  node: AnyNode,
  parent: AnyNode | undefined,
  key: string | undefined,
  violations: WorkflowDeterminismViolation[],
): void {
  switch (node['type']) {
    case 'MemberExpression': {
      const object = node['object'] as AnyNode;
      const property = node['property'] as AnyNode;
      const computed = node['computed'] === true;

      if (!computed && property['type'] === 'Identifier') {
        const propertyName = property['name'];
        if (object['type'] === 'Identifier' && object['name'] === 'Date' && propertyName === 'now') {
          push(violations, node, 'Date.now', 'Date.now() is non-deterministic.');
          return;
        }
        if (
          object['type'] === 'Identifier' &&
          object['name'] === 'Math' &&
          propertyName === 'random'
        ) {
          push(violations, node, 'Math.random', 'Math.random() is non-deterministic.');
          return;
        }
        if (object['type'] === 'Identifier' && FORBIDDEN_GLOBALS.has(object['name'] as string)) {
          push(
            violations,
            node,
            forbiddenKind(object['name'] as string),
            `Access to host global \`${String(object['name'])}\` is not allowed inside a workflow script.`,
          );
        }
      }
      return;
    }

    case 'NewExpression': {
      const callee = node['callee'] as AnyNode;
      const arguments_ = node['arguments'] as readonly AnyNode[];
      if (callee['type'] === 'Identifier' && callee['name'] === 'Date' && arguments_.length === 0) {
        push(violations, node, 'new Date', 'new Date() is non-deterministic.');
      }
      return;
    }

    case 'CallExpression': {
      const callee = node['callee'] as AnyNode;
      if (callee['type'] === 'Identifier' && callee['name'] === 'require') {
        push(violations, node, 'require', 'require() is not available inside a workflow script.');
      }
      return;
    }

    case 'ImportExpression':
      push(violations, node, 'import', 'Dynamic import() is not available inside a workflow script.');
      return;

    case 'ImportDeclaration':
      push(violations, node, 'import', 'import statements are not available inside a workflow script.');
      return;

    case 'ExportAllDeclaration':
      push(violations, node, 'import', 'Exporting from another module is not allowed in a workflow script.');
      return;

    case 'ExportNamedDeclaration':
      if (node['source'] !== null && node['source'] !== undefined) {
        push(
          violations,
          node,
          'import',
          'Exporting from another module is not allowed in a workflow script.',
        );
      }
      return;

    case 'Identifier': {
      // Bare references to host globals outside of binding positions.
      if (parent !== undefined && isBindingPosition(node, parent, key)) return;
      const name = node['name'] as string;
      if (FORBIDDEN_GLOBALS.has(name)) {
        push(
          violations,
          node,
          forbiddenKind(name),
          `Access to host global \`${name}\` is not allowed inside a workflow script.`,
        );
      }
      return;
    }

    default:
      return;
  }
}

/** True when `node` sits in a declaration/binding position and is not a read. */
function isBindingPosition(
  node: AnyNode,
  parent: AnyNode,
  key: string | undefined,
): boolean {
  if (key === undefined) return false;
  switch (parent['type']) {
    case 'VariableDeclarator':
      return key === 'id';
    case 'FunctionDeclaration':
    case 'FunctionExpression':
    case 'ArrowFunctionExpression':
      return key === 'id' || key === 'params';
    case 'Property':
      // A non-shorthand key (`{ a: process }`) is a name, not a reference; a
      // shorthand value (`{ process }`) IS a reference and stays flagged.
      return key === 'key' && parent['shorthand'] !== true;
    case 'MethodDefinition':
      return key === 'key';
    case 'MemberExpression':
      return key === 'property' && parent['computed'] !== true;
    case 'CatchClause':
      return key === 'param';
    case 'ClassDeclaration':
    case 'ClassExpression':
      return key === 'id';
    case 'ImportSpecifier':
    case 'ImportDefaultSpecifier':
    case 'ImportNamespaceSpecifier':
      return key === 'local';
    case 'ExportSpecifier':
      return key === 'local';
    case 'AssignmentPattern':
      return key === 'left';
    case 'RestElement':
      return key === 'argument';
    case 'AssignmentExpression':
      return key === 'left';
    default:
      return false;
  }
}

function forbiddenKind(name: string): WorkflowDeterminismViolation['kind'] {
  // FORBIDDEN_GLOBALS is exactly the kind-union subset that maps 1:1.
  return name as WorkflowDeterminismViolation['kind'];
}

function push(
  violations: WorkflowDeterminismViolation[],
  node: AnyNode,
  kind: WorkflowDeterminismViolation['kind'],
  message: string,
): void {
  violations.push({
    kind,
    message,
    line: node.loc?.start.line ?? 0,
    column: node.loc?.start.column ?? 0,
  });
}

/**
 * Generic ESTree walker. Visits every AST node with its parent and the key it
 * was reached under, so position-sensitive checks (binding positions, member
 * properties) can be resolved. Acorn ASTs are acyclic, so a simple recursive
 * walk is safe.
 */
function traverse(
  value: unknown,
  parent: AnyNode | undefined,
  key: string | undefined,
  visit: (node: AnyNode, parent: AnyNode | undefined, key: string | undefined) => void,
): void {
  if (value === null || typeof value !== 'object') return;
  if (Array.isArray(value)) {
    for (const item of value) {
      traverse(item, parent, key, visit);
    }
    return;
  }
  const node = value as AnyNode;
  if (typeof node['type'] === 'string') {
    visit(node, parent, key);
  }
  for (const [childKey, childValue] of Object.entries(node)) {
    if (childKey === 'start' || childKey === 'end' || childKey === 'loc' || childKey === 'range') {
      continue;
    }
    if (childValue !== null && typeof childValue === 'object') {
      traverse(childValue, node, childKey, visit);
    }
  }
}
