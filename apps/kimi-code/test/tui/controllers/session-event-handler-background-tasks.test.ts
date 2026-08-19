import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import type { Event } from '@moonshot-ai/kimi-code-sdk';

import { SessionEventHandler } from '#/tui/controllers/session-event-handler';
import { getBuiltInPalette } from '#/tui/theme';

/**
 * Background-task event handling tests. `background.task.started` /
 * `background.task.terminated` must (a) update the footer's compact badge via
 * `setBackgroundCounts` and (b) refresh the per-agent/process rows via
 * `setRunningAgents` so a background job is visible the moment it starts and
 * disappears when it terminates.
 */
function makeHost() {
  const session = { id: 's1' };
  const host = {
    state: {
      appState: {
        sessionId: 's1',
        streamingPhase: 'idle',
        model: 'kimi-model',
        permissionMode: 'manual',
        workflowRuns: [],
      },
      queuedMessages: [],
      queuedMessageDispatchPending: false,
      theme: { palette: getBuiltInPalette('dark') },
      toolOutputExpanded: false,
      todoPanel: { getTodos: vi.fn(() => []) },
      transcriptContainer: { addChild: vi.fn() },
      ui: { requestRender: vi.fn() },
      tasksBrowser: undefined,
      footer: { setRunningAgents: vi.fn(), setBackgroundCounts: vi.fn() },
    },
    session,
    aborted: false,
    sessionEventUnsubscribe: undefined,
    streamingUI: {
      setTurnId: vi.fn(),
      getTurnContext: vi.fn(() => ({ turnId: 1, step: 0 })),
      markSubagentBackgrounded: vi.fn(),
      applyBackgroundTaskTerminalStatus: vi.fn(),
    },
    requireSession: vi.fn(() => session),
    setAppState: vi.fn(),
    patchLivePane: vi.fn(),
    resetLivePane: vi.fn(),
    showError: vi.fn(),
    showStatus: vi.fn(),
    showNotice: vi.fn(),
    track: vi.fn(),
    recordSessionActivity: vi.fn(),
    noteStepUsage: vi.fn(),
    noteCompactionFinished: vi.fn(),
    mountEditorReplacement: vi.fn(),
    restoreEditor: vi.fn(),
    restoreInputText: vi.fn(),
    appendTranscriptEntry: vi.fn(),
    sendNormalUserInput: vi.fn(),
    sendQueuedMessage: vi.fn(),
    shiftQueuedMessage: vi.fn(),
    btwPanelController: { routeEvent: vi.fn(() => false) },
    tasksBrowserController: { repaint: vi.fn(), refreshOutputViewer: vi.fn() },
  };
  host.setAppState.mockImplementation((patch: Record<string, unknown>) => {
    Object.assign(host.state.appState, patch);
  });
  return { host: host as any, session };
}

function agentStartedEvent(taskId: string) {
  return {
    type: 'background.task.started',
    sessionId: 's1',
    agentId: 'main',
    info: {
      taskId,
      kind: 'agent',
      agentId: 'a1',
      subagentType: 'researcher',
      description: 'research the workspace',
      status: 'running',
      startedAt: Date.now(),
      endedAt: null,
    },
  } as const;
}

function agentTerminatedEvent(taskId: string) {
  return {
    type: 'background.task.terminated',
    sessionId: 's1',
    agentId: 'main',
    info: {
      taskId,
      kind: 'agent',
      agentId: 'a1',
      subagentType: 'researcher',
      description: 'research the workspace',
      status: 'completed',
      startedAt: Date.now(),
      endedAt: Date.now(),
    },
  } as const;
}

function processStartedEvent(taskId: string) {
  return {
    type: 'background.task.started',
    sessionId: 's1',
    agentId: 'main',
    info: {
      taskId,
      kind: 'process',
      command: 'npm run build',
      description: 'build',
      status: 'running',
      startedAt: Date.now(),
      endedAt: null,
      pid: 1234,
      exitCode: null,
    },
  } as const;
}

function workflowStartedEvent(taskId: string): Event {
  return {
    type: 'background.task.started',
    sessionId: 's1',
    agentId: 'main',
    info: {
      taskId,
      kind: 'workflow',
      description: 'Running workflow: smoke test',
      status: 'running',
      startedAt: Date.now(),
      endedAt: null,
    },
  } as unknown as Event;
}

