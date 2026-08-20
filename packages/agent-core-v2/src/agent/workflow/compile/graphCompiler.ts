/**
 * `workflow.compile` domain — compiles explicit DAG authoring into a verified
 * WorkflowGraph and rejects kinds that the first scheduler cannot execute.
 */

import {
  isExecutableWorkflowNodeKind,
  validateWorkflowGraph,
  WorkflowGraphError,
} from '#/agent/workflow/ir/graph';
import { computeWorkflowFingerprint, type WorkflowFingerprintContext } from '#/agent/workflow/ir/fingerprint';
import type {
  WorkflowGraph,
  WorkflowGraphValidationResult,
  WorkflowNodeKind,
} from '#/agent/workflow/types';
import { WorkflowCompileError } from '#/agent/workflow/types';

export interface CompiledWorkflowGraph extends WorkflowGraphValidationResult {
  readonly verified: true;
  readonly executable: true;
  readonly unsupportedKinds: readonly WorkflowNodeKind[];
  readonly fingerprintContext: WorkflowGraphCompileOptions;
}

export type WorkflowGraphCompileOptions = WorkflowFingerprintContext;

export function compileWorkflowGraph(
  input: unknown,
  options: WorkflowGraphCompileOptions = {},
): CompiledWorkflowGraph {
  let validated: WorkflowGraphValidationResult;
  try {
    validated = validateWorkflowGraph(input as WorkflowGraph);
  } catch (error) {
    if (error instanceof WorkflowGraphError) {
      throw new WorkflowCompileError({
        code: 'workflow.graph_invalid',
        message: error.message,
      });
    }
    throw error;
  }
  const unsupportedKinds = [...new Set(
    validated.graph.nodes
      .filter((node) => !isExecutableWorkflowNodeKind(node.kind))
      .map((node) => node.kind),
  )];
  if (unsupportedKinds.length > 0) {
    throw new WorkflowCompileError({
      code: 'workflow.unsupported_node_kind',
      message: `WorkflowGraph contains node kinds not executable by this runtime: ${unsupportedKinds.join(', ')}.`,
    });
  }
  const nodes = validated.graph.nodes.map((node) => {
    const computedFingerprint = computeWorkflowFingerprint(validated.graph, node, options);
    if (node.fingerprint !== undefined && node.fingerprint.value !== computedFingerprint.value) {
      throw new WorkflowCompileError({
        code: 'workflow.fingerprint_mismatch',
        message: `Workflow node "${node.id}" declares a fingerprint that does not match its normalized specification and runtime context.`,
      });
    }
    const baseProvenance = node.provenance ?? validated.graph.provenance ?? { authoring: 'ir' as const };
    const provenance = {
      ...baseProvenance,
      cacheable: computedFingerprint.cacheable,
      unknownInputs: computedFingerprint.unknownInputs,
    };
    return {
      ...node,
      provenance,
      fingerprint: computedFingerprint,
    };
  });
  return {
    graph: { ...validated.graph, nodes },
    order: validated.order,
    verified: true,
    executable: true,
    unsupportedKinds,
    fingerprintContext: options,
  };
}

export function compileWorkflowDag(
  input: unknown,
  options?: WorkflowGraphCompileOptions,
): CompiledWorkflowGraph {
  return compileWorkflowGraph(input, options);
}

export function compileWorkflowGraphResult(
  input: unknown,
  options?: WorkflowGraphCompileOptions,
): { readonly graph: CompiledWorkflowGraph } | { readonly error: WorkflowCompileError } {
  try {
    return { graph: compileWorkflowGraph(input, options) };
  } catch (error) {
    if (error instanceof WorkflowCompileError) return { error };
    throw error;
  }
}

export interface WorkflowAuthoringCompileSuccess {
  readonly mode: 'dag' | 'legacy-js';
  readonly graph?: CompiledWorkflowGraph;
  readonly source?: string;
  readonly provenance: 'ir' | 'legacy-js';
}

export type WorkflowAuthoringCompileResult =
  | WorkflowAuthoringCompileSuccess
  | { readonly error: WorkflowCompileError };

export function compileWorkflowAuthoring(
  authoring: unknown,
  options?: WorkflowGraphCompileOptions,
): WorkflowAuthoringCompileResult {
  if (isGraphAuthoring(authoring)) {
    const graph = 'graph' in authoring ? authoring.graph : authoring;
    const compiled = compileWorkflowGraphResult(graph, options);
    if ('error' in compiled) return compiled;
    return { mode: 'dag', graph: compiled.graph, provenance: 'ir' };
  }
  if (typeof authoring === 'object' && authoring !== null && 'script' in authoring && typeof authoring.script === 'string') {
    return {
      mode: 'legacy-js',
      source: authoring.script,
      provenance: 'legacy-js',
    };
  }
  if (typeof authoring === 'string') {
    return { mode: 'legacy-js', source: authoring, provenance: 'legacy-js' };
  }
  return {
    error: new WorkflowCompileError({
      code: 'workflow.js_not_static_dag',
      message: 'Workflow authoring is not a verified DAG. Use an explicit graph entry for DAG execution.',
    }),
  };
}

export function assertWorkflowGraphCompileError(error: unknown): asserts error is WorkflowCompileError {
  if (!(error instanceof WorkflowCompileError)) throw error;
}

function isGraphAuthoring(value: unknown): value is WorkflowGraph | { readonly graph: WorkflowGraph } {
  if (typeof value !== 'object' || value === null) return false;
  if ('graph' in value) return true;
  return 'version' in value && 'nodes' in value;
}
