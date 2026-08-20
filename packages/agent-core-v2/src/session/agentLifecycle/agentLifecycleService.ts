/**
 * `agentLifecycle` domain — `IAgentLifecycleService` implementation.
 *
 * Creates and tracks the session's agents as child scopes in a flat registry,
 * serializing same-id bootstrap and dropping incomplete handles after startup
 * failure. Enforces the subagent nesting depth cap against the persisted
 * parent chain, stamping each subagent with its depth label. Seeds each
 * agent's identity through `agent` scopeContext, wires
 * per-agent wire records and the wire state machine, the blob store, and MCP,
 * allocates an optional workspace-isolation lease before Agent scope creation,
 * and registers the agent in the session registry. Binds the agent id into the
 * Agent-scoped telemetry view. New logs receive a metadata
 * envelope while non-empty unversioned logs are rejected. Removal awaits the
 * agent task manager's graceful exit policy before draining turns and full
 * compaction, then disposing the child scope. Fans session-level
 * permission-mode switches out to every live agent. Bound at Session scope.
 *
 * No agent id is special here: the main agent is simply the agent created
 * with the conventional `MAIN_AGENT_ID`, and `fork` requires its source to
 * exist. MCP readiness is not awaited here: the workspace's shared manager
 * connects in the background and the agent's LLM steps wait on it instead
 * (see `AgentMcpService`).
 */

import { IInstantiationService } from '#/_base/di/instantiation';
import { Disposable, type IDisposable } from '#/_base/di/lifecycle';
import { Emitter } from '#/_base/event';
import { Error2, ErrorCodes } from '#/errors';
import { join } from 'pathe';
import { LifecycleScope } from '#/app/scopes';
import {
  createScopedChildHandle,
  type IAgentScopeHandle,
  ScopeActivation,
  registerScopedService,
} from '#/_base/di/scope';
import { IBootstrapService } from '#/app/bootstrap/bootstrap';
import { IConfigService } from '#/app/config/config';
import { IFlagService } from '#/app/flag/flag';
import { IEventBus } from '#/app/event/eventBus';
import { DEFAULT_PERMISSION_MODE_SECTION } from '#/agent/permissionMode/configSection';
import { PermissionModeConfiguredModel } from '#/agent/permissionMode/permissionModeOps';
import type { PermissionMode } from '#/agent/permissionPolicy/types';
import { IAgentTaskService } from '#/agent/task/task';
import { ISessionContext } from '#/session/sessionContext/sessionContext';
import {
  ISessionWorkspaceContext,
  makeAgentWorkspaceContext,
  type AgentWorkspaceIsolationInfo,
  type ISessionWorkspaceContext as SessionWorkspaceContext,
} from '#/session/workspaceContext/workspaceContext';
import { ISessionMetadata } from '#/session/sessionMetadata/sessionMetadata';
import { IAgentScopeContext, makeAgentScopeContext } from '#/agent/scopeContext/scopeContext';
import { IAgentLoopService } from '#/agent/loop/loop';
import { IAgentProfileService } from '#/agent/profile/profile';
import { abortError } from '#/_base/utils/abort';
import { IAgentPermissionModeService } from '#/agent/permissionMode/permissionMode';
import { IAgentContextMemoryService } from '#/agent/contextMemory/contextMemory';
import { IAgentFullCompactionService } from '#/agent/fullCompaction/fullCompaction';
import { IAgentToolActivationService } from '#/agent/toolActivation/toolActivation';
import { ISessionInteractionService } from '#/session/interaction/interaction';
import { IWireService } from '#/wire/wire';
import { ITelemetryService } from '#/app/telemetry/telemetry';
import { ISessionAgentProfileCatalog } from '#/session/sessionAgentProfileCatalog/sessionAgentProfileCatalog';
import {
  IWorkspaceIsolationService,
  type WorkspaceIsolationLease,
  type WorkspaceIsolationMode,
} from '#/workspace/workspaceIsolation/workspaceIsolation';
import { workspaceIsolationFlag } from '#/workspace/workspaceIsolation/flag';
import {
  type AgentListFilter,
  type CreateAgentOptions,
  type ForkAgentOptions,
  IAgentLifecycleService,
  SUBAGENT_DEPTH_CAP,
} from './agentLifecycle';
import { SUBAGENT_DEPTH_LABEL, subagentDepth } from './subagentMetadata';

let nextAgentId = 0;

