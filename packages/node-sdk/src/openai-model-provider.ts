import {
  ErrorCodes,
  KimiError,
  type BearerTokenProvider,
  type KimiConfig,
  type Logger,
  type ModelProvider,
  type ResolvedRuntimeProvider,
} from '@moonshot-ai/agent-core';
import {
  getOpenAICodexAccountId,
  OPENAI_CODEX_BASE_URL,
  OPENAI_CODEX_PROVIDER_NAME,
} from '@moonshot-ai/kimi-code-oauth';
import {
  APIStatusError,
  type ModelCapability,
  type ProviderConfig as KosongProviderConfig,
  type ProviderRequestAuth,
} from '@moonshot-ai/kosong';

export interface OpenAIResponsesHarnessModel {
  readonly id: string;
  readonly maxContextTokens: number;
  readonly maxOutputTokens: number;
  readonly displayName?: string;
  readonly supportEfforts?: readonly string[];
  readonly defaultEffort?: string;
}

export interface OpenAIResponsesModelProviderOptions {
  /** API-key access or ChatGPT subscription access. Defaults to `api-key`. */
  readonly authentication?: 'api-key' | 'chatgpt';
  /** Falls back to `OPENAI_API_KEY` when omitted. */
  readonly apiKey?: string;
  /** API-key access falls back to `OPENAI_BASE_URL`, then the public OpenAI API. */
  readonly baseUrl?: string;
  readonly defaultModel?: string;
  readonly models?: readonly OpenAIResponsesHarnessModel[];
  readonly defaultHeaders?: Record<string, string>;
  /** Defaults to the harness session id. Set an explicit value to share cache affinity. */
  readonly promptCacheKey?: string;
  /** Token source used by ChatGPT authentication. The harness supplies this automatically. */
  readonly tokenProvider?: BearerTokenProvider;
  readonly originator?: string;
  readonly clientVersion?: string;
  /** Defaults to the Responses Lite request shape used by current Codex models. */
  readonly codexResponsesLite?: boolean;
}

export interface ApplyOpenAICodexConfigOptions {
  readonly accountId: string;
  readonly selectedModel: string;
  readonly thinking: boolean;
  readonly effort?: string;
  readonly clientVersion?: string;
}

export interface ApplyOpenAICodexConfigResult {
  readonly defaultModel: string;
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
const OPENAI_CODEX_CLIENT_VERSION = '0.144.1';

export function applyOpenAICodexConfig(
  config: KimiConfig,
  options: ApplyOpenAICodexConfigOptions,
): ApplyOpenAICodexConfigResult {
  const selected = OPENAI_HARNESS_MODELS.find((model) => model.id === options.selectedModel);
  if (selected === undefined) {
    throw new KimiError(
      ErrorCodes.CONFIG_INVALID,
      `OpenAI model "${options.selectedModel}" is not registered in the harness model list.`,
    );
  }

  config.providers[OPENAI_CODEX_PROVIDER_NAME] = {
    type: 'openai-codex',
    baseUrl: resolveOpenAICodexBaseUrl(undefined),
    oauth: { storage: 'file', key: OPENAI_CODEX_PROVIDER_NAME },
    customHeaders: createOpenAICodexHeaders({
      accountId: options.accountId,
      clientVersion: options.clientVersion,
      responsesLite: true,
    }),
  };

  const models = config.models ?? {};
  for (const [alias, model] of Object.entries(models)) {
    if (model.provider === OPENAI_CODEX_PROVIDER_NAME) delete models[alias];
  }
  for (const model of OPENAI_HARNESS_MODELS) {
    models[`${OPENAI_CODEX_PROVIDER_NAME}/${model.id}`] = {
      provider: OPENAI_CODEX_PROVIDER_NAME,
      model: model.id,
      maxContextSize: Math.min(model.maxContextTokens, 1_000_000),
      maxOutputSize: model.maxOutputTokens,
      capabilities: ['image_in', 'thinking', 'tool_use'],
      displayName: model.displayName,
      supportEfforts: model.supportEfforts?.filter((effort) => effort !== 'off'),
      defaultEffort: model.defaultEffort,
    };
  }
  const defaultModel = `${OPENAI_CODEX_PROVIDER_NAME}/${selected.id}`;
  config.models = models;
  config.defaultModel = defaultModel;
  config.thinking = {
    ...config.thinking,
    enabled: options.thinking,
    effort: options.effort,
  };
  return { defaultModel };
}

/** Runtime-only OpenAI Responses model registry for `createKimiHarness`. */
export class OpenAIResponsesModelProvider implements ModelProvider {
  readonly defaultModel: string;

  private readonly apiKey: string | undefined;
  private readonly baseUrl: string | undefined;
  private readonly defaultHeaders: Record<string, string> | undefined;
  private readonly promptCacheKey: string | undefined;
  private readonly models: ReadonlyMap<string, OpenAIResponsesHarnessModel>;
  private readonly authentication: 'api-key' | 'chatgpt';
  private readonly tokenProvider: BearerTokenProvider | undefined;
  private readonly codexResponsesLite: boolean;

