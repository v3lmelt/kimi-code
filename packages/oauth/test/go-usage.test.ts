import { afterEach, describe, it, expect, vi } from 'vitest';

import { fetchGoUsage } from '../src/go-usage';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('fetchGoUsage', () => {
  it('parses rolling and weekly windows from the payload', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              usage: {
                rolling: { status: 'ok', percent: 11, resetsAt: '2026-08-14T09:14:53Z' },
                weekly: { status: 'ok', percent: 44, resetsAt: '2026-08-17T00:00:00Z' },
                monthly: { status: 'ok', percent: 22 },
              },
            }),
            { status: 200, headers: { 'Content-Type': 'application/json' } },
          ),
      ),
    );

    await expect(fetchGoUsage('https://opencode.ai/zen/go/v1', 'api-key')).resolves.toEqual({
      kind: 'ok',
      parsed: {
        rolling: { percent: 11, resetsAt: '2026-08-14T09:14:53Z' },
        weekly: { percent: 44, resetsAt: '2026-08-17T00:00:00Z' },
      },
    });
  });

  it('sends only Authorization and Accept headers', async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(JSON.stringify({ usage: {} }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
    );
    vi.stubGlobal('fetch', fetchMock);

    await fetchGoUsage('https://opencode.ai/zen/go/v1', 'api-key');

    const calls = fetchMock.mock.calls as unknown as [string, RequestInit?][];
    const init = calls[0]?.[1] ?? {};
    const headers = new Headers((init.headers ?? {}) as Record<string, string>);
    expect(headers.get('authorization')).toBe('Bearer api-key');
    expect(headers.get('accept')).toBe('application/json');
    expect(headers.get('user-agent')).toBeNull();
  });

  it('drops windows with a missing or non-numeric percent', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              usage: {
                rolling: { status: 'ok', resetsAt: '2026-08-14T09:14:53Z' },
                weekly: { status: 'ok', percent: '44' },
              },
            }),
            { status: 200 },
          ),
      ),
    );

    await expect(fetchGoUsage('https://opencode.ai/zen/go/v1', 'api-key')).resolves.toEqual({
      kind: 'ok',
      parsed: { rolling: null, weekly: null },
    });
  });

  it('drops windows with an out-of-range percent', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              usage: {
                rolling: { status: 'ok', percent: 101 },
                weekly: { status: 'ok', percent: -1 },
              },
            }),
            { status: 200 },
          ),
      ),
    );

    await expect(fetchGoUsage('https://opencode.ai/zen/go/v1', 'api-key')).resolves.toEqual({
      kind: 'ok',
      parsed: { rolling: null, weekly: null },
    });
  });

  it('drops windows whose status is not ok', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              usage: {
                rolling: { status: 'limit', percent: 50 },
                weekly: { status: 'ok', percent: 12 },
              },
            }),
            { status: 200 },
          ),
      ),
    );

    await expect(fetchGoUsage('https://opencode.ai/zen/go/v1', 'api-key')).resolves.toEqual({
      kind: 'ok',
      parsed: { rolling: null, weekly: { percent: 12 } },
    });
  });

  it('omits resetsAt when it is missing or empty', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              usage: {
                rolling: { status: 'ok', percent: 11 },
                weekly: { status: 'ok', percent: 44, resetsAt: '' },
              },
            }),
            { status: 200 },
          ),
      ),
    );

    await expect(fetchGoUsage('https://opencode.ai/zen/go/v1', 'api-key')).resolves.toEqual({
      kind: 'ok',
      parsed: { rolling: { percent: 11 }, weekly: { percent: 44 } },
    });
  });

  it('returns null windows when the payload has no usage record', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(JSON.stringify({ message: 'no usage' }), {
            status: 200,
          }),
      ),
    );

    await expect(fetchGoUsage('https://opencode.ai/zen/go/v1', 'api-key')).resolves.toEqual({
      kind: 'ok',
      parsed: { rolling: null, weekly: null },
    });
  });

  it('joins the usage path onto the base URL, trimming trailing slashes', async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(JSON.stringify({ usage: {} }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
    );
    vi.stubGlobal('fetch', fetchMock);

    await fetchGoUsage('https://opencode.ai/zen/go/v1/', 'api-key');

    const calls = fetchMock.mock.calls as unknown as [string, RequestInit?][];
    expect(calls[0]?.[0]).toBe('https://opencode.ai/zen/go/v1/usage');
  });

  it('returns an error with an API-key hint on 401', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('', { status: 401 })));

    const result = await fetchGoUsage('https://opencode.ai/zen/go/v1', 'bad-key');

    expect(result.kind).toBe('error');
    if (result.kind !== 'error') return;
    expect(result.status).toBe(401);
    expect(result.message).toBe('Authorization failed. Please check your API key.');
  });

  it('surfaces JSON API error messages with status', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(JSON.stringify({ message: 'invalid api key' }), {
            status: 401,
            headers: { 'Content-Type': 'application/json' },
          }),
      ),
    );

    const result = await fetchGoUsage('https://opencode.ai/zen/go/v1', 'bad-key');

    expect(result.kind).toBe('error');
    if (result.kind !== 'error') return;
    expect(result.status).toBe(401);
    expect(result.message).toBe('invalid api key');
  });

  it('returns an error with a base-URL hint on 404', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('', { status: 404 })));

    const result = await fetchGoUsage('https://opencode.ai/zen/go/v1', 'api-key');

    expect(result.kind).toBe('error');
    if (result.kind !== 'error') return;
    expect(result.status).toBe(404);
    expect(result.message).toBe('Usage endpoint not available. Please check the opencode-go base URL.');
  });

  it('returns a timeout error when the request exceeds the timeout', async () => {
    vi.useFakeTimers();
    vi.stubGlobal(
      'fetch',
      vi.fn(
        (_url: string, init?: RequestInit) =>
          new Promise<Response>((_resolve, reject) => {
            init?.signal?.addEventListener('abort', () => {
              const error = new Error('aborted');
              error.name = 'AbortError';
              reject(error);
            });
          }),
      ),
    );

    const result = fetchGoUsage('https://opencode.ai/zen/go/v1', 'api-key', { timeoutMs: 8000 });
    await vi.advanceTimersByTimeAsync(8000);
    await expect(result).resolves.toEqual({
      kind: 'error',
      message: 'Failed to fetch usage: request timed out.',
    });
  });
});
