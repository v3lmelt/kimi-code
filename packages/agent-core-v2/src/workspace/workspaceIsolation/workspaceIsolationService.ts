/**
 * `workspaceIsolation` domain — Workspace-scoped isolation lease manager.
 *
 * Resolves and confines dedicated worktree paths under a private isolation
 * root, tracks lease transitions for diagnostics, and delegates Git mutation
 * to the App-scoped backend. Shared modes return the handler workspace root;
 * dedicated mode is gated by `workspace_isolation`. Uses `workspaceContext`,
 * `hostFs`, `hostEnvironment`, and `flag` as collaborators. The lease manager
 * is bound at Workspace scope and the Git backend at App scope.
 */

import { Disposable } from '#/_base/di/lifecycle';
import { LifecycleScope } from '#/app/scopes';
import { ScopeActivation, registerScopedService } from '#/_base/di/scope';
import { Error2, ErrorCodes } from '#/errors';
import { IFlagService } from '#/app/flag/flag';
import { IHostEnvironment } from '#/os/interface/hostEnvironment';
import { IHostFileSystem, type HostFileStat } from '#/os/interface/hostFileSystem';
import { IHostProcessService, type IHostProcess } from '#/os/interface/hostProcess';
import { HostFsError, OsFsErrors } from '#/os/interface/hostFsErrors';
import { IWorkspaceContext } from '#/workspace/workspaceContext/workspaceContext';
import { dirname, isAbsolute, join, normalize, relative, resolve } from 'pathe';

import {
  IWorkspaceIsolationBackend,
  IWorkspaceIsolationService,
  type WorkspaceIsolationAcquireOptions,
  type WorkspaceIsolationLease,
  type WorkspaceIsolationLeaseState,
  type WorkspaceIsolationMode,
  type WorkspaceIsolationWorktreeRequest,
} from './workspaceIsolation';
import { workspaceIsolationFlag } from './flag';

const DEFAULT_ISOLATION_DIRECTORY = join('.kimi-code', 'worktrees');
const MAX_NAME_LENGTH = 80;
const MAX_NAME_ATTEMPTS = 1000;
const WORKTREE_FLAG = workspaceIsolationFlag.id;

interface MutableLease {
  readonly id: string;
  readonly workspaceId: string;
  readonly mode: WorkspaceIsolationMode;
  readonly path: string;
  readonly worktreePath: string;
  readonly workspaceRoot: string;
  readonly isolationRoot?: string;
  readonly branch?: string;
  readonly baseRef?: string;
  readonly owner?: string;
  readonly writable: boolean;
  readonly createdAt: number;
  state: WorkspaceIsolationLeaseState;
  updatedAt: number;
  releasedAt?: number;
  error?: string;
  cleanupError?: string;
}

interface PathInspection {
  readonly stat: HostFileStat;
  readonly realPath: string;
}

export class WorkspaceIsolationService extends Disposable implements IWorkspaceIsolationService {
  declare readonly _serviceBrand: undefined;

  private readonly leases = new Map<string, MutableLease>();
  private nextOrdinal = 0;
  private operationQueue: Promise<unknown> = Promise.resolve();
  private disposing = false;

  constructor(
    @IWorkspaceContext private readonly workspace: IWorkspaceContext,
    @IHostFileSystem private readonly fs: IHostFileSystem,
    @IHostEnvironment private readonly environment: IHostEnvironment,
    @IFlagService private readonly flags: IFlagService,
    @IWorkspaceIsolationBackend private readonly backend: IWorkspaceIsolationBackend,
  ) {
    super();
  }

  acquire(
    request: WorkspaceIsolationAcquireOptions | WorkspaceIsolationMode,
  ): Promise<WorkspaceIsolationLease> {
    const options = typeof request === 'string' ? { mode: request } : request;
    return this.enqueue(() => this.acquireLocked(options));
  }

  create(
    request: WorkspaceIsolationAcquireOptions | WorkspaceIsolationMode,
  ): Promise<WorkspaceIsolationLease> {
    return this.acquire(request);
  }

  createDedicatedWorktree(
    request: Omit<WorkspaceIsolationAcquireOptions, 'mode'> = {},
  ): Promise<WorkspaceIsolationLease> {
    return this.acquire({ ...request, mode: 'dedicated-worktree' });
  }

  get(id: string): WorkspaceIsolationLease | undefined {
    const lease = this.leases.get(id);
    return lease === undefined ? undefined : snapshotLease(lease);
  }

  getLease(id: string): WorkspaceIsolationLease | undefined {
    return this.get(id);
  }

  list(): readonly WorkspaceIsolationLease[] {
    return [...this.leases.values()].map(snapshotLease);
  }

