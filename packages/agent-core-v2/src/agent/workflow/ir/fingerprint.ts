/**
 * `workflow.ir` domain — computes stable execution fingerprints and marks
 * environment-dependent inputs that must never produce cross-environment hits.
 */

import { createHash } from 'node:crypto';

import type {
  WorkflowExecutionFingerprint,
  WorkflowFingerprintInputs,
  WorkflowGraph,
  WorkflowNode,
} from '#/agent/workflow/types';

export const WORKFLOW_UNKNOWN_MARKER = '__workflow_unknown__' as const;

export interface WorkflowFingerprintContext {
  readonly graphVersion?: string;
  readonly resolvedModel?: unknown;
  readonly effort?: unknown;
  readonly profile?: unknown;
  readonly tool?: unknown;
  readonly permission?: unknown;
  readonly toolset?: unknown;
  readonly cwd?: unknown;
  readonly workspaceRevision?: unknown;
  readonly environment?: unknown;
}

export function computeWorkflowFingerprint(
  graph: WorkflowGraph,
  node: WorkflowNode,
  context: WorkflowFingerprintContext = {},
): WorkflowExecutionFingerprint {
  const graphVersion = graph.version;
  const inputs: WorkflowFingerprintInputs = {
    graphVersion,
    nodeSpec: fingerprintNodeSpec(node),
    prompt: 'prompt' in node ? node.prompt : null,
    schema: 'schema' in node ? node.schema : null,
    resolvedModel: contextValue(context, 'resolvedModel'),
    effort: contextValue(context, 'effort'),
    profile: contextValue(context, 'profile'),
    tool: contextValue(context, 'tool'),
    permission: contextValue(context, 'permission'),
    toolset: context.toolset !== undefined || hasOwn(context, 'toolset')
      ? context.toolset
      : contextValue(context, 'tool'),
    cwd: contextValue(context, 'cwd'),
    workspaceRevision: contextValue(context, 'workspaceRevision'),
    ...(context.environment === undefined ? {} : { environment: context.environment }),
  };
  const unknownInputs = findUnknownInputs(inputs);
  const canonical = canonicalJson(inputs);
  const value = `wf-fp-v1:${createHash('sha256').update(canonical, 'utf8').digest('hex')}`;
  return { value, inputs, cacheable: unknownInputs.length === 0, unknownInputs };
}

function contextValue(
  context: WorkflowFingerprintContext,
  key: 'resolvedModel' | 'effort' | 'profile' | 'tool' | 'permission' | 'cwd' | 'workspaceRevision',
): unknown {
  return hasOwn(context, key) ? context[key] : WORKFLOW_UNKNOWN_MARKER;
}

function hasOwn(value: object, key: PropertyKey): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function fingerprintNodeSpec(node: WorkflowNode): unknown {
  const spec = { ...node } as Record<string, unknown>;
  delete spec['fingerprint'];
  delete spec['provenance'];
  return spec;
}

export const workflowExecutionFingerprint = computeWorkflowFingerprint;

export function fingerprintForNode(
  graph: WorkflowGraph,
  node: WorkflowNode,
  context?: WorkflowFingerprintContext,
): string {
  return computeWorkflowFingerprint(graph, node, context).value;
}

export function canonicalWorkflowJson(value: unknown): string {
  return canonicalJson(value);
}

function findUnknownInputs(value: unknown, path = '', out: string[] = []): readonly string[] {
  if (value === WORKFLOW_UNKNOWN_MARKER || value === undefined || typeof value === 'function' || typeof value === 'symbol') {
    out.push(path || '$');
    return out;
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) => findUnknownInputs(item, `${path}[${String(index)}]`, out));
    return out;
  }
  if (typeof value === 'object' && value !== null) {
    for (const [key, child] of Object.entries(value)) {
      findUnknownInputs(child, path === '' ? key : `${path}.${key}`, out);
    }
  }
  return out;
}

function canonicalJson(value: unknown): string {
  const seen = new Set<object>();
  const normalized = normalize(value, seen);
  return JSON.stringify(normalized);
}

function normalize(value: unknown, seen: Set<object>): unknown {
  if (value === undefined) return WORKFLOW_UNKNOWN_MARKER;
  if (typeof value === 'number' && !Number.isFinite(value)) return String(value);
  if (typeof value === 'bigint') return `${String(value)}n`;
  if (typeof value === 'function' || typeof value === 'symbol') return WORKFLOW_UNKNOWN_MARKER;
  if (value === null || typeof value !== 'object') return value;
  if (seen.has(value)) return '[Circular]';
  seen.add(value);
  if (Array.isArray(value)) return value.map((item) => normalize(item, seen));
  const result: Record<string, unknown> = {};
  for (const key of Object.keys(value as Record<string, unknown>).sort()) {
    if (key === '__proto__') continue;
    result[key] = normalize((value as Record<string, unknown>)[key], seen);
  }
  seen.delete(value);
  return result;
}
