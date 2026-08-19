/**
 * `ultracode` domain — the `[agent]` config section.
 *
 * Owns the agent-level mode toggles that gate ultracode / workflow
 * orchestration:
 *
 * - `workflowKeywordTriggerEnabled` (default `true`): whether a bare
 *   `chesto!` token in a user prompt opts the turn into ultracode mode
 *   (the `onBeforeSubmitPrompt` keyword trigger). Set to `false` to require
 *   an explicit manual entry or the config-forced mode.
 * - `workflowToolEnabled` (default `true`): whether the `Workflow` tool is
 *   active in every session (the default), so the orchestration tool is
 *   available without entering ultracode mode. Set to `false` to keep the
 *   tool gated behind ultracode mode.
 * - `ultracode` (default `false`): when `true`, the agent runs in ultracode
 *   mode from the start — the config-forced equivalent of entering the mode —
 *   so the `Workflow` tool is active and the maintenance loop runs without
 *   needing the keyword. Exiting the mode is a no-op while this is set.
 *
 * Mirrors Claude Code's `[agent]`-section shape: a small set of agent-level
 * feature switches resolved as `defaults -> config.toml -> env overlay ->
 * memory` like every other section. Self-registered at module load via
 * `registerConfigSection`; the section becomes available as soon as this
 * module is imported.
 */

import { z } from 'zod';

import { registerConfigSection } from '#/app/config/configSectionContributions';

/** On-disk / runtime key of the agent config section. */
export const AGENT_SECTION = 'agent';

export const AGENT_CONFIG_DEFAULT_WORKFLOW_KEYWORD_TRIGGER = true;
export const AGENT_CONFIG_DEFAULT_WORKFLOW_TOOL_ENABLED = true;
export const AGENT_CONFIG_DEFAULT_ULTRACODE = false;

export const AgentConfigSchema = z.object({
  workflowKeywordTriggerEnabled: z.boolean().default(AGENT_CONFIG_DEFAULT_WORKFLOW_KEYWORD_TRIGGER),
  workflowToolEnabled: z.boolean().default(AGENT_CONFIG_DEFAULT_WORKFLOW_TOOL_ENABLED),
  ultracode: z.boolean().default(AGENT_CONFIG_DEFAULT_ULTRACODE),
});

export type AgentConfig = z.infer<typeof AgentConfigSchema>;

registerConfigSection(AGENT_SECTION, AgentConfigSchema, {
  defaultValue: {
    workflowKeywordTriggerEnabled: AGENT_CONFIG_DEFAULT_WORKFLOW_KEYWORD_TRIGGER,
    workflowToolEnabled: AGENT_CONFIG_DEFAULT_WORKFLOW_TOOL_ENABLED,
    ultracode: AGENT_CONFIG_DEFAULT_ULTRACODE,
  },
});
