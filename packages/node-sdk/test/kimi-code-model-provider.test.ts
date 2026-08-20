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
import { APIStatusError } from '@moonshot-ai/kosong';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  applyOpenAICodexConfig,
  ErrorCodes,
  KimiError,
  KimiForCodingProvider,
  OPENAI_HARNESS_MODELS,
  OpenAIResponsesModelProvider,
} from '#/index';

import { TEST_IDENTITY } from './test-identity';

function openAICodexJwt(accountId: string, nonce = 'token'): string {
  const encode = (value: Record<string, unknown>) =>
    Buffer.from(JSON.stringify(value)).toString('base64url');
  return `${encode({ alg: 'none' })}.${encode({
    'https://api.openai.com/auth': { chatgpt_account_id: accountId },
    nonce,
  })}.signature`;
}

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
  it('writes a persistent OpenAI Codex provider and built-in model aliases', () => {
    const config = {
      providers: {},
      models: {},
    };

    const result = applyOpenAICodexConfig(config, {
      accountId: 'account-test',
      selectedModel: 'gpt-5.6-terra',
      thinking: true,
      effort: 'high',
    });

    expect(result.defaultModel).toBe('openai-codex/gpt-5.6-terra');
    expect(config).toMatchObject({
      defaultModel: 'openai-codex/gpt-5.6-terra',
      thinking: { enabled: true, effort: 'high' },
      providers: {
        'openai-codex': {
          type: 'openai-codex',
          baseUrl: 'https://chatgpt.com/backend-api/codex',
          oauth: { storage: 'file', key: 'openai-codex' },
          customHeaders: {
            'chatgpt-account-id': 'account-test',
            'x-openai-internal-codex-responses-lite': 'true',
          },
        },
      },
      models: {
        'openai-codex/gpt-5.6-sol': { provider: 'openai-codex', model: 'gpt-5.6-sol' },
        'openai-codex/gpt-5.6-terra': { provider: 'openai-codex', model: 'gpt-5.6-terra' },
        'openai-codex/gpt-5.6-luna': { provider: 'openai-codex', model: 'gpt-5.6-luna' },
      },
    });
  });

  it('registers the GPT-5.6 family on the Responses API with configured limits', () => {
    const provider = new OpenAIResponsesModelProvider({
      apiKey: 'YOUR_API_KEY',
      promptCacheKey: 'session-1',
      nativeToolSearch: true,
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
        nativeToolSearch: true,
        generationKwargs: { prompt_cache_key: 'session-1' },
      },
      modelCapabilities: {
        image_in: true,
        thinking: true,
        tool_use: true,
        max_context_tokens: 272_000,
      },
      supportEfforts: ['off', 'low', 'medium', 'high', 'xhigh', 'max'],
      defaultEffort: 'medium',
      maxOutputSize: 128_000,
      type: 'openai_responses',
    });
  });

  it('routes ChatGPT subscription models through the Codex Responses endpoint', () => {
    const provider = new OpenAIResponsesModelProvider({
      authentication: 'chatgpt',
      promptCacheKey: 'session-1',
      clientVersion: '1.2.3',
      responsesWebSocket: true,
    });

    expect(provider.resolveProviderConfig('gpt-5.6-sol')).toMatchObject({
      providerName: 'openai-codex',
      provider: {
        type: 'openai_responses',
        model: 'gpt-5.6-sol',
        apiKey: undefined,
        baseUrl: 'https://chatgpt.com/backend-api/codex',
        defaultHeaders: {
          'OpenAI-Beta': 'responses=experimental',
          originator: 'kimi-code',
          version: '1.2.3',
          'User-Agent': 'kimi-code/1.2.3',
          conversation_id: 'session-1',
          session_id: 'session-1',
          'x-openai-internal-codex-responses-lite': 'true',
        },
        codex: { responsesLite: true },
        responsesWebSocket: true,
      },
      modelCapabilities: { max_context_tokens: 272_000 },
      supportEfforts: ['low', 'medium', 'high', 'xhigh', 'max'],
    });
  });

  it('scopes ChatGPT cache and thread identities per agent', () => {
    const provider = new OpenAIResponsesModelProvider({
      authentication: 'chatgpt',
      promptCacheKey: 'session-1',
    });

    const main = provider.forAgent('main').resolveProviderConfig('gpt-5.6-sol');
    const child = provider.forAgent('agent-3').resolveProviderConfig('gpt-5.6-sol');

    expect(main.provider).toMatchObject({
      generationKwargs: { prompt_cache_key: 'session-1' },
      defaultHeaders: {
        conversation_id: 'session-1',
        session_id: 'session-1:main',
      },
    });
    expect(child.provider).toMatchObject({
      generationKwargs: { prompt_cache_key: 'session-1:agent-3' },
      defaultHeaders: {
        conversation_id: 'session-1',
        session_id: 'session-1:agent-3',
      },
    });
  });

  it('binds ChatGPT requests to the account encoded in the access token', async () => {
    const token = openAICodexJwt('account-1');
    const getAccessToken = vi.fn(async () => token);
    const provider = new OpenAIResponsesModelProvider({
      authentication: 'chatgpt',
      tokenProvider: { getAccessToken },
    });
    const auth = provider.resolveAuth('gpt-5.6-sol');

    await expect(auth!((requestAuth) => Promise.resolve(requestAuth))).resolves.toEqual({
      apiKey: token,
      headers: { 'chatgpt-account-id': 'account-1' },
    });
    expect(getAccessToken).toHaveBeenCalledWith(undefined);
  });

  it('forces one token refresh after ChatGPT rejects a request', async () => {
    const staleToken = openAICodexJwt('account-1', 'stale');
    const freshToken = openAICodexJwt('account-1', 'fresh');
    const getAccessToken = vi
      .fn()
      .mockResolvedValueOnce(staleToken)
      .mockResolvedValueOnce(freshToken);
    const provider = new OpenAIResponsesModelProvider({
      authentication: 'chatgpt',
      tokenProvider: { getAccessToken },
    });
    const auth = provider.resolveAuth('gpt-5.6-sol');
    const request = vi
      .fn()
      .mockRejectedValueOnce(new APIStatusError(401, 'unauthorized'))
      .mockResolvedValueOnce('ok');

    await expect(auth!(request)).resolves.toBe('ok');
    expect(getAccessToken).toHaveBeenNthCalledWith(2, { force: true });
    expect(request).toHaveBeenNthCalledWith(2, {
      apiKey: freshToken,
      headers: { 'chatgpt-account-id': 'account-1' },
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
