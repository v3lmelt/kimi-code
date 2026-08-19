import { createKimiDeviceId, KIMI_CODE_PROVIDER_NAME } from '@moonshot-ai/kimi-code-oauth';
import {
  loadRuntimeConfigSafe,
  resolveKimiHome,
  type KimiConfig,
} from '@moonshot-ai/kimi-code-sdk';

import type { PromptHarness } from './prompt-session';
import { initializeTelemetry, track } from '@moonshot-ai/kimi-telemetry';

import { CLI_USER_AGENT_PRODUCT } from '#/constant/app';

import { createKimiCodeHostIdentity } from './version';

export interface CliTelemetryBootstrap {
  readonly homeDir: string;
  readonly deviceId: string;
  readonly firstLaunch: boolean;
}

export interface InitializeCliTelemetryOptions {
  readonly harness: PromptHarness;
  readonly bootstrap: CliTelemetryBootstrap;
  readonly config: Pick<KimiConfig, 'defaultModel' | 'telemetry'>;
  readonly version: string;
  readonly uiMode: string;
  readonly model?: string;
  readonly sessionId?: string;
}

export function createCliTelemetryBootstrap(): CliTelemetryBootstrap {
  let firstLaunch = false;
  const homeDir = resolveKimiHome();
  const deviceId = createKimiDeviceId(homeDir, {
    onFirstLaunch: () => {
      firstLaunch = true;
    },
  });
  return { homeDir, deviceId, firstLaunch };
}

export function initializeCliTelemetry(options: InitializeCliTelemetryOptions): void {
  initializeTelemetry({
    homeDir: options.harness.homeDir,
    deviceId: options.bootstrap.deviceId,
    enabled: options.config.telemetry !== false,
    appName: CLI_USER_AGENT_PRODUCT,
    version: options.version,
    uiMode: options.uiMode,
    model: options.model ?? options.config.defaultModel,
    sessionId: options.sessionId,
    getAccessToken: async () =>
      (await options.harness.auth.getCachedAccessToken(KIMI_CODE_PROVIDER_NAME)) ?? null,
  });
  if (options.bootstrap.firstLaunch) {
    options.harness.track('first_launch');
  }
}
