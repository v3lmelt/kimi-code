/**
 * `llmRequester` domain — `IAgentLLMRequesterService` implementation.
 *
 * Assembles per-turn `ModelRequestInput` from `profile` (system prompt),
 * `contextMemory` + `contextProjector` (history), `toolRegistry` (tools), and
 * `toolSelect` (progressive-disclosure shaping of the tool and history views),
 * folds the completion-token budget into the profile's dialect-free intent
 * params, then drives a bounded request chain through the `ModelRequester`
 * resolved from `IModelCatalog`: one primary `requester.request(input, signal,
 * params)` attempt plus projection rebuilds for request structure or media
 * compatibility. Before each request the projected messages pass through `media`'s
 * video resolver, which rewrites every `kimi-file://` prompt-video reference
 * to a provider-acceptable part (uploaded `ms://`, inline base64, or a
 * `<video path>` tag) so the internal reference never reaches the wire. When a
 * model is configured, `prepareTurnConfig` snapshots the
 * model, effective thinking effort, and system prompt at the turn boundary
 * so loop telemetry and every request in that turn share one configuration.
 * Forwards streamed `part` events to the caller's `onPart`
 * handler, records `usage` through `IAgentUsageService`, resolves to an
 * `AgentLLMRequestFinish` on the `finish` event, logs the request lifecycle
 * (config deduplicated by content, request/response/failure lines, plus
 * per-request fields) through `log`, publishes advisory model-capability
 * warnings through `eventBus`, records durable request-trace Ops
 * through `wire`, reports each request's `x-trace-id` to its caller, and
 * reports provider failures through `telemetry`. The mutable request state
 * (`lastConfigLogSignature`, `turnConfigs`, `mediaDegradedTurns`,
 * `mediaStrippedTurns`, `emittedThinkingEffortWarnings`) is registered into
 * `agentState` (`IAgentStateService`) and read/written through it. Bound at
 * Agent scope.
 */

import { createHash } from 'node:crypto';
import { LifecycleScope } from '#/app/scopes';
import { ScopeActivation, registerScopedService } from '#/_base/di/scope';
import { defineState } from '#/_base/state/stateRegistry';
import { IAgentContextMemoryService } from '#/agent/contextMemory/contextMemory';
import type { ContextMessage } from '#/agent/contextMemory/types';
import {
  IAgentContextProjectorService,
  type MediaStripSnapshot,
} from '#/agent/contextProjector/contextProjector';
import { IAgentTokenCountingService } from '#/agent/tokenCounting/tokenCounting';
import { IAgentProfileService, type ProfileModelContext } from '#/agent/profile/profile';
import { IAgentStateService } from '#/agent/state/agentState';
import { IAgentToolRegistryService } from '#/agent/toolRegistry/toolRegistry';
import { IAgentToolSelectService } from '#/agent/toolSelect/toolSelect';
import { TOOLS_SECTION, type ToolsConfig } from '#/agent/toolPolicy/configSection';
import { ISessionToolPolicy } from '#/session/sessionToolPolicy/sessionToolPolicy';
import { ISessionToolPolicyGate } from '#/session/sessionToolPolicyGate/sessionToolPolicyGate';
import { IAgentVideoResolverService } from '#/agent/media/videoResolver';
import { IAgentUsageService } from '#/agent/usage/usage';
import { IAgentToolResultTruncationService } from '#/agent/toolResultTruncation/toolResultTruncation';
import { IConfigService } from '#/app/config/config';
import { IEventBus } from '#/app/event/eventBus';
import {
  APIRequestTooLargeError,
  APIStatusError,
  classifyApiError,
  isImageFormatError,
  isRecoverableRequestStructureError,
  isRetryableGenerateError,
} from '#/kosong/contract/errors';
import { createUserMessage, type Message } from '#/kosong/contract/message';
import { type ThinkingEffort } from '#/kosong/contract/provider';
import { type Tool } from '#/kosong/contract/tool';
import { emptyUsage, inputTotal, type TokenUsage } from '#/kosong/contract/usage';
import { ILogService, type LogContext } from '#/_base/log/log';
import { IModelCatalog, type Model } from '#/kosong/model/catalog';
import {
  effectiveMaxCompletionTokens,
  type ModelRequestEvent,
  type ModelRequestParams,
  type ModelRequester,
  type ModelRequestTiming,
} from '#/kosong/model/modelRequester';
import type { ModelOverrides } from '#/kosong/model/model.types';
import { IModelService } from '#/kosong/model/model';
import { completionBudgetParams, resolveCompletionBudget } from '#/kosong/model/completionBudget';
import { resolveThinkingKeep, type ThinkingConfig } from '#/kosong/model/thinking';
import { THINKING_SECTION } from '#/app/kosongConfig/configSection';
import type { Protocol } from '#/kosong/protocol/protocol';
import type { ApiErrorEvent } from '#/app/telemetry/events';
import { ITelemetryService } from '#/app/telemetry/telemetry';
import { IWireService } from '#/wire/wire';
import type { PayloadOf } from '#/wire/types';

