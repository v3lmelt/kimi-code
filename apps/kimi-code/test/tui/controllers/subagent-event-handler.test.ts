import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Event } from '@moonshot-ai/kimi-code-sdk';
import type { Component } from '@moonshot-ai/pi-tui';

import {
  collectSwarmRunningAgents,
  collectWorkflowRunAgents,
  SWARM_MEMBER_LIMIT,
  SubAgentEventHandler,
  swarmItemLabel,
  type SubAgentEventHandlerDependencies,
} from '#/tui/controllers/subagent-event-handler';
import { AgentSwarmProgressComponent } from '#/tui/components/messages/agent-swarm-progress';
import { GutterContainer } from '#/tui/components/chrome/gutter-container';
import type { SessionEventHost } from '#/tui/controllers/session-event-handler';
import type { StreamingUIController } from '#/tui/controllers/streaming-ui';
import type {
  ToolCallComponent,
  ToolCallSubagentSnapshot,
} from '#/tui/components/messages/tool-call';
import type { WorkflowRunView } from '#/tui/utils/workflow-model';

afterEach(() => {
  vi.useRealTimers();
});

function makeProgress(items: string[]): AgentSwarmProgressComponent {
  const progress = new AgentSwarmProgressComponent({ description: 'Review files' });
  progress.updateArgs({ items });
  progress.markInputComplete();
  return progress;
}

function startMembers(
  progress: AgentSwarmProgressComponent,
  count: number,
  usage?: { inputOther: number; inputCacheRead: number; inputCacheCreation: number; output: number },
): void {
  for (let index = 1; index <= count; index += 1) {
    const agentId = `agent-${String(index)}`;
    progress.registerSubagent({ agentId });
    progress.markStarted(agentId);
    if (usage !== undefined) progress.recordMemberUsage(agentId, usage);
  }
}

describe('collectSwarmRunningAgents', () => {
  it('returns one summary per active member under the limit', () => {
    vi.useFakeTimers({ now: 5_000 });
    const progress = makeProgress(['task A', 'task B']);
    progress.registerSubagent({ agentId: 'agent-1' });
    progress.markStarted('agent-1');
    progress.recordMemberUsage('agent-1', {
      inputOther: 100,
      inputCacheRead: 0,
      inputCacheCreation: 0,
      output: 400,
    });

    const rows = collectSwarmRunningAgents(progress, 'tool-1');
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({
      id: 'tool-1:001',
      name: '001',
      description: 'task A',
      phase: 'running',
      startedAtMs: 5_000,
      tokens: 500,
    });
    // Unstarted member maps to waiting, falling back to now for its start.
    expect(rows[1]).toMatchObject({
      name: '002',
      description: 'task B',
      phase: 'waiting',
      startedAtMs: 5_000,
      tokens: 0,
    });
  });

  it('collapses into a summary row beyond the member limit, keeping terminal members visible', () => {
    vi.useFakeTimers({ now: 10_000 });
    const count = SWARM_MEMBER_LIMIT + 2;
    const items = Array.from({ length: count }, (_item, index) => `task ${index + 1}`);
    const progress = makeProgress(items);
    startMembers(progress, count, {
      inputOther: 0,
      inputCacheRead: 0,
      inputCacheCreation: 0,
      output: 200,
    });
    progress.markCompleted('agent-1');
    progress.markFailed('agent-2');

    const rows = collectSwarmRunningAgents(progress, 'tool-1');
    // First SWARM_MEMBER_LIMIT members stay as individual rows (terminal ones
    // with a status mark), then the folded summary.
    expect(rows).toHaveLength(SWARM_MEMBER_LIMIT + 1);
    expect(rows[0]).toMatchObject({ name: '001', description: 'task 1 · ✓ done', phase: 'done' });
    expect(rows[1]).toMatchObject({ name: '002', description: 'task 2 · ✗ failed', phase: 'failed' });
    expect(rows[2]).toMatchObject({ name: '003', description: 'task 3', phase: 'running' });
    const summary = rows[SWARM_MEMBER_LIMIT]!;
    expect(summary.name).toBe('swarm');
    expect(summary.description).toContain(`${count - 2}/${count} working`);
    expect(summary.description).toContain('1 done');
    expect(summary.description).toContain('1 failed');
    // Summed tokens across every member (terminal ones included).
    expect(summary.tokens).toBe(count * 200);
    expect(summary.startedAtMs).toBe(10_000);
  });

  it('keeps a single terminal member visible with its status mark', () => {
    vi.useFakeTimers({ now: 5_000 });
    const progress = makeProgress(['task A']);
    progress.registerSubagent({ agentId: 'agent-1' });
    progress.markStarted('agent-1');
    progress.markCompleted('agent-1');
    const rows = collectSwarmRunningAgents(progress, 'tool-1');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      id: 'tool-1:001',
      name: '001',
      description: 'task A · ✓ done',
      phase: 'done',
    });
  });

  it('returns nothing when the tool call is no longer active', () => {
    const progress = makeProgress(['task A']);
    progress.registerSubagent({ agentId: 'agent-1' });
    progress.markStarted('agent-1');
    progress.markToolCallEnded();
    expect(collectSwarmRunningAgents(progress, 'tool-1')).toHaveLength(0);
  });
  it('joins the member activity line under the item title when a resolver is given', () => {
    vi.useFakeTimers({ now: 5_000 });
    const progress = makeProgress(['【专题:footer】阅读 footer.ts 全文。回答:1) 渲染几行?']);
    progress.registerSubagent({ agentId: 'agent-1' });
    progress.markStarted('agent-1');
    const rows = collectSwarmRunningAgents(progress, 'tool-1', (agentId) => {
      if (agentId === 'agent-1') return 'Using Read (footer.ts)';
      return undefined;
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      id: 'tool-1:001',
      name: '001',
      description: '【专题:footer】',
      latestActivity: 'Using Read (footer.ts)',
    });
  });
});

