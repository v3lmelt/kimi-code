/**
 * `toolExecutor` domain — `toolExecutor` config-section schema.
 *
 * Owns the `[tool_executor]` section: `max_parallel_tool_calls` bounds the
 * rolling dispatch pool for parallel tool calls in one model step. Unset keeps
 * the previous unbounded dispatch (access-conflict scheduling only). Self-
 * registered at module load via `registerConfigSection`.
 */

import { z } from 'zod';

import { registerConfigSection } from '#/app/config/configSectionContributions';

export const TOOL_EXECUTOR_SECTION = 'toolExecutor';

export const ToolExecutorConfigSchema = z.object({
  maxParallelToolCalls: z.number().int().min(1).optional(),
});

export type ToolExecutorConfig = z.infer<typeof ToolExecutorConfigSchema>;

registerConfigSection(TOOL_EXECUTOR_SECTION, ToolExecutorConfigSchema);
