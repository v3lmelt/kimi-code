/**
 * `workflow.ir` — verifies graph normalization, topology, fingerprints, and
 * the explicit compile rejection for first-stage unsupported node kinds.
 */

import { describe, expect, it } from 'vitest';

import {
  computeWorkflowFingerprint,
  validateWorkflowGraph,
  WorkflowGraphError,
} from '#/agent/workflow/ir/index';
import { compileWorkflowGraphResult } from '#/agent/workflow/compile/graphCompiler';
import type { WorkflowGraph } from '#/agent/workflow/types';

function graph(nodes: WorkflowGraph['nodes']): WorkflowGraph {
  return { version: '1', nodes };
}

describe('WorkflowGraph topology', () => {
  it('normalizes dependency aliases and produces deterministic order', () => {
    const result = validateWorkflowGraph(graph([
      { id: 'b', kind: 'agent', prompt: 'b', dependencies: ['a'] },
      { id: 'a', kind: 'agent', prompt: 'a' },
    ]));
    expect(result.order).toEqual(['a', 'b']);
    expect(result.graph.nodes[0]?.dependsOn).toEqual(['a']);
    expect(result.graph.nodes[0]?.dependencies).toEqual(['a']);
  });

  it('rejects duplicate IDs, unknown dependencies, and cycles', () => {
    expect(() => validateWorkflowGraph(graph([
      { id: 'a', kind: 'agent', prompt: 'a' },
      { id: 'a', kind: 'agent', prompt: 'duplicate' },
    ]))).toThrow(WorkflowGraphError);
    expect(() => validateWorkflowGraph(graph([
      { id: 'a', kind: 'agent', prompt: 'a', dependsOn: ['missing'] },
    ]))).toThrow(/unknown node/);
    expect(() => validateWorkflowGraph(graph([
      { id: 'a', kind: 'agent', prompt: 'a', dependsOn: ['b'] },
      { id: 'b', kind: 'agent', prompt: 'b', dependsOn: ['a'] },
    ]))).toThrow(/cycle/);
  });

  it('places condition branches after their condition node', () => {
    const result = validateWorkflowGraph(graph([
      { id: 'branch', kind: 'sequence' },
      { id: 'condition', kind: 'condition', whenTrue: 'branch', condition: { value: true } },
    ]));
    expect(result.order).toEqual(['condition', 'branch']);
  });
});

describe('WorkflowGraph compilation and fingerprint', () => {
  it('accepts executable kinds and attaches provenance and fingerprints', () => {
    const result = compileWorkflowGraphResult(graph([
      { id: 'a', kind: 'agent', prompt: 'a' },
      { id: 'join', kind: 'join', dependsOn: ['a'] },
      { id: 'condition', kind: 'condition', dependsOn: ['join'], condition: { value: true } },
      { id: 'sequence', kind: 'sequence', dependsOn: ['condition'] },
    ]), {
      resolvedModel: 'model',
      effort: 'medium',
      profile: 'coder',
      tool: 'workflow',
      permission: 'allow',
      cwd: 'workspace',
      workspaceRevision: 'rev-1',
    });
    expect('graph' in result).toBe(true);
    if (!('graph' in result)) return;
    expect(result.graph.verified).toBe(true);
    expect(result.graph.graph.nodes.every((node) => node.fingerprint !== undefined)).toBe(true);
    expect(result.graph.graph.nodes[0]?.provenance?.authoring).toBe('ir');
  });

  it('rejects kinds not implemented by the first executor', () => {
    const result = compileWorkflowGraphResult(graph([{ id: 'fan', kind: 'fanout', items: [] }]));
    expect('error' in result).toBe(true);
    if ('error' in result) expect(result.error.code).toBe('workflow.unsupported_node_kind');
  });

  it('recomputes fingerprints from the normalized node and rejects stale declarations', () => {
    const context = {
      resolvedModel: 'model',
      effort: 'medium',
      profile: 'coder',
      tool: 'workflow',
      permission: 'allow',
      cwd: 'workspace',
      workspaceRevision: 'rev-1',
    };
    const original = { id: 'a', kind: 'agent' as const, prompt: 'original' };
    const declared = computeWorkflowFingerprint(graph([original]), original, context);
    const result = compileWorkflowGraphResult(graph([{
      ...original,
      prompt: 'changed',
      fingerprint: declared,
    }]), context);
    expect('error' in result).toBe(true);
    if ('error' in result) expect(result.error.code).toBe('workflow.fingerprint_mismatch');
  });

  it('uses the graph version from the normalized graph even when context declares another version', () => {
    const value = computeWorkflowFingerprint(
      graph([{ id: 'a', kind: 'agent', prompt: 'a' }]),
      { id: 'a', kind: 'agent', prompt: 'a' },
      { graphVersion: 'stale', resolvedModel: 'model' },
    );
    expect(value.inputs.graphVersion).toBe('1');
  });

  it('uses an unknown marker and disables cacheability when environment inputs are unavailable', () => {
    const value = computeWorkflowFingerprint(graph([{ id: 'a', kind: 'agent', prompt: 'a' }]), {
      id: 'a',
      kind: 'agent',
      prompt: 'a',
    });
    expect(value.cacheable).toBe(false);
    expect(value.unknownInputs).toContain('resolvedModel');
    expect(value.inputs.resolvedModel).toBe('__workflow_unknown__');
  });
});
