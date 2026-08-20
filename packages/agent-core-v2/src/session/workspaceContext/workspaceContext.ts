/**
 * `workspaceContext` domain — session workspace root and path access.
 *
 * Defines the `ISessionWorkspaceContext` used by the Agent side to resolve relative
 * paths against the session work directory and to enforce that file/process
 * operations stay within the workspace (plus any additional dirs). The
 * Session-scoped view is read-only; Agent scopes receive a mutable lease view
 * whose work directory follows the active workspace isolation lease. Pure
 * configuration + boundary — it performs no IO.
 * Session and Agent-scoped.
 */

import { createDecorator, type ServiceIdentifier } from '#/_base/di/instantiation';
import { Error2, ErrorCodes } from '#/errors';
import { isAbsolute, normalize, resolve } from 'pathe';

export type PathAccessOperation = 'read' | 'write' | 'execute';

export type AgentWorkspaceIsolationMode =
  | 'shared-readonly'
  | 'shared-worktree'
  | 'dedicated-worktree';

export interface AgentWorkspaceIsolationInfo {
  readonly leaseId: string;
  readonly mode: AgentWorkspaceIsolationMode;
  readonly state: 'provisioning' | 'active' | 'releasing' | 'released' | 'failed';
  readonly path: string;
  readonly workspaceRoot: string;
  readonly writable: boolean;
}

export interface ISessionWorkspaceContext {
  readonly _serviceBrand: undefined;

  readonly workDir: string;
  readonly additionalDirs: readonly string[];
  readonly isolation?: AgentWorkspaceIsolationInfo;
  resolve(rel: string): string;
  isWithin(absPath: string): boolean;
  assertAllowed(absPath: string, op: PathAccessOperation): string;
}

export const ISessionWorkspaceContext: ServiceIdentifier<ISessionWorkspaceContext> =
  createDecorator<ISessionWorkspaceContext>('sessionWorkspaceContext');

export function makeAgentWorkspaceContext(
  base: ISessionWorkspaceContext,
  initial?: AgentWorkspaceIsolationInfo,
): ISessionWorkspaceContext & { update(info?: AgentWorkspaceIsolationInfo): void } {
  let isolation = initial;

  const resolvePath = (rel: string): string =>
    isAbsolute(rel) ? normalize(rel) : resolve(currentWorkDir(), rel);

  const currentWorkDir = (): string => isolation?.path ?? base.workDir;

  const within = (root: string, target: string): boolean => {
    const normalizedRoot = normalizePath(root);
    const normalizedTarget = normalizePath(target);
    if (normalizedRoot === normalizedTarget) return true;
    const prefix = normalizedRoot.endsWith('/') ? normalizedRoot : `${normalizedRoot}/`;
    return normalizedTarget.startsWith(prefix);
  };

  const context: ISessionWorkspaceContext & {
    update(info?: AgentWorkspaceIsolationInfo): void;
  } = {
    _serviceBrand: undefined,
    get workDir() {
      return currentWorkDir();
    },
    get additionalDirs() {
      return base.additionalDirs;
    },
    get isolation() {
      return isolation;
    },
    resolve: resolvePath,
    isWithin(absPath: string): boolean {
      const target = normalize(absPath);
      // A dedicated worktree is the complete workspace boundary for every
      // operation. In particular, do not fall back to the session workspace
      // for reads or searches: doing so would make a dedicated agent able to
      // inspect files outside its lease even though its cwd points at the
      // worktree.
      if (isDedicatedIsolation(isolation)) return within(isolation.path, target);
      return within(currentWorkDir(), target) || base.isWithin(target);
    },
    assertAllowed(absPath: string, op: PathAccessOperation): string {
      const target = resolvePath(absPath);
      const active = isolation;
      if (active !== undefined) {
        if (active.state !== 'active') {
          throw workspacePathError(
            target,
            op,
            'The workspace isolation lease is not active.',
          );
        }
        if (op === 'write' && !active.writable) {
          throw workspacePathError(target, op, 'The active workspace isolation lease is read-only.');
        }
        if (isDedicatedIsolation(active) && !within(active.path, target)) {
          throw workspacePathError(
            target,
            op,
            'The path for a dedicated workspace lease must stay inside its worktree.',
          );
        }
      }
      if (!context.isWithin(target)) {
        throw workspacePathError(target, op, 'The path is outside the active workspace scope.');
      }
      return target;
    },
    update(info?: AgentWorkspaceIsolationInfo): void {
      isolation = info;
    },
  };
  return context;
}

function isDedicatedIsolation(
  isolation: AgentWorkspaceIsolationInfo | undefined,
): isolation is AgentWorkspaceIsolationInfo & { readonly mode: 'dedicated-worktree' } {
  return isolation?.mode === 'dedicated-worktree';
}

function normalizePath(value: string): string {
  return normalize(value);
}

function workspacePathError(path: string, op: PathAccessOperation, reason: string): Error2 {
  return new Error2(ErrorCodes.FS_PATH_ESCAPES, `${reason} (${op}): ${path}`, {
    details: { op, path },
  });
}
