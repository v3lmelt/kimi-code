import type { ManagedKimiCodeModelInfo, ManagedKimiConfigShape } from './managed-kimi-code';
import { isRecord } from './utils';

/**
 * OpenCode Go — opencode's low-cost open-source model subscription
 * (https://opencode.ai/docs/go). One gateway base URL serves three wire
 * protocols, selected per model:
 *  - `openai_responses`  → POST /responses
 *  - `openai`            → POST /chat/completions
 *  - `anthropic`         → POST /messages
 *
 * Provisioning writes the provider + a static model table into config.toml
 * (like the managed Kimi / open-platform flows); each model alias declares its
 * own `protocol` + wire-adapted `baseUrl` so both agent engines route it to the
 * right transport with zero kosong changes.
 */

export type OpenCodeGoProtocol = 'openai' | 'openai_responses' | 'anthropic';

export interface OpenCodeGoModelDef {
  readonly id: string;
  readonly protocol: OpenCodeGoProtocol;
  readonly maxContextSize: number;
  /** Declared prompt/input cap below the total window, when known. */
  readonly maxInputSize?: number;
  readonly thinking: boolean;
  readonly toolUse?: boolean;
  /** Thinking-effort levels the model accepts on its wire. */
  readonly supportEfforts?: readonly string[];
  /** Default effort persisted alongside the alias; the UI middle entry when absent. */
  readonly defaultEffort?: string;
  /**
   * Explicit budget-style thinking for anthropic-protocol models whose backend
   * does not speak Claude 4.7+'s adaptive `thinking`/`output_config` encoding.
   */
  readonly adaptiveThinking?: boolean;
}

export const OPENCODE_GO_PROVIDER_ID = 'opencode-go';
export const OPENCODE_GO_DEFAULT_BASE_URL = 'https://opencode.ai/zen/go/v1';
export const OPENCODE_GO_API_KEY_ENV = 'OPENCODE_GO_API_KEY';

/**
 * Context windows mirror models.dev's `opencode-go` provider `limit.context`
 * (verified 2026-08-17 against the live gateway catalog; `minimax-m2.5` was
 * dropped the same day when upstream deprecated it, and `glm-5.3` was added). The alias key is
 * the prefixed id (`opencode-go/<id>`); the wire-facing `model` is the bare id
 * — the gateway rejects the prefixed form (verified against the live API,
 * HTTP 401 "Model opencode-go/… is not supported").
 */
/** Standard effort levels every thinking opencode-go model accepts on its wire. */
const THINKING_EFFORTS = ['low', 'medium', 'high'] as const;
/** DeepSeek V4-Pro/Flash speak low/high/max (no medium), per api-docs.deepseek.com. */
const DEEPSEEK_THINKING_EFFORTS = ['low', 'high', 'max'] as const;
const DEFAULT_EFFORT = 'high' as const;

