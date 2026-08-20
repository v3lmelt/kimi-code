/**
 * `workflow.runtime` — end-to-end tests for verified DAG execution, retry,
 * conditions, typed schema failures, resume fingerprints, and budget gates.
 */

import { describe, expect, it } from 'vitest';

import { compileWorkflowGraph } from '#/agent/workflow/compile/index';
import { WorkflowTask } from '#/agent/tools/workflow/workflowTask';
import { WorkflowDagBudgetLedger, WorkflowDagScheduler } from '#/agent/workflow/runtime/dagScheduler';
import type { WorkflowGraph } from '#/agent/workflow/types';

function compile(graph: WorkflowGraph, options: Parameters<typeof compileWorkflowGraph>[1] = {}) {
  return compileWorkflowGraph(graph, {
    resolvedModel: 'model',
    effort: 'medium',
    profile: 'coder',
    tool: 'workflow',
    permission: 'allow',
    cwd: 'workspace',
    workspaceRevision: 'rev-1',
    ...options,
  });
}

describe('WorkflowDagScheduler', () => {
  it('executes agent, sequence, join, and condition nodes in dependency order', async () => {
    const graph = compile({
      version: '1',
      root: 'sequence',
      nodes: [
        { id: 'a', kind: 'agent', prompt: 'a' },
        { id: 'b', kind: 'agent', prompt: 'b', dependsOn: ['a'] },
        { id: 'join', kind: 'join', dependsOn: ['a', 'b'], strategy: 'all' },
        { id: 'condition', kind: 'condition', dependsOn: ['join'], condition: { value: true } },
        { id: 'sequence', kind: 'sequence', dependsOn: ['condition'], children: ['condition'] },
      ],
    });
    const calls: string[] = [];
    const result = await new WorkflowDagScheduler({
      graph,
      executeAgent: async (node) => {
        calls.push(node.id);
        return { ok: true, agentId: node.id, output: node.prompt, durationMs: 1 };
      },
      budget: { total: 100 },
    }).run();
    expect(result.status).toBe('completed');
    expect(calls).toEqual(['a', 'b']);
    expect(result.result).toEqual([true]);
    expect(result.nodes.get('sequence')?.status).toBe('completed');
  });

  it('retries failures and preserves a typed schema failure without text coercion', async () => {
    let attempts = 0;
    const graph = compile({
      version: '1',
      root: 'agent',
      nodes: [{ id: 'agent', kind: 'agent', prompt: 'structured', schema: { type: 'object' }, retry: { maxAttempts: 2 } }],
    });
    const result = await new WorkflowDagScheduler({
      graph,
      executeAgent: async () => {
        attempts += 1;
        if (attempts === 1) throw new Error('retry me');
        return { ok: true, agentId: 'agent', output: 'plain text', durationMs: 1 };
      },
      budget: { total: 100 },
    }).run();
    expect(attempts).toBe(2);
    expect(result.status).toBe('failed');
    expect(result.nodes.get('agent')?.result?.status).toBe('failed');
    expect(result.nodes.get('agent')?.result?.error?.code).toBe('workflow.schema_invalid');
    expect(result.nodes.get('agent')?.result).not.toHaveProperty('value');
  });

  it('allows a join-any node to wait for a successful sibling', async () => {
    const graph = compile({
      version: '1',
      root: 'join',
      nodes: [
        { id: 'fail', kind: 'agent', prompt: 'fail' },
        { id: 'ok', kind: 'agent', prompt: 'ok' },
        { id: 'join', kind: 'join', dependsOn: ['fail', 'ok'], strategy: 'any' },
      ],
    });
    const result = await new WorkflowDagScheduler({
      graph,
      executeAgent: async (node) => node.id === 'fail'
        ? { ok: false, agentId: node.id, output: null, error: 'failed', durationMs: 1 }
        : { ok: true, agentId: node.id, output: 'ok', durationMs: 1 },
      budget: { total: 10 },
    }).run();
    expect(result.status).toBe('completed');
    expect(result.result).toBe('ok');
  });

  it('propagates an unselected condition branch as skipped without treating it as success', async () => {
    const graph = compile({
      version: '1',
      nodes: [
        { id: 'condition', kind: 'condition', condition: { value: false }, whenTrue: 'skipped', whenFalse: 'selected' },
        { id: 'skipped', kind: 'agent', prompt: 'skipped' },
        { id: 'selected', kind: 'agent', prompt: 'selected' },
        { id: 'agent-downstream', kind: 'agent', prompt: 'downstream', dependsOn: ['skipped'] },
        { id: 'sequence-downstream', kind: 'sequence', dependsOn: ['skipped'], children: ['skipped'] },
        { id: 'join-downstream', kind: 'join', dependsOn: ['skipped'], strategy: 'all' },
        { id: 'join-accepts-skipped', kind: 'join', dependsOn: ['skipped'], strategy: 'all', acceptsSkipped: true },
      ],
    });
    const calls: string[] = [];
    const result = await new WorkflowDagScheduler({
      graph,
      executeAgent: async (node) => {
        calls.push(node.id);
        return { ok: true, agentId: node.id, output: node.id, durationMs: 1 };
      },
      budget: { total: 100 },
    }).run();
    expect(result.nodes.get('condition')?.status).toBe('skipped');
    expect(result.nodes.get('skipped')?.status).toBe('skipped');
    expect(result.nodes.get('selected')?.status).toBe('completed');
    expect(result.nodes.get('agent-downstream')?.status).toBe('blocked');
    expect(result.nodes.get('sequence-downstream')?.status).toBe('blocked');
    expect(result.nodes.get('join-downstream')?.status).toBe('blocked');
    expect(result.nodes.get('join-accepts-skipped')?.status).toBe('completed');
    expect(calls).toEqual(['selected']);
  });

  it('resumes only a completed node with a matching cacheable fingerprint', async () => {
    const graph = compile({ version: '1', root: 'a', nodes: [{ id: 'a', kind: 'agent', prompt: 'a' }] });
    const node = graph.graph.nodes[0]!;
    const calls: string[] = [];
    const result = await new WorkflowDagScheduler({
      graph,
      resume: new Map([['a', {
        nodeId: 'a',
        status: 'completed',
        fingerprint: node.fingerprint!.value,
        attempt: 1,
        result: { status: 'completed', value: 'cached', provenance: { authoring: 'ir', nodeId: 'a', fingerprint: node.fingerprint!.value } },
      }]]),
      executeAgent: async () => {
        calls.push('live');
        return { ok: true, agentId: 'a', output: 'live', durationMs: 1 };
      },
      budget: { total: 100 },
    }).run();
    expect(calls).toEqual([]);
    expect(result.result).toBe('cached');
  });

  it('retries a lost running node from its persisted attempt', async () => {
    const graph = compile({ version: '1', root: 'a', nodes: [{ id: 'a', kind: 'agent', prompt: 'a' }] });
    const node = graph.graph.nodes[0]!;
    let calls = 0;
    const result = await new WorkflowDagScheduler({
      graph,
      resume: new Map([['a', {
        nodeId: 'a',
        status: 'lost',
        fingerprint: node.fingerprint!.value,
        attempt: 1,
      }]]),
      executeAgent: async () => {
        calls += 1;
        return { ok: true, agentId: 'a', output: 'recovered', durationMs: 1 };
      },
      budget: { total: 10 },
    }).run();
    expect(calls).toBe(1);
    expect(result.status).toBe('completed');
  });

  it('does not start a node when spent plus reserved exceeds the budget', async () => {
    const graph = compile({
      version: '1',
      nodes: [
        { id: 'a', kind: 'agent', prompt: 'a', budget: 2 },
        { id: 'b', kind: 'agent', prompt: 'b', budget: 2 },
      ],
    });
    const calls: string[] = [];
    const budget = new WorkflowDagBudgetLedger(2);
    const result = await new WorkflowDagScheduler({
      graph,
      budget,
      executeAgent: async (node) => {
        calls.push(node.id);
        return { ok: true, agentId: node.id, output: node.id, durationMs: 1, usage: { inputOther: 2, output: 0, inputCacheRead: 0, inputCacheCreation: 0 } };
      },
    }).run();
    expect(calls).toEqual(['a']);
    expect(result.nodes.get('b')?.status).toBe('blocked');
  });

  it('reconciles actual overage, retains the node result, and blocks later ready nodes', async () => {
    const graph = compile({
      version: '1',
      nodes: [
        { id: 'overage', kind: 'agent', prompt: 'overage', budget: 1 },
        { id: 'later', kind: 'agent', prompt: 'later', budget: 1 },
      ],
    });
    const calls: string[] = [];
    const result = await new WorkflowDagScheduler({
      graph,
      executeAgent: async (node) => {
        calls.push(node.id);
        return {
          ok: true,
          agentId: node.id,
          output: 'retained',
          durationMs: 1,
          usage: { inputOther: 3, output: 0, inputCacheRead: 0, inputCacheCreation: 0 },
        };
      },
      budget: { total: 2 },
    }).run();
    expect(calls).toEqual(['overage']);
    expect(result.status).toBe('budget_exceeded');
    expect(result.budgetExceeded).toBe(true);
    expect(result.spent).toBe(3);
    expect(result.nodes.get('overage')?.status).toBe('completed');
    expect(result.nodes.get('overage')?.result?.value).toBe('retained');
    expect(result.nodes.get('later')?.status).toBe('blocked');
  });

  it('reserves a concurrent budget before launching more than one node', async () => {
    const graph = compile({
      version: '1',
      nodes: [
        { id: 'a', kind: 'agent', prompt: 'a', budget: 2 },
        { id: 'b', kind: 'agent', prompt: 'b', budget: 2 },
      ],
    });
    const calls: string[] = [];
    const result = await new WorkflowDagScheduler({
      graph,
      maxConcurrency: 2,
      executeAgent: async (node) => {
        calls.push(node.id);
        return { ok: true, agentId: node.id, output: node.id, durationMs: 1 };
      },
      budget: { total: 2 },
    }).run();
    expect(calls).toEqual(['a']);
    expect(result.nodes.get('b')?.status).toBe('blocked');
  });

  it('executes a verified graph through the public WorkflowTask entry', async () => {
    const graph = compile({
      version: '1',
      root: 'sequence',
      nodes: [
        { id: 'condition', kind: 'condition', condition: { value: true } },
        { id: 'sequence', kind: 'sequence', dependsOn: ['condition'], children: ['condition'] },
      ],
    });
    const settled: string[] = [];
    const outputs: string[] = [];
    const task = new WorkflowTask({
      runId: 'wf_0123456789abcdef',
      script: JSON.stringify(graph.graph),
      scriptSha256: 'graph-sha',
      name: 'graph-test',
      description: 'graph-test',
      meta: { name: 'graph-test', description: 'graph-test' },
      tokenBudgetTotal: 20,
      journal: {
        writeWorkflowStarted: () => undefined,
        writeWorkflowCompleted: () => undefined,
        writeNodePlanned: () => undefined,
        writeNodeReady: () => undefined,
        writeNodeRunning: () => undefined,
        writeNodeCompleted: () => undefined,
        writeNodeFailed: () => undefined,
        writeNodeSkipped: () => undefined,
        writeNodeBlocked: () => undefined,
        writeCheckpoint: () => undefined,
      } as never,
      wire: { dispatch: () => undefined } as never,
      telemetry: { launched: () => undefined, completed: () => undefined } as never,
      log: { info: () => undefined, warn: () => undefined } as never,
      spawnDeps: {} as never,
      parentToolCallId: 'tool-call',
      graph,
    });
    await task.start({
      signal: new AbortController().signal,
      appendOutput: (output) => outputs.push(output),
      settle: async (settlement) => {
        settled.push(settlement.status);
        return true;
      },
    });
    expect(settled).toEqual(['completed']);
    expect(outputs.join('\n')).toContain('status: completed');
  });
});
