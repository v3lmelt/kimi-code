/**
 * `workflow.persist` — unit tests for the run journal.
 *
 * Covers: write/read roundtrip of every record kind (started with the script
 * sha256 pin, phase transitions, agent spawn/completion, terminal settlement);
 * the derived summary (status, completedAgentIds for resume, agents folded with
 * spawn + completion); a missing journal reading as undefined; the `wf_<16 hex>`
 * run-id shape and guard; and sha256 pin stability.
 */

import { describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { toDisposable } from '#/_base/di/lifecycle';
import { AppendLogStore } from '#/persistence/backends/node-fs/appendLogStore';
import { FileStorageService } from '#/persistence/backends/node-fs/fileStorageService';
import { InMemoryStorageService } from '#/persistence/backends/memory/inMemoryStorageService';
import {
  WorkflowJournal,
  WorkflowRunAlreadyClaimedError,
  generateWorkflowRunId,
  isWorkflowRunId,
  workflowAgentCacheKey,
  workflowJournalDir,
  workflowJournalFile,
  workflowJournalScope,
  workflowScriptSha256,
} from '#/agent/workflow/persist/journal';

const SCRIPT = [
  "export const meta = { name: 'demo', description: 'A demo run', phases: [{ title: 'gather' }] };",
  'export async function main() {',
  "  const first = await agent('gather');",
  '  return first.output;',
  '}',
].join('\n');

function makeJournal(runId = generateWorkflowRunId()): {
  readonly journal: WorkflowJournal;
  readonly runId: string;
} {
  const log = new AppendLogStore(new InMemoryStorageService());
  const journal = new WorkflowJournal({
    runId,
    scope: workflowJournalScope('sessions/s-1', runId),
    dir: workflowJournalDir('sessions/s-1', runId),
    log,
    allowMissingExclusiveLock: true,
  });
  return { journal, runId };
}

function makeJournalWithLog(
  log: AppendLogStore,
  runId = generateWorkflowRunId(),
  allowMissingExclusiveLock = true,
): WorkflowJournal {
  return new WorkflowJournal({
    runId,
    scope: workflowJournalScope('sessions/s-1', runId),
    dir: workflowJournalDir('sessions/s-1', runId),
    log,
    allowMissingExclusiveLock,
  });
}

describe('workflowScriptSha256', () => {
  it('is stable for the same script and changes when the script changes', () => {
    const first = workflowScriptSha256(SCRIPT);
    const again = workflowScriptSha256(SCRIPT);
    expect(first).toBe(again);
    expect(first).toMatch(/^[a-f0-9]{64}$/);

    const changed = workflowScriptSha256(`${SCRIPT}\n// trailing\n`);
    expect(changed).not.toBe(first);
  });
});

describe('generateWorkflowRunId', () => {
  it('produces the wf_<16 hex> shape', () => {
    for (let i = 0; i < 32; i++) {
      const runId = generateWorkflowRunId();
      expect(runId.startsWith('wf_')).toBe(true);
      expect(runId).toMatch(/^wf_[a-f0-9]{16}$/);
      expect(isWorkflowRunId(runId)).toBe(true);
    }
  });

  it('is practically unique', () => {
    const seen = new Set<string>();
    for (let i = 0; i < 256; i++) {
      seen.add(generateWorkflowRunId());
    }
    expect(seen.size).toBe(256);
  });
});

describe('isWorkflowRunId', () => {
  it('rejects malformed run ids', () => {
    expect(isWorkflowRunId('')).toBe(false);
    expect(isWorkflowRunId('wf_')).toBe(false);
    expect(isWorkflowRunId('wf_xyz')).toBe(false);
    expect(isWorkflowRunId('task-abcdef12')).toBe(false);
    expect(isWorkflowRunId('wf_ABCDEF1234567890')).toBe(false);
    expect(isWorkflowRunId('../wf_0123456789abcdef')).toBe(false);
  });
});

describe('workflowAgentCacheKey', () => {
  it('is stable for the same (prompt, opts) and version-prefixed', () => {
    const first = workflowAgentCacheKey('do the thing', { model: 'fast' });
    const again = workflowAgentCacheKey('do the thing', { model: 'fast' });
    expect(first).toBe(again);
    expect(first).toMatch(/^v1:[a-f0-9]{64}$/);
  });

  it('changes when the prompt changes', () => {
    const a = workflowAgentCacheKey('prompt A', undefined);
    const b = workflowAgentCacheKey('prompt B', undefined);
    expect(a).not.toBe(b);
  });

  it('ignores display-only opts (label, phase)', () => {
    const bare = workflowAgentCacheKey('same prompt', undefined);
    const labelled = workflowAgentCacheKey('same prompt', { label: 'collector', phase: 'Review' });
    expect(labelled).toBe(bare);
  });

  it('is sensitive to the effective opts (schema, model, effort, isolation, agentType)', () => {
    const base = workflowAgentCacheKey('p', { model: 'a' });
    expect(workflowAgentCacheKey('p', { model: 'b' })).not.toBe(base);
    expect(workflowAgentCacheKey('p', { model: 'a', effort: 'low' })).not.toBe(base);
    expect(workflowAgentCacheKey('p', { model: 'a', isolation: 'worktree' })).not.toBe(base);
    expect(workflowAgentCacheKey('p', { model: 'a', agentType: 'coder' })).not.toBe(base);
    expect(
      workflowAgentCacheKey('p', { model: 'a', schema: { type: 'object' } }),
    ).not.toBe(base);
  });

  it('is insensitive to schema key order (canonical JSON)', () => {
    const a = workflowAgentCacheKey('p', {
      schema: { type: 'object', properties: { a: { type: 'string' }, b: { type: 'number' } } },
    });
    const b = workflowAgentCacheKey('p', {
      schema: { properties: { b: { type: 'number' }, a: { type: 'string' } }, type: 'object' },
    });
    expect(a).toBe(b);
  });
});

describe('journal cache-key folding (completedByCacheKey)', () => {
  it('maps successful keyed completions; failed and keyless agents are not replayable', async () => {
    const { journal } = makeJournal();
    journal.writeWorkflowStarted({
      script: SCRIPT,
      scriptSha256: workflowScriptSha256(SCRIPT),
      name: 'demo',
      description: 'cache keys',
      startedAt: '2026-08-18T00:00:00.000Z',
    });
    const key1 = workflowAgentCacheKey('prompt one', undefined);
    const key2 = workflowAgentCacheKey('prompt two', undefined);
    journal.writeAgentSpawned({ agentId: 'a1', cacheKey: key1, at: '2026-08-18T00:00:01.000Z' });
    journal.writeAgentCompleted({
      agentId: 'a1',
      cacheKey: key1,
      ok: true,
      result: 'one done',
      durationMs: 10,
      at: '2026-08-18T00:00:02.000Z',
    });
    journal.writeAgentSpawned({ agentId: 'a2', cacheKey: key2, at: '2026-08-18T00:00:03.000Z' });
    journal.writeAgentCompleted({
      agentId: 'a2',
      cacheKey: key2,
      ok: false,
      error: 'boom',
      durationMs: 5,
      at: '2026-08-18T00:00:04.000Z',
    });
    journal.writeAgentSpawned({ agentId: 'a3', at: '2026-08-18T00:00:05.000Z' });
    journal.writeAgentCompleted({
      agentId: 'a3',
      ok: true,
      result: 'no key',
      durationMs: 5,
      at: '2026-08-18T00:00:06.000Z',
    });

    const summary = await journal.readJournal();
    expect(summary?.completedByCacheKey.size).toBe(1);
    const cached = summary?.completedByCacheKey.get(key1);
    expect(cached).toMatchObject({ agentId: 'a1', ok: true, result: 'one done' });
    expect(summary?.completedByCacheKey.has(key2)).toBe(false);
  });

  it('a re-run record for the same key overwrites the earlier completion', async () => {
    const { journal } = makeJournal();
    journal.writeWorkflowStarted({
      script: SCRIPT,
      scriptSha256: workflowScriptSha256(SCRIPT),
      name: 'demo',
      description: 'dup keys',
      startedAt: '2026-08-18T00:00:00.000Z',
    });
    const key = workflowAgentCacheKey('same', undefined);
    journal.writeAgentSpawned({ agentId: 'first', cacheKey: key, at: '2026-08-18T00:00:01.000Z' });
    journal.writeAgentCompleted({
      agentId: 'first',
      cacheKey: key,
      ok: true,
      result: 'old',
      durationMs: 1,
      at: '2026-08-18T00:00:02.000Z',
    });
    journal.writeAgentSpawned({ agentId: 'second', cacheKey: key, at: '2026-08-18T00:00:03.000Z' });
    journal.writeAgentCompleted({
      agentId: 'second',
      cacheKey: key,
      ok: true,
      result: 'new',
      durationMs: 1,
      at: '2026-08-18T00:00:04.000Z',
    });

    const summary = await journal.readJournal();
    expect(summary?.completedByCacheKey.get(key)?.result).toBe('new');
  });
});

describe('path helpers', () => {
  it('lays the journal under <sessionDir>/workflows/<runId>/', () => {
    const runId = generateWorkflowRunId();
    expect(workflowJournalDir('s/s', runId)).toBe(`s/s/workflows/${runId}`);
    expect(workflowJournalFile('s/s', runId)).toBe(
      `s/s/workflows/${runId}/journal.jsonl`,
    );
    expect(workflowJournalScope('sessions/s-1', runId)).toBe(
      `sessions/s-1/workflows/${runId}`,
    );
  });

  it('rejects a run id that is not a valid wf_ id (path-traversal guard)', () => {
    expect(() => workflowJournalDir('s/s', '../evil' as never)).toThrow();
    expect(() => workflowJournalScope('s/s', 'wf_..' as never)).toThrow();
  });
});

describe('WorkflowJournal', () => {
  it('reads undefined for a run that was never started', async () => {
    const { journal } = makeJournal();
    await expect(journal.readJournal()).resolves.toBeUndefined();
  });

  it('round-trips a full run and folds the summary for resume', async () => {
    const { journal, runId } = makeJournal();
    const sha256 = workflowScriptSha256(SCRIPT);

    journal.writeWorkflowStarted({
      script: SCRIPT,
      scriptSha256: sha256,
      name: 'demo',
      description: 'A demo run',
      phases: [{ title: 'gather' }],
      args: { input: 42 },
      startedAt: '2026-08-14T00:00:00.000Z',
    });
    journal.writePhaseChanged('gather', '2026-08-14T00:00:01.000Z');
    journal.writeAgentSpawned({
      agentId: 'agent-1',
      label: 'collector',
      phase: 'gather',
      at: '2026-08-14T00:00:02.000Z',
    });
    journal.writeAgentCompleted({
      agentId: 'agent-1',
      ok: true,
      result: { summary: 'found 3 files' },
      durationMs: 1250,
      at: '2026-08-14T00:00:03.000Z',
    });
    journal.writeAgentSpawned({
      agentId: 'agent-2',
      phase: 'gather',
      at: '2026-08-14T00:00:04.000Z',
    });
    journal.writeAgentCompleted({
      agentId: 'agent-2',
      ok: false,
      error: 'agent failed',
      durationMs: 500,
      at: '2026-08-14T00:00:05.000Z',
    });
    journal.writeWorkflowCompleted({
      ok: true,
      result: { first: 'found 3 files' },
      completedAt: '2026-08-14T00:00:06.000Z',
    });

    const summary = await journal.readJournal();
    expect(summary).toBeDefined();
    expect(summary).toMatchObject({
      runId,
      script: SCRIPT,
      scriptSha256: sha256,
      name: 'demo',
      description: 'A demo run',
      status: 'completed',
      ok: true,
      startedAt: '2026-08-14T00:00:00.000Z',
      completedAt: '2026-08-14T00:00:06.000Z',
      result: { first: 'found 3 files' },
      phaseTransitions: ['gather'],
    });
    expect(summary?.args).toEqual({ input: 42 });
    expect(summary?.agents).toHaveLength(2);
    expect(summary?.agents[0]).toEqual({
      agentId: 'agent-1',
      label: 'collector',
      phase: 'gather',
      spawnedAt: '2026-08-14T00:00:02.000Z',
      ok: true,
      result: { summary: 'found 3 files' },
      durationMs: 1250,
      completedAt: '2026-08-14T00:00:03.000Z',
    });
    expect(summary?.agents[1]).toMatchObject({
      agentId: 'agent-2',
      phase: 'gather',
      ok: false,
      error: 'agent failed',
      durationMs: 500,
      completedAt: '2026-08-14T00:00:05.000Z',
    });
    // Resume contract: exactly the agents that completed.
    expect(summary?.completedAgentIds).toEqual(['agent-1', 'agent-2']);
  });

  it('derives status running until a completion record arrives', async () => {
    const { journal } = makeJournal();
    journal.writeWorkflowStarted({
      script: SCRIPT,
      scriptSha256: workflowScriptSha256(SCRIPT),
      name: 'demo',
      description: 'still running',
      startedAt: '2026-08-14T00:00:00.000Z',
    });
    journal.writeAgentSpawned({
      agentId: 'agent-1',
      at: '2026-08-14T00:00:01.000Z',
    });

    const summary = await journal.readJournal();
    expect(summary?.status).toBe('running');
    expect(summary?.ok).toBeUndefined();
    expect(summary?.completedAgentIds).toEqual([]);
    expect(summary?.agents[0]).toMatchObject({ agentId: 'agent-1', ok: undefined });
  });

  it('derives a failed terminal status and keeps the error', async () => {
    const { journal } = makeJournal();
    journal.writeWorkflowStarted({
      script: SCRIPT,
      scriptSha256: workflowScriptSha256(SCRIPT),
      name: 'demo',
      description: 'fails',
      startedAt: '2026-08-14T00:00:00.000Z',
    });
    journal.writeWorkflowCompleted({
      ok: false,
      error: 'compile failed',
      completedAt: '2026-08-14T00:00:02.000Z',
    });

    const summary = await journal.readJournal();
    expect(summary?.status).toBe('failed');
    expect(summary?.ok).toBe(false);
    expect(summary?.error).toBe('compile failed');
    expect(summary?.result).toBeUndefined();
  });

  it('orders agents by spawn order even when completions interleave', async () => {
    const { journal } = makeJournal();
    journal.writeWorkflowStarted({
      script: SCRIPT,
      scriptSha256: workflowScriptSha256(SCRIPT),
      name: 'demo',
      description: 'interleaved',
      startedAt: '2026-08-14T00:00:00.000Z',
    });
    journal.writeAgentSpawned({ agentId: 'b', at: '2026-08-14T00:00:01.000Z' });
    journal.writeAgentSpawned({ agentId: 'a', at: '2026-08-14T00:00:02.000Z' });
    journal.writeAgentCompleted({
      agentId: 'b',
      ok: true,
      result: 'b done',
      durationMs: 10,
      at: '2026-08-14T00:00:03.000Z',
    });

    const summary = await journal.readJournal();
    expect(summary?.agents.map((agent) => agent.agentId)).toEqual(['b', 'a']);
    expect(summary?.agents[0]).toMatchObject({ ok: true, result: 'b done' });
    expect(summary?.agents[1]).toMatchObject({ ok: undefined });
  });

  it('recovers a terminal source whose legacy lease is still held', async () => {
    const log = new AppendLogStore(new InMemoryStorageService());
    const runId = 'wf_0123456789abcdef' as const;
    const journal = makeJournalWithLog(log, runId);
    journal.writeWorkflowStarted({
      script: SCRIPT,
      scriptSha256: workflowScriptSha256(SCRIPT),
      name: 'leased',
      description: 'leased source',
      startedAt: '2026-08-14T00:00:00.000Z',
    });
    journal.writeWorkflowCompleted({ ok: true, completedAt: '2026-08-14T00:00:01.000Z' });
    await log.flush();

    const lease = await journal.acquireRunLease();
    await expect(journal.readJournal()).resolves.toMatchObject({
      terminal: 'completed',
      lease: {
        held: true,
        recoverable: true,
        diagnostic: 'terminal-held-lease',
      },
    });
    const claim = await journal.claimResume('wf_fedcba9876543210');
    expect(claim.state).toBe('reserved');
    await claim.release();
    await expect(journal.readJournal()).resolves.toMatchObject({
      terminal: 'completed',
      lease: { held: false },
      resumeClaim: { state: 'released' },
    });
    await lease.finalize();
    await log.close();
  });

  it('reports when a production journal has no physical exclusive lock', async () => {
    const log = new AppendLogStore(new InMemoryStorageService());
    const sourceRunId = 'wf_0123456789abcdef' as const;
    const journal = new WorkflowJournal({
      runId: sourceRunId,
      scope: workflowJournalScope('sessions/s-1', sourceRunId),
      dir: workflowJournalDir('sessions/s-1', sourceRunId),
      log,
    });
    journal.writeWorkflowStarted({
      script: SCRIPT,
      scriptSha256: workflowScriptSha256(SCRIPT),
      name: 'lock capability',
      description: 'lock capability',
      startedAt: '2026-08-14T00:00:00.000Z',
    });
    journal.writeWorkflowCompleted({ ok: true, completedAt: '2026-08-14T00:00:01.000Z' });
    await log.flush();

    await expect(journal.claimResume('wf_fedcba9876543210')).rejects.toThrow(
      'cross-process append-log locks require a filesystem storage backend',
    );
    await log.close();
  });

  it('allows one terminal resume claim and persists the claimed run id after restart', async () => {
    const log = new AppendLogStore(new InMemoryStorageService());
    const sourceRunId = 'wf_0123456789abcdef' as const;
    const claimedRunId = 'wf_fedcba9876543210' as const;
    const journal = makeJournalWithLog(log, sourceRunId);
    journal.writeWorkflowStarted({
      script: SCRIPT,
      scriptSha256: workflowScriptSha256(SCRIPT),
      name: 'claim',
      description: 'claim source',
      startedAt: '2026-08-14T00:00:00.000Z',
    });
    journal.writeWorkflowCompleted({ ok: true, completedAt: '2026-08-14T00:00:01.000Z' });
    await log.flush();

    await expect(journal.claimResume(claimedRunId)).resolves.toMatchObject({
      terminal: 'completed',
      claimedBy: claimedRunId,
      lease: { held: false },
    });
    await expect(journal.claimResume('wf_aaaaaaaaaaaaaaaa')).rejects.toBeInstanceOf(WorkflowRunAlreadyClaimedError);
    await expect(journal.claimResume('wf_aaaaaaaaaaaaaaaa')).rejects.toThrow(claimedRunId);

    const restarted = makeJournalWithLog(log, sourceRunId);
    await expect(restarted.readJournal()).resolves.toMatchObject({
      terminal: 'completed',
      claimedBy: claimedRunId,
    });
    await log.close();
  });

  it('rejects an active source and releases its temporary lease', async () => {
    const log = new AppendLogStore(new InMemoryStorageService());
    const sourceRunId = 'wf_0123456789abcdef' as const;
    const journal = makeJournalWithLog(log, sourceRunId);
    journal.writeWorkflowStarted({
      script: SCRIPT,
      scriptSha256: workflowScriptSha256(SCRIPT),
      name: 'active',
      description: 'active source',
      startedAt: '2026-08-14T00:00:00.000Z',
    });
    await log.flush();

    await expect(journal.claimResume('wf_fedcba9876543210')).rejects.toThrow(/still running/);
    await expect(journal.readJournal()).resolves.toMatchObject({
      status: 'running',
      lease: { held: false },
    });
    await log.close();
  });

  it('serializes concurrent terminal claims so only one resumer succeeds', async () => {
    const log = new AppendLogStore(new InMemoryStorageService());
    const sourceRunId = 'wf_0123456789abcdef' as const;
    const firstRunId = 'wf_fedcba9876543210' as const;
    const secondRunId = 'wf_aaaaaaaaaaaaaaaa' as const;
    let exclusiveHeld = false;
    log.acquireExclusive = async () => {
      if (exclusiveHeld) throw new Error('test exclusive lock is held');
      exclusiveHeld = true;
      return toDisposable(() => {
        exclusiveHeld = false;
      });
    };
    const journal = new WorkflowJournal({
      runId: sourceRunId,
      scope: workflowJournalScope('sessions/s-1', sourceRunId),
      dir: workflowJournalDir('sessions/s-1', sourceRunId),
      log,
    });
    journal.writeWorkflowStarted({
      script: SCRIPT,
      scriptSha256: workflowScriptSha256(SCRIPT),
      name: 'concurrent',
      description: 'concurrent source',
      startedAt: '2026-08-14T00:00:00.000Z',
    });
    journal.writeWorkflowCompleted({ ok: true, completedAt: '2026-08-14T00:00:01.000Z' });
    await log.flush();

    const [first, second] = await Promise.allSettled([
      journal.claimResume(firstRunId),
      journal.claimResume(secondRunId),
    ]);
    expect([first.status, second.status].filter((status) => status === 'fulfilled')).toHaveLength(1);
    const summary = await journal.readJournal();
    expect(summary?.claimedBy).toBe(
      first.status === 'fulfilled' ? firstRunId : secondRunId,
    );
    await log.close();
  });

  it('folds reserved and released claims, then keeps a committed claim permanent across restart', async () => {
    const log = new AppendLogStore(new InMemoryStorageService());
    const sourceRunId = 'wf_0123456789abcdef' as const;
    const firstDestination = 'wf_fedcba9876543210' as const;
    const secondDestination = 'wf_aaaaaaaaaaaaaaaa' as const;
    const journal = makeJournalWithLog(log, sourceRunId);
    journal.writeWorkflowStarted({
      script: SCRIPT,
      scriptSha256: workflowScriptSha256(SCRIPT),
      name: 'claim-state',
      description: 'claim state machine',
      startedAt: '2026-08-14T00:00:00.000Z',
    });
    journal.writeWorkflowCompleted({ ok: true, completedAt: '2026-08-14T00:00:01.000Z' });
    await log.flush();

    const reserved = await journal.claimResume(firstDestination);
    expect(reserved.state).toBe('reserved');
    await reserved.release();
    const afterRelease = makeJournalWithLog(log, sourceRunId);
    await expect(afterRelease.readJournal()).resolves.toMatchObject({
      resumeClaim: { state: 'released', claimedBy: firstDestination },
    });

    const committed = await afterRelease.claimResume(secondDestination);
    await committed.commit();
    await committed.commit();
    await committed.release();
    await committed.release();

    const restarted = makeJournalWithLog(log, sourceRunId);
    await expect(restarted.readJournal()).resolves.toMatchObject({
      resumeClaim: { state: 'committed', claimedBy: secondDestination },
      claimedBy: secondDestination,
    });
    await expect(restarted.claimResume(firstDestination)).rejects.toBeInstanceOf(WorkflowRunAlreadyClaimedError);
    await log.close();
  });

  it('recovers a reserved claim after the destination started when source commit had a flush fault', async () => {
    const storage = new InMemoryStorageService();
    const log = new AppendLogStore(storage);
    const sourceRunId = 'wf_0123456789abcdef' as const;
    const destinationRunId = 'wf_fedcba9876543210' as const;
    const source = makeJournalWithLog(log, sourceRunId);
    source.writeWorkflowStarted({
      script: SCRIPT,
      scriptSha256: workflowScriptSha256(SCRIPT),
      name: 'source',
      description: 'source run',
      startedAt: '2026-08-14T00:00:00.000Z',
    });
    source.writeWorkflowCompleted({ ok: true, completedAt: '2026-08-14T00:00:01.000Z' });
    await log.flush();

    const claim = await source.claimResume(destinationRunId);
    const destination = makeJournalWithLog(log, destinationRunId);
    destination.writeWorkflowStarted({
      script: SCRIPT,
      scriptSha256: workflowScriptSha256(SCRIPT),
      name: 'destination',
      description: 'destination run',
      startedAt: '2026-08-14T00:01:00.000Z',
    });
    await log.flush();

    const flush = log.flush.bind(log);
    let failCommitFlush = true;
    log.flush = async () => {
      if (failCommitFlush) {
        failCommitFlush = false;
        throw new Error('source commit flush fault');
      }
      await flush();
    };
    await expect(claim.commit()).rejects.toThrow('source commit flush fault');

    const restartedLog = new AppendLogStore(storage);
    const restarted = makeJournalWithLog(restartedLog, sourceRunId);
    const recovered = await restarted.claimResume(destinationRunId);
    expect(recovered.state).toBe('committed');
    await recovered.release();
    await expect(restarted.readJournal()).resolves.toMatchObject({
      resumeClaim: { state: 'committed', claimedBy: destinationRunId },
    });

    await log.close();
    await restartedLog.close();
  });

  it('keeps the pre-state-machine resume claim compatible and idempotent for its original owner', async () => {
    const log = new AppendLogStore(new InMemoryStorageService());
    const sourceRunId = 'wf_0123456789abcdef' as const;
    const destinationRunId = 'wf_fedcba9876543210' as const;
    const journal = makeJournalWithLog(log, sourceRunId);
    journal.writeWorkflowStarted({
      script: SCRIPT,
      scriptSha256: workflowScriptSha256(SCRIPT),
      name: 'legacy-claim',
      description: 'legacy claim',
      startedAt: '2026-08-14T00:00:00.000Z',
    });
    journal.writeWorkflowCompleted({ ok: true, completedAt: '2026-08-14T00:00:01.000Z' });
    journal.writeWorkflowResumeClaim(destinationRunId, '2026-08-14T00:00:02.000Z');
    await log.flush();

    const restarted = makeJournalWithLog(log, sourceRunId);
    await expect(restarted.readJournal()).resolves.toMatchObject({
      resumeClaim: { state: 'committed', claimedBy: destinationRunId, legacy: true },
    });
    const sameOwner = await restarted.claimResume(destinationRunId);
    expect(sameOwner.state).toBe('committed');
    await sameOwner.release();
    await expect(restarted.claimResume('wf_aaaaaaaaaaaaaaaa')).rejects.toBeInstanceOf(WorkflowRunAlreadyClaimedError);
    await log.close();
  });

  it('serializes resume claims across independent filesystem stores', async () => {
    const baseDir = await mkdtemp(join(tmpdir(), 'workflow-claim-'));
    try {
      const firstLog = new AppendLogStore(new FileStorageService(baseDir));
      const secondLog = new AppendLogStore(new FileStorageService(baseDir));
      const sourceRunId = 'wf_0123456789abcdef' as const;
      const firstDestination = 'wf_fedcba9876543210' as const;
      const secondDestination = 'wf_aaaaaaaaaaaaaaaa' as const;
      const first = makeJournalWithLog(firstLog, sourceRunId, false);
      first.writeWorkflowStarted({
        script: SCRIPT,
        scriptSha256: workflowScriptSha256(SCRIPT),
        name: 'cross-store',
        description: 'cross-store claim',
        startedAt: '2026-08-14T00:00:00.000Z',
      });
      first.writeWorkflowCompleted({ ok: true, completedAt: '2026-08-14T00:00:01.000Z' });
      await firstLog.flush();

      const second = makeJournalWithLog(secondLog, sourceRunId, false);
      const results = await Promise.allSettled([
        first.claimResume(firstDestination),
        second.claimResume(secondDestination),
      ]);
      const fulfilled = results.filter((result): result is PromiseFulfilledResult<Awaited<ReturnType<WorkflowJournal['claimResume']>>> => result.status === 'fulfilled');
      const rejected = results.filter((result) => result.status === 'rejected');
      expect(fulfilled).toHaveLength(1);
      expect(rejected).toHaveLength(1);
      await fulfilled[0]!.value.release();

      const restarted = makeJournalWithLog(new AppendLogStore(new FileStorageService(baseDir)), sourceRunId, false);
      await expect(restarted.readJournal()).resolves.toMatchObject({ resumeClaim: { state: 'released' } });
      await firstLog.close();
      await secondLog.close();
    } finally {
      await rm(baseDir, { recursive: true, force: true });
    }
  });

  it('keeps the physical lease lock until the release and terminal records are flushed', async () => {
    const baseDir = await mkdtemp(join(tmpdir(), 'workflow-lease-'));
    try {
      const firstLog = new AppendLogStore(new FileStorageService(baseDir));
      const secondLog = new AppendLogStore(new FileStorageService(baseDir));
      const runId = 'wf_0123456789abcdef' as const;
      const first = new WorkflowJournal({
        runId,
        dir: workflowJournalDir('sessions/s-1', runId),
        scope: workflowJournalScope('sessions/s-1', runId),
        log: firstLog,
      });
      const second = new WorkflowJournal({
        runId,
        dir: workflowJournalDir('sessions/s-1', runId),
        scope: workflowJournalScope('sessions/s-1', runId),
        log: secondLog,
      });
      first.writeWorkflowStarted({
        script: SCRIPT,
        scriptSha256: workflowScriptSha256(SCRIPT),
        name: 'lease-order',
        description: 'lease order',
        startedAt: '2026-08-14T00:00:00.000Z',
      });
      await firstLog.flush();
      const lease = await first.acquireRunLease();
      await lease.release();
      first.writeWorkflowCompleted({ ok: true, completedAt: '2026-08-14T00:00:01.000Z' });
      await first.flush();

      await expect(secondLog.acquireExclusive(first.scope, 'journal.jsonl')).rejects.toMatchObject({
        code: 'storage.locked',
      });
      await lease.finalize();
      const lock = await secondLog.acquireExclusive(first.scope, 'journal.jsonl');
      lock.dispose();

      const records: Array<{ readonly kind?: string }> = [];
      for await (const record of firstLog.read<{ readonly kind?: string }>(first.scope, 'journal.jsonl')) records.push(record);
      const releaseIndex = records.findIndex((record) => record.kind === 'workflow.lease.released');
      const terminalIndex = records.findIndex((record) => record.kind === 'workflow.completed');
      expect(releaseIndex).toBeGreaterThanOrEqual(0);
      expect(terminalIndex).toBeGreaterThan(releaseIndex);
      await firstLog.close();
      await secondLog.close();
    } finally {
      await rm(baseDir, { recursive: true, force: true });
    }
  });

  it('retries a failed release flush before releasing the physical lock', async () => {
    const baseDir = await mkdtemp(join(tmpdir(), 'workflow-lease-retry-'));
    try {
      const firstLog = new AppendLogStore(new FileStorageService(baseDir));
      const secondLog = new AppendLogStore(new FileStorageService(baseDir));
      const runId = 'wf_0123456789abcdef' as const;
      const journal = new WorkflowJournal({
        runId,
        dir: workflowJournalDir('sessions/s-1', runId),
        scope: workflowJournalScope('sessions/s-1', runId),
        log: firstLog,
      });
      const lease = await journal.acquireRunLease();
      const flush = firstLog.flush.bind(firstLog);
      let fail = true;
      firstLog.flush = async () => {
        if (fail) {
          fail = false;
          throw new Error('release flush fault');
        }
        await flush();
      };

      await expect(lease.release()).rejects.toThrow('release flush fault');
      expect(lease.state).toBe('held');
      await expect(secondLog.acquireExclusive(journal.scope, 'journal.jsonl')).rejects.toMatchObject({
        code: 'storage.locked',
      });

      await lease.finalize();
      expect(lease.state).toBe('released');
      const lock = await secondLog.acquireExclusive(journal.scope, 'journal.jsonl');
      lock.dispose();

      const records: Array<{ readonly kind?: string }> = [];
      for await (const record of firstLog.read<{ readonly kind?: string }>(journal.scope, 'journal.jsonl')) records.push(record);
      expect(records.filter((record) => record.kind === 'workflow.lease.released')).toHaveLength(1);
      await firstLog.close();
      await secondLog.close();
    } finally {
      await rm(baseDir, { recursive: true, force: true });
    }
  });

  it('shares an in-flight release retry across release and finalize calls', async () => {
    const baseDir = await mkdtemp(join(tmpdir(), 'workflow-lease-concurrent-'));
    try {
      const firstLog = new AppendLogStore(new FileStorageService(baseDir));
      const secondLog = new AppendLogStore(new FileStorageService(baseDir));
      const runId = 'wf_0123456789abcdef' as const;
      const journal = new WorkflowJournal({
        runId,
        dir: workflowJournalDir('sessions/s-1', runId),
        scope: workflowJournalScope('sessions/s-1', runId),
        log: firstLog,
      });
      const lease = await journal.acquireRunLease();
      const flush = firstLog.flush.bind(firstLog);
      let flushCalls = 1;
      let releaseFlushStartedResolve!: () => void;
      const releaseFlushStarted = new Promise<void>((resolve) => { releaseFlushStartedResolve = resolve; });
      let allowReleaseFlushResolve!: () => void;
      const allowReleaseFlush = new Promise<void>((resolve) => { allowReleaseFlushResolve = resolve; });
      firstLog.flush = async () => {
        flushCalls++;
        if (flushCalls === 2) throw new Error('initial release flush fault');
        if (flushCalls === 3) {
          releaseFlushStartedResolve();
          await allowReleaseFlush;
        }
        await flush();
      };

      await expect(lease.release()).rejects.toThrow('initial release flush fault');
      const retry = lease.release();
      await releaseFlushStarted;
      const concurrentRetry = lease.release();
      const finalize = lease.finalize();
      expect(concurrentRetry).toBe(retry);
      expect(flushCalls).toBe(3);
      allowReleaseFlushResolve();
      await Promise.all([retry, concurrentRetry, finalize]);
      expect(lease.state).toBe('released');
      expect(flushCalls).toBe(4);

      const lock = await secondLog.acquireExclusive(journal.scope, 'journal.jsonl');
      lock.dispose();
      const records: Array<{ readonly kind?: string }> = [];
      for await (const record of firstLog.read<{ readonly kind?: string }>(journal.scope, 'journal.jsonl')) records.push(record);
      expect(records.filter((record) => record.kind === 'workflow.lease.released')).toHaveLength(1);
      await firstLog.close();
      await secondLog.close();
    } finally {
      await rm(baseDir, { recursive: true, force: true });
    }
  });

  it('keeps the physical lock held across repeated release flush failures', async () => {
    const baseDir = await mkdtemp(join(tmpdir(), 'workflow-lease-repeat-'));
    try {
      const firstLog = new AppendLogStore(new FileStorageService(baseDir));
      const secondLog = new AppendLogStore(new FileStorageService(baseDir));
      const runId = 'wf_0123456789abcdef' as const;
      const journal = new WorkflowJournal({
        runId,
        dir: workflowJournalDir('sessions/s-1', runId),
        scope: workflowJournalScope('sessions/s-1', runId),
        log: firstLog,
      });
      const lease = await journal.acquireRunLease();
      const flush = firstLog.flush.bind(firstLog);
      let failures = 3;
      firstLog.flush = async () => {
        if (failures > 0) {
          failures--;
          throw new Error('persistent release flush fault');
        }
        await flush();
      };

      await expect(lease.release()).rejects.toThrow('persistent release flush fault');
      await expect(lease.finalize()).rejects.toThrow('persistent release flush fault');
      await expect(lease.finalize()).rejects.toThrow('persistent release flush fault');
      expect(lease.state).toBe('held');
      await expect(secondLog.acquireExclusive(journal.scope, 'journal.jsonl')).rejects.toMatchObject({
        code: 'storage.locked',
      });

      firstLog.flush = flush;
      await lease.finalize();
      const lock = await secondLog.acquireExclusive(journal.scope, 'journal.jsonl');
      lock.dispose();
      await firstLog.close();
      await secondLog.close();
    } finally {
      await rm(baseDir, { recursive: true, force: true });
    }
  });
});
