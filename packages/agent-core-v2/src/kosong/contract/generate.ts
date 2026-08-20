/**
 * `kosong/contract` domain — the generation driver.
 *
 * `generate()` is the single place that orchestrates "call
 * `ChatProvider.generate` and normalize the event stream": it merges streamed
 * deltas into a complete assistant `Message`, fires the caller's callbacks,
 * enforces the abort contract (standard abort DOMException, stream cancelled
 * on abort), and rejects empty or thinking-only responses with
 * `APIEmptyResponseError`.
 */

import { APIEmptyResponseError, createAbortError } from './errors';
import {
  isContentPart,
  isHostedSearchPart,
  isToolCall,
  isToolCallPart,
  isUrlCitationPart,
  isUsagePart,
  mergeInPlace,
  type HostedSearchAction,
  type HostedSearchCitation,
  type HostedSearchEvent,
  type HostedSearchPart,
  type Message,
  type StreamedMessagePart,
  type ToolCall,
} from './message';
import type { ChatProvider, FinishReason, GenerateOptions, StreamedMessage } from './provider';
import type { Tool } from './tool';
import type { TokenUsage } from './usage';

type StoredToolCall = Omit<ToolCall, '_streamIndex'>;
type MutableMessage = Message & {
  annotations?: HostedSearchCitation[];
  searchMetadata?: HostedSearchEvent[];
};

export interface GenerateResult {
  readonly id: string | null;
  readonly message: Message;
  readonly usage: TokenUsage | null;
  readonly finishReason: FinishReason | null;
  readonly rawFinishReason: string | null;
  readonly annotations?: readonly HostedSearchCitation[];
  readonly searchMetadata?: readonly HostedSearchEvent[];
  readonly traceId?: string | null;
}

export interface GenerateCallbacks {
  onMessagePart?: (part: StreamedMessagePart) => void | Promise<void>;
  onToolCall?: (toolCall: ToolCall) => void | Promise<void>;
}

export async function generate(
  provider: ChatProvider,
  systemPrompt: string,
  tools: Tool[],
  history: Message[],
  callbacks?: GenerateCallbacks,
  options?: GenerateOptions,
): Promise<GenerateResult> {
  const message: MutableMessage = { role: 'assistant', content: [], toolCalls: [] };
  let pendingPart: StreamedMessagePart | null = null;

  const toolCallIndexMap = new Map<number | string, number>();

  if (options?.signal?.aborted) {
    throw createAbortError();
  }

  const wireTools = tools.some((tool) => tool.deferred === true)
    ? tools.filter((tool) => tool.deferred !== true)
    : tools;

  options?.onRequestStart?.();
  const stream = await provider.generate(systemPrompt, wireTools, history, options);
  if (stream.traceId !== undefined) {
    options?.onTraceId?.(stream.traceId);
  }

  await throwIfAborted(options?.signal, stream);

  let serverDecodeMs = 0;
  let clientConsumeMs = 0;
  let firstPartAt: number | undefined;
  let lastResumeAt = 0;

  for await (const part of stream) {
    const arrivedAt = Date.now();
    if (firstPartAt === undefined) {
      firstPartAt = arrivedAt;
    } else {
      serverDecodeMs += arrivedAt - lastResumeAt;
    }

    try {
      await throwIfAborted(options?.signal, stream);

      if (callbacks?.onMessagePart !== undefined) {
        await callbacks.onMessagePart(deepCopyPart(part));
        await throwIfAborted(options?.signal, stream);
      }

      if (isUsagePart(part)) continue;

      if (
        isToolCallPart(part) &&
        part.index !== undefined &&
        !isPendingToolCallAtIndex(pendingPart, part.index)
      ) {
        const arrayIdx = toolCallIndexMap.get(part.index);
        if (arrayIdx !== undefined) {
          const target = message.toolCalls[arrayIdx];
          if (target !== undefined && part.argumentsPart !== null) {
            target.arguments =
              target.arguments === null
                ? part.argumentsPart
                : target.arguments + part.argumentsPart;
          }
          continue;
        }
      }

      if (pendingPart === null) {
        pendingPart = part;
      } else if (!mergeInPlace(pendingPart, part)) {
        flushPart(message, pendingPart, toolCallIndexMap);
        pendingPart = part;
      }
    } finally {
      lastResumeAt = Date.now();
      clientConsumeMs += lastResumeAt - arrivedAt;
    }
  }

  await throwIfAborted(options?.signal, stream);
  if (firstPartAt !== undefined) {
    serverDecodeMs += Date.now() - lastResumeAt;
  }
  options?.onStreamEnd?.(
    firstPartAt === undefined ? undefined : { serverDecodeMs, clientConsumeMs },
  );

  if (pendingPart !== null) {
    flushPart(message, pendingPart, toolCallIndexMap);
  }
  if (stream.annotations !== undefined) {
    for (const citation of stream.annotations) {
      appendUniqueCitation((message.annotations ??= []), citation);
    }
  }
  if (stream.searchMetadata !== undefined) {
    for (const event of stream.searchMetadata) {
      appendHostedSearchEvent((message.searchMetadata ??= []), event);
    }
  }
  if (message.content.length === 0 && message.toolCalls.length === 0) {
    throw new APIEmptyResponseError(
      'The API returned an empty response (no content, no tool calls).' +
        formatFinishReasonHint(stream) +
        ` Provider: ${provider.name}, model: ${provider.modelName}`,
      {
        finishReason: stream.finishReason,
        rawFinishReason: stream.rawFinishReason,
      },
    );
  }

  const hasThink = message.content.some((p) => p.type === 'think');
  const hasText = message.content.some((p) => p.type === 'text' && p.text.trim().length > 0);
  const hasToolCalls = message.toolCalls.length > 0;

  if (hasThink && !hasText && !hasToolCalls) {
    throw new APIEmptyResponseError(
      'The API returned a response containing only thinking content ' +
        'without any text or tool calls. This usually indicates the ' +
        'stream was interrupted or the output token budget was exhausted ' +
        'during reasoning.' +
        formatFinishReasonHint(stream) +
        ` Provider: ${provider.name}, model: ${provider.modelName}`,
      {
        finishReason: stream.finishReason,
        rawFinishReason: stream.rawFinishReason,
      },
    );
  }

  if (callbacks?.onToolCall !== undefined) {
    for (const toolCall of message.toolCalls) {
      await throwIfAborted(options?.signal, stream);
      await callbacks.onToolCall(toolCall);
    }
  }

  const result: GenerateResult = {
    id: stream.id,
    message,
    usage: stream.usage,
    finishReason: stream.finishReason,
    rawFinishReason: stream.rawFinishReason,
    annotations: message.annotations,
    searchMetadata: message.searchMetadata,
  };
  if (stream.traceId !== undefined) {
    return { ...result, traceId: stream.traceId };
  }
  return result;
}

