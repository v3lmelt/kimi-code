/**
 * `workspaceIsolation` domain — Workspace-scoped isolation lease contract.
 *
 * Describes shared workspace leases and dedicated Git worktree leases, plus
 * the App-scoped backend seam used to create and remove dedicated worktrees.
 */

import { createDecorator, type ServiceIdentifier } from '#/_base/di/instantiation';

export const WORKSPACE_ISOLATION_MODES = [
  'shared-readonly',
  'shared-worktree',
  'dedicated-worktree',
] as const;

export type WorkspaceIsolationMode = (typeof WORKSPACE_ISOLATION_MODES)[number];

export const WORKSPACE_ISOLATION_LEASE_STATES = [
  'provisioning',
  'active',
  'releasing',
  'released',
  'failed',
] as const;

export type WorkspaceIsolationLeaseState =
  (typeof WORKSPACE_ISOLATION_LEASE_STATES)[number];

export interface WorkspaceIsolationAcquireOptions {
  readonly mode: WorkspaceIsolationMode;
  readonly owner?: string;
  readonly leaseId?: string;
  readonly name?: string;
  readonly directoryName?: string;
  readonly path?: string;
  readonly branch?: string;
  readonly branchName?: string;
  readonly baseRef?: string;
  readonly isolationRoot?: string;
}

export interface WorkspaceIsolationLease {
  readonly id: string;
  readonly workspaceId: string;
  readonly mode: WorkspaceIsolationMode;
  readonly state: WorkspaceIsolationLeaseState;
  readonly status: WorkspaceIsolationLeaseState;
  readonly path: string;
  readonly worktreePath: string;
  readonly workspaceRoot: string;
  readonly isolationRoot?: string;
  readonly branch?: string;
  readonly baseRef?: string;
  readonly owner?: string;
  readonly writable: boolean;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly releasedAt?: number;
  readonly error?: string;
  readonly cleanupError?: string;
}

export interface WorkspaceIsolationWorktreeRequest {
  readonly leaseId?: string;
  readonly workspaceRoot: string;
  readonly isolationRoot?: string;
  readonly worktreePath: string;
  readonly branch: string;
  readonly baseRef: string;
}

export interface WorkspaceIsolationBackend {
  addWorktree(request: WorkspaceIsolationWorktreeRequest): Promise<void>;
  removeWorktree(request: WorkspaceIsolationWorktreeRequest): Promise<void>;
  rollbackWorktree(request: WorkspaceIsolationWorktreeRequest): Promise<void>;
}

export interface IWorkspaceIsolationBackend extends WorkspaceIsolationBackend {
  readonly _serviceBrand: undefined;
}

export const IWorkspaceIsolationBackend: ServiceIdentifier<IWorkspaceIsolationBackend> =
  createDecorator<IWorkspaceIsolationBackend>('workspaceIsolationBackend');

export interface IWorkspaceIsolationService {
  readonly _serviceBrand: undefined;

  acquire(
    request: WorkspaceIsolationAcquireOptions | WorkspaceIsolationMode,
  ): Promise<WorkspaceIsolationLease>;
  create(request: WorkspaceIsolationAcquireOptions | WorkspaceIsolationMode): Promise<WorkspaceIsolationLease>;
  createDedicatedWorktree(
    request?: Omit<WorkspaceIsolationAcquireOptions, 'mode'>,
  ): Promise<WorkspaceIsolationLease>;
  get(id: string): WorkspaceIsolationLease | undefined;
  getLease(id: string): WorkspaceIsolationLease | undefined;
  list(): readonly WorkspaceIsolationLease[];
  diagnostics(): readonly WorkspaceIsolationLease[];
  release(id: string): Promise<WorkspaceIsolationLease>;
  releaseLease(id: string): Promise<WorkspaceIsolationLease>;
  whenIdle(): Promise<void>;
}

export const IWorkspaceIsolationService: ServiceIdentifier<IWorkspaceIsolationService> =
  createDecorator<IWorkspaceIsolationService>('workspaceIsolationService');
