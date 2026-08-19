import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { Event, TokenUsage } from '@moonshot-ai/kimi-code-sdk';

import { SessionEventHandler } from '#/tui/controllers/session-event-handler';
import { getBuiltInPalette } from '#/tui/theme';

/**
 * Session-cache-usage accumulation tests. Every completed step's exact usage
 * (`turn.step.completed`) must fold its input cache split into
 * `appState.sessionCacheUsage` — the source for the footer's cache-hit-rate
 * slot — and `resetRuntimeState` must clear it when the session switches.
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
      flushNow: vi.fn(),
      markStepTruncated: vi.fn(),
      resetToolUi: vi.fn(),
      finalizeTurn: vi.fn(),
      setTodoList: vi.fn(),
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
    updateActivityPane: vi.fn(),
  };
  host.setAppState.mockImplementation((patch: Record<string, unknown>) => {
    Object.assign(host.state.appState, patch);
  });
  return { host: host as any };
}

function stepCompletedEvent(usage: TokenUsage): Event {
  return {
    type: 'turn.step.completed',
    agentId: 'main',
    sessionId: 's1',
    turnId: 1,
    step: 1,
    usage,
    finishReason: 'end_turn',
    providerFinishReason: 'stop',
  } as unknown as Event;
}

describe('SessionEventHandler — session cache usage accumulation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('sums the input cache split across completed steps', () => {
    const { host } = makeHost();
    const handler = new SessionEventHandler(host);

    handler.handleEvent(
      stepCompletedEvent({ inputOther: 25, inputCacheRead: 75, inputCacheCreation: 0, output: 10 }),
      vi.fn(),
    );
    handler.handleEvent(
      stepCompletedEvent({ inputOther: 5, inputCacheRead: 25, inputCacheCreation: 70, output: 3 }),
      vi.fn(),
    );

    expect(host.state.appState.sessionCacheUsage).toEqual({
      inputOther: 30,
      inputCacheRead: 100,
      inputCacheCreation: 70,
    });
  });

  it('stays undefined until the first completed step carries exact usage', () => {
    const { host } = makeHost();
    const handler = new SessionEventHandler(host);

    expect(host.state.appState.sessionCacheUsage).toBeUndefined();
  });

  it('clears the accumulated usage on resetRuntimeState', () => {
    const { host } = makeHost();
    const handler = new SessionEventHandler(host);

    handler.handleEvent(
      stepCompletedEvent({ inputOther: 25, inputCacheRead: 75, inputCacheCreation: 0, output: 10 }),
      vi.fn(),
    );
    expect(host.state.appState.sessionCacheUsage).toBeDefined();

    handler.resetRuntimeState();
    expect(host.state.appState.sessionCacheUsage).toBeUndefined();
  });
});

describe('SessionEventHandler — in-flight turn usage throttle', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  function usageEvent(output: number): Event {
    return {
      type: 'turn.step.usage',
      agentId: 'main',
      sessionId: 's1',
      turnId: 1,
      step: 1,
      usage: { inputOther: 10, inputCacheRead: 5, inputCacheCreation: 0, output },
    } as unknown as Event;
  }

  it('coalesces turn.step.usage appState pushes to one per 250ms window', () => {
    vi.useFakeTimers();
    const { host } = makeHost();
    host.state.appState.turnUsage = { input: 0, output: 0, turnStartedAt: Date.now() };
    const handler = new SessionEventHandler(host);

    handler.handleEvent(usageEvent(100), vi.fn());
    handler.handleEvent(usageEvent(200), vi.fn());
    // A burst of usage events coalesces — nothing is pushed until the trailing
    // window elapses.
    expect(host.setAppState).not.toHaveBeenCalled();

    vi.advanceTimersByTime(250);
    expect(host.setAppState).toHaveBeenCalledTimes(1);
    expect(host.state.appState.turnUsage.live).toEqual({ input: 15, output: 200 });

    // A second burst coalesces again and the final applied value is the last
    // event of the burst, not an intermediate one.
    handler.handleEvent(usageEvent(300), vi.fn());
    handler.handleEvent(usageEvent(400), vi.fn());
    vi.advanceTimersByTime(250);
    expect(host.state.appState.turnUsage.live).toEqual({ input: 15, output: 400 });
  });

  it('does not apply a stale live usage after the turn ends', () => {
    vi.useFakeTimers();
    const { host } = makeHost();
    host.state.appState.turnUsage = { input: 0, output: 0, turnStartedAt: Date.now() };
    const handler = new SessionEventHandler(host);

    handler.handleEvent(usageEvent(100), vi.fn()); // schedules the trailing sync
    handler.handleEvent(
      {
        type: 'turn.ended',
        agentId: 'main',
        sessionId: 's1',
        turnId: 1,
        reason: 'end_turn',
      } as unknown as Event,
      vi.fn(),
    );
    // The turn end clears the pending sync, so the timer must fire without
    // pushing the pre-end usage into the (now cleared) turnUsage slot.
    host.setAppState.mockClear();
    vi.advanceTimersByTime(250);
    expect(host.setAppState).not.toHaveBeenCalled();
    expect(host.state.appState.turnUsage).toBeUndefined();
  });
});
