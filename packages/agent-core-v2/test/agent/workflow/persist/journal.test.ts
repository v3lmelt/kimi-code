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

import { AppendLogStore } from '#/persistence/backends/node-fs/appendLogStore';
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
  });
  return { journal, runId };
}

function makeJournalWithLog(log: AppendLogStore, runId = generateWorkflowRunId()): WorkflowJournal {
  return new WorkflowJournal({
    runId,
    scope: workflowJournalScope('sessions/s-1', runId),
    dir: workflowJournalDir('sessions/s-1', runId),
    log,
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

  it('rejects a terminal resume while the source journal lease is held', async () => {
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
    await expect(journal.claimResume('wf_fedcba9876543210')).rejects.toThrow(/already leased/);
    await expect(journal.readJournal()).resolves.toMatchObject({
      terminal: 'completed',
      lease: { held: true },
    });
    lease.dispose();
    await expect(journal.readJournal()).resolves.toMatchObject({ lease: { held: false } });
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
    const journal = makeJournalWithLog(log, sourceRunId);
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
});
