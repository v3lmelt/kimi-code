/**
 * `subagent` domain — registers the `secondary-model` experimental flag
 * into `flag`.
 *
 * Gates secondary-model selection for newly spawned subagents, including the
 * agent-facing model choices and startup validation warning. Off by default;
 * enable via `KIMI_CODE_EXPERIMENTAL_SECONDARY_MODEL`, the master
 * `KIMI_CODE_EXPERIMENTAL_FLAG`, or the `[experimental]` config section.
 */

import { type FlagDefinitionInput, registerFlagDefinition } from '#/app/flag/flagRegistry';

export const SECONDARY_MODEL_FLAG_ID = 'secondary-model';
export const SECONDARY_MODEL_FLAG_ENV = 'KIMI_CODE_EXPERIMENTAL_SECONDARY_MODEL';

export const secondaryModelFlag: FlagDefinitionInput = {
  id: SECONDARY_MODEL_FLAG_ID,
  title: 'Subagent model selection',
  description:
    'Let newly spawned subagents bind to the configured secondary model by default, or to any configured model via the Agent/AgentSwarm model parameter or an agent model_preference.',
  env: SECONDARY_MODEL_FLAG_ENV,
  default: true,
  surface: 'core',
};

registerFlagDefinition(secondaryModelFlag);
