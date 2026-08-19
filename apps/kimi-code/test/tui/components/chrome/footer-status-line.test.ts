import { describe, expect, it, vi } from 'vitest';

import { FooterComponent } from '#/tui/components/chrome/footer';
import {
  runStatusLineCommand,
  STATUS_LINE_MAX_CAPTURE_BYTES,
  StatusLineCommandRunner,
  type StatusLinePayload,
} from '#/tui/utils/status-line-command';
import type { AppState } from '#/tui/types';

const baseState: AppState = {
  version: '1.2.3',
  workDir: '/tmp/project',
  additionalDirs: [],
  sessionId: 'ses-1',
  sessionTitle: null,
  model: 'kimi-k2',
  permissionMode: 'manual',
  thinkingEffort: 'off',
  contextUsage: 0,
  contextTokens: 0,
  maxContextTokens: 0,
  isCompacting: false,
  isReplaying: false,
  streamingPhase: 'idle',
  streamingStartTime: 0,
  planMode: false,
  inputMode: 'prompt',
  swarmMode: false,
  theme: 'dark',
  editorCommand: null,
  notifications: { enabled: true, condition: 'unfocused' },
  upgrade: { autoInstall: true },
  availableModels: {},
  availableProviders: {},
  mcpServersSummary: null,
  workflowRuns: [],
};

const payload: StatusLinePayload = {
  model: 'kimi-k2',
  cwd: '/tmp/project',
  gitBranch: 'main',
  permissionMode: 'manual',
  planMode: false,
  contextUsage: 12,
  contextTokens: 1024,
  maxContextTokens: 8192,
  sessionId: 'ses-1',
  version: '1.2.3',
};

