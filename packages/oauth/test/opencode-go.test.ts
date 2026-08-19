import { describe, expect, it } from 'vitest';

import {
  applyOpenCodeGoConfig,
  OPENCODE_GO_DEFAULT_BASE_URL,
  OPENCODE_GO_MODELS,
  OPENCODE_GO_PROVIDER_ID,
  openCodeGoCapabilities,
  removeOpenCodeGoConfig,
  toManagedModelInfo,
  type OpenCodeGoModelDef,
} from '../src/opencode-go';
import type { ManagedKimiConfigShape } from '../src/managed-kimi-code';

function emptyConfig(): ManagedKimiConfigShape {
  return { providers: {} };
}

function findModel(id: string): OpenCodeGoModelDef {
  const model = OPENCODE_GO_MODELS.find((m) => m.id === id);
  if (model === undefined) throw new Error(`missing model ${id}`);
  return model;
}

describe('OPENCODE_GO_MODELS', () => {
  it('declares the full static model table', () => {
    expect(OPENCODE_GO_MODELS).toHaveLength(19);
  });

  it('covers all three wire protocols', () => {
    const protocols = new Set(OPENCODE_GO_MODELS.map((m) => m.protocol));
    expect(protocols).toEqual(new Set(['openai', 'openai_responses', 'anthropic']));
  });

  it('routes known models to the right protocol', () => {
    expect(findModel('kimi-k2.7-code').protocol).toBe('openai');
    expect(findModel('grok-4.5').protocol).toBe('openai_responses');
    expect(findModel('minimax-m3').protocol).toBe('anthropic');
    expect(findModel('qwen3.8-max').protocol).toBe('anthropic');
  });
});

describe('toManagedModelInfo', () => {
  it('maps a model to the ManagedKimiCodeModelInfo shape for the selection UI', () => {
    const info = toManagedModelInfo(findModel('kimi-k2.7-code'));
    expect(info.id).toBe('kimi-k2.7-code');
    expect(info.contextLength).toBeGreaterThan(0);
    expect(info.supportsReasoning).toBe(true);
    expect(info.supportsToolUse).toBe(true);
    expect(info.supportsThinkingType).toBe('both');
  });

  it('marks non-thinking models as no thinking', () => {
    const info = toManagedModelInfo(findModel('hy3'));
    expect(info.supportsReasoning).toBe(false);
    expect(info.supportsThinkingType).toBe('no');
  });

  it('carries declared effort levels for thinking models', () => {
    const info = toManagedModelInfo(findModel('minimax-m3'));
    expect(info.supportEfforts).toEqual(['low', 'medium', 'high']);
    expect(info.defaultEffort).toBe('high');
  });

  it('uses DeepSeek-native low/high/max efforts for deepseek models', () => {
    for (const id of ['deepseek-v4-flash', 'deepseek-v4-pro']) {
      const info = toManagedModelInfo(findModel(id));
      expect(info.supportEfforts).toEqual(['low', 'high', 'max']);
      expect(info.defaultEffort).toBe('high');
    }
  });

  it('leaves effort fields off non-thinking models', () => {
    const info = toManagedModelInfo(findModel('hy3'));
    expect(info.supportEfforts).toBeUndefined();
    expect(info.defaultEffort).toBeUndefined();
  });
});

