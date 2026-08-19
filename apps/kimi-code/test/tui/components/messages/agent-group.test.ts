import type { TUI } from '@moonshot-ai/pi-tui';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { AgentGroupComponent } from '#/tui/components/messages/agent-group';
import { ToolCallComponent } from '#/tui/components/messages/tool-call';

const ESC = String.fromCodePoint(0x1b);
const BEL = String.fromCodePoint(0x07);

function strip(text: string): string {
  return text
    .replaceAll(/\u001B\[[0-9;]*m/g, '')
    .replaceAll(new RegExp(`${ESC}\\]8;;[^${BEL}]*${BEL}`, 'g'), '');
}

function stubTui(): TUI {
  return {
    terminal: { rows: 40 },
    requestRender: vi.fn(),
  } as unknown as TUI;
}

function renderText(component: AgentGroupComponent, width = 120): string {
  return strip(component.render(width).join('\n'));
}

function createAgent(
  id: string,
  description: string,
  agentName: string,
  ui: TUI,
): ToolCallComponent {
  const component = new ToolCallComponent(
    {
      id,
      name: 'Agent',
      args: { description },
    },
    undefined,
    ui,
  );
  component.onSubagentSpawned({
    agentId: `sub_${id}`,
    agentName,
    runInBackground: false,
  });
  return component;
}

function startAgent(component: ToolCallComponent, id: string, agentName: string): void {
  component.onSubagentStarted({
    agentId: `sub_${id}`,
    agentName,
    runInBackground: false,
  });
}

describe('AgentGroupComponent', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('shows explicit active breakdown, row state, and waiting fallback', () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const ui = stubTui();
    const group = new AgentGroupComponent(ui);
    const running = createAgent('call_agent_1', 'inspect project', 'explore', ui);
    const waiting = createAgent('call_agent_2', 'write tests', 'coder', ui);

    startAgent(running, 'call_agent_1', 'explore');
    running.appendSubToolCall({
      id: 'sub_call_agent_1:read',
      name: 'Read',
      args: { path: 'src/a.ts' },
    });

    group.attach('call_agent_1', running);
    group.attach('call_agent_2', waiting);

    const output = renderText(group);
    expect(output).toContain('2 agents (1 running, 1 waiting)');
    expect(output).toContain('explore (inspect project) · 1 tool use');
    expect(output).toContain('⎿  Using Read (src/a.ts)');
    expect(output).toContain('coder (write tests) · 0 tool uses');
    expect(output).toContain('⎿  Initializing…');
    expect(output).not.toContain('Running 2 agents');

    group.dispose();
    running.dispose();
    waiting.dispose();
  });

  it('shows the bound model in the row stats once reported', () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const ui = stubTui();
    const group = new AgentGroupComponent(ui);
    const running = createAgent('call_agent_1', 'inspect project', 'explore', ui);
    startAgent(running, 'call_agent_1', 'explore');

    group.attach('call_agent_1', running);
    expect(renderText(group)).toContain('explore (inspect project) · 0 tool uses');

    running.updateSubagentMetrics({ modelDisplay: 'Kimi K2.5', effortDisplay: 'high' });
    // Non-phase updates are throttled; flush the pending refresh.
    vi.runOnlyPendingTimers();
    expect(renderText(group)).toContain(
      'explore (inspect project) · Kimi K2.5 · high · 0 tool uses',
    );

    group.dispose();
    running.dispose();
  });

  it('shows the Ctrl+B hint while agents are running and hides it once all are backgrounded', () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const ui = stubTui();
    const group = new AgentGroupComponent(ui);
    const a = createAgent('call_agent_1', 'inspect project', 'explore', ui);
    const b = createAgent('call_agent_2', 'write tests', 'coder', ui);
    startAgent(a, 'call_agent_1', 'explore');
    startAgent(b, 'call_agent_2', 'coder');
    group.attach('call_agent_1', a);
    group.attach('call_agent_2', b);

    expect(renderText(group)).toContain('(ctrl+b to run in background)');

    a.markBackgrounded();
    expect(renderText(group)).toContain('(ctrl+b to run in background)');

    b.markBackgrounded();
    expect(renderText(group)).not.toContain('(ctrl+b to run in background)');

    group.dispose();
    a.dispose();
    b.dispose();
  });

  it('uses still-working fallback for running agents without recent activity', () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const ui = stubTui();
    const group = new AgentGroupComponent(ui);
    const running = createAgent('call_agent_1', 'inspect project', 'explore', ui);
    const waiting = createAgent('call_agent_2', 'write tests', 'coder', ui);

    startAgent(running, 'call_agent_1', 'explore');
    group.attach('call_agent_1', running);
    group.attach('call_agent_2', waiting);

    const output = renderText(group);
    expect(output).toContain('Still working…');
    expect(output).toContain('Initializing…');
    expect(output).not.toContain('Waiting to start…');

    group.dispose();
    running.dispose();
    waiting.dispose();
  });

  it('keeps grouped rows free of elapsed-time churn while child timers tick', () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const ui = stubTui();
    const group = new AgentGroupComponent(ui);
    const running = createAgent('call_agent_1', 'inspect project', 'explore', ui);
    const waiting = createAgent('call_agent_2', 'write tests', 'coder', ui);

    startAgent(running, 'call_agent_1', 'explore');
    group.attach('call_agent_1', running);
    group.attach('call_agent_2', waiting);

    let output = renderText(group);
    expect(output).toContain('2 agents (1 running, 1 waiting)');
    expect(output).not.toContain('0s');
    vi.mocked(ui.requestRender).mockClear();

    vi.advanceTimersByTime(1_200);

    expect(ui.requestRender).toHaveBeenCalled();
    output = renderText(group);
    expect(output).toContain('explore (inspect project) · 0 tool uses');
    expect(output).not.toContain('1s');

    group.dispose();
    running.dispose();
    waiting.dispose();
  });

  it('keeps per-agent status rows explicit through mixed terminal states', () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const ui = stubTui();
    const group = new AgentGroupComponent(ui);
    const done = createAgent('call_agent_1', 'inspect project', 'explore', ui);
    const running = createAgent('call_agent_2', 'write tests', 'coder', ui);

    startAgent(done, 'call_agent_1', 'explore');
    startAgent(running, 'call_agent_2', 'coder');
    group.attach('call_agent_1', done);
    group.attach('call_agent_2', running);

    vi.setSystemTime(12_000);
    done.onSubagentCompleted({ resultSummary: 'done' });

    const mixed = renderText(group);
    expect(mixed).toContain('2 agents (1 done, 1 running)');
    expect(mixed).toContain('explore (inspect project) · 0 tool uses');
    expect(mixed).toContain('⎿  Done');
    expect(mixed).toContain('coder (write tests) · 0 tool uses');
    expect(mixed).toContain('⎿  Still working…');
    expect(mixed).not.toContain('12s');

    vi.setSystemTime(15_000);
    running.onSubagentFailed({ error: 'review failed' });

    const terminal = renderText(group);
    expect(terminal).toContain('2 agents (1 done, 1 failed)');
    expect(terminal).toContain('⎿  Done');
    expect(terminal).toContain('⎿  Error: review failed');
    expect(terminal).not.toContain('Still working…');

    group.dispose();
    done.dispose();
    running.dispose();
  });

  it('renders a detached foreground subagent as backgrounded in the group, even after its ToolResult lands', () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const ui = stubTui();
    const group = new AgentGroupComponent(ui);
    const a = createAgent('call_agent_1', 'inspect project', 'explore', ui);
    const b = createAgent('call_agent_2', 'write tests', 'coder', ui);
    startAgent(a, 'call_agent_1', 'explore');
    startAgent(b, 'call_agent_2', 'coder');
    group.attach('call_agent_1', a);
    group.attach('call_agent_2', b);

    // Detach `a` (Ctrl+B), then its spawn-success ToolResult lands.
    a.markBackgrounded();
    a.setResult({
      tool_call_id: 'call_agent_1',
      output: 'agent_id: sub_call_agent_1\nactual_subagent_type: explore\n',
      is_error: false,
    });

    const out = renderText(group);
    expect(out).toContain('2 agents (1 backgrounded, 1 running)');
    // `a` must stay backgrounded, not become done.
    expect(out).toContain('⎿  Running in the background');
    expect(out).not.toContain('⎿  Done');
    // `b` is still running.
    expect(out).toContain('⎿  Still working…');

    group.dispose();
    a.dispose();
    b.dispose();
  });
});
