/**
 * `workspaceIsolation` domain — Workspace-scope lease and backend contract
 * tests. The unit cases use an injectable backend and a temporary filesystem;
 * the final case exercises the real Git backend only inside a temporary repo.
 */

import { mkdtemp, rm, symlink } from 'node:fs/promises';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { join } from 'pathe';

import { createScopedTestHost, stubPair, type ScopedTestHost } from '#/_base/di/test';
import { LifecycleScope } from '#/app/scopes';
import {
  _clearScopedRegistryForTests,
  registerScopedService,
  ScopeActivation,
} from '#/_base/di/scope';
import { IFlagService } from '#/app/flag/flag';
import { IHostEnvironment } from '#/os/interface/hostEnvironment';
import { HostFileSystem } from '#/os/backends/node-local/hostFsService';
import { HostProcessService } from '#/os/backends/node-local/hostProcessService';
import { IHostFileSystem } from '#/os/interface/hostFileSystem';
import {
  IHostProcessService,
  type HostProcessOptions,
  type IHostProcess,
} from '#/os/interface/hostProcess';
import {
  IWorkspaceContext,
  type IWorkspaceContext as WorkspaceContext,
} from '#/workspace/workspaceContext/workspaceContext';

import {
  IWorkspaceIsolationBackend,
  IWorkspaceIsolationService,
  type IWorkspaceIsolationBackend as WorkspaceIsolationBackend,
  type WorkspaceIsolationWorktreeRequest,
} from '#/workspace/workspaceIsolation/workspaceIsolation';
import {
  GitWorkspaceIsolationBackend,
  WorkspaceIsolationService,
} from '#/workspace/workspaceIsolation/workspaceIsolationService';

class RecordingBackend implements WorkspaceIsolationBackend {
  declare readonly _serviceBrand: undefined;

  readonly addRequests: WorkspaceIsolationWorktreeRequest[] = [];
  readonly removeRequests: WorkspaceIsolationWorktreeRequest[] = [];
  failAdd = false;
  failRemove = false;

  constructor(private readonly fs: IHostFileSystem) {}

  async addWorktree(request: WorkspaceIsolationWorktreeRequest): Promise<void> {
    this.addRequests.push(request);
    await this.fs.mkdir(request.worktreePath, { recursive: true });
    if (this.failAdd) throw new Error('backend add failed');
  }

  async removeWorktree(request: WorkspaceIsolationWorktreeRequest): Promise<void> {
    this.removeRequests.push(request);
    if (this.failRemove) throw new Error('backend remove failed');
    await this.fs.remove(request.worktreePath);
  }

  async rollbackWorktree(_request: WorkspaceIsolationWorktreeRequest): Promise<void> {}
}

class PostValidationProcess implements IHostProcess {
  declare readonly _serviceBrand: undefined;

  private sabotaged = false;

  constructor(
    private readonly process: IHostProcess,
    private readonly sabotage: () => Promise<void>,
  ) {}

  get pid(): number {
    return this.process.pid;
  }

  get exitCode(): number | null {
    return this.process.exitCode;
  }

  get stdin(): IHostProcess['stdin'] {
    return this.process.stdin;
  }

  get stdout(): IHostProcess['stdout'] {
    return this.process.stdout;
  }

  get stderr(): IHostProcess['stderr'] {
    return this.process.stderr;
  }

  async wait(): Promise<number> {
    const exitCode = await this.process.wait();
    if (exitCode === 0 && !this.sabotaged) {
      this.sabotaged = true;
      await this.sabotage();
    }
    return exitCode;
  }

  kill(signal?: NodeJS.Signals): Promise<void> {
    return this.process.kill(signal);
  }

  dispose(): void {
    this.process.dispose();
  }
}

class PostValidationProcessService implements IHostProcessService {
  declare readonly _serviceBrand: undefined;

  constructor(
    private readonly delegate: IHostProcessService,
    private readonly fs: IHostFileSystem,
    private readonly outside: () => string | undefined,
  ) {}

