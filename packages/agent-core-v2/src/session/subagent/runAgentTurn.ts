/**
 * `subagent` domain — helper that runs one prompt (or retry) turn on
 * an agent and distills a summary from its context once the turn ends.
 *
 * Not a Service: `runAgentTurn` is a pure function that borrows
 * `IAgentPromptService`, `IAgentContextMemoryService`, `IAgentUsageService`,
 * and `IEventBus` from the target agent's scope. It has no notion of a caller:
 * it emits no record signals, runs no hooks, and tracks no telemetry.
 *
 * The lifecycle is imperative — the caller awaits the returned `completion`
 * promise. Turn hooks are not used because there is exactly one observer (the
 * caller who requested the run); a hook indirection would only obscure the
 * flow. Usage snapshots are taken before prompt enqueueing so synchronous
 * prompt work is included in the reported child delta.
 */

import { APIProviderRateLimitError, isProviderRateLimitError } from '#/kosong/contract/errors';
import { type TokenUsage } from '#/kosong/contract/usage';

import { linkAbortSignal, userCancellationReason } from '#/_base/utils/abort';
import type { IAgentScopeHandle } from '#/_base/di/scope';
import type { IDisposable } from '#/_base/di/lifecycle';
import { IAgentContextMemoryService } from '#/agent/contextMemory/contextMemory';
import type { ContextMessage, PromptOrigin } from '#/agent/contextMemory/types';
import { Error2, ErrorCodes, toKimiErrorPayload, type KimiErrorPayload } from '#/errors';
import { IAgentPromptService } from '#/agent/prompt/prompt';
import { IAgentLoopService, type Turn, type TurnResult } from '#/agent/loop/loop';
import { IAgentUsageService } from '#/agent/usage/usage';
import type { AgentProfileSummaryPolicy } from '#/app/agentProfileCatalog/agentProfileCatalog';
import { IAgentProfileService } from '#/agent/profile/profile';
import { IAgentToolRegistryService } from '#/agent/toolRegistry/toolRegistry';
import {
  STRUCTURED_OUTPUT_TOOL_NAME,
  StructuredOutputTool,
  StructuredOutputValidationError,
} from '#/agent/workflow/structured/structuredOutputTool';

import type { AgentRunHandle, AgentRunRequest } from './subagent';

export const AGENT_RUN_PROMPT_ORIGIN: PromptOrigin = {
  kind: 'system_trigger',
  name: 'subagent',
};

export interface RunAgentTurnOptions {
  readonly summaryPolicy?: AgentProfileSummaryPolicy;
  readonly signal: AbortSignal;
  readonly onReady?: () => void;
  readonly requiresStructuredOutput?: boolean;
  readonly structuredSchema?: Record<string, unknown>;
}

/** A structured-output turn's registered tool + its disposal handles. */
interface StructuredOutputTurn {
  readonly tool: StructuredOutputTool;
  readonly registration: IDisposable;
  /** Revokes the ephemeral active-tool overlay granted for this turn. */
  readonly deactivate: () => void;
}

export async function runAgentTurn(
  target: IAgentScopeHandle,
  request: AgentRunRequest,
  options: RunAgentTurnOptions,
): Promise<AgentRunHandle> {
  options.signal.throwIfAborted();
  const usageBefore = target.accessor.get(IAgentUsageService)?.status().total;
  const structured = setupStructuredOutput(target, options);
  const promptService = target.accessor.get(IAgentPromptService);
  let turn: Turn | undefined;
  try {
    turn =
      request.kind === 'prompt'
        ? await (await promptService.enqueue({ message: {
            role: 'user',
            content: [{ type: 'text', text: request.prompt }],
            toolCalls: [],
            origin: AGENT_RUN_PROMPT_ORIGIN,
          } })).launched
        : await promptService.retry();
  } catch (error) {
    structured?.registration.dispose();
    structured?.deactivate();
    throw error;
  }
  if (turn === undefined) {
    structured?.registration.dispose();
    structured?.deactivate();
    throw new Error2(ErrorCodes.INTERNAL, 'Agent turn could not be started');
  }

  if (options.onReady !== undefined) {
    void turn.ready.then(() => options.onReady?.()).catch(() => {});
  }

  const completion = awaitRun(target, turn, options, structured, usageBefore);
  const tracked = completion.finally(() => {
    structured?.registration.dispose();
    structured?.deactivate();
  });
  return { agentId: target.id, turn, completion: tracked };
}