import {
  IAgentLLMRequesterService,
  type AgentLLMRequestFinish,
  type AgentLLMRequestLogFields,
  type AgentLLMRequestOverrides,
  type AgentLLMRequestPartHandler,
  type AgentLLMRequestSource,
  type AgentLLMRequestTask,
  type PreparedTurnRequestConfig,
} from './llmRequester';
import type { LLMRequestTrace } from '#/kosong/contract/requestTrace';
import {
  LlmRequestTraceModel,
  llmRequest,
  llmToolsSnapshot,
  type LlmRequestToolSchema,
} from './llmRequestOps';
import { isAbortError } from '#/_base/utils/abort';
import { ErrorCodes, Error2, unwrapErrorCause } from '#/errors';
import { retryErrorFields } from '#/_base/utils/retry';

const EMPTY_TOOL_PARAMETERS: Record<string, unknown> = {
  type: 'object',
  properties: {},
};

const noopOnPart: AgentLLMRequestPartHandler = () => {};

interface ResolvedLLMRequest {
  readonly requester: ModelRequester;
  readonly model: Model;
  readonly params: ModelRequestParams;
  readonly modelAlias: string;
  readonly thinkingEffort: ThinkingEffort;
  readonly systemPrompt: string;
  readonly tools: readonly Tool[];
  readonly messages: Message[];
  readonly source: AgentLLMRequestSource | undefined;
  readonly logFields: AgentLLMRequestLogFields;
}

type RequestProjection = 'normal' | 'strict' | 'media-degraded' | 'media-stripped';

interface LLMRequestLogInput {
  readonly protocol: Protocol;
  readonly providerType?: string;
  readonly modelName: string;
  readonly modelAlias?: string;
  readonly thinkingEffort?: ThinkingEffort | null;
  readonly maxTokens?: number;
  readonly systemPrompt: string;
  readonly tools: readonly Tool[];
  readonly messages: readonly Message[];
  readonly fields?: AgentLLMRequestLogFields;
  /** Precomputed request-scoped signature pieces, computed once in `run()` and
   *  shared by `logRequest` / `recordRequest` so the tool table is serialized
   *  and hashed at most once per request. Absent when a caller builds the
   *  input directly — both consumers fall back to computing them. */
  readonly wireTools?: readonly Tool[];
  readonly toolSignature?: readonly LlmRequestToolSchema[];
  readonly toolsHash?: string;
}

interface TurnRequestConfig {
  readonly resolved: ProfileModelContext;
  readonly params: ModelRequestParams;
  readonly systemPrompt: string;
}

export const llmRequesterLastConfigLogSignatureKey = defineState<string | undefined>(
  'llmRequester.lastConfigLogSignature',
  () => undefined as string | undefined,
);
export const llmRequesterTurnConfigsKey = defineState<Map<number, TurnRequestConfig>>(
  'llmRequester.turnConfigs',
  () => new Map(),
);
export const llmRequesterMediaDegradedTurnsKey = defineState<Set<number>>(
  'llmRequester.mediaDegradedTurns',
  () => new Set(),
);
export const llmRequesterMediaStrippedTurnsKey = defineState<Map<number, MediaStripSnapshot>>(
  'llmRequester.mediaStrippedTurns',
  () => new Map(),
);
export const llmRequesterEmittedThinkingEffortWarningsKey = defineState<Set<string>>(
  'llmRequester.emittedThinkingEffortWarnings',
  () => new Set(),
);

export class AgentLLMRequesterService implements IAgentLLMRequesterService {
  declare readonly _serviceBrand: undefined;

  constructor(
    @IAgentContextMemoryService private readonly context: IAgentContextMemoryService,
    @IAgentContextProjectorService private readonly projector: IAgentContextProjectorService,
    @IAgentTokenCountingService private readonly tokenCounting: IAgentTokenCountingService,
    @IAgentToolRegistryService private readonly tools: IAgentToolRegistryService,
    @IAgentToolSelectService private readonly toolSelect: IAgentToolSelectService,
    @IAgentVideoResolverService private readonly videoResolver: IAgentVideoResolverService,
    @IAgentProfileService private readonly profile: IAgentProfileService,
    @IAgentUsageService private readonly usage: IAgentUsageService,
    @IConfigService private readonly config: IConfigService,
    @IModelService private readonly modelService: IModelService,
    @IModelCatalog private readonly modelCatalog: IModelCatalog,
    @ILogService private readonly log: ILogService,
    @ITelemetryService private readonly telemetry: ITelemetryService,
    @IWireService private readonly wire: IWireService,
    @IEventBus private readonly eventBus: IEventBus,
    @IAgentStateService private readonly states: IAgentStateService,
    @IAgentToolResultTruncationService
    private readonly resultTruncation: IAgentToolResultTruncationService | undefined,
    @ISessionToolPolicy private readonly sessionToolPolicy: ISessionToolPolicy,
    @ISessionToolPolicyGate private readonly toolPolicyGate: ISessionToolPolicyGate,
  ) {
    this.states.register(llmRequesterLastConfigLogSignatureKey);
    this.states.register(llmRequesterTurnConfigsKey);
    this.states.register(llmRequesterMediaDegradedTurnsKey);
    this.states.register(llmRequesterMediaStrippedTurnsKey);
    this.states.register(llmRequesterEmittedThinkingEffortWarningsKey);
  }

