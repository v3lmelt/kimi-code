/**
 * ChatGPT authentication for the OpenAI Codex backend.
 *
 * The browser flow uses OAuth authorization code + PKCE with the fixed
 * localhost callback registered by the Codex client. A device flow is also
 * available for headless environments. Both flows return the shared TokenInfo
 * shape so the existing storage and refresh coordinator can own persistence.
 */

import { createHash, randomBytes } from 'node:crypto';
import { createServer, type Server } from 'node:http';

import {
  DeviceCodeTimeoutError,
  OAuthConnectionError,
  OAuthError,
  OAuthUnauthorizedError,
  RetryableRefreshError,
} from './errors';
import type { OAuthFlowConfig, TokenInfo } from './types';
import { isRecord } from './utils';

export const OPENAI_CODEX_PROVIDER_NAME = 'openai-codex';
export const OPENAI_CODEX_BASE_URL = 'https://chatgpt.com/backend-api';

const OPENAI_CODEX_CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann';
const OPENAI_CODEX_AUTHORIZE_URL = 'https://auth.openai.com/oauth/authorize';
const OPENAI_CODEX_TOKEN_URL = 'https://auth.openai.com/oauth/token';
const OPENAI_CODEX_DEVICE_USER_CODE_URL =
  'https://auth.openai.com/api/accounts/deviceauth/usercode';
const OPENAI_CODEX_DEVICE_TOKEN_URL = 'https://auth.openai.com/api/accounts/deviceauth/token';
const OPENAI_CODEX_DEVICE_AUTH_URL = 'https://auth.openai.com/codex/device';
const OPENAI_CODEX_DEVICE_REDIRECT_URI = 'https://auth.openai.com/deviceauth/callback';
const OPENAI_CODEX_CALLBACK_PORT = 1455;
const OPENAI_CODEX_CALLBACK_PATH = '/auth/callback';
const OPENAI_CODEX_REDIRECT_URI =
  `http://localhost:${OPENAI_CODEX_CALLBACK_PORT}${OPENAI_CODEX_CALLBACK_PATH}`;
const OPENAI_CODEX_SCOPE =
  'openid profile email offline_access api.connectors.read api.connectors.invoke';
const OPENAI_CODEX_AUTH_CLAIM = 'https://api.openai.com/auth';
const TOKEN_TIMEOUT_MS = 15_000;
const LOGIN_TIMEOUT_MS = 10 * 60 * 1000;
const DEVICE_MAX_POLLS = 120;
const DEVICE_INITIAL_POLL_MS = 5_000;
const DEVICE_POLL_SAFETY_MARGIN_MS = 3_000;

export const OPENAI_CODEX_FLOW_CONFIG: OAuthFlowConfig = {
  name: OPENAI_CODEX_PROVIDER_NAME,
  oauthHost: 'https://auth.openai.com',
  clientId: OPENAI_CODEX_CLIENT_ID,
};

type Fetch = typeof fetch;
type Sleep = (ms: number) => Promise<void>;

export interface OpenAICodexAuthorizationInfo {
  readonly url: string;
  readonly instructions: string;
  readonly userCode?: string;
}

export interface OpenAICodexBrowserLoginOptions {
  readonly onAuthorization: (
    info: OpenAICodexAuthorizationInfo,
  ) => void | PromiseLike<void>;
  readonly signal?: AbortSignal;
  readonly fetch?: Fetch;
  readonly originator?: string;
  readonly timeoutMs?: number;
}

export interface OpenAICodexDeviceLoginOptions {
  readonly onAuthorization: (
    info: OpenAICodexAuthorizationInfo,
  ) => void | PromiseLike<void>;
  readonly onProgress?: (message: string) => void;
  readonly signal?: AbortSignal;
  readonly fetch?: Fetch;
  readonly sleep?: Sleep;
  readonly maxPolls?: number;
}

export interface OpenAICodexRefreshOptions {
  readonly fetch?: Fetch;
}

