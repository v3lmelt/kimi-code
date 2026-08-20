import type {
  HostedSearchAction,
  HostedSearchCitation,
  HostedSearchEvent,
  HostedSearchSource,
} from '@moonshot-ai/kimi-code-sdk';

import type { HostedSearchTranscriptData } from '../types';

export function canonicalHostedSearchUrl(url: string): string {
  return url.trim();
}

export function canonicalHostedSearchCallId(callId: string | undefined): string | undefined {
  const canonical = callId?.trim();
  return canonical === undefined || canonical.length === 0 ? undefined : canonical;
}

export function canonicalHostedSearchAction(action: HostedSearchAction): HostedSearchAction {
  switch (action.type) {
    case 'search':
      return action;
    case 'open_page':
      return {
        ...action,
        url: action.url === undefined ? undefined : canonicalHostedSearchUrl(action.url),
      };
    case 'find_in_page':
      return {
        ...action,
        url: action.url === undefined ? undefined : canonicalHostedSearchUrl(action.url),
      };
  }
}

export function hostedSearchEventKey(event: HostedSearchEvent): string {
  return `${String(event.turnId)}:${String(event.step)}:${canonicalHostedSearchCallId(event.callId) ?? ''}`;
}

export function hostedSearchGroupKey(turnId: string | number, step: number): string {
  return `${String(turnId)}:${String(step)}`;
}

export function hostedSearchActionKey(action: HostedSearchAction): string {
  const canonicalAction = canonicalHostedSearchAction(action);
  switch (canonicalAction.type) {
    case 'search':
      return `search:${canonicalAction.query?.trim() ?? ''}:${(canonicalAction.queries ?? [])
        .map((query) => query.trim())
        .join('\u0000')}`;
    case 'open_page':
      return `open_page:${canonicalAction.url ?? ''}`;
    case 'find_in_page':
      return `find_in_page:${canonicalAction.url ?? ''}:${canonicalAction.pattern ?? ''}`;
  }
}

export function createHostedSearchTranscriptData(
  event: HostedSearchEvent,
  identity = hostedSearchEventKey(event),
): HostedSearchTranscriptData {
  const data: HostedSearchTranscriptData = {
    identity,
    callId: canonicalHostedSearchCallId(event.callId),
    turnId: String(event.turnId),
    step: event.step,
    version: 0,
    phase: event.phase,
    status: event.status,
    query: event.query,
    actions: [],
    sources: [],
    citations: [],
  };
  mergeHostedSearchEvent(data, event);
  return data;
}

const actionKey = hostedSearchActionKey;

export function isValidHostedSearchCitation(citation: HostedSearchCitation): boolean {
  const url = canonicalHostedSearchUrl(citation.url);
  return (
    url.length > 0 &&
    Number.isSafeInteger(citation.startIndex) &&
    Number.isSafeInteger(citation.endIndex) &&
    citation.startIndex >= 0 &&
    citation.endIndex > citation.startIndex
  );
}

function mergeSource(previous: HostedSearchSource, next: HostedSearchSource): HostedSearchSource {
  const snippet =
    next.snippet !== undefined && next.snippet.length > 0
      ? next.snippet
      : previous.snippet;
  return {
    // Keep the latest non-empty presentation fields, but always expose the
    // canonical URL used by every merge and citation lookup.
    url: canonicalHostedSearchUrl(next.url),
    title: next.title ?? previous.title,
    snippet,
    cited: previous.cited === true || next.cited === true ? true : next.cited ?? previous.cited,
    citationText: next.citationText ?? previous.citationText,
    snippetKind: next.snippetKind ?? previous.snippetKind,
    date: next.date ?? previous.date,
    siteName: next.siteName ?? previous.siteName,
  };
}

export function upsertHostedSearchSource(
  target: HostedSearchSource[],
  source: HostedSearchSource,
): void {
  const canonicalUrl = canonicalHostedSearchUrl(source.url);
  if (canonicalUrl.length === 0) return;
  const index = target.findIndex(
    (candidate) => canonicalHostedSearchUrl(candidate.url) === canonicalUrl,
  );
  if (index < 0) {
    target.push({ ...source, url: canonicalUrl });
    return;
  }
  target[index] = mergeSource(target[index]!, source);
}

