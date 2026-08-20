import type { HostedSearchCitation, HostedSearchEvent } from '@moonshot-ai/kimi-code-sdk';
import { getCapabilities, setCapabilities, visibleWidth } from '@moonshot-ai/pi-tui';
import { describe, expect, it } from 'vitest';

import { HostedSearchComponent } from '#/tui/components/messages/hosted-search';
import {
  StreamingUIController,
  type StreamingUIHost,
} from '#/tui/controllers/streaming-ui';
import type { TranscriptEntry } from '#/tui/types';
import type { TUIState } from '#/tui/tui-state';
import {
  createHostedSearchTranscriptData,
  decorateAssistantTextWithCitations,
  mergeHostedSearchEvent,
} from '#/tui/utils/hosted-search';

function makeStreamingSearchHarness(): {
  readonly controller: StreamingUIController;
  readonly entries: TranscriptEntry[];
} {
  const entries: TranscriptEntry[] = [];
  const host = {
    state: {
      ui: { requestRender: () => undefined },
      previewContainer: { clear: () => undefined, addChild: () => undefined },
    } as unknown as TUIState,
    appendTranscriptEntry: (entry: TranscriptEntry) => entries.push(entry),
    pushTranscriptEntry: (entry: TranscriptEntry) => entries.push(entry),
    updateActivityPane: () => undefined,
  } as unknown as StreamingUIHost;
  return { controller: new StreamingUIController(host), entries };
}

function searchCardEntries(entries: readonly TranscriptEntry[]): TranscriptEntry[] {
  return entries.filter((entry) => entry.hostedSearchData !== undefined);
}

