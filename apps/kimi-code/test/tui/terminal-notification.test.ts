import { spawn } from 'node:child_process';

import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { TUIState } from '#/tui/kimi-tui';
import {
  buildPowerShellToastScript,
  buildTerminalNotificationSequences,
  emitSystemNotification,
  emitTerminalNotification,
  formatNotification,
  isInsideTmux,
  notifyTerminalOnce,
  supportsOsc9Notification,
  supportsTerminalProgress,
  WINDOWS_TOAST_APP_ID,
} from '#/tui/utils/terminal-notification';

vi.mock('node:child_process', () => ({
  spawn: vi.fn(() => ({ on: vi.fn() })),
}));

function makeNotificationState(args: {
  readonly enabled?: boolean;
  readonly condition?: 'unfocused' | 'always';
  readonly focused?: boolean;
  readonly system?: boolean;
  readonly supportsOsc9?: boolean;
  readonly insideTmux?: boolean;
} = {}): TUIState {
  return {
    appState: {
      notifications: {
        enabled: args.enabled ?? true,
        condition: args.condition ?? 'unfocused',
        system: args.system ?? false,
      },
    },
    terminalState: {
      notificationKeys: new Set<string>(),
      focused: args.focused ?? false,
      supportsOsc9: args.supportsOsc9 ?? true,
      insideTmux: args.insideTmux ?? false,
    },
    terminal: {
      write: vi.fn(),
    },
  } as unknown as TUIState;
}

describe('terminal notification helpers', () => {
  it('emits OSC 9 only when the terminal supports it', () => {
    const terminal = { write: vi.fn() };

    emitTerminalNotification(
      terminal,
      { title: 'Hasu', body: 'Approval\nrequired' },
      { supportsOsc9: true, insideTmux: false },
    );

    expect(terminal.write).toHaveBeenCalledTimes(1);
    expect(terminal.write).toHaveBeenCalledWith(']9;Hasu: Approval required');
  });

  it('falls back to a bare BEL when the terminal does not support OSC 9', () => {
    const terminal = { write: vi.fn() };

    emitTerminalNotification(
      terminal,
      { title: 'Hasu', body: 'Approval required' },
      { supportsOsc9: false, insideTmux: false },
    );

    expect(terminal.write).toHaveBeenCalledTimes(1);
    expect(terminal.write).toHaveBeenCalledWith('');
  });

  it('wraps OSC 9 in a tmux DCS passthrough when running inside tmux', () => {
    const terminal = { write: vi.fn() };

    emitTerminalNotification(
      terminal,
      { title: 'Hasu', body: 'Approval required' },
      { supportsOsc9: true, insideTmux: true },
    );

    expect(terminal.write).toHaveBeenCalledTimes(1);
    expect(terminal.write).toHaveBeenCalledWith('Ptmux;]9;Hasu: Approval required\\');
  });

  it('skips the tmux wrap when falling back to BEL', () => {
    const terminal = { write: vi.fn() };

    emitTerminalNotification(
      terminal,
      { title: 'Hasu', body: 'Approval required' },
      { supportsOsc9: false, insideTmux: true },
    );

    expect(terminal.write).toHaveBeenCalledWith('');
  });

  it('emits nothing when the formatted message is empty', () => {
    const terminal = { write: vi.fn() };

    emitTerminalNotification(
      terminal,
      { title: '', body: '' },
      { supportsOsc9: true, insideTmux: false },
    );

    expect(terminal.write).not.toHaveBeenCalled();
  });

  it('deduplicates notifications by key on TUI state', () => {
    const state = makeNotificationState();

    notifyTerminalOnce(state, 'approval:req-1', { title: 'Approval required' });
    notifyTerminalOnce(state, 'approval:req-1', { title: 'Approval required' });
    notifyTerminalOnce(state, 'approval:req-2', { title: 'Approval required' });

    expect(state.terminal.write).toHaveBeenCalledTimes(2);
  });

  it('suppresses notifications while the terminal is focused', () => {
    const state = makeNotificationState({ focused: true });

    notifyTerminalOnce(state, 'approval:req-1', { title: 'Approval required' });
    state.terminalState.focused = false;
    notifyTerminalOnce(state, 'approval:req-1', { title: 'Approval required' });
    notifyTerminalOnce(state, 'approval:req-2', { title: 'Approval required' });

    expect(state.terminal.write).toHaveBeenCalledTimes(1);
    expect(state.terminalState.notificationKeys.has('approval:req-1')).toBe(true);
  });

  it('skips emission entirely when notifications.enabled is false', () => {
    const state = makeNotificationState({ enabled: false });

    notifyTerminalOnce(state, 'approval:req-1', { title: 'Approval required' });

    expect(state.terminal.write).not.toHaveBeenCalled();
    expect(state.terminalState.notificationKeys.has('approval:req-1')).toBe(false);
  });

  it('emits even while focused when condition is "always"', () => {
    const state = makeNotificationState({ condition: 'always', focused: true });

    notifyTerminalOnce(state, 'approval:req-1', { title: 'Approval required' });

    expect(state.terminal.write).toHaveBeenCalledTimes(1);
    expect(state.terminalState.notificationKeys.has('approval:req-1')).toBe(true);
  });

  it('uses the tmux-wrapped sequence when state.insideTmux is true', () => {
    const state = makeNotificationState({ insideTmux: true });

    notifyTerminalOnce(state, 'approval:req-1', { title: 'Approval required' });

    expect(state.terminal.write).toHaveBeenCalledTimes(1);
    expect(state.terminal.write).toHaveBeenCalledWith('Ptmux;]9;Approval required\\');
  });

  it('falls back to BEL on a TUI state that did not detect OSC 9 support', () => {
    const state = makeNotificationState({ supportsOsc9: false });

    notifyTerminalOnce(state, 'approval:req-1', { title: 'Approval required' });

    expect(state.terminal.write).toHaveBeenCalledTimes(1);
    expect(state.terminal.write).toHaveBeenCalledWith('');
  });

  it('falls back to body when the title is empty', () => {
    expect(formatNotification({ title: '', body: 'Question?' })).toBe('Question?');
  });

  it('returns OSC 9 / BEL based on capability flag', () => {
    expect(
      buildTerminalNotificationSequences(
        { title: 'A', body: 'B' },
        { supportsOsc9: true, insideTmux: false },
      ),
    ).toEqual([']9;A: B']);
    expect(
      buildTerminalNotificationSequences(
        { title: 'A', body: 'B' },
        { supportsOsc9: false, insideTmux: false },
      ),
    ).toEqual(['']);
  });

  it('doubles ESC bytes inside the tmux DCS payload', () => {
    const sequences = buildTerminalNotificationSequences(
      { title: 'A', body: 'B' },
      { supportsOsc9: true, insideTmux: true },
    );

    expect(sequences).toHaveLength(1);
    const wrapped = sequences[0]!;
    expect(wrapped.startsWith('Ptmux;')).toBe(true);
    expect(wrapped.endsWith('\\')).toBe(true);
    expect(wrapped).toContain(']9;A: B');
  });
});

