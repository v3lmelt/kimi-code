/**
 * v1-compatible message history — the loader behind
 * `GET /api/v1/sessions/{sid}/messages[/{mid}]`, served from the server layer
 * on top of the engine's native services (moved out of the engine's deleted
 * `messageLegacy` edge adapter).
 *
 * History is streamed from the main agent's append log after its pending wire
 * writes are flushed. The journal is folded incrementally by the shared
 * transcript reducer, keeping full history across compactions (inserting a
 * summary marker instead of folding) — unlike the live
 * `IAgentContextMemoryService.get()`, whose folded context collapses into
 * `[...keptUserMessages, compaction_summary]` and would lose the prefix.
 * `foldedLength` is what the live history length WOULD be from the journal's
 * records; because the journal can trail the live context by a record within a
 * single dispatch, anything beyond it is appended as the unflushed tail.
 * Pagination, id derivation, and the role filter mirror the legacy v1
 * semantics.
 *
 * Read-path caching (perf Top 5): a per-agent incremental fold cache keeps
 * the journal fold state across requests — a new request only pulls the
 * bytes appended since the last one (`readFrom` offset read) and folds those
 * records. The reducer is a deterministic sequential state machine, so
 * "fold the first N records, then keep folding N..M" is strictly equivalent
 * to folding all M; undo/clear are journal records too and replay naturally
 * through the incremental fold. A journal rewrite that shrank the log below
 * the cached byte offset invalidates the cache and triggers a full rebuild.
 * The projected message array is cached alongside (blob refs are
 * immutable after offload), and pagination resolves cursor ids from the
 * `msg_<session>_<index>` id formula in O(1) instead of a full reverse +
 * linear scan.
 */

import {
  AGENT_WIRE_RECORD_KEY,
  IAgentBlobService,
  IAgentContextMemoryService,
  IAgentScopeContext,
  IAppendLogStore,
  ISessionIndex,
  IWireService,
  createContextTranscriptReducer,
  ensureMainAgent,
  resumeSessionById,
  type ContextMessage,
  type ContextTranscript,
  type ContextTranscriptReducer,
  type IAgentScopeHandle,
  type Scope,
  type WireRecord,
} from '@moonshot-ai/agent-core-v2';

import type { Message, MessageRole } from '../../protocol/message';
import { toProtocolMessage } from './messageProjection';

const DEFAULT_PAGE_SIZE = 50;
const MAX_PAGE_SIZE = 100;

/**
 * Per-agent journal fold + projection cache (see header comment).
 */
interface MessageHistoryCacheEntry {
  /** Fold state machine — keeps folding across requests. */
  readonly reducer: ContextTranscriptReducer;
  /** Number of journal records folded so far. */
  foldedRecords: number;
  /** Byte offset just past the last folded line — the next read resumes here. */
  nextByte: number;
  /** Last `reducer.result()` — reference identity signals projection reuse. */
  folded: ContextTranscript | undefined;
  /** Projection of the folded entries (blob-rehydrated, clamped). */
  projectedFold: readonly Message[] | undefined;
}

const historyCache = new Map<string, MessageHistoryCacheEntry>();
/** Per-key serialization so concurrent requests never double-fold a record. */
const foldLocks = new Map<string, Promise<void>>();

function foldLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const prev = foldLocks.get(key) ?? Promise.resolve();
  const run = prev.catch(() => undefined).then(fn);
  foldLocks.set(key, run.then(() => undefined, () => undefined));
  return run;
}

/** Sentinel — the route maps it to 40401. */
export class SessionNotFoundError extends Error {
  readonly sessionId: string;
  constructor(sessionId: string) {
    super(`session ${sessionId} does not exist`);
    this.name = 'SessionNotFoundError';
    this.sessionId = sessionId;
  }
}

/** Sentinel — the route maps it to 40403. */
export class MessageNotFoundError extends Error {
  readonly sessionId: string;
  readonly messageId: string;
  constructor(sessionId: string, messageId: string) {
    super(`message ${messageId} does not exist in session ${sessionId}`);
    this.name = 'MessageNotFoundError';
    this.sessionId = sessionId;
    this.messageId = messageId;
  }
}

export interface MessageListQuery {
  readonly before_id?: string | undefined;
  readonly after_id?: string | undefined;
  readonly page_size?: number | undefined;
  readonly role?: MessageRole | undefined;
}

export interface PageResponse<T> {
  items: T[];
  has_more: boolean;
}

/**
 * Resolve a cursor message id to its ascending index in `all`. Ids minted by
 * `deriveMessageId` (`msg_<sessionId>_<padded>`) resolve by formula in O(1);
 * anything else falls back to a linear scan. Returns -1 when absent — the
 * route treats an unknown cursor as "no cursor" (page from the top), matching
 * the historical `findIndex` behavior.
 */
