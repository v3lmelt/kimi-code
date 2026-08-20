import type {
  HostedSearchAction,
  HostedSearchCitation,
  HostedSearchEvent,
  HostedSearchSource,
} from '@moonshot-ai/kosong';

import type { UrlFetcher } from './fetch-url';

export const HOSTED_SEARCH_MAX_SOURCES = 20;
export const HOSTED_SEARCH_MAX_FETCH_CONCURRENCY = 4;
export const HOSTED_SEARCH_MAX_PAGE_CHARS = 20_000;
export const HOSTED_SEARCH_MAX_SNIPPET_CHARS = 320;
export const HOSTED_SEARCH_FETCH_TIMEOUT_MS = 5_000;

export type HostedSearchSnippetKind = 'citation' | 'page_extract' | 'unavailable';

export interface NormalizedHostedSearchSource {
  readonly title: string;
  readonly url: string;
  readonly snippet: string;
  readonly cited?: boolean;
  readonly citationText?: string;
  readonly snippetKind: HostedSearchSnippetKind;
  readonly date?: string;
  readonly siteName?: string;
}

export interface NormalizedHostedSearchCitation {
  readonly type: 'url_citation';
  readonly startIndex: number;
  readonly endIndex: number;
  readonly title?: string;
  readonly url: string;
  readonly citationText?: string;
}

export interface NormalizeHostedSearchInput {
  readonly answerText: string;
  readonly events?: readonly HostedSearchEvent[];
  readonly annotations?: readonly HostedSearchCitation[];
  readonly query?: string;
  readonly urlFetcher?: UrlFetcher;
}

export interface NormalizeHostedSearchResult {
  readonly query?: string;
  readonly sources: readonly NormalizedHostedSearchSource[];
  readonly citations: readonly NormalizedHostedSearchCitation[];
}

type SourceMetadata = HostedSearchSource & {
  readonly snippet?: string;
  readonly date?: string;
  readonly siteName?: string;
};

interface SourceEntry {
  readonly url: string;
  metadataTitle?: string;
  citationTitle?: string;
  metadataSnippet?: string;
  date?: string;
  siteName?: string;
  cited?: boolean;
  citationText?: string;
}

export async function normalizeHostedSearch(
  input: NormalizeHostedSearchInput,
): Promise<NormalizeHostedSearchResult> {
  const query = input.query ?? deriveQuery(input.events);
  const citations = collectCitations(input.annotations, input.answerText);
  const entries = prioritizeSources(
    collectSources(input.events, citations),
    citations,
  ).slice(0, HOSTED_SEARCH_MAX_SOURCES);
  const sources = await enrichSources(entries, query, input.urlFetcher);
  const includedSourceUrls = new Set(sources.map((source) => source.url));
  return {
    ...(query === undefined ? {} : { query }),
    sources,
    citations: citations.filter((citation) => includedSourceUrls.has(citation.url)),
  };
}

function collectSources(
  events: readonly HostedSearchEvent[] | undefined,
  annotations: readonly NormalizedHostedSearchCitation[],
): SourceEntry[] {
  const byUrl = new Map<string, SourceEntry>();
  const addMetadata = (source: SourceMetadata | undefined): void => {
    if (source === undefined) return;
    const url = normalizeSourceUrl(source.url);
    if (url === undefined) return;
    const entry = byUrl.get(url) ?? { url };
    if (entry.metadataTitle === undefined && nonEmpty(source.title) !== undefined) {
      entry.metadataTitle = nonEmpty(source.title);
    }
    if (entry.metadataSnippet === undefined && nonEmpty(source.snippet) !== undefined) {
      entry.metadataSnippet = nonEmpty(source.snippet);
    }
    if (entry.date === undefined && nonEmpty(source.date) !== undefined) {
      entry.date = nonEmpty(source.date);
    }
    if (entry.siteName === undefined && nonEmpty(source.siteName) !== undefined) {
      entry.siteName = nonEmpty(source.siteName);
    }
    byUrl.set(url, entry);
  };

  const addActionUrl = (action: HostedSearchAction | undefined): void => {
    if (action?.type === 'open_page' && action.url !== undefined) {
      addMetadata({ url: action.url });
    }
    if (action?.type === 'find_in_page' && action.url !== undefined) {
      addMetadata({ url: action.url });
    }
  };

  for (const event of events ?? []) {
    for (const source of event.sources ?? []) addMetadata(source);
    if (event.action?.type === 'search') {
      for (const source of event.action.sources ?? []) addMetadata(source);
    }
    addActionUrl(event.action);
  }

  for (const annotation of annotations) {
    const url = annotation.url;
    const entry = byUrl.get(url) ?? { url };
    if (entry.citationTitle === undefined && nonEmpty(annotation.title) !== undefined) {
      entry.citationTitle = nonEmpty(annotation.title);
    }
    if (entry.citationText === undefined && annotation.citationText !== undefined) {
      entry.cited = true;
      entry.citationText = annotation.citationText;
    }
    byUrl.set(url, entry);
  }

  return [...byUrl.values()];
}