export function createOpenAICodexAuthorizationUrl(input: {
  readonly state: string;
  readonly challenge: string;
  readonly originator?: string;
}): string {
  const query = new URLSearchParams({
    response_type: 'code',
    client_id: OPENAI_CODEX_CLIENT_ID,
    redirect_uri: OPENAI_CODEX_REDIRECT_URI,
    scope: OPENAI_CODEX_SCOPE,
    code_challenge: input.challenge,
    code_challenge_method: 'S256',
    state: input.state,
    id_token_add_organizations: 'true',
    codex_cli_simplified_flow: 'true',
    originator: normalizeOptionalString(input.originator) ?? 'kimi-code',
  });
  return `${OPENAI_CODEX_AUTHORIZE_URL}?${query.toString()}`;
}

export function getOpenAICodexAccountId(accessToken: string): string | undefined {
  const payload = decodeJwt(accessToken);
  const auth = payload?.[OPENAI_CODEX_AUTH_CLAIM];
  if (!isRecord(auth)) return undefined;
  return normalizeOptionalString(
    typeof auth['chatgpt_account_id'] === 'string' ? auth['chatgpt_account_id'] : undefined,
  );
}

export async function loginOpenAICodex(
  options: OpenAICodexBrowserLoginOptions,
): Promise<TokenInfo> {
  const verifier = randomBytes(32).toString('base64url');
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  const state = randomBytes(24).toString('base64url');
  const callback = await startCallbackServer(state, options.signal, options.timeoutMs);

  try {
    await options.onAuthorization({
      url: createOpenAICodexAuthorizationUrl({
        state,
        challenge,
        originator: options.originator,
      }),
      instructions: 'Complete the ChatGPT sign-in in your browser.',
    });
    const code = await callback.code;
    return await exchangeOpenAICodexAuthorizationCode(code, verifier, {
      fetch: options.fetch,
      redirectUri: OPENAI_CODEX_REDIRECT_URI,
    });
  } finally {
    await closeServer(callback.server);
  }
}

export async function loginOpenAICodexDevice(
  options: OpenAICodexDeviceLoginOptions,
): Promise<TokenInfo> {
  const request = options.fetch ?? fetch;
  options.onProgress?.('Starting ChatGPT device authorization.');
  const initialized = await fetchJson(
    request,
    OPENAI_CODEX_DEVICE_USER_CODE_URL,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ client_id: OPENAI_CODEX_CLIENT_ID }),
      signal: combineSignals(options.signal, TOKEN_TIMEOUT_MS),
    },
    'Device authorization request',
  );
  const deviceAuthId = requireString(initialized, 'device_auth_id');
  const userCode = requireString(initialized, 'user_code');
  const intervalSeconds = parsePositiveNumber(initialized['interval']) ?? 5;
  const pollIntervalMs = intervalSeconds * 1000 + DEVICE_POLL_SAFETY_MARGIN_MS;
  const sleep = options.sleep ?? defaultSleep;

  await options.onAuthorization({
    url: OPENAI_CODEX_DEVICE_AUTH_URL,
    instructions: `Enter code: ${userCode}`,
    userCode,
  });
  options.onProgress?.('Waiting for ChatGPT authorization.');

  for (let attempt = 0; attempt < (options.maxPolls ?? DEVICE_MAX_POLLS); attempt += 1) {
    throwIfAborted(options.signal);
    await sleep(attempt === 0 ? Math.min(pollIntervalMs, DEVICE_INITIAL_POLL_MS) : pollIntervalMs);
    throwIfAborted(options.signal);

    let response: Response;
    try {
      response = await request(OPENAI_CODEX_DEVICE_TOKEN_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ device_auth_id: deviceAuthId, user_code: userCode }),
        signal: combineSignals(options.signal, TOKEN_TIMEOUT_MS),
      });
    } catch (error) {
      throw connectionError('Device token polling failed', error);
    }

    if (response.status === 403 || response.status === 404) continue;
    if (!response.ok) {
      throw await responseError('Device token polling failed', response);
    }

    const body = await parseJsonObject(response, 'Device token response');
    const authorizationCode = requireString(body, 'authorization_code');
    const codeVerifier = requireString(body, 'code_verifier');
    options.onProgress?.('Exchanging the ChatGPT authorization code.');
    return exchangeOpenAICodexAuthorizationCode(authorizationCode, codeVerifier, {
      fetch: request,
      redirectUri: OPENAI_CODEX_DEVICE_REDIRECT_URI,
    });
  }

  throw new DeviceCodeTimeoutError('ChatGPT device authorization timed out.');
}