  constructor(options: OpenAIResponsesModelProviderOptions = {}) {
    const models = options.models ?? OPENAI_HARNESS_MODELS;
    this.authentication = options.authentication ?? 'api-key';
    if (this.authentication === 'chatgpt' && normalizeOptionalString(options.apiKey) !== undefined) {
      throw new KimiError(
        ErrorCodes.CONFIG_INVALID,
        'OpenAI apiKey cannot be combined with ChatGPT authentication.',
      );
    }
    this.models = new Map(models.map((model) => [model.id, model]));
    this.defaultModel = options.defaultModel ?? models[0]?.id ?? DEFAULT_OPENAI_MODEL;
    this.promptCacheKey = normalizeOptionalString(options.promptCacheKey);
    this.codexResponsesLite = options.codexResponsesLite ?? true;
    this.apiKey = this.authentication === 'api-key' ? options.apiKey : undefined;
    this.baseUrl =
      this.authentication === 'chatgpt'
        ? resolveOpenAICodexBaseUrl(options.baseUrl)
        : options.baseUrl ?? normalizeOptionalString(process.env['OPENAI_BASE_URL']);
    this.defaultHeaders =
      this.authentication === 'chatgpt'
        ? createOpenAICodexHeaders({
            promptCacheKey: this.promptCacheKey,
            originator: options.originator,
            clientVersion: options.clientVersion,
            responsesLite: this.codexResponsesLite,
            defaultHeaders: options.defaultHeaders,
          })
        : options.defaultHeaders;
    this.tokenProvider = options.tokenProvider;

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
      offEffort: this.authentication === 'api-key' ? 'none' : undefined,
      codex:
        this.authentication === 'chatgpt'
          ? { responsesLite: this.codexResponsesLite }
          : undefined,
      generationKwargs:
        this.promptCacheKey === undefined
          ? undefined
          : { prompt_cache_key: this.promptCacheKey },
    };

    return {
      providerName:
        this.authentication === 'chatgpt' ? OPENAI_CODEX_PROVIDER_NAME : 'openai',
      provider,
      modelCapabilities: capabilityFor(definition, this.authentication),
      supportEfforts:
        this.authentication === 'chatgpt'
          ? definition.supportEfforts?.filter((effort) => effort !== 'off')
          : definition.supportEfforts,
      defaultEffort: definition.defaultEffort,
      maxOutputSize: definition.maxOutputTokens,
      type: 'openai_responses',
      protocol: undefined,
    };
  }

  resolveAuth(_model: string, _options?: { readonly log?: Logger }) {
    if (this.authentication !== 'chatgpt') return undefined;
    return async <T>(request: (auth: ProviderRequestAuth) => Promise<T>): Promise<T> => {
      let auth = await this.buildOpenAICodexAuth(false);
      for (let refreshed = false; ; refreshed = true) {
        try {
          return await request(auth);
        } catch (error) {
          if (!(error instanceof APIStatusError) || error.statusCode !== 401) throw error;
          if (refreshed) {
            throw new KimiError(
              ErrorCodes.AUTH_LOGIN_REQUIRED,
              'ChatGPT authentication was rejected after refresh. Sign in again.',
              { cause: error },
            );
          }
          auth = await this.buildOpenAICodexAuth(true);
        }
      }
    };
  }

  private async buildOpenAICodexAuth(force: boolean): Promise<ProviderRequestAuth> {
    if (this.tokenProvider === undefined) {
      throw new KimiError(
        ErrorCodes.AUTH_LOGIN_REQUIRED,
        'ChatGPT authentication requires login before the OpenAI model can be used.',
      );
    }
    const apiKey = await this.tokenProvider.getAccessToken(force ? { force: true } : undefined);
    const accountId = getOpenAICodexAccountId(apiKey);
    if (accountId === undefined) {
      throw new KimiError(
        ErrorCodes.AUTH_LOGIN_REQUIRED,
        'The stored ChatGPT token does not contain an account id. Sign in again.',
      );
    }
    return { apiKey, headers: { 'chatgpt-account-id': accountId } };
  }
}

function resolveOpenAICodexBaseUrl(value: string | undefined): string {
  const normalized = (normalizeOptionalString(value) ?? OPENAI_CODEX_BASE_URL).replace(/\/+$/, '');
  if (normalized.endsWith('/codex/responses')) {
    return normalized.slice(0, -'/responses'.length);
  }
  return normalized.endsWith('/codex') ? normalized : `${normalized}/codex`;
}

function createOpenAICodexHeaders(options: {
  readonly accountId?: string;
  readonly promptCacheKey?: string;
  readonly originator?: string;
  readonly clientVersion?: string;
  readonly responsesLite: boolean;
  readonly defaultHeaders?: Record<string, string>;
}): Record<string, string> {
  const originator = normalizeOptionalString(options.originator) ?? 'kimi-code';
  const version = normalizeOptionalString(options.clientVersion) ?? OPENAI_CODEX_CLIENT_VERSION;
  const headers: Record<string, string> = {
    'OpenAI-Beta': 'responses=experimental',
    originator,
    version,
    'User-Agent': `${originator}/${version}`,
    ...options.defaultHeaders,
  };
  if (options.promptCacheKey !== undefined) {
    headers['conversation_id'] = options.promptCacheKey;
    headers['session_id'] = options.promptCacheKey;
    headers['x-client-request-id'] = options.promptCacheKey;
  }
  if (options.accountId !== undefined) {
    headers['chatgpt-account-id'] = options.accountId;
  }
  if (options.responsesLite) {
    headers['x-openai-internal-codex-responses-lite'] = 'true';
  }
  return headers;
}

function capabilityFor(
  model: OpenAIResponsesHarnessModel,
  authentication: 'api-key' | 'chatgpt',
): ModelCapability {
  return {
    image_in: true,
    video_in: false,
    audio_in: false,
    thinking: true,
    tool_use: true,
    max_context_tokens:
      authentication === 'chatgpt'
        ? Math.min(model.maxContextTokens, 1_000_000)
        : model.maxContextTokens,
  };
}

function normalizeOptionalString(value: string | undefined): string | undefined {
  const normalized = value?.trim();
  return normalized === undefined || normalized.length === 0 ? undefined : normalized;
}
