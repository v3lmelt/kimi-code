import {
  APIContextOverflowError,
  APIProviderQuotaExhaustedError,
  APIProviderRateLimitError,
  ChatProviderError,
  isContextOverflowErrorCode,
} from '#/errors';
import type {
  ContentPart,
  HostedSearchAction,
  HostedSearchCitation,
  HostedSearchEvent,
  HostedSearchLifecycle,
  HostedSearchMode,
  HostedSearchPart,
  HostedSearchSource,
  Message,
  StreamedMessagePart,
  ToolCall,
  UrlCitationPart,
} from '#/message';
import { extractText, isToolDeclarationOnlyMessage } from '#/message';
import type {
  ChatProvider,
  FinishReason,
  GenerateOptions,
  ProviderRequestAuth,
  ResponseFormat,
  StreamedMessage,
  ThinkingEffort,
} from '#/provider';
import type { Tool } from '#/tool';
import type { TokenUsage } from '#/usage';
import OpenAI from 'openai';
import { ResponsesWS } from 'openai/resources/responses/ws';

import { usesOpenAIResponsesDeveloperRole } from './capability-registry';
import {
  convertOpenAIError,
  isMediaPart,
  isOpenAIInsufficientQuotaCode,
  TOOL_RESULT_MEDIA_PLACEHOLDER,
  TOOL_RESULT_MEDIA_PROMPT,
  type ToolMessageConversion,
} from './openai-common';
import {
  mergeRequestHeaders,
  requireProviderApiKey,
  resolveAuthBackedClient,
} from './request-auth';
import {
  normalizeToolCallIdsForProvider,
  sanitizeOpenAIResponsesCallId,
  type ToolCallIdPolicy,
} from './tool-call-id';

/**
 * Normalize the Responses API status / incomplete_details into the unified
 * {@link FinishReason} enum.
 *
 * Note: the Responses API has no `tool_calls`-style status. When a response
 * completes with `function_call` items inline the status is still
 * `'completed'`; callers detect tool calls via `message.toolCalls.length`,
 * not via finishReason.
 */
function normalizeResponsesFinishReason(
  status: string | null | undefined,
  incompleteReason: string | null | undefined,
): { finishReason: FinishReason | null; rawFinishReason: string | null } {
  if (status === null || status === undefined) {
    return { finishReason: null, rawFinishReason: null };
  }
  if (status === 'completed') {
    return { finishReason: 'completed', rawFinishReason: 'completed' };
  }
  if (status === 'incomplete') {
    if (incompleteReason === 'max_output_tokens') {
      return { finishReason: 'truncated', rawFinishReason: 'max_output_tokens' };
    }
    if (incompleteReason === 'content_filter') {
      return { finishReason: 'filtered', rawFinishReason: 'content_filter' };
    }
    return {
      finishReason: 'other',
      rawFinishReason: incompleteReason ?? 'incomplete',
    };
  }
  if (status === 'failed') {
    return { finishReason: 'other', rawFinishReason: 'failed' };
  }
  return { finishReason: null, rawFinishReason: null };
}

type RawObject = Record<string, unknown>;
const OPENAI_RESPONSES_TOOL_CALL_ID_POLICY: ToolCallIdPolicy = {
  normalize: (id) => sanitizeOpenAIResponsesCallId(id, 64),
  maxLength: 64,
};

type ResponseOutputItemView =
  | {
      type: 'message';
      content: RawObject[];
    }
  | {
      type: 'function_call';
      itemId?: string;
      callId?: string;
      name?: string;
      arguments?: string | null;
    }
  | {
      type: 'reasoning';
      encryptedContent?: string;
      summary: RawObject[];
    }
  | {
      type: 'web_search_call';
      callId?: string;
      status?: HostedSearchLifecycle;
      action?: HostedSearchAction;
      sources: HostedSearchSource[];
    }
  | {
      type: 'other';
    };

function asRawObject(value: unknown): RawObject | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return null;
  }
  return value as RawObject;
}

function readStringField(object: RawObject, key: string): string | undefined {
  const value = object[key];
  return typeof value === 'string' ? value : undefined;
}

function hasOwn(object: RawObject, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(object, key);
}

function readNullableStringField(object: RawObject, key: string): string | null | undefined {
  const value = object[key];
  if (value === null) return null;
  return typeof value === 'string' ? value : undefined;
}

function readNumberField(object: RawObject, key: string): number | undefined {
  const value = object[key];
  return typeof value === 'number' ? value : undefined;
}

function readObjectField(object: RawObject, key: string): RawObject | undefined {
  return asRawObject(object[key]) ?? undefined;
}

function readObjectArrayField(object: RawObject, key: string): RawObject[] | undefined {
  const value = object[key];
  if (!Array.isArray(value)) return undefined;
  return value.flatMap((item) => {
    const objectItem = asRawObject(item);
    return objectItem === null ? [] : [objectItem];
  });
}

function readHostedSearchSource(value: unknown): HostedSearchSource | undefined {
  const source = asRawObject(value);
  if (source === null) return undefined;
  const url = readStringField(source, 'url');
  if (url === undefined || url.length === 0) return undefined;
  const result: HostedSearchSource = { url };
  if (readStringField(source, 'type') === 'url') result.type = 'url';
  const title = readStringField(source, 'title');
  if (title !== undefined) result.title = title;
  return result;
}

function readHostedSearchSources(value: unknown): HostedSearchSource[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    const source = readHostedSearchSource(item);
    return source === undefined ? [] : [source];
  });
}

function readHostedSearchAction(value: unknown): HostedSearchAction | undefined {
  const action = asRawObject(value);
  if (action === null) return undefined;
  const type = readStringField(action, 'type');
  if (type === 'search') {
    const result: Extract<HostedSearchAction, { type: 'search' }> = { type };
    const query = readStringField(action, 'query');
    if (query !== undefined) result.query = query;
    if (Array.isArray(action['queries'])) {
      result.queries = action['queries'].flatMap((item) =>
        typeof item === 'string' ? [item] : [],
      );
    }
    const sources = readHostedSearchSources(action['sources']);
    if (sources.length > 0) result.sources = sources;
    return result;
  }
  if (type === 'open_page') {
    const result: Extract<HostedSearchAction, { type: 'open_page' }> = { type };
    const url = readStringField(action, 'url');
    if (url !== undefined) result.url = url;
    return result;
  }
  if (type === 'find_in_page') {
    const result: Extract<HostedSearchAction, { type: 'find_in_page' }> = { type };
    const url = readStringField(action, 'url');
    if (url !== undefined) result.url = url;
    const pattern = readStringField(action, 'pattern');
    if (pattern !== undefined) result.pattern = pattern;
    return result;
  }
  return undefined;
}

function readHostedSearchLifecycle(value: unknown): HostedSearchLifecycle | undefined {
  const status = typeof value === 'string' ? value : undefined;
  return status === 'in_progress' ||
    status === 'searching' ||
    status === 'completed' ||
    status === 'failed'
    ? status
    : undefined;
}

function readUrlCitation(value: unknown): UrlCitationPart | undefined {
  const annotation = asRawObject(value);
  if (annotation === null || annotation['type'] !== 'url_citation') return undefined;
  const url = readStringField(annotation, 'url');
  const startIndex = readNumberField(annotation, 'start_index');
  const endIndex = readNumberField(annotation, 'end_index');
  if (url === undefined || startIndex === undefined || endIndex === undefined) return undefined;
  const result: UrlCitationPart = { type: 'url_citation', startIndex, endIndex, url };
  const title = readStringField(annotation, 'title');
  if (title !== undefined) result.title = title;
  return result;
}

function readCitations(value: unknown): UrlCitationPart[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((annotation) => {
    const citation = readUrlCitation(annotation);
    return citation === undefined ? [] : [citation];
  });
}

function readOutputTextCitations(contentItem: RawObject): UrlCitationPart[] {
  return readCitations(contentItem['annotations']);
}

function failResponsesDecode(context: string, detail: string): never {
  throw new ChatProviderError(`OpenAI Responses decode error: ${context} ${detail}`);
}

function requireStringField(object: RawObject, key: string, context: string): string {
  const value = readStringField(object, key);
  if (value === undefined) {
    failResponsesDecode(`${context}.${key}`, 'must be a string.');
  }
  return value;
}