export function upsertHostedSearchCitation(
  target: HostedSearchCitation[],
  citation: HostedSearchCitation,
): boolean {
  if (!isValidHostedSearchCitation(citation)) return false;
  const canonicalUrl = canonicalHostedSearchUrl(citation.url);
  const index = target.findIndex(
    (candidate) =>
      canonicalHostedSearchUrl(candidate.url) === canonicalUrl &&
      candidate.startIndex === citation.startIndex &&
      candidate.endIndex === citation.endIndex,
  );
  if (index < 0) {
    target.push({ ...citation, url: canonicalUrl });
    return true;
  }
  target[index] = {
    ...target[index],
    ...citation,
    url: canonicalUrl,
    citationText: citation.citationText ?? target[index]!.citationText,
    title: citation.title ?? target[index]!.title,
  };
  return true;
}

export function reorderHostedSearchSources(data: HostedSearchTranscriptData): void {
  const citedOrder = new Map<string, number>();
  for (const citation of data.citations) {
    const url = canonicalHostedSearchUrl(citation.url);
    if (!citedOrder.has(url)) citedOrder.set(url, citedOrder.size);
  }
  const citedCount = citedOrder.size;
  data.sources = data.sources
    .map((source, index) => ({ source, index }))
    .toSorted((left, right) => {
      const leftUrl = canonicalHostedSearchUrl(left.source.url);
      const rightUrl = canonicalHostedSearchUrl(right.source.url);
      const leftCitationOrder = citedOrder.get(leftUrl);
      const rightCitationOrder = citedOrder.get(rightUrl);
      const leftRank =
        leftCitationOrder ?? (left.source.cited === true ? citedCount : Number.POSITIVE_INFINITY);
      const rightRank =
        rightCitationOrder ?? (right.source.cited === true ? citedCount : Number.POSITIVE_INFINITY);
      if (leftRank < rightRank) return -1;
      if (leftRank > rightRank) return 1;
      if (leftCitationOrder !== undefined && rightCitationOrder !== undefined) {
        if (leftCitationOrder < rightCitationOrder) return -1;
        if (leftCitationOrder > rightCitationOrder) return 1;
      }
      // Keep the provider's order for sources with the same citation rank.
      return left.index - right.index;
    })
    .map(({ source }) => source);
}

const HOSTED_SEARCH_PHASE_RANK: Record<HostedSearchEvent['phase'], number> = {
  started: 0,
  action: 1,
  source: 2,
  completed: 3,
};

const HOSTED_SEARCH_STATUS_RANK: Record<NonNullable<HostedSearchEvent['status']>, number> = {
  in_progress: 0,
  searching: 1,
  completed: 2,
  failed: 2,
};

function mergeHostedSearchStatus(
  current: HostedSearchTranscriptData['status'],
  next: HostedSearchEvent['status'],
): HostedSearchTranscriptData['status'] {
  if (next === undefined) return current;
  if (current === 'completed' || current === 'failed') return current;
  if (current === undefined) return next;
  return HOSTED_SEARCH_STATUS_RANK[next] >= HOSTED_SEARCH_STATUS_RANK[current] ? next : current;
}

export function mergeHostedSearchEvent(
  data: HostedSearchTranscriptData,
  event: HostedSearchEvent,
): void {
  data.version += 1;
  const callId = canonicalHostedSearchCallId(event.callId);
  if (callId !== undefined) data.callId = callId;
  if (HOSTED_SEARCH_PHASE_RANK[event.phase] > HOSTED_SEARCH_PHASE_RANK[data.phase]) {
    data.phase = event.phase;
  }
  data.status = mergeHostedSearchStatus(data.status, event.status);
  if (event.query !== undefined) data.query = event.query;
  const action = event.action === undefined ? undefined : canonicalHostedSearchAction(event.action);
  if (action?.type === 'search') {
    if (data.query === undefined && action.query !== undefined) {
      data.query = action.query;
    }
  }

  if (action !== undefined) {
    const key = actionKey(action);
    if (!data.actions.some((candidate) => actionKey(candidate) === key)) {
      data.actions.push({ ...action });
    }
  }

  for (const source of event.sources ?? []) {
    upsertHostedSearchSource(data.sources, source);
  }
  if (action?.type === 'search') {
    for (const source of action.sources ?? []) {
      upsertHostedSearchSource(data.sources, source);
    }
  }
  for (const citation of event.citations ?? []) {
    if (!upsertHostedSearchCitation(data.citations, citation)) continue;
    upsertHostedSearchSource(data.sources, {
      url: citation.url,
      title: citation.title,
      cited: true,
      citationText: citation.citationText,
      snippet: citation.citationText,
      snippetKind: 'citation',
    });
  }
  reorderHostedSearchSources(data);
}