  /** Content-addressed sha256 cache for the system prompt and tools-signature
   *  strings. Map keys use value equality, so a content change produces a new
   *  key and naturally misses; equal content (shared cached prompt string) hits
   *  and skips the O(n) hashing. Bounded so a long-lived session never grows
   *  an unbounded set of large keys. */
  private readonly fingerprintCache = new Map<string, string>();
  private static readonly FINGERPRINT_CACHE_MAX = 64;

  private cachedFingerprint(content: string): string {
    const cached = this.fingerprintCache.get(content);
    if (cached !== undefined) return cached;
    const hash = fingerprint(content);
    if (this.fingerprintCache.size >= AgentLLMRequesterService.FINGERPRINT_CACHE_MAX) {
      const oldest = this.fingerprintCache.keys().next().value;
      if (oldest !== undefined) this.fingerprintCache.delete(oldest);
    }
    this.fingerprintCache.set(content, hash);
    return hash;
  }

  private get lastConfigLogSignature(): string | undefined {
    return this.states.get(llmRequesterLastConfigLogSignatureKey);
  }

  private set lastConfigLogSignature(value: string | undefined) {
    this.states.set(llmRequesterLastConfigLogSignatureKey, value);
  }

  private get turnConfigs(): Map<number, TurnRequestConfig> {
    return this.states.get(llmRequesterTurnConfigsKey);
  }

  private get mediaDegradedTurns(): Set<number> {
    return this.states.get(llmRequesterMediaDegradedTurnsKey);
  }

  private get mediaStrippedTurns(): Map<number, MediaStripSnapshot> {
    return this.states.get(llmRequesterMediaStrippedTurnsKey);
  }

  private get emittedThinkingEffortWarnings(): Set<string> {
    return this.states.get(llmRequesterEmittedThinkingEffortWarningsKey);
  }

  prepareTurnConfig(turnId: number): PreparedTurnRequestConfig | undefined {
    if (!this.profile.hasProvider()) return undefined;
    const config = this.getOrCreateTurnConfig(turnId);
    return { thinkingEffort: config.resolved.thinkingLevel };
  }

  async request(
    overrides: AgentLLMRequestOverrides = {},
    onPart: AgentLLMRequestPartHandler = noopOnPart,
    signal?: AbortSignal,
  ): Promise<AgentLLMRequestFinish> {
    return this.start(overrides, onPart, signal).result;
  }

  start(
    overrides: AgentLLMRequestOverrides = {},
    onPart: AgentLLMRequestPartHandler = noopOnPart,
    signal?: AbortSignal,
  ): AgentLLMRequestTask {
    const trace = new MutableLLMRequestTrace();
    return {
      trace,
      result: this.requestWithTrace(trace, overrides, onPart, signal),
    };
  }

  private async requestWithTrace(
    trace: MutableLLMRequestTrace,
    overrides: AgentLLMRequestOverrides,
    onPart: AgentLLMRequestPartHandler,
    signal: AbortSignal | undefined,
  ): Promise<AgentLLMRequestFinish> {
    signal?.throwIfAborted();
    const startedAt = Date.now();
    trace.set(undefined);
    try {
      return await this.runRequest(
        this.resolveRequest(overrides),
        onPart,
        signal,
        (traceId) => {
          trace.set(traceId);
        },
      );
    } catch (error) {
      this.logRequestFailure(error, overrides, signal);
      trace.set(this.trackApiError(error, startedAt, signal, overrides.source, trace.traceId));
      throw error;
    }
  }

  private logRequestFailure(
    error: unknown,
    overrides: AgentLLMRequestOverrides,
    signal: AbortSignal | undefined,
  ): void {
    if (isAbortError(error) || signal?.aborted === true) return;
    const payload: LogContext = {
      ...logFieldsForSource(overrides.source),
      model: this.profile.data().modelAlias ?? 'unknown',
      ...retryErrorFields(error),
    };
    this.log.warn('llm request failed', payload);
  }