  diagnostics(): readonly WorkspaceIsolationLease[] {
    return this.list();
  }

  release(id: string): Promise<WorkspaceIsolationLease> {
    if (this.disposing) return Promise.reject(invalidRequest('Workspace isolation service is disposing.'));
    return this.enqueue(async () => {
      const lease = this.leases.get(id);
      if (lease === undefined) {
        throw invalidRequest(`Unknown isolation lease '${id}'.`, { id });
      }
      if (lease.state === 'released') return snapshotLease(lease);
      if (lease.state === 'releasing') return snapshotLease(lease);
      await this.releaseLocked(lease);
      return snapshotLease(lease);
    });
  }

  releaseLease(id: string): Promise<WorkspaceIsolationLease> {
    return this.release(id);
  }

  whenIdle(): Promise<void> {
    return this.operationQueue.then(() => undefined);
  }

  override dispose(): void {
    if (this.disposing) return;
    this.disposing = true;
    const cleanup = this.enqueue(async () => {
      const active = [...this.leases.values()]
        .filter(
          (lease) =>
            lease.mode === 'dedicated-worktree' &&
            lease.state !== 'released',
        )
        .toReversed();
      for (const lease of active) {
        await this.releaseLocked(lease);
      }
    });
    cleanup.catch(() => {});
    super.dispose();
  }

  private async acquireLocked(
    request: WorkspaceIsolationAcquireOptions,
  ): Promise<WorkspaceIsolationLease> {
    this.assertUsable();
    if (!isWorkspaceIsolationMode(request.mode)) {
      throw invalidRequest(`Unsupported workspace isolation mode '${String(request.mode)}'.`, {
        mode: request.mode,
      });
    }

    const id = this.allocateLeaseId(request.leaseId);
    const now = Date.now();
    if (request.mode === 'shared-readonly' || request.mode === 'shared-worktree') {
      assertResolvedPathInput(this.workspace.cwd);
      const lease: MutableLease = {
        id,
        workspaceId: this.workspace.workspaceId,
        mode: request.mode,
        path: normalize(this.workspace.cwd),
        worktreePath: normalize(this.workspace.cwd),
        workspaceRoot: normalize(this.workspace.cwd),
        owner: request.owner,
        writable: request.mode === 'shared-worktree',
        createdAt: now,
        updatedAt: now,
        state: 'active',
      };
      this.leases.set(id, lease);
      return snapshotLease(lease);
    }

    if (!this.flags.enabled(WORKTREE_FLAG)) {
      throw new Error2(
        ErrorCodes.NOT_IMPLEMENTED,
        'Dedicated workspace worktrees are disabled by the workspace_isolation flag.',
      );
    }

    const paths = await this.resolveIsolationPaths(request, id);
    const branch = this.resolveBranch(request, id);
    const baseRef = request.baseRef ?? 'HEAD';
    assertGitRef(baseRef);
    const lease: MutableLease = {
      id,
      workspaceId: this.workspace.workspaceId,
      mode: request.mode,
      path: paths.target,
      worktreePath: paths.target,
      workspaceRoot: paths.workspaceRoot,
      isolationRoot: paths.isolationRoot,
      branch,
      baseRef,
      owner: request.owner,
      writable: true,
      createdAt: now,
      updatedAt: now,
      state: 'provisioning',
    };
    this.leases.set(id, lease);

    const backendRequest: WorkspaceIsolationWorktreeRequest = {
      leaseId: lease.id,
      workspaceRoot: paths.workspaceRoot,
      isolationRoot: paths.isolationRoot,
      worktreePath: paths.target,
      branch,
      baseRef,
    };
    let backendAdded = false;
    try {
      await this.backend.addWorktree(backendRequest);
      backendAdded = true;
      await this.assertCreatedWorktree(paths.isolationRoot, paths.target);
      this.transition(lease, 'active');
      return snapshotLease(lease);
    } catch (error) {
      lease.error = describeError(error);
      await this.cleanupFailedWorktree(lease, backendRequest, backendAdded);
      this.transition(lease, 'failed');
      throw error;
    }
  }