/**
 * Register the `StructuredOutput` tool on the target agent when a structured
 * result is requested. `requiresStructuredOutput` is an explicit driver
 * request (workflow `agent({ schema })`), so the tool is injected regardless
 * of the target profile's static tool policy — gating on the policy would
 * silently downgrade structured mode to plain text for profiles whose tool
 * table does not list the engine-internal `StructuredOutput` tool.
 *
 * Registration alone does not surface the tool to the model: the request tool
 * table (`toolSelect.shapeTools`) and the executor's preflight guard both
 * filter against the profile's active-tool policy, and agent profiles never
 * list the engine-internal `StructuredOutput`. The turn therefore also grants
 * the tool as an ephemeral active-tool overlay (revoked via `deactivate`),
 * so the model can actually call it and the structured result round-trips.
 */
export function setupStructuredOutput(
  target: IAgentScopeHandle,
  options: RunAgentTurnOptions,
): StructuredOutputTurn | undefined {
  if (options.requiresStructuredOutput !== true) return undefined;
  if (options.structuredSchema === undefined) return undefined;
  const tool = new StructuredOutputTool(options.structuredSchema);
  const registry = target.accessor.get(IAgentToolRegistryService);
  const registration = registry.register(tool);
  const profile = target.accessor.get(IAgentProfileService);
  profile.addActiveTool(STRUCTURED_OUTPUT_TOOL_NAME);
  return {
    tool,
    registration,
    deactivate: () => profile.removeActiveTool(STRUCTURED_OUTPUT_TOOL_NAME),
  };
}

async function awaitRun(
  target: IAgentScopeHandle,
  turn: Turn,
  options: RunAgentTurnOptions,
  structured: StructuredOutputTurn | undefined,
  usageBefore: TokenUsage | undefined,
): Promise<{ summary: string; output?: unknown; usage?: TokenUsage }> {
  const controller = new AbortController();
  const unlink = linkAbortSignal(options.signal, controller);
  const loop = target.accessor.get(IAgentLoopService);
  const completion = (output: unknown): { summary: string; output: unknown; usage?: TokenUsage } => {
    const usage = usageSince(usageBefore, target.accessor.get(IAgentUsageService)?.status().total);
    return { summary: stringifyStructuredValue(output), output, usage };
  };
  const cancelTurn = (turnToCancel: Turn, reason: unknown): void => {
    loop.cancel(turnToCancel.id, reason);
  };
  let turnRef: Turn = turn;
  try {
    const result = await awaitTurn(turnRef, controller, cancelTurn);
    classifyTurnResult(result);
    if (structured !== undefined && structured.tool.validated) {
      return completion(structured.tool.value);
    }
    if (structured !== undefined && structured.tool.retryable) {
      await retryStructuredOutput(
        target,
        controller,
        structured,
        (t) => {
          turnRef = t;
        },
        cancelTurn,
      );
      if (structured.tool.validated) return completion(structured.tool.value);
      throw new StructuredOutputValidationError(
        'Structured output was not produced after the retry limit.',
        structured.tool.errors,
        usageSince(usageBefore, target.accessor.get(IAgentUsageService)?.status().total),
      );
    }
    if (structured !== undefined) {
      throw new StructuredOutputValidationError(
        'Structured output could not be validated because its schema is invalid.',
        structured.tool.errors,
        usageSince(usageBefore, target.accessor.get(IAgentUsageService)?.status().total),
      );
    }
    const summary = await distillSummary(
      target,
      controller,
      options.summaryPolicy,
      (t) => {
        turnRef = t;
      },
      cancelTurn,
    );
    const usage = usageSince(usageBefore, target.accessor.get(IAgentUsageService)?.status().total);
    return { summary, usage };
  } finally {
    unlink();
    if (controller.signal.aborted) {
      cancelTurn(turnRef, controller.signal.reason);
    }
  }
}