  private trackApiError(
    error: unknown,
    startedAt: number,
    signal: AbortSignal | undefined,
    source?: AgentLLMRequestSource,
    requestTraceId?: string,
  ): string | undefined {
    if (isAbortError(error) || signal?.aborted === true) return requestTraceId;
    const modelAlias = this.profile.data().modelAlias;
    const model = this.tryGetModel();
    const traceId = requestTraceId ?? apiTraceId(error);
    const classification = classifyApiError(unwrapErrorCause(error));
    const properties: ApiErrorEvent = {
      error_type: classification.kind,
      model: model?.id ?? modelAlias ?? 'unknown',
      alias: modelAlias,
      provider_type: model?.providerType ?? model?.protocol,
      protocol: model?.protocol,
      retryable: isRetryableGenerateError(error),
      duration_ms: Math.max(0, Date.now() - startedAt),
      turn_id: source?.turnId,
      request_kind: requestKindForTelemetry(source),
      trace_id: traceId,
    };
    if (source?.type === 'turn') {
      if (source.step !== undefined) properties['step_no'] = source.step;
    }
    const statusCode = apiStatusCode(error);
    if (statusCode !== undefined) properties['status_code'] = statusCode;
    const currentTurn = this.usage.status().currentTurn;
    if (currentTurn !== undefined) properties['input_tokens'] = inputTotal(currentTurn);
    this.telemetry.track2('api_error', properties);
    return traceId;
  }

  private tryGetModel(): Model | undefined {
    const modelAlias = this.profile.data().modelAlias;
    if (modelAlias === undefined) return undefined;
    try {
      return this.modelCatalog.get(modelAlias);
    } catch {
      return undefined;
    }
  }

  private async runRequest(
    request: ResolvedLLMRequest,
    onPart: AgentLLMRequestPartHandler,
    signal: AbortSignal | undefined,
    onRequestTrace: (traceId: string | undefined) => void,
  ): Promise<AgentLLMRequestFinish> {
    const shaped = this.toolSelect.shapeHistory(request.messages);
    // Transient total_tokens reminder: appended after shaping so it never enters
    // context history (wire replay and post-compaction tails stay clean) while
    // still riding the outbound request at the tail. Appending here — rather
    // than to `request.messages` in resolveRequest — keeps the token-counting
    // measured anchor aligned with the wire context.
    const requestMessages = this.appendTotalTokensReminder(shaped, request.source);
    let mediaStripSnapshot = this.mediaStripSnapshotForTurn(request.source);
    const requestInput = (projection: RequestProjection) => {
      return {
        systemPrompt: request.systemPrompt,
        tools: request.tools,
        messages:
          projection === 'strict'
            ? this.projector.projectStrict(requestMessages)
            : projection === 'media-degraded'
              ? this.projector.projectMediaDegraded(requestMessages)
              : projection === 'media-stripped'
                ? this.projector.projectMediaStripped(
                    requestMessages,
                    (mediaStripSnapshot ??=
                      this.projector.captureMediaStripSnapshot(shaped)),
                  )
                : this.projector.project(requestMessages),
      };
    };

    const run = async (projection: RequestProjection): Promise<AgentLLMRequestFinish> => {
      onRequestTrace(undefined);
      const projected = requestInput(projection);
      const budgeted = await this.prepareRequestMessages(projected.messages);
      const input = {
        ...projected,
        messages: await this.videoResolver.resolve(
          budgeted,
          request.requester,
          signal,
        ),
      };
      const fields =
        projection === 'normal'
          ? request.logFields
          : { ...request.logFields, projection };
      this.warnAboutAnthropicThinkingEffort(request);
      const wireTools = providerVisibleTools(input.tools);
      const toolSignatureArray = toolSignature(wireTools);
      const toolsHash = this.cachedFingerprint(JSON.stringify(toolSignatureArray));
      const logInput: LLMRequestLogInput = {
        protocol: request.model.protocol,
        providerType: request.model.providerType,
        modelName: request.model.name,
        modelAlias: request.modelAlias,
        thinkingEffort: request.thinkingEffort,
        maxTokens: effectiveMaxCompletionTokens(request.params),
        systemPrompt: input.systemPrompt,
        tools: input.tools,
        messages: input.messages,
        fields,
        wireTools,
        toolSignature: toolSignatureArray,
        toolsHash,
      };
      this.logRequest(logInput);
      this.recordRequest(logInput);

      let message: Message | undefined;
      let usage: TokenUsage | undefined;
      let timing: ModelRequestTiming | undefined;
      let finish: Extract<ModelRequestEvent, { type: 'finish' }> | undefined;

      const setTraceId = (traceId: string | null | undefined): void => {
        const normalized = traceId ?? undefined;
        onRequestTrace(normalized);
      };

      for await (const event of request.requester.request(input, signal, {
        ...request.params,
        onTraceId: setTraceId,
      })) {
        switch (event.type) {
          case 'part':
            await onPart(event.part);
            break;
          case 'usage':
            usage = event.usage;
            break;
          case 'finish':
            finish = event;
            message = event.message;
            setTraceId(event.traceId);
            break;
          case 'timing': {
            const { type: _type, ...streamTiming } = event;
            timing = streamTiming;
            break;
          }
        }
      }

      if (message === undefined || finish === undefined) {
        throw new Error2(
          ErrorCodes.PROVIDER_API_ERROR,
          'LLM request stream ended without a finish event.',
        );
      }

      this.usage.record(request.modelAlias, usage ?? emptyUsage(), request.source);
      // Only a stream that actually reported usage may write a measured
      // anchor — recording emptyUsage() zeros would zero the context size and
      // silence compaction for providers without usage reporting.
      if (usage !== undefined) {
        this.tokenCounting.measured(request.messages, [message], usage);
      }
      this.logResponse(request.logFields, usage ?? emptyUsage(), timing);

      return {
        message,
        usage: usage ?? emptyUsage(),
        model: request.modelAlias,
        providerFinishReason: finish.providerFinishReason,
        rawFinishReason: finish.rawFinishReason,
        providerMessageId: finish.id,
        timing,
        traceId: finish.traceId,
      };
    };

    const initialProjection: RequestProjection = mediaStripSnapshot !== undefined
      ? 'media-stripped'
      : this.isRecoveryTurn(this.mediaDegradedTurns, request.source)
        ? 'media-degraded'
        : 'normal';
    let projection: RequestProjection = initialProjection;
    for (;;) {
      try {
        return await run(projection);
      } catch (error) {
        if (signal?.aborted === true) throw error;
        const raw = unwrapErrorCause(error);
        if (
          raw instanceof APIRequestTooLargeError &&
          (projection === 'normal' || projection === 'media-degraded')
        ) {
          signal?.throwIfAborted();
          if (projection === 'normal') {
            this.log.warn(
              'provider rejected request as too large; resending with degraded media',
              {
                model: request.model.name,
                ...request.logFields,
              },
            );
            this.markRecoveryTurn(this.mediaDegradedTurns, request.source);
            projection = 'media-degraded';
          } else {
            this.log.warn(
              'provider rejected degraded-media request as too large; resending with rejected media stripped',
              {
                model: request.model.name,
                ...request.logFields,
              },
            );
            mediaStripSnapshot = this.projector.captureMediaStripSnapshot(shaped);
            this.markMediaStrippedRecoveryTurn(mediaStripSnapshot, request.source);
            projection = 'media-stripped';
          }
          continue;
        }
        if (projection !== 'media-stripped' && isImageFormatError(raw)) {
          signal?.throwIfAborted();
          this.log.warn(
            'provider rejected an image in the request; resending with rejected media stripped',
            {
              model: request.model.name,
              ...request.logFields,
            },
          );
          mediaStripSnapshot = this.projector.captureMediaStripSnapshot(shaped);
          this.markMediaStrippedRecoveryTurn(mediaStripSnapshot, request.source);
          projection = 'media-stripped';
          continue;
        }
        if (projection === 'normal' && isRecoverableRequestStructureError(raw)) {
          signal?.throwIfAborted();
          this.log.warn('provider rejected request structure; resending with strict projection', {
            model: request.model.name,
            ...request.logFields,
          });
          projection = 'strict';
          continue;
        }
        throw error;
      }
    }
  }