type CancelableStream = StreamedMessage & {
  cancel?: () => unknown;
  return?: () => unknown;
};

async function cancelStream(stream: StreamedMessage): Promise<void> {
  const cancelable = stream as CancelableStream;

  try {
    await cancelable.cancel?.();
  } catch {}

  try {
    await cancelable.return?.();
  } catch {}
}

async function throwIfAborted(signal?: AbortSignal, stream?: StreamedMessage): Promise<void> {
  if (!signal?.aborted) {
    return;
  }

  if (stream !== undefined) {
    await cancelStream(stream);
  }

  throw createAbortError();
}

function isPendingToolCallAtIndex(
  pending: StreamedMessagePart | null,
  index: number | string,
): pending is ToolCall {
  return pending !== null && isToolCall(pending) && pending._streamIndex === index;
}

function flushPart(
  message: MutableMessage,
  part: StreamedMessagePart,
  toolCallIndexMap: Map<number | string, number>,
): void {
  if (isContentPart(part)) {
    message.content.push(part);
    return;
  }
  if (isToolCall(part)) {
    const streamIndex = part._streamIndex;
    const stored: StoredToolCall = {
      type: 'function',
      id: part.id,
      name: part.name,
      arguments: part.arguments,
      extras: part.extras,
    };
    const ordinal = message.toolCalls.length;
    message.toolCalls.push(stored as ToolCall);
    if (streamIndex !== undefined) {
      toolCallIndexMap.set(streamIndex, ordinal);
    }
    return;
  }
  if (isUrlCitationPart(part)) {
    appendUniqueCitation((message.annotations ??= []), part);
    return;
  }
  if (isHostedSearchPart(part)) {
    appendHostedSearchEvent((message.searchMetadata ??= []), hostedSearchPartToEvent(part));
  }
}

function appendUniqueCitation(
  citations: HostedSearchCitation[],
  citation: HostedSearchCitation,
): void {
  if (
    citations.some(
      (candidate) =>
        candidate.url === citation.url &&
        candidate.startIndex === citation.startIndex &&
        candidate.endIndex === citation.endIndex,
    )
  ) {
    return;
  }
  citations.push(citation);
}