describe('swarmItemLabel', () => {
  it('keeps a Chinese bracket-pair title and drops the prompt body', () => {
    expect(
      swarmItemLabel('【专题:footer 现有渲染细节】阅读 apps/kimi-code/src/tui/components/chrome/footer.ts 全文(重点 render)。回答:1) 渲染几行?'),
    ).toBe('【专题:footer 现有渲染细节】');
  });

  it('keeps an English bracket-pair label', () => {
    expect(swarmItemLabel('[Step 1] read AGENTS.md and extract the rules.')).toBe('[Step 1]');
  });

  it('keeps the first line of a multi-line item', () => {
    expect(swarmItemLabel('Review the diff\nFocus on regressions.\n')).toBe('Review the diff');
  });

  it('keeps the first sentence when no title signal exists', () => {
    expect(swarmItemLabel('Review src/a.ts for regressions. Also check tests.')).toBe(
      'Review src/a.ts for regressions.',
    );
  });

  it('returns the item text unchanged when no shorter label exists', () => {
    expect(swarmItemLabel('task A')).toBe('task A');
    expect(swarmItemLabel('   ')).toBe('');
  });

  it('applies the label extraction to swarm member rows', () => {
    vi.useFakeTimers({ now: 5_000 });
    const progress = new AgentSwarmProgressComponent({ description: 'Review files' });
    progress.updateArgs({
      items: ['【专题:footer】阅读 footer.ts 全文。回答:1) 渲染几行?', 'task B'],
    });
    progress.markInputComplete();
    progress.registerSubagent({ agentId: 'agent-1' });
    progress.markStarted('agent-1');
    progress.registerSubagent({ agentId: 'agent-2' });
    progress.markStarted('agent-2');

    const rows = collectSwarmRunningAgents(progress, 'tool-1');
    expect(rows[0]!.description).toBe('【专题:footer】');
    expect(rows[1]!.description).toBe('task B');
  });
});

