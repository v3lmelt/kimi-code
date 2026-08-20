import type { Terminal } from '@moonshot-ai/pi-tui';
import type { BackgroundTaskInfo } from '@moonshot-ai/kimi-code-sdk';
import { describe, expect, it, vi } from 'vitest';

import { RuntimeCenterApp, type RuntimeCenterProps } from '@/tui/components/dialogs/runtime-center';
import { projectRuntimeCenter, type RuntimeCenterProjection } from '@/tui/utils/runtime-center-model';
import type { WorkflowRunView } from '@/tui/utils/workflow-model';

const ANSI_SGR = /\[[0-9;]*m/g;
const strip = (value: string): string => value.replaceAll(ANSI_SGR, '');

function terminal(rows: number): Terminal {
  return {
    start: () => {}, stop: () => {}, drainInput: () => Promise.resolve(), write: () => {},
    columns: 120, rows, kittyProtocolActive: false, moveBy: () => {}, hideCursor: () => {},
    showCursor: () => {}, clearLine: () => {}, clearFromCursor: () => {}, clearScreen: () => {},
    setTitle: () => {}, setProgress: () => {},
  } as unknown as Terminal;
}

function task(overrides: Record<string, unknown> = {}): BackgroundTaskInfo {
  return {
    taskId: 'task-1', kind: 'process', command: 'echo ok', description: 'build', status: 'running',
    pid: 1, exitCode: null, startedAt: Date.now() - 1000, endedAt: null, ...overrides,
  } as BackgroundTaskInfo;
}

function workflow(): WorkflowRunView {
  return {
    runId: 'wf-1', name: 'release', description: 'ship it', phases: [{ title: 'build' }],
    status: 'running', phase: 'build', spawnedAgents: 1, completedAgents: 0,
    startedAt: new Date(Date.now() - 1000).toISOString(), agents: [
      { agentId: 'agent-1', label: 'builder', phase: 'build', status: 'running' },
    ], logLines: [],
  };
}

function props(overrides: Partial<RuntimeCenterProps> = {}): RuntimeCenterProps {
  const projection: RuntimeCenterProjection = projectRuntimeCenter({
    tasks: [task({ taskId: 'task-1', agentId: 'agent-1' })],
    workflows: [workflow()],
    agentMetadata: { 'agent-1': { type: 'sub', parentAgentId: 'main', workspaceMode: 'session' } },
  });
  return {
    view: 'tasks', projection, selectedKey: 'task:task-1', flashMessage: undefined,
    onSelect: vi.fn(), onViewChange: vi.fn(), onRefresh: vi.fn(), onCancel: vi.fn(),
    onAction: vi.fn(), onActionUnavailable: vi.fn(), ...overrides,
  };
}

describe('RuntimeCenterApp', () => {
  it('renders all three tabs and preserves exact height at a narrow terminal', () => {
    const app = new RuntimeCenterApp(props(), terminal(12));
    const lines = app.render(120);
    expect(lines).toHaveLength(12);
    const output = strip(lines.join('\n'));
    expect(output).toContain('RUNTIME CENTER');
    expect(output).toContain('Tasks');
    expect(output).toContain('Agents');
    expect(output).toContain('Workflows');
    expect(output).toContain('Task ID:');
  });

  it('renders an unavailable identity and a bounded-list hint on a narrow terminal', () => {
    const projection = projectRuntimeCenter({
      tasks: Array.from({ length: 20 }, (_, index) => task({ taskId: `task-${String(index)}` })),
      workflows: [],
    });
    const app = new RuntimeCenterApp(
      props({ projection, selectedKey: 'task:task-0' }),
      terminal(12),
    );
    const output = strip(app.render(56).join('\n'));
    expect(output).toContain('more');
    expect(output).toContain('unavailable');
    expect(app.render(55)).toHaveLength(12);
    expect(strip(app.render(55).join('\n'))).toContain('needs at least');
  });

  it('supports tab view switching and workflow drill-down selection', () => {
    const onViewChange = vi.fn();
    const app = new RuntimeCenterApp(props({ onViewChange }), terminal(20));
    app.handleInput('\t');
    expect(onViewChange).toHaveBeenCalledWith('agents');
    app.setProps(props({ view: 'workflows', selectedKey: 'workflow:wf-1' }));
    expect(strip(app.render(120).join('\n'))).toContain('DAG node:');
    expect(strip(app.render(120).join('\n'))).toContain('release');
  });

  it('routes enabled stop and output actions, and reports unsupported actions', () => {
    const onAction = vi.fn();
    const onActionUnavailable = vi.fn();
    const app = new RuntimeCenterApp(props({ onAction, onActionUnavailable }), terminal(20));
    app.handleInput('s');
    expect(onAction).not.toHaveBeenCalled();
    expect(strip(app.render(120).join('\n'))).toContain('Y confirm');
    app.handleInput('y');
    expect(onAction).toHaveBeenCalledWith('stop', 'task:task-1');
    app.handleInput('o');
    expect(onAction).toHaveBeenCalledWith('output', 'task:task-1');
    app.setProps(props({ view: 'workflows', selectedKey: 'workflow:wf-1', onAction, onActionUnavailable }));
    app.handleInput('y');
    expect(onActionUnavailable).toHaveBeenCalledWith(
      'retry',
      'workflow:wf-1',
      expect.stringContaining('not exposed'),
    );
  });

  it('uses Esc to leave and gives agents a disabled targeted-message reason', () => {
    const onCancel = vi.fn();
    const onActionUnavailable = vi.fn();
    const app = new RuntimeCenterApp(
      props({ view: 'agents', selectedKey: 'agent:agent-1', onCancel, onActionUnavailable }),
      terminal(20),
    );
    app.handleInput('m');
    expect(onActionUnavailable).toHaveBeenCalledWith(
      'message',
      'agent:agent-1',
      expect.stringContaining('Targeted agent'),
    );
    app.handleInput('\u001b');
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it('requires confirmation for stop and consumes Esc while confirmation is pending', () => {
    const onAction = vi.fn();
    const onCancel = vi.fn();
    const app = new RuntimeCenterApp(props({ onAction, onCancel }), terminal(20));
    app.handleInput('s');
    app.handleInput('\u001b');
    expect(onAction).not.toHaveBeenCalled();
    expect(onCancel).not.toHaveBeenCalled();
    app.handleInput('s');
    app.handleInput('N');
    expect(onAction).not.toHaveBeenCalled();
    app.handleInput('s');
    app.handleInput('Y');
    expect(onAction).toHaveBeenCalledWith('stop', 'task:task-1');
  });

  it('disables stop and output when a foreground or unmapped agent lacks an owner', () => {
    const onAction = vi.fn();
    const onActionUnavailable = vi.fn();
    const foregroundProjection = projectRuntimeCenter({
      tasks: [task({ detached: false })],
      workflows: [],
      agentMetadata: { orphan: { type: 'sub' } },
    });
    const foreground = new RuntimeCenterApp(
      props({ projection: foregroundProjection, selectedKey: 'task:task-1', onAction, onActionUnavailable }),
      terminal(20),
    );
    foreground.handleInput('s');
    expect(onAction).not.toHaveBeenCalled();
    expect(onActionUnavailable).toHaveBeenCalledWith(
      'stop',
      'task:task-1',
      expect.stringContaining('Foreground'),
    );

    const orphan = new RuntimeCenterApp(
      props({ projection: foregroundProjection, view: 'agents', selectedKey: 'agent:orphan', onAction, onActionUnavailable }),
      terminal(20),
    );
    orphan.handleInput('o');
    expect(onActionUnavailable).toHaveBeenCalledWith(
      'output',
      'agent:orphan',
      expect.stringContaining('owning background task'),
    );
  });
});