  private async releaseLocked(lease: MutableLease): Promise<void> {
    if (lease.state === 'released') return;
    if (lease.mode !== 'dedicated-worktree') {
      lease.releasedAt = Date.now();
      this.transition(lease, 'released');
      return;
    }

    if (lease.isolationRoot === undefined || lease.branch === undefined || lease.baseRef === undefined) {
      lease.error = 'Dedicated lease is missing its worktree metadata.';
      this.transition(lease, 'failed');
      return;
    }

    try {
      await this.validateLeasePath(lease);
    } catch (error) {
      lease.cleanupError = describeError(error);
      this.transition(lease, 'failed');
      return;
    }

    this.transition(lease, 'releasing');
    const request: WorkspaceIsolationWorktreeRequest = {
      leaseId: lease.id,
      workspaceRoot: lease.workspaceRoot,
      isolationRoot: lease.isolationRoot,
      worktreePath: lease.path,
      branch: lease.branch,
      baseRef: lease.baseRef,
    };
    let backendError: unknown;
    try {
      await this.backend.removeWorktree(request);
    } catch (error) {
      backendError = error;
    }

    let remaining: PathInspection | undefined;
    try {
      remaining = await this.validateLeasePath(lease);
    } catch (error) {
      lease.cleanupError = describeError(error);
      this.transition(lease, 'failed');
      return;
    }
    if (remaining === undefined) {
      if (backendError !== undefined) {
        lease.cleanupError = describeError(backendError);
        this.transition(lease, 'failed');
        return;
      }
      lease.cleanupError = undefined;
      lease.releasedAt = Date.now();
      this.transition(lease, 'released');
      return;
    }

    let fallbackError: unknown;
    try {
      await this.removeValidatedPath(lease.isolationRoot, lease.path, remaining);
    } catch (error) {
      fallbackError = error;
    }

    let afterFallback: PathInspection | undefined;
    try {
      afterFallback = await this.validateLeasePath(lease);
    } catch (error) {
      lease.cleanupError = combineErrors(backendError, fallbackError, error);
      this.transition(lease, 'failed');
      return;
    }
    if (afterFallback !== undefined) {
      lease.cleanupError = combineErrors(
        backendError,
        fallbackError,
        new Error('worktree path remains after cleanup'),
      );
      this.transition(lease, 'failed');
      return;
    }
    if (backendError !== undefined || fallbackError !== undefined) {
      lease.cleanupError = combineErrors(backendError, fallbackError);
      this.transition(lease, 'failed');
      return;
    }
    lease.cleanupError = undefined;
    lease.releasedAt = Date.now();
    this.transition(lease, 'released');
  }

  private async cleanupFailedWorktree(
    lease: MutableLease,
    request: WorkspaceIsolationWorktreeRequest,
    backendAdded: boolean,
  ): Promise<void> {
    try {
      try {
        await this.validateLeasePath(lease);
      } catch (error) {
        lease.cleanupError = describeError(error);
        return;
      }

      let cleanupError: unknown;
      if (backendAdded) {
        try {
          await this.backend.removeWorktree(request);
        } catch (error) {
          cleanupError = error;
        }
      }

      let remaining: PathInspection | undefined;
      try {
        remaining = await this.validateLeasePath(lease);
      } catch (error) {
        lease.cleanupError = combineErrors(cleanupError, error);
        return;
      }
      if (remaining !== undefined) {
        try {
          if (lease.isolationRoot === undefined) throw invalidPath(lease.path);
          await this.removeValidatedPath(lease.isolationRoot, lease.path, remaining);
        } catch (error) {
          cleanupError = cleanupError ?? error;
        }
      }
      let afterCleanup: PathInspection | undefined;
      try {
        afterCleanup = await this.validateLeasePath(lease);
      } catch (error) {
        lease.cleanupError = combineErrors(cleanupError, error);
        return;
      }
      if (afterCleanup !== undefined) {
        lease.cleanupError = combineErrors(
          cleanupError,
          new Error('worktree path remains after cleanup'),
        );
      } else if (cleanupError !== undefined) {
        lease.cleanupError = describeError(cleanupError);
      }
    } finally {
      try {
        await this.backend.rollbackWorktree(request);
      } catch (error) {
        lease.cleanupError = combineErrors(lease.cleanupError, error);
      }
      lease.updatedAt = Date.now();
    }
  }

