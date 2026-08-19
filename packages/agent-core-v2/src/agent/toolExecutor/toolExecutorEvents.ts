/**
 * `toolExecutor` domain — the `tool.call.*` / `tool.progress` / `tool.result`
 * event payloads published through `IEventBus` as tool calls execute.
 */

import type { ToolUpdate } from '#/tool/toolContract';
import type { ToolInputDisplay } from '#/tool/toolInputDisplay';

export interface ToolCallStartedEvent {
  readonly type: 'tool.call.started';
  readonly turnId: number;
  readonly toolCallId: string;
  readonly name: string;
  readonly args: unknown;
  readonly description?: string;
  readonly display?: ToolInputDisplay;
}

export interface ToolProgressEvent {
  readonly type: 'tool.progress';
  readonly turnId: number;
  readonly toolCallId: string;
  readonly update: ToolUpdate;
}

export interface ToolResultEvent {
  readonly type: 'tool.result';
  readonly turnId: number;
  readonly toolCallId: string;
  /**
   * Truncated preview of the tool output for the UI. The full output is kept
   * only on the model-context / persisted-loop-event paths, never on the bus.
   */
  readonly uiPreview: string;
  /** Whether `uiPreview` was clipped from a larger output. */
  readonly truncated?: boolean;
  readonly isError?: boolean;
  readonly synthetic?: boolean;
  /** @deprecated alias of `uiPreview` kept for existing consumers. */
  readonly output: string;
}

declare module '#/app/event/eventBus' {
  interface DomainEventMap {
    'tool.call.started': ToolCallStartedEvent;
    'tool.result': ToolResultEvent;
    'tool.progress': ToolProgressEvent;
  }
}