  async spawn(
    command: string,
    args: readonly string[] = [],
    options: HostProcessOptions = {},
  ): Promise<IHostProcess> {
    const process = await this.delegate.spawn(command, args, options);
    const outside = this.outside();
    if (
      outside === undefined ||
      command !== 'git' ||
      args[0] !== 'worktree' ||
      args[1] !== 'add' ||
      typeof args[6] !== 'string'
    ) {
      return process;
    }
    const target = args[6];
    return new PostValidationProcess(process, async () => {
      await this.fs.remove(target);
      await linkDirectory(outside, target);
    });
  }
}

function context(root: string): WorkspaceContext {
  return {
    _serviceBrand: undefined,
    workspaceId: 'workspace-test',
    cwd: root,
    source: 'local',
    meta: {
      id: 'workspace-test',
      root,
      name: 'test',
      createdAt: 1,
      lastOpenedAt: 1,
    },
    persistenceScope: 'sessions/workspace-test',
    osBackendId: 'local',
    persistenceBackendId: 'local',
  };
}

function environment(homeDir: string): IHostEnvironment {
  return {
    _serviceBrand: undefined,
    osKind: 'Linux',
    osArch: 'x64',
    osVersion: 'test',
    shellName: 'bash',
    shellPath: '/bin/bash',
    pathClass: 'posix',
    homeDir,
    ready: Promise.resolve(),
  };
}

function flags(enabled: boolean): IFlagService {
  return {
    _serviceBrand: undefined,
    registry: {} as IFlagService['registry'],
    enabled: () => enabled,
    snapshot: () => ({ workspace_isolation: enabled }),
    enabledIds: () => (enabled ? ['workspace_isolation'] : []),
    explain: () => undefined,
    explainAll: () => [],
    setConfigOverrides: () => {},
  };
}

async function exists(fs: IHostFileSystem, path: string): Promise<boolean> {
  try {
    await fs.lstat(path);
    return true;
  } catch {
    return false;
  }
}

async function linkDirectory(target: string, path: string): Promise<void> {
  await symlink(target, path, process.platform === 'win32' ? 'junction' : 'dir');
}

async function runHostProcess(
  service: IHostProcessService,
  command: string,
  args: readonly string[],
  cwd: string,
): Promise<void> {
  const process = await service.spawn(command, args, { cwd, windowsHide: true });
  await Promise.all([drain(process.stdout), drain(process.stderr), process.wait()]);
  process.dispose();
}

async function drain(stream: AsyncIterable<Uint8Array | string>): Promise<void> {
  for await (const _chunk of stream) {
  }
}