function requireObjectField(object: RawObject, key: string, context: string): RawObject {
  const value = readObjectField(object, key);
  if (value === undefined) {
    failResponsesDecode(`${context}.${key}`, 'must be an object.');
  }
  return value;
}

function readResponseOutputItem(
  value: unknown,
  context: string,
): ResponseOutputItemView {
  const item = asRawObject(value);
  if (item === null) {
    failResponsesDecode(context, 'must be an object.');
  }

  const type = requireStringField(item, 'type', context);

  if (type === 'message') {
    return {
      type,
      content: readObjectArrayField(item, 'content') ?? [],
    };
  }

  if (type === 'function_call') {
    return {
      type,
      itemId: readStringField(item, 'id'),
      callId: readStringField(item, 'call_id'),
      name: readStringField(item, 'name'),
      arguments: readNullableStringField(item, 'arguments'),
    };
  }

  if (type === 'reasoning') {
    return {
      type,
      encryptedContent: readStringField(item, 'encrypted_content'),
      summary: readObjectArrayField(item, 'summary') ?? [],
    };
  }

  if (type === 'web_search_call') {
    const action = readHostedSearchAction(item['action']);
    const actionObject = readObjectField(item, 'action');
    const sources = readHostedSearchSources(actionObject?.['sources'] ?? item['sources']);
    const result: Extract<ResponseOutputItemView, { type: 'web_search_call' }> = {
      type,
      sources,
    };
    const callId = readStringField(item, 'id');
    if (callId !== undefined) result.callId = callId;
    const status = readHostedSearchLifecycle(item['status']);
    if (status !== undefined) result.status = status;
    if (action !== undefined) result.action = action;
    return result;
  }

  return { type: 'other' };
}

function responseStreamIndex(
  itemId: string | undefined,
  outputIndex: number | undefined,
): string | number | undefined {
  return itemId ?? outputIndex;
}

function formatResponseStreamIndex(streamIndex: string | number | undefined): string {
  return streamIndex === undefined ? '<unindexed>' : String(streamIndex);
}

function requireFunctionCallName(item: { name?: string }): string {
  if (item.name === undefined) {
    throw new ChatProviderError('OpenAI Responses function_call item is missing a name.');
  }
  return item.name;
}

function functionCallId(callId: string | undefined): string {
  return callId === undefined || callId.length === 0 ? crypto.randomUUID() : callId;
}

function formatResponsesErrorEvent(
  code: string | null,
  message: string,
  param: string | null,
): string {
  const codeText = code ?? 'unknown';
  const paramText = param === null ? '' : ` (param: ${param})`;
  return `${codeText}: ${message}${paramText}`;
}

const EMBEDDED_STATUS_CODE_RE = /\bstatus_code\s*[:=]\s*(\d{3})\b/;

function readEmbeddedStatusCode(message: string): number | undefined {
  const match = EMBEDDED_STATUS_CODE_RE.exec(message);
  return match === null ? undefined : Number(match[1]);
}

function errorFromOpenAIResponsesEvent(
  prefix: string,
  code: string | null,
  message: string,
  param: string | null,
): ChatProviderError {
  const formatted = formatResponsesErrorEvent(code, message, param);
  const fullMessage = `${prefix}: ${formatted}`;
  if (isContextOverflowErrorCode(code)) {
    return new APIContextOverflowError(400, fullMessage);
  }
  // Quota/balance exhaustion first — otherwise an `insufficient_quota` event
  // falls through to the base ChatProviderError (whose unclassified fallback
  // is retryable), and a quota message with an embedded status_code=429 would
  // classify as a retryable rate limit. Only OpenAI's own documented code is
  // recognized here; vendor-specific quota signals live with their vendor.
  if (isOpenAIInsufficientQuotaCode(code)) {
    return new APIProviderQuotaExhaustedError(fullMessage);
  }
  if (code === 'rate_limit_exceeded' || readEmbeddedStatusCode(message) === 429) {
    return new APIProviderRateLimitError(fullMessage);
  }
  return new ChatProviderError(fullMessage);
}

function parseNestedGatewayStreamError(message: string):
  | {
      code: string | null;
      message: string;
      param: string | null;
    }
  | undefined {
  const marker = 'received error while streaming:';
  const markerIndex = message.indexOf(marker);
  if (markerIndex === -1) return undefined;

  const jsonText = message.slice(markerIndex + marker.length).trim();
  if (jsonText.length === 0) return undefined;

  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonText);
  } catch {
    return undefined;
  }

  const error = asRawObject(parsed);
  if (error === null) return undefined;

  const nestedMessage = readStringField(error, 'message');
  if (nestedMessage === undefined) return undefined;

  return {
    code: readNullableStringField(error, 'code') ?? null,
    message: nestedMessage,
    param: readNullableStringField(error, 'param') ?? null,
  };
}

function malformedStreamErrorEvent(message: string): ChatProviderError {
  const nested = parseNestedGatewayStreamError(message);
  if (nested !== undefined) {
    return errorFromOpenAIResponsesEvent(
      'OpenAI Responses malformed stream error',
      nested.code,
      nested.message,
      nested.param,
    );
  }

  return errorFromOpenAIResponsesEvent(
    'OpenAI Responses malformed stream error',
    null,
    message,
    null,
  );
}

function readResponsesFailedResponseError(response: RawObject):
  | {
      code: string | null;
      message: string;
    }
  | undefined {
  const error = readObjectField(response, 'error');
  if (error !== undefined) {
    const code = readNullableStringField(error, 'code') ?? 'unknown';
    const message = readStringField(error, 'message') ?? 'no message';
    return { code, message };
  }
  return undefined;
}

function formatResponsesFailedResponse(response: RawObject): string {
  const error = readResponsesFailedResponseError(response);
  if (error !== undefined) {
    return formatResponsesErrorEvent(error.code, error.message, null);
  }

  const incompleteDetails = readObjectField(response, 'incomplete_details');
  const reason =
    incompleteDetails === undefined ? undefined : readStringField(incompleteDetails, 'reason');
  return reason === undefined
    ? 'Unknown error (no error details in response)'
    : `incomplete: ${reason}`;
}

export type HostedSearchConfig = HostedSearchMode | { readonly mode: HostedSearchMode };

export interface OpenAIResponsesOptions {
  apiKey?: string | undefined;
  baseUrl?: string | undefined;
  model: string;
  /** Hosted web search policy. Defaults to `disabled`. */
  hostedSearch?: HostedSearchConfig | undefined;
  /** Backwards-compatible spelling for {@link hostedSearch}. */
  hostedSearchMode?: HostedSearchConfig | undefined;
  /** Alias accepted by callers that name the feature after the wire tool. */
  webSearch?: HostedSearchConfig | undefined;
  /** Explicit alias for callers that prefer a `*Mode` option name. */
  webSearchMode?: HostedSearchConfig | undefined;
  maxOutputTokens?: number | undefined;
  /**
   * The effort value that encodes "thinking off" on this wire (e.g. `'none'`
   * for xai grok). When set, `withThinking('off')` sends it as
   * `reasoning_effort` instead of omitting the field — required by models
   * whose default is to reason.
   */
  offEffort?: string | undefined;
  httpClient?: unknown;
  defaultHeaders?: Record<string, string>;
  toolMessageConversion?: ToolMessageConversion | undefined;
  clientFactory?: (auth: ProviderRequestAuth) => OpenAI;
  /**
   * Construction-time free-form request kwargs (e.g. `prompt_cache_key` for
   * session affinity), merged into every request at generate time. Explicit
   * first-class options (`maxOutputTokens`) win on conflict; the
   * `withGenerationKwargs` morph layers on top of both.
   */
  generationKwargs?: OpenAIResponsesGenerationKwargs | undefined;
  /** Use the Responses API hosted tool search for deferred function tools. */
  nativeToolSearch?: boolean | undefined;
  /** Reuse a Responses WebSocket and send strict input deltas when possible. */
  responsesWebSocket?: boolean | undefined;
  /**
   * Add a stable explicit cache breakpoint after the system instructions.
   * Intended for GPT-5.6 and later models. The API currently supports a
   * single 30-minute TTL.
   */
  promptCache?: OpenAIResponsesPromptCacheOptions;
  /** Explicit model capability required when promptCache is configured. */
  supportsPromptCacheBreakpoints?: boolean;
  /** Test seam for the Responses WebSocket transport. */
  responsesWebSocketFactory?: OpenAIResponsesWebSocketFactory | undefined;
  /** ChatGPT Codex wire adjustments layered on top of the Responses API. */
  codex?: {
    readonly responsesLite?: boolean;
  };
}

