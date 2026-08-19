/**
 * `toolResultTruncation` domain — `IAgentToolResultTruncationService` implementation.
 *
 * Persists complete oversized text tool results through `storage`, addressed
 * under the current `scopeContext` agent root, and renders a model-visible
 * preview with an absolute file path rooted at `bootstrap.homeDir`. Bound at
 * Agent scope.
 */

import { randomUUID } from 'node:crypto';
import { LifecycleScope } from '#/app/scopes';
import { ScopeActivation, registerScopedService } from '#/_base/di/scope';
import { IAgentScopeContext } from '#/agent/scopeContext/scopeContext';
import type { ExecutableToolResult } from '#/tool/toolContract';
import { IBootstrapService } from '#/app/bootstrap/bootstrap';
import type { ContentPart, Message } from '#/kosong/contract/message';
import { IFileSystemStorageService } from '#/persistence/interface/storage';
import { join } from 'pathe';
import {
  IAgentToolResultTruncationService,
  type ToolResultTruncationInput,
} from './toolResultTruncation';

const TOOL_RESULT_MAX_CHARS = 50_000;
const TOOL_RESULT_PREVIEW_CHARS = 2_000;

/** Aggregate budget for all tool results in one request; older results are
 *  persisted to storage when the combined text exceeds this. */
const TOOL_RESULT_AGGREGATE_MAX_CHARS = 120_000;

/** Age (ms) past which a whitelisted tool result is cleared from requests. */
const STALE_TOOL_RESULT_GAP_MS = 60 * 60 * 1000;

const STALE_TOOL_RESULT_TEXT = '[Old tool result content cleared]';

const COMPACTABLE_TOOLS = new Set([
  'Read',
  'Bash',
  'Grep',
  'Glob',
  'WebSearch',
  'WebFetch',
  'Edit',
  'Write',
]);

const encoder = new TextEncoder();

export class ToolResultTruncationService implements IAgentToolResultTruncationService {
  declare readonly _serviceBrand: undefined;

  private readonly storageScope: string;
  private readonly resultTimes = new Map<string, number>();
  private readonly persistedPreviewCache = new Map<string, string>();
  /** Total text length of the messages last scanned by `applyToolResultBudget`
   *  (-1 = never scanned). When the length is unchanged the whole scan is
   *  short-circuited; any context spliced/append changes it and invalidates. */
  private lastScannedLength = -1;

  constructor(
    @IBootstrapService private readonly bootstrap: IBootstrapService,
    @IAgentScopeContext agent: IAgentScopeContext,
    @IFileSystemStorageService private readonly storage: IFileSystemStorageService,
  ) {
    this.storageScope = agent.scope('tool-results');
  }

  async truncateForModel<T extends ExecutableToolResult>(
    input: ToolResultTruncationInput<T>,
  ): Promise<T> {
    const text = persistableToolResultText(input.result.output);
    if (text === undefined || text.length <= TOOL_RESULT_MAX_CHARS) return input.result;
    if (input.result.truncated === true) return input.result;

    const saved = await this.saveToolResult(input.toolName, input.toolCallId, text);
    if (saved === undefined) return input.result;

    return {
      ...input.result,
      output: renderPersistedToolResult(input.toolName, input.toolCallId, text, saved.outputPath),
      truncated: true,
    } as T;
  }

  noteResultTime(toolCallId: string, now: number = Date.now()): void {
    this.resultTimes.set(toolCallId, now);
  }

  async applyToolResultBudget(messages: readonly Message[]): Promise<readonly Message[]> {
    // Dirty-check: when the combined text length is unchanged since the last
    // scan the budget decision is unchanged too, so skip the whole scan. Every
    // context spliced/append changes the length and invalidates this marker; a
    // same-length rewrite of an already-scanned result is intentionally left
    // untouched this round (the persisted previews still apply next length bump).
    const length = messagesTotalLength(messages);
    if (length === this.lastScannedLength) return messages;
    this.lastScannedLength = length;

    // Build the tool-name lookup once instead of per tool message (was O(K*M)
    // over all assistant tool calls for every tool result).
    const names = toolNamesByCall(messages);
    const entries: ToolResultEntry[] = [];
    let total = 0;
    messages.forEach((message, index) => {
      if (message.role !== 'tool') return;
      const text = toolMessageText(message);
      if (text === undefined || isPersistedPreviewText(text)) return;
      entries.push({
        index,
        toolCallId: message.toolCallId,
        text,
        toolName:
          message.toolCallId === undefined ? undefined : names.get(message.toolCallId),
      });
      total += text.length;
    });
    if (total <= TOOL_RESULT_AGGREGATE_MAX_CHARS) return messages;

    let out: Message[] | undefined;
    for (const entry of entries) {
      if (total <= TOOL_RESULT_AGGREGATE_MAX_CHARS) break;
      const preview = this.previewFor(entry.toolName, entry.toolCallId, entry.text);
      if (preview === undefined) continue;
      total -= entry.text.length - preview.length;
      // Copy the array once, then swap entries in place — avoids re-mapping the
      // whole array per over-budget result (was O(M) per replaced entry).
      out ??= [...messages];
      out[entry.index] = {
        ...messages[entry.index]!,
        content: [{ type: 'text' as const, text: preview }],
      };
    }
    return out ?? messages;
  }

