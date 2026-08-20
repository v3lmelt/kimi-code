/**
 * `workspaceIsolation` domain — registers the experimental isolation flag.
 *
 * Owns the default-off switch for dedicated worktree provisioning. Bound at
 * App scope through the flag registry contribution channel.
 */

import { type FlagDefinitionInput, registerFlagDefinition } from '#/app/flag/flagRegistry';

export const workspaceIsolationFlag: FlagDefinitionInput = {
  id: 'workspace_isolation',
  title: 'Workspace isolation',
  description: 'Allow parallel agents to use dedicated Git worktrees.',
  env: 'KIMI_CODE_EXPERIMENTAL_WORKSPACE_ISOLATION',
  default: false,
  surface: 'core',
};

registerFlagDefinition(workspaceIsolationFlag);
