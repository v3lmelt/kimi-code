import { execFile } from 'node:child_process';

import { resolveCommandPath } from './process/resolve-command';

export interface OpenUrlCommand {
  readonly command: string;
  readonly args: readonly string[];
}

export function openUrlCommand(
  url: string,
  platform: NodeJS.Platform = process.platform,
): OpenUrlCommand {
  if (platform === 'darwin') return { command: 'open', args: [url] };
  if (platform === 'win32') {
    return {
      command: 'rundll32.exe',
      args: ['url.dll,FileProtocolHandler', url],
    };
  }
  return { command: 'xdg-open', args: [url] };
}

export function openUrl(url: string): void {
  const launch = openUrlCommand(url);
  const command = resolveCommandPath(launch.command);
  if (command === undefined) return;
  execFile(command, launch.args, () => {});
}