  private warnAboutAnthropicThinkingEffort(request: ResolvedLLMRequest): void {
    if (request.model.protocol !== 'anthropic') return;
    const effort = request.thinkingEffort;
    if (effort === 'on' || effort === 'off') return;

    let code: string;
    let message: string;
    let knownEfforts: string | undefined;
    const supportEfforts = request.model.supportEfforts?.filter((value) => value.length > 0);
    if (supportEfforts === undefined || supportEfforts.length === 0) return;
    if (supportEfforts.includes(effort)) return;
    code = 'anthropic-thinking-effort-not-listed';
    knownEfforts = supportEfforts.join(',');
    message = `Thinking effort "${effort}" is not listed for model "${request.model.name}" (known: ${supportEfforts.join(', ')}). The configured value will be sent unchanged to the Anthropic-compatible backend.`;

    const key = [code, request.modelAlias, request.model.name, effort, knownEfforts].join('\u0000');
    if (this.emittedThinkingEffortWarnings.has(key)) return;
    this.emittedThinkingEffortWarnings.add(key);
    try {
      this.log.warn(message, {
        modelAlias: request.modelAlias,
        model: request.model.name,
        effort,
        knownEfforts,
      });
    } catch {
    }
    try {
      this.eventBus.publish({ type: 'warning', code, message });
    } catch {
    }
  }

  private isRecoveryTurn(set: ReadonlySet<number>, source: AgentLLMRequestSource | undefined): boolean {
    if (source?.type !== 'turn') return false;
    return set.has(source.turnId);
  }

  private mediaStripSnapshotForTurn(
    source: AgentLLMRequestSource | undefined,
  ): MediaStripSnapshot | undefined {
    if (source?.type !== 'turn') return undefined;
    return this.mediaStrippedTurns.get(source.turnId);
  }

  private markMediaStrippedRecoveryTurn(
    snapshot: MediaStripSnapshot,
    source: AgentLLMRequestSource | undefined,
  ): void {
    if (source?.type !== 'turn') return;
    for (const id of this.mediaStrippedTurns.keys()) {
      if (id < source.turnId) this.mediaStrippedTurns.delete(id);
    }
    this.mediaStrippedTurns.set(source.turnId, snapshot);
  }

  private markRecoveryTurn(set: Set<number>, source: AgentLLMRequestSource | undefined): void {
    if (source?.type !== 'turn') return;
    for (const id of set) {
      if (id < source.turnId) set.delete(id);
    }
    set.add(source.turnId);
  }