function resolvePivotIndex(all: readonly Message[], id: string, sessionId: string): number {
  const prefix = `msg_${sessionId}_`;
  if (id.startsWith(prefix)) {
    const idx = Number(id.slice(prefix.length));
    if (Number.isInteger(idx) && idx >= 0 && idx < all.length && all[idx]!.id === id) {
      return idx;
    }
  }
  return all.findIndex((m) => m.id === id);
}

export async function listMessages(
  core: Scope,
  sessionId: string,
  query: MessageListQuery,
): Promise<PageResponse<Message>> {
  const all = await loadMessages(core, sessionId);
  const n = all.length;

  const requestedSize = query.page_size ?? DEFAULT_PAGE_SIZE;
  const pageSize = Math.min(Math.max(requestedSize, 1), MAX_PAGE_SIZE);

  let pivotAsc = -1;
  let mode: 'before' | 'after' | 'none' = 'none';
  if (query.before_id !== undefined) {
    pivotAsc = resolvePivotIndex(all, query.before_id, sessionId);
    mode = pivotAsc >= 0 ? 'before' : 'none';
  } else if (query.after_id !== undefined) {
    pivotAsc = resolvePivotIndex(all, query.after_id, sessionId);
    mode = pivotAsc >= 0 ? 'after' : 'none';
  }

  // Window selection on the ascending array, reversed — equivalent to the
  // historical `[...all].reverse()` + `slice(pivot + 1)` / `slice(0, pivot)`
  // but only touches the page-sized window instead of the whole array.
  let page: Message[];
  let hasMore: boolean;
  if (mode === 'before') {
    const start = Math.max(0, pivotAsc - pageSize);
    page = all.slice(start, pivotAsc).reverse();
    hasMore = pivotAsc > pageSize;
  } else if (mode === 'after') {
    const end = Math.min(n, pivotAsc + 1 + pageSize);
    page = all.slice(pivotAsc + 1, end).reverse();
    hasMore = n - pivotAsc - 1 > pageSize;
  } else {
    const start = Math.max(0, n - pageSize);
    page = all.slice(start, n).reverse();
    hasMore = n > pageSize;
  }

  const filtered = query.role !== undefined ? page.filter((m) => m.role === query.role) : page;

  return { items: filtered, has_more: hasMore };
}

export async function getMessage(
  core: Scope,
  sessionId: string,
  messageId: string,
): Promise<Message> {
  const all = await loadMessages(core, sessionId);
  const entry = all.find((m) => m.id === messageId);
  if (entry === undefined) {
    throw new MessageNotFoundError(sessionId, messageId);
  }
  return entry;
}

async function loadMessages(core: Scope, sessionId: string): Promise<Message[]> {
  const summary = await core.accessor.get(ISessionIndex).get(sessionId);
  if (summary === undefined) {
    throw new SessionNotFoundError(sessionId);
  }

  const session = await resumeSessionById(core.accessor, sessionId);
  if (session === undefined) return [];
  const agent = await ensureMainAgent(session);

  return loadMessageHistory(core, agent, sessionId, summary.createdAt);
}

/**
 * One agent's full, ascending, projected message history: the persisted
 * journal (flushed first) folded by the transcript reducer, the unflushed
 * live tail merged in, blob references rehydrated, and timestamps clamped
 * strictly increasing. Shared by the `messages` routes and the `snapshot`
 * route so all history-serving surfaces agree.
 *
 * The folded prefix and its projection are cached per agent (see the header
 * comment); only the live tail is re-projected per call.
 */
export async function loadMessageHistory(
  core: Scope,
  agent: IAgentScopeHandle,
  sessionId: string,
  sessionCreatedAtMs: number,
): Promise<Message[]> {
  const key = agent.accessor.get(IAgentScopeContext).scope();
  // Snapshot the fold version BEFORE reading: readTranscript updates the
  // cache entry, so comparing after the call can never see a change.
  const foldBefore = historyCache.get(key)?.folded;
  const transcript = await readTranscript(core, agent);
  const entry = historyCache.get(key);
  if (entry === undefined) {
    // Unreachable — readTranscript always registers the entry before returning.
    return projectRange(agent, sessionId, sessionCreatedAtMs, [], [], 0, Number.NEGATIVE_INFINITY);
  }

  const contextMessages = agent.accessor.get(IAgentContextMemoryService).get();
  const merged = mergeLiveTail(transcript, contextMessages);
  const foldCount = transcript.entries.length;

  // Re-project the folded prefix only when the fold result actually changed
  // (new records or an undo/clear rewound it).
  let fold = entry.projectedFold;
  if (fold === undefined || foldBefore !== transcript) {
    fold = await projectRange(
      agent,
      sessionId,
      sessionCreatedAtMs,
      merged.messages.slice(0, foldCount),
      merged.times.slice(0, foldCount),
      0,
      Number.NEGATIVE_INFINITY,
    );
    entry.projectedFold = fold;
  }
  if (merged.messages.length <= foldCount) return [...fold];

  // Live tail (unflushed last message) — small, always re-projected. Its
  // first timestamp clamps against the folded prefix's last message.
  const previousMs =
    fold.length > 0 ? Date.parse(fold[fold.length - 1]!.created_at) : Number.NEGATIVE_INFINITY;
  const tail = await projectRange(
    agent,
    sessionId,
    sessionCreatedAtMs,
    merged.messages.slice(foldCount),
    merged.times.slice(foldCount),
    foldCount,
    previousMs,
  );
  return [...fold, ...tail];
}

