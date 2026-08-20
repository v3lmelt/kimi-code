import type { FlagDefinitionInput } from './types';

/**
 * Experimental feature flags.
 *
 * To add one, append an entry and gate runtime behavior through the scoped
 * resolver available on `KimiCore`, `Session`, or `Agent`:
 *   { id: 'my_feature', title: 'My feature', description: '...', env: 'KIMI_CODE_EXPERIMENTAL_MY_FEATURE', default: false, surface: 'both' }
 *
 * Keep the `as const satisfies` — it derives the literal `FlagId` union that gives `enabled()`
 * autocomplete and typo-checking. `env` must start with 'KIMI_CODE_EXPERIMENTAL_', be unique, and
 * not equal the master switch 'KIMI_CODE_EXPERIMENTAL_FLAG'; `id` must not be 'flag'.
 */
export const FLAG_DEFINITIONS = [
  // Micro compaction has been disabled and removed: the capability cannot be
  // enabled via env, config, or the master experimental switch. The entry is
  // kept here commented out so it can be restored if the feature is revived.
  // {
  //   id: 'micro_compaction',
  //   title: 'Micro compaction',
  //   description: 'Trim older large tool results from context while keeping recent conversation intact.',
  //   env: 'KIMI_CODE_EXPERIMENTAL_MICRO_COMPACTION',
  //   default: false,
  //   surface: 'core',
  // },
  {
    id: 'tool-select',
    title: 'Tool select (progressive tool disclosure)',
    description:
      'Keep MCP tool schemas out of the immutable top-level tools[]; the model loads them on demand via the select_tools tool. Only takes effect on models whose capability catalog declares dynamically loaded tools.',
    env: 'KIMI_CODE_EXPERIMENTAL_TOOL_SELECT',
    default: false,
    surface: 'core',
  },
  {
    id: 'responses-websocket',
    title: 'OpenAI Responses WebSocket',
    description:
      'Reuse the ChatGPT Responses WebSocket and continue exact request extensions with previous_response_id.',
    env: 'KIMI_CODE_EXPERIMENTAL_RESPONSES_WEBSOCKET',
    default: false,
    surface: 'core',
  },
  {
    id: 'secondary-model',
    title: 'Subagent model selection',
    description:
      'Let newly spawned subagents bind to the configured secondary model by default, or to any configured model via the Agent/AgentSwarm model parameter or an agent model_preference.',
    env: 'KIMI_CODE_EXPERIMENTAL_SECONDARY_MODEL',
    default: true,
    surface: 'core',
  },
] as const satisfies readonly FlagDefinitionInput[];

/** Literal union of registered flag ids. */
export type FlagId = (typeof FLAG_DEFINITIONS)[number]['id'];
