/**
 * Tests for the TUI workflow progress ledger (`utils/workflow-model.ts`) and
 * the `/workflows` report builder (`commands/workflows.ts`).
 *
 * The model tests fold `WorkflowProgressEvent` sequences into the run ledger:
 * spawn/completion counters, the new per-agent display fields (model / tokens
 * / summary), narrator `workflow.log` lines, terminal stats, and the
 * reference-stability gate the `setAppState` fast path relies on.
 *
 * The builder tests assert the shape of the rendered tree (run status badge,
 * animated meter cells, per-agent model/tokens/duration facts, log lines)
 * with the colour functions stubbed to identity so expectations are plain
 * text.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { WorkflowProgressEvent } from '@moonshot-ai/agent-core-v2';

// The theme singleton is read at render time; stub the colour functions to
// identity so assertions see plain text.
vi.mock('#/tui/theme', () => ({
  currentTheme: {
    fg: (_token: string, text: string) => text,
    boldFg: (_token: string, text: string) => text,
  },
}));

import {
  applyWorkflowProgressEvent,
  EMPTY_WORKFLOW_RUNS,
  WORKFLOW_LEDGER_LIMITS,
  type WorkflowRunView,
} from '#/tui/utils/workflow-model';
import { mergeWorkflowTaskSnapshots, projectRuntimeCenter } from '#/tui/utils/runtime-center-model';
import { buildWorkflowReportLines } from '#/tui/commands/workflows';

const RUN_ID = 'wf_0123456789abcdef';

function startedEvent(): Extract<WorkflowProgressEvent, { type: 'workflow.started' }> {
  return {
    type: 'workflow.started',
    runId: RUN_ID,
    meta: {
      name: 'demo-run',
      description: 'A demo workflow',
      phases: [{ title: 'Review' }, { title: 'Action' }],
    },
    startedAt: new Date(Date.now() - 5_000).toISOString(),
  };
}

function runningLedger(): ReturnType<typeof applyWorkflowProgressEvent> {
  return applyWorkflowProgressEvent(EMPTY_WORKFLOW_RUNS, startedEvent());
}

describe('applyWorkflowProgressEvent', () => {
  it('folds spawn and completion with model/tokens/summary onto the agent row', () => {
    let runs = runningLedger();
    runs = applyWorkflowProgressEvent(runs, {
      type: 'workflow.agent_spawned',
      runId: RUN_ID,
      agentId: 'a1',
      label: 'review:arch',
      phase: 'Review',
    });
    runs = applyWorkflowProgressEvent(runs, {
      type: 'workflow.agent_completed',
      runId: RUN_ID,
      agentId: 'a1',
      ok: true,
      durationMs: 1234,
      model: 'k2-fast',
      tokens: 4321,
      summary: 'found 2 issues',
    });

    const run = runs[0];
    expect(run?.spawnedAgents).toBe(1);
    expect(run?.completedAgents).toBe(1);
    expect(run?.agents[0]).toMatchObject({
      agentId: 'a1',
      status: 'completed',
      durationMs: 1234,
      model: 'k2-fast',
      tokens: 4321,
      summary: 'found 2 issues',
    });
  });

  it('appends narrator log lines while the run is live', () => {
    let runs = runningLedger();
    runs = applyWorkflowProgressEvent(runs, {
      type: 'workflow.log',
      runId: RUN_ID,
      message: '3/10 found, 250k remaining',
    });
    runs = applyWorkflowProgressEvent(runs, {
      type: 'workflow.log',
      runId: RUN_ID,
      message: 'fanning out fixes',
    });
    expect(runs[0]?.logLines).toEqual(['3/10 found, 250k remaining', 'fanning out fixes']);
  });

  it('stops accepting log lines once the run settles', () => {
    let runs = runningLedger();
    runs = applyWorkflowProgressEvent(runs, {
      type: 'workflow.completed',
      runId: RUN_ID,
      ok: true,
      result: null,
    });
    runs = applyWorkflowProgressEvent(runs, {
      type: 'workflow.log',
      runId: RUN_ID,
      message: 'late log',
    });
    expect(runs[0]?.logLines).toEqual([]);
  });

  it('carries terminal duration and tokens onto the settled run and aborts dangling agents', () => {
    let runs = runningLedger();
    runs = applyWorkflowProgressEvent(runs, {
      type: 'workflow.agent_spawned',
      runId: RUN_ID,
      agentId: 'a1',
    });
    runs = applyWorkflowProgressEvent(runs, {
      type: 'workflow.completed',
      runId: RUN_ID,
      ok: true,
      result: { done: true },
      agentsSpawned: 1,
      tokensSpent: 12000,
      durationMs: 6100,
    });
    const run = runs[0];
    expect(run?.status).toBe('completed');
    expect(run?.durationMs).toBe(6100);
    expect(run?.tokensSpent).toBe(12000);
    expect(run?.agents[0]?.status).toBe('aborted');
  });

  it('returns the same array reference for unknown runs and no-op events', () => {
    const event = startedEvent();
    const runs = applyWorkflowProgressEvent(EMPTY_WORKFLOW_RUNS, event);
    expect(
      applyWorkflowProgressEvent(runs, {
        type: 'workflow.log',
        runId: 'wf_ffffffffffffffff',
        message: 'nope',
      }),
    ).toBe(runs);
    expect(applyWorkflowProgressEvent(runs, event)).toBe(runs);
  });

  it('folds optional node, identity, replay, and isolation fields without changing legacy events', () => {
    const runs = applyWorkflowProgressEvent(EMPTY_WORKFLOW_RUNS, {
      ...startedEvent(),
      taskId: 'task-1',
      taskPath: 'main/wf-1',
      nodeId: 'root',
      model: 'k2',
      isolationLease: 'lease-1',
      worktreePath: 'C:/worktree',
    });
    const next = applyWorkflowProgressEvent(runs, {
      type: 'workflow.agent_spawned',
      runId: RUN_ID,
      agentId: 'a1',
      nodeId: 'node-a',
      taskPath: 'main/wf-1/node-a',
      cache: 'hit',
      replayed: true,
    });
    expect(next[0]).toMatchObject({ taskId: 'task-1', nodeId: 'root', model: 'k2' });
    expect(next[0]?.agents[0]).toMatchObject({
      nodeId: 'node-a', taskPath: 'main/wf-1/node-a', cache: 'hit', replayed: true,
    });
  });

  it('bounds runs, agents, logs, and observed node identities', () => {
    let runs = EMPTY_WORKFLOW_RUNS;
    for (let index = 0; index < WORKFLOW_LEDGER_LIMITS.runs + 5; index += 1) {
      runs = applyWorkflowProgressEvent(runs, {
        ...startedEvent(),
        runId: `wf_${String(index)}`,
        nodeId: `node-${String(index)}`,
      });
    }
    expect(runs).toHaveLength(WORKFLOW_LEDGER_LIMITS.runs);
    let run = runs[0];
    expect(run).toBeDefined();
    for (let index = 0; index < WORKFLOW_LEDGER_LIMITS.agents + 5; index += 1) {
      run = applyWorkflowProgressEvent(runs, {
        type: 'workflow.agent_spawned',
        runId: run!.runId as `wf_${string}`,
        agentId: `agent-${String(index)}`,
        nodeId: `node-agent-${String(index)}`,
      })[0];
      runs = run === undefined ? runs : [run, ...runs.slice(1)];
    }
    for (let index = 0; index < WORKFLOW_LEDGER_LIMITS.logs + 5; index += 1) {
      runs = applyWorkflowProgressEvent(runs, {
        type: 'workflow.log',
        runId: run!.runId as `wf_${string}`,
        message: `${String(index)} ${'x'.repeat(WORKFLOW_LEDGER_LIMITS.logLineCharacters + 10)}`,
      });
    }
    const bounded = runs[0]!;
    expect(bounded.agents.length).toBeLessThanOrEqual(WORKFLOW_LEDGER_LIMITS.agents);
    expect(bounded.logLines.length).toBe(WORKFLOW_LEDGER_LIMITS.logs);
    expect(bounded.logLines.every((line) => line.length <= WORKFLOW_LEDGER_LIMITS.logLineCharacters)).toBe(true);
    expect(bounded.nodeIds?.length).toBeLessThanOrEqual(WORKFLOW_LEDGER_LIMITS.nodes);
  });
});

describe('runtime center projection', () => {
  it('merges task snapshots and started events in either arrival order', () => {
    const task = {
      taskId: 'task-order', kind: 'workflow', runId: RUN_ID, workflowName: 'snapshot-name',
      description: 'snapshot description', status: 'completed', startedAt: Date.now() - 1000,
      endedAt: Date.now(), meta: {
        name: 'snapshot-meta', description: 'snapshot meta', phases: [{ title: 'Snapshot' }],
      },
    } as never;
    const started: Extract<WorkflowProgressEvent, { type: 'workflow.started' }> = {
      ...startedEvent(),
      meta: {
        name: 'live-name', description: 'live description', phases: [{ title: 'Live' }],
      },
    };

    const startedAfterSnapshot = applyWorkflowProgressEvent(
      mergeWorkflowTaskSnapshots([], [task]),
      started,
    )[0];
    expect(startedAfterSnapshot).toMatchObject({
      taskId: 'task-order',
      name: 'live-name',
      description: 'live description',
      phases: [{ title: 'Live' }],
      status: 'completed',
    });

    const snapshotAfterStarted = mergeWorkflowTaskSnapshots(
      applyWorkflowProgressEvent([], started),
      [task],
    )[0];
    expect(snapshotAfterStarted).toMatchObject({
      taskId: 'task-order',
      name: 'live-name',
      description: 'live description',
      phases: [{ title: 'Live' }],
      status: 'completed',
    });
  });

  it('uses the same task snapshot fallback for replay and live task updates', () => {
    const task = {
      taskId: 'task-wf', kind: 'workflow', runId: RUN_ID, workflowName: 'demo-run',
      description: 'A demo workflow', status: 'completed', startedAt: Date.now() - 1000,
      endedAt: Date.now(), agentsSpawned: 2, tokensSpent: 99,
    } as never;
    const runs = mergeWorkflowTaskSnapshots([], [task]);
    expect(runs[0]).toMatchObject({ runId: RUN_ID, name: 'demo-run', status: 'completed', tokensSpent: 99 });
    const projection = projectRuntimeCenter({ tasks: [task], workflows: runs });
    expect(projection.workflows[0]).toMatchObject({ runId: RUN_ID, taskId: 'task-wf', status: 'completed' });
    expect(projection.workflows[0]?.actions.resume).toMatchObject({ enabled: false });
    expect(projection.workflows[0]?.actions.retry.reason).toContain('not exposed');
  });

  it('folds task metadata through the real workflow.started shape', () => {
    const task = {
      taskId: 'task-wf-meta', kind: 'workflow', runId: RUN_ID, workflowName: 'fallback-name',
      description: 'fallback description', status: 'running', startedAt: Date.now() - 1000,
      endedAt: null, meta: {
        name: 'real-name', description: 'real description',
        phases: [{ title: 'Plan', detail: 'prepare' }],
      },
    } as never;
    const run = mergeWorkflowTaskSnapshots([], [task])[0];
    expect(run).toMatchObject({
      runId: RUN_ID,
      name: 'real-name',
      description: 'real description',
      status: 'running',
      phases: [{ title: 'Plan', detail: 'prepare' }],
    });
  });

  it('maps an agent output action to its explicit owning task', () => {
    const run = runningLedger()[0]!;
    const withAgent = applyWorkflowProgressEvent([run], {
      type: 'workflow.agent_spawned',
      runId: RUN_ID,
      agentId: 'agent-owned',
      taskId: 'task-owned',
    });
    const projection = projectRuntimeCenter({ tasks: [], workflows: withAgent });
    expect(projection.agents.find((agent) => agent.agentId === 'agent-owned')).toMatchObject({
      taskId: 'task-owned',
      actions: { output: { enabled: true } },
    });

    const workflowOwnedRun = applyWorkflowProgressEvent(EMPTY_WORKFLOW_RUNS, {
      ...startedEvent(),
      taskId: 'task-workflow-owner',
    });
    const workflowOwnedWithAgent = applyWorkflowProgressEvent(workflowOwnedRun, {
      type: 'workflow.agent_spawned',
      runId: RUN_ID,
      agentId: 'agent-run-owned',
    });
    const workflowOwnedProjection = projectRuntimeCenter({
      tasks: [],
      workflows: workflowOwnedWithAgent,
    });
    expect(workflowOwnedProjection.agents.find((agent) => agent.agentId === 'agent-run-owned')).toMatchObject({
      taskId: 'task-workflow-owner',
      actions: { output: { enabled: true } },
    });

    const orphanProjection = projectRuntimeCenter({
      tasks: [],
      workflows: [runningLedger()[0]!],
      agentMetadata: { orphan: { type: 'sub' } },
    });
    expect(orphanProjection.agents.find((agent) => agent.agentId === 'orphan')?.actions.output).toMatchObject({
      enabled: false,
    });
  });
});

describe('buildWorkflowReportLines', () => {
  beforeEach(() => {
    vi.useRealTimers();
  });

  function demoRun(overrides: Partial<WorkflowRunView> = {}): WorkflowRunView {
    return {
      runId: RUN_ID,
      name: 'demo-run',
      description: 'A demo workflow',
      phases: [{ title: 'Review' }],
      status: 'running',
      phase: 'Review',
      spawnedAgents: 2,
      completedAgents: 1,
      startedAt: new Date(Date.now() - 30_000).toISOString(),
      agents: [
        {
          agentId: 'a1',
          label: 'review:arch',
          phase: 'Review',
          status: 'completed',
          durationMs: 1234,
          model: 'k2-fast',
          tokens: 4321,
          summary: 'found 2 issues',
        },
        {
          agentId: 'a2',
          label: 'review:security',
          phase: 'Review',
          status: 'running',
        },
      ],
      logLines: ['3/10 found'],
      ...overrides,
    };
  }

  it('renders the run header with an animated meter, stats and agent facts', () => {
    const lines = buildWorkflowReportLines([demoRun()]);
    const text = lines.join('\n');
    expect(text).toContain('demo-run');
    expect(text).toContain('running');
    // The animated meter: solid cells + a braille spinner frame + dim empties.
    expect(text).toMatch(/[⣿⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]/);
    expect(text).toContain('1/2 agents');
    expect(text).toContain('phase: Review');
    expect(text).toContain('4.3k tok');
    // Agent row facts: model · tokens · duration + summary.
    expect(text).toContain('k2-fast');
    expect(text).toContain('found 2 issues');
    // Narrator log line.
    expect(text).toContain('3/10 found');
  });

  it('renders a completed run without the meter and with terminal stats', () => {
    const lines = buildWorkflowReportLines([
      demoRun({
        status: 'completed',
        durationMs: 6100,
        tokensSpent: 12000,
        phase: undefined,
        agents: [],
        logLines: [],
      }),
    ]);
    const text = lines.join('\n');
    expect(text).toContain('completed');
    expect(text).not.toContain('running');
    expect(text).toContain('12.0k tok');
  });

  it('renders the empty ledger message', () => {
    expect(buildWorkflowReportLines([]).join('\n')).toContain('No workflow runs');
  });
});
