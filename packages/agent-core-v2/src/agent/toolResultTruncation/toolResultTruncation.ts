/**
 * `toolResultTruncation` domain — model-context truncation contract for tool results.
 *
 * Defines the Agent-scoped service that runs after tool execution hooks and
 * before a result is recorded into model-visible context. It preserves complete
 * oversized text results through agent-scoped storage, replacing the inline
 * payload with a recoverable preview and `output_path`. Pure contract; the
 * implementation owns persistence through the storage backend.
 */

import { createDecorator, type ServiceIdentifier } from '#/_base/di/instantiation';
import type { Message } from '#/kosong/contract/message';
import type { ExecutableToolResult } from '#/tool/toolContract';

export interface ToolResultTruncationInput<
  T extends ExecutableToolResult = ExecutableToolResult,
> {
  readonly toolName: string;
  readonly toolCallId: string;
  readonly result: T;
}

export interface IAgentToolResultTruncationService {
  readonly _serviceBrand: undefined;

  truncateForModel<T extends ExecutableToolResult>(
    input: ToolResultTruncationInput<T>,
  ): Promise<T>;

  /** Records when a tool result ran so request-time compacting can clear stale
   *  results without an LLM pass. */
  noteResultTime?(toolCallId: string, now?: number): void;

  /** Request-time aggregate tool-result budget: when the combined text of the
   *  request's tool results exceeds the budget, persists the oldest results to
   *  storage and swaps in recoverable previews. Persistence is fire-and-forget:
   *  the write is not awaited on the send path, so the preview applies this
   *  round while the backing file lands on disk in the background. */
  applyToolResultBudget?(messages: readonly Message[]): Promise<readonly Message[]>;

  /** Request-time time-based compact: replaces whitelisted tool results older
   *  than the gap threshold — keeping the most recent one — with a cleared
   *  placeholder (zero LLM). */
  clearStaleToolResults?(messages: readonly Message[], now?: number): readonly Message[];
}

export const IAgentToolResultTruncationService: ServiceIdentifier<
  IAgentToolResultTruncationService
> = createDecorator<IAgentToolResultTruncationService>('agentToolResultTruncationService');