function appendHostedSearchEvent(events: HostedSearchEvent[], event: HostedSearchEvent): void {
  if (
    events.some(
      (candidate) =>
        candidate.callId === event.callId &&
        candidate.status === event.status &&
        JSON.stringify(candidate.action) === JSON.stringify(event.action) &&
        JSON.stringify(candidate.sources) === JSON.stringify(event.sources),
    )
  ) {
    return;
  }
  events.push(event);
}

function hostedSearchPartToEvent(part: HostedSearchPart): HostedSearchEvent {
  const event: HostedSearchEvent = {};
  if (part.callId !== undefined) event.callId = part.callId;
  if (part.type === 'hosted_search_source') event.sources = [part.source];
  if (part.type === 'hosted_search_action') event.action = part.action;
  if (part.type === 'hosted_search_lifecycle') {
    event.status = part.status;
    if (part.action !== undefined) event.action = part.action;
    if (part.sources !== undefined) event.sources = part.sources;
  }
  return event;
}

function formatFinishReasonHint(stream: StreamedMessage): string {
  if (stream.finishReason === null && stream.rawFinishReason === null) return '';

  const raw =
    stream.rawFinishReason === null ? '' : `, rawFinishReason=${stream.rawFinishReason}`;
  const filteredHint =
    stream.finishReason === 'filtered'
      ? ' The provider filtered the response before visible output was emitted.'
      : '';

  return ` Provider stop details: finishReason=${stream.finishReason ?? 'unknown'}${raw}.${filteredHint}`;
}

/**
 * Produce a copy of a StreamedMessagePart that the onMessagePart callback can
 * freely mutate without aliasing the stream's own part objects.
 *
 * Hot path: this runs once per streamed chunk, so it avoids structuredClone's
 * generic-object-graph machinery and instead copies each part type by hand.
 * Strings/numbers/null are immutable and copied by reference; nested objects
 * (`imageUrl`/`audioUrl`/`videoUrl`, `usage`, `extras`) are copied to the
 * depth callbacks actually mutate: media payloads one level, `extras` fully
 * recursive (callbacks have been observed mutating `extras.metadata.*` and
 * pushing into `extras.tags`).
 *
 * Mirrors `packages/kosong/src/generate.ts` — keep the two copies in sync.
 */
function deepCopyPart(part: StreamedMessagePart): StreamedMessagePart {
  switch (part.type) {
    case 'text':
      return { type: 'text', text: part.text };
    case 'think':
      return { type: 'think', think: part.think, encrypted: part.encrypted };
    case 'image_url':
      return { type: 'image_url', imageUrl: { ...part.imageUrl } };
    case 'audio_url':
      return { type: 'audio_url', audioUrl: { ...part.audioUrl } };
    case 'video_url':
      return { type: 'video_url', videoUrl: { ...part.videoUrl } };
    case 'function':
      return {
        type: 'function',
        id: part.id,
        name: part.name,
        arguments: part.arguments,
        extras: part.extras === undefined ? undefined : deepCopyExtras(part.extras),
        _streamIndex: part._streamIndex,
      };
    case 'tool_call_part':
      return { type: 'tool_call_part', argumentsPart: part.argumentsPart, index: part.index };
    case 'usage':
      return { type: 'usage', usage: { ...part.usage } };
    case 'url_citation':
      return { ...part };
    case 'hosted_search_source':
      return { ...part, source: { ...part.source } };
    case 'hosted_search_action':
      return { ...part, action: deepCopyHostedSearchAction(part.action) };
    case 'hosted_search_lifecycle':
      return {
        ...part,
        action:
          part.action === undefined ? undefined : deepCopyHostedSearchAction(part.action),
        sources: part.sources?.map((source) => ({ ...source })),
      };
  }
}

function deepCopyHostedSearchAction(action: HostedSearchAction): HostedSearchAction {
  if (action.type === 'search') {
    return {
      ...action,
      queries: action.queries === undefined ? undefined : [...action.queries],
      sources: action.sources?.map((source) => ({ ...source })),
    };
  }
  return { ...action };
}

/** Recursive copy of a ToolCall `extras` record (plain objects and arrays). */
function deepCopyExtras(extras: Record<string, unknown>): Record<string, unknown> {
  const copy: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(extras)) {
    copy[key] = deepCopyExtrasValue(value);
  }
  return copy;
}

function deepCopyExtrasValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(deepCopyExtrasValue);
  }
  if (typeof value === 'object' && value !== null) {
    return deepCopyExtras(value as Record<string, unknown>);
  }
  return value;
}
