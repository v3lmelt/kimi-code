/**
 * `readState` domain — `[read_state]` config-section schema.
 *
 * Killswitch for read-state enforcement (must-Read-before-Edit, mtime-stale
 * checks, and the unchanged-file read stub). When `enabled` is false every
 * read-state behavior is off and Read/Edit fall back to their pre-feature
 * behavior. Self-registers at module load via `registerConfigSection`.
 */

import { z } from 'zod';

import { registerConfigSection } from '#/app/config/configSectionContributions';

export const READ_STATE_SECTION = 'readState';

export const ReadStateConfigSchema = z.object({
  enabled: z.boolean().optional(),
});

export type ReadStateConfig = z.infer<typeof ReadStateConfigSchema>;

registerConfigSection(READ_STATE_SECTION, ReadStateConfigSchema, {
  defaultValue: {},
});
