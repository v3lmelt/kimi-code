/**
 * `tools` domain — unit tests for `WorkflowTask`, the background embodiment of
 * a workflow run.
 *
 * Exercises the task lifecycle without real subagents by driving the resume
 * replay path (the resume ledger covers every `agent()` call, so no spawn host
 * runs): the run settles `completed`, the run journal folds a full
 * started → agent.spawned → agent.completed → workflow.completed sequence, and
 * the progress wire ledger records the run + spawn/completion counters. Also
 * covers the failure path (a throwing script settles `failed` with the error
 * surfaced as `stopReason` and the journal's terminal record). The live-spawn
 * tests stub `spawnWorkflowAgent` at the module seam: the spawn is reported
 * while the turn is still in flight (spawned but not completed), and a turn
 * that rejects after the spawn closes the ledger entry with a failed
 * completion for the same agentId.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { SyncDescriptor } from '#/_base/di/descriptors';
import { DisposableStore } from '#/_base/di/lifecycle';
import { TestInstantiationService } from '#/_base/di/test';
import { ILogService } from '#/_base/log/log';
import { WorkflowProgressModel } from '#/agent/workflow/progress/workflowProgress';
import {
  WorkflowJournal,
  workflowAgentCacheKey,
  workflowScriptSha256,
} from '#/agent/workflow/persist/journal';
import { WorkflowTask } from '#/agent/tools/workflow/workflowTask';
import {
  spawnWorkflowAgent,
  type WorkflowSpawnHostDeps,
} from '#/agent/tools/workflow/spawnHost';
import type { AgentTaskSink } from '#/agent/task/types';
import type {
  WorkflowAgentResult,
  WorkflowRunId,
  WorkflowScriptMeta,
} from '#/agent/workflow/types';
import { grandTotal, type TokenUsage } from '#/kosong/contract/usage';
import type { IWireService } from '#/wire/wire';
import { IEventBus } from '#/app/event/eventBus';
import { EventBusService } from '#/app/event/eventBusService';
import { AppendLogStore } from '#/persistence/backends/node-fs/appendLogStore';
import { InMemoryStorageService } from '#/persistence/backends/memory/inMemoryStorageService';
import { IAppendLogStore } from '#/persistence/interface/appendLogStore';
import { IFileSystemStorageService } from '#/persistence/interface/storage';

import { registerTestAgentWire, testWireScope } from '../../../wire/stubs';

// The live-spawn tests stub the spawn host at the module seam; the resume
// replay tests never reach it.
vi.mock('#/agent/tools/workflow/spawnHost', async (importActual) => {
  const actual = await importActual<typeof import('#/agent/tools/workflow/spawnHost')>();
  return { ...actual, spawnWorkflowAgent: vi.fn() };
});

const RUN_ID = 'wf_0123456789abcdef' as WorkflowRunId;

const META: WorkflowScriptMeta = {
  name: 'resume-demo',
  description: 'A demo workflow',
  phases: [{ title: 'gather' }],
};

const SCRIPT = [
  "export const meta = { name: 'resume-demo', description: 'A demo workflow', phases: [{ title: 'gather' }] };",
  'export async function main() {',
  "  const first = await agent('gather');",
  '  return { output: first.output };',
  '}',
].join('\n');

const THROWING_SCRIPT = [
  "export const meta = { name: 'boom', description: 'throws' };",
  'export async function main() {',
  "  throw new Error('boom');",
  '}',
].join('\n');

function makeSink(): {
  readonly sink: AgentTaskSink;
  readonly appendOutput: ReturnType<typeof vi.fn>;
  readonly settle: ReturnType<typeof vi.fn>;
} {
  const appendOutput = vi.fn();
  const settle = vi.fn(async () => true);
  const signal = new AbortController().signal;
  const sink = { signal, appendOutput, settle } as unknown as AgentTaskSink;
  return { sink, appendOutput, settle };
}

describe('WorkflowTask', () => {
  let disposables: DisposableStore;
  let ix: TestInstantiationService;
  let wire: IWireService;
  let logStore: IAppendLogStore;

  function makeJournal(runId: WorkflowRunId = RUN_ID): WorkflowJournal {
    return new WorkflowJournal({
      runId,
      scope: testWireScope('wf', runId),
      dir: `wf-dir/${runId}`,
      log: logStore,
    });
  }

  beforeEach(() => {
    disposables = new DisposableStore();
    ix = disposables.add(new TestInstantiationService());
    ix.stub(IFileSystemStorageService, new InMemoryStorageService());
    ix.set(IAppendLogStore, new SyncDescriptor(AppendLogStore));
    ix.set(IEventBus, new SyncDescriptor(EventBusService));
    logStore = ix.get(IAppendLogStore);
    wire = registerTestAgentWire(ix, testWireScope('wire', 'workflow-task-test'), {
      log: logStore,
      eventBus: ix.get(IEventBus),
    });
  });

  afterEach(() => disposables.dispose());

  it('runs a sequential script to completion via resume replay, journals the run, and settles completed', async () => {
    const journal = makeJournal();
    const task = new WorkflowTask({
      runId: RUN_ID,
      script: SCRIPT,
      scriptSha256: workflowScriptSha256(SCRIPT),
      name: META.name,
      description: 'Workflow: resume-demo',
      phases: META.phases,
      args: undefined,
      meta: META,
      tokenBudgetTotal: 1000,
      journal,
      wire,
      telemetry: { launched: vi.fn(), completed: vi.fn() },
      log: { info: vi.fn(), warn: vi.fn() } as unknown as ILogService,
      spawnDeps: {} as unknown as WorkflowSpawnHostDeps,
      parentToolCallId: 'tc-1',
      resume: {
        sourceRunId: RUN_ID,
        completedByCacheKey: new Map([
          [
            workflowAgentCacheKey('gather', undefined),
            {
              agentId: 'a1',
              spawnedAt: '2026-01-01T00:00:00.000Z',
              ok: true,
              result: 'cached-summary',
              durationMs: 5,
            },
          ],
        ]),
      },
    });

    const { sink, appendOutput, settle } = makeSink();
    await task.start(sink);

    expect(settle).toHaveBeenCalledWith({ status: 'completed' });
    expect(appendOutput).toHaveBeenCalledWith(
      expect.stringContaining('Workflow completed: resume-demo'),
    );

    const progress = wire.getModel(WorkflowProgressModel);
    const run = progress.get(RUN_ID);
    expect(run?.status).toBe('completed');
    expect(run?.spawnedAgents).toBe(1);
    expect(run?.completedAgents).toBe(1);

    await logStore.flush();
    const summary = await journal.readJournal();
    expect(summary?.status).toBe('completed');
    expect(summary?.name).toBe('resume-demo');
    expect(summary?.agents).toHaveLength(1);
    expect(summary?.agents[0]?.result).toBe('cached-summary');
    expect(summary?.agents[0]?.ok).toBe(true);
    expect(summary?.completedAgentIds).toEqual(['a1']);
    expect(summary?.lease).toEqual({ state: 'available', held: false });
  });

  it('settles failed when the script throws and journals the terminal failure', async () => {
    const journal = makeJournal();
    const task = new WorkflowTask({
      runId: RUN_ID,
      script: THROWING_SCRIPT,
      scriptSha256: workflowScriptSha256(THROWING_SCRIPT),
      name: 'boom',
      description: 'Workflow: boom',
      meta: { name: 'boom', description: 'throws' },
      tokenBudgetTotal: 1000,
      journal,
      wire,
      telemetry: { launched: vi.fn(), completed: vi.fn() },
      log: { info: vi.fn(), warn: vi.fn() } as unknown as ILogService,
      spawnDeps: {} as unknown as WorkflowSpawnHostDeps,
      parentToolCallId: 'tc-1',
    });

    const { sink, settle } = makeSink();
    await task.start(sink);

    // The vm sandbox re-contextifies a thrown Error, so the message surfaces
    // with the host-side `Error: ` prefix.
    expect(settle).toHaveBeenCalledWith({ status: 'failed', stopReason: expect.stringContaining('boom') });

    const progress = wire.getModel(WorkflowProgressModel);
    expect(progress.get(RUN_ID)?.status).toBe('failed');

    await logStore.flush();
    const summary = await journal.readJournal();
    expect(summary?.status).toBe('failed');
    expect(summary?.error).toContain('boom');
    expect(summary?.completedAgentIds).toEqual([]);
  });

  it('a cache-key miss on resume spawns live; the hit replays from cache', async () => {
    const spawned: string[] = [];
    vi.mocked(spawnWorkflowAgent).mockImplementation(
      async (_deps, prompt, _opts, _signal, _parentToolCallId, hooks) => {
        spawned.push(prompt);
        hooks?.onSpawned?.(`live-${String(spawned.length)}`);
        return {
          ok: true,
          agentId: `live-${String(spawned.length)}`,
          output: `fresh:${prompt}`,
          durationMs: 0,
        };
      },
    );

    const TWO_STEP_SCRIPT = [
      "export const meta = { name: 'two-step', description: 'x' };",
      'export async function main() {',
      "  const a = await agent('step one');",
      "  const b = await agent('step two');",
      '  return [a.output, b.output];',
      '}',
    ].join('\n');

    const journal = makeJournal();
    const task = new WorkflowTask({
      runId: RUN_ID,
      script: TWO_STEP_SCRIPT,
      scriptSha256: workflowScriptSha256(TWO_STEP_SCRIPT),
      name: 'two-step',
      description: 'Workflow: two-step',
      meta: { name: 'two-step', description: 'x' },
      tokenBudgetTotal: 1000,
      journal,
      wire,
      telemetry: { launched: vi.fn(), completed: vi.fn() },
      log: { info: vi.fn(), warn: vi.fn() } as unknown as ILogService,
      spawnDeps: {} as unknown as WorkflowSpawnHostDeps,
      parentToolCallId: 'tc-1',
      resume: {
        sourceRunId: RUN_ID,
        completedByCacheKey: new Map([
          [
            workflowAgentCacheKey('step two', undefined),
            {
              agentId: 'cached-2',
              spawnedAt: '2026-01-01T00:00:00.000Z',
              ok: true,
              result: 'cached-two',
              durationMs: 5,
            },
          ],
        ]),
      },
    });

    const { sink, appendOutput, settle } = makeSink();
    await task.start(sink);

    expect(settle).toHaveBeenCalledWith({ status: 'completed' });
    // Only the cache-missing call spawned live; the hit replayed regardless of
    // position in the script.
    expect(spawned).toEqual(['step one']);
    expect(appendOutput).toHaveBeenCalledWith(
      expect.stringContaining('cached-two'),
    );

    await logStore.flush();
    const summary = await journal.readJournal();
    expect(summary?.status).toBe('completed');
    expect(summary?.agents).toHaveLength(2);
    expect(summary?.completedByCacheKey.get(workflowAgentCacheKey('step two', undefined))?.result)
      .toBe('cached-two');
  });

  it('exposes workflow display facts on the task info record', () => {
    const task = new WorkflowTask({
      runId: RUN_ID,
      script: SCRIPT,
      scriptSha256: workflowScriptSha256(SCRIPT),
      name: META.name,
      description: 'Workflow: resume-demo',
      meta: META,
      tokenBudgetTotal: 1000,
      journal: makeJournal(),
      wire,
      telemetry: { launched: vi.fn(), completed: vi.fn() },
      log: { info: vi.fn(), warn: vi.fn() } as unknown as ILogService,
      spawnDeps: {} as unknown as WorkflowSpawnHostDeps,
      parentToolCallId: 'tc-1',
    });

    const info = task.toInfo({
      taskId: 'wf-task-abcdef12',
      description: 'Workflow: resume-demo',
      status: 'running',
      detached: true,
      startedAt: 1,
      endedAt: null,
    });
    expect(info.kind).toBe('workflow');
    expect(info.runId).toBe(RUN_ID);
    expect(info.workflowName).toBe('resume-demo');
    expect(info.scriptSha256).toBe(workflowScriptSha256(SCRIPT));
  });

  it('reports the spawn when the child agent exists and the completion when its turn ends', async () => {
    const usage: TokenUsage = {
      inputOther: 20,
      output: 5,
      inputCacheRead: 3,
      inputCacheCreation: 2,
    };
    const onSubagentUsage = vi.fn();
    let resolveSpawn!: (result: WorkflowAgentResult & { readonly usage?: TokenUsage }) => void;
    const spawnPending = new Promise<void>((resolve) => {
      vi.mocked(spawnWorkflowAgent).mockImplementation(
        async (_deps, _prompt, _opts, _signal, _parentToolCallId, hooks) => {
          hooks?.onSpawned?.('live-1');
          resolve();
          return await new Promise<WorkflowAgentResult & { readonly usage?: TokenUsage }>((res) => {
            resolveSpawn = res;
          });
        },
      );
    });

    const journal = makeJournal();
    const task = new WorkflowTask({
      runId: RUN_ID,
      script: SCRIPT,
      scriptSha256: workflowScriptSha256(SCRIPT),
      name: META.name,
      description: 'Workflow: resume-demo',
      meta: META,
      tokenBudgetTotal: 1000,
      journal,
      wire,
      telemetry: { launched: vi.fn(), completed: vi.fn() },
      log: { info: vi.fn(), warn: vi.fn() } as unknown as ILogService,
      spawnDeps: {} as unknown as WorkflowSpawnHostDeps,
      parentToolCallId: 'tc-1',
      onSubagentUsage,
    });

    const dispatch = vi.spyOn(wire, 'dispatch');
    const { sink, settle } = makeSink();
    const startPromise = task.start(sink);

    // The spawn is reported while the turn is still in flight: the progress
    // ledger counts the agent as spawned but not yet completed.
    await spawnPending;
    const progress = wire.getModel(WorkflowProgressModel);
    expect(progress.get(RUN_ID)?.spawnedAgents).toBe(1);
    expect(progress.get(RUN_ID)?.completedAgents).toBe(0);

    resolveSpawn({ ok: true, agentId: 'live-1', output: 'fresh-summary', durationMs: 0, usage });
    await startPromise;

    expect(settle).toHaveBeenCalledWith({ status: 'completed' });
    // Re-fetch the model: the handle captured mid-flight is a snapshot.
    const settled = wire.getModel(WorkflowProgressModel);
    expect(settled.get(RUN_ID)?.spawnedAgents).toBe(1);
    expect(settled.get(RUN_ID)?.completedAgents).toBe(1);
    expect(onSubagentUsage).toHaveBeenCalledTimes(1);
    expect(onSubagentUsage).toHaveBeenCalledWith(usage);
    expect(dispatch).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'workflow.completed',
        payload: expect.objectContaining({ tokensSpent: grandTotal(usage) }),
      }),
    );

    await logStore.flush();
    const summary = await journal.readJournal();
    expect(summary?.agents).toHaveLength(1);
    expect(summary?.agents[0]?.result).toBe('fresh-summary');
    expect(summary?.completedAgentIds).toEqual(['live-1']);
  });

  it('records a failed completion for the spawned agentId when the turn rejects after spawn', async () => {
    vi.mocked(spawnWorkflowAgent).mockImplementation(
      async (_deps, _prompt, _opts, _signal, _parentToolCallId, hooks) => {
        hooks?.onSpawned?.('live-1');
        throw new Error('turn exploded');
      },
    );

    const journal = makeJournal();
    const task = new WorkflowTask({
      runId: RUN_ID,
      script: SCRIPT,
      scriptSha256: workflowScriptSha256(SCRIPT),
      name: META.name,
      description: 'Workflow: resume-demo',
      meta: META,
      tokenBudgetTotal: 1000,
      journal,
      wire,
      telemetry: { launched: vi.fn(), completed: vi.fn() },
      log: { info: vi.fn(), warn: vi.fn() } as unknown as ILogService,
      spawnDeps: {} as unknown as WorkflowSpawnHostDeps,
      parentToolCallId: 'tc-1',
    });

    const { sink, settle } = makeSink();
    await task.start(sink);

    // A single failed spawn does not abort the run; the ledger entry opened by
    // the spawn report is closed by a failed completion for the same agentId.
    expect(settle).toHaveBeenCalledWith({ status: 'completed' });
    const progress = wire.getModel(WorkflowProgressModel);
    expect(progress.get(RUN_ID)?.spawnedAgents).toBe(1);
    expect(progress.get(RUN_ID)?.completedAgents).toBe(1);

    await logStore.flush();
    const summary = await journal.readJournal();
    expect(summary?.status).toBe('completed');
    expect(summary?.agents).toHaveLength(1);
    expect(summary?.agents[0]?.ok).toBe(false);
    expect(summary?.agents[0]?.error).toBe('turn exploded');
    expect(summary?.completedAgentIds).toEqual(['live-1']);
  });
});