  private resolveRequest(overrides: AgentLLMRequestOverrides): ResolvedLLMRequest {
    const turnConfig = this.resolveTurnConfig(overrides.source);
    const resolved = turnConfig?.resolved ?? this.profile.resolveModelContext();
    const baseParams = turnConfig?.params ?? this.profile.resolveRequestParams();
    const budgetParams = completionBudgetParams({
      budget: resolveCompletionBudget({
        maxOutputSize: overrides.maxOutputSize ?? resolved.maxOutputSize,
        reservedContextSize: resolved.reservedContextSize,
        maxCompletionTokensCap:
          this.config.get<ModelOverrides>('modelOverrides')?.maxCompletionTokens,
      }),
      capability: resolved.modelCapabilities,
      usedContextTokens:
        overrides.messages === undefined
          ? this.tokenCounting.get().measured
          : undefined,
    });
    const requester = this.modelCatalog.getRequester(resolved.modelAlias);

    const messages = overrides.messages ?? this.context.get();
    return {
      requester,
      model: requester.model,
      params: { ...baseParams, ...budgetParams },
      modelAlias: resolved.modelAlias,
      thinkingEffort: resolved.thinkingLevel,
      systemPrompt: overrides.systemPrompt ?? turnConfig?.systemPrompt ?? this.profile.getSystemPrompt(),
      tools: [...(overrides.tools ?? this.defaultTools())],
      messages: [...messages],
      source: overrides.source,
      logFields: logFieldsForSource(overrides.source),
    };
  }

  /** Appends a transient `<total_tokens>` reminder as the final user message of
   *  a turn request so the model can self-converge before the context window
   *  fills. The reminder is computed fresh and never persisted into context
   *  history — it rides only on the outbound request, keeping wire replay,
   *  post-compaction tails, and the request cache prefix clean. It fires once
   *  per turn on the first turn-typed request (mirroring the original
   *  `isNewTurn` gating in `contextInjector`), so later steps of the same turn
   *  are not re-prefixed. Operation requests (compaction, memory extraction)
   *  pass explicit `overrides.messages` and a non-turn source, and are
   *  excluded. */
  private readonly totalTokensInjectedTurns = new Set<number>();

  private appendTotalTokensReminder(
    messages: readonly ContextMessage[],
    source: AgentLLMRequestSource | undefined,
  ): readonly ContextMessage[] {
    if (source?.type !== 'turn') return messages;
    const { turnId } = source;
    if (this.totalTokensInjectedTurns.has(turnId)) return messages;
    this.totalTokensInjectedTurns.add(turnId);
    for (const id of this.totalTokensInjectedTurns) {
      if (id < turnId) this.totalTokensInjectedTurns.delete(id);
    }
    const remaining = this.totalTokensRemaining();
    if (remaining === undefined) return messages;
    return [
      ...messages,
      createUserMessage(
        `<system-reminder>\n<total_tokens>${remaining} tokens left</total_tokens>\n</system-reminder>`,
      ),
    ];
  }

  /** Tokens left until the model's input window fills, from the latest measured
   *  context size. Undefined when the profile has no input-window budget, no
   *  measured reading exists, the window is already exhausted, or the profile/
   *  token-counting services are unavailable in the current scope (test stubs)
   *  — the reminder is then simply skipped. */
  private totalTokensRemaining(): number | undefined {
    try {
      const capability = this.profile.getModelCapabilities();
      const maxInputTokens = capability.max_input_tokens ?? capability.max_context_tokens;
      if (maxInputTokens === undefined || maxInputTokens <= 0) return undefined;
      const used = this.tokenCounting.get().measured;
      if (used <= 0) return undefined;
      const remaining = maxInputTokens - used;
      return remaining > 0 ? remaining : undefined;
    } catch {
      return undefined;
    }
  }

  private resolveTurnConfig(source: AgentLLMRequestSource | undefined): TurnRequestConfig | undefined {
    if (source?.type !== 'turn') return undefined;
    return this.getOrCreateTurnConfig(source.turnId);
  }

  /** Request-level tool-result budget pass: clears stale (time-based) whitelisted
   *  tool results, then persists the oldest oversized results to storage when
   *  their combined text exceeds the aggregate budget. No-op when the truncation
   *  service is unavailable (test scopes). */
  private async prepareRequestMessages(messages: readonly Message[]): Promise<readonly Message[]> {
    const truncation = this.resultTruncation;
    if (truncation === undefined) return messages;
    const cleared = truncation.clearStaleToolResults?.(messages) ?? messages;
    return truncation.applyToolResultBudget?.(cleared) ?? Promise.resolve(cleared);
  }

