import {
  SECONDARY_DERIVED_MODEL_ALIAS,
  SECONDARY_MODEL_ENV,
  effectiveModelAlias,
  secondaryModelPatch,
  type KimiConfig,
  type ModelAlias,
  type SecondaryModelConfig,
} from '../config';
import { ErrorCodes, KimiError } from '../errors';
import type { ExperimentalFlagResolver } from '../flags';
import type { AgentModelPreference } from '../profile';

/**
 * Subagent model binding — the model-selection half of the spawn decision.
 *
 * When the `secondary-model` experiment is enabled and `[secondary_model]` is
 * configured, newly spawned subagents bind to it by default instead of
 * inheriting the caller's model. The caller (the parent model, through the
 * `Agent` / `AgentSwarm` tool `model` parameter) or the spawned profile (via
 * `model_preference`) can pick any configured model alias: `'primary'` forces
 * the caller's model, `'inherit'` explicitly inherits it, and any other
 * non-empty string is taken as a concrete `[models]` alias. A recipe with
 * patch fields binds the synthesized derived entry
 * ({@link SECONDARY_DERIVED_MODEL_ALIAS}, materialized by
 * `applySecondaryModelConfig`); a pointer-only recipe binds the pointed entry
 * directly. `default_effort` is passed as the explicit subagent thinking
 * effort; without it the child resolves thinking naturally (global thinking
 * config → the bound model's default effort) rather than inheriting the
 * caller's level. When unset, spawning behavior is unchanged: subagents
 * inherit the caller's model and effort.
 */

export type SubagentModelChoice = AgentModelPreference;

export interface SubagentModelBinding {
  readonly modelAlias: string | undefined;
  readonly thinkingEffort?: string;
}

export function resolveSecondaryModel(
  config: KimiConfig | undefined,
  flags: ExperimentalFlagResolver,
): SecondaryModelConfig | undefined {
  if (!flags.enabled('secondary-model')) return undefined;
  return config?.secondaryModel;
}

/**
 * Resolve which model a newly spawned subagent binds to. `requested` is the
 * explicit per-spawn choice (tool argument or profile preference); `own` is
 * the caller's current model state, used when inheriting.
 *
 * Precedence: a concrete `[models]` alias and `'inherit'` are handled first
 * (an arbitrary string would otherwise fall through to the secondary branch);
 * `'secondary'` (and the omitted default) bind the configured secondary model
 * when the experiment is on and it is set; `'primary'` binds the caller's
 * model.
 */
export function resolveSubagentBinding(
  config: KimiConfig | undefined,
  flags: ExperimentalFlagResolver,
  own: { readonly modelAlias: string | undefined; readonly thinkingEffort: string },
  requested?: SubagentModelChoice,
): SubagentModelBinding {
  // Concrete `[models]` alias — bind it directly; effort resolves naturally.
  if (isConcreteModelAlias(requested)) {
    return { modelAlias: requested, thinkingEffort: undefined };
  }
  // Explicitly inherit the caller's model, even when a secondary is set.
  if (requested === 'inherit') {
    return { modelAlias: own.modelAlias, thinkingEffort: own.thinkingEffort };
  }
  const secondary = resolveSecondaryModel(config, flags);
  if (requested !== 'primary' && secondary?.model !== undefined) {
    return {
      modelAlias:
        secondaryModelPatch(secondary) === undefined
          ? secondary.model
          : SECONDARY_DERIVED_MODEL_ALIAS,
      thinkingEffort: secondary.defaultEffort,
    };
  }
  return { modelAlias: own.modelAlias, thinkingEffort: own.thinkingEffort };
}

function isConcreteModelAlias(
  requested: SubagentModelChoice | undefined,
): requested is string {
  return (
    requested !== undefined &&
    requested !== 'primary' &&
    requested !== 'secondary' &&
    requested !== 'inherit'
  );
}

/**
 * The "Available models" block appended to the `Agent` / `AgentSwarm` tool
 * descriptions so the parent model knows it can pick. Lists the caller's
 * model, the configured secondary model (when set), and every configured
 * `[models]` alias, each suffixed with its resolved capability flags so the
 * parent can route multimodal or thinking-heavy tasks without guessing from
 * the id. `undefined` when the caller's model is not bound yet.
 *
 * Truncation: beyond {@link MAX_LISTED_MODELS} aliases, the extras collapse
 * into a single comma-joined line so a large catalog does not bloat the
 * per-turn tool description.
 */
export const MAX_LISTED_MODELS = 24;

const ADVERTISED_CAPABILITY_FLAGS = [
  'image_in',
  'video_in',
  'audio_in',
  'thinking',
  'tool_use',
  'dynamically_loaded_tools',
] as const;

function capabilitiesSuffix(capabilities: readonly string[] | undefined): string {
  if (capabilities === undefined) return '';
  const names = ADVERTISED_CAPABILITY_FLAGS.filter((flag) => capabilities.includes(flag));
  return `; capabilities: ${names.length === 0 ? 'none' : names.join(', ')}`;
}

