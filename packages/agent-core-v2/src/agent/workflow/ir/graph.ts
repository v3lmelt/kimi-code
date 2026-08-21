/**
 * `workflow.ir` domain — validates and normalizes the durable WorkflowGraph
 * contract, including node identity, dependency edges, and deterministic
 * topological order.
 */

import type {
  WorkflowGraph,
  WorkflowGraphValidationResult,
  WorkflowNode,
  WorkflowNodeId,
} from '#/agent/workflow/types';

export class WorkflowGraphError extends Error {
  readonly code = 'workflow.graph_invalid' as const;
  readonly nodeId: WorkflowNodeId | undefined;

  constructor(message: string, nodeId?: WorkflowNodeId) {
    super(message);
    this.name = 'WorkflowGraphError';
    this.nodeId = nodeId;
  }
}

export const WORKFLOW_NODE_KINDS = [
  'agent',
  'map',
  'fanout',
  'sequence',
  'join',
  'verify',
  'condition',
  'approval',
  'gate',
] as const;

export const WORKFLOW_EXECUTABLE_NODE_KINDS = [
  'agent',
  'sequence',
  'join',
  'condition',
] as const;

export function isWorkflowNodeKind(value: unknown): value is WorkflowNode['kind'] {
  return typeof value === 'string' && (WORKFLOW_NODE_KINDS as readonly string[]).includes(value);
}

export function isExecutableWorkflowNodeKind(value: unknown): boolean {
  return typeof value === 'string' &&
    (WORKFLOW_EXECUTABLE_NODE_KINDS as readonly string[]).includes(value);
}

export function nodeDependencies(node: WorkflowNode): readonly WorkflowNodeId[] {
  const values = [
    ...(node.dependsOn ?? []),
    ...(node.dependencies ?? []),
    ...('children' in node ? (node.children ?? []) : []),
    ...('itemNodeId' in node && node.itemNodeId !== undefined ? [node.itemNodeId] : []),
    ...('target' in node && node.target !== undefined ? [node.target] : []),
  ];
  return [...new Set(values)];
}

/** Structural child edges that belong to a node's branch-owned subgraph. */
export function nodeChildren(node: WorkflowNode): readonly WorkflowNodeId[] {
  return [
    ...('children' in node ? (node.children ?? []) : []),
    ...('itemNodeId' in node && node.itemNodeId !== undefined ? [node.itemNodeId] : []),
    ...('target' in node && node.target !== undefined ? [node.target] : []),
  ];
}