export interface OpenAIResponsesPromptCacheOptions {
  /** Defaults to explicit-only caching to avoid writes for changing user input. */
  readonly mode?: 'implicit' | 'explicit';
  /** The Responses API currently supports only a 30-minute exact TTL. */
  readonly ttl?: '30m';
}

export type OpenAIResponsesWebSocketMessage =
  | { readonly type: 'connecting' | 'open' | 'closing' | 'close' }
  | { readonly type: 'message'; readonly message: Record<string, unknown> }
  | { readonly type: 'error'; readonly error: unknown };

export interface OpenAIResponsesWebSocket {
  send(event: Record<string, unknown>): void;
  close(props?: { readonly code: number; readonly reason: string }): void;
  stream(): AsyncIterableIterator<OpenAIResponsesWebSocketMessage>;
}

export type OpenAIResponsesWebSocketFactory = (
  client: OpenAI,
  headers: Record<string, string> | undefined,
) => OpenAIResponsesWebSocket;

export interface OpenAIResponsesGenerationKwargs {
  max_output_tokens?: number | undefined;
  temperature?: number | undefined;
  top_p?: number | undefined;
  reasoning_effort?: string | undefined;
  [key: string]: unknown;
}
interface ResponseInputItem {
  [key: string]: unknown;
}

interface ResponseToolParam {
  type: string;
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  strict: boolean;
  defer_loading?: true;
}

function responseFormatToResponsesText(format: ResponseFormat): Record<string, unknown> {
  if (format.type === 'json_object') {
    return { format: { type: 'json_object' } };
  }
  return {
    format: {
      type: 'json_schema',
      name: format.jsonSchema.name,
      schema: format.jsonSchema.schema,
      strict: format.jsonSchema.strict,
      description: format.jsonSchema.description,
    },
  };
}

// The Responses API has no input type for video, and only mp3/wav audio can
// be inlined as input_file data. Degrade such parts to placeholder text so
// the model still learns an attachment existed instead of silently losing it.
const OMITTED_AUDIO_PLACEHOLDER = '(audio omitted: unsupported audio format)';
const OMITTED_VIDEO_PLACEHOLDER = '(video omitted: not supported by this provider)';

function contentPartsToInputItems(parts: ContentPart[]): unknown[] {
  const items: unknown[] = [];
  for (const part of parts) {
    switch (part.type) {
      case 'text':
        if (part.text) {
          items.push({ type: 'input_text', text: part.text });
        }
        break;
      case 'image_url':
        items.push({
          type: 'input_image',
          detail: 'auto',
          image_url: part.imageUrl.url,
        });
        break;
      case 'audio_url': {
        const mapped = mapAudioUrlToInputItem(part.audioUrl.url);
        items.push(mapped ?? { type: 'input_text', text: OMITTED_AUDIO_PLACEHOLDER });
        break;
      }
      case 'video_url':
        items.push({ type: 'input_text', text: OMITTED_VIDEO_PLACEHOLDER });
        break;
      case 'think':
        // Handled separately as reasoning items.
        break;
    }
  }
  return items;
}

function contentPartsToOutputItems(parts: ContentPart[]): unknown[] {
  const items: unknown[] = [];
  for (const part of parts) {
    if (part.type === 'text' && part.text) {
      items.push({ type: 'output_text', text: part.text, annotations: [] });
    }
  }
  return items;
}

function messageContentToFunctionOutputItems(content: ContentPart[]): unknown[] {
  const items: unknown[] = [];
  for (const part of content) {
    switch (part.type) {
      case 'text':
        if (part.text) {
          items.push({ type: 'input_text', text: part.text });
        }
        break;
      case 'image_url':
        items.push({ type: 'input_image', image_url: part.imageUrl.url });
        break;
      case 'audio_url': {
        // Tool results can legitimately include audio (e.g. a TTS tool
        // returning generated speech). The user-message path already
        // encodes audio via `mapAudioUrlToInputItem`; without the same
        // branch here, audio returned by a tool would be dropped on the
        // next turn.
        const mapped = mapAudioUrlToInputItem(part.audioUrl.url);
        items.push(mapped ?? { type: 'input_text', text: OMITTED_AUDIO_PLACEHOLDER });
        break;
      }
      case 'video_url':
        items.push({ type: 'input_text', text: OMITTED_VIDEO_PLACEHOLDER });
        break;
      case 'think':
        // Handled separately as reasoning items.
        break;
    }
  }
  return items;
}

function mapAudioUrlToInputItem(url: string): unknown {
  if (url.startsWith('data:audio/')) {
    try {
      const parts = url.split(',', 2);
      if (parts.length !== 2 || parts[0] === undefined || parts[1] === undefined) return null;
      const header = parts[0];
      const b64 = parts[1];
      const subtypePart = header.split('/')[1];
      if (subtypePart === undefined) return null;
      const [subtypeHead = ''] = subtypePart.split(';');
      const subtype = subtypeHead.toLowerCase();
      const ext =
        subtype === 'mp3' || subtype === 'mpeg' ? 'mp3' : subtype === 'wav' ? 'wav' : null;
      if (ext === null) return null;
      return { type: 'input_file', file_data: b64, filename: `inline.${ext}` };
    } catch {
      return null;
    }
  }
  if (url.startsWith('http://') || url.startsWith('https://')) {
    return { type: 'input_file', file_url: url };
  }
  return null;
}

function convertMessage(
  message: Message,
  modelName: string,
  toolMessageConversion: ToolMessageConversion,
): ResponseInputItem[] {
  let role: string = message.role;
  if (usesOpenAIResponsesDeveloperRole(modelName) && role === 'system') {
    role = 'developer';
  }

  // tool role -> function_call_output
  if (role === 'tool') {
    const callId = message.toolCallId ?? '';
    let output: string | unknown[];
    if (toolMessageConversion === 'extract_text') {
      // Plain-string output for backends that reject structured
      // function_call_output. Media parts are reattached as a user message
      // by `convertHistoryMessages`; when the result carries no text at
      // all, point the model at that follow-up message.
      const text = extractText(message);
      output =
        text.length === 0 && message.content.some(isMediaPart)
          ? TOOL_RESULT_MEDIA_PLACEHOLDER
          : text;
    } else {
      output = messageContentToFunctionOutputItems(message.content);
    }
    return [
      {
        call_id: callId,
        output,
        type: 'function_call_output',
      },
    ];
  }

  const result: ResponseInputItem[] = [];

  // Process content parts
  if (message.content.length > 0) {
    const pendingParts: ContentPart[] = [];

    const flushPendingParts = (): void => {
      if (pendingParts.length === 0) return;
      if (role === 'assistant') {
        result.push({
          content: contentPartsToOutputItems(pendingParts),
          role,
          type: 'message',
        });
      } else {
        result.push({
          content: contentPartsToInputItems(pendingParts),
          role,
          type: 'message',
        });
      }
      pendingParts.length = 0;
    };

    let i = 0;
    const n = message.content.length;
    while (i < n) {
      const part = message.content[i];
      if (part === undefined) break;
      if (part.type === 'think') {
        // Flush accumulated non-reasoning parts first
        flushPendingParts();
        // Aggregate consecutive ThinkParts with the same `encrypted` value
        const encryptedValue = part.encrypted;
        const summaries: unknown[] = [{ type: 'summary_text', text: part.think }];
        i += 1;
        while (i < n) {
          const nextPart = message.content[i];
          if (nextPart === undefined) break;
          if (nextPart.type !== 'think') break;
          if (nextPart.encrypted !== encryptedValue) break;
          summaries.push({ type: 'summary_text', text: nextPart.think });
          i += 1;
        }
        result.push({
          summary: summaries,
          type: 'reasoning',
          encrypted_content: encryptedValue,
        });
      } else {
        pendingParts.push(part);
        i += 1;
      }
    }

    // Handle remaining trailing non-reasoning parts
    flushPendingParts();
  }

  // Handle tool calls
  for (const toolCall of message.toolCalls) {
    result.push({
      arguments: toolCall.arguments ?? '{}',
      call_id: toolCall.id,
      name: toolCall.name,
      type: 'function_call',
    });
  }

  return result;
}

