/**
 * `memory` domain — `[memory]` config-section schema.
 *
 * Killswitch and tuning knobs for the cross-session memory subsystem:
 * `enabled` turns the whole domain off (system-prompt injection, background
 * extraction, and memory-first compaction); `dir` overrides the default memory
 * directory under the brand home; `autoExtract` gates the fire-and-forget
 * background extraction; `maxBytes` caps the memory file; the `extract*` keys
 * tune the time / turn-count double gate; `compactSummaryMaxChars` caps the
 * session memory used as a compaction summary. Self-registers at module load
 * via `registerConfigSection`.
 */

import { z } from 'zod';

import { registerConfigSection } from '#/app/config/configSectionContributions';

export const MEMORY_SECTION = 'memory';

export const MemoryConfigSchema = z.object({
  enabled: z.boolean().optional(),
  dir: z.string().optional(),
  autoExtract: z.boolean().optional(),
  maxBytes: z.number().int().positive().optional(),
  extractMinIntervalMs: z.number().int().positive().optional(),
  extractMinTurns: z.number().int().positive().optional(),
  compactSummaryMaxChars: z.number().int().positive().optional(),
});

export type MemoryConfig = z.infer<typeof MemoryConfigSchema>;

registerConfigSection(MEMORY_SECTION, MemoryConfigSchema, {
  defaultValue: {},
});