  clearStaleToolResults(messages: readonly Message[], now: number = Date.now()): readonly Message[] {
    const names = toolNamesByCall(messages);
    const stale: number[] = [];
    messages.forEach((message, index) => {
      if (message.role !== 'tool' || message.toolCallId === undefined) return;
      const name = names.get(message.toolCallId);
      if (name === undefined || !COMPACTABLE_TOOLS.has(name)) return;
      const recordedAt = this.resultTimes.get(message.toolCallId);
      if (recordedAt === undefined || now - recordedAt < STALE_TOOL_RESULT_GAP_MS) return;
      stale.push(index);
    });
    if (stale.length <= 1) return messages;
    const keepIndex = stale.at(-1)!;
    return messages.map((message, index) => {
      if (index === keepIndex || !stale.includes(index)) return message;
      return { ...message, content: [{ type: 'text', text: STALE_TOOL_RESULT_TEXT }] };
    });
  }

  /** Renders the recoverable preview for an oversized result and starts its
   *  persistence without blocking the send path. The write is fire-and-forget:
   *  the model sees the preview this round while the file lands on disk in the
   *  background. A reader racing the write, or a failed write, leaves a briefly
   *  dangling `output_path` — an accepted trade-off for removing the only real
   *  I/O from the send path. Previews are memoized per tool call. */
  private previewFor(
    toolName: string | undefined,
    toolCallId: string | undefined,
    text: string,
  ): string | undefined {
    if (toolCallId === undefined) return undefined;
    const cached = this.persistedPreviewCache.get(toolCallId);
    if (cached !== undefined) return cached;
    const name = toolName ?? 'tool';
    const outputPath = this.startToolResultWrite(name, toolCallId, text);
    const preview = renderPersistedToolResult(name, toolCallId, text, outputPath);
    this.persistedPreviewCache.set(toolCallId, preview);
    return preview;
  }

  /** Persists the result in the background and returns the deterministic output
   *  path immediately. Intentionally not awaited — storage I/O is the only real
   *  I/O on the send path. The write still runs to completion, independent of
   *  any abort, exactly like the awaited path; failures are swallowed. */
  private startToolResultWrite(toolName: string, toolCallId: string, text: string): string {
    const key = `${safeToolResultFileStem(toolName, toolCallId)}-${randomUUID()}.txt`;
    const outputPath = join(this.bootstrap.homeDir, this.storageScope, key);
    void this.writeToolResultFile(key, text).catch(() => undefined);
    return outputPath;
  }

  private async saveToolResult(
    toolName: string,
    toolCallId: string,
    text: string,
  ): Promise<{ readonly outputPath: string } | undefined> {
    const key = `${safeToolResultFileStem(toolName, toolCallId)}-${randomUUID()}.txt`;
    try {
      await this.writeToolResultFile(key, text);
      return { outputPath: join(this.bootstrap.homeDir, this.storageScope, key) };
    } catch {
      return undefined;
    }
  }

  private async writeToolResultFile(key: string, text: string): Promise<void> {
    await this.storage.write(this.storageScope, key, encoder.encode(text), { atomic: true });
  }
}

interface ToolResultEntry {
  readonly index: number;
  readonly toolCallId: string | undefined;
  readonly toolName: string | undefined;
  readonly text: string;
}

function toolNamesByCall(messages: readonly Message[]): Map<string, string> {
  const names = new Map<string, string>();
  for (const message of messages) {
    if (message.role !== 'assistant') continue;
    for (const call of message.toolCalls) names.set(call.id, call.name);
  }
  return names;
}

function toolMessageText(message: Message): string | undefined {
  if (message.content.length === 0) return undefined;
  if (message.content.some((part) => part.type !== 'text')) return undefined;
  return message.content.map((part) => (part as Extract<ContentPart, { type: 'text' }>).text).join('');
}

/** Cheap dirty-marker fingerprint: total text length of every message, computed
 *  in a single allocation-free pass. Any context spliced/append changes it. */
function messagesTotalLength(messages: readonly Message[]): number {
  let sum = 0;
  for (const message of messages) {
    for (const part of message.content) {
      if (part.type === 'text') sum += part.text.length;
    }
  }
  return sum;
}

function isPersistedPreviewText(text: string): boolean {
  return text.startsWith('Tool output exceeded') || text.includes('next_step: Use Read with output_path');
}

function persistableToolResultText(output: ExecutableToolResult['output']): string | undefined {
  if (typeof output === 'string') return output;
  if (
    !output.every((part): part is Extract<ContentPart, { type: 'text' }> => part.type === 'text')
  ) {
    return undefined;
  }
  return output.map((part) => part.text).join('');
}

function renderPersistedToolResult(
  toolName: string,
  toolCallId: string,
  text: string,
  outputPath: string,
): string {
  const lines = [
    `Tool output exceeded ${String(TOOL_RESULT_MAX_CHARS)} characters; showing a preview only.`,
    `tool_name: ${toolName}`,
    `tool_call_id: ${toolCallId}`,
    `output_size_chars: ${String(text.length)}`,
    `output_size_bytes: ${String(Buffer.byteLength(text, 'utf8'))}`,
    `output_path: ${outputPath}`,
    'next_step: Use Read with output_path to page through the full output.',
    '',
    '[preview]',
    text.slice(0, TOOL_RESULT_PREVIEW_CHARS),
  ];
  return lines.join('\n');
}

function safeToolResultFileStem(toolName: string, toolCallId: string): string {
  const label = `${toolName}-${toolCallId}`
    .replace(/[^a-zA-Z0-9._-]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 80);
  return label || 'tool-result';
}

registerScopedService(
  LifecycleScope.Agent,
  IAgentToolResultTruncationService,
  ToolResultTruncationService,
  ScopeActivation.OnScopeCreated,
  'toolResultTruncation',
);