describe('collectRunningAgents', () => {
  function makeSnapshot(description: string, latestActivity?: string): ToolCallSubagentSnapshot {
    return {
      toolCallId: 'call',
      toolName: 'workflow',
      toolCallDescription: description,
      agentName: 'explore',
      phase: 'running',
      toolCount: 0,
      elapsedSeconds: 1,
      tokens: 0,
      isError: false,
      errorText: undefined,
      latestActivity: latestActivity ?? 'reading AGENTS.md',
    };
  }

  /** A fake ToolCallComponent: mutators are no-ops, snapshot getters return the fixture. */
  function makeToolComponent(
    snapshot: ToolCallSubagentSnapshot,
    startedAtMs = 1_000,
  ): Pick<
    ToolCallComponent,
    | 'getSubagentSnapshot'
    | 'getSubagentStartedAtMs'
    | 'setSubagentMeta'
    | 'appendSubagentText'
    | 'appendSubToolCall'
    | 'appendSubToolCallDelta'
    | 'appendSubToolLiveOutput'
    | 'finishSubToolCall'
    | 'updateSubagentMetrics'
  > {
    return {
      getSubagentSnapshot: () => snapshot,
      getSubagentStartedAtMs: () => startedAtMs,
      setSubagentMeta: () => {},
      appendSubagentText: () => {},
      appendSubToolCall: () => {},
      appendSubToolCallDelta: () => {},
      appendSubToolLiveOutput: () => {},
      finishSubToolCall: () => {},
      updateSubagentMetrics: () => {},
    };
  }

  function makeHandler(
    components: Map<string, ReturnType<typeof makeToolComponent>>,
    workflows: readonly WorkflowRunView[] = [],
    activeToolCalls: ReadonlyMap<string, { readonly name?: string }> = new Map(),
  ): SubAgentEventHandler {
    const streamingUI = {
      getToolComponent: (toolCallId: string) => components.get(toolCallId),
      getActiveToolCall: (toolCallId: string) => activeToolCalls.get(toolCallId),
    } as unknown as StreamingUIController;
    const host = {
      streamingUI,
      btwPanelController: { routeEvent: () => false },
      // `collectRunningAgents` reads `state.appState.workflowRuns` to surface
      // active workflow runs; an empty ledger keeps the existing cases pure.
      state: { appState: { workflowRuns: workflows } },
    } as unknown as SessionEventHost;
    const deps: SubAgentEventHandlerDependencies = {
      backgroundTasks: new Map(),
      backgroundTaskTranscriptedTerminal: new Set(),
      syncBackgroundAgentBadge: () => {},
      syncRunningAgentsFooter: () => {},
    };
    return new SubAgentEventHandler(host, deps);
  }

  it('surfaces each subagent description as the row name when several share one card', () => {
    const handler = makeHandler(
      new Map([
        ['wf-call', makeToolComponent(makeSnapshot('Running workflow: smoke test'))],
      ]),
    );
    handler.subagentInfo.set('agent-1', {
      parentToolCallId: 'wf-call',
      name: 'explore',
      description: 'survey:agent-core',
      runInBackground: false,
      startedAtMs: 0,
    });
    handler.subagentInfo.set('agent-2', {
      parentToolCallId: 'wf-call',
      name: 'explore',
      description: 'survey:agent-core-v2',
      runInBackground: false,
      startedAtMs: 0,
    });

    const rows = handler.collectRunningAgents();
    expect(rows).toHaveLength(2);
    // The per-subagent label becomes the name so the row says what the agent does.
    expect(rows[0]!.name).toBe('survey:agent-core');
    expect(rows[1]!.name).toBe('survey:agent-core-v2');
    expect(rows[0]!.description).toBeUndefined();
    // No routed events yet: the activity falls back to the card snapshot.
    expect(rows[0]!.latestActivity).toBe('reading AGENTS.md');
  });

  it('falls back to the card description when the spawn carried none', () => {
    const handler = makeHandler(
      new Map([['agent-call', makeToolComponent(makeSnapshot('Review files'))]]),
    );
    handler.subagentInfo.set('agent-1', {
      parentToolCallId: 'agent-call',
      name: 'explore',
      runInBackground: false,
      startedAtMs: 0,
    });

    const rows = handler.collectRunningAgents();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.name).toBe('explore');
    expect(rows[0]!.description).toBe('Review files');
  });

  it('reports a distinct latest activity per subagent from routed events', () => {
    const handler = makeHandler(
      new Map([['wf-call', makeToolComponent(makeSnapshot('Running workflow: smoke test'))]]),
    );
    handler.subagentInfo.set('agent-1', {
      parentToolCallId: 'wf-call',
      name: 'explore',
      description: 'survey:agent-core',
      runInBackground: false,
      startedAtMs: 0,
    });
    handler.subagentInfo.set('agent-2', {
      parentToolCallId: 'wf-call',
      name: 'explore',
      description: 'survey:agent-core-v2',
      runInBackground: false,
      startedAtMs: 0,
    });

    handler.routeChildAgentEvent({
      type: 'tool.call.started',
      agentId: 'agent-1',
      toolCallId: 'read-1',
      name: 'Read',
      args: { path: 'AGENTS.md' },
    } as unknown as Event);
    handler.routeChildAgentEvent({
      type: 'tool.call.started',
      agentId: 'agent-2',
      toolCallId: 'grep-1',
      name: 'Grep',
      args: { pattern: 'workflow' },
    } as unknown as Event);

    const rows = handler.collectRunningAgents();
    expect(rows).toHaveLength(2);
    expect(rows[0]!.latestActivity).toBe('Using Read (AGENTS.md)');
    expect(rows[1]!.latestActivity).toBe('Using Grep (workflow)');
  });

  it('uses the last text line as activity when the subagent is not calling a tool', () => {
    const handler = makeHandler(
      new Map([['wf-call', makeToolComponent(makeSnapshot('Running workflow: smoke test'))]]),
    );
    handler.subagentInfo.set('agent-1', {
      parentToolCallId: 'wf-call',
      name: 'explore',
      description: 'survey:agent-core',
      runInBackground: false,
      startedAtMs: 0,
    });

    handler.routeChildAgentEvent({
      type: 'assistant.delta',
      agentId: 'agent-1',
      delta: 'checking the agent-core guide\n',
    } as unknown as Event);

    const rows = handler.collectRunningAgents();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.latestActivity).toBe('checking the agent-core guide');
  });

  it('falls back to a phase label when no activity is available yet', () => {
    const handler = makeHandler(
      new Map([
        [
          'wf-call-1',
          makeToolComponent({
            ...makeSnapshot('Running workflow: smoke test'),
            latestActivity: undefined,
          }),
        ],
        [
          'wf-call-2',
          makeToolComponent({
            ...makeSnapshot('Running workflow: smoke test'),
            phase: 'queued',
            latestActivity: undefined,
          }),
        ],
        [
          'wf-call-3',
          makeToolComponent({
            ...makeSnapshot('Running workflow: smoke test'),
            phase: 'spawning',
            latestActivity: undefined,
          }),
        ],
      ]),
    );
    handler.subagentInfo.set('agent-1', {
      parentToolCallId: 'wf-call-1',
      name: 'explore',
      description: 'survey:agent-core',
      runInBackground: false,
      startedAtMs: 0,
    });
    handler.subagentInfo.set('agent-2', {
      parentToolCallId: 'wf-call-2',
      name: 'explore',
      description: 'survey:agent-core-v2',
      runInBackground: false,
      startedAtMs: 0,
    });
    handler.subagentInfo.set('agent-3', {
      parentToolCallId: 'wf-call-3',
      name: 'explore',
      description: 'survey:agent-core-v3',
      runInBackground: false,
      startedAtMs: 0,
    });

    const rows = handler.collectRunningAgents();
    expect(rows).toHaveLength(3);
    expect(rows[0]!.phase).toBe('running');
    expect(rows[0]!.latestActivity).toBe('working…');
    expect(rows[1]!.phase).toBe('waiting');
    expect(rows[1]!.latestActivity).toBe('queued…');
    expect(rows[2]!.phase).toBe('starting');
    expect(rows[2]!.latestActivity).toBe('starting…');
  });

  it('collapses more than SWARM_MEMBER_LIMIT subagents under one card into a summary row', () => {
    const handler = makeHandler(
      new Map([
        [
          'wf-call',
          makeToolComponent({ ...makeSnapshot('Running workflow: smoke test'), tokens: 120 }),
        ],
      ]),
    );
    for (let index = 1; index <= SWARM_MEMBER_LIMIT + 1; index += 1) {
      handler.subagentInfo.set(`agent-${String(index)}`, {
        parentToolCallId: 'wf-call',
        name: 'explore',
        description: `survey:task-${String(index)}`,
        runInBackground: false,
        startedAtMs: 0,
      });
    }

    const rows = handler.collectRunningAgents();
    expect(rows).toHaveLength(1);
    expect(rows[0]!).toMatchObject({
      id: 'wf-call:subagents',
      name: 'subagents',
      phase: 'running',
      startedAtMs: 1_000,
    });
    expect(rows[0]!.description).toContain(`${SWARM_MEMBER_LIMIT + 1}/${SWARM_MEMBER_LIMIT + 1} working`);
    // Summed tokens across every member.
    expect(rows[0]!.tokens).toBe((SWARM_MEMBER_LIMIT + 1) * 120);
  });

  it('reads the card snapshot once and shares it across every member of a parent', () => {
    const getSnapshot = vi.fn((): ToolCallSubagentSnapshot => ({
      ...makeSnapshot('Running workflow: smoke test'),
      tokens: 120,
    }));
    const component = makeToolComponent({
      ...makeSnapshot('Running workflow: smoke test'),
      tokens: 120,
    });
    component.getSubagentSnapshot = getSnapshot;
    const handler = makeHandler(new Map([['wf-call', component]]));
    for (let index = 1; index <= SWARM_MEMBER_LIMIT + 1; index += 1) {
      handler.subagentInfo.set(`agent-${String(index)}`, {
        parentToolCallId: 'wf-call',
        name: 'explore',
        description: `survey:task-${String(index)}`,
        runInBackground: false,
        startedAtMs: 0,
      });
    }

    const rows = handler.collectRunningAgents();
    // One snapshot per parent card per collect — not one per member — so a
    // workflow fanning out 20+ agents under one card reads it once.
    expect(getSnapshot).toHaveBeenCalledTimes(1);
    expect(rows).toHaveLength(1);
    expect(rows[0]!).toMatchObject({
      id: 'wf-call:subagents',
      name: 'subagents',
      phase: 'running',
      startedAtMs: 1_000,
    });
    expect(rows[0]!.description).toContain(`${SWARM_MEMBER_LIMIT + 1}/${SWARM_MEMBER_LIMIT + 1} working`);
    // Summed tokens across every member.
    expect(rows[0]!.tokens).toBe((SWARM_MEMBER_LIMIT + 1) * 120);

    // The cache lives for one collect only: a second collect re-reads.
    handler.collectRunningAgents();
    expect(getSnapshot).toHaveBeenCalledTimes(2);
  });

  it('drops the group once every member is done or failed', () => {
    const component = makeToolComponent({
      ...makeSnapshot('Running workflow: smoke test'),
      phase: 'done',
      tokens: 120,
    });
    const handler = makeHandler(new Map([['wf-call', component]]));
    for (let index = 1; index <= SWARM_MEMBER_LIMIT + 1; index += 1) {
      handler.subagentInfo.set(`agent-${String(index)}`, {
        parentToolCallId: 'wf-call',
        name: 'explore',
        description: `survey:task-${String(index)}`,
        runInBackground: false,
        startedAtMs: 0,
      });
    }

    expect(handler.collectRunningAgents()).toHaveLength(0);
  });

  it('does not render terminal rows individually at or below the limit', () => {
    const component = makeToolComponent({
      ...makeSnapshot('Running workflow: smoke test'),
      phase: 'done',
      tokens: 120,
    });
    const handler = makeHandler(new Map([['wf-call', component]]));
    for (let index = 1; index <= 3; index += 1) {
      handler.subagentInfo.set(`agent-${String(index)}`, {
        parentToolCallId: 'wf-call',
        name: 'explore',
        description: `survey:task-${String(index)}`,
        runInBackground: false,
        startedAtMs: 0,
      });
    }

    // Members share the card's snapshot, so a terminal card contributes no
    // rows even when the group is small enough to list individually.
    expect(handler.collectRunningAgents()).toHaveLength(0);
  });

  it('keeps one row per subagent at or below the member limit', () => {
    const handler = makeHandler(
      new Map([['wf-call', makeToolComponent(makeSnapshot('Running workflow: smoke test'))]]),
    );
    for (let index = 1; index <= SWARM_MEMBER_LIMIT; index += 1) {
      handler.subagentInfo.set(`agent-${String(index)}`, {
        parentToolCallId: 'wf-call',
        name: 'explore',
        description: `survey:task-${String(index)}`,
        runInBackground: false,
        startedAtMs: 0,
      });
    }

    const rows = handler.collectRunningAgents();
    expect(rows).toHaveLength(SWARM_MEMBER_LIMIT);
    expect(rows.map((row) => row.name)).toEqual(
      Array.from({ length: SWARM_MEMBER_LIMIT }, (_item, index) => `survey:task-${String(index + 1)}`),
    );
  });

  it('keeps separate parent tool calls from merging into one row', () => {
    const handler = makeHandler(
      new Map([
        ['wf-call-1', makeToolComponent(makeSnapshot('Running workflow: smoke test'))],
        ['wf-call-2', makeToolComponent(makeSnapshot('Running workflow: agent-core'))],
      ]),
    );
    for (let index = 1; index <= 3; index += 1) {
      handler.subagentInfo.set(`agent-${String(index)}`, {
        parentToolCallId: 'wf-call-1',
        name: 'explore',
        description: `survey:task-${String(index)}`,
        runInBackground: false,
        startedAtMs: 0,
      });
      handler.subagentInfo.set(`agent-${String(index + 3)}`, {
        parentToolCallId: 'wf-call-2',
        name: 'explore',
        description: `survey:task-${String(index + 3)}`,
        runInBackground: false,
        startedAtMs: 0,
      });
    }

    const rows = handler.collectRunningAgents();
    expect(rows).toHaveLength(6);
    expect(rows.map((row) => row.name)).toEqual([
      'survey:task-1',
      'survey:task-2',
      'survey:task-3',
      'survey:task-4',
      'survey:task-5',
      'survey:task-6',
    ]);
  });

  it('surfaces each running workflow run with its current phase and progress', () => {
    const handler = makeHandler(new Map(), [
      {
        runId: 'wf_live',
        name: 'Monorepo 大规模读取',
        description: '并行派遣只读探索代理',
        phases: [{ title: '读取' }],
        status: 'running',
        phase: '读取',
        spawnedAgents: 21,
        completedAgents: 3,
        startedAt: '2026-08-14T08:00:00.000Z',
        agents: [],
        logLines: [],
      } as WorkflowRunView,
      // Terminal runs must not produce a row.
      {
        runId: 'wf_done',
        name: '已完成的 run',
        description: 'done',
        phases: [],
        status: 'completed',
        spawnedAgents: 5,
        completedAgents: 5,
        startedAt: '2026-08-14T07:00:00.000Z',
        agents: [],
        logLines: [],
      } as WorkflowRunView,
    ]);

    const rows = handler.collectRunningAgents();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      id: 'workflow:wf_live',
      name: 'workflow',
      description: 'Monorepo 大规模读取',
      latestActivity: '3/21 complete · 读取',
      phase: 'running',
      startedAtMs: Date.parse('2026-08-14T08:00:00.000Z'),
      tokens: 0,
    });
  });

  it('falls back to the agent progress when the run has not entered a phase yet', () => {
    const handler = makeHandler(new Map(), [
      {
        runId: 'wf_starting',
        name: '早期 run',
        description: '尚无 phase',
        phases: [],
        status: 'running',
        spawnedAgents: 4,
        completedAgents: 0,
        startedAt: '2026-08-14T08:00:00.000Z',
        agents: [],
        logLines: [],
      } as WorkflowRunView,
    ]);

    const rows = handler.collectRunningAgents();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.latestActivity).toBe('0/4 complete');
  });

  it('lists each workflow subagent under the run row at or below the limit', () => {
    vi.useFakeTimers({ now: Date.parse('2026-08-14T08:01:00.000Z') });
    const handler = makeHandler(new Map(), [
      {
        runId: 'wf_live',
        name: 'Review',
        description: '',
        phases: [],
        status: 'running',
        spawnedAgents: 2,
        completedAgents: 1,
        startedAt: '2026-08-14T08:00:00.000Z',
        agents: [
          { agentId: 'agent-1', label: 'survey:core', status: 'running' },
          { agentId: 'agent-2', label: 'survey:docs', status: 'completed', durationMs: 42_000 },
        ],
        logLines: [],
      } as WorkflowRunView,
    ]);

    const rows = handler.collectRunningAgents();
    expect(rows).toHaveLength(3); // run row + 2 subagent rows
    expect(rows[0]).toMatchObject({
      id: 'workflow:wf_live',
      name: 'workflow',
      latestActivity: '1/2 complete',
      phase: 'running',
    });
    expect(rows[1]).toMatchObject({
      id: 'workflow:wf_live:agent-1',
      name: 'survey:core',
      description: 'working…',
      phase: 'running',
      startedAtMs: Date.parse('2026-08-14T08:00:00.000Z'),
      tokens: 0,
    });
    expect(rows[2]).toMatchObject({
      id: 'workflow:wf_live:agent-2',
      name: 'survey:docs',
      description: '✓ done',
      phase: 'done',
      // Back-dated so the footer elapsed clock shows the agent's duration.
      startedAtMs: Date.parse('2026-08-14T08:01:00.000Z') - 42_000,
      tokens: 0,
    });
  });

  it('shows the first SWARM_MEMBER_LIMIT workflow subagents plus a folded summary', () => {
    const count = SWARM_MEMBER_LIMIT + 2;
    const handler = makeHandler(new Map(), [
      {
        runId: 'wf_live',
        name: 'Review',
        description: '',
        phases: [],
        status: 'running',
        spawnedAgents: count,
        completedAgents: 2,
        startedAt: '2026-08-14T08:00:00.000Z',
        agents: [
          { agentId: 'agent-1', label: 'task:1', status: 'completed', durationMs: 10_000 },
          { agentId: 'agent-2', label: 'task:2', status: 'failed', durationMs: 5_000 },
          ...Array.from({ length: count - 2 }, (_item, index) => ({
            agentId: `agent-${String(index + 3)}`,
            label: `task:${String(index + 3)}`,
            status: 'running' as const,
          })),
        ],
        logLines: [],
      } as WorkflowRunView,
    ]);

    const rows = handler.collectRunningAgents();
    // run row + SWARM_MEMBER_LIMIT member rows + folded summary row.
    expect(rows).toHaveLength(SWARM_MEMBER_LIMIT + 2);
    expect(rows[1]).toMatchObject({ name: 'task:1', description: '✓ done', phase: 'done' });
    expect(rows[2]).toMatchObject({ name: 'task:2', description: '✗ failed', phase: 'failed' });
    expect(rows[3]).toMatchObject({ name: 'task:3', description: 'working…', phase: 'running' });
    const summary = rows[SWARM_MEMBER_LIMIT + 1]!;
    expect(summary).toMatchObject({
      id: 'workflow:wf_live:summary',
      name: 'workflow agents',
      phase: 'running',
    });
    expect(summary.description).toBe(`${count - 2}/${count} working · 1 done · 1 failed`);
  });

  it('keeps workflow-run subagents out of the plain subagent rows', () => {
    const handler = makeHandler(
      new Map([
        ['wf-call', makeToolComponent(makeSnapshot('Running workflow: smoke test'))],
      ]),
      [],
      new Map([['wf-call', { name: 'Workflow' }]]),
    );
    handler.subagentInfo.set('agent-1', {
      parentToolCallId: 'wf-call',
      name: 'explore',
      description: 'survey:agent-core',
      runInBackground: false,
      startedAtMs: 0,
    });
    // No running run in the ledger: the subagent is still excluded because
    // its parent tool call is a Workflow run (the workflow rows own it).
    expect(handler.collectRunningAgents()).toHaveLength(0);
  });

  it('joins the workflow subagent activity under its row from the activity ledger', () => {
    vi.useFakeTimers({ now: Date.parse('2026-08-14T08:01:00.000Z') });
    const handler = makeHandler(
      new Map([
        ['wf-call', makeToolComponent(makeSnapshot('Running workflow: smoke test'))],
      ]),
      [
        {
          runId: 'wf_live',
          name: 'Review',
          description: '',
          phases: [],
          status: 'running',
          spawnedAgents: 1,
          completedAgents: 0,
          startedAt: '2026-08-14T08:00:00.000Z',
          agents: [{ agentId: 'agent-1', label: 'survey:core', status: 'running' }],
          logLines: [],
        } as WorkflowRunView,
      ],
      new Map([['wf-call', { name: 'Workflow' }]]),
    );
    handler.subagentInfo.set('agent-1', {
      parentToolCallId: 'wf-call',
      name: 'explore',
      description: 'survey:core',
      runInBackground: false,
      startedAtMs: 0,
    });
    handler.routeChildAgentEvent({
      type: 'tool.call.started',
      agentId: 'agent-1',
      toolCallId: 't1',
      name: 'Read',
      args: {},
    } as unknown as Event);

    const rows = handler.collectRunningAgents();
    expect(rows).toHaveLength(2); // run row + agent row
    expect(rows[0]).toMatchObject({ id: 'workflow:wf_live', name: 'workflow' });
    expect(rows[1]!.name).toBe('survey:core');
    expect(rows[1]!.description).toBe('working…');
    expect(rows[1]!.latestActivity).toContain('Read');
  });

  it('shows in-flight workflow subagents from the live registry and counts them in the total', () => {
    vi.useFakeTimers({ now: Date.parse('2026-08-14T08:01:00.000Z') });
    const handler = makeHandler(
      new Map([['wf-call', makeToolComponent(makeSnapshot('Running workflow'), 5_000)]]),
      [
        {
          runId: 'wf_live',
          name: 'Review',
          description: '',
          phases: [],
          status: 'running',
          // Spawn counts are live (each `agent_spawned` bumps the counter),
          // while the per-agent ledger entries land on completion, so the two
          // finished agents are here while the in-flight one is not.
          spawnedAgents: 2,
          completedAgents: 2,
          startedAt: '2026-08-14T08:00:00.000Z',
          agents: [
            { agentId: 'agent-1', label: 'task:1', status: 'completed', durationMs: 10_000 },
            { agentId: 'agent-2', label: 'task:2', status: 'completed', durationMs: 20_000 },
          ],
          logLines: [],
        } as WorkflowRunView,
      ],
      new Map([['wf-call', { name: 'Workflow' }]]),
    );
    handler.subagentInfo.set('agent-3', {
      parentToolCallId: 'wf-call',
      name: 'explore',
      description: 'task:3',
      runInBackground: false,
      // Per-agent spawn time, recorded when `subagent.spawned` is handled.
      startedAtMs: 40_000,
    });

    const rows = handler.collectRunningAgents();
    expect(rows).toHaveLength(4); // run row + live row + 2 ledger rows
    // The in-flight agent counts toward the displayed total.
    expect(rows[0]).toMatchObject({ id: 'workflow:wf_live', latestActivity: '2/3 complete' });
    expect(rows[1]).toMatchObject({
      id: 'workflow:wf_live:agent-3',
      name: 'task:3',
      description: 'working…',
      phase: 'running',
      // The agent's own spawn time, not the parent card's shared start clock.
      startedAtMs: 40_000,
      tokens: 0,
    });
    expect(rows[2]).toMatchObject({ name: 'task:1', description: '✓ done', phase: 'done' });
    expect(rows[3]).toMatchObject({ name: 'task:2', description: '✓ done', phase: 'done' });
  });

  it('folds live and ledger workflow agents into one summary with live agents as working', () => {
    vi.useFakeTimers({ now: Date.parse('2026-08-14T08:01:00.000Z') });
    const handler = makeHandler(
      new Map([['wf-call', makeToolComponent(makeSnapshot('Running workflow'), 5_000)]]),
      [
        {
          runId: 'wf_live',
          name: 'Review',
          description: '',
          phases: [],
          status: 'running',
          spawnedAgents: 3,
          completedAgents: 3,
          startedAt: '2026-08-14T08:00:00.000Z',
          agents: [
            { agentId: 'agent-1', label: 'task:1', status: 'completed', durationMs: 10_000 },
            { agentId: 'agent-2', label: 'task:2', status: 'completed', durationMs: 20_000 },
            { agentId: 'agent-3', label: 'task:3', status: 'completed', durationMs: 30_000 },
          ],
          logLines: [],
        } as WorkflowRunView,
      ],
      new Map([['wf-call', { name: 'Workflow' }]]),
    );
    handler.subagentInfo.set('agent-4', {
      parentToolCallId: 'wf-call',
      name: 'explore',
      description: 'task:4',
      runInBackground: false,
      startedAtMs: 0,
    });
    handler.subagentInfo.set('agent-5', {
      parentToolCallId: 'wf-call',
      name: 'explore',
      description: 'task:5',
      runInBackground: false,
      startedAtMs: 0,
    });

    const rows = handler.collectRunningAgents();
    // run row + SWARM_MEMBER_LIMIT detail rows (live first) + folded summary.
    expect(rows).toHaveLength(SWARM_MEMBER_LIMIT + 2);
    expect(rows[0]).toMatchObject({ latestActivity: '3/5 complete' });
    expect(rows[1]).toMatchObject({ name: 'task:4', description: 'working…', phase: 'running' });
    expect(rows[2]).toMatchObject({ name: 'task:5', description: 'working…', phase: 'running' });
    expect(rows[3]).toMatchObject({ name: 'task:1', description: '✓ done', phase: 'done' });
    const summary = rows[SWARM_MEMBER_LIMIT + 1]!;
    expect(summary).toMatchObject({
      id: 'workflow:wf_live:summary',
      name: 'workflow agents',
      phase: 'running',
    });
    expect(summary.description).toBe('2/5 working · 3 done');
  });

  it('accumulates agent.status.updated usage into subagentTokenTotals (context fallback, monotonic)', () => {
    const handler = makeHandler(
      new Map([['wf-call', makeToolComponent(makeSnapshot('Running workflow'))]]),
    );
    handler.subagentInfo.set('agent-1', {
      parentToolCallId: 'wf-call',
      name: 'explore',
      description: 'task:1',
      runInBackground: false,
      startedAtMs: 0,
    });
    const statusUpdated = (usage?: unknown, contextTokens?: number): Event =>
      ({ type: 'agent.status.updated', agentId: 'agent-1', usage, contextTokens }) as unknown as Event;

    // Usage (input + output) wins when present.
    handler.routeChildAgentEvent(
      statusUpdated({ total: { inputOther: 10, inputCacheRead: 20, inputCacheCreation: 5, output: 100 } }),
    );
    expect(handler.subagentTokenTotals.get('agent-1')).toBe(135);

    // Context tokens are the fallback until usage is reported.
    handler.routeChildAgentEvent(statusUpdated(undefined, 200));
    expect(handler.subagentTokenTotals.get('agent-1')).toBe(200);

    // A smaller later report never lowers the counter (monotonic).
    handler.routeChildAgentEvent(
      statusUpdated({ currentTurn: { inputOther: 0, inputCacheRead: 0, inputCacheCreation: 0, output: 50 } }),
    );
    expect(handler.subagentTokenTotals.get('agent-1')).toBe(200);

    // Neither usage nor context tokens: the entry stays untouched.
    handler.routeChildAgentEvent(statusUpdated(undefined, undefined));
    expect(handler.subagentTokenTotals.get('agent-1')).toBe(200);
  });

  it('feeds accumulated subagent tokens into the workflow footer rows', () => {
    vi.useFakeTimers({ now: Date.parse('2026-08-14T08:01:00.000Z') });
    const handler = makeHandler(
      new Map([['wf-call', makeToolComponent(makeSnapshot('Running workflow'))]]),
      [
        {
          runId: 'wf_live',
          name: 'Review',
          description: '',
          phases: [],
          status: 'running',
          spawnedAgents: 1,
          completedAgents: 0,
          startedAt: '2026-08-14T08:00:00.000Z',
          agents: [{ agentId: 'agent-1', label: 'task:1', status: 'running' }],
          logLines: [],
        } as WorkflowRunView,
      ],
      new Map([['wf-call', { name: 'Workflow' }]]),
    );
    handler.subagentInfo.set('agent-1', {
      parentToolCallId: 'wf-call',
      name: 'explore',
      description: 'task:1',
      runInBackground: false,
      startedAtMs: 0,
    });
    handler.routeChildAgentEvent({
      type: 'agent.status.updated',
      agentId: 'agent-1',
      usage: { total: { output: 350, inputOther: 0, inputCacheRead: 0, inputCacheCreation: 0 } },
    } as unknown as Event);

    const rows = handler.collectRunningAgents();
    expect(rows[1]).toMatchObject({ id: 'workflow:wf_live:agent-1', tokens: 350 });
  });

  it('feeds live activity and tokens into workflow rows after the launching card is gone', () => {
    vi.useFakeTimers({ now: Date.parse('2026-08-14T08:01:00.000Z') });
    // The Workflow card is cleared on turn end; the run keeps running in the
    // background. The activity ledger must still be fed by child events.
    const handler = makeHandler(
      new Map(),
      [
        {
          runId: 'wf_live',
          name: 'Review',
          description: '',
          phases: [],
          status: 'running',
          spawnedAgents: 1,
          completedAgents: 0,
          startedAt: '2026-08-14T08:00:00.000Z',
          agents: [{ agentId: 'agent-1', label: 'task:1', status: 'running' }],
          logLines: [],
        } as WorkflowRunView,
      ],
      new Map(),
    );
    handler.subagentInfo.set('agent-1', {
      parentToolCallId: 'wf-call',
      name: 'explore',
      description: 'task:1',
      runInBackground: false,
      startedAtMs: 0,
    });

    handler.routeChildAgentEvent({
      type: 'tool.call.started',
      agentId: 'agent-1',
      toolCallId: 'tc-1',
      name: 'Bash',
      args: { command: 'ls' },
    } as unknown as Event);
    handler.routeChildAgentEvent({
      type: 'assistant.delta',
      agentId: 'agent-1',
      delta: 'reading files',
    } as unknown as Event);
    handler.routeChildAgentEvent({
      type: 'agent.status.updated',
      agentId: 'agent-1',
      usage: { total: { output: 350, inputOther: 0, inputCacheRead: 0, inputCacheCreation: 0 } },
    } as unknown as Event);

    expect(handler.subagentTokenTotals.get('agent-1')).toBe(350);

    const rows = handler.collectRunningAgents();
    expect(rows[1]).toMatchObject({
      id: 'workflow:wf_live:agent-1',
      latestActivity: 'Using Bash (ls)',
      tokens: 350,
    });
  });

  it('attributes an in-flight workflow subagent to its run from the run ledger when the card is gone', () => {
    // No active tool call and no mounted card — the run ledger is the only
    // signal that agent-1 belongs to the workflow. It must render under the
    // run row, not as a standalone foreground row.
    const handler = makeHandler(
      new Map(),
      [
        {
          runId: 'wf_live',
          name: 'Review',
          description: '',
          phases: [],
          status: 'running',
          spawnedAgents: 1,
          completedAgents: 0,
          startedAt: '2026-08-14T08:00:00.000Z',
          agents: [{ agentId: 'agent-1', label: 'task:1', status: 'running' }],
          logLines: [],
        } as WorkflowRunView,
      ],
      new Map(),
    );
    handler.subagentInfo.set('agent-1', {
      parentToolCallId: 'wf-call',
      name: 'explore',
      description: 'task:1',
      runInBackground: false,
      startedAtMs: 0,
    });

    const rows = handler.collectRunningAgents();
    expect(rows).toHaveLength(2);
    expect(rows[1]).toMatchObject({
      id: 'workflow:wf_live:agent-1',
      name: 'task:1',
      description: 'working…',
      phase: 'running',
    });
  });

  it('routes activity-ledger child events to the injected footer sync', () => {
    const components = new Map([['wf-call', makeToolComponent(makeSnapshot('Running workflow'))]]);
    const syncRunningAgentsFooter = vi.fn();
    const streamingUI = {
      getToolComponent: (toolCallId: string) => components.get(toolCallId),
      getActiveToolCall: () => undefined,
    } as unknown as StreamingUIController;
    const host = {
      streamingUI,
      btwPanelController: { routeEvent: () => false },
      state: { appState: { workflowRuns: [] } },
    } as unknown as SessionEventHost;
    const handler = new SubAgentEventHandler(host, {
      backgroundTasks: new Map(),
      backgroundTaskTranscriptedTerminal: new Set(),
      syncBackgroundAgentBadge: () => {},
      syncRunningAgentsFooter,
    });
    handler.subagentInfo.set('agent-1', {
      parentToolCallId: 'wf-call',
      name: 'explore',
      description: 'task:1',
      runInBackground: false,
      startedAtMs: 0,
    });

    handler.routeChildAgentEvent({
      type: 'assistant.delta',
      agentId: 'agent-1',
      delta: 'hello',
    } as unknown as Event);
    expect(syncRunningAgentsFooter).toHaveBeenCalledTimes(1);

    // `tool.progress` stdout/stderr bursts are included too — the caller's
    // trailing throttle coalesces them.
    handler.routeChildAgentEvent({
      type: 'tool.progress',
      agentId: 'agent-1',
      toolCallId: 't1',
      update: { kind: 'stdout', text: 'line' },
    } as unknown as Event);
    expect(syncRunningAgentsFooter).toHaveBeenCalledTimes(2);
  });
});