function collectCitations(
  annotations: readonly HostedSearchCitation[] | undefined,
  answerText: string,
): NormalizedHostedSearchCitation[] {
  const citations: NormalizedHostedSearchCitation[] = [];
  const seen = new Set<string>();
  for (const annotation of annotations ?? []) {
    const url = normalizeHttpUrl(annotation.url);
    const citationText = validCitationText(annotation, answerText);
    if (url === undefined || citationText === undefined) continue;
    const key = `${url}\u0000${annotation.startIndex}\u0000${annotation.endIndex}`;
    if (seen.has(key)) continue;
    seen.add(key);
    citations.push({
      type: 'url_citation',
      startIndex: annotation.startIndex,
      endIndex: annotation.endIndex,
      ...(nonEmpty(annotation.title) === undefined ? {} : { title: annotation.title }),
      url,
      citationText,
    });
  }
  return citations;
}

function prioritizeSources(
  entries: readonly SourceEntry[],
  citations: readonly NormalizedHostedSearchCitation[],
): SourceEntry[] {
  const byUrl = new Map(entries.map((entry) => [entry.url, entry]));
  const citedUrls: string[] = [];
  const citedUrlSet = new Set<string>();
  for (const citation of citations) {
    if (citedUrlSet.has(citation.url)) continue;
    citedUrlSet.add(citation.url);
    citedUrls.push(citation.url);
  }

  const prioritized: SourceEntry[] = [];
  for (const url of citedUrls) {
    const entry = byUrl.get(url);
    if (entry !== undefined) prioritized.push(entry);
  }
  for (const entry of entries) {
    if (!citedUrlSet.has(entry.url)) prioritized.push(entry);
  }
  return prioritized;
}

async function enrichSources(
  entries: readonly SourceEntry[],
  query: string | undefined,
  urlFetcher: UrlFetcher | undefined,
): Promise<readonly NormalizedHostedSearchSource[]> {
  const results: NormalizedHostedSearchSource[] = [];
  results.length = entries.length;
  let next = 0;
  const worker = async (): Promise<void> => {
    while (true) {
      const index = next++;
      if (index >= entries.length) return;
      results[index] = await enrichSource(entries[index]!, query, urlFetcher);
    }
  };
  const workerCount = Math.min(HOSTED_SEARCH_MAX_FETCH_CONCURRENCY, entries.length);
  await Promise.all(Array.from({ length: workerCount }, () => worker()));
  return results;
}

async function enrichSource(
  entry: SourceEntry,
  query: string | undefined,
  urlFetcher: UrlFetcher | undefined,
): Promise<NormalizedHostedSearchSource> {
  const title = sourceTitle(entry);
  if (normalizeHttpUrl(entry.url) === undefined) return unavailableSource(entry, title);
  if (entry.cited === true && entry.citationText !== undefined) {
    return {
      title,
      url: entry.url,
      snippet: entry.citationText,
      cited: true,
      citationText: entry.citationText,
      snippetKind: 'citation',
      ...(entry.date === undefined ? {} : { date: entry.date }),
      ...(entry.siteName === undefined ? {} : { siteName: entry.siteName }),
    };
  }

  if (entry.metadataSnippet !== undefined) {
    return {
      title,
      url: entry.url,
      snippet: truncate(entry.metadataSnippet, HOSTED_SEARCH_MAX_SNIPPET_CHARS),
      snippetKind: 'page_extract',
      ...(entry.date === undefined ? {} : { date: entry.date }),
      ...(entry.siteName === undefined ? {} : { siteName: entry.siteName }),
    };
  }

  if (urlFetcher === undefined) return unavailableSource(entry, title);
  try {
    const result = await fetchWithTimeout(urlFetcher, entry.url);
    const content = result.content.slice(0, HOSTED_SEARCH_MAX_PAGE_CHARS);
    const snippet = extractSnippet(content, query);
    if (snippet.length === 0) return unavailableSource(entry, title);
    return {
      title,
      url: entry.url,
      snippet,
      snippetKind: 'page_extract',
      ...(entry.date === undefined ? {} : { date: entry.date }),
      ...(entry.siteName === undefined ? {} : { siteName: entry.siteName }),
    };
  } catch {
    return unavailableSource(entry, title);
  }
}