  private async resolveIsolationPaths(
    request: WorkspaceIsolationAcquireOptions,
    leaseId: string,
  ): Promise<{
    readonly workspaceRoot: string;
      readonly isolationRoot: string;
      readonly target: string;
  }> {
    assertResolvedPathInput(this.workspace.cwd);
    assertResolvedPathInput(this.environment.homeDir);
    const workspaceRoot = await this.realPathOrThrow(this.workspace.cwd);
    await this.assertDirectory(workspaceRoot);
    const homeDir = await this.realPathOrNormalized(this.environment.homeDir);
    const rawRoot = request.isolationRoot ?? DEFAULT_ISOLATION_DIRECTORY;
    assertResolvedPathInput(rawRoot);
    const rootCandidate = isAbsolute(rawRoot)
      ? normalize(rawRoot)
      : resolve(workspaceRoot, rawRoot);
    assertAbsolutePath(rootCandidate);
    this.assertSafeIsolationRootCandidate(rootCandidate, workspaceRoot, homeDir);
    await this.assertSafePathParent(rootCandidate);
    await this.fs.mkdir(rootCandidate, { recursive: true });
    const isolationRoot = await this.realPathOrThrow(rootCandidate);
    await this.assertIsolationRoot(workspaceRoot, isolationRoot, rootCandidate, homeDir);

    const explicitPath = request.path;
    let target: string | undefined;
    if (explicitPath !== undefined) {
      assertResolvedPathInput(explicitPath);
      target = isAbsolute(explicitPath)
        ? normalize(explicitPath)
        : resolve(isolationRoot, explicitPath);
    } else {
      const name = this.resolveDirectoryName(request, leaseId);
      const first = resolve(isolationRoot, name);
      target = await this.findAvailableTarget(
        isolationRoot,
        first,
        request.name !== undefined || request.directoryName !== undefined,
      );
    }
    if (target === undefined) throw invalidPath(rootCandidate);
    this.assertSafeTargetPath(target, workspaceRoot, isolationRoot, homeDir);
    await this.assertSafePathParent(target, isolationRoot);
    const existing = await this.inspectPath(target);
    if (existing !== undefined) {
      throw new Error2(ErrorCodes.REQUEST_INVALID, `Isolation worktree path already exists: ${target}`, {
        details: { path: target },
      });
    }
    return { workspaceRoot, isolationRoot, target: normalize(target) };
  }

  private async assertCreatedWorktree(isolationRoot: string, target: string): Promise<void> {
    const workspaceRoot = await this.realPathOrThrow(this.workspace.cwd);
    const homeDir = await this.realPathOrNormalized(this.environment.homeDir);
    this.assertSafeTargetPath(target, workspaceRoot, isolationRoot, homeDir);
    await this.assertSafePathParent(target, isolationRoot);
    const inspection = await this.inspectPath(target);
    if (inspection === undefined || inspection.stat.isSymbolicLink || !inspection.stat.isDirectory) {
      throw invalidPath(target);
    }
    assertPathWithin(isolationRoot, inspection.realPath, false, this.environment.pathClass);
    if (!pathsEqual(target, inspection.realPath, this.environment.pathClass)) {
      throw invalidPath(target);
    }
  }

  private async removeValidatedPath(
    isolationRoot: string,
    target: string,
    inspection: PathInspection,
  ): Promise<void> {
    if (
      inspection.stat.isSymbolicLink ||
      (!inspection.stat.isDirectory && !inspection.stat.isFile)
    ) {
      throw invalidPath(target);
    }
    const isolationRealPath = await this.realPathOrThrow(isolationRoot);
    const workspaceRoot = await this.realPathOrThrow(this.workspace.cwd);
    const homeDir = await this.realPathOrNormalized(this.environment.homeDir);
    this.assertSafeTargetPath(target, workspaceRoot, isolationRealPath, homeDir);
    await this.assertSafePathParent(target, isolationRealPath);
    const current = await this.inspectPath(target);
    if (current === undefined) return;
    if (
      current.stat.isSymbolicLink ||
      (!current.stat.isDirectory && !current.stat.isFile)
    ) {
      throw invalidPath(target);
    }
    const targetRealPath = current.realPath;
    assertPathWithin(isolationRealPath, targetRealPath, false, this.environment.pathClass);
    if (!pathsEqual(target, targetRealPath, this.environment.pathClass)) {
      throw invalidPath(target);
    }
    await this.fs.remove(targetRealPath);
  }

  private async assertIsolationRoot(
    workspaceRoot: string,
    isolationRoot: string,
    rootCandidate: string,
    homeDir: string,
  ): Promise<void> {
    assertAbsolutePath(isolationRoot);
    if (!pathsEqual(rootCandidate, isolationRoot, this.environment.pathClass)) {
      throw invalidPath(rootCandidate);
    }
    this.assertSafeIsolationRootCandidate(isolationRoot, workspaceRoot, homeDir);
    const stat = await this.inspectPath(isolationRoot);
    if (stat === undefined || stat.stat.isSymbolicLink || !stat.stat.isDirectory) {
      throw invalidPath(isolationRoot);
    }
    if (!pathsEqual(isolationRoot, stat.realPath, this.environment.pathClass)) {
      throw invalidPath(isolationRoot);
    }
  }

