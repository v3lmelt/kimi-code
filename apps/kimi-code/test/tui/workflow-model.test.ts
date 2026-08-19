/**
 * `tui.workflow` model tests — the `workflow.progress` event reducer that feeds
 * `appState.workflowRuns` for the `/workflows` command.
 * Run: pnpm -C apps/kimi-code exec vitest run test/tui/workflow-model.test.ts
 */

import { describe, expect, it } from 'vitest';

import type { WorkflowProgressEvent, WorkflowRunId } from '@moonshot-ai/agent-core-v2';
import {
  applyWorkflowProgressEvent,
  EMPTY_WORKFLOW_RUNS,
  isWorkflowProgressEvent,
  type WorkflowRunsViewState,
} from '#/tui/utils/workflow-model';

const RUN_ID = 'wf_0123456789abcdef';
const AGENT_A = 'agent_a';
const AGENT_B = 'agent_b';

function started(overrides: Partial<Extract<WorkflowProgressEvent, { type: 'workflow.started' }>> = {}): WorkflowProgressEvent {
  return {
    type: 'workflow.started',
    runId: RUN_ID,
    meta: {
      name: 'Refactor build',
      description: 'Rebuild the pipeline',
      phases: [
        { title: 'Research', detail: 'gather constraints' },
        { title: 'Implement' },
      ],
    },
    startedAt: '2026-08-14T00:00:00.000Z',
    ...overrides,
  };
}

function spawnAgent(
  agentId: string,
  phase?: string,
  runId: WorkflowRunId = RUN_ID,
): WorkflowProgressEvent {
  return {
    type: 'workflow.agent_spawned',
    runId,
    agentId,
    label: `agent-${agentId}`,
    ...(phase === undefined ? {} : { phase }),
  };
}

function completeAgent(agentId: string, ok: boolean, durationMs = 1000): WorkflowProgressEvent {
  return { type: 'workflow.agent_completed', runId: RUN_ID, agentId, ok, durationMs };
}

describe('isWorkflowProgressEvent', () => {
  it('narrows the SDK-delivered wire event shape', () => {
    expect(isWorkflowProgressEvent({ type: 'workflow.progress', runId: RUN_ID, event: started() })).toBe(true);
  });

  it('rejects non-progress and malformed events', () => {
    expect(isWorkflowProgressEvent(null)).toBe(false);
    expect(isWorkflowProgressEvent({ type: 'turn.ended' })).toBe(false);
    expect(isWorkflowProgressEvent({ type: 'workflow.progress' })).toBe(false);
    expect(isWorkflowProgressEvent({ type: 'workflow.progress', runId: RUN_ID })).toBe(false);
    expect(isWorkflowProgressEvent({ type: 'workflow.progress', runId: RUN_ID, event: 42 })).toBe(false);
  });
});