function convertTool(tool: Tool, nativeToolSearch: boolean): ResponseToolParam {
  const converted: ResponseToolParam = {
    type: 'function',
    name: tool.name,
    description: tool.description,
    parameters: tool.parameters,
    strict: false,
  };
  if (nativeToolSearch && tool.deferred === true) converted.defer_loading = true;
  return converted;
}

function hostedSearchTool(mode: HostedSearchMode): RawObject | undefined {
  if (mode === 'disabled') return undefined;
  if (mode === 'cached') {
    return { type: 'web_search', external_web_access: false };
  }
  if (mode === 'indexed') {
    return {
      type: 'web_search',
      external_web_access: true,
      indexed_web_access: true,
    };
  }
  return { type: 'web_search', external_web_access: true };
}

function resolveHostedSearchMode(config: HostedSearchConfig | undefined): HostedSearchMode {
  if (config === undefined) return 'disabled';
  return typeof config === 'string' ? config : config.mode;
}

/**
 * Convert the history, buffering tool-result media when `extract_text`
 * flattens tool outputs to plain strings. The buffered media items are
 * reattached as a single user message after each run of consecutive tool
 * messages — mirroring the OpenAI Chat Completions provider.
 */
function convertHistoryMessages(
  history: readonly Message[],
  modelName: string,
  toolMessageConversion: ToolMessageConversion,
): unknown[] {
  const input: unknown[] = [];
  const pendingToolResultMedia: unknown[] = [];

  const flushPendingMedia = (): void => {
    if (pendingToolResultMedia.length === 0) return;
    input.push({
      type: 'message',
      role: 'user',
      content: [
        { type: 'input_text', text: TOOL_RESULT_MEDIA_PROMPT },
        ...pendingToolResultMedia,
      ],
    });
    pendingToolResultMedia.length = 0;
  };

  for (const msg of history) {
    // Message-level tool declarations are a Kimi wire feature; skipped here
    // because the leftover content-free message item is rejected by the
    // Responses API. See isToolDeclarationOnlyMessage.
    if (isToolDeclarationOnlyMessage(msg)) continue;
    if (msg.role !== 'tool') {
      flushPendingMedia();
    }
    input.push(...convertMessage(msg, modelName, toolMessageConversion));
    if (msg.role === 'tool' && toolMessageConversion === 'extract_text') {
      pendingToolResultMedia.push(
        ...messageContentToFunctionOutputItems(msg.content.filter(isMediaPart)),
      );
    }
  }

  flushPendingMedia();
  return input;
}

function hostedSearchPartToEvent(part: HostedSearchPart): HostedSearchEvent {
  const event: HostedSearchEvent = {};
  if (part.callId !== undefined) event.callId = part.callId;
  switch (part.type) {
    case 'hosted_search_source':
      event.sources = [part.source];
      break;
    case 'hosted_search_action':
      event.action = part.action;
      break;
    case 'hosted_search_lifecycle':
      event.status = part.status;
      if (part.action !== undefined) event.action = part.action;
      if (part.sources !== undefined) event.sources = part.sources;
      break;
  }
  return event;
}

function hostedSearchPartsForItem(
  item: Extract<ResponseOutputItemView, { type: 'web_search_call' }>,
): HostedSearchPart[] {
  const parts: HostedSearchPart[] = [];
  if (item.action !== undefined) {
    const actionPart = { type: 'hosted_search_action', action: item.action } as const;
    if (item.callId !== undefined) {
      parts.push({ ...actionPart, callId: item.callId });
    } else {
      parts.push(actionPart);
    }
  }
  for (const source of item.sources) {
    const sourcePart = { type: 'hosted_search_source', source } as const;
    if (item.callId !== undefined) {
      parts.push({ ...sourcePart, callId: item.callId });
    } else {
      parts.push(sourcePart);
    }
  }
  if (item.status !== undefined) {
    const lifecyclePart: Extract<HostedSearchPart, { type: 'hosted_search_lifecycle' }> = {
      type: 'hosted_search_lifecycle',
      status: item.status,
    };
    if (item.callId !== undefined) lifecyclePart.callId = item.callId;
    if (item.action !== undefined) lifecyclePart.action = item.action;
    if (item.sources.length > 0) lifecyclePart.sources = item.sources;
    parts.push(lifecyclePart);
  }
  return parts;
}

export class OpenAIResponsesStreamedMessage implements StreamedMessage {
  private _id: string | null = null;
  private _usage: TokenUsage | null = null;
  private _finishReason: FinishReason | null = null;
  private _rawFinishReason: string | null = null;
  private readonly _annotations: HostedSearchCitation[] = [];
  private readonly _annotationKeys = new Set<string>();
  private readonly _searchMetadata: HostedSearchEvent[] = [];
  private readonly _searchMetadataKeys = new Set<string>();
  private readonly _iter: AsyncGenerator<StreamedMessagePart>;

  constructor(response: unknown, isStream: boolean) {
    if (isStream) {
      this._iter = this._convertStreamResponse(response as AsyncIterable<RawObject>);
    } else {
      this._iter = this._convertNonStreamResponse(response as RawObject);
    }
  }

  get id(): string | null {
    return this._id;
  }

  get usage(): TokenUsage | null {
    return this._usage;
  }

  get finishReason(): FinishReason | null {
    return this._finishReason;
  }

  get rawFinishReason(): string | null {
    return this._rawFinishReason;
  }

  get annotations(): readonly HostedSearchCitation[] {
    return this._annotations;
  }

  get searchMetadata(): readonly HostedSearchEvent[] {
    return this._searchMetadata;
  }

  async *[Symbol.asyncIterator](): AsyncIterator<StreamedMessagePart> {
    yield* this._iter;
  }

  private _recordCitation(citation: HostedSearchCitation): boolean {
    const key = `${citation.url}\u0000${citation.startIndex}\u0000${citation.endIndex}`;
    if (this._annotationKeys.has(key)) return false;
    this._annotationKeys.add(key);
    this._annotations.push(citation);
    return true;
  }

  private _recordSearchPart(part: HostedSearchPart): boolean {
    const event = hostedSearchPartToEvent(part);
    if (part.type === 'hosted_search_lifecycle' && part.callId !== undefined) {
      const existing = this._searchMetadata.find(
        (candidate) => candidate.callId === part.callId && candidate.status === part.status,
      );
      if (existing !== undefined) {
        if (existing.action === undefined && event.action !== undefined) {
          existing.action = event.action;
        }
        if (event.sources !== undefined) {
          existing.sources ??= [];
          for (const source of event.sources) {
            if (!existing.sources.some((candidate) => candidate.url === source.url)) {
              existing.sources.push(source);
            }
          }
        }
        return false;
      }
    }
    const key = JSON.stringify(event);
    if (this._searchMetadataKeys.has(key)) return false;
    this._searchMetadataKeys.add(key);
    this._searchMetadata.push(event);
    return true;
  }

  private _captureFinishReasonFromResponse(response: RawObject): void {
    const status = readNullableStringField(response, 'status');
    const incomplete = readObjectField(response, 'incomplete_details');
    const incompleteReason = incomplete ? readStringField(incomplete, 'reason') : null;
    const normalized = normalizeResponsesFinishReason(status, incompleteReason);
    this._finishReason = normalized.finishReason;
    this._rawFinishReason = normalized.rawFinishReason;
  }

  private _extractUsage(usage: RawObject): void {
    const inputTokens = readNumberField(usage, 'input_tokens') ?? 0;
    const outputTokens = readNumberField(usage, 'output_tokens') ?? 0;
    const details = readObjectField(usage, 'input_tokens_details');
    const cached = details ? (readNumberField(details, 'cached_tokens') ?? 0) : 0;
    const cacheWrite = details ? (readNumberField(details, 'cache_write_tokens') ?? 0) : 0;
    this._usage = {
      inputOther: Math.max(0, inputTokens - cached - cacheWrite),
      output: outputTokens,
      inputCacheRead: cached,
      inputCacheCreation: cacheWrite,
    };
  }