  private async validateLeasePath(lease: MutableLease): Promise<PathInspection | undefined> {
    if (
      lease.isolationRoot === undefined ||
      lease.branch === undefined ||
      lease.baseRef === undefined
    ) {
      throw invalidPath(lease.path);
    }
    const workspaceRoot = await this.realPathOrThrow(this.workspace.cwd);
    const homeDir = await this.realPathOrNormalized(this.environment.homeDir);
    const isolationRoot = await this.realPathOrThrow(lease.isolationRoot);
    await this.assertIsolationRoot(workspaceRoot, isolationRoot, lease.isolationRoot, homeDir);
    if (!pathsEqual(workspaceRoot, lease.workspaceRoot, this.environment.pathClass)) {
      throw invalidPath(lease.workspaceRoot);
    }
    if (!pathsEqual(lease.path, lease.worktreePath, this.environment.pathClass)) {
      throw invalidPath(lease.path);
    }
    this.assertSafeTargetPath(lease.path, workspaceRoot, isolationRoot, homeDir);
    await this.assertSafePathParent(lease.path, isolationRoot);
    const inspection = await this.inspectPath(lease.path);
    if (inspection === undefined) return undefined;
    if (inspection.stat.isSymbolicLink) throw invalidPath(lease.path);
    if (!inspection.stat.isDirectory && !inspection.stat.isFile) {
      throw invalidPath(lease.path);
    }
    assertPathWithin(isolationRoot, inspection.realPath, false, this.environment.pathClass);
    if (!pathsEqual(lease.path, inspection.realPath, this.environment.pathClass)) {
      throw invalidPath(lease.path);
    }
    return inspection;
  }

  private assertSafeIsolationRootCandidate(
    isolationRoot: string,
    workspaceRoot: string,
    homeDir: string,
  ): void {
    assertAbsolutePath(isolationRoot);
    if (
      isFilesystemRoot(isolationRoot) ||
      isProtectedRootBoundary(
        isolationRoot,
        workspaceRoot,
        homeDir,
        this.environment.pathClass,
      )
    ) {
      throw invalidPath(isolationRoot);
    }
  }

  private assertSafeTargetPath(
    target: string,
    workspaceRoot: string,
    isolationRoot: string,
    homeDir: string,
  ): void {
    assertAbsolutePath(target);
    assertPathWithin(isolationRoot, target, false, this.environment.pathClass);
    if (
      isProtectedTarget(
        target,
        workspaceRoot,
        isolationRoot,
        homeDir,
        this.environment.pathClass,
      )
    ) {
      throw invalidPath(target);
    }
  }

  private async assertSafePathParent(path: string, boundary?: string): Promise<void> {
    assertAbsolutePath(path);
    const parent = normalize(dirname(path));
    const existing = await this.nearestExistingPath(parent);
    if (existing === undefined) throw invalidPath(path);
    if (
      existing.inspection.stat.isSymbolicLink ||
      !existing.inspection.stat.isDirectory ||
      !pathsEqual(existing.path, existing.inspection.realPath, this.environment.pathClass)
    ) {
      throw invalidPath(path);
    }
    if (boundary !== undefined) {
      assertPathWithin(
        boundary,
        existing.inspection.realPath,
        true,
        this.environment.pathClass,
      );
    }
  }

  private async nearestExistingPath(
    path: string,
  ): Promise<{ readonly path: string; readonly inspection: PathInspection } | undefined> {
    let candidate = normalize(path);
    for (;;) {
      const inspection = await this.inspectPath(candidate);
      if (inspection !== undefined) return { path: candidate, inspection };
      const parent = normalize(dirname(candidate));
      if (pathsEqual(parent, candidate, this.environment.pathClass)) return undefined;
      candidate = parent;
    }
  }

  private async assertDirectory(path: string): Promise<void> {
    const inspection = await this.inspectPath(path);
    if (
      inspection === undefined ||
      inspection.stat.isSymbolicLink ||
      !inspection.stat.isDirectory ||
      !pathsEqual(path, inspection.realPath, this.environment.pathClass)
    ) {
      throw invalidPath(path);
    }
  }

  private async findAvailableTarget(
    isolationRoot: string,
    first: string,
    explicitName: boolean,
  ): Promise<string> {
    for (let index = 0; index < MAX_NAME_ATTEMPTS; index += 1) {
      const candidate = index === 0 ? first : `${first}-${index + 1}`;
      if (!this.leasesByPath(candidate) && (await this.inspectPath(candidate)) === undefined) {
        return candidate;
      }
      if (explicitName) {
        throw new Error2(ErrorCodes.REQUEST_INVALID, `Isolation worktree path already exists: ${candidate}`, {
          details: { path: candidate },
        });
      }
    }
    throw new Error2(ErrorCodes.REQUEST_INVALID, 'Unable to allocate a unique isolation worktree path.');
  }

  private resolveDirectoryName(request: WorkspaceIsolationAcquireOptions, generatedId: string): string {
    const supplied = request.name ?? request.directoryName;
    if (supplied !== undefined) {
      assertDirectoryName(supplied);
      return supplied;
    }
    return generatedId;
  }