describe('applyWorkflowProgressEvent', () => {
  it('creates a run on workflow.started (newest first)', () => {
    const next = applyWorkflowProgressEvent(EMPTY_WORKFLOW_RUNS, started());
    expect(next).toHaveLength(1);
    const run = next[0];
    expect(run?.runId).toBe(RUN_ID);
    expect(run?.name).toBe('Refactor build');
    expect(run?.description).toBe('Rebuild the pipeline');
    expect(run?.phases.map((p) => p.title)).toEqual(['Research', 'Implement']);
    expect(run?.status).toBe('running');
    expect(run?.spawnedAgents).toBe(0);
    expect(run?.completedAgents).toBe(0);
    expect(run?.agents).toEqual([]);
  });

  it('prepends a second started run and leaves the first intact', () => {
    const one = applyWorkflowProgressEvent(EMPTY_WORKFLOW_RUNS, started());
    const two = applyWorkflowProgressEvent(one, started({ runId: 'wf_ffffffffffffffff' }));
    expect(two.map((r) => r.runId)).toEqual(['wf_ffffffffffffffff', RUN_ID]);
  });

  it('is a no-op on re-starting the same run (same reference)', () => {
    const one = applyWorkflowProgressEvent(EMPTY_WORKFLOW_RUNS, started());
    expect(applyWorkflowProgressEvent(one, started())).toBe(one);
  });

  it('updates the active phase on phase_changed', () => {
    let runs = applyWorkflowProgressEvent(EMPTY_WORKFLOW_RUNS, started());
    runs = applyWorkflowProgressEvent(runs, {
      type: 'workflow.phase_changed',
      runId: RUN_ID,
      phase: 'Implement',
    });
    expect(runs[0]?.phase).toBe('Implement');
  });

  it('is a no-op on re-entering the current phase (same reference)', () => {
    let runs = applyWorkflowProgressEvent(EMPTY_WORKFLOW_RUNS, started());
    runs = applyWorkflowProgressEvent(runs, {
      type: 'workflow.phase_changed',
      runId: RUN_ID,
      phase: 'Research',
    });
    expect(applyWorkflowProgressEvent(runs, {
      type: 'workflow.phase_changed',
      runId: RUN_ID,
      phase: 'Research',
    })).toBe(runs);
  });

  it('records spawned agents in order with their phase', () => {
    let runs = applyWorkflowProgressEvent(EMPTY_WORKFLOW_RUNS, started());
    runs = applyWorkflowProgressEvent(runs, spawnAgent(AGENT_A, 'Research'));
    runs = applyWorkflowProgressEvent(runs, spawnAgent(AGENT_B, 'Implement'));
    const run = runs[0];
    expect(run?.spawnedAgents).toBe(2);
    expect(run?.agents.map((a) => [a.agentId, a.phase, a.status])).toEqual([
      [AGENT_A, 'Research', 'running'],
      [AGENT_B, 'Implement', 'running'],
    ]);
  });

  it('marks an agent completed on agent_completed and bumps the counter', () => {
    let runs = applyWorkflowProgressEvent(EMPTY_WORKFLOW_RUNS, started());
    runs = applyWorkflowProgressEvent(runs, spawnAgent(AGENT_A));
    runs = applyWorkflowProgressEvent(runs, completeAgent(AGENT_A, true, 2500));
    const run = runs[0];
    expect(run?.completedAgents).toBe(1);
    expect(run?.agents[0]).toMatchObject({ agentId: AGENT_A, status: 'completed', durationMs: 2500 });
  });

  it('marks an agent failed on a non-ok completion', () => {
    let runs = applyWorkflowProgressEvent(EMPTY_WORKFLOW_RUNS, started());
    runs = applyWorkflowProgressEvent(runs, spawnAgent(AGENT_A));
    runs = applyWorkflowProgressEvent(runs, completeAgent(AGENT_A, false));
    expect(runs[0]?.agents[0]?.status).toBe('failed');
  });

  it('is a no-op when a completion arrives for an unknown agent (same reference)', () => {
    let runs = applyWorkflowProgressEvent(EMPTY_WORKFLOW_RUNS, started());
    runs = applyWorkflowProgressEvent(runs, spawnAgent(AGENT_A));
    expect(applyWorkflowProgressEvent(runs, completeAgent('ghost', true))).toBe(runs);
  });

  it('settles a successful run as completed and marks dangling agents aborted', () => {
    let runs = applyWorkflowProgressEvent(EMPTY_WORKFLOW_RUNS, started());
    runs = applyWorkflowProgressEvent(runs, spawnAgent(AGENT_A, 'Research'));
    runs = applyWorkflowProgressEvent(runs, spawnAgent(AGENT_B, 'Implement'));
    runs = applyWorkflowProgressEvent(runs, completeAgent(AGENT_A, true));
    // AGENT_B was spawned but never completed → aborted on settle.
    runs = applyWorkflowProgressEvent(runs, {
      type: 'workflow.completed',
      runId: RUN_ID,
      ok: true,
      result: { shipped: true },
    });
    const run = runs[0];
    expect(run?.status).toBe('completed');
    expect(run?.result).toEqual({ shipped: true });
    expect(run?.agents[0]?.status).toBe('completed');
    expect(run?.agents[1]?.status).toBe('aborted');
  });

  it('settles a failed run with the error', () => {
    let runs = applyWorkflowProgressEvent(EMPTY_WORKFLOW_RUNS, started());
    runs = applyWorkflowProgressEvent(runs, {
      type: 'workflow.completed',
      runId: RUN_ID,
      ok: false,
      error: 'determinism violation',
    });
    const run = runs[0];
    expect(run?.status).toBe('failed');
    expect(run?.error).toBe('determinism violation');
  });

  it('ignores a late terminal settle (same reference)', () => {
    let runs = applyWorkflowProgressEvent(EMPTY_WORKFLOW_RUNS, started());
    runs = applyWorkflowProgressEvent(runs, {
      type: 'workflow.completed',
      runId: RUN_ID,
      ok: true,
    });
    const settled = runs;
    expect(applyWorkflowProgressEvent(runs, {
      type: 'workflow.completed',
      runId: RUN_ID,
      ok: false,
      error: 'late',
    })).toBe(settled);
  });

  it('ignores events for unknown runs (same reference)', () => {
    const runs: WorkflowRunsViewState = applyWorkflowProgressEvent(EMPTY_WORKFLOW_RUNS, started());
    expect(applyWorkflowProgressEvent(runs, spawnAgent('x', undefined, 'wf_ffffffffffffffff'))).toBe(runs);
    expect(applyWorkflowProgressEvent(runs, {
      type: 'workflow.phase_changed',
      runId: 'wf_ffffffffffffffff',
      phase: 'P',
    })).toBe(runs);
  });
});