async function fetchWithTimeout(urlFetcher: UrlFetcher, url: string): Promise<{ content: string }> {
  const controller = new AbortController();
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timeoutId = setTimeout(
      () => {
        controller.abort();
        reject(new Error(`Hosted search source fetch timed out after ${HOSTED_SEARCH_FETCH_TIMEOUT_MS}ms`));
      },
      HOSTED_SEARCH_FETCH_TIMEOUT_MS,
    );
  });
  try {
    return await Promise.race([urlFetcher.fetch(url, { signal: controller.signal }), timeout]);
  } finally {
    if (timeoutId !== undefined) clearTimeout(timeoutId);
  }
}

function unavailableSource(entry: SourceEntry, title: string): NormalizedHostedSearchSource {
  return {
    title,
    url: entry.url,
    snippet: '',
    snippetKind: 'unavailable',
    ...(entry.date === undefined ? {} : { date: entry.date }),
    ...(entry.siteName === undefined ? {} : { siteName: entry.siteName }),
  };
}

function sourceTitle(entry: SourceEntry): string {
  if (entry.metadataTitle !== undefined) return entry.metadataTitle;
  if (entry.citationTitle !== undefined) return entry.citationTitle;
  try {
    return new URL(entry.url).hostname || entry.url;
  } catch {
    return entry.url;
  }
}

function deriveQuery(events: readonly HostedSearchEvent[] | undefined): string | undefined {
  for (const event of events ?? []) {
    const action = event.action;
    if (action?.type !== 'search') continue;
    const query = nonEmpty(action.query);
    if (query !== undefined) return query;
    const firstQuery = action.queries?.find((item) => nonEmpty(item) !== undefined);
    if (firstQuery !== undefined) return firstQuery;
  }
  return undefined;
}

function validCitationText(
  citation: HostedSearchCitation,
  answerText: string,
): string | undefined {
  if (!Number.isSafeInteger(citation.startIndex) || !Number.isSafeInteger(citation.endIndex)) {
    return undefined;
  }
  if (citation.startIndex < 0 || citation.endIndex <= citation.startIndex) return undefined;
  if (citation.endIndex > answerText.length) return undefined;
  return answerText.slice(citation.startIndex, citation.endIndex);
}

function normalizeSourceUrl(value: string): string | undefined {
  const raw = value.trim();
  return raw.length === 0 ? undefined : raw;
}

function normalizeHttpUrl(value: string): string | undefined {
  const raw = value.trim();
  if (raw.length === 0) return undefined;
  try {
    const parsed = new URL(raw);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return undefined;
    return raw;
  } catch {
    return undefined;
  }
}

function extractSnippet(content: string, query: string | undefined): string {
  const normalized = content.replaceAll(/\s+/gu, ' ').trim();
  if (normalized.length === 0) return '';
  const queryTokens = tokenize(query ?? '');
  if (queryTokens.length === 0) return truncate(normalized, HOSTED_SEARCH_MAX_SNIPPET_CHARS);

  const sentences = normalized.split(/(?<=[.!?。！？])\s+/u).filter((sentence) => sentence.length > 0);
  let bestSentence = normalized;
  let bestScore = 0;
  for (const sentence of sentences) {
    const sentenceTokens = new Set(tokenize(sentence));
    const score = queryTokens.reduce((total, token) => total + (sentenceTokens.has(token) ? 1 : 0), 0);
    if (score > bestScore) {
      bestScore = score;
      bestSentence = sentence;
    }
  }
  if (bestScore > 0) return truncate(bestSentence, HOSTED_SEARCH_MAX_SNIPPET_CHARS);

  const firstToken = queryTokens[0]!;
  const tokenIndex = normalized.toLocaleLowerCase().indexOf(firstToken);
  if (tokenIndex >= 0) {
    const start = Math.max(0, tokenIndex - Math.floor(HOSTED_SEARCH_MAX_SNIPPET_CHARS / 3));
    return truncate(normalized.slice(start), HOSTED_SEARCH_MAX_SNIPPET_CHARS);
  }
  return truncate(normalized, HOSTED_SEARCH_MAX_SNIPPET_CHARS);
}

function tokenize(value: string): string[] {
  return value.toLocaleLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
}

function nonEmpty(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed === undefined || trimmed.length === 0 ? undefined : trimmed;
}

function truncate(value: string, maxLength: number): string {
  if (value.length <= maxLength) return value;
  return `${value.slice(0, Math.max(0, maxLength - 1)).trimEnd()}…`;
}
