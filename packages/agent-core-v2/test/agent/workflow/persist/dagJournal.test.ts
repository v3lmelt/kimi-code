/**
 * `workflow.persist` — verifies append-only DAG node records, checkpoint
 * folding, and restart recovery of running nodes as lost.
 */

import { describe, expect, it } from 'vitest';

import { AppendLogStore } from '#/persistence/backends/node-fs/appendLogStore';
import { InMemoryStorageService } from '#/persistence/backends/memory/inMemoryStorageService';
import {
  WorkflowDagJournal,
  WorkflowJournalCorruptionError,
  foldWorkflowJournal,
  nodeProvenance,
} from '#/agent/workflow/persist/dagJournal';

const runId = 'wf_0123456789abcdef' as const;

describe('Workflow DAG journal fold', () => {
  it('folds node lifecycle and marks an interrupted running node lost', () => {
    const records = [
      { kind: 'node.planned' as const, runId, nodeId: 'a', fingerprint: 'fp-a', provenance: nodeProvenance('a', 'fp-a'), at: '1' },
      { kind: 'node.ready' as const, runId, nodeId: 'a', fingerprint: 'fp-a', at: '2' },
      { kind: 'node.running' as const, runId, nodeId: 'a', fingerprint: 'fp-a', attempt: 1, at: '3' },
    ];
    const summary = foldWorkflowJournal(records, { recoverRunning: true, lostAt: '4' });
    expect(summary.nodes.get('a')).toMatchObject({ status: 'lost', attempt: 1, lostAt: '4' });
  });

  it('round-trips node results and checkpoints through the append log', async () => {
    const log = new AppendLogStore(new InMemoryStorageService());
    const journal = new WorkflowDagJournal({ runId, scope: `session/workflows/${runId}`, log });
    journal.writeNodePlanned('a', 'fp-a', nodeProvenance('a', 'fp-a'), '1');
    journal.writeNodeRunning('a', 'fp-a', 1, '2');
    journal.writeNodeCompleted('a', 'fp-a', 1, {
      status: 'completed',
      value: { ok: true },
      provenance: nodeProvenance('a', 'fp-a'),
    }, '3');
    journal.writeCheckpoint({
      checkpointId: 'c1',
      graphVersion: '1',
      nodes: [{
        nodeId: 'a',
        status: 'completed',
        fingerprint: 'fp-a',
        attempt: 1,
        updatedAt: '3',
      }],
      spent: 2,
      reserved: 0,
      at: '4',
    });
    const summary = await journal.readDagSummary({ recoverRunning: true });
    expect(summary.graphVersion).toBe('1');
    expect(summary.nodes.get('a')?.status).toBe('completed');
    expect(summary.spent).toBe(2);
    await log.close();
  });

  it('recovers a running checkpoint as lost', () => {
    const summary = foldWorkflowJournal([{
      kind: 'checkpoint',
      runId,
      checkpointId: 'c1',
      graphVersion: '1',
      nodes: [{ nodeId: 'a', status: 'running', fingerprint: 'fp-a', attempt: 1, updatedAt: '3' }],
      spent: 0,
      reserved: 1,
      at: '3',
    }], { recoverRunning: true, lostAt: '4' });
    expect(summary.nodes.get('a')).toMatchObject({ status: 'lost', lostAt: '4' });
  });

  it('does not double-count duplicate terminal usage events', () => {
    const result = {
      status: 'completed' as const,
      value: 'ok',
      usage: { inputOther: 2, output: 1, inputCacheRead: 0, inputCacheCreation: 0 },
      provenance: nodeProvenance('a', 'fp-a'),
    };
    const summary = foldWorkflowJournal([
      { kind: 'node.completed', runId, nodeId: 'a', fingerprint: 'fp-a', attempt: 1, result, at: '1' },
      { kind: 'node.completed', runId, nodeId: 'a', fingerprint: 'fp-a', attempt: 1, result, at: '2' },
    ]);
    expect(summary.spent).toBe(3);
  });

  it('rejects conflicting duplicate terminal events as journal corruption', () => {
    const result = {
      status: 'completed' as const,
      value: 'ok',
      provenance: nodeProvenance('a', 'fp-a'),
    };
    expect(() => foldWorkflowJournal([
      { kind: 'node.completed', runId, nodeId: 'a', fingerprint: 'fp-a', attempt: 1, result, at: '1' },
      { kind: 'node.completed', runId, nodeId: 'a', fingerprint: 'fp-a', attempt: 1, result: { ...result, value: 'different' }, at: '2' },
    ])).toThrow(WorkflowJournalCorruptionError);
  });

  it('rejects an unknown node event as journal corruption', async () => {
    const log = {
      read: async function* () {
        yield { kind: 'node.unknown', runId, nodeId: 'a', fingerprint: 'fp-a', at: '1' };
      },
    } as never;
    const journal = new WorkflowDagJournal({ runId, scope: 'scope', log });
    await expect(journal.readDagSummary()).rejects.toBeInstanceOf(WorkflowJournalCorruptionError);
  });
});