// NOTE: stays Disposable — its own 'get' and 'config' collide with the Fiber
export class AgentLifecycleService extends Disposable implements IAgentLifecycleService {
  declare readonly _serviceBrand: undefined;
  private readonly handles = new Map<string, IAgentScopeHandle>();
  private readonly onDidCreateEmitter = this._register(new Emitter<IAgentScopeHandle>());
  private readonly onDidDisposeEmitter = this._register(new Emitter<string>());
  private readonly interactionBusDisposables = new Map<string, IDisposable>();
  private readonly creating = new Map<string, Promise<IAgentScopeHandle>>();
  private readonly isolationLeases = new Map<string, WorkspaceIsolationLease>();
  /**
   * Lease transitions are serialized per Agent. `turn.ended` releases are
   * asynchronous, so a follow-up must wait for that release before deciding
   * whether it can reuse or must reacquire a lease.
   */
  private readonly isolationOperations = new Map<string, Promise<void>>();
  private readonly workspaceContexts = new Map<
    string,
    SessionWorkspaceContext & { update(info?: AgentWorkspaceIsolationInfo): void }
  >();
  private disposed = false;

  get onDidCreate() {
    return this.onDidCreateEmitter.event;
  }
  get onDidDispose() {
    return this.onDidDisposeEmitter.event;
  }

  constructor(
    @IInstantiationService private readonly instantiation: IInstantiationService,
    @ISessionContext private readonly ctx: ISessionContext,
    @ISessionMetadata private readonly sessionMetadata: ISessionMetadata,
    @IBootstrapService private readonly bootstrap: IBootstrapService,
    @IConfigService private readonly config: IConfigService,
    @ISessionInteractionService private readonly interaction: ISessionInteractionService,
    @ITelemetryService private readonly telemetry: ITelemetryService,
    @ISessionWorkspaceContext private readonly sessionWorkspace: SessionWorkspaceContext,
    @ISessionAgentProfileCatalog private readonly profileCatalog: ISessionAgentProfileCatalog,
    @IWorkspaceIsolationService private readonly isolation?: IWorkspaceIsolationService,
    @IFlagService private readonly flags?: IFlagService,
  ) {
    super();
    this._register(this.onDidCreate((handle) => this.subscribeInteractionBus(handle)));
    this._register(
      this.onDidDispose((agentId) => {
        const d = this.interactionBusDisposables.get(agentId);
        if (d !== undefined) {
          d.dispose();
          this.interactionBusDisposables.delete(agentId);
        }
      }),
    );
    this._register({
      dispose: () => {
        for (const d of this.interactionBusDisposables.values()) d.dispose();
        this.interactionBusDisposables.clear();
      },
    });
  }

  private subscribeInteractionBus(handle: IAgentScopeHandle): void {
    if (this.interactionBusDisposables.has(handle.id)) return;
    const bus = handle.accessor.get(IEventBus);
    const interaction = bus.subscribe('turn.ended', (e) => this.interaction.cancelPendingForTurn(e.turnId));
    const release = bus.subscribe('turn.ended', () => {
        if (handle.id !== 'main') void this.releaseIsolation(handle.id).catch(() => {});
      });
    this.interactionBusDisposables.set(handle.id, {
      dispose: () => {
        interaction.dispose();
        release.dispose();
      },
    });
  }

  async create(opts: CreateAgentOptions = {}): Promise<IAgentScopeHandle> {
    if (opts.agentId !== undefined) {
      const inflight = this.creating.get(opts.agentId);
      if (inflight !== undefined) return inflight;
      const existing = this.handles.get(opts.agentId);
      if (existing !== undefined) return existing;
    }
    const agentId = opts.agentId ?? (await this.nextAvailableAgentId());
    const promise = this.doCreate(agentId, opts);
    this.creating.set(agentId, promise);
    try {
      return await promise;
    } finally {
      this.creating.delete(agentId);
    }
  }

  private async nextAvailableAgentId(): Promise<string> {
    let maxSuffix = -1;
    const consider = (id: string): void => {
      const match = /^agent-(\d+)$/.exec(id);
      if (match !== null) maxSuffix = Math.max(maxSuffix, Number(match[1]));
    };
    for (const id of this.handles.keys()) consider(id);
    const persisted = (await this.sessionMetadata.read()).agents ?? {};
    for (const id of Object.keys(persisted)) consider(id);
    const candidate = Math.max(maxSuffix + 1, nextAgentId);
    nextAgentId = candidate + 1;
    return `agent-${String(candidate)}`;
  }