describe('WorkspaceIsolationService', () => {
  let root: string;
  let homeDir: string;
  let host: ScopedTestHost | undefined;
  let service: IWorkspaceIsolationService | undefined;
  let backend: RecordingBackend | undefined;
  let fs: IHostFileSystem;

  beforeEach(async () => {
    _clearScopedRegistryForTests();
    registerScopedService(
      LifecycleScope.Workspace,
      IWorkspaceIsolationService,
      WorkspaceIsolationService,
      ScopeActivation.OnDemand,
      'workspaceIsolation',
    );
    root = await mkdtemp(join(process.env['TEMP'] ?? process.env['TMP'] ?? '/tmp', 'isolation-root-'));
    homeDir = await mkdtemp(join(process.env['TEMP'] ?? process.env['TMP'] ?? '/tmp', 'isolation-home-'));
    fs = new HostFileSystem();
    backend = new RecordingBackend(fs);
    host = createScopedTestHost([
      stubPair(IWorkspaceContext, context(root)),
      stubPair(IHostFileSystem, fs),
      stubPair(IHostEnvironment, environment(homeDir)),
      stubPair(IFlagService, flags(true)),
      stubPair(IWorkspaceIsolationBackend, backend),
    ]);
    const workspace = host.child(LifecycleScope.Workspace, 'workspace-test');
    service = workspace.accessor.get(IWorkspaceIsolationService);
  });

  afterEach(async () => {
    const currentService = service;
    host?.dispose();
    if (currentService !== undefined) await currentService.whenIdle();
    host = undefined;
    service = undefined;
    await rm(root, { recursive: true, force: true });
    await rm(homeDir, { recursive: true, force: true });
  });

  it('resolves through the Workspace scope and creates uniquely named dedicated leases', async () => {
    const first = await service!.createDedicatedWorktree({ owner: 'agent-a' });
    const second = await service!.createDedicatedWorktree({ owner: 'agent-b' });

    expect(first.state).toBe('active');
    expect(second.state).toBe('active');
    expect(first.path).not.toBe(second.path);
    expect(first.path.startsWith(join(root, '.kimi-code', 'worktrees'))).toBe(true);
    expect(service!.list().map((lease) => lease.id)).toEqual([first.id, second.id]);
    expect(backend!.addRequests).toHaveLength(2);
  });

  it('returns shared modes without invoking the Git backend', async () => {
    const readonlyLease = await service!.acquire('shared-readonly');
    const sharedLease = await service!.acquire({ mode: 'shared-worktree', owner: 'agent' });

    expect(readonlyLease.path).toBe(root);
    expect(readonlyLease.writable).toBe(false);
    expect(sharedLease.path).toBe(root);
    expect(sharedLease.writable).toBe(true);
    expect(backend!.addRequests).toHaveLength(0);

    await service!.release(readonlyLease.id);
    await service!.releaseLease(sharedLease.id);
    expect(service!.get(readonlyLease.id)?.state).toBe('released');
    expect(service!.get(sharedLease.id)?.state).toBe('released');
  });

  it('makes repeated release idempotent and performs cleanup once', async () => {
    const lease = await service!.createDedicatedWorktree();

    const firstRelease = await service!.release(lease.id);
    const secondRelease = await service!.release(lease.id);

    expect(firstRelease.state).toBe('released');
    expect(secondRelease.state).toBe('released');
    expect(backend!.removeRequests).toHaveLength(1);
    expect(await exists(fs, lease.path)).toBe(false);
  });

  it('rejects traversal and protected isolation roots before creating a lease', async () => {
    await expect(service!.createDedicatedWorktree({ name: '../escape' })).rejects.toMatchObject({
      code: 'fs.path_escapes',
    });
    await expect(
      service!.createDedicatedWorktree({ isolationRoot: root }),
    ).rejects.toMatchObject({ code: 'fs.path_escapes' });
    expect(service!.list()).toEqual([]);
  });

  it('rejects symlinked isolation roots and target parents before backend mutation', async () => {
    const outside = await mkdtemp(join(process.env['TEMP'] ?? process.env['TMP'] ?? '/tmp', 'isolation-outside-'));
    try {
      const linkedRoot = join(root, 'linked-root');
      await linkDirectory(outside, linkedRoot);
      await expect(
        service!.createDedicatedWorktree({ isolationRoot: linkedRoot }),
      ).rejects.toMatchObject({ code: 'fs.path_escapes' });

      const isolationRoot = join(root, '.kimi-code', 'worktrees');
      await fs.mkdir(isolationRoot, { recursive: true });
      const redirect = join(isolationRoot, 'redirect');
      await linkDirectory(outside, redirect);
      await expect(
        service!.createDedicatedWorktree({ path: join('redirect', 'lease') }),
      ).rejects.toMatchObject({ code: 'fs.path_escapes' });
      expect(backend!.addRequests).toHaveLength(0);
      expect(await exists(fs, join(outside, 'lease'))).toBe(false);
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });

  it('refuses release after the leased path is replaced by a symlink', async () => {
    const outside = await mkdtemp(join(process.env['TEMP'] ?? process.env['TMP'] ?? '/tmp', 'isolation-release-outside-'));
    try {
      const lease = await service!.createDedicatedWorktree();
      await fs.remove(lease.path);
      await linkDirectory(outside, lease.path);

      const released = await service!.release(lease.id);

      expect(released.state).toBe('failed');
      expect(released.cleanupError).toContain('Isolation path is not safe');
      expect(backend!.removeRequests).toHaveLength(0);
      expect(await exists(fs, outside)).toBe(true);
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });

  it('retains a failed lease and cleans a partially created path', async () => {
    backend!.failAdd = true;

    await expect(service!.createDedicatedWorktree()).rejects.toThrow('backend add failed');

    const [failed] = service!.diagnostics();
    expect(failed?.state).toBe('failed');
    expect(failed?.error).toContain('backend add failed');
    expect(await exists(fs, failed!.path)).toBe(false);
    expect(backend!.removeRequests).toHaveLength(0);
  });

  it('falls back to a validated directory cleanup when Git removal fails', async () => {
    const lease = await service!.createDedicatedWorktree();
    backend!.failRemove = true;

    const released = await service!.release(lease.id);

    expect(released.state).toBe('failed');
    expect(released.cleanupError).toContain('backend remove failed');
    expect(await exists(fs, lease.path)).toBe(false);
  });

  it('cleans active dedicated leases in reverse creation order during dispose', async () => {
    const first = await service!.createDedicatedWorktree();
    const second = await service!.createDedicatedWorktree();
    const currentService = service!;

    host!.dispose();
    host!.dispose();
    await currentService.whenIdle();

    expect(backend!.removeRequests.map((request) => request.worktreePath)).toEqual([
      second.path,
      first.path,
    ]);
    expect(currentService.get(first.id)?.state).toBe('released');
    expect(currentService.get(second.id)?.state).toBe('released');
    host = undefined;
  });
});

describe('GitWorkspaceIsolationBackend', () => {
  let root: string;
  let homeDir: string;
  let host: ScopedTestHost | undefined;
  let postValidationOutside: string | undefined;

  beforeEach(async () => {
    _clearScopedRegistryForTests();
    registerScopedService(
      LifecycleScope.App,
      IHostFileSystem,
      HostFileSystem,
      ScopeActivation.OnScopeCreated,
      'hostFs',
    );
    registerScopedService(
      LifecycleScope.App,
      IHostProcessService,
      HostProcessService,
      ScopeActivation.OnScopeCreated,
      'hostProcess',
    );
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
      ScopeActivation.OnDemand,
      'workspaceIsolation',
    );
    const fs = new HostFileSystem();
    const wrappedProcessService = new PostValidationProcessService(
      new HostProcessService(),
      fs,
      () => postValidationOutside,
    );
    root = await mkdtemp(join(process.env['TEMP'] ?? process.env['TMP'] ?? '/tmp', 'git-isolation-'));
    homeDir = await mkdtemp(join(process.env['TEMP'] ?? process.env['TMP'] ?? '/tmp', 'git-isolation-home-'));
    host = createScopedTestHost([
      stubPair(IWorkspaceContext, context(root)),
      stubPair(IHostFileSystem, fs),
      stubPair(IHostProcessService, wrappedProcessService),
      stubPair(IHostEnvironment, environment(homeDir)),
      stubPair(IFlagService, flags(true)),
    ]);
    const processService = host.app.accessor.get(IHostProcessService);
    await runHostProcess(processService, 'git', ['init'], root);
    await runHostProcess(processService, 'git', ['config', 'user.email', 'test@example.test'], root);
    await runHostProcess(processService, 'git', ['config', 'user.name', 'Test User'], root);
    await fs.writeText(join(root, 'README.md'), 'temporary integration repository\n');
    await runHostProcess(processService, 'git', ['add', 'README.md'], root);
    await runHostProcess(processService, 'git', ['commit', '-m', 'initial'], root);
  });

  afterEach(async () => {
    postValidationOutside = undefined;
    host?.dispose();
    host = undefined;
    await rm(root, { recursive: true, force: true });
    await rm(homeDir, { recursive: true, force: true });
  });

  it('creates and removes a real Git worktree under a temporary isolation root', async () => {
    const workspace = host!.child(LifecycleScope.Workspace, 'workspace-test');
    const service = workspace.accessor.get(IWorkspaceIsolationService);
    const fs = host!.app.accessor.get(IHostFileSystem);
    const lease = await service.createDedicatedWorktree({ owner: 'integration' });
    const processService = host!.app.accessor.get(IHostProcessService);

    expect((await fs.stat(lease.path)).isDirectory).toBe(true);
    await runHostProcess(processService, 'git', ['rev-parse', '--is-inside-work-tree'], lease.path);

    await service.release(lease.id);
    expect(await exists(fs, lease.path)).toBe(false);
  });

  it('releases the held Git key when worktree add fails and permits the same request to retry', async () => {
    const backend = host!.app.accessor.get(IWorkspaceIsolationBackend);
    const fs = host!.app.accessor.get(IHostFileSystem);
    const isolationRoot = join(root, '.kimi-code', 'worktrees');
    const request: WorkspaceIsolationWorktreeRequest = {
      leaseId: 'retry-add',
      workspaceRoot: root,
      isolationRoot,
      worktreePath: join(isolationRoot, 'retry-add'),
      branch: 'codex/isolation/retry-add',
      baseRef: 'HEAD',
    };
    await fs.mkdir(isolationRoot, { recursive: true });

    await expect(
      backend.addWorktree({ ...request, baseRef: 'missing-base-ref' }),
    ).rejects.toMatchObject({ code: 'fs.git_unavailable' });
    await expect(backend.addWorktree(request)).resolves.toBeUndefined();

    await backend.removeWorktree(request);
    expect(await exists(fs, request.worktreePath)).toBe(false);
  });

  it('releases the held Git key after post-add validation fails without deleting an outside path', async () => {
    const outside = await mkdtemp(
      join(process.env['TEMP'] ?? process.env['TMP'] ?? '/tmp', 'git-isolation-outside-'),
    );
    try {
      postValidationOutside = outside;
      const workspace = host!.child(LifecycleScope.Workspace, 'workspace-test');
      const service = workspace.accessor.get(IWorkspaceIsolationService);
      const fs = host!.app.accessor.get(IHostFileSystem);
      const backend = host!.app.accessor.get(IWorkspaceIsolationBackend);

      await expect(
        service.createDedicatedWorktree({ leaseId: 'post-validation', name: 'post-validation' }),
      ).rejects.toMatchObject({ code: 'fs.path_escapes' });

      const failed = service.get('post-validation');
      expect(failed?.state).toBe('failed');
      expect(failed?.cleanupError).toContain('Isolation path is not safe');
      expect(await exists(fs, outside)).toBe(true);

      await fs.remove(failed!.path);
      const processService = host!.app.accessor.get(IHostProcessService);
      await runHostProcess(processService, 'git', ['worktree', 'prune'], root);
      await runHostProcess(processService, 'git', ['branch', '-D', failed!.branch!], root);

      postValidationOutside = undefined;
      const request: WorkspaceIsolationWorktreeRequest = {
        leaseId: failed!.id,
        workspaceRoot: failed!.workspaceRoot,
        isolationRoot: failed!.isolationRoot,
        worktreePath: failed!.worktreePath,
        branch: failed!.branch!,
        baseRef: failed!.baseRef!,
      };
      await expect(backend.addWorktree(request)).resolves.toBeUndefined();
      await backend.removeWorktree(request);
      expect(await exists(fs, outside)).toBe(true);
    } finally {
      postValidationOutside = undefined;
      await rm(outside, { recursive: true, force: true });
    }
  });

  it('rejects Git removal without a held lease and with a non-absolute target', async () => {
    const backend = host!.app.accessor.get(IWorkspaceIsolationBackend);
    const isolationRoot = join(root, '.kimi-code', 'worktrees');
    await expect(
      backend.removeWorktree({
        leaseId: 'unheld',
        workspaceRoot: root,
        isolationRoot,
        worktreePath: join(isolationRoot, 'unheld'),
        branch: 'codex/isolation/unheld',
        baseRef: 'HEAD',
      }),
    ).rejects.toMatchObject({ code: 'request.invalid' });
    await expect(
      backend.removeWorktree({
        leaseId: 'relative',
        workspaceRoot: root,
        isolationRoot,
        worktreePath: 'relative-target',
        branch: 'codex/isolation/relative',
        baseRef: 'HEAD',
      }),
    ).rejects.toMatchObject({ code: 'fs.path_escapes' });
  });
});
