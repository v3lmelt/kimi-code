import { describe, expect, it, vi } from 'vitest';

import { applyMotionChoice, applyUpdatePreferenceChoice } from '#/tui/commands/config';
import { setReducedMotionPreference } from '#/tui/utils/accessibility';
import { darkColors } from '#/tui/theme/colors';

const mocks = vi.hoisted(() => ({
  saveTuiConfig: vi.fn(),
}));

vi.mock('../../../src/tui/config', async () => {
  const actual = await vi.importActual<typeof import('../../../src/tui/config.js')>(
    '../../../src/tui/config.js',
  );
  return {
    ...actual,
    saveTuiConfig: mocks.saveTuiConfig,
  };
});

describe('update preference commands', () => {
  it('saves automatic update preference changes to tui.toml', async () => {
    const setAppState = vi.fn();
    const showStatus = vi.fn();
    const track = vi.fn();
    const host = {
      state: {
        appState: {
          theme: 'auto' as const,
          editorCommand: null,
          notifications: { enabled: true, condition: 'unfocused' as const },
          upgrade: { autoInstall: true },
        },
        theme: { palette: darkColors },
      },
      setAppState,
      showStatus,
      track,
    };

    await applyUpdatePreferenceChoice(host, false);

    expect(mocks.saveTuiConfig).toHaveBeenCalledWith({
      theme: 'auto',
      editorCommand: null,
      disablePasteBurst: false,
      cacheExpiryHint: true,
      hideThinking: false,
      reducedMotion: false,
      spinner: { verbs: [], verbMode: 'append' },
      notifications: { enabled: true, condition: 'unfocused' },
      upgrade: { autoInstall: false },
      statusLine: { items: null, command: null },
    });
    expect(setAppState).toHaveBeenCalledWith({ upgrade: { autoInstall: false } });
    expect(track).toHaveBeenCalledWith('upgrade_preference_changed', { auto_install: false });
    expect(showStatus).toHaveBeenCalledWith('Automatic updates disabled.');
  });

  it('persists reduced motion and applies it to the current TUI', async () => {
    const setAppState = vi.fn();
    const showStatus = vi.fn();
    const host = {
      state: {
        appState: {
          theme: 'auto' as const,
          editorCommand: null,
          notifications: { enabled: true, condition: 'unfocused' as const },
          upgrade: { autoInstall: true },
          reducedMotion: false,
        },
      },
      setAppState,
      showStatus,
    };

    try {
      await applyMotionChoice(host as never, true);

      expect(mocks.saveTuiConfig).toHaveBeenLastCalledWith(
        expect.objectContaining({ reducedMotion: true }),
      );
      expect(setAppState).toHaveBeenCalledWith({ reducedMotion: true });
      expect(showStatus).toHaveBeenCalledWith('Motion setting changed to reduced.');
    } finally {
      setReducedMotionPreference(false);
    }
  });
});