  private async doCreate(agentId: string, opts: CreateAgentOptions): Promise<IAgentScopeHandle> {
    const agentScope = this.ctx.scope(`agents/${agentId}`);
    const agentHomedir = join(this.bootstrap.homeDir, agentScope);
    const workspaceContext = makeAgentWorkspaceContext(this.sessionWorkspace);
    let handle: IAgentScopeHandle | undefined;
    try {
      handle = createScopedChildHandle(
        this.instantiation,
        LifecycleScope.Agent,
        agentId,
        {
          seeds: [
            [IAgentScopeContext, makeAgentScopeContext({ agentId, agentScope })],
            [ITelemetryService, this.telemetry.withContext({ agent_id: agentId })],
            [ISessionWorkspaceContext, workspaceContext],
          ],
        },
      ) as IAgentScopeHandle;
      this.handles.set(agentId, handle);
      this.workspaceContexts.set(agentId, workspaceContext);
      const lease = this.isolationEnabled() ? await this.acquireIsolation(agentId, opts) : undefined;
      if (lease !== undefined) workspaceContext.update(isolationInfo(lease));
      const wire = handle.accessor.get(IWireService);
      await wire.seal();
      const labels = await this.depthCheckedLabels(agentId, opts);
      await this.sessionMetadata.registerAgent(agentId, {
        homedir: agentHomedir,
        type: agentId === 'main' ? 'main' : 'sub',
        parentAgentId: agentId === 'main' ? undefined : 'main',
        forkedFrom: opts.forkedFrom,
        labels,
      });
      this.onDidCreateEmitter.fire(handle);
      await wire.restore();
      await this.bindBootstrap(handle, opts);
      await handle.accessor.get(IAgentToolActivationService).activate();
      return handle;
    } catch (error) {
      if (handle !== undefined) {
        if (this.handles.get(agentId) === handle) this.handles.delete(agentId);
        try {
          handle.dispose();
        } catch { }
        this.onDidDisposeEmitter.fire(agentId);
      }
      await this.releaseIsolation(agentId);
      this.workspaceContexts.delete(agentId);
      this.isolationLeases.delete(agentId);
      throw error;
    }
  }

  getIsolationLease(agentId: string): WorkspaceIsolationLease | undefined {
    return this.isolationLeases.get(agentId);
  }

  async ensureIsolation(agentId: string): Promise<WorkspaceIsolationLease | undefined> {
    return this.enqueueIsolationOperation(agentId, async () => {
      if (!this.isolationEnabled()) return undefined;
      if (this.handles.get(agentId) === undefined) return undefined;
      const current = this.isolationLeases.get(agentId);
      if (current !== undefined && current.state === 'active') {
        this.workspaceContexts.get(agentId)?.update(isolationInfo(current));
        return current;
      }
      const mode = current?.mode ?? this.resolveIsolationMode(agentId, {});
      if (mode === undefined || this.isolation === undefined) return undefined;
      if (current !== undefined && current.state !== 'released') {
        await this.releaseIsolationLocked(agentId, current);
      }
      const next = await this.isolation.acquire({ mode, owner: agentId });
      this.setIsolationLease(agentId, next);
      return next;
    });
  }

  async releaseIsolation(agentId: string): Promise<WorkspaceIsolationLease | undefined> {
    return this.enqueueIsolationOperation(agentId, () => this.releaseIsolationLocked(agentId));
  }

  private async acquireIsolation(
    agentId: string,
    opts: CreateAgentOptions,
  ): Promise<WorkspaceIsolationLease | undefined> {
    return this.enqueueIsolationOperation(agentId, async () => {
      if (!this.isolationEnabled() || this.isolation === undefined) return undefined;
      const current = this.isolationLeases.get(agentId);
      if (
        current !== undefined &&
        current.state === 'active' &&
        this.handles.get(agentId) !== undefined
      ) {
        return current;
      }
      if (current !== undefined && current.state !== 'released') {
        await this.releaseIsolationLocked(agentId, current);
      }
      const mode = this.resolveIsolationMode(agentId, opts);
      if (mode === undefined) return undefined;
      const lease = await this.isolation.acquire({ mode, owner: agentId });
      this.setIsolationLease(agentId, lease);
      return lease;
    });
  }

  private async releaseIsolationLocked(
    agentId: string,
    suppliedLease?: WorkspaceIsolationLease,
  ): Promise<WorkspaceIsolationLease | undefined> {
    const lease = suppliedLease ?? this.isolationLeases.get(agentId);
    if (lease === undefined || this.isolation === undefined) return lease;
    if (lease.state === 'released') return lease;

    // The context is kept on the Agent until cleanup has completed, but it is
    // marked non-active immediately. A stale tool execution therefore cannot
    // continue using a worktree while its lease is being removed.
    if (lease.state === 'active') {
      this.workspaceContexts.get(agentId)?.update(isolationInfo({ ...lease, state: 'releasing' }));
    }
    const released = await this.isolation.release(lease.id);
    this.isolationLeases.set(agentId, released);
    if (released.state === 'released') this.workspaceContexts.get(agentId)?.update();
    else this.workspaceContexts.get(agentId)?.update(isolationInfo(released));
    return released;
  }

