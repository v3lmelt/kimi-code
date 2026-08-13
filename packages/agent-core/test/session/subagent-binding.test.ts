import { describe, expect, it } from 'vitest';

import type { KimiConfig, ModelAlias } from '../../src/config';
import { SECONDARY_DERIVED_MODEL_ALIAS } from '../../src/config';
import { ErrorCodes, KimiError } from '../../src/errors';
import { FlagResolver } from '../../src/flags';
import {
  buildSubagentModelDescriptions,
  MAX_LISTED_MODELS,
  resolveSubagentBinding,
  wrapSubagentModelError,
} from '../../src/session/subagent-binding';

const flagOn = () => new FlagResolver({ KIMI_CODE_EXPERIMENTAL_SECONDARY_MODEL: '1' });
const flagOff = () => new FlagResolver({});

const own = { modelAlias: 'primary-model', thinkingEffort: 'high' };

const model = (name: string, capabilities?: string[]): ModelAlias => ({
  provider: 'test-provider',
  model: name,
  maxContextSize: 1_000_000,
  ...(capabilities !== undefined ? { capabilities } : {}),
});

const configWithSecondary: KimiConfig = {
  providers: {},
  models: {},
  secondaryModel: { model: 'cheap-model' },
};

describe('resolveSubagentBinding', () => {
  it('binds the secondary model by default when configured and the experiment is on', () => {
    const binding = resolveSubagentBinding(configWithSecondary, flagOn(), own);
    expect(binding.modelAlias).toBe('cheap-model');
    expect(binding.thinkingEffort).toBeUndefined();
  });

  it('binds the derived secondary entry when the recipe carries patch fields', () => {
    const config: KimiConfig = {
      providers: {},
      models: {},
      secondaryModel: { model: 'cheap-model', defaultEffort: 'low' },
    };
    const binding = resolveSubagentBinding(config, flagOn(), own);
    expect(binding.modelAlias).toBe(SECONDARY_DERIVED_MODEL_ALIAS);
    expect(binding.thinkingEffort).toBe('low');
  });

  it('binds the caller model for an explicit "primary" choice', () => {
    const binding = resolveSubagentBinding(configWithSecondary, flagOn(), own, 'primary');
    expect(binding.modelAlias).toBe('primary-model');
    expect(binding.thinkingEffort).toBe('high');
  });

  it('binds the caller model for an explicit "inherit" choice despite a configured secondary', () => {
    const binding = resolveSubagentBinding(configWithSecondary, flagOn(), own, 'inherit');
    expect(binding.modelAlias).toBe('primary-model');
    expect(binding.thinkingEffort).toBe('high');
  });

  it('binds a concrete model alias, resolving thinking naturally', () => {
    const binding = resolveSubagentBinding(
      configWithSecondary,
      flagOn(),
      own,
      'expensive-model',
    );
    expect(binding.modelAlias).toBe('expensive-model');
    expect(binding.thinkingEffort).toBeUndefined();
  });

  it('does not let a concrete alias fall through to the secondary branch', () => {
    const binding = resolveSubagentBinding(
      { ...configWithSecondary, models: { 'expensive-model': model('expensive-model') } },
      flagOn(),
      own,
      'expensive-model',
    );
    expect(binding.modelAlias).toBe('expensive-model');
  });

  it('inherits the caller model when the experiment is off', () => {
    const binding = resolveSubagentBinding(configWithSecondary, flagOff(), own);
    expect(binding.modelAlias).toBe('primary-model');
  });

  it('inherits the caller model when no secondary is configured', () => {
    const binding = resolveSubagentBinding({ providers: {}, models: {} }, flagOn(), own);
    expect(binding.modelAlias).toBe('primary-model');
  });
});

describe('buildSubagentModelDescriptions', () => {
  it('returns undefined when the caller model is not bound', () => {
    expect(
      buildSubagentModelDescriptions({ providers: {}, models: {} }, flagOn(), undefined),
    ).toBeUndefined();
  });

  it('lists the caller model and every configured alias without a secondary', () => {
    const desc = buildSubagentModelDescriptions(
      { providers: {}, models: { a: model('a'), b: model('b') } },
      flagOn(),
      'a',
    );
    expect(desc).toContain('Available models (pass via model):');
    expect(desc).toContain('- primary: a');
    expect(desc).toContain('- b: b');
    expect(desc).toContain('"inherit" uses your own model');
  });

  it('marks the secondary model as the default and lists it first', () => {
    const desc = buildSubagentModelDescriptions(
      { providers: {}, models: { a: model('a'), b: model('b') }, secondaryModel: { model: 'b' } },
      flagOn(),
      'a',
    );
    expect(desc).toContain('- secondary: b (default)');
    expect(desc).toContain('- primary: a');
  });

  it('annotates capability flags from the effective model alias', () => {
    const desc = buildSubagentModelDescriptions(
      {
        providers: {},
        models: { a: model('a', ['image_in', 'thinking']), b: model('b') },
      },
      flagOn(),
      'a',
    );
    expect(desc).toContain('capabilities: image_in, thinking');
  });

  it('dedupes the caller alias and excludes the derived entry', () => {
    const desc = buildSubagentModelDescriptions(
      {
        providers: {},
        models: { a: model('a'), cheap: model('cheap'), [SECONDARY_DERIVED_MODEL_ALIAS]: model('cheap') },
        secondaryModel: { model: 'cheap' },
      },
      flagOn(),
      'a',
    );
    expect(desc).toBeDefined();
    expect(desc!).not.toContain(SECONDARY_DERIVED_MODEL_ALIAS);
    // The caller alias appears only once, in the primary line, not again in
    // the enumerated list.
    expect(desc!).toContain('- primary: a');
    expect(desc!.match(/- a: a/g) ?? []).toHaveLength(0);
  });

  it('collapses extras beyond the cap into a single line', () => {
    const models: Record<string, ModelAlias> = {};
    for (let i = 0; i < MAX_LISTED_MODELS + 5; i++) {
      models[`model-${i}`] = model(`model-${i}`);
    }
    const desc = buildSubagentModelDescriptions({ providers: {}, models }, flagOn(), 'model-0');
    expect(desc).toContain('- other models: ');
  });
});

describe('wrapSubagentModelError', () => {
  const configError = (modelAlias: string): KimiError =>
    new KimiError(ErrorCodes.CONFIG_INVALID, 'Model not configured', {
      details: { model: modelAlias },
    });

  it('returns the error unchanged when the bound model is the caller model', () => {
    const error = configError('a');
    expect(wrapSubagentModelError(error, 'a', 'a')).toBe(error);
  });

  it('points at the secondary model configuration for a secondary binding', () => {
    const error = configError('cheap');
    const wrapped = wrapSubagentModelError(error, 'cheap', 'a', 'cheap');
    expect(wrapped).toBeInstanceOf(KimiError);
    expect((wrapped as KimiError).message).toContain('[secondary_model].model');
  });

  it('points at the model parameter for a concrete alias binding', () => {
    const error = configError('expensive');
    const wrapped = wrapSubagentModelError(error, 'expensive', 'a');
    expect(wrapped).toBeInstanceOf(KimiError);
    const message = (wrapped as KimiError).message;
    expect(message).toContain('not a valid [models] entry');
    expect(message).not.toContain('[secondary_model]');
  });

  it('returns non-config errors unchanged', () => {
    const error = new Error('boom');
    expect(wrapSubagentModelError(error, 'x', 'a')).toBe(error);
  });
});