  private async *_convertNonStreamResponse(
    response: RawObject,
  ): AsyncGenerator<StreamedMessagePart> {
    this._id = readStringField(response, 'id') ?? null;
    const usage = readObjectField(response, 'usage');
    if (usage !== undefined) {
      this._extractUsage(usage);
    }
    this._captureFinishReasonFromResponse(response);

    const output = readObjectArrayField(response, 'output');
    if (output === undefined) return;

    for (const item of output) {
      const outputItem = readResponseOutputItem(item, 'response.output item');

      if (outputItem.type === 'message') {
        for (const contentItem of outputItem.content) {
          if (contentItem['type'] === 'output_text') {
            const text = readStringField(contentItem, 'text');
            if (text !== undefined) {
              yield { type: 'text', text };
            }
            for (const citation of readOutputTextCitations(contentItem)) {
              if (this._recordCitation(citation)) yield citation;
            }
          }
        }
      } else if (outputItem.type === 'function_call') {
        yield {
          type: 'function',
          id: functionCallId(outputItem.callId),
          name: requireFunctionCallName(outputItem),
          arguments: outputItem.arguments ?? null,
        } satisfies ToolCall;
      } else if (outputItem.type === 'web_search_call') {
        for (const part of hostedSearchPartsForItem(outputItem)) {
          if (this._recordSearchPart(part)) yield part;
        }
      } else if (outputItem.type === 'reasoning') {
        let hasReasoningSummary = false;
        for (const summary of outputItem.summary) {
          const text = readStringField(summary, 'text');
          if (text === undefined) continue;
          hasReasoningSummary = true;
          const thinkPart: StreamedMessagePart = {
            type: 'think',
            think: text,
          };
          if (outputItem.encryptedContent !== undefined) {
            (thinkPart as { encrypted: string }).encrypted = outputItem.encryptedContent;
          }
          yield thinkPart;
        }
        if (!hasReasoningSummary) {
          const thinkPart: StreamedMessagePart = { type: 'think', think: '' };
          if (outputItem.encryptedContent !== undefined) {
            (thinkPart as { encrypted: string }).encrypted = outputItem.encryptedContent;
          }
          yield thinkPart;
        }
      }
    }
  }

  private async *_convertStreamResponse(
    response: AsyncIterable<RawObject>,
  ): AsyncGenerator<StreamedMessagePart> {
    const functionCallArgumentsByIndex = new Map<number | string, string>();
    let unindexedFunctionCallArguments: string | undefined;

    const hasFunctionCallArguments = (streamIndex: number | string | undefined): boolean =>
      streamIndex === undefined
        ? unindexedFunctionCallArguments !== undefined
        : functionCallArgumentsByIndex.has(streamIndex);

    const getFunctionCallArguments = (streamIndex: number | string | undefined): string =>
      streamIndex === undefined
        ? (unindexedFunctionCallArguments as string)
        : functionCallArgumentsByIndex.get(streamIndex)!;

    const setFunctionCallArguments = (
      streamIndex: number | string | undefined,
      argumentsValue: string,
    ): void => {
      if (streamIndex === undefined) {
        unindexedFunctionCallArguments = argumentsValue;
      } else {
        functionCallArgumentsByIndex.set(streamIndex, argumentsValue);
      }
    };

    const appendFunctionCallArguments = (
      streamIndex: number | string | undefined,
      argumentsPart: string,
      context: string,
    ): void => {
      if (!hasFunctionCallArguments(streamIndex)) {
        failResponsesDecode(
          context,
          `received function-call arguments for unknown stream index ${formatResponseStreamIndex(streamIndex)}.`,
        );
      }
      setFunctionCallArguments(
        streamIndex,
        getFunctionCallArguments(streamIndex) + argumentsPart,
      );
    };

    const yieldFinalArgumentsSuffix = function* (
      streamIndex: number | string | undefined,
      finalArguments: string,
      context: string,
    ): Generator<StreamedMessagePart> {
      if (!hasFunctionCallArguments(streamIndex)) {
        failResponsesDecode(
          context,
          `received final function-call arguments for unknown stream index ${formatResponseStreamIndex(streamIndex)}.`,
        );
      }

      const accumulatedArguments = getFunctionCallArguments(streamIndex);
      if (finalArguments === accumulatedArguments) {
        return;
      }

      if (!finalArguments.startsWith(accumulatedArguments)) {
        throw new ChatProviderError(
          `OpenAI Responses final function-call arguments for stream index ${formatResponseStreamIndex(
            streamIndex,
          )} do not match the streamed argument deltas.`,
        );
      }

      const suffix = finalArguments.slice(accumulatedArguments.length);
      setFunctionCallArguments(streamIndex, finalArguments);
      if (suffix.length === 0) {
        return;
      }

      const part: StreamedMessagePart = {
        type: 'tool_call_part',
        argumentsPart: suffix,
      };
      if (streamIndex !== undefined) {
        (part as { index: number | string }).index = streamIndex;
      }
      yield part;
    };

    try {
      for await (const chunk of response) {
        const type = readStringField(chunk, 'type');
        if (type === undefined) {
          if (!hasOwn(chunk, 'type')) {
            const message = readStringField(chunk, 'message');
            if (message !== undefined) {
              throw malformedStreamErrorEvent(message);
            }
          }
          failResponsesDecode('stream event.type', 'must be a string.');
        }

        switch (type) {
          case 'response.output_text.delta':
            yield { type: 'text', text: requireStringField(chunk, 'delta', type) };
            break;
          case 'response.output_text.annotation.added': {
            const citation = readUrlCitation(chunk['annotation']);
            if (citation !== undefined && this._recordCitation(citation)) {
              yield citation;
            }
            break;
          }
          case 'response.output_text.done': {
            for (const citation of readCitations(chunk['annotations'])) {
              if (this._recordCitation(citation)) yield citation;
            }
            break;
          }
          case 'response.web_search_call.in_progress':
          case 'response.web_search_call.searching':
          case 'response.web_search_call.completed': {
            const status = type.slice('response.web_search_call.'.length) as HostedSearchLifecycle;
            const part: Extract<HostedSearchPart, { type: 'hosted_search_lifecycle' }> = {
              type: 'hosted_search_lifecycle',
              status,
            };
            const callId = readStringField(chunk, 'item_id');
            if (callId !== undefined) part.callId = callId;
            if (this._recordSearchPart(part)) yield part;
            break;
          }
          case 'response.created':
          case 'response.in_progress': {
            const responseObject = requireObjectField(chunk, 'response', type);
            // Initial events carry the Responses API `response.id`. Record it
            // here so callers that inspect `stream.id` before the stream
            // completes see the actual response id rather than a later
            // output-item identifier.
            const respId = readStringField(responseObject, 'id');
            if (respId !== undefined) {
              this._id = respId;
            }
            break;
          }
          case 'response.output_item.added': {
            const item = readResponseOutputItem(chunk['item'], `${type}.item`);
            const outputIndex = readNumberField(chunk, 'output_index');
            // NOTE: `item.id` here is an output-item identifier, not the
            // Responses API `response.id`. Do NOT overwrite `this._id` — it
            // would clobber the real response id (or leave it undefined for
            // tool-call items that have no `item.id`).
            if (item.type === 'function_call') {
              // The Responses API routes streaming argument deltas via
              // `item_id`, which matches `item.id` on output_item.added.
              // Preserve it so the generate loop can dispatch interleaved
              // deltas across parallel function calls correctly.
              const streamIndex = responseStreamIndex(item.itemId, outputIndex);
              setFunctionCallArguments(streamIndex, item.arguments ?? '');
              const tc: ToolCall = {
                type: 'function',
                id: functionCallId(item.callId),
                name: requireFunctionCallName(item),
                arguments: item.arguments ?? null,
              };
              if (streamIndex !== undefined) {
                tc._streamIndex = streamIndex;
              }
              yield tc;
            } else if (item.type === 'web_search_call') {
              for (const part of hostedSearchPartsForItem(item)) {
                if (this._recordSearchPart(part)) yield part;
              }
            } else if (item.type === 'message') {
              for (const contentItem of item.content) {
                if (contentItem['type'] !== 'output_text') continue;
                for (const citation of readOutputTextCitations(contentItem)) {
                  if (this._recordCitation(citation)) yield citation;
                }
              }
            }
            break;
          }
          case 'response.output_item.done': {
            const item = readResponseOutputItem(chunk['item'], `${type}.item`);
            const outputIndex = readNumberField(chunk, 'output_index');
            // Same as output_item.added: `item.id` is not the response id.
            if (item.type === 'reasoning') {
              const thinkPart: StreamedMessagePart = { type: 'think', think: '' };
              if (item.encryptedContent !== undefined) {
                (thinkPart as { encrypted: string }).encrypted = item.encryptedContent;
              }
              yield thinkPart;
            } else if (item.type === 'function_call' && typeof item.arguments === 'string') {
              const streamIndex = responseStreamIndex(item.itemId, outputIndex);
              yield* yieldFinalArgumentsSuffix(streamIndex, item.arguments, type);
            } else if (item.type === 'web_search_call') {
              for (const part of hostedSearchPartsForItem(item)) {
                if (this._recordSearchPart(part)) yield part;
              }
            } else if (item.type === 'message') {
              for (const contentItem of item.content) {
                if (contentItem['type'] !== 'output_text') continue;
                for (const citation of readOutputTextCitations(contentItem)) {
                  if (this._recordCitation(citation)) yield citation;
                }
              }
            }
            break;
          }
          case 'response.function_call_arguments.delta': {
            // `item_id` uniquely identifies the function_call output item this
            // delta belongs to; use it as the streaming index.
            const streamIndex = responseStreamIndex(
              readStringField(chunk, 'item_id'),
              readNumberField(chunk, 'output_index'),
            );
            const argumentsPart = requireStringField(chunk, 'delta', type);
            const part: StreamedMessagePart = {
              type: 'tool_call_part',
              argumentsPart,
            };
            appendFunctionCallArguments(streamIndex, argumentsPart, type);
            if (streamIndex !== undefined) {
              (part as { index: number | string }).index = streamIndex;
            }
            yield part;
            break;
          }
          case 'response.function_call_arguments.done': {
            const functionArguments = requireStringField(chunk, 'arguments', type);
            const streamIndex = responseStreamIndex(
              readStringField(chunk, 'item_id'),
              readNumberField(chunk, 'output_index'),
            );
            yield* yieldFinalArgumentsSuffix(streamIndex, functionArguments, type);
            break;
          }
          case 'response.reasoning_summary_part.added':
            yield { type: 'think', think: '' };
            break;
          case 'response.reasoning_summary_text.delta':
            yield { type: 'think', think: requireStringField(chunk, 'delta', type) };
            break;
          case 'response.completed':
          case 'response.incomplete': {
            const responseObject = requireObjectField(chunk, 'response', type);
            // Final event confirms the Responses API `response.id`. Prefer
            // it over any earlier value in case the API refines it.
            const respId = readStringField(responseObject, 'id');
            if (respId !== undefined) {
              this._id = respId;
            }
            const usage = readObjectField(responseObject, 'usage');
            if (usage !== undefined) {
              this._extractUsage(usage);
              if (this._usage !== null) {
                yield { type: 'usage', usage: { ...this._usage } };
              }
            }
            this._captureFinishReasonFromResponse(responseObject);
            break;
          }
          case 'error': {
            const message = requireStringField(chunk, 'message', type);
            throw errorFromOpenAIResponsesEvent(
              'OpenAI Responses stream error',
              readNullableStringField(chunk, 'code') ?? null,
              message,
              readNullableStringField(chunk, 'param') ?? null,
            );
          }
          case 'response.failed': {
            const responseObject = requireObjectField(chunk, 'response', type);
            const error = readResponsesFailedResponseError(responseObject);
            if (error !== undefined) {
              throw errorFromOpenAIResponsesEvent(
                'OpenAI Responses response.failed',
                error.code,
                error.message,
                null,
              );
            }
            throw new ChatProviderError(
              `OpenAI Responses response.failed: ${formatResponsesFailedResponse(responseObject)}`,
            );
          }
          default:
            // Unknown future event types carry no data we currently consume.
            break;
        }
      }
    } catch (error: unknown) {
      throw convertOpenAIError(error);
    }
  }
}