export async function exchangeOpenAICodexAuthorizationCode(
  code: string,
  verifier: string,
  options: { readonly fetch?: Fetch; readonly redirectUri?: string } = {},
): Promise<TokenInfo> {
  return requestOpenAICodexToken(
    {
      grant_type: 'authorization_code',
      client_id: OPENAI_CODEX_CLIENT_ID,
      code,
      code_verifier: verifier,
      redirect_uri: options.redirectUri ?? OPENAI_CODEX_REDIRECT_URI,
    },
    options.fetch,
    'ChatGPT token exchange',
  );
}

export async function refreshOpenAICodexToken(
  refreshToken: string,
  options: OpenAICodexRefreshOptions = {},
): Promise<TokenInfo> {
  return requestOpenAICodexToken(
    {
      grant_type: 'refresh_token',
      client_id: OPENAI_CODEX_CLIENT_ID,
      refresh_token: refreshToken,
    },
    options.fetch,
    'ChatGPT token refresh',
    refreshToken,
  );
}

async function requestOpenAICodexToken(
  form: Record<string, string>,
  fetchImpl: Fetch | undefined,
  context: string,
  previousRefreshToken?: string,
): Promise<TokenInfo> {
  const request = fetchImpl ?? fetch;
  let response: Response;
  try {
    response = await request(OPENAI_CODEX_TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(form),
      signal: AbortSignal.timeout(TOKEN_TIMEOUT_MS),
    });
  } catch (error) {
    throw connectionError(`${context} failed`, error);
  }

  if (!response.ok) {
    const error = await responseError(`${context} failed`, response);
    if (
      response.status === 401 ||
      response.status === 403 ||
      /\binvalid_grant\b/i.test(error.message)
    ) {
      throw new OAuthUnauthorizedError(error.message);
    }
    if (response.status === 429 || response.status >= 500) {
      throw new RetryableRefreshError(error.message);
    }
    throw error;
  }

  const body = await parseJsonObject(response, `${context} response`);
  const accessToken = requireString(body, 'access_token');
  const refreshToken = normalizeOptionalString(
    typeof body['refresh_token'] === 'string' ? body['refresh_token'] : undefined,
  ) ?? previousRefreshToken;
  if (refreshToken === undefined) {
    throw new OAuthError(`${context} response is missing refresh_token.`);
  }
  const expiresIn = parsePositiveNumber(body['expires_in']);
  if (expiresIn === undefined) {
    throw new OAuthError(`${context} response is missing expires_in.`);
  }
  if (getOpenAICodexAccountId(accessToken) === undefined) {
    throw new OAuthError(`${context} response does not contain a ChatGPT account id.`);
  }

  return {
    accessToken,
    refreshToken,
    expiresAt: Math.floor(Date.now() / 1000) + expiresIn,
    expiresIn,
    scope: typeof body['scope'] === 'string' ? body['scope'] : OPENAI_CODEX_SCOPE,
    tokenType: typeof body['token_type'] === 'string' ? body['token_type'] : 'Bearer',
  };
}

async function startCallbackServer(
  expectedState: string,
  signal?: AbortSignal,
  timeoutMs = LOGIN_TIMEOUT_MS,
): Promise<{ readonly server: Server; readonly code: Promise<string> }> {
  let resolveCode: (code: string) => void;
  let rejectCode: (error: Error) => void;
  const code = new Promise<string>((resolve, reject) => {
    resolveCode = resolve;
    rejectCode = reject;
  });

  const server = createServer((request, response) => {
    const url = new URL(request.url ?? '/', OPENAI_CODEX_REDIRECT_URI);
    if (request.method !== 'GET' || url.pathname !== OPENAI_CODEX_CALLBACK_PATH) {
      response.writeHead(404).end('Not found');
      return;
    }
    const error = normalizeOptionalString(url.searchParams.get('error') ?? undefined);
    const state = url.searchParams.get('state');
    const authorizationCode = normalizeOptionalString(url.searchParams.get('code') ?? undefined);
    if (error !== undefined) {
      response.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' }).end('Authorization failed.');
      rejectCode(new OAuthError(`ChatGPT authorization failed: ${error}`));
      return;
    }
    if (state !== expectedState || authorizationCode === undefined) {
      response.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' }).end('Invalid authorization callback.');
      rejectCode(new OAuthError('ChatGPT authorization callback is invalid.'));
      return;
    }
    response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }).end(
      '<!doctype html><meta charset="utf-8"><title>Signed in</title><p>ChatGPT sign-in completed. You can close this window.</p>',
    );
    resolveCode(authorizationCode);
  });

  const timeout = setTimeout(() => {
    rejectCode(new DeviceCodeTimeoutError('ChatGPT browser authorization timed out.'));
  }, timeoutMs);
  timeout.unref();
  const abort = () => {
    rejectCode(new OAuthError('ChatGPT authorization was cancelled.'));
  };
  signal?.addEventListener('abort', abort, { once: true });
  const cleanup = () => {
    clearTimeout(timeout);
    signal?.removeEventListener('abort', abort);
  };
  void code.then(cleanup, cleanup);

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(OPENAI_CODEX_CALLBACK_PORT, 'localhost', () => {
      server.off('error', reject);
      resolve();
    });
  }).catch((error: unknown) => {
    clearTimeout(timeout);
    signal?.removeEventListener('abort', abort);
    throw new OAuthError(
      `Unable to start the ChatGPT callback server on localhost:${OPENAI_CODEX_CALLBACK_PORT}.`,
      { cause: error },
    );
  });

  return { server, code };
}

