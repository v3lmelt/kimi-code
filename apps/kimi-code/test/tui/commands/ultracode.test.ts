import { describe, expect, it, vi } from 'vitest';

import { handleUltracodeCommand } from '#/tui/commands/index';
import type { SlashCommandHost } from '#/tui/commands/dispatch';

function makeHost(
  overrides: {
    hasSession?: boolean;
    ultracode?: boolean;
  } = {},
) {
  const session = {
    setUltracode: vi.fn(async () => {}),
  };
  const hasSession = overrides.hasSession ?? true;
  const host = {
    state: {
      appState: {
        model: 'kimi-model',
        ultracode: overrides.ultracode ?? false,
      },
    },
    session: hasSession ? session : undefined,
    requireSession: () => session,
    setAppState: vi.fn((patch: Record<string, unknown>) =>
      Object.assign(host.state.appState, patch),
    ),
    showError: vi.fn(),
    showStatus: vi.fn(),
  } as unknown as SlashCommandHost;
  return { host, session };
}

describe('handleUltracodeCommand', () => {
  it('turns ultracode mode on via the "on" subcommand', async () => {
    const { host, session } = makeHost();

    await handleUltracodeCommand(host, 'on');

    expect(session.setUltracode).toHaveBeenCalledWith(true, 'manual');
    expect(host.setAppState).toHaveBeenCalledWith({ ultracode: true });
    expect(host.showStatus).toHaveBeenCalledWith('Ultracode mode on (xhigh effort).');
    expect(host.showError).not.toHaveBeenCalled();
  });

  it('turns ultracode mode on when called without args while off', async () => {
    const { host, session } = makeHost({ ultracode: false });

    await handleUltracodeCommand(host, '');

    expect(session.setUltracode).toHaveBeenCalledWith(true, 'manual');
    expect(host.setAppState).toHaveBeenCalledWith({ ultracode: true });
  });

  it('turns ultracode mode off via the "off" subcommand', async () => {
    const { host, session } = makeHost({ ultracode: true });

    await handleUltracodeCommand(host, 'off');

    expect(session.setUltracode).toHaveBeenCalledWith(false, 'manual');
    expect(host.setAppState).toHaveBeenCalledWith({ ultracode: false });
    expect(host.showStatus).toHaveBeenCalledWith('Ultracode mode off.');
  });

  it('turns ultracode mode off when called without args while on', async () => {
    const { host, session } = makeHost({ ultracode: true });

    await handleUltracodeCommand(host, '');

    expect(session.setUltracode).toHaveBeenCalledWith(false, 'manual');
    expect(host.setAppState).toHaveBeenCalledWith({ ultracode: false });
  });

  it('is idempotent when already on', async () => {
    const { host, session } = makeHost({ ultracode: true });

    await handleUltracodeCommand(host, 'on');

    expect(session.setUltracode).not.toHaveBeenCalled();
    expect(host.showStatus).toHaveBeenCalledWith('Ultracode mode is already on.');
    expect(host.setAppState).not.toHaveBeenCalledWith({ ultracode: true });
  });

  it('is idempotent when already off', async () => {
    const { host, session } = makeHost({ ultracode: false });

    await handleUltracodeCommand(host, 'off');

    expect(session.setUltracode).not.toHaveBeenCalled();
    expect(host.showStatus).toHaveBeenCalledWith('Ultracode mode is already off.');
  });

  it('reports an unknown subcommand', async () => {
    const { host, session } = makeHost();

    await handleUltracodeCommand(host, 'banana');

    expect(session.setUltracode).not.toHaveBeenCalled();
    expect(host.showError).toHaveBeenCalledWith('Unknown /ultracode subcommand: banana');
  });

  it('requires an active session', async () => {
    const { host, session } = makeHost({ hasSession: false });

    await handleUltracodeCommand(host, 'on');

    expect(session.setUltracode).not.toHaveBeenCalled();
    expect(host.showError).toHaveBeenCalled();
  });

  it('shows an error when the session call fails', async () => {
    const { host, session } = makeHost({ ultracode: false });
    session.setUltracode.mockRejectedValueOnce(new Error('denied'));

    await handleUltracodeCommand(host, 'on');

    expect(host.showError).toHaveBeenCalledWith(
      expect.stringContaining('Failed to enable ultracode mode'),
    );
    expect(host.setAppState).not.toHaveBeenCalledWith({ ultracode: true });
  });
});