/**
 * Rehydrate a message range and project it, clamping `created_at` strictly
 * increasing from `previousMs` (the last message's timestamp before the
 * range, or `-Infinity` for the range head).
 */
async function projectRange(
  agent: IAgentScopeHandle,
  sessionId: string,
  sessionCreatedAtMs: number,
  messages: readonly ContextMessage[],
  times: readonly (number | undefined)[],
  baseIndex: number,
  previousMs: number,
): Promise<Message[]> {
  const hydrated = await rehydrate(agent, messages);
  let prev = previousMs;
  return hydrated.map((msg, index) => {
    const baseMs = times[index] ?? sessionCreatedAtMs + (baseIndex + index);
    const createdAtMs = Math.max(prev + 1, baseMs);
    prev = createdAtMs;
    return toProtocolMessage(sessionId, baseIndex + index, msg, sessionCreatedAtMs, createdAtMs);
  });
}

/**
 * Replace `blobref:` media URLs with `data:` URIs read from the agent's
 * blob store (v1's `rehydrateBlobRefs`); unresolvable refs become the
 * `[media missing]` placeholder, same as v1 and live replay.
 */
async function rehydrate(
  agent: IAgentScopeHandle,
  messages: readonly ContextMessage[],
): Promise<readonly ContextMessage[]> {
  const blobs = agent.accessor.get(IAgentBlobService);
  let changed = false;
  const out: ContextMessage[] = [];
  for (const msg of messages) {
    const content = await blobs.loadParts(msg.content);
    if (content === msg.content) {
      out.push(msg);
      continue;
    }
    changed = true;
    out.push({ ...msg, content: [...content] });
  }
  return changed ? out : messages;
}

/**
 * Fold the agent's wire journal into a `ContextTranscript`, incrementally
 * across calls: records appended after the previous request's byte offset are
 * read from storage (offset-based `readFrom`, not a full re-read) and folded
 * into the cached reducer. A journal rewrite that shrank the log below the
 * cached offset forces a full rebuild. Reads are serialized per agent scope,
 * so concurrent history requests never double-fold a record. The
 * `IWireService.flush` is kept — it settles the blob-dehydration queue so
 * records appended but not yet persisted are visible to the read.
 */
async function readTranscript(core: Scope, agent: IAgentScopeHandle): Promise<ContextTranscript> {
  const key = agent.accessor.get(IAgentScopeContext).scope();
  return foldLock(key, async () => {
    await agent.accessor.get(IWireService).flush();
    const log = core.accessor.get(IAppendLogStore);
    const scope = agent.accessor.get(IAgentScopeContext).scope();

    const existing = historyCache.get(key);
    let reducer = existing?.reducer;
    let nextByte = existing?.nextByte ?? 0;
    let foldedRecords = existing?.foldedRecords ?? 0;
    let changed = existing === undefined || existing.folded === undefined;

    const delta = await log.readFrom<WireRecord>(scope, AGENT_WIRE_RECORD_KEY, nextByte);
    if (delta.truncated || reducer === undefined) {
      // First read, or the journal was rewritten shorter than our offset —
      // the cached fold no longer corresponds to the log; rebuild from 0.
      reducer = createContextTranscriptReducer();
      const full = await log.readFrom<WireRecord>(scope, AGENT_WIRE_RECORD_KEY, 0);
      for (const record of full.records) reducer.add(record);
      nextByte = full.nextByte;
      foldedRecords = full.records.length;
      changed = true;
    } else {
      for (const record of delta.records) reducer.add(record);
      nextByte = delta.nextByte;
      foldedRecords += delta.records.length;
      if (delta.records.length > 0) changed = true;
    }

    const folded = changed ? reducer.result() : existing!.folded!;
    historyCache.set(key, {
      reducer,
      foldedRecords,
      nextByte,
      folded,
      projectedFold: existing?.projectedFold,
    });
    return folded;
  });
}

function mergeLiveTail(
  transcript: ContextTranscript,
  contextMessages: readonly ContextMessage[],
): {
  readonly messages: readonly ContextMessage[];
  readonly times: readonly (number | undefined)[];
} {
  if (contextMessages.length <= transcript.foldedLength) {
    return { messages: transcript.entries, times: transcript.times };
  }
  const tail = contextMessages.slice(transcript.foldedLength);
  return {
    messages: [...transcript.entries, ...tail],
    times: [...transcript.times, ...tail.map(() => undefined)],
  };
}