async function fetchJson(
  fetchImpl: Fetch,
  url: string,
  init: RequestInit,
  context: string,
): Promise<Record<string, unknown>> {
  let response: Response;
  try {
    response = await fetchImpl(url, init);
  } catch (error) {
    throw connectionError(`${context} failed`, error);
  }
  if (!response.ok) throw await responseError(`${context} failed`, response);
  return parseJsonObject(response, `${context} response`);
}

async function parseJsonObject(
  response: Response,
  context: string,
): Promise<Record<string, unknown>> {
  let value: unknown;
  try {
    value = await response.json();
  } catch (error) {
    throw new OAuthError(`${context} is not valid JSON.`, { cause: error });
  }
  if (!isRecord(value)) throw new OAuthError(`${context} is not a JSON object.`);
  return value;
}

async function responseError(context: string, response: Response): Promise<OAuthError> {
  const raw = await response.text();
  let detail = raw.trim();
  try {
    const parsed: unknown = JSON.parse(raw);
    if (isRecord(parsed)) {
      const description = parsed['error_description'];
      const error = parsed['error'];
      if (typeof description === 'string') detail = description;
      else if (typeof error === 'string') detail = error;
      else if (isRecord(error)) {
        const code = typeof error['code'] === 'string' ? error['code'] : undefined;
        const message = typeof error['message'] === 'string' ? error['message'] : undefined;
        detail =
          code !== undefined && message !== undefined
            ? `${code}: ${message}`
            : code ?? message ?? detail;
      }
    }
  } catch {
    // Plain-text endpoint errors remain useful as-is.
  }
  return new OAuthError(`${context}: HTTP ${response.status}${detail ? ` ${detail}` : ''}`);
}

function decodeJwt(token: string): Record<string, unknown> | undefined {
  const parts = token.split('.');
  if (parts.length !== 3) return undefined;
  try {
    const parsed: unknown = JSON.parse(Buffer.from(parts[1] ?? '', 'base64url').toString('utf8'));
    return isRecord(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function requireString(value: Record<string, unknown>, key: string): string {
  const resolved = normalizeOptionalString(typeof value[key] === 'string' ? value[key] : undefined);
  if (resolved === undefined) throw new OAuthError(`OAuth response is missing ${key}.`);
  return resolved;
}

function parsePositiveNumber(value: unknown): number | undefined {
  const parsed = typeof value === 'number' ? value : Number.parseFloat(String(value));
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

function normalizeOptionalString(value: string | undefined): string | undefined {
  const normalized = value?.trim();
  return normalized === undefined || normalized.length === 0 ? undefined : normalized;
}

function connectionError(message: string, cause: unknown): OAuthConnectionError {
  return new OAuthConnectionError(message, { cause });
}

function combineSignals(signal: AbortSignal | undefined, timeoutMs: number): AbortSignal {
  return signal === undefined
    ? AbortSignal.timeout(timeoutMs)
    : AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]);
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted === true) throw new OAuthError('ChatGPT authorization was cancelled.');
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

async function closeServer(server: Server): Promise<void> {
  if (!server.listening) return;
  await new Promise<void>((resolve) => {
    server.close(() => {
      resolve();
    });
  });
}