export const OPENCODE_GO_MODELS: readonly OpenCodeGoModelDef[] = [
  // OpenAI Responses
  { id: 'grok-4.5', protocol: 'openai_responses', maxContextSize: 500_000, thinking: true, supportEfforts: THINKING_EFFORTS, defaultEffort: DEFAULT_EFFORT },
  { id: 'gpt-5.6-luna', protocol: 'openai_responses', maxContextSize: 1_050_000, thinking: true, supportEfforts: THINKING_EFFORTS, defaultEffort: DEFAULT_EFFORT },
  // OpenAI chat/completions
  { id: 'glm-5.3', protocol: 'openai', maxContextSize: 1_000_000, thinking: true, supportEfforts: THINKING_EFFORTS, defaultEffort: DEFAULT_EFFORT },
  { id: 'glm-5.2', protocol: 'openai', maxContextSize: 1_000_000, thinking: true, supportEfforts: THINKING_EFFORTS, defaultEffort: DEFAULT_EFFORT },
  { id: 'glm-5.1', protocol: 'openai', maxContextSize: 202_752, thinking: true, supportEfforts: THINKING_EFFORTS, defaultEffort: DEFAULT_EFFORT },
  { id: 'kimi-k3', protocol: 'openai', maxContextSize: 1_048_576, thinking: true, supportEfforts: THINKING_EFFORTS, defaultEffort: DEFAULT_EFFORT },
  { id: 'kimi-k2.7-code', protocol: 'openai', maxContextSize: 262_144, thinking: true, supportEfforts: THINKING_EFFORTS, defaultEffort: DEFAULT_EFFORT },
  { id: 'kimi-k2.6', protocol: 'openai', maxContextSize: 262_144, thinking: true, supportEfforts: THINKING_EFFORTS, defaultEffort: DEFAULT_EFFORT },
  { id: 'deepseek-v4-pro', protocol: 'openai', maxContextSize: 1_000_000, thinking: true, supportEfforts: DEEPSEEK_THINKING_EFFORTS, defaultEffort: DEFAULT_EFFORT },
  { id: 'deepseek-v4-flash', protocol: 'openai', maxContextSize: 1_000_000, thinking: true, supportEfforts: DEEPSEEK_THINKING_EFFORTS, defaultEffort: DEFAULT_EFFORT },
  { id: 'mimo-v2.5', protocol: 'openai', maxContextSize: 1_000_000, thinking: false },
  { id: 'mimo-v2.5-pro', protocol: 'openai', maxContextSize: 1_048_576, thinking: false },
  { id: 'hy3', protocol: 'openai', maxContextSize: 256_000, thinking: false },
  // Anthropic messages — MiniMax/Qwen speak the legacy budget-style thinking
  // encoding, not Claude 4.7+'s adaptive `thinking`/`output_config`, so force
  // budget mode (adaptiveThinking: false) instead of letting the profile
  // inference fall back to the latest Opus adaptive profile.
  { id: 'minimax-m3', protocol: 'anthropic', maxContextSize: 1_000_000, thinking: true, supportEfforts: THINKING_EFFORTS, defaultEffort: DEFAULT_EFFORT, adaptiveThinking: false },
  { id: 'minimax-m2.7', protocol: 'anthropic', maxContextSize: 204_800, thinking: true, supportEfforts: THINKING_EFFORTS, defaultEffort: DEFAULT_EFFORT, adaptiveThinking: false },
  { id: 'qwen3.8-max', protocol: 'anthropic', maxContextSize: 1_000_000, thinking: true, supportEfforts: THINKING_EFFORTS, defaultEffort: DEFAULT_EFFORT, adaptiveThinking: false },
  { id: 'qwen3.7-max', protocol: 'anthropic', maxContextSize: 1_000_000, thinking: true, supportEfforts: THINKING_EFFORTS, defaultEffort: DEFAULT_EFFORT, adaptiveThinking: false },
  { id: 'qwen3.7-plus', protocol: 'anthropic', maxContextSize: 1_000_000, thinking: true, supportEfforts: THINKING_EFFORTS, defaultEffort: DEFAULT_EFFORT, adaptiveThinking: false },
  { id: 'qwen3.6-plus', protocol: 'anthropic', maxContextSize: 1_000_000, thinking: true, supportEfforts: THINKING_EFFORTS, defaultEffort: DEFAULT_EFFORT, adaptiveThinking: false },
];

function openCodeGoModelKey(modelId: string): string {
  return `${OPENCODE_GO_PROVIDER_ID}/${modelId}`;
}

/**
 * The Anthropic SDK appends `/v1/messages` itself, so an Anthropic-protocol
 * model must point at `…/zen/go` (not `…/zen/go/v1`, which would POST to
 * `/v1/v1/messages`). OpenAI-family SDKs append `/chat/completions` /
 * `/responses` to a `/v1` base, so those keep the full path.
 */
function wireBaseUrl(baseUrl: string, protocol: OpenCodeGoProtocol): string {
  const normalized = baseUrl.replace(/\/+$/, '');
  return protocol === 'anthropic' ? normalized.replace(/\/v1\/?$/, '') : normalized;
}

export function openCodeGoCapabilities(model: OpenCodeGoModelDef): string[] | undefined {
  const caps = new Set<string>();
  if (model.thinking) caps.add('thinking');
  if (model.toolUse ?? true) caps.add('tool_use');
  return caps.size > 0 ? [...caps] : undefined;
}