describe('collectWorkflowRunAgents', () => {
  it('reports per-member tokens and sums the folded summary from tokensForAgent', () => {
    const run = {
      runId: 'wf_live',
      name: 'Review',
      description: '',
      phases: [],
      status: 'running',
      spawnedAgents: 6,
      completedAgents: 0,
      startedAt: '2026-08-14T08:00:00.000Z',
      agents: Array.from({ length: 6 }, (_item, index) => ({
        agentId: `agent-${String(index + 1)}`,
        label: `task:${String(index + 1)}`,
        status: 'running' as const,
      })),
      logLines: [],
    } as WorkflowRunView;
    const tokens = new Map([
      ['agent-1', 100],
      ['agent-2', 200],
      ['agent-3', 300],
      ['agent-4', 400],
      ['agent-5', 500],
      ['agent-6', 600],
    ]);
    const rows = collectWorkflowRunAgents(
      run,
      Date.parse('2026-08-14T08:00:00.000Z'),
      undefined,
      [],
      (agentId) => tokens.get(agentId) ?? 0,
    );
    expect(rows).toHaveLength(SWARM_MEMBER_LIMIT + 1);
    expect(rows[0]!.tokens).toBe(100);
    expect(rows[1]!.tokens).toBe(200);
    expect(rows[2]!.tokens).toBe(300);
    expect(rows[3]!.tokens).toBe(400);
    // Members beyond SWARM_MEMBER_LIMIT fold into the summary, which sums
    // their tokens so the collapsed display keeps the batch total visible.
    const summary = rows[SWARM_MEMBER_LIMIT]!;
    expect(summary).toMatchObject({ id: 'workflow:wf_live:summary' });
    expect(summary.tokens).toBe(500 + 600);
  });

  it('reports tokens for live in-flight agents too', () => {
    const run = {
      runId: 'wf_live',
      name: 'Review',
      description: '',
      phases: [],
      status: 'running',
      spawnedAgents: 1,
      completedAgents: 0,
      startedAt: '2026-08-14T08:00:00.000Z',
      agents: [],
      logLines: [],
    } as WorkflowRunView;
    const rows = collectWorkflowRunAgents(
      run,
      Date.parse('2026-08-14T08:00:00.000Z'),
      undefined,
      [{ agentId: 'agent-1', name: 'task:1', startedAtMs: 5_000 }],
      (agentId) => (agentId === 'agent-1' ? 42 : 0),
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ id: 'workflow:wf_live:agent-1', tokens: 42 });
  });
});