  private resolveBranch(request: WorkspaceIsolationAcquireOptions, id: string): string {
    const supplied = request.branchName ?? request.branch;
    if (supplied !== undefined) {
      assertBranchName(supplied);
      return supplied;
    }
    return `codex/isolation/${slug(this.workspace.workspaceId)}/${slug(id)}`;
  }

  private allocateLeaseId(requested: string | undefined): string {
    if (requested !== undefined) {
      assertLeaseId(requested);
      if (this.leases.has(requested)) {
        throw new Error2(ErrorCodes.REQUEST_INVALID, `Isolation lease id already exists: ${requested}`, {
          details: { id: requested },
        });
      }
      return requested;
    }
    let id: string;
    do {
      this.nextOrdinal += 1;
      id = `lease-${String(this.nextOrdinal).padStart(4, '0')}`;
    } while (this.leases.has(id));
    return id;
  }

  private leasesByPath(path: string): boolean {
    return [...this.leases.values()].some((lease) =>
      pathsEqual(lease.path, path, this.environment.pathClass),
    );
  }

  private transition(lease: MutableLease, state: WorkspaceIsolationLeaseState): void {
    lease.state = state;
    lease.updatedAt = Date.now();
  }

  private async inspectPath(path: string): Promise<PathInspection | undefined> {
    let stat: HostFileStat;
    try {
      stat = await this.fs.lstat(path);
    } catch (error) {
      if (error instanceof HostFsError && error.code === OsFsErrors.codes.OS_FS_NOT_FOUND) {
        return undefined;
      }
      throw error;
    }
    if (stat.isSymbolicLink) {
      return { stat, realPath: normalize(path) };
    }
    return { stat, realPath: await this.realPathOrThrow(path) };
  }

  private async realPathOrThrow(path: string): Promise<string> {
    return normalize(await this.fs.realpath(path));
  }

  private async realPathOrNormalized(path: string): Promise<string> {
    try {
      return await this.realPathOrThrow(path);
    } catch (error) {
      if (isNotFoundError(error)) return normalize(path);
      throw error;
    }
  }

  private assertUsable(): void {
    if (this.disposing) throw invalidRequest('Workspace isolation service is disposing.');
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const run = this.operationQueue.then(operation, operation);
    this.operationQueue = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }
}

export class GitWorkspaceIsolationBackend implements IWorkspaceIsolationBackend {
  declare readonly _serviceBrand: undefined;

  private readonly heldWorktrees = new Set<string>();

  constructor(@IHostProcessService private readonly hostProcess: IHostProcessService) {}

  async addWorktree(request: WorkspaceIsolationWorktreeRequest): Promise<void> {
    assertBackendRequest(request);
    const key = backendLeaseKey(request);
    if (this.heldWorktrees.has(key)) {
      throw invalidRequest('Git worktree lease is already held.', {
        leaseId: request.leaseId,
        worktreePath: request.worktreePath,
      });
    }
    this.heldWorktrees.add(key);
    try {
      await this.runGit(
        [
          'worktree',
          'add',
          '--no-checkout',
          '-b',
          request.branch,
          '--',
          request.worktreePath,
          request.baseRef,
        ],
        request.workspaceRoot,
      );
    } catch (error) {
      this.heldWorktrees.delete(key);
      throw error;
    }
  }

  async removeWorktree(request: WorkspaceIsolationWorktreeRequest): Promise<void> {
    assertBackendRequest(request);
    const key = backendLeaseKey(request);
    if (!this.heldWorktrees.has(key)) {
      throw invalidRequest('Git worktree lease is not held.', {
        leaseId: request.leaseId,
        worktreePath: request.worktreePath,
      });
    }
    await this.runGit(
      ['worktree', 'remove', '--force', '--', request.worktreePath],
      request.workspaceRoot,
    );
    this.heldWorktrees.delete(key);
  }

  async rollbackWorktree(request: WorkspaceIsolationWorktreeRequest): Promise<void> {
    assertBackendRequest(request);
    this.heldWorktrees.delete(backendLeaseKey(request));
  }

  private async runGit(args: readonly string[], cwd: string): Promise<void> {
    let process: IHostProcess;
    try {
      process = await this.hostProcess.spawn('git', args, {
        cwd,
        windowsHide: true,
        env: { GIT_TERMINAL_PROMPT: '0' },
      });
    } catch (error) {
      throw new Error2(ErrorCodes.FS_GIT_UNAVAILABLE, `git could not be started in ${cwd}`, {
        details: { cwd, args: [...args] },
        cause: error,
      });
    }
    try {
      const [stdout, stderr, exitCode] = await Promise.all([
        collect(process.stdout),
        collect(process.stderr),
        process.wait(),
      ]);
      if (exitCode !== 0) {
        throw new Error2(
          ErrorCodes.FS_GIT_UNAVAILABLE,
          stderr.trim() || stdout.trim() || `git exited with code ${exitCode}`,
          { details: { cwd, args: [...args], exitCode } },
        );
      }
    } finally {
      process.dispose();
    }
  }
}