function isHostedSearchWireTool(value: unknown): boolean {
  return asRawObject(value)?.['type'] === 'web_search';
}

function shapeOpenAICodexRequest(body: Record<string, unknown>, responsesLite: boolean): void {
  delete body['max_output_tokens'];
  delete body['max_completion_tokens'];
  if (!responsesLite) return;

  const input = Array.isArray(body['input']) ? body['input'] : [];
  stripOpenAICodexImageDetails(input);
  const tools = Array.isArray(body['tools']) ? body['tools'] : [];
  const additionalTools = tools.filter((tool) => !isHostedSearchWireTool(tool));
  const hostedTools = tools.filter(isHostedSearchWireTool);
  const prefix: unknown[] = [
    { type: 'additional_tools', role: 'developer', tools: additionalTools },
  ];
  const instructions = body['instructions'];
  if (typeof instructions === 'string' && instructions.length > 0) {
    prefix.push({
      type: 'message',
      role: 'developer',
      content: [{ type: 'input_text', text: instructions }],
    });
  }
  body['input'] = [...prefix, ...input];
  body['parallel_tool_calls'] = false;
  const toolChoice = body['tool_choice'];
  if (toolChoice !== 'none' && toolChoice !== 'required') body['tool_choice'] = 'auto';
  body['reasoning'] = { ...asRawObject(body['reasoning']), context: 'all_turns' };
  delete body['instructions'];
  if (hostedTools.length > 0) {
    body['tools'] = hostedTools;
  } else {
    delete body['tools'];
  }
}

function configureOpenAIResponsesPromptCache(
  body: Record<string, unknown>,
  systemPrompt: string,
  promptCache: OpenAIResponsesPromptCacheOptions,
): void {
  body['prompt_cache_options'] = {
    mode: promptCache.mode ?? 'explicit',
    ttl: promptCache.ttl ?? '30m',
  };
  if (systemPrompt.length === 0) return;

  const input = Array.isArray(body['input']) ? body['input'] : [];
  body['input'] = [
    {
      type: 'message',
      role: 'developer',
      content: [
        {
          type: 'input_text',
          text: systemPrompt,
          prompt_cache_breakpoint: { mode: 'explicit' },
        },
      ],
    },
    ...input,
  ];
  delete body['instructions'];
}

function stripOpenAICodexImageDetails(input: unknown[]): void {
  for (const item of input) {
    const itemRecord = asRawObject(item);
    if (itemRecord === null) continue;
    for (const field of ['content', 'output']) {
      const parts = itemRecord[field];
      if (!Array.isArray(parts)) continue;
      for (const part of parts) {
        const partRecord = asRawObject(part);
        if (partRecord === null || partRecord['type'] !== 'input_image') continue;
        delete partRecord['detail'];
      }
    }
  }
}

interface CompletedResponsesRequest {
  readonly request: RawObject;
  readonly responseId: string;
  readonly outputItems: readonly unknown[];
}

function responseRequestProperties(request: RawObject): string {
  const properties = { ...request };
  delete properties['input'];
  delete properties['previous_response_id'];
  delete properties['client_metadata'];
  delete properties['type'];
  return JSON.stringify(properties);
}

function normalizeResponseOutputForReplay(value: unknown): unknown | undefined {
  const item = asRawObject(value);
  if (item === null) return undefined;
  switch (item['type']) {
    case 'message': {
      const content = readObjectArrayField(item, 'content')?.map((part) => {
        if (part['type'] !== 'output_text') return part;
        return {
          type: 'output_text',
          text: readStringField(part, 'text') ?? '',
          annotations: Array.isArray(part['annotations']) ? part['annotations'] : [],
        };
      });
      return {
        content: content ?? [],
        role: readStringField(item, 'role') ?? 'assistant',
        type: 'message',
      };
    }
    case 'function_call':
      return {
        arguments: readStringField(item, 'arguments') ?? '{}',
        call_id: readStringField(item, 'call_id') ?? '',
        name: readStringField(item, 'name') ?? '',
        type: 'function_call',
      };
    case 'reasoning':
      return {
        summary: readObjectArrayField(item, 'summary') ?? [],
        type: 'reasoning',
        encrypted_content: readStringField(item, 'encrypted_content'),
      };
    default:
      return undefined;
  }
}