describe('SessionEventHandler — background task footer refresh', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('refreshes the footer rows and badge when a background agent starts', () => {
    const { host } = makeHost();
    const handler = new SessionEventHandler(host);

    handler.handleEvent(agentStartedEvent('t1'), vi.fn());

    // Badge shows one running agent.
    const badgeCalls = host.state.footer.setBackgroundCounts.mock.calls as Array<
      [{ bashTasks: number; agentTasks: number }]
    >;
    expect(badgeCalls.at(-1)?.[0]).toEqual({ bashTasks: 0, agentTasks: 1, workflowTasks: 0 });

    // Rows land on the throttled footer sync (250ms trailing window).
    vi.advanceTimersByTime(250);

    // Per-agent rows refreshed with the running background agent.
    const rowsCalls = host.state.footer.setRunningAgents.mock.calls;
    const lastRows = rowsCalls.at(-1)?.[0] as Array<{ id: string; name: string }> | undefined;
    expect(lastRows).toBeDefined();
    expect(lastRows!.some((row) => row.id === 'a1' && row.name === 'researcher')).toBe(true);
  });

  it('removes the agent row when the background agent terminates', () => {
    const { host } = makeHost();
    const handler = new SessionEventHandler(host);

    handler.handleEvent(agentStartedEvent('t1'), vi.fn());
    handler.handleEvent(agentTerminatedEvent('t1'), vi.fn());

    // Both events fall in one throttle window; the trailing sync reflects the
    // final state (the row is gone).
    vi.advanceTimersByTime(250);

    const rowsCalls = host.state.footer.setRunningAgents.mock.calls;
    const lastRows = rowsCalls.at(-1)?.[0] as unknown;
    expect(lastRows).toEqual([]);
  });

  it('produces a visible row for a background process task', () => {
    const { host } = makeHost();
    const handler = new SessionEventHandler(host);

    handler.handleEvent(processStartedEvent('t2'), vi.fn());

    // Rows land on the throttled footer sync (250ms trailing window).
    vi.advanceTimersByTime(250);

    const rowsCalls = host.state.footer.setRunningAgents.mock.calls;
    const lastRows = rowsCalls.at(-1)?.[0] as Array<{
      id: string;
      name: string;
      description: string;
      tokens: number;
    }> | undefined;
    expect(lastRows).toBeDefined();
    expect(lastRows!.some((row) => row.id === 't2' && row.name === 'bash' && row.tokens === 0)).toBe(true);
  });

  it('coalesces rapid footer refreshes into one sync per throttle window', () => {
    const { host } = makeHost();
    const handler = new SessionEventHandler(host);

    handler.handleEvent(processStartedEvent('t2'), vi.fn());
    handler.handleEvent(agentStartedEvent('t1'), vi.fn());
    handler.handleEvent(agentTerminatedEvent('t1'), vi.fn());

    // A burst inside one window produces no intermediate syncs.
    expect(host.state.footer.setRunningAgents).not.toHaveBeenCalled();

    // The trailing sync reflects only the latest state.
    vi.advanceTimersByTime(250);
    expect(host.state.footer.setRunningAgents).toHaveBeenCalledTimes(1);
    const rows = host.state.footer.setRunningAgents.mock.calls.at(-1)?.[0] as unknown[];
    expect(rows.some((row) => (row as { id: string }).id === 't2')).toBe(true);
    expect(rows.some((row) => (row as { id: string }).id === 'a1')).toBe(false);

    // A later event opens a fresh window and still flushes at its end.
    handler.handleEvent(agentStartedEvent('t3'), vi.fn());
    expect(host.state.footer.setRunningAgents).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(250);
    expect(host.state.footer.setRunningAgents).toHaveBeenCalledTimes(2);
  });

  it('keeps the badge accurate when bash and agent tasks run together', () => {
    const { host } = makeHost();
    const handler = new SessionEventHandler(host);

    handler.handleEvent(processStartedEvent('t2'), vi.fn());
    handler.handleEvent(agentStartedEvent('t1'), vi.fn());

    const badgeCalls = host.state.footer.setBackgroundCounts.mock.calls as Array<
      [{ bashTasks: number; agentTasks: number }]
    >;
    expect(badgeCalls.at(-1)?.[0]).toEqual({ bashTasks: 1, agentTasks: 1, workflowTasks: 0 });
  });

  it('updates the badge but skips the standalone entry for a workflow run', () => {
    const { host } = makeHost();
    const handler = new SessionEventHandler(host);

    handler.handleEvent(workflowStartedEvent('wf1'), vi.fn());

    // The workflow run's own tool call card shows the subagent activity, so
    // no "bash task started in background" entry is appended.
    expect(host.appendTranscriptEntry).not.toHaveBeenCalled();

    // The run still counts towards the compact background-task badge.
    const badgeCalls = host.state.footer.setBackgroundCounts.mock.calls as Array<
      [{ bashTasks: number; agentTasks: number }]
    >;
    expect(badgeCalls.at(-1)?.[0]).toEqual({ bashTasks: 0, agentTasks: 0, workflowTasks: 1 });
  });
});