describe('supportsOsc9Notification', () => {
  it('detects iTerm2 / WezTerm / Ghostty / Warp via TERM_PROGRAM', () => {
    expect(supportsOsc9Notification({ TERM_PROGRAM: 'iTerm.app' })).toBe(true);
    expect(supportsOsc9Notification({ TERM_PROGRAM: 'WezTerm' })).toBe(true);
    expect(supportsOsc9Notification({ TERM_PROGRAM: 'ghostty' })).toBe(true);
    expect(supportsOsc9Notification({ TERM_PROGRAM: 'WarpTerminal' })).toBe(true);
  });

  it('detects Kitty / Ghostty via TERM', () => {
    expect(supportsOsc9Notification({ TERM: 'xterm-kitty' })).toBe(true);
    expect(supportsOsc9Notification({ TERM: 'xterm-ghostty' })).toBe(true);
  });

  it('returns false for terminals known not to support OSC 9', () => {
    expect(supportsOsc9Notification({ TERM_PROGRAM: 'Apple_Terminal' })).toBe(false);
    expect(supportsOsc9Notification({ TERM_PROGRAM: 'vscode' })).toBe(false);
    expect(supportsOsc9Notification({ TERM_PROGRAM: 'tabby' })).toBe(false);
    expect(supportsOsc9Notification({ WT_SESSION: 'abc-123' })).toBe(false);
    expect(supportsOsc9Notification({ ConEmuANSI: 'ON' })).toBe(false);
    expect(supportsOsc9Notification({ TERM: 'xterm-256color' })).toBe(false);
    expect(supportsOsc9Notification({})).toBe(false);
  });
});