function resolvedCapabilities(
  config: KimiConfig | undefined,
  modelAlias: string,
): readonly string[] | undefined {
  const alias: ModelAlias | undefined = config?.models?.[modelAlias];
  if (alias === undefined) return undefined;
  return effectiveModelAlias(alias).capabilities;
}

export function buildSubagentModelDescriptions(
  config: KimiConfig | undefined,
  flags: ExperimentalFlagResolver,
  callerModelAlias: string | undefined,
): string | undefined {
  if (callerModelAlias === undefined) return undefined;
  if (!flags.enabled('secondary-model')) return undefined;
  const secondary = resolveSecondaryModel(config, flags);
  const lines: string[] = [];
  const seen = new Set<string>();

  const addLine = (
    alias: string,
    label: string,
    note: string,
    isDefault: boolean,
  ): void => {
    if (seen.has(alias)) return;
    seen.add(alias);
    lines.push(
      `- ${label}: ${alias}${isDefault ? ' (default)' : ''}${note}${capabilitiesSuffix(
        resolvedCapabilities(config, alias),
      )}`,
    );
  };

  addLine(
    callerModelAlias,
    'primary',
    ' — the main model you are running on; use it for hard, quality-sensitive subagent tasks',
    false,
  );
  if (secondary?.model !== undefined && secondary.model !== callerModelAlias) {
    addLine(
      secondary.model,
      'secondary',
      ' — the configured secondary model; prefer it for routine subagent tasks',
      true,
    );
  }

  const rest = Object.keys(config?.models ?? {}).filter(
    (alias) => alias !== SECONDARY_DERIVED_MODEL_ALIAS && !seen.has(alias),
  );
  if (rest.length > MAX_LISTED_MODELS) {
    for (const alias of rest.slice(0, MAX_LISTED_MODELS)) {
      addLine(alias, alias, '', false);
    }
    lines.push(`- other models: ${rest.slice(MAX_LISTED_MODELS).join(', ')}`);
  } else {
    for (const alias of rest) {
      addLine(alias, alias, '', false);
    }
  }

  lines.push(
    '"inherit" uses your own model; this is the default when no secondary model is configured.',
  );
  return ['Available models (pass via model):', ...lines].join('\n');
}

/**
 * Strip the `model` property from a subagent collaboration tool's advertised
 * JSON schema. While the `secondary-model` experiment is off the parameter is
 * a silent no-op, so the schema the model sees (and the args validator
 * compiled from the same advertised schema) drops it entirely — the
 * secondary-model concept never enters the prompt, and a stray `model`
 * argument is rejected instead of silently inheriting the caller's model.
 * Returns the input unchanged when there is no `model` property; otherwise a
 * shallow copy — the input is never mutated, so callers can keep both
 * variants as shared constants.
 */
export function stripSubagentModelParameter(
  parameters: Record<string, unknown>,
): Record<string, unknown> {
  const properties = parameters['properties'];
  if (typeof properties !== 'object' || properties === null || !('model' in properties)) {
    return parameters;
  }
  const nextProperties = { ...(properties as Record<string, unknown>) };
  delete nextProperties['model'];
  const next: Record<string, unknown> = { ...parameters, properties: nextProperties };
  const required = parameters['required'];
  if (Array.isArray(required) && required.includes('model')) {
    next['required'] = required.filter((entry) => entry !== 'model');
  }
  return next;
}

/**
 * Point a spawn-time model resolution failure at the source of the bound
 * model when it is not the caller's own — otherwise the parent model sees a
 * bare "model not configured" error. Failures on the secondary model hint at
 * `[secondary_model]`; failures on a concrete `model` / `model_preference`
 * alias hint at the tool/profile field that named it.
 */
export function wrapSubagentModelError(
  error: unknown,
  boundModel: string,
  callerModelAlias: string | undefined,
  secondaryModel?: string | undefined,
): unknown {
  if (boundModel === callerModelAlias) return error;
  if (!(error instanceof KimiError) || error.code !== ErrorCodes.CONFIG_INVALID) return error;
  // ProviderManager tags only the missing-alias failure with details.model;
  // malformed aliases and providers must keep their own actionable errors.
  if (error.details?.['model'] !== boundModel) return error;
  if (boundModel === SECONDARY_DERIVED_MODEL_ALIAS || boundModel === secondaryModel) {
    const displayModel =
      boundModel === SECONDARY_DERIVED_MODEL_ALIAS
        ? `the derived entry "${SECONDARY_DERIVED_MODEL_ALIAS}"`
        : `"${boundModel}"`;
    return new KimiError(
      error.code,
      `${error.message} (secondary model ${displayModel} comes from [secondary_model].model / ${SECONDARY_MODEL_ENV} — check that it names a valid [models] entry)`,
      {
        cause: error,
        details: {
          ...error.details,
          secondaryModel: boundModel,
        },
      },
    );
  }
  return new KimiError(
    error.code,
    `${error.message} (model "${boundModel}" is not a valid [models] entry — pass a configured model alias via the Agent tool's model parameter or the agent's model_preference)`,
    {
      cause: error,
      details: {
        ...error.details,
        modelChoice: boundModel,
      },
    },
  );
}