describe('agent swarm card viewport visibility', () => {
  const FRAME_MS = 120;

  /** A filler transcript child that always renders `height` blank lines, so a
   *  test can push the swarm card below the (mock) viewport bottom. */
  class FillerComponent implements Component {
    constructor(private readonly height: number) {}
    render(): string[] {
      return Array.from({ length: this.height }, () => '');
    }
    invalidate(): void {}
  }

  function makeVisibilityHandler(options: { rows: number; columns: number }): {
    handler: SubAgentEventHandler;
    ui: { terminal: { rows: number; columns: number }; requestRender: ReturnType<typeof vi.fn> };
    transcript: GutterContainer;
  } {
    const transcript = new GutterContainer(0, 0);
    const ui = {
      children: [transcript],
      terminal: { rows: options.rows, columns: options.columns },
      requestRender: vi.fn(),
    };
    const host = {
      streamingUI: {
        getToolComponent: () => undefined,
        getActiveToolCall: () => undefined,
        finalizeLiveTextBuffers: () => {},
        removeToolComponentIfInactive: () => {},
      },
      btwPanelController: { routeEvent: () => false },
      updateActivityPane: () => {},
      state: { ui, transcriptContainer: transcript, appState: { workflowRuns: [] } },
    } as unknown as SessionEventHost;
    const deps: SubAgentEventHandlerDependencies = {
      backgroundTasks: new Map(),
      backgroundTaskTranscriptedTerminal: new Set(),
      syncBackgroundAgentBadge: () => {},
      syncRunningAgentsFooter: () => {},
    };
    return { handler: new SubAgentEventHandler(host, deps), ui, transcript };
  }

  /** Create a swarm card with a completed member (estimator prior) plus a
   *  running member, then render once so the progress bar enters catch-up and
   *  the 120ms animation loop starts driving `ui.requestRender`. */
  function addAnimatedCard(
    handler: SubAgentEventHandler,
    transcript: GutterContainer,
    toolCallId: string,
  ): AgentSwarmProgressComponent {
    handler.handleAgentSwarmToolCallStarted(toolCallId, { description: 'Review files' });
    const card = transcript.children.find(
      (child): child is AgentSwarmProgressComponent =>
        child instanceof AgentSwarmProgressComponent,
    );
    expect(card).toBeDefined();
    card!.registerSubagent({ agentId: 'agent-0' });
    card!.markStarted('agent-0');
    vi.advanceTimersByTime(1_000); // real duration so the prior rate is sane
    card!.markCompleted('agent-0');
    card!.registerSubagent({ agentId: 'agent-1' });
    card!.markStarted('agent-1');
    vi.advanceTimersByTime(500);
    card!.render(100);
    return card!;
  }

  it('stops the card render loop once later content pushes it off the viewport', () => {
    vi.useFakeTimers();
    const { handler, ui, transcript } = makeVisibilityHandler({ rows: 5, columns: 100 });
    addAnimatedCard(handler, transcript, 'tc-1');

    vi.advanceTimersByTime(FRAME_MS * 3);
    expect(ui.requestRender.mock.calls.length).toBeGreaterThanOrEqual(3);

    // Push enough rows below the card to fill the 5-row viewport; the next
    // animation tick re-evaluates visibility and stops the loop.
    transcript.addChild(new FillerComponent(10));
    vi.advanceTimersByTime(FRAME_MS * 3);
    ui.requestRender.mockClear();
    vi.advanceTimersByTime(FRAME_MS * 3);
    expect(ui.requestRender).not.toHaveBeenCalled();
  });

  it('resumes the card render loop when the viewport grows to show it again', () => {
    vi.useFakeTimers();
    const { handler, ui, transcript } = makeVisibilityHandler({ rows: 5, columns: 100 });
    addAnimatedCard(handler, transcript, 'tc-1');

    transcript.addChild(new FillerComponent(10));
    vi.advanceTimersByTime(FRAME_MS * 3);
    ui.requestRender.mockClear();
    vi.advanceTimersByTime(FRAME_MS * 3);
    expect(ui.requestRender).not.toHaveBeenCalled();

    // Growing the viewport brings the card back on screen; the next event
    // re-evaluates and restarts the animation loop.
    ui.terminal.rows = 50;
    handler.handleAgentSwarmToolCallStarted('tc-1', { description: 'Review files' });
    vi.advanceTimersByTime(FRAME_MS * 2);
    expect(ui.requestRender.mock.calls.length).toBeGreaterThanOrEqual(2);
  });
});