/** Shape consumed by the existing model-selection UI (`ManagedKimiCodeModelInfo`). */
export function toManagedModelInfo(model: OpenCodeGoModelDef): ManagedKimiCodeModelInfo {
  return {
    id: model.id,
    contextLength: model.maxContextSize,
    supportsReasoning: model.thinking,
    supportsImageIn: false,
    supportsVideoIn: false,
    supportsToolUse: model.toolUse ?? true,
    supportsThinkingType: model.thinking ? 'both' : 'no',
    ...(model.supportEfforts !== undefined ? { supportEfforts: model.supportEfforts } : {}),
    ...(model.defaultEffort !== undefined ? { defaultEffort: model.defaultEffort } : {}),
  };
}

export interface ApplyOpenCodeGoConfigResult {
  readonly defaultModel: string;
  readonly defaultThinking: boolean;
  readonly defaultEffort: string | undefined;
}

export function applyOpenCodeGoConfig(
  config: ManagedKimiConfigShape,
  options: {
    readonly apiKey: string;
    readonly baseUrl?: string | undefined;
    readonly selectedModel?: OpenCodeGoModelDef | undefined;
    readonly thinking?: boolean | undefined;
    /** Concrete thinking effort to persist (e.g. 'low'/'high'/'max'). */
    readonly effort?: string | undefined;
  },
): ApplyOpenCodeGoConfigResult {
  const baseUrl = (options.baseUrl ?? OPENCODE_GO_DEFAULT_BASE_URL).replace(/\/+$/, '');
  const providerKey = OPENCODE_GO_PROVIDER_ID;

  const providerConfig: Record<string, unknown> = {
    type: 'opencode-go',
    baseUrl,
    apiKey: options.apiKey,
  };
  config.providers[providerKey] = providerConfig;

  const existingModels = config.models ?? {};
  // Selectively merge the static table into the existing config so fields the
  // user added by hand survive a refresh; models no longer in the table are
  // removed.
  const upstreamKeys = new Set(OPENCODE_GO_MODELS.map((m) => openCodeGoModelKey(m.id)));
  for (const [key, model] of Object.entries(existingModels)) {
    if (isRecord(model) && model['provider'] === providerKey && !upstreamKeys.has(key)) {
      delete existingModels[key];
    }
  }
  for (const model of OPENCODE_GO_MODELS) {
    const aliasKey = openCodeGoModelKey(model.id);
    const alias: Record<string, unknown> = {
      provider: providerKey,
      model: model.id,
      maxContextSize: model.maxContextSize,
      protocol: model.protocol,
      baseUrl: wireBaseUrl(baseUrl, model.protocol),
      capabilities: openCodeGoCapabilities(model),
    };
    if (model.maxInputSize !== undefined) {
      alias['maxInputSize'] = model.maxInputSize;
    }
    if (model.supportEfforts !== undefined) {
      alias['supportEfforts'] = model.supportEfforts;
    }
    if (model.defaultEffort !== undefined) {
      alias['defaultEffort'] = model.defaultEffort;
    }
    if (model.adaptiveThinking !== undefined) {
      alias['adaptiveThinking'] = model.adaptiveThinking;
    }
    existingModels[aliasKey] = alias;
  }
  config.models = existingModels;

  const selected = options.selectedModel ?? OPENCODE_GO_MODELS[0]!;
  config.defaultModel = openCodeGoModelKey(selected.id);
  config.thinking = {
    ...config.thinking,
    enabled: options.thinking ?? selected.thinking,
    // Re-login refreshes the model table; a stale persisted effort (e.g.
    // 'max' for a secondary DeepSeek alias) would otherwise be sent verbatim
    // to models that only accept low/medium/high.
    effort:
      options.effort ??
      (selected.defaultEffort ?? (selected.supportEfforts?.includes('high') ? 'high' : undefined)),
  };

  return {
    defaultModel: config.defaultModel,
    defaultThinking: config.thinking.enabled === true,
    defaultEffort: config.thinking.effort,
  };
}

export function removeOpenCodeGoConfig(config: ManagedKimiConfigShape): void {
  delete config.providers[OPENCODE_GO_PROVIDER_ID];

  const existingModels = config.models ?? {};
  for (const [key, model] of Object.entries(existingModels)) {
    if (!isRecord(model) || model['provider'] !== OPENCODE_GO_PROVIDER_ID) continue;
    delete existingModels[key];
    if (config.defaultModel === key) {
      config.defaultModel = undefined;
    }
  }
  config.models = existingModels;

  if (config['defaultProvider'] === OPENCODE_GO_PROVIDER_ID) {
    config['defaultProvider'] = undefined;
  }
}