function plain(text: string): string {
  // eslint-disable-next-line no-control-regex
  return text.replaceAll(/\u001B\[[0-9;]*m/g, '');
}

function printCommand(text: string): string {
  return process.platform === 'win32' ? `echo ${text}` : `printf "${text}"`;
}

describe('FooterComponent status_line items', () => {
  it('renders only the chosen slots in the given order', () => {
    const state: AppState = {
      ...baseState,
      statusLine: { items: ['cwd', 'model'], command: null },
    };
    const footer = new FooterComponent(state);

    const rendered = footer.render(120).slice(0, 2).map(plain).join('\n');
    const cwdAt = rendered.indexOf('/tmp/project');
    const modelAt = rendered.indexOf('kimi-k2');
    expect(cwdAt).toBeGreaterThanOrEqual(0);
    expect(modelAt).toBeLessThan(cwdAt);
    expect(rendered).not.toContain('goal');
  });

  it('keeps the default layout when statusLine is unset', () => {
    const footer = new FooterComponent({ ...baseState });

    const line1 = plain(footer.render(120)[0]!);
    expect(line1).toContain('kimi-k2');
    // Default layout omits the cwd / git badges.
    expect(line1).not.toContain('/tmp/project');
  });

  it('drops the rotating tips when tips is not in items', () => {
    const withTipsState: AppState = {
      ...baseState,
      statusLine: { items: ['model', 'cwd', 'tips'], command: null },
    };
    const withTips = new FooterComponent(withTipsState).render(200).slice(0, 2).map(plain).join('\n');
    const tipsOnly = plain(
      new FooterComponent({
        ...baseState,
        statusLine: { items: ['tips'], command: null },
      }).render(200)[1]!,
    ).trim();
    const state: AppState = {
      ...baseState,
      statusLine: { items: ['model', 'cwd'], command: null },
    };
    const withoutTips = new FooterComponent(state).render(200).slice(0, 2).map(plain).join('\n');

    expect(withTips).toContain(tipsOnly);
    expect(withoutTips).not.toContain(tipsOnly);
    expect(withoutTips).toContain('kimi-k2');
    expect(withoutTips.trimEnd()).toMatch(/\/tmp\/project$/);
  });

  it('renders configured tips on the secondary footer line', () => {
    const tipsOnly = plain(
      new FooterComponent({
        ...baseState,
        statusLine: { items: ['tips'], command: null },
      }).render(200)[1]!,
    ).trim();
    const rendered = new FooterComponent({
      ...baseState,
      statusLine: { items: ['model', 'tips'], command: null },
    }).render(200);
    const primary = plain(rendered[0]!);
    const secondary = plain(rendered[1]!);

    expect(tipsOnly.length).toBeGreaterThan(0);
    expect(primary).toContain('kimi-k2');
    expect(primary).not.toContain(tipsOnly);
    expect(secondary).toContain(tipsOnly);
  });

  it('keeps primary slots on line one when secondary slots are ordered first', () => {
    const rendered = new FooterComponent({
      ...baseState,
      statusLine: { items: ['tips', 'model'], command: null },
    }).render(200);
    const primary = plain(rendered[0]!);
    const secondary = plain(rendered[1]!);

    expect(primary).toContain('kimi-k2');
    expect(secondary.trim().length).toBeGreaterThan(0);
  });

  it('renders tips after other secondary slots when configured later', () => {
    const tipsOnly = plain(
      new FooterComponent({
        ...baseState,
        statusLine: { items: ['tips'], command: null },
      }).render(200)[1]!,
    ).trim();
    const secondary = plain(
      new FooterComponent({
        ...baseState,
        statusLine: { items: ['cwd', 'tips'], command: null },
      }).render(200)[1]!,
    );

    expect(secondary.indexOf('/tmp/project')).toBeLessThan(secondary.indexOf(tipsOnly));
  });

  it('renders nothing on line 1 for an empty items list', () => {
    const state: AppState = {
      ...baseState,
      statusLine: { items: [], command: null },
    };
    const footer = new FooterComponent(state);

    expect(plain(footer.render(120)[0]!).trim()).toBe('');
  });
});

describe('runStatusLineCommand', () => {
  it('passes the payload as JSON on stdin and returns the first stdout line', async () => {
    const line = await runStatusLineCommand(
      process.platform === 'win32' ? 'more' : 'cat',
      payload,
      10_000,
    );

    expect(line).not.toBeNull();
    const parsed = JSON.parse(line!);
    expect(parsed.model).toBe('kimi-k2');
    expect(parsed.gitBranch).toBe('main');
    expect(parsed.cwd).toBe('/tmp/project');
  }, 15_000);

  it('returns null on a nonzero exit', async () => {
    const command = process.platform === 'win32' ? 'exit /b 3' : 'exit 3';
    expect(await runStatusLineCommand(command, payload)).toBeNull();
  });

  it('returns null on empty output', async () => {
    const command = process.platform === 'win32' ? 'ver >nul' : 'true';
    expect(await runStatusLineCommand(command, payload)).toBeNull();
  });

  it('returns null when the command overruns the timeout', async () => {
    expect(
      await runStatusLineCommand(
        process.platform === 'win32' ? 'ping 127.0.0.1 -n 3 >nul' : 'sleep 2',
        payload,
        100,
      ),
    ).toBeNull();
  });

  it('trims the line and ignores later lines', async () => {
    const line = await runStatusLineCommand(
      process.platform === 'win32' ? '(echo first& echo second)' : 'printf "first\\nsecond\\n"',
      payload,
    );

    expect(line).toBe('first');
  });

  it('caps the captured output instead of accumulating an unending stream', async () => {
    // 200 KB on a single line, then exit: only the capped prefix is kept.
    const command =
      process.platform === 'win32'
        ? "powershell -NoProfile -Command \"[Console]::Out.Write('a' * 200000)\""
        : 'head -c 200000 /dev/zero | tr "\\0" "a"';
    const line = await runStatusLineCommand(command, payload, 10_000);

    expect(line).not.toBeNull();
    expect(line!.length).toBeLessThanOrEqual(STATUS_LINE_MAX_CAPTURE_BYTES);
  }, 15_000);
});

describe('FooterComponent status_line command', () => {
  it('swaps line 1 to the command output once it lands', async () => {
    const state: AppState = {
      ...baseState,
      statusLine: { items: null, command: printCommand('my-custom-status') },
    };
    const footer = new FooterComponent(state);

    // Before the first run completes the built-in layout is still shown.
    expect(plain(footer.render(120)[0]!)).toContain('kimi-k2');

    await new Promise((resolve) => setTimeout(resolve, 500));

    expect(plain(footer.render(120)[0]!)).toContain('my-custom-status');
  });

  it('keeps the built-in layout when the command fails', async () => {
    const state: AppState = {
      ...baseState,
      statusLine: { items: null, command: process.platform === 'win32' ? 'exit /b 1' : 'exit 1' },
    };
    const footer = new FooterComponent(state);

    await new Promise((resolve) => setTimeout(resolve, 200));

    expect(plain(footer.render(120)[0]!)).toContain('kimi-k2');
  });
});

describe('StatusLineCommandRunner', () => {
  it('caches the last good line and coalesces refreshes in the same interval', async () => {
    const runner = new StatusLineCommandRunner(printCommand('x'), () => {});

    runner.maybeRefresh(payload);
    runner.maybeRefresh(payload);
    await new Promise((resolve) => setTimeout(resolve, 500));

    expect(runner.current()).toBe('x');
  });

  it('runs a deferred refresh after the throttle interval instead of dropping it', async () => {
    const onUpdate = vi.fn();
    const runner = new StatusLineCommandRunner(printCommand('x'), onUpdate);

    runner.maybeRefresh(payload);
    await new Promise((resolve) => setTimeout(resolve, 250));
    runner.maybeRefresh(payload); // throttled: must defer, not drop
    await new Promise((resolve) => setTimeout(resolve, 250));
    expect(onUpdate).toHaveBeenCalledTimes(1);

    await new Promise((resolve) => setTimeout(resolve, 2_000));
    expect(onUpdate).toHaveBeenCalledTimes(2);
    runner.dispose();
  });

  it('recreates the runner when the command changes', async () => {
    const state: AppState = {
      ...baseState,
      statusLine: { items: null, command: printCommand('aaa') },
    };
    const footer = new FooterComponent(state);
    footer.render(120); // kicks the first run
    await new Promise((resolve) => setTimeout(resolve, 450));
    expect(plain(footer.render(120)[0]!)).toContain('aaa');

    footer.setState({
      ...state,
      statusLine: { items: null, command: printCommand('bbb') },
    });
    footer.render(120); // kicks the replacement run
    await new Promise((resolve) => setTimeout(resolve, 450));

    const line1 = plain(footer.render(120)[0]!);
    expect(line1).toContain('bbb');
    expect(line1).not.toContain('aaa');
  });
});
