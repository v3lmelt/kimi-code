import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  KimiOAuthToolkit,
  OAuthConnectionError,
  OAuthError,
  OAuthUnauthorizedError,
  RetryableRefreshError,
} from '@moonshot-ai/kimi-code-oauth';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  ErrorCodes,
  KimiError,
  KimiForCodingProvider,
  OPENAI_HARNESS_MODELS,
  OpenAIResponsesModelProvider,
} from '#/index';

import { TEST_IDENTITY } from './test-identity';

describe('KimiForCodingProvider OAuth error mapping', () => {
  let homeDir: string;

  beforeEach(async () => {
    homeDir = await mkdtemp(join(tmpdir(), 'kimi-for-coding-provider-'));
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await rm(homeDir, { recursive: true, force: true });
  });

  function resolveAuth() {
    const provider = new KimiForCodingProvider({ homeDir, ...TEST_IDENTITY });
    return provider.resolveAuth('kimi-for-coding');
  }

  it('maps unauthorized token failures to auth.login_required', async () => {
    vi.spyOn(KimiOAuthToolkit.prototype, 'ensureFresh').mockRejectedValue(
      new OAuthUnauthorizedError('No token for "kimi-code". Run /login to authenticate.'),
    );

    const auth = resolveAuth();
    await expect(auth(async () => 'ok')).rejects.toMatchObject({
      code: ErrorCodes.AUTH_LOGIN_REQUIRED,
    });
  });

  it('maps transient token failures to provider.connection_error', async () => {
    const tokenErrors = [
      new OAuthConnectionError('OAuth request to https://example.test failed: fetch failed'),
      new RetryableRefreshError('Token refresh failed (HTTP 503).'),
    ];

    for (const tokenError of tokenErrors) {
      vi.spyOn(KimiOAuthToolkit.prototype, 'ensureFresh').mockRejectedValue(tokenError);

      const auth = resolveAuth();
      const caught = await auth(async () => 'ok').catch((error: unknown) => error);

      expect(caught).toBeInstanceOf(KimiError);
      expect(caught).toMatchObject({
        code: ErrorCodes.PROVIDER_CONNECTION_ERROR,
        message: expect.stringContaining(tokenError.message),
        cause: tokenError,
      });

      vi.restoreAllMocks();
    }
  });

  it('rethrows unrecognized OAuth errors raw instead of guessing a category', async () => {
    const oauthError = new OAuthError('Token refresh failed (HTTP 400).');
    vi.spyOn(KimiOAuthToolkit.prototype, 'ensureFresh').mockRejectedValue(oauthError);

    const auth = resolveAuth();
    await expect(auth(async () => 'ok')).rejects.toBe(oauthError);
  });
});

describe('OpenAIResponsesModelProvider', () => {
  it('registers the GPT-5.6 family on the Responses API with official limits', () => {
    const provider = new OpenAIResponsesModelProvider({
      apiKey: 'YOUR_API_KEY',
      promptCacheKey: 'session-1',
    });

    expect(OPENAI_HARNESS_MODELS.map((model) => model.id)).toEqual([
      'gpt-5.6-sol',
      'gpt-5.6-terra',
      'gpt-5.6-luna',
    ]);
    expect(provider.defaultModel).toBe('gpt-5.6-sol');
    expect(provider.resolveProviderConfig('gpt-5.6-terra')).toMatchObject({
      providerName: 'openai',
      provider: {
        type: 'openai_responses',
        model: 'gpt-5.6-terra',
        apiKey: 'YOUR_API_KEY',
        maxOutputTokens: 128_000,
        offEffort: 'none',
        generationKwargs: { prompt_cache_key: 'session-1' },
      },
      modelCapabilities: {
        image_in: true,
        thinking: true,
        tool_use: true,
        max_context_tokens: 1_050_000,
      },
      supportEfforts: ['off', 'low', 'medium', 'high', 'xhigh', 'max'],
      defaultEffort: 'medium',
      maxOutputSize: 128_000,
      type: 'openai_responses',
    });
  });

  it('uses the first custom model as the default when no default is supplied', () => {
    const provider = new OpenAIResponsesModelProvider({
      models: [{ id: 'gpt-example', maxContextTokens: 32_000, maxOutputTokens: 4_000 }],
    });

    expect(provider.defaultModel).toBe('gpt-example');
  });

  it('rejects an unregistered default model before a session starts', () => {
    expect(
      () => new OpenAIResponsesModelProvider({ defaultModel: 'gpt-not-registered' }),
    ).toThrow(/not registered/);
  });
});