function assertBackendRequest(request: WorkspaceIsolationWorktreeRequest): void {
  if (request.leaseId === undefined) {
    throw invalidRequest('Git worktree operations require an isolation lease.');
  }
  assertLeaseId(request.leaseId);
  if (request.isolationRoot === undefined) {
    throw invalidPath(request.worktreePath);
  }
  assertAbsolutePath(request.workspaceRoot);
  assertAbsolutePath(request.isolationRoot);
  assertAbsolutePath(request.worktreePath);
  const pathClass = inferPathClass(
    request.workspaceRoot,
    request.isolationRoot,
    request.worktreePath,
  );
  if (pathsEqual(request.workspaceRoot, request.worktreePath, pathClass)) {
    throw invalidPath(request.worktreePath);
  }
  if (pathsEqual(request.workspaceRoot, request.isolationRoot, pathClass)) {
    throw invalidPath(request.isolationRoot);
  }
  if (isFilesystemRoot(request.isolationRoot)) throw invalidPath(request.isolationRoot);
  assertPathWithin(request.isolationRoot, request.worktreePath, false, pathClass);
  assertBranchName(request.branch);
  assertGitRef(request.baseRef);
}

function backendLeaseKey(request: WorkspaceIsolationWorktreeRequest): string {
  const pathClass = inferPathClass(
    request.workspaceRoot,
    request.isolationRoot ?? '',
    request.worktreePath,
  );
  return [
    request.leaseId ?? '',
    pathKey(request.workspaceRoot, pathClass),
    pathKey(request.worktreePath, pathClass),
  ].join('\0');
}

function inferPathClass(...paths: readonly string[]): 'posix' | 'win32' {
  return paths.some((path) => /^[A-Za-z]:[\\/]/.test(path) || path.startsWith('\\\\'))
    ? 'win32'
    : 'posix';
}

async function collect(stream: AsyncIterable<Uint8Array | string>): Promise<string> {
  const decoder = new TextDecoder();
  let output = '';
  for await (const chunk of stream) {
    output += typeof chunk === 'string' ? chunk : decoder.decode(chunk, { stream: true });
  }
  return output + decoder.decode();
}

function snapshotLease(lease: MutableLease): WorkspaceIsolationLease {
  return {
    id: lease.id,
    workspaceId: lease.workspaceId,
    mode: lease.mode,
    state: lease.state,
    status: lease.state,
    path: lease.path,
    worktreePath: lease.worktreePath,
    workspaceRoot: lease.workspaceRoot,
    isolationRoot: lease.isolationRoot,
    branch: lease.branch,
    baseRef: lease.baseRef,
    owner: lease.owner,
    writable: lease.writable,
    createdAt: lease.createdAt,
    updatedAt: lease.updatedAt,
    releasedAt: lease.releasedAt,
    error: lease.error,
    cleanupError: lease.cleanupError,
  };
}

function isWorkspaceIsolationMode(value: unknown): value is WorkspaceIsolationMode {
  return value === 'shared-readonly' || value === 'shared-worktree' || value === 'dedicated-worktree';
}

function assertResolvedPathInput(value: string): void {
  if (
    value.length === 0 ||
    value.includes('\0') ||
    value.includes('$') ||
    value.includes('%') ||
    value.includes('~')
  ) {
    throw invalidPath(value);
  }
}

function assertDirectoryName(value: string): void {
  assertResolvedPathInput(value);
  if (
    value.length === 0 ||
    value.length > MAX_NAME_LENGTH ||
    value === '.' ||
    value === '..' ||
    value.includes('/') ||
    value.includes('\\')
  ) {
    throw invalidPath(value);
  }
}

function assertLeaseId(value: string): void {
  assertDirectoryName(value);
  if (!/^[A-Za-z0-9._-]+$/.test(value)) throw invalidPath(value);
}

function assertBranchName(value: string): void {
  if (
    value.length === 0 ||
    value.length > 200 ||
    value.includes('\0') ||
    value.startsWith('-') ||
    value.startsWith('/') ||
    value.endsWith('/') ||
    value.includes('..') ||
    /[\s\\~^:?*]/.test(value) || value.includes('[')
  ) {
    throw invalidRequest(`Invalid Git branch name '${value}'.`, { branch: value });
  }
}

