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
import type { IHostFileSystem } from '#/os/interface/hostFileSystem';
import { basename, dirname, isAbsolute, normalize, relative, resolve } from 'pathe';

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
  /**
   * Re-checks a path against the active isolation boundary after resolving
   * every existing symlink component. The optional boundary root is used by
   * a dedicated agent view so a path that is inside the session workspace but
   * outside the leased worktree is still rejected.
   */
  assertAllowedRealPath?: (
    absPath: string,
    op: PathAccessOperation,
    boundaryRoot?: string,
  ) => Promise<string>;
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
    async assertAllowedRealPath(
      absPath: string,
      op: PathAccessOperation,
      boundaryRoot?: string,
    ): Promise<string> {
      const target = context.assertAllowed(absPath, op);
      const active = isolation;
      if (active === undefined) {
        return base.assertAllowedRealPath?.(target, op) ?? target;
      }
      const root =
        boundaryRoot ??
        (isDedicatedIsolation(active) ? active.path : undefined);
      return (
        base.assertAllowedRealPath?.(target, op, root) ??
        target
      );
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

/**
 * Resolves the longest existing prefix of a path. This preserves a missing
 * write target while still following symlinks in its existing ancestors.
 */
export async function realpathExistingPrefix(
  fs: Pick<IHostFileSystem, 'realpath'>,
  absPath: string,
): Promise<string> {
  const tail: string[] = [];
  let current = absPath;
  for (let i = 0; i < 256; i += 1) {
    try {
      const real = await fs.realpath(current);
      return tail.length === 0 ? real : resolve(real, ...tail.toReversed());
    } catch (error) {
      if (!isMissingPathError(error)) throw error;
      const parent = dirname(current);
      if (parent === current) return absPath;
      tail.push(basename(current));
      current = parent;
    }
  }
  return absPath;
}

/**
 * Verifies a path against real filesystem roots. A root itself must resolve
 * inside one of the allowed roots, which prevents a dedicated lease path
 * from being replaced by a junction or symlink to an external directory.
 */
export async function assertRealPathWithin(
  fs: Pick<IHostFileSystem, 'realpath'>,
  absPath: string,
  roots: readonly string[],
  op: PathAccessOperation,
  boundaryRoot?: string,
): Promise<string> {
  const target = normalize(absPath);
  const realRoots = await Promise.all(
    roots.map(async (root) => {
      const lexical = normalize(root);
      return { lexical, real: normalize(await realpathExistingPrefix(fs, lexical)) };
    }),
  );

  const inside = (candidate: string, root: string): boolean => {
    const rel = relative(root, candidate);
    return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
  };

  let boundaryReal: string | undefined;
  if (boundaryRoot !== undefined) {
    const boundaryLexical = normalize(boundaryRoot);
    const boundary = realRoots.find((root) => inside(boundaryLexical, root.lexical));
    if (boundary === undefined) {
      throw workspacePathError(
        target,
        op,
        'The isolated worktree is outside the real workspace roots.',
      );
    }
    boundaryReal = normalize(await realpathExistingPrefix(fs, boundaryLexical));
    if (!inside(boundaryReal, boundary.real)) {
      throw workspacePathError(
        target,
        op,
        'The isolated worktree resolves through a symlink outside the workspace.',
      );
    }
  }

  const resolved = normalize(await realpathExistingPrefix(fs, target));
  if (boundaryReal !== undefined) {
    if (!inside(resolved, boundaryReal)) {
      throw workspacePathError(
        target,
        op,
        'The path resolves through a symlink outside the isolated worktree.',
      );
    }
    return target;
  }
  if (!realRoots.some((root) => inside(resolved, root.real))) {
    throw workspacePathError(
      target,
      op,
      'The path resolves through a symlink outside the workspace.',
    );
  }
  return target;
}

/**
 * Applies the expensive realpath check only while an isolation lease is
 * active. The flag-off path intentionally keeps the historical lexical-only
 * behavior and does not add filesystem I/O.
 */
export async function assertWorkspacePathBeforeIO(
  context: ISessionWorkspaceContext,
  absPath: string,
  op: PathAccessOperation,
): Promise<string> {
  if (context.isolation === undefined) return absPath;
  return context.assertAllowedRealPath?.(absPath, op) ?? context.assertAllowed(absPath, op);
}

function isMissingPathError(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  const code = (error as { code?: unknown })['code'];
  return code === 'ENOENT' || code === 'ENOTDIR' || code === 'os.fs.not_found';
}

function workspacePathError(path: string, op: PathAccessOperation, reason: string): Error2 {
  return new Error2(ErrorCodes.FS_PATH_ESCAPES, `${reason} (${op}): ${path}`, {
    details: { op, path },
  });
}