function prepareIncrementalResponsesEvent(
  request: RawObject,
  previous: CompletedResponsesRequest | undefined,
): { readonly event: RawObject; readonly incremental: boolean } {
  const fullEvent = { ...request, type: 'response.create' };
  if (previous === undefined) return { event: fullEvent, incremental: false };
  if (responseRequestProperties(previous.request) !== responseRequestProperties(request)) {
    return { event: fullEvent, incremental: false };
  }

  const previousInput = Array.isArray(previous.request['input']) ? previous.request['input'] : [];
  const currentInput = Array.isArray(request['input']) ? request['input'] : [];
  const baseline = [...previousInput, ...previous.outputItems];
  if (currentInput.length <= baseline.length) return { event: fullEvent, incremental: false };
  for (let index = 0; index < baseline.length; index += 1) {
    if (JSON.stringify(currentInput[index]) !== JSON.stringify(baseline[index])) {
      return { event: fullEvent, incremental: false };
    }
  }
  return {
    event: {
      ...fullEvent,
      input: currentInput.slice(baseline.length),
      previous_response_id: previous.responseId,
    },
    incremental: true,
  };
}

function webSocketErrorCode(error: unknown): string | undefined {
  const value = asRawObject(error);
  const direct = value === null ? undefined : readStringField(value, 'code');
  if (direct !== undefined) return direct;
  const event = value === null ? undefined : readObjectField(value, 'error');
  return event === undefined ? undefined : readStringField(event, 'code');
}

class OpenAIResponsesWebSocketSession {
  private connection: OpenAIResponsesWebSocket | undefined;
  private iterator: AsyncIterableIterator<OpenAIResponsesWebSocketMessage> | undefined;
  private connectionKey: string | undefined;
  private active = false;
  private previous: CompletedResponsesRequest | undefined;

  constructor(private readonly factory: OpenAIResponsesWebSocketFactory) {}

  async request(
    client: OpenAI,
    headers: Record<string, string> | undefined,
    request: RawObject,
    signal: AbortSignal | undefined,
  ): Promise<AsyncIterable<RawObject> | undefined> {
    if (this.active) return undefined;
    this.active = true;
    const key = JSON.stringify([client.apiKey, headers]);
    try {
      await this.ensureConnection(client, headers, key);
      const connection = this.connection;
      if (connection === undefined) {
        this.active = false;
        return undefined;
      }
      const transportRequest = {
        ...request,
        client_metadata: {
          session_id: headers?.['conversation_id'],
          thread_id: headers?.['session_id'],
          turn_id: crypto.randomUUID(),
        },
      };
      const prepared = prepareIncrementalResponsesEvent(transportRequest, this.previous);
      connection.send(prepared.event);
      return this.readResponse(transportRequest, prepared.incremental, signal);
    } catch (error: unknown) {
      this.resetConnection();
      if (signal?.aborted === true) throw signal.reason ?? error;
      return undefined;
    }
  }

  private async ensureConnection(
    client: OpenAI,
    headers: Record<string, string> | undefined,
    key: string,
  ): Promise<void> {
    if (this.connection !== undefined && this.connectionKey === key) return;
    this.resetConnection(true);
    const connection = this.factory(client, {
      ...headers,
      'OpenAI-Beta': 'responses_websockets=2026-02-06',
      'x-client-request-id': crypto.randomUUID(),
    });
    const iterator = connection.stream();
    this.connection = connection;
    this.iterator = iterator;
    this.connectionKey = key;
    while (true) {
      const result = await iterator.next();
      if (result.done) throw new ChatProviderError('OpenAI Responses WebSocket closed during setup.');
      const envelope = result.value;
      if (envelope.type === 'open') return;
      if (envelope.type === 'error') throw envelope.error;
      if (envelope.type === 'close' || envelope.type === 'closing') {
        throw new ChatProviderError('OpenAI Responses WebSocket closed during setup.');
      }
    }
  }

  private async *readResponse(
    fullRequest: RawObject,
    usedIncrementalRequest: boolean,
    signal: AbortSignal | undefined,
  ): AsyncGenerator<RawObject> {
    const connection = this.connection;
    const iterator = this.iterator;
    if (connection === undefined || iterator === undefined) return;
    const outputItems: unknown[] = [];
    let terminal = false;
    let incremental = usedIncrementalRequest;
    let replayable = true;
    const abort = (): void => this.resetConnection();
    signal?.addEventListener('abort', abort, { once: true });
    try {
      while (true) {
        const result = await iterator.next();
        if (result.done) throw new ChatProviderError('OpenAI Responses WebSocket closed.');
        const envelope = result.value;
        if (envelope.type === 'error') {
          if (incremental && webSocketErrorCode(envelope.error) === 'previous_response_not_found') {
            this.previous = undefined;
            outputItems.length = 0;
            connection.send({ ...fullRequest, type: 'response.create' });
            incremental = false;
            continue;
          }
          throw envelope.error;
        }
        if (envelope.type === 'close' || envelope.type === 'closing') {
          throw new ChatProviderError('OpenAI Responses WebSocket closed.');
        }
        if (envelope.type !== 'message') continue;
        const event = envelope.message;
        if (
          event['type'] === 'error' &&
          incremental &&
          webSocketErrorCode(event) === 'previous_response_not_found'
        ) {
          this.previous = undefined;
          outputItems.length = 0;
          connection.send({ ...fullRequest, type: 'response.create' });
          incremental = false;
          continue;
        }
        if (event['type'] === 'response.output_item.done') {
          const normalized = normalizeResponseOutputForReplay(event['item']);
          if (normalized === undefined) replayable = false;
          else outputItems.push(normalized);
        }
        yield event;
        if (event['type'] === 'response.completed') {
          const response = readObjectField(event, 'response');
          const responseId = response === undefined ? undefined : readStringField(response, 'id');
          if (responseId !== undefined && replayable) {
            this.previous = { request: fullRequest, responseId, outputItems };
          } else {
            this.previous = undefined;
          }
          terminal = true;
          return;
        }
        if (event['type'] === 'response.incomplete') {
          this.previous = undefined;
          terminal = true;
          return;
        }
        if (event['type'] === 'response.failed' || event['type'] === 'error') {
          this.previous = undefined;
          return;
        }
      }
    } finally {
      signal?.removeEventListener('abort', abort);
      this.active = false;
      if (!terminal) this.resetConnection();
    }
  }

  private resetConnection(preserveActive = false): void {
    this.connection?.close({ code: 1000, reason: 'Resetting Responses transport' });
    void this.iterator?.return?.();
    this.connection = undefined;
    this.iterator = undefined;
    this.connectionKey = undefined;
    if (!preserveActive) this.active = false;
    this.previous = undefined;
  }
}

export class OpenAIResponsesChatProvider implements ChatProvider {
  readonly name: string = 'openai-responses';

  get preservesDeferredTools(): boolean {
    return this._nativeToolSearch;
  }

  /** See {@link ChatProvider.maxCompletionTokens}. */
  get maxCompletionTokens(): number | undefined {
    return this._generationKwargs.max_output_tokens;
  }

  private _model: string;
  private _stream: boolean;
  private _apiKey: string | undefined;
  private _baseUrl: string | undefined;
  private _defaultHeaders: Record<string, string> | undefined;
  private _generationKwargs: OpenAIResponsesGenerationKwargs;
  private _offEffort: string | undefined;
  private _toolMessageConversion: ToolMessageConversion;
  private _client: OpenAI | undefined;
  private _httpClient: unknown;
  private _clientFactory: ((auth: ProviderRequestAuth) => OpenAI) | undefined;
  private _codex: OpenAIResponsesOptions['codex'];
  private _hostedSearchMode: HostedSearchMode;
  private _nativeToolSearch: boolean;
  private _responsesWebSocket: boolean;
  private _promptCache: OpenAIResponsesPromptCacheOptions | undefined;
  private _responsesWebSocketSession: OpenAIResponsesWebSocketSession;

