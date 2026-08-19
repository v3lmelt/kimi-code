import { MissingApiKeyError } from '#/errors';
import type { ProviderRequestAuth } from '#/provider';

export function requireProviderApiKey(
  providerName: string,
  auth: ProviderRequestAuth | undefined,
  defaultApiKey?: string,
): string {
  const apiKey = auth?.apiKey ?? defaultApiKey;
  if (apiKey === undefined || apiKey.length === 0) {
    throw new MissingApiKeyError(
      `${providerName}: apiKey is required. Provide it via the constructor options, the provider's API-key environment variable, options.auth.apiKey on each request, or an OAuth login.`,
    );
  }
  return apiKey;
}

export function mergeRequestHeaders(
  defaultHeaders: Record<string, string> | undefined,
  requestHeaders: Record<string, string> | undefined,
): Record<string, string> | undefined {
  const merged: Record<string, string> = {};
  if (defaultHeaders !== undefined) {
    Object.assign(merged, defaultHeaders);
  }
  if (requestHeaders !== undefined) {
    Object.assign(merged, requestHeaders);
  }
  return Object.keys(merged).length > 0 ? merged : undefined;
}

/**
 * Stable signature for a per-request auth: apiKey plus sorted header entries.
 * Equal auth values always produce the same signature; header order does not
 * matter. Used as the per-provider cache key for rebuilt clients.
 */
function authSignature(auth: ProviderRequestAuth | undefined): string {
  if (auth === undefined) return '';
  let signature = auth.apiKey ?? '';
  if (auth.headers !== undefined) {
    const names = Object.keys(auth.headers).toSorted();
    for (const name of names) {
      signature += `\n${name}=${auth.headers[name]}`;
    }
  }
  return signature;
}

/**
 * Rebuilt per-request SDK clients, keyed by provider instance (`cacheScope`)
 * then by auth signature. A provider instance that keeps rebuilding its client
 * for the same auth (e.g. an OAuth token that stays valid across turns) reuses
 * the previously built client instead of paying SDK construction plus
 * environment re-parsing every request. The WeakMap scope keeps caches
 * instance-local and garbage-collected with the provider; each scope holds at
 * most {@link AUTH_CLIENT_CACHE_MAX_PER_SCOPE} entries and clears when full.
 * Failed builds are never cached. SDK clients are safe to share across
 * requests (they hold configuration, not per-request state).
 */
const AUTH_CLIENT_CACHE_MAX_PER_SCOPE = 8;
const authClientCache = new WeakMap<object, Map<string, unknown>>();

/**
 * Resolve the SDK client to use for a single provider request, applying the
 * standard precedence shared by every provider adapter:
 *
 * 1. If a `clientFactory` was supplied, delegate to it (it receives the
 *    per-request {@link ProviderRequestAuth}, defaulting to `{}`).
 * 2. Otherwise, if no per-request auth is needed AND a constructor-time
 *    client was cached, reuse the cached instance.
 * 3. Otherwise, call `build(auth)` to construct a fresh client for this
 *    request — typically using `requireProviderApiKey` plus
 *    `mergeRequestHeaders`. When `cacheScope` is provided, the built client is
 *    cached per `(cacheScope, auth signature)` so identical per-request auth
 *    (e.g. the same OAuth bearer token on every turn) reuses the client; a
 *    changed token or apiKey produces a fresh client and is cached under its
 *    own signature.
 *
 * Note: when per-request `auth` is provided (e.g. an OAuth bearer token
 * resolved immediately before each call), step 3 fires and a fresh SDK client
 * would otherwise be constructed per request. The cache keeps short-lived
 * credentials out of any long-lived shared state while avoiding the per-request
 * rebuild cost; concurrent requests that share one cached client are safe
 * because the SDK clients serialize per request and hold no per-request state.
 */
export function resolveAuthBackedClient<TClient>(
  state: {
    readonly cachedClient: TClient | undefined;
    readonly clientFactory: ((auth: ProviderRequestAuth) => TClient) | undefined;
  },
  auth: ProviderRequestAuth | undefined,
  build: (auth: ProviderRequestAuth | undefined) => TClient,
  cacheScope?: object,
): TClient {
  if (state.clientFactory !== undefined) {
    return state.clientFactory(auth ?? {});
  }
  if (auth === undefined && state.cachedClient !== undefined) {
    return state.cachedClient;
  }
  if (cacheScope !== undefined) {
    const key = authSignature(auth);
    let entries = authClientCache.get(cacheScope);
    if (entries === undefined) {
      entries = new Map();
      authClientCache.set(cacheScope, entries);
    }
    const cached = entries.get(key);
    if (cached !== undefined) {
      return cached as TClient;
    }
    const client = build(auth);
    if (entries.size >= AUTH_CLIENT_CACHE_MAX_PER_SCOPE) {
      entries.clear();
    }
    entries.set(key, client);
    return client;
  }
  return build(auth);
}
