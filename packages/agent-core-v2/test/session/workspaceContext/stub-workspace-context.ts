import {
  makeAgentWorkspaceContext,
  type AgentWorkspaceIsolationMode,
  type ISessionWorkspaceContext,
} from '#/session/workspaceContext/workspaceContext';

export function stubWorkspaceContext(
  workDir: string,
  additionalDirs: readonly string[] = [],
): ISessionWorkspaceContext {
  return {
    _serviceBrand: undefined,
    workDir,
    additionalDirs,
    resolve: (rel) => `${workDir}/${rel}`,
    isWithin: () => true,
    assertAllowed: (absPath) => absPath,
  };
}

export function stubAgentWorkspaceContext(
  mode: AgentWorkspaceIsolationMode,
  workDir = '/workspace/.kimi-code/worktrees/agent',
): ISessionWorkspaceContext {
  return makeAgentWorkspaceContext(stubWorkspaceContext('/workspace'), {
    leaseId: `lease-${mode}`,
    mode,
    state: 'active',
    path: mode === 'dedicated-worktree' ? workDir : '/workspace',
    workspaceRoot: '/workspace',
    writable: mode !== 'shared-readonly',
  });
}