describe('hosted search TUI projection', () => {
  it('merges lifecycle sources once and prioritizes cited URLs', () => {
    const data = createHostedSearchTranscriptData({
      type: 'hosted.search',
      turnId: 3,
      step: 1,
      phase: 'action',
      callId: 'call-1',
      action: {
        type: 'search',
        query: 'terminal UI',
        sources: [
          { url: 'https://example.test/uncited', title: 'Uncited' },
          { url: 'https://example.test/cited', title: 'Cited' },
        ],
      },
      status: 'searching',
    });

    mergeHostedSearchEvent(data, {
      type: 'hosted.search',
      turnId: 3,
      step: 1,
      phase: 'completed',
      callId: 'call-1',
      status: 'completed',
      citations: [
        {
          type: 'url_citation',
          startIndex: 0,
          endIndex: 5,
          url: 'https://example.test/cited',
          title: 'Cited',
          citationText: 'hello',
        },
      ],
      sources: [
        {
          url: 'https://example.test/cited',
          title: 'Cited',
          snippet: 'hello',
          cited: true,
          snippetKind: 'citation',
        },
      ],
    });

    expect(data.status).toBe('completed');
    expect(data.query).toBe('terminal UI');
    expect(data.sources.map((source) => source.url)).toEqual([
      'https://example.test/cited',
      'https://example.test/uncited',
    ]);
    expect(data.sources).toHaveLength(2);
    expect(data.citations).toHaveLength(1);
  });

  it('adds clickable display-only citation markers without changing source text', () => {
    const text = 'hello world';
    const citation = {
      type: 'url_citation' as const,
      startIndex: 0,
      endIndex: 5,
      url: 'https://example.test/article',
    };
    const decorated = decorateAssistantTextWithCitations(text, [citation], [citation]);

    expect(text).toBe('hello world');
    expect(decorated).toContain('[1]');
    expect(decorated).toContain('https://example.test/article');
  });

  it('keeps no-call-id actions in distinct cards and migrates each by evidence', () => {
    const { controller, entries } = makeStreamingSearchHarness();
    const firstUrl = ' https://example.test/first ';
    const secondUrl = 'https://example.test/second';
    const firstAction: HostedSearchEvent = {
      type: 'hosted.search',
      turnId: 4,
      step: 2,
      phase: 'action',
      status: 'searching',
      action: { type: 'search', query: 'first query', sources: [{ url: firstUrl }] },
    };
    const secondAction: HostedSearchEvent = {
      type: 'hosted.search',
      turnId: 4,
      step: 2,
      phase: 'action',
      status: 'searching',
      action: { type: 'search', query: 'second query', sources: [{ url: secondUrl }] },
    };
    controller.handleHostedSearch(firstAction);
    controller.handleHostedSearch(secondAction);

    expect(searchCardEntries(entries)).toHaveLength(2);
    expect(searchCardEntries(entries).map((entry) => entry.hostedSearchData?.query)).toEqual([
      'first query',
      'second query',
    ]);
    expect(searchCardEntries(entries).map((entry) => entry.hostedSearchData?.identity)).toEqual([
      '4:2:temporary:0',
      '4:2:temporary:1',
    ]);
    expect(searchCardEntries(entries).map((entry) => entry.hostedSearchData?.sources.map((source) => source.url))).toEqual([
      ['https://example.test/first'],
      [secondUrl],
    ]);

    controller.handleHostedSearch({
      ...firstAction,
      callId: 'call-first',
      phase: 'source',
      sources: [{ url: firstUrl, title: 'First' }],
    });
    controller.handleHostedSearch({
      ...secondAction,
      callId: 'call-second',
      phase: 'source',
      sources: [{ url: secondUrl, title: 'Second' }],
    });
    controller.handleHostedSearch({
      type: 'hosted.search',
      turnId: 4,
      step: 2,
      phase: 'source',
      sources: [{ url: firstUrl, snippet: 'first extract' }],
    });
    controller.handleHostedSearch({
      type: 'hosted.search',
      turnId: 4,
      step: 2,
      phase: 'completed',
      status: 'completed',
      query: 'second query',
    });

    const cards = searchCardEntries(entries).map((entry) => entry.hostedSearchData!);
    expect(cards).toHaveLength(2);
    expect(cards.map((data) => data.callId)).toEqual(['call-first', 'call-second']);
    expect(cards.map((data) => data.identity)).toEqual(['4:2:temporary:0', '4:2:temporary:1']);
    expect(cards[0]?.sources).toEqual([
      expect.objectContaining({ url: 'https://example.test/first', snippet: 'first extract' }),
    ]);
    expect(cards[1]?.sources).toEqual([
      expect.objectContaining({ url: 'https://example.test/second', title: 'Second' }),
    ]);
  });

  it('keeps repeated no-call action events separate when identity is unavailable', () => {
    const { controller, entries } = makeStreamingSearchHarness();
    const action: HostedSearchEvent = {
      type: 'hosted.search',
      turnId: 8,
      step: 0,
      phase: 'action',
      action: { type: 'search', query: 'same query' },
    };
    controller.handleHostedSearch(action);
    controller.handleHostedSearch(action);

    expect(searchCardEntries(entries)).toHaveLength(2);
    expect(searchCardEntries(entries).map((entry) => entry.hostedSearchData?.identity)).toEqual([
      '8:0:temporary:0',
      '8:0:temporary:1',
    ]);
  });

  it('treats empty call ids as missing, then migrates a card to a valid call id', () => {
    const { controller, entries } = makeStreamingSearchHarness();
    const firstAction: HostedSearchEvent = {
      type: 'hosted.search',
      turnId: 9,
      step: 1,
      phase: 'action',
      callId: '   ',
      action: { type: 'search', query: 'first query' },
    };
    const secondAction: HostedSearchEvent = {
      type: 'hosted.search',
      turnId: 9,
      step: 1,
      phase: 'action',
      callId: '',
      action: { type: 'search', query: 'second query' },
    };
    controller.handleHostedSearch(firstAction);
    controller.handleHostedSearch(secondAction);

    expect(searchCardEntries(entries)).toHaveLength(2);
    expect(searchCardEntries(entries).map((entry) => entry.hostedSearchData?.callId)).toEqual([
      undefined,
      undefined,
    ]);

    controller.handleHostedSearch({
      ...firstAction,
      callId: ' call-first ',
      phase: 'source',
      sources: [{ url: 'https://example.test/first' }],
    });

    const cards = searchCardEntries(entries).map((entry) => entry.hostedSearchData!);
    expect(cards).toHaveLength(2);
    expect(cards[0]?.callId).toBe('call-first');
    expect(cards[0]?.identity).toBe('9:1:temporary:0');
    expect(cards[1]?.callId).toBeUndefined();
    expect(cards[1]?.identity).toBe('9:1:temporary:1');
  });

  it('does not merge an ambiguous late no-call event into an existing card', () => {
    const { controller, entries } = makeStreamingSearchHarness();
    const event = (query: string): HostedSearchEvent => ({
      type: 'hosted.search',
      turnId: 8,
      step: 1,
      phase: 'action',
      action: { type: 'search', query },
    });
    controller.handleHostedSearch(event('one'));
    controller.handleHostedSearch(event('two'));
    controller.handleHostedSearch({
      type: 'hosted.search',
      turnId: 8,
      step: 1,
      phase: 'source',
      sources: [{ url: 'https://example.test/unknown' }],
    });

    expect(searchCardEntries(entries)).toHaveLength(3);
    expect(searchCardEntries(entries)[2]?.hostedSearchData?.query).toBeUndefined();
  });

  it('keeps hosted-search phase and terminal status monotonic while merging late data', () => {
    const data = createHostedSearchTranscriptData({
      type: 'hosted.search',
      turnId: 7,
      step: 1,
      phase: 'completed',
      status: 'failed',
      callId: 'call-terminal',
    });
    mergeHostedSearchEvent(data, {
      type: 'hosted.search',
      turnId: 7,
      step: 1,
      phase: 'started',
      status: 'searching',
      callId: 'call-terminal',
    });
    mergeHostedSearchEvent(data, {
      type: 'hosted.search',
      turnId: 7,
      step: 1,
      phase: 'source',
      status: 'completed',
      callId: 'call-terminal',
      sources: [{ url: ' https://example.test/late ' }],
    });

    expect(data.phase).toBe('completed');
    expect(data.status).toBe('failed');
    expect(data.sources.map((source) => source.url)).toEqual(['https://example.test/late']);

    const completed = createHostedSearchTranscriptData({
      type: 'hosted.search',
      turnId: 7,
      step: 2,
      phase: 'completed',
      status: 'completed',
      callId: 'call-completed',
    });
    mergeHostedSearchEvent(completed, {
      type: 'hosted.search',
      turnId: 7,
      step: 2,
      phase: 'started',
      status: 'failed',
      callId: 'call-completed',
    });
    expect(completed.phase).toBe('completed');
    expect(completed.status).toBe('completed');
  });

  it('rejects invalid, duplicate, and overlapping citation ranges', () => {
    const text = 'abcdefghij';
    const valid = {
      type: 'url_citation' as const,
      startIndex: 0,
      endIndex: 5,
      url: ' https://example.test/valid ',
    };
    const decorated = decorateAssistantTextWithCitations(text, [
      { ...valid },
      { ...valid },
      { ...valid, startIndex: 2, endIndex: 7, url: 'https://example.test/overlap' },
      { ...valid, startIndex: Number.NaN, url: 'https://example.test/nan' },
      { ...valid, startIndex: Number.POSITIVE_INFINITY, url: 'https://example.test/infinity' },
      { ...valid, startIndex: 0.5, url: 'https://example.test/fraction' },
      { ...valid, startIndex: -1, endIndex: 2, url: 'https://example.test/negative' },
      { ...valid, startIndex: 4, endIndex: 4, url: 'https://example.test/empty' },
      { ...valid, startIndex: 4, endIndex: 11, url: 'https://example.test/too-long' },
    ], [valid]);

    expect(text).toBe('abcdefghij');
    expect(decorated.match(/\[\[1\]\]/g)).toHaveLength(1);
    expect(decorated).toContain('https://example.test/valid');
    expect(decorated).not.toContain('overlap');
    expect(decorated).not.toContain('nan');
    expect(decorated).not.toContain('too-long');
  });

  it('filters malformed realtime citations before source promotion and numbering', () => {
    const invalidCitations: HostedSearchCitation[] = [
      {
        type: 'url_citation',
        startIndex: Number.NaN,
        endIndex: 1,
        url: 'https://example.test/nan',
      },
      {
        type: 'url_citation',
        startIndex: 0,
        endIndex: Number.POSITIVE_INFINITY,
        url: 'https://example.test/infinity',
      },
      {
        type: 'url_citation',
        startIndex: 0.5,
        endIndex: 1,
        url: 'https://example.test/fraction',
      },
      {
        type: 'url_citation',
        startIndex: -1,
        endIndex: 1,
        url: 'https://example.test/negative',
      },
      {
        type: 'url_citation',
        startIndex: 2,
        endIndex: 2,
        url: 'https://example.test/empty',
      },
      {
        type: 'url_citation',
        startIndex: 3,
        endIndex: 2,
        url: 'https://example.test/reversed',
      },
      {
        type: 'url_citation',
        startIndex: 0,
        endIndex: 1,
        url: '   ',
      },
    ];
    const valid: HostedSearchCitation = {
      type: 'url_citation',
      startIndex: 5,
      endIndex: 10,
      url: 'https://example.test/valid',
    };
    const data = createHostedSearchTranscriptData({
      type: 'hosted.search',
      turnId: 5,
      step: 0,
      phase: 'source',
      sources: [{ url: '   ', title: 'invalid source' }],
      citations: invalidCitations,
    });

    expect(data.citations).toEqual([]);
    expect(data.sources).toEqual([]);
    mergeHostedSearchEvent(data, {
      type: 'hosted.search',
      turnId: 5,
      step: 0,
      phase: 'completed',
      citations: [...invalidCitations, valid],
    });

    expect(data.citations).toEqual([valid]);
    expect(data.sources.map((source) => source.url)).toEqual([valid.url]);

    const decorated = decorateAssistantTextWithCitations(
      'abcdefghij',
      [...invalidCitations, valid],
    );
    expect(decorated.match(/\[\[1\]\]/g)).toHaveLength(1);
    expect(decorated).toContain('https://example.test/valid');
    for (const citation of invalidCitations) {
      expect(decorated).not.toContain(citation.url);
    }

    const { controller, entries } = makeStreamingSearchHarness();
    controller.onStreamingTextStart();
    controller.addAssistantCitations(invalidCitations);
    const assistant = entries.find((entry) => entry.kind === 'assistant');
    expect(assistant?.assistantCitations).toEqual([]);
    expect(assistant?.assistantCitationSources).toEqual([]);
  });

  it('removes out-of-bounds citations before card ordering and numbering', () => {
    const { controller, entries } = makeStreamingSearchHarness();
    controller.setTurnId('1');
    controller.setStep(0);
    controller.onStreamingTextStart();
    controller.onStreamingTextUpdate('abcdefghij');
    controller.handleHostedSearch({
      type: 'hosted.search',
      turnId: 1,
      step: 0,
      phase: 'completed',
      callId: 'call-1',
      status: 'completed',
      citations: [
        {
          type: 'url_citation',
          startIndex: 0,
          endIndex: 11,
          url: 'https://example.test/out-of-bounds',
        },
        {
          type: 'url_citation',
          startIndex: 0,
          endIndex: 1,
          url: 'https://example.test/valid',
        },
      ],
    });

    controller.finalizeAssistantStream();

    const card = searchCardEntries(entries)[0]?.hostedSearchData;
    expect(card?.citations.map((citation) => citation.url)).toEqual([
      'https://example.test/valid',
    ]);
    expect(card?.sources.map((source) => source.url)).toEqual([
      'https://example.test/valid',
      'https://example.test/out-of-bounds',
    ]);
    const assistant = entries.find((entry) => entry.kind === 'assistant');
    expect(assistant?.assistantCitations?.map((citation) => citation.url)).toEqual([
      'https://example.test/valid',
    ]);
  });

  it('canonicalizes open and find action URLs in storage and card output', () => {
    const data = createHostedSearchTranscriptData({
      type: 'hosted.search',
      turnId: 5,
      step: 1,
      phase: 'action',
      action: { type: 'open_page', url: ' https://example.test/open ' },
    });
    mergeHostedSearchEvent(data, {
      type: 'hosted.search',
      turnId: 5,
      step: 1,
      phase: 'action',
      action: { type: 'find_in_page', url: ' https://example.test/find ' },
    });

    expect(data.actions).toEqual([
      { type: 'open_page', url: 'https://example.test/open' },
      { type: 'find_in_page', url: 'https://example.test/find' },
    ]);
    const rendered = new HostedSearchComponent(data).render(120).join('\n');
    expect(rendered).toContain('Action: open: https://example.test/open');
    expect(rendered).toContain('Action: find: https://example.test/find');
    expect(rendered).not.toContain('https://example.test/open ');
    expect(rendered).not.toContain('https://example.test/find ');
  });

  it('deduplicates source and citation URLs after trimming', () => {
    const data = createHostedSearchTranscriptData({
      type: 'hosted.search',
      turnId: 5,
      step: 0,
      phase: 'source',
      sources: [{ url: ' https://example.test/trimmed ', title: 'First' }],
    });
    mergeHostedSearchEvent(data, {
      type: 'hosted.search',
      turnId: 5,
      step: 0,
      phase: 'completed',
      citations: [
        {
          type: 'url_citation',
          startIndex: 0,
          endIndex: 1,
          url: 'https://example.test/trimmed',
        },
      ],
    });

    expect(data.sources).toHaveLength(1);
    expect(data.sources[0]?.url).toBe('https://example.test/trimmed');
    expect(data.citations[0]?.url).toBe('https://example.test/trimmed');
  });

  it('keeps the dedicated card within narrow terminal widths', () => {
    const data = createHostedSearchTranscriptData({
      type: 'hosted.search',
      turnId: 1,
      step: 0,
      phase: 'completed',
      status: 'completed',
      query: 'a long query that must wrap',
      sources: [
        {
          url: 'https://example.test/a-very-long-source-url',
          title: 'A source with a long title',
          snippet: 'A source snippet that must remain visibly attributed.',
          snippetKind: 'page_extract',
        },
      ],
    });
    const component = new HostedSearchComponent(data);

    for (const line of component.render(24)) {
      expect(visibleWidth(line)).toBeLessThanOrEqual(24);
    }
  });

  it('keeps source URLs readable when OSC 8 hyperlinks are unavailable', () => {
    const previous = getCapabilities();
    const data = createHostedSearchTranscriptData({
      type: 'hosted.search',
      turnId: 1,
      step: 0,
      phase: 'completed',
      status: 'completed',
      sources: [{ url: 'https://example.test/source', title: 'Source' }],
    });
    try {
      setCapabilities({ ...previous, hyperlinks: false });
      const rendered = new HostedSearchComponent(data).render(120).join('\\n');
      expect(rendered).toContain('https://example.test/source');
      expect(rendered).not.toContain('\\u001b]8;;');
    } finally {
      setCapabilities(previous);
    }
  });
});