function stringifyStructuredValue(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value === undefined || value === null) return '';
  return JSON.stringify(value);
}

function usageSince(before: TokenUsage | undefined, after: TokenUsage | undefined): TokenUsage | undefined {
  if (after === undefined) return undefined;
  if (before === undefined) return after;
  return {
    inputOther: Math.max(0, after.inputOther - before.inputOther),
    output: Math.max(0, after.output - before.output),
    inputCacheRead: Math.max(0, after.inputCacheRead - before.inputCacheRead),
    inputCacheCreation: Math.max(0, after.inputCacheCreation - before.inputCacheCreation),
  };
}

/** Cap on driver-initiated structured-output retry rounds (continuation turns). */
const STRUCTURED_RETRY_LIMIT = 3;

/**
 * Drive additional continuation turns (reusing the same enqueue-a-user-message
 * channel as the summary policy) until the model produces a schema-valid
 * `StructuredOutput` value. The caller owns the terminal failure when every
 * retry round settles without a valid value.
 */
async function retryStructuredOutput(
  target: IAgentScopeHandle,
  controller: AbortController,
  structured: StructuredOutputTurn,
  setTurn: (turn: Turn) => void,
  cancelTurn: (turn: Turn, reason: unknown) => void,
): Promise<void> {
  const promptService = target.accessor.get(IAgentPromptService);
  for (let attempt = 0; attempt < STRUCTURED_RETRY_LIMIT; attempt++) {
    if (structured.tool.validated) break;
    // Each round gets a fresh in-tool retry budget so earlier misses do not
    // exhaust the tool's own cap before the model is re-prompted.
    structured.tool.resetRetryBudget();
    const turn = await (await promptService.enqueue({ message: {
      role: 'user',
      content: [{ type: 'text', text: structuredRetryPrompt(structured.tool) }],
      toolCalls: [],
      origin: AGENT_RUN_PROMPT_ORIGIN,
    } })).launched;
    if (turn === undefined) break;
    setTurn(turn);
    const result = await awaitTurn(turn, controller, cancelTurn);
    classifyTurnResult(result);
  }
}

function structuredRetryPrompt(tool: StructuredOutputTool): string {
  const errors = tool.errors;
  const detail =
    errors.length > 0 ? errors.join('; ') : 'the value did not satisfy the declared JSON schema';
  return [
    'Your run ended without producing a valid StructuredOutput value.',
    `Validation errors recorded: ${detail}`,
    'Call StructuredOutput exactly once with `result` set to a value satisfying the declared JSON schema.',
    'Resume directly — no apology, no recap, no preamble.',
  ].join('\n');
}

async function awaitTurn(
  turn: Turn,
  controller: AbortController,
  cancelTurn: (turn: Turn, reason: unknown) => void,
): Promise<TurnResult> {
  const cancelOnAbort = (): void => {
    cancelTurn(turn, controller.signal.reason);
  };
  controller.signal.addEventListener('abort', cancelOnAbort, { once: true });
  try {
    if (controller.signal.aborted) {
      cancelOnAbort();
    }
    const result = await turn.result;
    controller.signal.throwIfAborted();
    return result;
  } finally {
    controller.signal.removeEventListener('abort', cancelOnAbort);
  }
}

async function distillSummary(
  target: IAgentScopeHandle,
  controller: AbortController,
  policy: AgentProfileSummaryPolicy | undefined,
  setTurn: (turn: Turn) => void,
  cancelTurn: (turn: Turn, reason: unknown) => void,
): Promise<string> {
  const memory = target.accessor.get(IAgentContextMemoryService);
  let summary = composeTurnSummary(memory.get());
  if (policy === undefined) return summary;
  if (isSummaryAdequate(summary, policy)) return summary;

  const promptService = target.accessor.get(IAgentPromptService);
  for (let attempt = 0; attempt < policy.retries; attempt++) {
    const turn = await (await promptService.enqueue({ message: {
      role: 'user',
      content: [{ type: 'text', text: policy.continuationPrompt }],
      toolCalls: [],
      origin: AGENT_RUN_PROMPT_ORIGIN,
    } })).launched;
    if (turn === undefined) break;
    setTurn(turn);
    const result = await awaitTurn(turn, controller, cancelTurn);
    classifyTurnResult(result);
    const continued = composeTurnSummary(memory.get());
    if (continued.trim().length > 0) summary = continued;
    if (isSummaryAdequate(summary, policy)) break;
  }
  return summary;
}

