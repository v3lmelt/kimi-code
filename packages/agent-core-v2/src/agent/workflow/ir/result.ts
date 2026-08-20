/**
 * `workflow.ir` domain — typed node-result helpers and JSON-schema validation
 * used by both the scheduler and persisted resume records.
 */

import type {
  WorkflowNodeProvenance,
  WorkflowNodeResult,
  WorkflowSchema,
} from '#/agent/workflow/types';

export function completedNodeResult<T>(
  value: T,
  provenance: WorkflowNodeProvenance,
  usage?: WorkflowNodeResult<T>['usage'],
): WorkflowNodeResult<T> {
  return { status: 'completed', value, provenance, ...(usage === undefined ? {} : { usage }) };
}

export function failedNodeResult<T = never>(
  error: { readonly code: string; readonly message: string; readonly details?: unknown },
  provenance: WorkflowNodeProvenance,
  usage?: WorkflowNodeResult<T>['usage'],
): WorkflowNodeResult<T> {
  return { status: 'failed', error, provenance, ...(usage === undefined ? {} : { usage }) };
}

export function skippedNodeResult(
  provenance: WorkflowNodeProvenance,
  reason = 'Node was skipped.',
): WorkflowNodeResult<never> {
  return {
    status: 'skipped',
    error: { code: 'workflow.node_skipped', message: reason },
    provenance,
  };
}

export function blockedNodeResult(
  provenance: WorkflowNodeProvenance,
  reason = 'Node is blocked by an upstream failure.',
): WorkflowNodeResult<never> {
  return {
    status: 'blocked',
    error: { code: 'workflow.node_blocked', message: reason },
    provenance,
  };
}

export function validateWorkflowSchema(value: unknown, schema: WorkflowSchema): string | undefined {
  if (!isRecord(schema)) return 'Schema must be a JSON object.';
  if (schema['enum'] !== undefined && Array.isArray(schema['enum']) && !schema['enum'].some((entry) => deepEqual(entry, value))) {
    return 'Value is not one of the schema enum values.';
  }
  if (schema['const'] !== undefined && !deepEqual(schema['const'], value)) return 'Value does not match schema const.';
  if (schema['type'] !== undefined) {
    const type = schema['type'];
    const valid = Array.isArray(type)
      ? type.some((item) => jsonTypeMatches(value, item))
      : jsonTypeMatches(value, type);
    if (!valid) return `Expected schema type ${String(type)}.`;
  }
  if (isRecord(value) && isRecord(schema['properties'])) {
    const required = Array.isArray(schema['required']) ? schema['required'] : [];
    for (const key of required) {
      if (typeof key === 'string' && !(key in value)) return `Missing required property "${key}".`;
    }
    for (const [key, childSchema] of Object.entries(schema['properties'])) {
      if (key in value && isRecord(childSchema)) {
        const error = validateWorkflowSchema(value[key], childSchema);
        if (error !== undefined) return `${key}: ${error}`;
      }
    }
  }
  if (Array.isArray(value) && isRecord(schema['items'])) {
    for (let index = 0; index < value.length; index += 1) {
      const error = validateWorkflowSchema(value[index], schema['items']);
      if (error !== undefined) return `[${String(index)}]: ${error}`;
    }
  }
  return undefined;
}

function jsonTypeMatches(value: unknown, type: unknown): boolean {
  switch (type) {
    case 'null': return value === null;
    case 'object': return isRecord(value);
    case 'array': return Array.isArray(value);
    case 'string': return typeof value === 'string';
    case 'number': return typeof value === 'number' && Number.isFinite(value);
    case 'integer': return typeof value === 'number' && Number.isInteger(value);
    case 'boolean': return typeof value === 'boolean';
    default: return true;
  }
}

function deepEqual(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true;
  if (typeof left !== 'object' || left === null || typeof right !== 'object' || right === null) return false;
  if (Array.isArray(left) !== Array.isArray(right)) return false;
  if (Array.isArray(left) && Array.isArray(right)) {
    return left.length === right.length && left.every((entry, index) => deepEqual(entry, right[index]));
  }
  const a = Object.keys(left as Record<string, unknown>);
  const b = Object.keys(right as Record<string, unknown>);
  return a.length === b.length && a.every((key) => key in (right as Record<string, unknown>) && deepEqual((left as Record<string, unknown>)[key], (right as Record<string, unknown>)[key]));
}

function isRecord(value: unknown): value is Record<string, any> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
