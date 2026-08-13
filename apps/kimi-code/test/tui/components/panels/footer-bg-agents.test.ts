import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';

import { FooterComponent } from '#/tui/components/chrome/footer';
import type { AppState, RunningAgentSummary } from '#/tui/types';

const ANSI_SGR = /\[[0-9;]*m/g;
function strip(text: string): string {
  return text.replaceAll(ANSI_SGR, '');
}

function baseState(overrides: Partial<AppState> = {}): AppState {
  return {
    model: 'k2',
    workDir: '/tmp/proj',
    additionalDirs: [],
    sessionId: 'sess_1',
    permissionMode: 'manual',
    planMode: false,
    thinkingEffort: 'off',
    contextUsage: 0,
    contextTokens: 0,
    maxContextTokens: 200_000,
    isCompacting: false,
    isReplaying: false,
    streamingPhase: 'idle',
    streamingStartTime: 0,
    theme: 'dark',
    version: 'test',
    editorCommand: null,
    notifications: { enabled: true, condition: 'unfocused' },
    availableModels: {},
    ...overrides,
  } as AppState;
}

describe('FooterComponent — background task / agent badges', () => {
  it('omits both badges when counts are 0', () => {
    const footer = new FooterComponent(baseState());
    const [line1] = footer.render(120);
    expect(line1).toBeDefined();
    expect(strip(line1!)).not.toMatch(/tasks? running/);
    expect(strip(line1!)).not.toMatch(/agents? running/);
  });

  it('renders the task badge alone when only bash tasks are running', () => {
    const footer = new FooterComponent(baseState());
    footer.setBackgroundCounts({ bashTasks: 1, agentTasks: 0 });
    const out = strip(footer.render(120)[0]!);
    expect(out).toMatch(/\[1 task running\]/);
    expect(out).not.toMatch(/agents? running/);
  });

  it('renders the agent badge alone when only agent tasks are running', () => {
    const footer = new FooterComponent(baseState());
    footer.setBackgroundCounts({ bashTasks: 0, agentTasks: 1 });
    const out = strip(footer.render(120)[0]!);
    expect(out).toMatch(/\[1 agent running\]/);
    expect(out).not.toMatch(/tasks? running/);
  });

  it('renders both badges side by side when both are non-zero', () => {
    const footer = new FooterComponent(baseState());
    footer.setBackgroundCounts({ bashTasks: 2, agentTasks: 3 });
    const out = strip(footer.render(120)[0]!);
    expect(out).toMatch(/\[2 tasks running\]/);
    expect(out).toMatch(/\[3 agents running\]/);
    // Task badge appears before agent badge in the line.
    expect(out.indexOf('2 tasks')).toBeLessThan(out.indexOf('3 agents'));
  });

  it('pluralizes correctly across both badges', () => {
    const footer = new FooterComponent(baseState());
    footer.setBackgroundCounts({ bashTasks: 1, agentTasks: 1 });
    const out = strip(footer.render(120)[0]!);
    expect(out).toMatch(/\[1 task running\]/);
    expect(out).toMatch(/\[1 agent running\]/);
  });

  it('updates badges live via setBackgroundCounts', () => {
    const footer = new FooterComponent(baseState());
    footer.setBackgroundCounts({ bashTasks: 2, agentTasks: 1 });
    expect(strip(footer.render(120)[0]!)).toMatch(/\[2 tasks running\]/);
    footer.setBackgroundCounts({ bashTasks: 0, agentTasks: 0 });
    const after = strip(footer.render(120)[0]!);
    expect(after).not.toMatch(/tasks? running/);
    expect(after).not.toMatch(/agents? running/);
  });

  it('clamps negative counts to 0', () => {
    const footer = new FooterComponent(baseState());
    footer.setBackgroundCounts({ bashTasks: -5, agentTasks: -2 });
    const out = strip(footer.render(120)[0]!);
    expect(out).not.toMatch(/tasks? running/);
    expect(out).not.toMatch(/agents? running/);
  });

  it('drops the badges when terminal is too narrow to fit them', () => {
    const footer = new FooterComponent(baseState());
    footer.setBackgroundCounts({ bashTasks: 4, agentTasks: 3 });
    // Extremely narrow width: footer primary content fills the line, so leftLine wins.
    const [line1] = footer.render(20);
    expect(line1).toBeDefined();
    expect(strip(line1!)).not.toMatch(/\[4 tasks running\]/);
    expect(strip(line1!)).not.toMatch(/\[3 agents running\]/);
  });
});

describe('FooterComponent — running agent rows', () => {
  const nowMs = Date.now();

  beforeEach(() => {
    vi.useFakeTimers({ now: nowMs });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  function runningAgent(overrides: Partial<RunningAgentSummary> = {}): RunningAgentSummary {
    return {
      id: 'agent-1',
      name: 'Explore',
      description: 'explore workspace',
      phase: 'running',
      startedAtMs: nowMs - 12_000,
      tokens: 50_077,
      ...overrides,
    };
  }

  it('renders a running agent below the standard footer lines', () => {
    const footer = new FooterComponent(baseState());
    footer.setRunningAgents([runningAgent()]);
    const lines = footer.render(120).map(strip);
    expect(lines.length).toBeGreaterThan(2);
    const agentLine = lines.slice(2).find((line) => line.includes('Explore'));
    expect(agentLine).toBeDefined();
    expect(agentLine!).toMatch(/○ Explore/);
    expect(agentLine!).toMatch(/explore workspace/);
    expect(agentLine!).toMatch(/12s/);
    expect(agentLine!).toMatch(/48\.9k tok/);
  });

  it('renders the main agent first when a turn is active', () => {
    const footer = new FooterComponent(
      baseState({
        streamingPhase: 'thinking',
        streamingStartTime: nowMs - 5_000,
        turnUsage: { input: 100, output: 200, turnStartedAt: nowMs - 5_000 },
      }),
    );
    footer.setRunningAgents([runningAgent()]);
    const lines = footer.render(120).map(strip);
    const agentLines = lines.slice(2);
    expect(agentLines[0]).toMatch(/● main/);
    expect(agentLines[1]).toMatch(/○ Explore/);
  });

  it('renders an idle main row before subagents when the main agent is not active', () => {
    const footer = new FooterComponent(baseState({ streamingPhase: 'idle' }));
    footer.setRunningAgents([runningAgent()]);
    const lines = footer.render(120).map(strip);
    const agentLines = lines.slice(2);
    expect(agentLines[0]).toMatch(/● main/);
    expect(agentLines[1]).toMatch(/○ Explore/);
  });

  it('shows the latest sub-tool activity on a subagent row', () => {
    const footer = new FooterComponent(baseState());
    footer.setRunningAgents([
      runningAgent({ latestActivity: 'Using Read (path)' }),
    ]);
    const lines = footer.render(120).map(strip);
    const agentLine = lines.slice(2).find((line) => line.includes('Explore'))!;
    expect(agentLine).toMatch(/→ Using Read \(path\)/);
  });

  it('keeps the compact agent badge alongside the detailed agent rows', () => {
    const footer = new FooterComponent(baseState());
    footer.setBackgroundCounts({ bashTasks: 0, agentTasks: 1 });
    footer.setRunningAgents([runningAgent()]);
    const out = footer.render(120).map(strip);
    expect(out[0]).toMatch(/\[1 agent running\]/);
    expect(out.slice(2).find((line) => line.includes('Explore'))).toBeDefined();
  });

  it('omits agent rows when no agents are running', () => {
    const footer = new FooterComponent(
      baseState({
        streamingPhase: 'idle',
        streamingStartTime: nowMs - 5_000,
      }),
    );
    footer.setRunningAgents([]);
    expect(footer.render(120)).toHaveLength(2);
  });

  it('truncates long agent lines to the terminal width', () => {
    const footer = new FooterComponent(baseState());
    footer.setRunningAgents([
      runningAgent({
        description: 'a'.repeat(200),
      }),
    ]);
    const agentLine = footer.render(40)[2];
    expect(agentLine).toBeDefined();
    expect(strip(agentLine!).length).toBeLessThanOrEqual(40);
  });

  it('omits the main agent line during an active turn when no agents run', () => {
    const footer = new FooterComponent(
      baseState({
        streamingPhase: 'thinking',
        streamingStartTime: nowMs - 5_000,
        turnUsage: { input: 0, output: 0, turnStartedAt: nowMs - 5_000 },
      }),
    );
    footer.setRunningAgents([]);
    // No subagents / background tasks -> footer stays at its two standard lines.
    expect(footer.render(120)).toHaveLength(2);
  });

  it('excludes input tokens from the main agent counter', () => {
    const footer = new FooterComponent(
      baseState({
        streamingPhase: 'composing',
        streamingStartTime: nowMs - 5_000,
        // A huge context input must not make the main line show any tokens.
        turnUsage: {
          input: 15_000,
          output: 0,
          turnStartedAt: nowMs - 5_000,
          live: { input: 15_000, output: 0 },
        },
      }),
    );
    footer.setTokenEstimateProvider(() => 0);
    footer.setRunningAgents([runningAgent()]);
    const lines = footer.render(120).map(strip);
    const mainLine = lines.slice(2).find((line) => line.includes('main'))!;
    expect(mainLine).toMatch(/● main/);
    expect(mainLine).not.toMatch(/tok/);
  });

  it('shows output tokens on the main agent counter once output exists', () => {
    const footer = new FooterComponent(
      baseState({
        streamingPhase: 'composing',
        streamingStartTime: nowMs - 5_000,
        turnUsage: { input: 15_000, output: 340, turnStartedAt: nowMs - 5_000 },
      }),
    );
    footer.setTokenEstimateProvider(() => 0);
    footer.setRunningAgents([runningAgent()]);
    const lines = footer.render(120).map(strip);
    const mainLine = lines.slice(2).find((line) => line.includes('main'))!;
    expect(mainLine).toMatch(/340 tok/);
  });

  it('renders a single background bash task as a visible row', () => {
    const footer = new FooterComponent(baseState());
    footer.setRunningAgents([
      {
        id: 'bash-1',
        name: 'bash',
        description: 'npm install',
        phase: 'running',
        startedAtMs: nowMs - 3_000,
        tokens: 0,
      },
    ]);
    const lines = footer.render(120).map(strip);
    const bashLine = lines.slice(2).find((line) => line.includes('npm install'))!;
    expect(bashLine).toMatch(/○ bash/);
    expect(bashLine).toMatch(/3s/);
  });
});

describe('FooterComponent — main agent token catch-up animation', () => {
  beforeEach(() => {
    vi.useFakeTimers({ now: Date.now() });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('chases a growing estimate toward its target in small steps', () => {
    const now = Date.now();
    const footer = new FooterComponent(
      baseState({
        streamingPhase: 'composing',
        streamingStartTime: now - 1_000,
        turnUsage: { input: 15_000, output: 0, turnStartedAt: now - 1_000 },
      }),
    );
    // The estimate starts at 0 and grows as text streams in, exactly like the
    // live handler's `estimatedOutputTokens`.
    let estimate = 0;
    footer.setTokenEstimateProvider(() => estimate);
    // The main line only renders while agents are running, so seed one to keep
    // the token counter visible for the animation assertions below.
    footer.setRunningAgents([
      {
        id: 'agent-1',
        name: 'Explore',
        description: 'explore workspace',
        phase: 'running',
        startedAtMs: now - 1_000,
        tokens: 0,
      },
    ]);

    const mainLine = (): string => {
      const lines = footer.render(120).map(strip);
      return lines.slice(2).find((line) => line.includes('main'))!;
    };
    // With a zero estimate the counter stays hidden.
    expect(mainLine()).toMatch(/● main/);
    expect(mainLine()).not.toMatch(/tok/);

    // Estimate jumps to 2k (a burst of streamed text). The display must not
    // snap there: the catch-up animation advances in small steps, and each
    // step only happens on a render after the 50ms throttle elapses.
    estimate = 2_000;
    for (let i = 0; i < 5; i++) {
      vi.advanceTimersByTime(50);
      mainLine();
    }
    const afterFewTicks = mainLine();
    expect(afterFewTicks).toMatch(/tok/);
    expect(afterFewTicks).not.toMatch(/2k tok/);

    // Render enough times (with the 50ms throttle satisfied between them) for
    // the counter to catch up to the 2k target.
    for (let i = 0; i < 100; i++) {
      vi.advanceTimersByTime(50);
      mainLine();
    }
    const caughtUp = mainLine();
    expect(caughtUp).toMatch(/2k tok/);
  });
});
