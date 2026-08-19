/**
 * `tools` domain — `[workflow]` config-section schema and budget resolution.
 *
 * Owns the `[workflow]` configuration section. Today it carries a single
 * field, `token_budget`, the ceiling the `budget` global reports as `total`
 * for a workflow run. The runtime already feeds real accounting into
 * `budget.spent()` / `budget.remaining()` from every subagent completion's
 * reported `TokenUsage`; `token_budget` is the configurable ceiling those
 * readings are measured against (defaults to `WORKFLOW_DEFAULT_TOKEN_BUDGET`).
 * Self-registered at module load via `registerConfigSection`.
 */

import { z } from 'zod';

import { type IConfigService } from '#/app/config/config';
import { registerConfigSection } from '#/app/config/configSectionContributions';

import { WORKFLOW_DEFAULT_TOKEN_BUDGET } from './workflow';

export const WORKFLOW_SECTION = 'workflow';

export const WorkflowConfigSchema = z.object({
  tokenBudget: z.number().int().min(1).optional(),
});

export type WorkflowConfig = z.infer<typeof WorkflowConfigSchema>;

/** Resolve the token-budget ceiling a workflow run reports as `budget.total`. */
export function resolveWorkflowTokenBudget(config: IConfigService): number {
  return config.get<WorkflowConfig | undefined>(WORKFLOW_SECTION)?.tokenBudget ?? WORKFLOW_DEFAULT_TOKEN_BUDGET;
}

registerConfigSection(WORKFLOW_SECTION, WorkflowConfigSchema, {
  defaultValue: { tokenBudget: WORKFLOW_DEFAULT_TOKEN_BUDGET },
});
