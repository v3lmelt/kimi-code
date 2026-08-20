/**
 * `kosong/contract` domain — wire message shapes and their pure helpers.
 *
 * `Message` / `ContentPart` / `ToolCall` are the provider-agnostic wire
 * content every protocol base encodes from and decodes into. The helpers
 * cover the whole lifecycle: construction (`create*Message`), inspection
 * (`is*` / `extractText`), and stream merge (`mergeInPlace` folds streamed
 * deltas into the pending part).
 *
 * Pure types and pure functions only — no other domain, no I/O, no SDKs.
 */

import type { Tool } from './tool';
import type { TokenUsage } from './usage';

export type Role = 'system' | 'user' | 'assistant' | 'tool';

export interface TextPart {
  type: 'text';
  text: string;
}

export interface ThinkPart {
  type: 'think';
  think: string;
  encrypted?: string;
}

export interface ImageURLPart {
  type: 'image_url';
  imageUrl: { url: string; id?: string };
}

export interface AudioURLPart {
  type: 'audio_url';
  audioUrl: { url: string; id?: string };
}

export interface VideoURLPart {
  type: 'video_url';
  videoUrl: { url: string; id?: string | undefined };
}

export type ContentPart = TextPart | ThinkPart | ImageURLPart | AudioURLPart | VideoURLPart;

export interface ToolCall {
  type: 'function';
  id: string;
  name: string;
  arguments: string | null;
  extras?: Record<string, unknown>;
  _streamIndex?: number | string;
}

export interface ToolCallPart {
  type: 'tool_call_part';
  argumentsPart: string | null;
  index?: number | string;
}

export interface UsagePart {
  type: 'usage';
  usage: TokenUsage;
}

export interface HostedSearchSource {
  type?: 'url';
  url: string;
  title?: string;
}

export type HostedSearchAction =
  | { type: 'search'; query?: string; queries?: string[]; sources?: HostedSearchSource[] }
  | { type: 'open_page'; url?: string }
  | { type: 'find_in_page'; url?: string; pattern?: string };

export type HostedSearchLifecycle = 'in_progress' | 'searching' | 'completed' | 'failed';

export interface HostedSearchEvent {
  callId?: string;
  status?: HostedSearchLifecycle;
  action?: HostedSearchAction;
  sources?: HostedSearchSource[];
}

export type HostedSearchPart =
  | { type: 'hosted_search_source'; source: HostedSearchSource; callId?: string }
  | { type: 'hosted_search_action'; action: HostedSearchAction; callId?: string }
  | {
      type: 'hosted_search_lifecycle';
      status: HostedSearchLifecycle;
      action?: HostedSearchAction;
      sources?: HostedSearchSource[];
      callId?: string;
    };

export interface HostedSearchCitation {
  type: 'url_citation';
  startIndex: number;
  endIndex: number;
  title?: string;
  url: string;
  citationText?: string;
}

export type UrlCitationPart = HostedSearchCitation;

export type StreamedMessagePart =
  | ContentPart
  | ToolCall
  | ToolCallPart
  | UsagePart
  | HostedSearchPart
  | UrlCitationPart;

export interface Message {
  readonly role: Role;
  readonly name?: string;
  readonly content: ContentPart[];
  readonly toolCalls: ToolCall[];
  readonly toolCallId?: string;
  readonly partial?: boolean;
  readonly annotations?: readonly HostedSearchCitation[];
  readonly searchMetadata?: readonly HostedSearchEvent[];
  readonly tools?: readonly Tool[];
}

export function isContentPart(part: StreamedMessagePart): part is ContentPart {
  const t = part.type;
  return (
    t === 'text' || t === 'think' || t === 'image_url' || t === 'audio_url' || t === 'video_url'
  );
}

export function isToolDeclarationOnlyMessage(message: Message): boolean {
  return (
    message.tools !== undefined &&
    message.tools.length > 0 &&
    message.content.length === 0 &&
    message.toolCalls.length === 0
  );
}

export function isToolCall(part: StreamedMessagePart): part is ToolCall {
  return part.type === 'function';
}

export function isToolCallPart(part: StreamedMessagePart): part is ToolCallPart {
  return part.type === 'tool_call_part';
}

export function isUsagePart(part: StreamedMessagePart): part is UsagePart {
  return part.type === 'usage';
}

export function isHostedSearchPart(part: StreamedMessagePart): part is HostedSearchPart {
  return (
    part.type === 'hosted_search_source' ||
    part.type === 'hosted_search_action' ||
    part.type === 'hosted_search_lifecycle'
  );
}

export function isUrlCitationPart(part: StreamedMessagePart): part is UrlCitationPart {
  return part.type === 'url_citation';
}

export function mergeInPlace(target: StreamedMessagePart, source: StreamedMessagePart): boolean {
  if (target.type === 'text' && source.type === 'text') {
    target.text += source.text;
    return true;
  }

  if (target.type === 'think' && source.type === 'think') {
    if (target.encrypted !== undefined) {
      return false;
    }
    target.think += source.think;
    if (source.encrypted !== undefined) {
      target.encrypted = source.encrypted;
    }
    return true;
  }

  if (target.type === 'function' && source.type === 'tool_call_part') {
    if (source.argumentsPart !== null) {
      target.arguments =
        target.arguments === null
          ? source.argumentsPart
          : target.arguments + source.argumentsPart;
    }
    return true;
  }

  return false;
}

export function extractText(message: Message, sep: string = ''): string {
  return message.content
    .filter((part): part is TextPart => part.type === 'text')
    .map((part) => part.text)
    .join(sep);
}

export function getTextContent(message: Message): string {
  return extractText(message);
}

export function createUserMessage(content: string): Message {
  return {
    role: 'user',
    content: [{ type: 'text', text: content }],
    toolCalls: [],
  };
}

export function createAssistantMessage(content: ContentPart[], toolCalls?: ToolCall[]): Message {
  return {
    role: 'assistant',
    content,
    toolCalls: toolCalls ?? [],
  };
}

export function createToolMessage(toolCallId: string, output: string | ContentPart[]): Message {
  const content: ContentPart[] =
    typeof output === 'string' ? [{ type: 'text', text: output }] : output;
  return {
    role: 'tool',
    content,
    toolCalls: [],
    toolCallId,
  };
}