describe('supportsTerminalProgress', () => {
  it('detects Windows Terminal / ConEmu via env flags', () => {
    expect(supportsTerminalProgress({ WT_SESSION: 'abc-123' })).toBe(true);
    expect(supportsTerminalProgress({ ConEmuANSI: 'ON' })).toBe(true);
  });

  it('detects Ghostty / WezTerm via TERM_PROGRAM and TERM', () => {
    expect(supportsTerminalProgress({ TERM_PROGRAM: 'ghostty' })).toBe(true);
    expect(supportsTerminalProgress({ TERM: 'xterm-ghostty' })).toBe(true);
    expect(supportsTerminalProgress({ TERM_PROGRAM: 'WezTerm' })).toBe(true);
  });

  it('rejects terminals that show every OSC 9 payload as a notification', () => {
    // iTerm2 treats any OSC 9 payload as a desktop notification, so the
    // ConEmu-style 9;4 progress sequence must never be sent there.
    expect(supportsTerminalProgress({ TERM_PROGRAM: 'iTerm.app' })).toBe(false);
    expect(supportsTerminalProgress({ TERM_PROGRAM: 'Apple_Terminal' })).toBe(false);
    expect(supportsTerminalProgress({ TERM_PROGRAM: 'WarpTerminal' })).toBe(false);
    expect(supportsTerminalProgress({ TERM: 'xterm-kitty' })).toBe(false);
    expect(supportsTerminalProgress({ TERM: 'xterm-256color' })).toBe(false);
    expect(supportsTerminalProgress({ ConEmuANSI: 'OFF' })).toBe(false);
    expect(supportsTerminalProgress({ WT_SESSION: '' })).toBe(false);
    expect(supportsTerminalProgress({})).toBe(false);
  });
});

describe('isInsideTmux', () => {
  it('detects tmux via the TMUX env var', () => {
    expect(isInsideTmux({ TMUX: '/private/tmp/tmux-501/default,1234,0' })).toBe(true);
  });

  it('returns false when TMUX is empty or unset', () => {
    expect(isInsideTmux({ TMUX: '' })).toBe(false);
    expect(isInsideTmux({})).toBe(false);
  });
});

describe('Windows system (toast) notifications', () => {
  beforeEach(() => {
    vi.mocked(spawn).mockClear();
  });

  it('builds a self-contained PowerShell script with escaped title/body', () => {
    const script = buildPowerShellToastScript('Hasu needs you', `It's <done> & "ok"?`);

    expect(script).toContain(`<text>Hasu needs you</text>`);
    expect(script).toContain(`<text>It's &lt;done&gt; &amp; &quot;ok&quot;?</text>`);
    expect(script).toContain(WINDOWS_TOAST_APP_ID);
    expect(script).toContain('CreateToastNotifier');
  });

  it('spawns a hidden powershell.exe to raise the toast on Windows', () => {
    emitSystemNotification({ title: 'Hasu', body: 'Approval required' }, 'win32');

    expect(spawn).toHaveBeenCalledTimes(1);
    const [command, args] = vi.mocked(spawn).mock.calls[0]!;
    expect(command).toBe('powershell.exe');
    expect((args as string[])).toContain('-NoProfile');
    expect((args as string[])).toContain('-Command');
    // -WindowStyle Hidden would crash spawned powershell.exe; the console is
    // hidden via CREATE_NO_WINDOW instead.
    expect((args as string[])).not.toContain('-WindowStyle');
  });

  it('does nothing on non-Windows platforms', () => {
    emitSystemNotification({ title: 'Hasu' }, 'linux');
    emitSystemNotification({ title: 'Hasu' }, 'darwin');

    expect(spawn).not.toHaveBeenCalled();
  });
});

describe('notifyTerminalOnce system-toast integration', () => {
  beforeEach(() => {
    vi.mocked(spawn).mockClear();
  });

  function forceWin32(): () => void {
    const platform = vi.spyOn(process, 'platform', 'get').mockReturnValue('win32');
    return () => platform.mockRestore();
  }

  it('also raises a Windows toast when notifications.system is enabled', () => {
    const restore = forceWin32();
    try {
      const state = makeNotificationState({ system: true });

      notifyTerminalOnce(state, 'approval:req-1', { title: 'Approval required' });

      expect(state.terminal.write).toHaveBeenCalledTimes(1);
      expect(spawn).toHaveBeenCalledTimes(1);
    } finally {
      restore();
    }
  });

  it('keeps terminal notifications only when notifications.system is off', () => {
    const restore = forceWin32();
    try {
      const state = makeNotificationState();

      notifyTerminalOnce(state, 'approval:req-1', { title: 'Approval required' });

      expect(state.terminal.write).toHaveBeenCalledTimes(1);
      expect(spawn).not.toHaveBeenCalled();
    } finally {
      restore();
    }
  });

  it('respects the focus condition for the system toast too', () => {
    const restore = forceWin32();
    try {
      const state = makeNotificationState({ system: true, focused: true });

      notifyTerminalOnce(state, 'approval:req-1', { title: 'Approval required' });

      expect(spawn).not.toHaveBeenCalled();
    } finally {
      restore();
    }
  });
});