export function hostedSearchCitationSignature(
  citations: readonly HostedSearchCitation[],
  sources: readonly HostedSearchSource[] = [],
): string {
  const sourceUrls = sources.map((source) => canonicalHostedSearchUrl(source.url)).join('|');
  const ranges = citations
    .map(
      (citation) =>
        `${canonicalHostedSearchUrl(citation.url)}:${String(citation.startIndex)}:${String(citation.endIndex)}`,
    )
    .join('|');
  return `${sourceUrls}::${ranges}`;
}

function citationNumbers(
  citations: readonly HostedSearchCitation[],
  sources: readonly HostedSearchSource[],
): Map<string, number> {
  const numbers = new Map<string, number>();
  for (const citation of citations) {
    const url = canonicalHostedSearchUrl(citation.url);
    if (url.length > 0 && !numbers.has(url)) numbers.set(url, numbers.size + 1);
  }
  for (const source of sources) {
    const url = canonicalHostedSearchUrl(source.url);
    if (url.length > 0 && !numbers.has(url)) numbers.set(url, numbers.size + 1);
  }
  return numbers;
}

interface PreparedCitation {
  readonly citation: HostedSearchCitation;
  readonly start: number;
  readonly end: number;
  readonly ordinal: number;
}

function prepareCitations(
  text: string,
  citations: readonly HostedSearchCitation[],
  sourceOffset: number,
): PreparedCitation[] {
  const offset = Number.isInteger(sourceOffset) && sourceOffset >= 0 ? sourceOffset : 0;
  const candidates: PreparedCitation[] = [];
  citations.forEach((citation, ordinal) => {
    if (!isValidHostedSearchCitation(citation)) return;
    const start = citation.startIndex - offset;
    const end = citation.endIndex - offset;
    if (start < 0 || end > text.length || start >= end) return;
    candidates.push({ citation, start, end, ordinal });
  });

  const accepted: PreparedCitation[] = [];
  const seen = new Set<string>();
  let lastEnd = -1;
  for (const candidate of candidates.toSorted(
    (a, b) => a.start - b.start || a.end - b.end || a.ordinal - b.ordinal,
  )) {
    const key = `${canonicalHostedSearchUrl(candidate.citation.url)}:${String(candidate.start)}:${String(candidate.end)}`;
    if (seen.has(key) || candidate.start < lastEnd) continue;
    seen.add(key);
    accepted.push(candidate);
    lastEnd = candidate.end;
  }
  return accepted;
}

/** Return only citations that can be projected into the supplied text. */
export function filterHostedSearchCitations(
  text: string,
  citations: readonly HostedSearchCitation[],
  sourceOffset = 0,
): HostedSearchCitation[] {
  return prepareCitations(text, citations, sourceOffset).map(({ citation }) => citation);
}

/**
 * Adds display-only Markdown links for `[n]` markers at annotation end
 * offsets. The caller keeps the original assistant text in the transcript
 * entry; this is strictly a render projection and therefore cannot affect the
 * next model request. Markdown renders the link as OSC 8 when the terminal
 * supports it and keeps the URL as a plain-text fallback otherwise.
 */
export function decorateAssistantTextWithCitations(
  text: string,
  citations: readonly HostedSearchCitation[],
  sources: readonly HostedSearchSource[] = [],
  sourceOffset = 0,
): string {
  if (text.length === 0 || citations.length === 0) return text;
  const prepared = prepareCitations(text, citations, sourceOffset);
  if (prepared.length === 0) return text;
  const numbers = citationNumbers(
    prepared.map(({ citation }) => citation),
    sources,
  );
  const insertions = prepared.map(({ citation, end, ordinal }) => {
    const url = canonicalHostedSearchUrl(citation.url);
    const number = numbers.get(url);
    return {
      end,
      ordinal,
      marker: number === undefined ? '' : ` [[${String(number)}]](<${url}>)`,
    };
  });

  let decorated = text;
  insertions
    .toSorted((a, b) => b.end - a.end || b.ordinal - a.ordinal)
    .forEach(({ end, marker }) => {
      if (marker.length > 0) decorated = `${decorated.slice(0, end)}${marker}${decorated.slice(end)}`;
    });
  return decorated;
}