export function normalizeWorkflowGraph(graph: WorkflowGraph): WorkflowGraph {
  if (!isRecord(graph)) throw new WorkflowGraphError('WorkflowGraph must be an object.');
  if (typeof graph.version !== 'string' || graph.version.trim().length === 0) {
    throw new WorkflowGraphError('WorkflowGraph.version must be a non-empty string.');
  }
  if (!Array.isArray(graph.nodes)) throw new WorkflowGraphError('WorkflowGraph.nodes must be an array.');
  const ids = new Set<string>();
  const nodes = graph.nodes.map((node, index) => {
    if (!isRecord(node)) throw new WorkflowGraphError(`WorkflowGraph.nodes[${String(index)}] must be an object.`);
    const id = node['id'];
    if (typeof id !== 'string' || id.trim().length === 0) {
      throw new WorkflowGraphError(`WorkflowGraph.nodes[${String(index)}].id must be a non-empty string.`);
    }
    if (ids.has(id)) throw new WorkflowGraphError(`WorkflowGraph contains duplicate node id "${id}".`, id);
    ids.add(id);
    if (!isWorkflowNodeKind(node['kind'])) {
      throw new WorkflowGraphError(`WorkflowGraph node "${id}" has unknown kind "${String(node['kind'])}".`, id);
    }
    if (node['kind'] === 'agent' && typeof node['prompt'] !== 'string') {
      throw new WorkflowGraphError(`Agent node "${id}" requires a string prompt.`, id);
    }
    const dependencies = nodeDependencies(node as WorkflowNode);
    if (dependencies.some((dependency) => typeof dependency !== 'string' || dependency.length === 0)) {
      throw new WorkflowGraphError(`WorkflowGraph node "${id}" has an invalid dependency.`, id);
    }
    return {
      ...(node as WorkflowNode),
      id,
      dependsOn: dependencies,
      dependencies,
    } as WorkflowNode;
  });
  const branchOwners = new Map<WorkflowNodeId, Set<WorkflowNodeId>>();
  for (const node of nodes) {
    if (node.kind !== 'condition') continue;
    for (const branch of [node.whenTrue, node.whenFalse]) {
      if (branch === undefined) continue;
      const pending = [branch];
      const visited = new Set<WorkflowNodeId>();
      while (pending.length > 0) {
        const current = pending.pop()!;
        if (visited.has(current)) continue;
        visited.add(current);
        const owners = branchOwners.get(current) ?? new Set<WorkflowNodeId>();
        owners.add(node.id);
        branchOwners.set(current, owners);
        const currentNode = nodes.find((candidate) => candidate.id === current);
        if (currentNode !== undefined) pending.push(...nodeChildren(currentNode));
      }
    }
  }
  const normalizedNodes = nodes.map((node) => {
    const owners = branchOwners.get(node.id);
    if (owners === undefined) return node;
    const dependencies = [...new Set([...nodeDependencies(node), ...owners])];
    return { ...node, dependsOn: dependencies, dependencies };
  });
  const normalized: WorkflowGraph = {
    ...graph,
    version: graph.version,
    nodes: normalizedNodes,
  };
  if (normalized.root !== undefined && !ids.has(normalized.root)) {
    throw new WorkflowGraphError(`WorkflowGraph.root references unknown node "${normalized.root}".`);
  }
  for (const node of normalizedNodes) {
    for (const dependency of nodeDependencies(node)) {
      if (!ids.has(dependency)) {
        throw new WorkflowGraphError(
          `WorkflowGraph node "${node.id}" depends on unknown node "${dependency}".`,
          node.id,
        );
      }
    }
    if (node.kind === 'condition') {
      for (const branch of [node.whenTrue, node.whenFalse]) {
        if (branch !== undefined && (typeof branch !== 'string' || !ids.has(branch))) {
          throw new WorkflowGraphError(
            `WorkflowGraph condition node "${node.id}" references unknown branch node "${String(branch)}".`,
            node.id,
          );
        }
      }
    }
  }
  return normalized;
}

export function topologicalWorkflowNodeIds(graph: WorkflowGraph): readonly WorkflowNodeId[] {
  const normalized = normalizeWorkflowGraph(graph);
  const byId = new Map(normalized.nodes.map((node) => [node.id, node]));
  const indegree = new Map<WorkflowNodeId, number>();
  const dependents = new Map<WorkflowNodeId, WorkflowNodeId[]>();
  for (const node of normalized.nodes) {
    const dependencies = nodeDependencies(node);
    indegree.set(node.id, dependencies.length);
    for (const dependency of dependencies) {
      const children = dependents.get(dependency) ?? [];
      children.push(node.id);
      dependents.set(dependency, children);
    }
  }
  const ready = normalized.nodes.filter((node) => indegree.get(node.id) === 0).map((node) => node.id);
  const order: WorkflowNodeId[] = [];
  while (ready.length > 0) {
    const id = ready.shift()!;
    order.push(id);
    for (const dependent of dependents.get(id) ?? []) {
      const next = (indegree.get(dependent) ?? 1) - 1;
      indegree.set(dependent, next);
      if (next === 0) ready.push(dependent);
    }
  }
  if (order.length !== normalized.nodes.length) {
    const cycle = normalized.nodes.find((node) => !order.includes(node.id));
    throw new WorkflowGraphError(`WorkflowGraph contains a dependency cycle.`, cycle?.id);
  }
  for (const id of order) {
    if (!byId.has(id)) throw new WorkflowGraphError(`WorkflowGraph contains unknown node "${id}".`);
  }
  return order;
}

export function validateWorkflowGraph(graph: WorkflowGraph): WorkflowGraphValidationResult {
  const normalized = normalizeWorkflowGraph(graph);
  return { graph: normalized, order: topologicalWorkflowNodeIds(normalized) };
}

export function createWorkflowGraph(
  version: string,
  nodes: readonly WorkflowNode[],
  options: Omit<WorkflowGraph, 'version' | 'nodes'> = {},
): WorkflowGraphValidationResult {
  return validateWorkflowGraph({ version, nodes, ...options });
}

function isRecord(value: unknown): value is Record<string, any> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
