import { NO_ACTIVE_SESSION_MESSAGE } from '../constant/kimi-tui';
import { formatErrorMessage } from '../utils/event-payload';
import type { SlashCommandHost } from './dispatch';

export async function handleUltracodeCommand(
  host: SlashCommandHost,
  args: string,
): Promise<void> {
  const prompt = args.trim();
  const mode = ultracodeSubcommand(prompt);
  if (mode !== undefined) {
    await applyUltracodeMode(host, mode);
    return;
  }
  if (prompt.length === 0) {
    await applyUltracodeMode(host, !host.state.appState.ultracode);
    return;
  }
  host.showError(`Unknown /ultracode subcommand: ${prompt}`);
}

async function applyUltracodeMode(host: SlashCommandHost, enabled: boolean): Promise<void> {
  if (host.session === undefined) {
    host.showError(NO_ACTIVE_SESSION_MESSAGE);
    return;
  }
  if (enabled && host.state.appState.ultracode) {
    host.showStatus('Ultracode mode is already on.');
    return;
  }
  if (!enabled && !host.state.appState.ultracode) {
    host.showStatus('Ultracode mode is already off.');
    return;
  }
  try {
    await host.requireSession().setUltracode(enabled, 'manual');
  } catch (error) {
    host.showError(
      `Failed to ${enabled ? 'enable' : 'disable'} ultracode mode: ${formatErrorMessage(error)}`,
    );
    return;
  }
  host.setAppState({ ultracode: enabled });
  host.showStatus(enabled ? 'Ultracode mode on (xhigh effort).' : 'Ultracode mode off.');
}

function ultracodeSubcommand(input: string): boolean | undefined {
  const command = input.toLowerCase();
  if (command === 'on') return true;
  if (command === 'off') return false;
  return undefined;
}
