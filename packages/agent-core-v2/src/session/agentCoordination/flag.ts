/**
 * `agentCoordination` domain — experimental feature registration.
 *
 * Contributes the opt-in gate for canonical task paths, cross-tree-safe
 * collaboration, explicit context inheritance, and the coordination tools.
 * Bound at App scope through the shared flag registry.
 */

import { registerFlagDefinition, type FlagDefinitionInput } from '#/app/flag/flagRegistry';

export const AGENT_COORDINATION_FLAG_ID = 'agent_coordination';

export const agentCoordinationFlag: FlagDefinitionInput = {
  id: AGENT_COORDINATION_FLAG_ID,
  title: 'Agent coordination task tree',
  description:
    'Enable canonical task paths, explicit context policies, and same-session agent coordination.',
  env: 'KIMI_CODE_EXPERIMENTAL_AGENT_COORDINATION',
  default: false,
  surface: 'core',
};

registerFlagDefinition(agentCoordinationFlag);
