import {
  ErrorCodes,
  KimiError,
  type ModelProvider,
  type ResolvedRuntimeProvider,
} from '@moonshot-ai/agent-core';
import type { ModelCapability, ProviderConfig as KosongProviderConfig } from '@moonshot-ai/kosong';

export interface OpenAIResponsesHarnessModel {
  readonly id: string;
  readonly maxContextTokens: number;
  readonly maxOutputTokens: number;
  readonly displayName?: string;
  readonly supportEfforts?: readonly string[];
  readonly defaultEffort?: string;
}

export interface OpenAIResponsesModelProviderOptions {
  /** Falls back to `OPENAI_API_KEY` when omitted. */
  readonly apiKey?: string;
  /** Falls back to `OPENAI_BASE_URL`, then `https://api.openai.com/v1`. */
  readonly baseUrl?: string;
  readonly defaultModel?: string;
  readonly models?: readonly OpenAIResponsesHarnessModel[];
  readonly defaultHeaders?: Record<string, string>;
  /** Defaults to the harness session id. Set an explicit value to share cache affinity. */
  readonly promptCacheKey?: string;
}

const GPT_56_EFFORTS = ['off', 'low', 'medium', 'high', 'xhigh', 'max'] as const;

export const OPENAI_HARNESS_MODELS: readonly OpenAIResponsesHarnessModel[] = [
  {
    id: 'gpt-5.6-sol',
    displayName: 'GPT-5.6 Sol',
    maxContextTokens: 1_050_000,
    maxOutputTokens: 128_000,
    supportEfforts: GPT_56_EFFORTS,
    defaultEffort: 'medium',
  },
  {
    id: 'gpt-5.6-terra',
    displayName: 'GPT-5.6 Terra',
    maxContextTokens: 1_050_000,
    maxOutputTokens: 128_000,
    supportEfforts: GPT_56_EFFORTS,
    defaultEffort: 'medium',
  },
  {
    id: 'gpt-5.6-luna',
    displayName: 'GPT-5.6 Luna',
    maxContextTokens: 1_050_000,
    maxOutputTokens: 128_000,
    supportEfforts: GPT_56_EFFORTS,
    defaultEffort: 'medium',
  },
];

const DEFAULT_OPENAI_MODEL = 'gpt-5.6-sol';

/** Runtime-only OpenAI Responses model registry for `createKimiHarness`. */
export class OpenAIResponsesModelProvider implements ModelProvider {
  readonly defaultModel: string;

  private readonly apiKey: string | undefined;
  private readonly baseUrl: string | undefined;
  private readonly defaultHeaders: Record<string, string> | undefined;
  private readonly promptCacheKey: string | undefined;
  private readonly models: ReadonlyMap<string, OpenAIResponsesHarnessModel>;

  constructor(options: OpenAIResponsesModelProviderOptions = {}) {
    const models = options.models ?? OPENAI_HARNESS_MODELS;
    this.models = new Map(models.map((model) => [model.id, model]));
    this.defaultModel = options.defaultModel ?? models[0]?.id ?? DEFAULT_OPENAI_MODEL;
    this.apiKey = options.apiKey;
    this.baseUrl = options.baseUrl ?? normalizeOptionalString(process.env['OPENAI_BASE_URL']);
    this.defaultHeaders = options.defaultHeaders;
    this.promptCacheKey = normalizeOptionalString(options.promptCacheKey);

    if (!this.models.has(this.defaultModel)) {
      throw new KimiError(
        ErrorCodes.CONFIG_INVALID,
        `OpenAI default model "${this.defaultModel}" is not registered in the harness model list.`,
      );
    }
  }

  resolveProviderConfig(model: string): ResolvedRuntimeProvider {
    const definition = this.models.get(model);
    if (definition === undefined) {
      throw new KimiError(
        ErrorCodes.CONFIG_INVALID,
        `OpenAI model "${model}" is not registered in the harness model list.`,
      );
    }

    const provider: KosongProviderConfig = {
      type: 'openai_responses',
      model,
      apiKey: this.apiKey,
      baseUrl: this.baseUrl,
      defaultHeaders: this.defaultHeaders,
      maxOutputTokens: definition.maxOutputTokens,
      offEffort: 'none',
      generationKwargs:
        this.promptCacheKey === undefined
          ? undefined
          : { prompt_cache_key: this.promptCacheKey },
    };

    return {
      providerName: 'openai',
      provider,
      modelCapabilities: capabilityFor(definition),
      supportEfforts: definition.supportEfforts,
      defaultEffort: definition.defaultEffort,
      maxOutputSize: definition.maxOutputTokens,
      type: 'openai_responses',
      protocol: undefined,
    };
  }
}

function capabilityFor(model: OpenAIResponsesHarnessModel): ModelCapability {
  return {
    image_in: true,
    video_in: false,
    audio_in: false,
    thinking: true,
    tool_use: true,
    max_context_tokens: model.maxContextTokens,
  };
}

function normalizeOptionalString(value: string | undefined): string | undefined {
  const normalized = value?.trim();
  return normalized === undefined || normalized.length === 0 ? undefined : normalized;
}
