import {
  applyOpenCodeGoConfig,
  applyOpenPlatformConfig,
  fetchOpenPlatformModels,
  filterModelsByPrefix,
  getOpenPlatformById,
  OPENCODE_GO_DEFAULT_BASE_URL,
  OPENCODE_GO_MODELS,
  OPENCODE_GO_PROVIDER_ID,
  OPENAI_CODEX_PROVIDER_NAME,
  OpenPlatformApiError,
  toManagedModelInfo,
  type ManagedKimiCodeModelInfo,
  type ManagedKimiConfigShape,
  type OpenPlatformDefinition,
} from '@moonshot-ai/kimi-code-oauth';
import {
  applyOpenAICodexConfig,
  log,
  OPENAI_HARNESS_MODELS,
} from '@moonshot-ai/kimi-code-sdk';

import type { ChoiceOption } from '../components/dialogs/choice-picker';
import { DEFAULT_OAUTH_PROVIDER_NAME } from '../constant/kimi-tui';
import { formatErrorMessage } from '../utils/event-payload';
import type { LoginProgressSpinnerHandle } from '../types';
import {
  promptApiKey,
  promptLogoutProviderSelection,
  promptModelSelectionForOpenPlatform,
  promptPlatformSelection,
} from './prompts';
import type { SlashCommandHost } from './dispatch';

// ---------------------------------------------------------------------------
// Auth: login / logout
// ---------------------------------------------------------------------------

export async function handleLoginCommand(host: SlashCommandHost): Promise<void> {
  const platformId = await promptPlatformSelection(host);
  if (platformId === undefined) return;

  if (platformId === 'kimi-code') {
    await handleKimiCodeOAuthLogin(host);
    return;
  }

  if (platformId === OPENCODE_GO_PROVIDER_ID) {
    await handleOpenCodeGoLogin(host);
    return;
  }

  if (platformId === OPENAI_CODEX_PROVIDER_NAME) {
    await handleOpenAICodexLogin(host);
    return;
  }

  const platform = getOpenPlatformById(platformId);
  if (platform === undefined) return;
  await handleOpenPlatformLogin(host, platform);
}

async function handleOpenAICodexLogin(host: SlashCommandHost): Promise<void> {
  const models: ManagedKimiCodeModelInfo[] = OPENAI_HARNESS_MODELS.map((model) => ({
    id: model.id,
    contextLength: Math.min(model.maxContextTokens, 1_000_000),
    supportsReasoning: true,
    supportsImageIn: true,
    supportsVideoIn: false,
    supportsToolUse: true,
    supportsThinkingType: 'both',
    supportEfforts: model.supportEfforts?.filter((effort) => effort !== 'off'),
    defaultEffort: model.defaultEffort,
    displayName: model.displayName,
  }));
  const platform: OpenPlatformDefinition = {
    id: OPENAI_CODEX_PROVIDER_NAME,
    name: 'OpenAI ChatGPT',
    baseUrl: 'https://chatgpt.com/backend-api/codex',
  };
  const selection = await promptModelSelectionForOpenPlatform(host, models, platform);
  if (selection === undefined) return;

  const previous = await host.harness.auth.getOpenAIStatus();
  const alreadyLoggedIn = previous.authenticated && previous.accountId !== undefined;
  let accountId = previous.accountId;
  let spinner: LoginProgressSpinnerHandle | undefined;
  const controller = new AbortController();
  const cancelLogin = (): void => controller.abort();
  host.cancelInFlight = cancelLogin;

  try {
    if (!alreadyLoggedIn) {
      const result = await host.harness.auth.loginOpenAI({
        signal: controller.signal,
        onAuthorization: (info) => {
          spinner = host.showLoginAuthorizationPrompt({
            userCode: info.userCode ?? '',
            deviceCode: '',
            verificationUri: info.url,
            verificationUriComplete: info.url,
            expiresIn: null,
            interval: 5,
          });
        },
      });
      accountId = result.accountId;
      spinner?.stop({ ok: true, label: 'Logged in.' });
      spinner = undefined;
    }
    if (accountId === undefined) {
      throw new Error('ChatGPT OAuth token does not contain an account id.');
    }

    const config = await host.harness.getConfig();
    applyOpenAICodexConfig(config, {
      accountId,
      selectedModel: selection.model.id,
      thinking: selection.thinking !== 'off',
      effort:
        selection.thinking !== 'off' && selection.thinking !== 'on'
          ? selection.thinking
          : undefined,
    });
    await host.harness.setConfig({
      providers: config.providers,
      models: config.models,
      defaultModel: config.defaultModel,
      thinking: config.thinking,
    });
    await host.authFlow.refreshConfigAfterLogin();
    host.track('login', {
      provider: OPENAI_CODEX_PROVIDER_NAME,
      method: 'oauth',
      already_logged_in: alreadyLoggedIn,
    });
    host.showStatus(`Setup complete: OpenAI ChatGPT · ${selection.model.id}`);
  } catch (error) {
    const cancelled = controller.signal.aborted;
    spinner?.stop({ ok: false, label: cancelled ? 'Login cancelled.' : 'Login failed.' });
    spinner = undefined;
    if (cancelled) return;
    log.warn('login failed', {
      providerName: OPENAI_CODEX_PROVIDER_NAME,
      alreadyLoggedIn,
      sessionId: host.session?.id,
      error,
    });
    host.showError(`Login failed: ${formatErrorMessage(error)}`);
  } finally {
    if (host.cancelInFlight === cancelLogin) host.cancelInFlight = undefined;
  }
}