describe('applyOpenCodeGoConfig', () => {
  it('writes the provider with the gateway base URL and API key', () => {
    const config = emptyConfig();
    applyOpenCodeGoConfig(config, { apiKey: 'sk-test' });

    const provider = config.providers[OPENCODE_GO_PROVIDER_ID];
    expect(provider).toMatchObject({
      type: 'opencode-go',
      baseUrl: OPENCODE_GO_DEFAULT_BASE_URL,
      apiKey: 'sk-test',
    });
  });

  it('registers every model with a wire-adapted base URL and capabilities', () => {
    const config = emptyConfig();
    applyOpenCodeGoConfig(config, { apiKey: 'sk-test' });

    const models = config.models ?? {};
    expect(Object.keys(models)).toHaveLength(OPENCODE_GO_MODELS.length);

    const chatAlias = models[`${OPENCODE_GO_PROVIDER_ID}/kimi-k2.7-code`];
    expect(chatAlias).toMatchObject({
      provider: OPENCODE_GO_PROVIDER_ID,
      model: 'kimi-k2.7-code',
      protocol: 'openai',
      baseUrl: 'https://opencode.ai/zen/go/v1',
      maxContextSize: findModel('kimi-k2.7-code').maxContextSize,
    });
    expect(chatAlias?.['capabilities']).toContain('thinking');
    expect(chatAlias?.['capabilities']).toContain('tool_use');
  });

  it('writes effort metadata into thinking model aliases', () => {
    const config = emptyConfig();
    applyOpenCodeGoConfig(config, { apiKey: 'sk-test' });

    const chat = config.models?.[`${OPENCODE_GO_PROVIDER_ID}/kimi-k2.7-code`];
    expect(chat).toMatchObject({
      supportEfforts: ['low', 'medium', 'high'],
      defaultEffort: 'high',
    });

    const anthropic = config.models?.[`${OPENCODE_GO_PROVIDER_ID}/minimax-m3`];
    expect(anthropic).toMatchObject({
      supportEfforts: ['low', 'medium', 'high'],
      adaptiveThinking: false,
    });

    const noThinking = config.models?.[`${OPENCODE_GO_PROVIDER_ID}/hy3`];
    expect(noThinking?.['supportEfforts']).toBeUndefined();
    expect(noThinking?.['adaptiveThinking']).toBeUndefined();
  });

  it('strips the trailing /v1 for Anthropic-protocol models', () => {
    const config = emptyConfig();
    applyOpenCodeGoConfig(config, { apiKey: 'sk-test' });

    const alias = config.models?.[`${OPENCODE_GO_PROVIDER_ID}/minimax-m3`];
    expect(alias).toMatchObject({ protocol: 'anthropic' });
    expect(alias?.['baseUrl']).toBe('https://opencode.ai/zen/go');
  });

  it('keeps the full /v1 base for OpenAI-family models', () => {
    const config = emptyConfig();
    applyOpenCodeGoConfig(config, { apiKey: 'sk-test' });

    const alias = config.models?.[`${OPENCODE_GO_PROVIDER_ID}/grok-4.5`];
    expect(alias).toMatchObject({ protocol: 'openai_responses' });
    expect(alias?.['baseUrl']).toBe('https://opencode.ai/zen/go/v1');
  });

  it('sets the default model to the selection and persists thinking', () => {
    const config = emptyConfig();
    applyOpenCodeGoConfig(config, {
      apiKey: 'sk-test',
      selectedModel: findModel('qwen3.8-max'),
      thinking: true,
      effort: 'high',
    });

    expect(config.defaultModel).toBe(`${OPENCODE_GO_PROVIDER_ID}/qwen3.8-max`);
    expect(config.thinking).toMatchObject({ enabled: true, effort: 'high' });
  });

  it('defaults to the first model when none is selected', () => {
    const config = emptyConfig();
    applyOpenCodeGoConfig(config, { apiKey: 'sk-test' });
    expect(config.defaultModel).toBe(`${OPENCODE_GO_PROVIDER_ID}/${OPENCODE_GO_MODELS[0]!.id}`);
  });

  it('overwrites a stale persisted effort on refresh', () => {
    const config = emptyConfig();
    config.thinking = { enabled: true, effort: 'max' };
    const result = applyOpenCodeGoConfig(config, {
      apiKey: 'sk-test',
      selectedModel: findModel('glm-5.2'),
    });
    expect(config.thinking).toMatchObject({ enabled: true, effort: 'high' });
    expect(result.defaultEffort).toBe('high');
  });

  it('removes stale models on refresh', () => {
    const config = emptyConfig();
    config.models = {
      [`${OPENCODE_GO_PROVIDER_ID}/old-model`]: {
        provider: OPENCODE_GO_PROVIDER_ID,
        model: `${OPENCODE_GO_PROVIDER_ID}/old-model`,
        maxContextSize: 128000,
      },
    };
    applyOpenCodeGoConfig(config, { apiKey: 'sk-test' });
    expect(config.models?.[`${OPENCODE_GO_PROVIDER_ID}/old-model`]).toBeUndefined();
  });
});

describe('removeOpenCodeGoConfig', () => {
  it('removes the provider, its models, and the default model', () => {
    const config = emptyConfig();
    applyOpenCodeGoConfig(config, { apiKey: 'sk-test' });
    config.defaultModel = `${OPENCODE_GO_PROVIDER_ID}/kimi-k3`;

    removeOpenCodeGoConfig(config);

    expect(config.providers[OPENCODE_GO_PROVIDER_ID]).toBeUndefined();
    const remaining = Object.keys(config.models ?? {}).filter(
      (key) => config.models?.[key]?.['provider'] === OPENCODE_GO_PROVIDER_ID,
    );
    expect(remaining).toHaveLength(0);
    expect(config.defaultModel).toBeUndefined();
  });
});

describe('openCodeGoCapabilities', () => {
  it('declares thinking only for thinking-capable models', () => {
    expect(openCodeGoCapabilities(findModel('glm-5.2'))).toContain('thinking');
    expect(openCodeGoCapabilities(findModel('hy3'))).not.toContain('thinking');
  });
});