  private getOrCreateTurnConfig(turnId: number): TurnRequestConfig {
    for (const id of this.turnConfigs.keys()) {
      if (id < turnId) this.turnConfigs.delete(id);
    }
    let snapshot = this.turnConfigs.get(turnId);
    if (snapshot === undefined) {
      snapshot = {
        resolved: this.profile.resolveModelContext(),
        params: this.profile.resolveRequestParams(),
        systemPrompt: this.profile.getSystemPrompt(),
      };
      this.turnConfigs.set(turnId, snapshot);
    }
    return snapshot;
  }

  private logRequest(input: LLMRequestLogInput): void {
    const logFields: AgentLLMRequestLogFields = input.fields ?? {};
    const wireTools = input.wireTools ?? providerVisibleTools(input.tools);
    const config = {
      provider: input.protocol,
      model: input.modelName,
      modelAlias: input.modelAlias,
      thinkingEffort: input.thinkingEffort ?? undefined,
      systemPromptChars: input.systemPrompt.length,
      toolCount: wireTools.length,
    };
    const signature = JSON.stringify({
      ...config,
      systemPromptHash: this.cachedFingerprint(input.systemPrompt),
      toolsHash:
        input.toolsHash ?? this.cachedFingerprint(JSON.stringify(toolSignature(wireTools))),
    });
    if (signature !== this.lastConfigLogSignature) {
      this.lastConfigLogSignature = signature;
      this.log.info('llm config', { ...logFields, ...config });
    }

    const partialMessageCount = input.messages.filter((message) => message.partial === true).length;
    const requestFields: LogContext = { ...logFields };
    if (partialMessageCount > 0) requestFields['partialMessageCount'] = partialMessageCount;
    this.log.info('llm request', requestFields);
  }

  private recordRequest(input: LLMRequestLogInput): void {
    const fields = input.fields ?? {};
    const wireTools = input.wireTools ?? providerVisibleTools(input.tools);
    const tools = input.toolSignature ?? toolSignature(wireTools);
    const toolsHash = input.toolsHash ?? this.cachedFingerprint(JSON.stringify(tools));
    if (!this.wire.getModel(LlmRequestTraceModel).seenToolsHashes.includes(toolsHash)) {
      this.wire.dispatch(llmToolsSnapshot({ hash: toolsHash, tools }));
    }

    const systemPromptHash = this.cachedFingerprint(input.systemPrompt);
    const overrides = this.config.get<ModelOverrides>('modelOverrides');
    const thinkingConfig = this.config.get<ThinkingConfig>(THINKING_SECTION);
    const modelConfig =
      input.modelAlias === undefined ? undefined : this.modelService.get(input.modelAlias);
    const payload: PayloadOf<typeof llmRequest> = {
      kind: requestKindForRecord(fields),
      provider: input.protocol,
      model: input.modelName,
      modelAlias: input.modelAlias,
      thinkingEffort: input.thinkingEffort ?? undefined,
      thinkingKeep: resolveThinkingKeep(
        overrides?.thinkingKeep,
        thinkingConfig?.keep,
        input.thinkingEffort ?? 'off',
      ),
      temperature: overrides?.temperature,
      topP: overrides?.topP,
      maxTokens: input.maxTokens,
      betaApi: modelConfig?.betaApi,
      toolSelect: this.toolSelect.enabled(),
      systemPromptHash,
      systemPrompt:
        input.systemPrompt === this.profile.data().systemPrompt
          ? undefined
          : input.systemPrompt,
      toolsHash,
      messageCount: input.messages.length,
      turnStep: stringField(fields, 'turnStep'),
      attempt: stringField(fields, 'attempt'),
      projection: projectionField(fields),
      droppedCount: numberField(fields, 'droppedCount'),
    };
    this.wire.dispatch(llmRequest(payload));
  }

  private logResponse(
    fields: AgentLLMRequestLogFields | undefined,
    usage: TokenUsage,
    timing: ModelRequestTiming | undefined,
  ): void {
    if (timing === undefined) return;
    const payload: LogContext = {
      ...fields,
      ttftMs: timing.firstTokenLatencyMs,
      streamDurationMs: timing.streamDurationMs,
      outputTokens: usage.output,
    };
    if (timing.requestBuildMs !== undefined) payload['requestBuildMs'] = timing.requestBuildMs;
    if (timing.serverFirstTokenMs !== undefined) {
      payload['serverFirstTokenMs'] = timing.serverFirstTokenMs;
    }
    if (timing.serverDecodeMs !== undefined) payload['serverDecodeMs'] = timing.serverDecodeMs;
    if (timing.clientConsumeMs !== undefined) payload['clientConsumeMs'] = timing.clientConsumeMs;
    this.log.info('llm response', payload);
  }

  private defaultToolsCache: { readonly key: string; readonly tools: readonly Tool[] } | undefined;