  constructor(options: OpenAIResponsesOptions) {
    if (options.promptCache !== undefined && options.supportsPromptCacheBreakpoints !== true) {
      throw new ChatProviderError(
        `OpenAI Responses model "${options.model}" does not declare support for explicit prompt cache breakpoints.`,
      );
    }
    const apiKey = options.apiKey ?? process.env['OPENAI_API_KEY'];
    this._apiKey = apiKey === undefined || apiKey.length === 0 ? undefined : apiKey;
    this._baseUrl = options.baseUrl ?? 'https://api.openai.com/v1';
    this._defaultHeaders = options.defaultHeaders;
    this._model = options.model;
    this._stream = true; // Responses API always supports streaming
    this._generationKwargs = { ...options.generationKwargs };
    this._offEffort = options.offEffort;
    this._toolMessageConversion = options.toolMessageConversion ?? null;
    this._httpClient = options.httpClient;
    this._clientFactory = options.clientFactory;
    this._codex = options.codex;
    this._hostedSearchMode = resolveHostedSearchMode(
      options.hostedSearch ??
        options.hostedSearchMode ??
        options.webSearch ??
        options.webSearchMode,
    );
    this._nativeToolSearch = options.nativeToolSearch === true;
    this._responsesWebSocket = options.responsesWebSocket === true;
    this._promptCache =
      options.promptCache === undefined ? undefined : { ...options.promptCache };
    this._responsesWebSocketSession = new OpenAIResponsesWebSocketSession(
      options.responsesWebSocketFactory ??
        ((client, headers) =>
          new ResponsesWS(client, { headers }) as unknown as OpenAIResponsesWebSocket),
    );

    if (options.maxOutputTokens !== undefined) {
      this._generationKwargs.max_output_tokens = options.maxOutputTokens;
    }

    this._client = this._apiKey === undefined ? undefined : this._buildClient(this._apiKey);
  }

  get modelName(): string {
    return this._model;
  }

  get thinkingEffort(): ThinkingEffort | null {
    const effort = this._generationKwargs.reasoning_effort;
    if (effort === undefined) return null;
    return effort === 'none' ? 'off' : effort;
  }

  get modelParameters(): Record<string, unknown> {
    return {
      model: this._model,
      baseUrl: this._baseUrl,
      ...this._generationKwargs,
    };
  }

  async generate(
    systemPrompt: string,
    tools: Tool[],
    history: Message[],
    options?: GenerateOptions,
  ): Promise<StreamedMessage> {
    const input: unknown[] = [];

    const normalizedHistory = normalizeToolCallIdsForProvider(
      history,
      OPENAI_RESPONSES_TOOL_CALL_ID_POLICY,
    );
    input.push(
      ...convertHistoryMessages(normalizedHistory, this._model, this._toolMessageConversion),
    );

    const kwargs: Record<string, unknown> = { ...this._generationKwargs };
    const reasoningEffort = kwargs['reasoning_effort'] as string | undefined;
    delete kwargs['reasoning_effort'];

    if (reasoningEffort !== undefined) {
      kwargs['reasoning'] = {
        effort: reasoningEffort,
        summary: 'auto',
      };
      kwargs['include'] = ['reasoning.encrypted_content'];
    }

    const hostedSearch = hostedSearchTool(this._hostedSearchMode);
    if (hostedSearch !== undefined) {
      const include = Array.isArray(kwargs['include'])
        ? kwargs['include'].filter((value): value is string => typeof value === 'string')
        : [];
      if (!include.includes('web_search_call.action.sources')) {
        include.push('web_search_call.action.sources');
      }
      kwargs['include'] = include;
    }

    // Remove undefined values
    for (const key of Object.keys(kwargs)) {
      if (kwargs[key] === undefined) {
        // eslint-disable-next-line @typescript-eslint/no-dynamic-delete
        delete kwargs[key];
      }
    }

    const requestTools: unknown[] = tools.map((tool) =>
      convertTool(tool, this._nativeToolSearch),
    );
    if (hostedSearch !== undefined) {
      requestTools.push(hostedSearch);
    }

    try {
      const client = this._createClient(options?.auth);
      const createParams: Record<string, unknown> = {
        model: this._model,
        input,
        tools: requestTools,
        store: false,
        stream: this._stream,
        ...kwargs,
      };
      if (this._nativeToolSearch && tools.some((tool) => tool.deferred === true)) {
        (createParams['tools'] as unknown[]).push({ type: 'tool_search', execution: 'server' });
      }
      if (systemPrompt) {
        createParams['instructions'] = systemPrompt;
      }
      if (this._promptCache !== undefined) {
        configureOpenAIResponsesPromptCache(createParams, systemPrompt, this._promptCache);
      }
      if (options?.responseFormat !== undefined) {
        createParams['text'] = {
          ...asRawObject(createParams['text']),
          ...responseFormatToResponsesText(options.responseFormat),
        };
      }
      if (this._codex !== undefined) {
        shapeOpenAICodexRequest(createParams, this._codex.responsesLite === true);
      }

      if (
        !('responses' in client) ||
        typeof (client as { responses?: { create?: unknown } }).responses?.create !== 'function'
      ) {
        throw new Error(
          'OpenAI SDK version does not support Responses API. Upgrade to >=4.x with responses support.',
        );
      }

      options?.onRequestSent?.();
      if (this._responsesWebSocket) {
        const webSocketResponse = await this._responsesWebSocketSession.request(
          client,
          mergeRequestHeaders(this._defaultHeaders, options?.auth?.headers),
          createParams,
          options?.signal,
        );
        if (webSocketResponse !== undefined) {
          return new OpenAIResponsesStreamedMessage(webSocketResponse, true);
        }
      }
      const requestOptions =
        options?.signal === undefined && this._codex === undefined
          ? undefined
          : {
              signal: options?.signal,
              headers:
                this._codex === undefined
                  ? undefined
                  : { 'x-client-request-id': crypto.randomUUID() },
            };
      const response = await (
        client.responses as {
          create(params: unknown, opts?: unknown): Promise<unknown>;
        }
      ).create(createParams, requestOptions);
      return new OpenAIResponsesStreamedMessage(response, this._stream);
    } catch (error: unknown) {
      throw convertOpenAIError(error);
    }
  }

  withThinking(effort: ThinkingEffort): OpenAIResponsesChatProvider {
    // 'on' sends no effort field; 'off' sends the model's declared off value
    // (e.g. 'none') when one is configured, and omits the field otherwise.
    const reasoningEffort =
      effort === 'off' ? this._offEffort : effort === 'on' ? undefined : effort;
    const clone = this._clone();
    clone._generationKwargs = {
      ...clone._generationKwargs,
      reasoning_effort: reasoningEffort,
    };
    return clone;
  }

  withGenerationKwargs(kwargs: OpenAIResponsesGenerationKwargs): OpenAIResponsesChatProvider {
    const clone = this._clone();
    clone._generationKwargs = { ...clone._generationKwargs, ...kwargs };
    return clone;
  }

  withMaxCompletionTokens(maxCompletionTokens: number): OpenAIResponsesChatProvider {
    return this.withGenerationKwargs({ max_output_tokens: maxCompletionTokens });
  }

  private _clone(): OpenAIResponsesChatProvider {
    const clone = Object.assign(
      Object.create(Object.getPrototypeOf(this) as object) as OpenAIResponsesChatProvider,
      this,
    );
    clone._generationKwargs = { ...this._generationKwargs };
    return clone;
  }

  private _createClient(auth: ProviderRequestAuth | undefined): OpenAI {
    return resolveAuthBackedClient(
      { cachedClient: this._client, clientFactory: this._clientFactory },
      auth,
      (a) =>
        this._buildClient(requireProviderApiKey('OpenAIResponsesChatProvider', a, this._apiKey), a),
    );
  }

  private _buildClient(apiKey: string, auth?: ProviderRequestAuth): OpenAI {
    const clientOpts: Record<string, unknown> = {
      apiKey,
      baseURL: this._baseUrl,
    };
    const defaultHeaders = mergeRequestHeaders(this._defaultHeaders, auth?.headers);
    if (defaultHeaders !== undefined) {
      clientOpts['defaultHeaders'] = defaultHeaders;
    }
    if (this._httpClient !== undefined) {
      clientOpts['httpClient'] = this._httpClient;
    }
    return new OpenAI(clientOpts as ConstructorParameters<typeof OpenAI>[0]);
  }
}