  private setIsolationLease(agentId: string, lease: WorkspaceIsolationLease): void {
    this.isolationLeases.set(agentId, lease);
    this.workspaceContexts.get(agentId)?.update(isolationInfo(lease));
  }

  private enqueueIsolationOperation<T>(
    agentId: string,
    operation: () => Promise<T>,
  ): Promise<T> {
    const previous = this.isolationOperations.get(agentId) ?? Promise.resolve();
    const current = previous.then(operation, operation);
    const settled = current.then(
      () => undefined,
      () => undefined,
    );
    this.isolationOperations.set(agentId, settled);
    void settled.then(() => {
      if (this.isolationOperations.get(agentId) === settled) {
        this.isolationOperations.delete(agentId);
      }
    });
    return current;
  }

  private async depthCheckedLabels(
    agentId: string,
    opts: CreateAgentOptions,
  ): Promise<Readonly<Record<string, string>> | undefined> {
    const parentAgentId = opts.labels?.['parentAgentId'];
    if (parentAgentId === undefined) return opts.labels;
    const parentMeta = (await this.sessionMetadata.read()).agents?.[parentAgentId];
    const depth = (subagentDepth(parentMeta) ?? 0) + 1;
    if (depth > SUBAGENT_DEPTH_CAP) {
      throw new Error2(
        ErrorCodes.AGENT_DEPTH_LIMIT_EXCEEDED,
        `Subagent nesting limit reached (depth ${String(depth)} of ${String(SUBAGENT_DEPTH_CAP)})`,
        { details: { agentId, parentAgentId, depth, limit: SUBAGENT_DEPTH_CAP } },
      );
    }
    return { ...opts.labels, [SUBAGENT_DEPTH_LABEL]: String(depth) };
  }

  private async bindBootstrap(
    handle: IAgentScopeHandle,
    opts: CreateAgentOptions,
  ): Promise<void> {
    if (opts.binding !== undefined) {
      await handle.accessor.get(IAgentProfileService).bind(opts.binding);
    } else {
      // Session resume: the wire replay restores the persisted profile binding
      // but `bind` never runs, so re-point the memory file scope at the bound
      // profile — otherwise a project-scoped agent would silently fall back
      // to the user-scoped memory file. No-op while no profile is bound.
      await handle.accessor.get(IAgentProfileService).syncMemoryScope();
    }
    const wire = handle.accessor.get(IWireService);
    const permissionMode = this.config.get<PermissionMode>(DEFAULT_PERMISSION_MODE_SECTION);
    const hasRestoredPermissionMode = wire.getModel(PermissionModeConfiguredModel);
    if (permissionMode !== undefined && !hasRestoredPermissionMode) {
      handle.accessor.get(IAgentPermissionModeService).setMode(permissionMode);
    }
  }

  async fork(sourceAgentId: string, opts?: ForkAgentOptions): Promise<IAgentScopeHandle> {
    const source = this.handles.get(sourceAgentId);
    if (source === undefined) {
      throw new Error2(ErrorCodes.AGENT_NOT_FOUND, `Source agent "${sourceAgentId}" does not exist`, {
        details: { agentId: sourceAgentId },
      });
    }
    if (opts?.agentId !== undefined && this.handles.has(opts.agentId)) {
      throw new Error2(ErrorCodes.AGENT_ALREADY_EXISTS, `Agent "${opts.agentId}" already exists`, {
        details: { agentId: opts.agentId },
      });
    }
    const child = await this.create({ agentId: opts?.agentId, forkedFrom: source.id });

    const sourceData = source.accessor.get(IAgentProfileService).data();
    const childProfile = child.accessor.get(IAgentProfileService);
    const override = opts?.binding;
    if (override?.profile !== undefined) {
      await childProfile.bind({
        profile: override.profile,
        model: override.model ?? sourceData.modelAlias,
        thinking: override?.thinking ?? sourceData.thinkingLevel,
      });
    } else {
      childProfile.applyBindingSnapshot(sourceData);
      if (override?.model !== undefined) await childProfile.setModel(override.model);
      if (override?.thinking !== undefined) childProfile.setThinking(override.thinking);
      // The snapshot path rebuilds the binding without `bind`, so re-point the
      // memory file scope at the resolved profile (the override branch above
      // already scoped it inside `bind`).
      await childProfile.syncMemoryScope();
    }

    const sourceMessages = source.accessor.get(IAgentContextMemoryService)?.get();
    if (sourceMessages !== undefined && sourceMessages.length > 0) {
      child.accessor.get(IAgentContextMemoryService)?.append(...sourceMessages);
    }
    return child;
  }

