/**
 * `kosong/provider` auth-backed client cache probes — mirror of
 * `packages/kosong/test/providers/request-auth.test.ts` (the kosong fork
 * contract): identical per-request auth reuses the built SDK client, header
 * order does not affect the signature, distinct auth signatures and distinct
 * provider instances build separately, failed builds are never cached, and the
 * clientFactory / constructor-cached-client precedence is unchanged.
 */

import type { ProviderRequestAuth } from '#/kosong/contract/provider';
import { resolveAuthBackedClient } from '#/kosong/provider/bases/request-auth';
import { describe, expect, it, vi } from 'vitest';

const emptyState = { cachedClient: undefined, clientFactory: undefined };

describe('resolveAuthBackedClient', () => {
  it('相同 auth 二次解析不重建 client', () => {
    const build = vi.fn((a: ProviderRequestAuth | undefined) => ({ built: a }));
    const scope = {};
    const auth: ProviderRequestAuth = { apiKey: 'k1' };
    const c1 = resolveAuthBackedClient(emptyState, auth, build, scope);
    const c2 = resolveAuthBackedClient(emptyState, auth, build, scope);
    expect(build).toHaveBeenCalledTimes(1);
    expect(c2).toBe(c1);
  });

  it('相同 auth(headers 顺序不同)仍复用 client', () => {
    const build = vi.fn((a: ProviderRequestAuth | undefined) => ({ built: a }));
    const scope = {};
    const auth1: ProviderRequestAuth = { apiKey: 'k', headers: { a: '1', b: '2' } };
    const auth2: ProviderRequestAuth = { apiKey: 'k', headers: { b: '2', a: '1' } };
    resolveAuthBackedClient(emptyState, auth1, build, scope);
    resolveAuthBackedClient(emptyState, auth2, build, scope);
    expect(build).toHaveBeenCalledTimes(1);
  });

  it('不同 auth 签名(apiKey/headers 变化)各自重建', () => {
    const build = vi.fn((a: ProviderRequestAuth | undefined) => ({ built: a }));
    const scope = {};
    resolveAuthBackedClient(emptyState, { apiKey: 'k1' }, build, scope);
    resolveAuthBackedClient(emptyState, { apiKey: 'k2' }, build, scope);
    resolveAuthBackedClient(emptyState, { apiKey: 'k1', headers: { x: 'y' } }, build, scope);
    expect(build).toHaveBeenCalledTimes(3);
  });

  it('不同 provider 实例(cacheScope)不共享缓存', () => {
    const build = vi.fn((a: ProviderRequestAuth | undefined) => ({ built: a }));
    const scope1 = {};
    const scope2 = {};
    resolveAuthBackedClient(emptyState, { apiKey: 'k' }, build, scope1);
    resolveAuthBackedClient(emptyState, { apiKey: 'k' }, build, scope2);
    expect(build).toHaveBeenCalledTimes(2);
  });

  it('build 失败不缓存:同一失败 auth 再次调用仍走 build', () => {
    const build = vi.fn(() => {
      throw new Error('no key');
    });
    const scope = {};
    expect(() => resolveAuthBackedClient(emptyState, { apiKey: 'k' }, build, scope)).toThrow('no key');
    expect(() => resolveAuthBackedClient(emptyState, { apiKey: 'k' }, build, scope)).toThrow('no key');
    expect(build).toHaveBeenCalledTimes(2);
  });

  it('无 per-request auth 且构造时 client 已缓存:直接复用,不 build', () => {
    const cached = { client: true };
    const build = vi.fn();
    const c = resolveAuthBackedClient(
      { cachedClient: cached, clientFactory: undefined },
      undefined,
      build,
      {},
    );
    expect(c).toBe(cached);
    expect(build).not.toHaveBeenCalled();
  });

  it('clientFactory 优先于缓存,且每次调用都委托', () => {
    const factory = vi.fn((a: ProviderRequestAuth) => ({ fromFactory: a }));
    const build = vi.fn();
    const scope = {};
    const c1 = resolveAuthBackedClient(
      { cachedClient: {}, clientFactory: factory },
      undefined,
      build,
      scope,
    );
    const c2 = resolveAuthBackedClient(
      { cachedClient: {}, clientFactory: factory },
      undefined,
      build,
      scope,
    );
    expect(factory).toHaveBeenCalledTimes(2);
    expect(c2).toEqual(c1);
    expect(c2).not.toBe(c1);
    expect(build).not.toHaveBeenCalled();
  });

  it('不传 cacheScope 时保持原行为:每次调用都 build', () => {
    const build = vi.fn((a: ProviderRequestAuth | undefined) => ({ built: a }));
    resolveAuthBackedClient(emptyState, { apiKey: 'k' }, build);
    resolveAuthBackedClient(emptyState, { apiKey: 'k' }, build);
    expect(build).toHaveBeenCalledTimes(2);
  });
});