async function handleKimiCodeOAuthLogin(host: SlashCommandHost): Promise<void> {
  const status = await host.harness.auth.status(DEFAULT_OAUTH_PROVIDER_NAME);
  const alreadyLoggedIn = status.providers.some(
    (provider) => provider.providerName === DEFAULT_OAUTH_PROVIDER_NAME && provider.hasToken,
  );

  let spinner: LoginProgressSpinnerHandle | undefined;
  const controller = new AbortController();
  const cancelLogin = (): void => {
    controller.abort();
  };
  host.cancelInFlight = cancelLogin;
  try {
    await host.harness.auth.login(DEFAULT_OAUTH_PROVIDER_NAME, {
      signal: controller.signal,
      onDeviceCode: (data) => {
        spinner = host.showLoginAuthorizationPrompt(data);
      },
    });
    spinner?.stop({ ok: true, label: 'Logged in.' });
    spinner = undefined;
    try {
      await host.authFlow.refreshConfigAfterLogin();
    } catch (refreshError) {
      const message = formatErrorMessage(refreshError);
      host.showError(`Authentication successful, but failed to refresh config: ${message}`);
      return;
    }
    host.track('login', {
      provider: DEFAULT_OAUTH_PROVIDER_NAME,
      method: 'oauth',
      already_logged_in: alreadyLoggedIn,
    });
    if (alreadyLoggedIn) {
      host.showStatus('Already logged in. Model configuration refreshed.', 'success');
    }
  } catch (error) {
    const cancelled = controller.signal.aborted;
    spinner?.stop({
      ok: false,
      label: cancelled ? 'Login cancelled.' : 'Login failed.',
    });
    spinner = undefined;
    if (cancelled) return;
    log.warn('login failed', {
      providerName: DEFAULT_OAUTH_PROVIDER_NAME,
      alreadyLoggedIn,
      sessionId: host.session?.id,
      error,
    });
    const message = formatErrorMessage(error);
    host.showError(`Login failed: ${message}`);
  } finally {
    if (host.cancelInFlight === cancelLogin) {
      host.cancelInFlight = undefined;
    }
  }
}