  get(agentId: string): IAgentScopeHandle | undefined {
    return this.handles.get(agentId);
  }

  list(filter?: AgentListFilter): readonly IAgentScopeHandle[] {
    const all = [...this.handles.values()];
    const prefix = filter?.prefix;
    if (prefix === undefined) return all;
    return all.filter((handle) => handle.id.startsWith(prefix));
  }

  broadcastPermissionMode(mode: PermissionMode): void {
    for (const handle of this.handles.values()) {
      handle.accessor.get(IAgentPermissionModeService).setMode(mode);
    }
  }

  async remove(agentId: string): Promise<void> {
    const handle = this.handles.get(agentId);
    if (handle === undefined) return;
    this.handles.delete(agentId);
    try {
      await handle.accessor.get(IAgentTaskService).stopAllOnExit('Session closed');
      const loop = handle.accessor.get(IAgentLoopService);
      const compaction = handle.accessor.get(IAgentFullCompactionService).compacting;
      const compactionSettled = compaction?.promise.catch(() => undefined) ?? Promise.resolve();
      const reason = abortError('Agent removed');
      for (const turnId of loop.status().pendingTurnIds) {
        loop.cancel(turnId, reason);
      }
      loop.cancel(undefined, reason);
      if (compaction !== null && !compaction.abortController.signal.aborted) {
        compaction.abortController.abort(reason);
      }
      await Promise.all([loop.settled(), compactionSettled]);
    } finally {
      try {
        handle.dispose();
      } finally {
        this.onDidDisposeEmitter.fire(agentId);
        await this.releaseIsolation(agentId);
        this.workspaceContexts.delete(agentId);
        this.isolationLeases.delete(agentId);
      }
    }
  }

  override dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    const agents = [...this.handles.entries()];
    const known = new Set(agents.map(([agentId]) => agentId));
    const orphanLeases = [...this.isolationLeases.keys()].filter((agentId) => !known.has(agentId));
    this.handles.clear();
    for (const [agentId, handle] of agents) {
      try {
        handle.dispose();
      } catch { }
      this.onDidDisposeEmitter.fire(agentId);
      void this.releaseIsolation(agentId)
        .catch(() => undefined)
        .then(() => {
          this.workspaceContexts.delete(agentId);
          this.isolationLeases.delete(agentId);
        });
    }
    for (const agentId of orphanLeases) {
      void this.releaseIsolation(agentId)
        .catch(() => undefined)
        .then(() => this.isolationLeases.delete(agentId));
    }
    super.dispose();
  }

  private isolationEnabled(): boolean {
    return !this.disposed && this.isolation !== undefined && this.flags?.enabled(workspaceIsolationFlag.id) === true;
  }

  private resolveIsolationMode(
    agentId: string,
    opts: CreateAgentOptions,
  ): WorkspaceIsolationMode | undefined {
    if (!this.isolationEnabled()) return undefined;
    if (opts.isolation !== undefined) return opts.isolation;
    if (agentId === 'main') return 'shared-worktree';
    const profileName = opts.binding?.profile;
    const profile = profileName === undefined ? undefined : this.profileCatalog.get(profileName);
    if (profile !== undefined && isReadOnlyProfile(profile.tools)) return 'shared-readonly';
    return 'dedicated-worktree';
  }
}

const READ_ONLY_PROFILE_TOOLS = new Set([
  'Read',
  'Grep',
  'Glob',
  'ReadMediaFile',
]);

function isReadOnlyProfile(tools: readonly string[] | undefined): boolean {
  if (tools === undefined || tools.length === 0) return false;
  return tools.every((name) => READ_ONLY_PROFILE_TOOLS.has(name));
}

function isolationInfo(lease: WorkspaceIsolationLease): AgentWorkspaceIsolationInfo {
  return {
    leaseId: lease.id,
    mode: lease.mode,
    state: lease.state,
    path: lease.path,
    workspaceRoot: lease.workspaceRoot,
    writable: lease.writable,
  };
}

registerScopedService(
  LifecycleScope.Session,
  IAgentLifecycleService,
  AgentLifecycleService,
  ScopeActivation.OnScopeCreated,
  'agentLifecycle',
);
