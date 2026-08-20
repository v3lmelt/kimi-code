import { describe, expect, it, vi } from 'vitest';

import { normalizeHostedSearch } from '../../src/tools/builtin/web/normalizer';

describe('normalizeHostedSearch', () => {
  it('prefers valid citation text and deduplicates source URLs without fetching cited pages', async () => {
    const fetch = vi.fn(async () => ({ content: 'should not be fetched', kind: 'extracted' as const }));
    const result = await normalizeHostedSearch({
      answerText: 'The answer cites this source.',
      events: [
        {
          callId: 'call_1',
          action: {
            type: 'search',
            query: 'answer source',
            sources: [
              { url: 'https://example.test/article', title: 'Metadata title' },
              { url: 'https://example.test/article', title: 'Duplicate title' },
            ],
          },
        },
      ],
      annotations: [
        {
          type: 'url_citation',
          startIndex: 4,
          endIndex: 10,
          title: 'Citation title',
          url: 'https://example.test/article',
        },
      ],
      urlFetcher: { fetch },
    });

    expect(fetch).not.toHaveBeenCalled();
    expect(result.sources).toEqual([
      {
        title: 'Metadata title',
        url: 'https://example.test/article',
        snippet: 'answer',
        cited: true,
        citationText: 'answer',
        snippetKind: 'citation',
      },
    ]);
    expect(result.citations[0]).toMatchObject({ citationText: 'answer' });
  });

  it('fetches only uncited HTTP sources and degrades failures or non-HTTP URLs', async () => {
    const fetch = vi.fn(async (url: string) => {
      if (url.includes('fail')) throw new Error('blocked');
      return {
        content: 'Unrelated opening. The deterministic query appears in this sentence.',
        kind: 'extracted' as const,
      };
    });
    const result = await normalizeHostedSearch({
      answerText: '',
      events: [
        {
          sources: [
            { url: 'https://example.test/page', title: 'Page' },
            { url: 'https://example.test/fail', title: 'Failure' },
            { url: 'file:///secret.txt', title: 'Private file' },
          ],
          action: { type: 'search', query: 'deterministic query' },
        },
      ],
      urlFetcher: { fetch },
    });

    expect(fetch).toHaveBeenCalledTimes(2);
    expect(fetch).toHaveBeenNthCalledWith(
      1,
      'https://example.test/page',
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    expect(fetch).toHaveBeenNthCalledWith(
      2,
      'https://example.test/fail',
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    expect(result.sources).toMatchObject([
      { url: 'https://example.test/page', snippetKind: 'page_extract' },
      { url: 'https://example.test/fail', snippetKind: 'unavailable', snippet: '' },
      { url: 'file:///secret.txt', snippetKind: 'unavailable', snippet: '' },
    ]);
  });

  it('rejects invalid citation ranges, trims URLs, and deduplicates citations', async () => {
    const result = await normalizeHostedSearch({
      answerText: '0123456789',
      events: [{ sources: [{ url: ' https://example.test/source ' }] }],
      annotations: [
        {
          type: 'url_citation',
          startIndex: 1,
          endIndex: 4,
          url: ' https://example.test/source ',
        },
        {
          type: 'url_citation',
          startIndex: 1,
          endIndex: 4,
          url: 'https://example.test/source',
        },
        {
          type: 'url_citation',
          startIndex: Number.NaN,
          endIndex: 4,
          url: 'https://example.test/source',
        },
        {
          type: 'url_citation',
          startIndex: 4,
          endIndex: Number.POSITIVE_INFINITY,
          url: 'https://example.test/source',
        },
        {
          type: 'url_citation',
          startIndex: 8,
          endIndex: 8,
          url: 'https://example.test/source',
        },
        {
          type: 'url_citation',
          startIndex: 9,
          endIndex: 11,
          url: 'https://example.test/source',
        },
      ],
    });

    expect(result.sources[0]?.url).toBe('https://example.test/source');
    expect(result.citations).toEqual([
      {
        type: 'url_citation',
        startIndex: 1,
        endIndex: 4,
        url: 'https://example.test/source',
        citationText: '123',
      },
    ]);
  });

  it('keeps cited sources ahead of uncited sources and drops citations for dropped sources', async () => {
    const uncited = Array.from({ length: 20 }, (_, index) => ({
      url: `https://example.test/uncited-${String(index)}`,
    }));
    const result = await normalizeHostedSearch({
      answerText: 'ab',
      events: [
        {
          sources: [
            ...uncited,
            { url: ' https://example.test/cited-a ' },
            { url: 'https://example.test/cited-b' },
          ],
        },
      ],
      annotations: [
        {
          type: 'url_citation',
          startIndex: 0,
          endIndex: 1,
          url: ' https://example.test/cited-a ',
        },
        {
          type: 'url_citation',
          startIndex: 1,
          endIndex: 2,
          url: 'https://example.test/cited-b',
        },
      ],
    });

    expect(result.sources).toHaveLength(20);
    expect(result.sources.slice(0, 2).map((source) => source.url)).toEqual([
      'https://example.test/cited-a',
      'https://example.test/cited-b',
    ]);
    expect(result.citations.every((citation) =>
      result.sources.some((source) => source.url === citation.url),
    )).toBe(true);
    expect(result.citations.map((citation) => citation.url)).toEqual([
      'https://example.test/cited-a',
      'https://example.test/cited-b',
    ]);
  });

  it('aborts source fetching when the five-second timeout expires', async () => {
    vi.useFakeTimers();
    let signal: AbortSignal | undefined;
    const fetch = vi.fn(
      (_url: string, options?: { signal?: AbortSignal }) =>
        new Promise<{ content: string; kind: 'extracted' }>(() => {
          signal = options?.signal;
        }),
    );
    try {
      const resultPromise = normalizeHostedSearch({
        answerText: '',
        events: [{ sources: [{ url: 'https://example.test/slow' }] }],
        urlFetcher: { fetch },
      });
      await vi.advanceTimersByTimeAsync(5_000);
      const result = await resultPromise;
      expect(signal).toBeDefined();
      expect(signal?.aborted).toBe(true);
      expect(result.sources).toMatchObject([
        { url: 'https://example.test/slow', snippetKind: 'unavailable' },
      ]);
    } finally {
      vi.useRealTimers();
    }
  });
});