  /** Cache key for `defaultTools()`. Returns `undefined` (no caching) when tool
   *  disclosure is enabled: the shaped table then depends on the context-driven
   *  loaded-tool ledger, which is not captured by the key. With disclosure off
   *  the shaped table is a pure function of the registry content and the tool
   *  policy inputs below — every input of `isToolActive` is folded into the
   *  key, so a policy change (profile switch, session tool disable, global
   *  config, workspace veto) invalidates like a registry change does. */
  private defaultToolsCacheKey(): string | undefined {
    if (this.toolSelect.enabled()) return undefined;
    const profile = this.profile.data();
    const globalTools = this.config.get<ToolsConfig>(TOOLS_SECTION);
    return [
      this.tools.revision,
      JSON.stringify(profile.activeToolNames ?? null),
      JSON.stringify(profile.disallowedTools),
      JSON.stringify(globalTools),
      JSON.stringify(this.sessionToolPolicy.disabledTools()),
      JSON.stringify(this.toolPolicyGate.disabledTools),
    ].join('|');
  }

  private defaultTools(): readonly Tool[] {
    const key = this.defaultToolsCacheKey();
    const cached = this.defaultToolsCache;
    if (key !== undefined && cached !== undefined && cached.key === key) return cached.tools;
    const tools = this.toolSelect
      .shapeTools(this.tools.list())
      .map((tool) => ({
        name: tool.name,
        description: tool.description,
        parameters: tool.parameters ?? EMPTY_TOOL_PARAMETERS,
        deferred: tool.deferred,
      }));
    this.defaultToolsCache = key === undefined ? undefined : { key, tools };
    return tools;
  }
}

class MutableLLMRequestTrace implements LLMRequestTrace {
  traceId: string | undefined;

  set(traceId: string | undefined): void {
    this.traceId = traceId;
  }
}

function logFieldsForSource(source: AgentLLMRequestSource | undefined): AgentLLMRequestLogFields {
  switch (source?.type) {
    case 'turn':
      return {
        ...source.logFields,
        ...(source.step === undefined
          ? {}
          : { turnStep: `${String(source.turnId)}.${String(source.step)}` }),
      };
    case 'operation':
      return {
        ...source.logFields,
        ...(source.requestKind === undefined ? {} : { requestKind: source.requestKind }),
      };
    default:
      return {};
  }
}

function requestKindForTelemetry(source: AgentLLMRequestSource | undefined): string | undefined {
  if (source?.type === 'turn') return 'turn';
  if (source?.type === 'operation') return source.requestKind ?? 'operation';
  return undefined;
}

export function providerVisibleTools(tools: readonly Tool[]): readonly Tool[] {
  if (!tools.some((tool) => tool.deferred === true)) return tools;
  return tools.filter((tool) => tool.deferred !== true);
}

export function toolSignature(tools: readonly Tool[]): readonly LlmRequestToolSchema[] {
  return tools.map(({ name, description, parameters }) => ({ name, description, parameters }));
}

function requestKindForRecord(fields: AgentLLMRequestLogFields): PayloadOf<typeof llmRequest>['kind'] {
  if (fields['kind'] === 'compaction') return 'compaction';
  if (fields['requestKind'] === 'full_compaction') return 'compaction';
  return 'loop';
}

function stringField(fields: AgentLLMRequestLogFields, key: string): string | undefined {
  const value = fields[key];
  return typeof value === 'string' ? value : undefined;
}

function numberField(fields: AgentLLMRequestLogFields, key: string): number | undefined {
  const value = fields[key];
  return typeof value === 'number' ? value : undefined;
}

function projectionField(
  fields: AgentLLMRequestLogFields,
): 'strict' | 'media-degraded' | 'media-stripped' | undefined {
  const value = fields['projection'];
  return value === 'strict' || value === 'media-degraded' || value === 'media-stripped'
    ? value
    : undefined;
}

function fingerprint(content: string): string {
  return createHash('sha256').update(content).digest('hex');
}

function apiStatusCode(error: unknown): number | undefined {
  const raw = unwrapErrorCause(error);
  if (raw instanceof APIStatusError) return raw.statusCode;
  if (typeof raw === 'object' && raw !== null) {
    const statusCode = (raw as Record<string, unknown>)['statusCode'];
    if (typeof statusCode === 'number') return statusCode;
    const status = (raw as Record<string, unknown>)['status'];
    if (typeof status === 'number') return status;
  }
  if (typeof error === 'object' && error !== null) {
    const details = (error as Record<string, unknown>)['details'];
    if (typeof details === 'object' && details !== null) {
      const statusCode = (details as Record<string, unknown>)['statusCode'];
      if (typeof statusCode === 'number') return statusCode;
    }
  }
  return undefined;
}

function apiTraceId(error: unknown): string | undefined {
  const raw = unwrapErrorCause(error);
  if (raw instanceof APIStatusError && raw.traceId !== null) return raw.traceId;
  if (typeof error === 'object' && error !== null) {
    const details = (error as Record<string, unknown>)['details'];
    if (typeof details === 'object' && details !== null) {
      const traceId = (details as Record<string, unknown>)['traceId'];
      if (typeof traceId === 'string') return traceId;
    }
  }
  return undefined;
}

registerScopedService(
  LifecycleScope.Agent,
  IAgentLLMRequesterService,
  AgentLLMRequesterService,
  ScopeActivation.OnScopeCreated,
  'llmRequester',
);