async function handleOpenPlatformLogin(
  host: SlashCommandHost,
  platform: OpenPlatformDefinition,
): Promise<void> {
  const consoleHost = platform.consoleUrl?.replace(/^https?:\/\//, '') ?? '';
  const platformName = consoleHost.length > 0 ? `Kimi Platform (${consoleHost})` : 'Kimi Platform';
  const subtitleLines = [
    `${'base_url'.padEnd(12)}${platform.baseUrl}`,
    `${'saved to'.padEnd(12)}~/.kimi-code/config.toml`,
  ];
  const apiKey = await promptApiKey(host, platformName, subtitleLines);
  if (apiKey === undefined) return;

  const controller = new AbortController();
  const cancelLogin = (): void => {
    controller.abort();
  };
  host.cancelInFlight = cancelLogin;

  let models: ManagedKimiCodeModelInfo[];
  try {
    models = await fetchOpenPlatformModels(platform, apiKey, fetch, controller.signal);
    models = filterModelsByPrefix(models, platform);
  } catch (error) {
    if (controller.signal.aborted) return;
    const msg = formatErrorMessage(error);
    host.showError(`Failed to verify API key: ${msg}`);
    if (
      error instanceof OpenPlatformApiError &&
      error.status === 401
    ) {
      host.showStatus(
        'Hint: If your API key was obtained from Kimi Code, please select "Kimi Code" instead.',
      );
    }
    return;
  } finally {
    if (host.cancelInFlight === cancelLogin) {
      host.cancelInFlight = undefined;
    }
  }

  if (models.length === 0) {
    host.showError('No models available for this platform.');
    return;
  }

  const selection = await promptModelSelectionForOpenPlatform(host, models, platform);
  if (selection === undefined) return;

  const existingConfig = await host.harness.getConfig();
  if (existingConfig.providers[platform.id] !== undefined) {
    await host.harness.removeProvider(platform.id);
  }

  const config = await host.harness.getConfig();
  applyOpenPlatformConfig(config as ManagedKimiConfigShape, {
    platform,
    models,
    selectedModel: selection.model,
    thinking: selection.thinking !== 'off',
    effort:
      selection.thinking !== 'off' && selection.thinking !== 'on'
        ? selection.thinking
        : undefined,
    apiKey,
  });

  await host.harness.setConfig({
    providers: config.providers,
    models: config.models,
    defaultModel: config.defaultModel,
    thinking: config.thinking,
  });

  await host.authFlow.refreshConfigAfterLogin();
  host.track('login', { provider: platform.id, method: 'api_key' });
  host.showStatus(`Setup complete: ${platform.name} · ${selection.model.id}`);
}

async function handleOpenCodeGoLogin(host: SlashCommandHost): Promise<void> {
  const platformName = 'OpenCode Go';
  const subtitleLines = [
    `${'base_url'.padEnd(12)}${OPENCODE_GO_DEFAULT_BASE_URL}`,
    `${'saved to'.padEnd(12)}~/.kimi-code/config.toml`,
  ];
  const apiKey = await promptApiKey(host, platformName, subtitleLines);
  if (apiKey === undefined) return;

  // OpenCode Go models come from the built-in static table (no /models fetch);
  // reuse the existing model-selection UI via the ManagedKimiCodeModelInfo shape.
  const models = OPENCODE_GO_MODELS.map((model) => toManagedModelInfo(model));
  const platform: OpenPlatformDefinition = {
    id: OPENCODE_GO_PROVIDER_ID,
    name: platformName,
    baseUrl: OPENCODE_GO_DEFAULT_BASE_URL,
  };
  const selection = await promptModelSelectionForOpenPlatform(host, models, platform);
  if (selection === undefined) return;

  const existingConfig = await host.harness.getConfig();
  if (existingConfig.providers[OPENCODE_GO_PROVIDER_ID] !== undefined) {
    await host.harness.removeProvider(OPENCODE_GO_PROVIDER_ID);
  }

  const config = await host.harness.getConfig();
  applyOpenCodeGoConfig(config as ManagedKimiConfigShape, {
    apiKey,
    selectedModel: OPENCODE_GO_MODELS.find((m) => m.id === selection.model.id),
    thinking: selection.thinking !== 'off',
    effort:
      selection.thinking !== 'off' && selection.thinking !== 'on'
        ? selection.thinking
        : undefined,
  });

  await host.harness.setConfig({
    providers: config.providers,
    models: config.models,
    defaultModel: config.defaultModel,
    thinking: config.thinking,
  });

  await host.authFlow.refreshConfigAfterLogin();
  host.track('login', { provider: OPENCODE_GO_PROVIDER_ID, method: 'api_key' });
  host.showStatus(`Setup complete: OpenCode Go · ${selection.model.id}`);
}

export async function handleLogoutCommand(host: SlashCommandHost): Promise<void> {
  const oauthStatus = await host.harness.auth.status(DEFAULT_OAUTH_PROVIDER_NAME);
  const openAIStatus = await host.harness.auth.getOpenAIStatus();
  const hasOAuthToken = oauthStatus.providers.some(
    (p) => p.providerName === DEFAULT_OAUTH_PROVIDER_NAME && p.hasToken,
  );
  const config = await host.harness.getConfig();
  const hasManagedRemnant =
    hasOAuthToken || config.providers[DEFAULT_OAUTH_PROVIDER_NAME] !== undefined;
  const apiKeyProviderIds = Object.keys(config.providers ?? {})
    .filter(
      (id) => id !== DEFAULT_OAUTH_PROVIDER_NAME && id !== OPENAI_CODEX_PROVIDER_NAME,
    )
    .toSorted();

  const options: ChoiceOption[] = [];
  if (hasManagedRemnant) {
    options.push({
      value: DEFAULT_OAUTH_PROVIDER_NAME,
      label: 'Kimi Code',
      description: 'OAuth login',
    });
  }
  if (
    openAIStatus.authenticated ||
    config.providers[OPENAI_CODEX_PROVIDER_NAME] !== undefined
  ) {
    options.push({
      value: OPENAI_CODEX_PROVIDER_NAME,
      label: 'OpenAI ChatGPT',
      description: 'OAuth login',
    });
  }
  for (const id of apiKeyProviderIds) {
    const baseUrl = config.providers[id]?.baseUrl;
    options.push({
      value: id,
      label: id,
      description: typeof baseUrl === 'string' && baseUrl.length > 0 ? baseUrl : undefined,
    });
  }

  if (options.length === 0) {
    host.showStatus('Nothing to logout.');
    return;
  }

  const currentModel = host.state.appState.model.trim();
  const currentProvider = host.state.appState.availableModels[currentModel]?.provider;

  const target = await promptLogoutProviderSelection(host, options, currentProvider);
  if (target === undefined) return;

  if (target === DEFAULT_OAUTH_PROVIDER_NAME) {
    await host.harness.auth.logout(DEFAULT_OAUTH_PROVIDER_NAME);
  } else if (target === OPENAI_CODEX_PROVIDER_NAME) {
    await host.harness.auth.logoutOpenAI();
    if (config.providers[OPENAI_CODEX_PROVIDER_NAME] !== undefined) {
      await host.harness.removeProvider(OPENAI_CODEX_PROVIDER_NAME);
    }
  } else {
    await host.harness.removeProvider(target);
  }

  if (target === currentProvider) {
    await host.authFlow.refreshConfigAfterLogout();
    await host.authFlow.clearActiveSessionAfterLogout();
  } else {
    const updated = await host.harness.getConfig({ reload: true });
    host.setAppState({
      availableModels: updated.models ?? {},
      availableProviders: updated.providers ?? {},
    });
  }

  host.track('logout', { provider: target });
  const label =
    target === DEFAULT_OAUTH_PROVIDER_NAME
      ? 'Kimi Code'
      : target === OPENAI_CODEX_PROVIDER_NAME
        ? 'OpenAI ChatGPT'
        : target;
  host.showStatus(`Logged out from ${label}.`);
}