function isSummaryAdequate(summary: string, policy: AgentProfileSummaryPolicy): boolean {
  return summary.trim().length >= policy.minChars;
}

function classifyTurnResult(result: TurnResult): void {
  switch (result.type) {
    case 'completed':
      // Truncation is already self-healed by the loop's bounded recovery chain
      // (recoverTruncation: maxOutputSize escalation + `Resume directly` rounds,
      // capped per turn and across turns). By the time a turn settles truncated
      // every recovery cap is exhausted — accept the partial output as a
      // best-effort completion so the subagent returns its result instead of
      // failing outright. A subagent run's prompt goes through the same loop,
      // so no extra resume round is triggered here to avoid double handling.
      return;
    case 'failed': {
      const error = result.error;
      if (isProviderRateLimitError(error)) throw error;
      const payload = toKimiErrorPayload(error);
      if (payload.code === ErrorCodes.PROVIDER_RATE_LIMIT) {
        throw providerRateLimitErrorFromPayload(payload);
      }
      throw toRunError(error);
    }
    case 'cancelled':
      throw toRunError(result.reason ?? userCancellationReason());
  }
}

function toRunError(error: unknown): Error {
  if (error instanceof Error) return error;
  if (error === undefined || error === null) return new Error('Agent turn failed');
  return new Error(stringifyRunError(error));
}

function stringifyRunError(value: unknown): string {
  if (typeof value === 'string') return value;
  return String(value);
}

function providerRateLimitErrorFromPayload(error: KimiErrorPayload): APIProviderRateLimitError {
  const requestId =
    typeof error.details?.['requestId'] === 'string' ? error.details['requestId'] : null;
  return new APIProviderRateLimitError(error.message, requestId);
}

function latestAssistantText(messages: readonly ContextMessage[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i]!;
    if (message.role !== 'assistant') continue;
    return contentText(message.content);
  }
  return '';
}

/** Cap on tool-result blocks appended to a composed summary. */
const TURN_SUMMARY_RESULT_BLOCKS = 3;
/** Per-block char cap in a composed summary. */
const TURN_SUMMARY_RESULT_CHARS = 800;
/** Total char cap for a composed summary. */
const TURN_SUMMARY_TOTAL_CHARS = 4_000;

/**
 * Compose the subagent's handoff summary from its last assistant message plus
 * the tail-most structured step results (tool outputs) that informed it —
 * rather than only the final assistant text, which can be a bare tool call or
 * a truncated tail. Final text first (the headline), then step results.
 */
function composeTurnSummary(messages: readonly ContextMessage[]): string {
  const parts: string[] = [];
  const finalText = latestAssistantText(messages).trim();
  if (finalText.length > 0) parts.push(finalText);
  let blocks = 0;
  for (let i = messages.length - 1; i >= 0 && blocks < TURN_SUMMARY_RESULT_BLOCKS; i--) {
    const message = messages[i]!;
    if (message.role !== 'tool') continue;
    const output = contentText(message.content).trim();
    if (output.length === 0) continue;
    blocks += 1;
    parts.push(`[step result]\n${clip(output, TURN_SUMMARY_RESULT_CHARS)}`);
  }
  return clip(parts.join('\n\n'), TURN_SUMMARY_TOTAL_CHARS);
}

function clip(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max)}...`;
}

function contentText(content: ContextMessage['content']): string {
  if (typeof content === 'string') return content;
  return content
    .filter((part): part is Extract<(typeof content)[number], { type: 'text' }> => part.type === 'text')
    .map((part) => part.text)
    .join('');
}