function assertGitRef(value: string): void {
  if (
    value.length === 0 ||
    value.length > 200 ||
    value.startsWith('-') ||
    value.includes('\0') ||
    value.includes('..') ||
    /[\s\\~^:?*]/.test(value) || value.includes('[')
  ) {
    throw invalidRequest(`Invalid Git base ref '${value}'.`, { baseRef: value });
  }
}

function assertAbsolutePath(path: string): void {
  assertResolvedPathInput(path);
  if (!isAbsolute(path)) throw invalidPath(path);
}

function assertPathWithin(
  root: string,
  target: string,
  allowEqual: boolean,
  pathClass: 'posix' | 'win32' = 'posix',
): void {
  if (!isPathWithin(root, target, allowEqual, pathClass)) throw invalidPath(target);
}

function isPathWithin(
  root: string,
  target: string,
  allowEqual: boolean,
  pathClass: 'posix' | 'win32' = 'posix',
): boolean {
  const rootNormalized = pathKey(root, pathClass);
  const targetNormalized = pathKey(target, pathClass);
  const pathRelative = relative(rootNormalized, targetNormalized);
  return !(
    (pathRelative.length === 0 && !allowEqual) ||
    pathRelative === '..' ||
    pathRelative.startsWith('../') ||
    isAbsolute(pathRelative)
  );
}

function pathsEqual(
  left: string,
  right: string,
  pathClass: 'posix' | 'win32' = 'posix',
): boolean {
  return pathKey(left, pathClass) === pathKey(right, pathClass);
}

function isProtectedTarget(
  target: string,
  workspaceRoot: string,
  isolationRoot: string,
  homeDir: string,
  pathClass: 'posix' | 'win32',
): boolean {
  if (
    pathsEqual(target, workspaceRoot, pathClass) ||
    pathsEqual(target, isolationRoot, pathClass) ||
    pathsEqual(target, homeDir, pathClass)
  ) {
    return true;
  }
  return (
    isPathWithin(workspaceRoot, target, true, pathClass) &&
      !isPathWithin(workspaceRoot, isolationRoot, false, pathClass)
  ) || (
    isPathWithin(homeDir, target, true, pathClass) &&
      !isPathWithin(homeDir, isolationRoot, false, pathClass)
  );
}

function isProtectedRootBoundary(
  target: string,
  workspaceRoot: string,
  homeDir: string,
  pathClass: 'posix' | 'win32',
): boolean {
  return (
    isPathWithin(target, workspaceRoot, true, pathClass) ||
    isPathWithin(target, homeDir, true, pathClass)
  );
}

function isFilesystemRoot(path: string): boolean {
  const normalized = normalize(path);
  return (
    normalized === '/' ||
    /^[A-Za-z]:\/$/.test(normalized) ||
    /^\/\/[^/]+\/[^/]+\/?$/.test(normalized)
  );
}

function pathKey(path: string, pathClass: 'posix' | 'win32' = 'posix'): string {
  const normalized = normalize(path);
  const trimmed =
    normalized === '/' || /^[A-Za-z]:\/$/.test(normalized)
      ? normalized
      : normalized.replace(/[\\/]+$/, '');
  return pathClass === 'win32' ? trimmed.toLowerCase() : trimmed;
}

function slug(value: string): string {
  const result = value.replaceAll(/[^A-Za-z0-9._-]+/g, '-').replaceAll(/^-+|-+$/g, '');
  return result.slice(0, MAX_NAME_LENGTH) || 'workspace';
}

function invalidPath(path: string): Error2 {
  return new Error2(ErrorCodes.FS_PATH_ESCAPES, `Isolation path is not safe: ${path}`, {
    details: { path },
  });
}

function invalidRequest(message: string, details?: Readonly<Record<string, unknown>>): Error2 {
  return new Error2(ErrorCodes.REQUEST_INVALID, message, { details });
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function combineErrors(...errors: readonly unknown[]): string | undefined {
  const descriptions = errors
    .filter((error): error is unknown => error !== undefined)
    .map(describeError);
  return descriptions.length === 0 ? undefined : descriptions.join('; ');
}

function isNotFoundError(error: unknown): boolean {
  return error instanceof HostFsError && error.code === OsFsErrors.codes.OS_FS_NOT_FOUND;
}

registerScopedService(
  LifecycleScope.App,
  IWorkspaceIsolationBackend,
  GitWorkspaceIsolationBackend,
  ScopeActivation.OnScopeCreated,
  'workspaceIsolation',
);

registerScopedService(
  LifecycleScope.Workspace,
  IWorkspaceIsolationService,
  WorkspaceIsolationService,
  ScopeActivation.OnScopeCreated,
  'workspaceIsolation',
);
