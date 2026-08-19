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
  type WorkflowRunView,
} from '#/tui/utils/workflow-model';
import { buildWorkflowReportLines } from '#/tui/commands/workflows';

const RUN_ID = 'wf_0123456789abcdef';

function startedEvent(): WorkflowProgressEvent {
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
    const runs = runningLedger();
    expect(
      applyWorkflowProgressEvent(runs, {
        type: 'workflow.log',
        runId: 'wf_ffffffffffffffff',
        message: 'nope',
      }),
    ).toBe(runs);
    expect(applyWorkflowProgressEvent(runs, startedEvent())).toBe(runs);
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
