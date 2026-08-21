/**
 * `agentCoordination` domain — Session-scoped task-tree and collaboration implementation.
 *
 * Tracks canonical task paths and parentage beside the existing agent
 * lifecycle, validates every address against this session's tree, queues
 * mailbox messages through the target loop, and starts follow-up turns only
 * for idle or completed targets. Context snapshots contain plain user and
 * assistant text with internal origins and tool payloads removed. The service
 * borrows Agent-scope handles only during operations, and intersects a child
 * profile's active tools and denylist with its parent's policy. Workspace
 * isolation leases are exposed on task metadata and released at run
 * boundaries. Logs failed cleanup after a partially completed spawn through
 * `log`. Bound at Session scope.
 */

import { Disposable } from '#/_base/di/lifecycle';
import { Emitter } from '#/_base/event';
import { ILogService } from '#/_base/log/log';
import { LifecycleScope } from '#/app/scopes';
import { ScopeActivation, registerScopedService, type IAgentScopeHandle } from '#/_base/di/scope';
import { Error2, ErrorCodes } from '#/errors';
import { IFlagService } from '#/app/flag/flag';
import { IAgentContextMemoryService } from '#/agent/contextMemory/contextMemory';
import { isRealUserInput } from '#/agent/contextMemory/compactionHandoff';
import type { ContextMessage, PromptOrigin } from '#/agent/contextMemory/types';
import { newMessageId } from '#/agent/contextMemory/messageId';
import { IAgentLoopService } from '#/agent/loop/loop';
import { IAgentPermissionModeService } from '#/agent/permissionMode/permissionMode';
import { MessageStepRequest } from '#/agent/loop/stepRequest';
import { IAgentProfileService } from '#/agent/profile/profile';
import { IAgentLifecycleService } from '#/session/agentLifecycle/agentLifecycle';
import { ISessionMetadata } from '#/session/sessionMetadata/sessionMetadata';
import { ISessionSubagentService } from '#/session/subagent/subagent';
import { abortError } from '#/_base/utils/abort';
import type { WorkspaceIsolationLease } from '#/workspace/workspaceIsolation/workspaceIsolation';

import {
  type AgentAddress,
  type AgentCoordinationFollowupResult,
  type AgentCoordinationSpawnOptions,
  type AgentCoordinationSpawnResult,
  type AgentCoordinationStatus,
  type AgentCoordinationTaskInfo,
  type ContextPolicy,
  IAgentCoordinationService,
} from './agentCoordination';
import { AGENT_COORDINATION_FLAG_ID } from './flag';

const INHERITED_CONTEXT_ORIGIN: PromptOrigin = {
  kind: 'system_trigger',
  name: 'agent_context_inherited',
};
const DEFAULT_CONTEXT_POLICY: ContextPolicy = { kind: 'fresh' };
const DEFAULT_DIGEST_CHARS = 4_000;
const MAX_INHERITED_CONTEXT_CHARS = 128_000;

interface MutableTask {
  readonly handle: IAgentScopeHandle;
  readonly claimedPaths: Set<string>;
  readonly agentId: string;
  taskPath: string;
  taskName: string;
  parentAgentId: string | undefined;
  parentTaskPath: string | undefined;
  rootTaskPath: string;
  status: AgentCoordinationStatus;
  mailboxCount: number;
  contextPolicy: ContextPolicy;
  workspaceIsolation: WorkspaceIsolationLease | undefined;
  pathPinned: boolean;
  readonly createdAt: number;
  updatedAt: number;
}

export class AgentCoordinationService
  extends Disposable
  implements IAgentCoordinationService
{
  declare readonly _serviceBrand: undefined;

  private readonly tasksByAgentId = new Map<string, MutableTask>();
  private readonly taskPathToAgentId = new Map<string, string>();
  private readonly claimedTaskPaths = new Set<string>();
  private readonly retiredHandles = new WeakSet<IAgentScopeHandle>();
  private readonly onDidChangeEmitter = this._register(new Emitter<AgentCoordinationTaskInfo>());

  get onDidChange() {
    return this.onDidChangeEmitter.event;
  }

  constructor(
    @IAgentLifecycleService private readonly lifecycle: IAgentLifecycleService,
    @ISessionSubagentService private readonly subagents: ISessionSubagentService,
    @ISessionMetadata private readonly metadata: ISessionMetadata,
    @IFlagService private readonly flags: IFlagService,
    @ILogService private readonly log?: ILogService,
  ) {
    super();
    this._register(
      lifecycle.onDidCreate((handle) => {
        this.observeHandle(handle);
      }),
    );
    this._register(
      lifecycle.onDidDispose((agentId) => {
        const task = this.tasksByAgentId.get(agentId);
        if (task === undefined) return;
        this.setStatus(task, 'interrupted');
      }),
    );
    for (const handle of lifecycle.list()) this.observeHandle(handle);
  }

  isEnabled(): boolean {
    return this.flags.enabled(AGENT_COORDINATION_FLAG_ID);
  }

  register(
    handle: IAgentScopeHandle,
    options: {
      readonly taskName?: string;
      readonly parentAgentId?: string;
      readonly taskPath?: string;
      readonly contextPolicy?: ContextPolicy;
    } = {},
  ): AgentCoordinationTaskInfo {
    const existing = this.tasksByAgentId.get(handle.id);
    if (existing !== undefined) {
      const previousPath = existing.taskPath;
      const previousName = existing.taskName;
      const previousParent = existing.parentTaskPath;
      const previousRoot = existing.rootTaskPath;
      const previousPolicy = existing.contextPolicy;
      if (options.taskPath !== undefined && options.taskPath !== existing.taskPath) {
        this.remapTaskPath(existing, options.taskPath);
        existing.pathPinned = true;
      }
      if (options.taskPath !== undefined) existing.pathPinned = true;
      if (options.taskName !== undefined) {
        existing.taskName = normalizeTaskName(options.taskName);
      }
      if (options.contextPolicy !== undefined) {
        existing.contextPolicy = normalizePolicy(options.contextPolicy);
      }
      if (options.parentAgentId !== undefined) {
        existing.parentAgentId = options.parentAgentId;
        this.setParent(existing, options.parentAgentId);
      }
      if (options.taskPath === undefined && options.parentAgentId !== undefined && !existing.pathPinned) {
        const parent = this.findParent(options.parentAgentId, existing.agentId);
        if (parent !== undefined) {
          this.remapTaskPath(existing, `${parent.taskPath}/${existing.taskName}`);
        }
      }
      this.reconcileChildren(existing);
      const policyChanged =
        previousPolicy.kind !== existing.contextPolicy.kind ||
        (previousPolicy.kind === 'lastN' &&
          existing.contextPolicy.kind === 'lastN' &&
          lastNCount(previousPolicy) !== lastNCount(existing.contextPolicy)) ||
        (previousPolicy.kind === 'digest' &&
          existing.contextPolicy.kind === 'digest' &&
          previousPolicy.maxChars !== existing.contextPolicy.maxChars);
      if (
        previousPath !== existing.taskPath ||
        previousName !== existing.taskName ||
        previousParent !== existing.parentTaskPath ||
        previousRoot !== existing.rootTaskPath ||
        policyChanged
      ) {
        existing.updatedAt = Date.now();
        this.publish(existing);
      }
      existing.workspaceIsolation = this.lifecycle.getIsolationLease?.(handle.id);
      return this.toInfo(existing);
    }

    const parentAgentId = options.parentAgentId;
    const parent = parentAgentId === undefined ? undefined : this.findParent(parentAgentId, handle.id);
    const taskName = normalizeTaskName(options.taskName ?? handle.id);
    const proposedPath = options.taskPath ?? this.proposedPath(parent, taskName, handle.id);
    const taskPath = this.claimPath(proposedPath, handle.id);
    const now = Date.now();
    const task: MutableTask = {
      handle,
      claimedPaths: new Set([taskPath]),
      agentId: handle.id,
      taskPath,
      taskName,
      parentAgentId,
      parentTaskPath: parent?.taskPath,
      rootTaskPath: parent?.rootTaskPath ?? taskPath,
      status: 'idle',
      mailboxCount: 0,
      contextPolicy: normalizePolicy(options.contextPolicy ?? DEFAULT_CONTEXT_POLICY),
      workspaceIsolation: this.lifecycle.getIsolationLease?.(handle.id),
      pathPinned: options.taskPath !== undefined,
      createdAt: now,
      updatedAt: now,
    };
    this.tasksByAgentId.set(handle.id, task);
    this.taskPathToAgentId.set(taskPath, handle.id);
    if (parent === undefined && parentAgentId !== undefined) {
      this.reconcileChildren(task);
    }
    this.publish(task);
    return this.toInfo(task);
  }

  async spawn(options: AgentCoordinationSpawnOptions): Promise<AgentCoordinationSpawnResult> {
    this.requireEnabled();
    const parent = this.requireTask(options.callerAgentId);
    const policy = normalizePolicy(options.contextPolicy ?? DEFAULT_CONTEXT_POLICY);
    const taskName = normalizeTaskName(options.taskName ?? options.agentId ?? 'agent');
    const taskPath = this.allocateChildPath(parent, taskName);
    let handle: IAgentScopeHandle;
    try {
      handle = await this.lifecycle.create({
        agentId: options.agentId,
        binding: options.binding,
        isolation: options.isolation,
        labels: {
          parentAgentId: options.callerAgentId,
          taskPath,
          taskName,
        },
      });
    } catch (error) {
      this.releasePath(taskPath);
      throw error;
    }
    try {
      this.register(handle, {
        taskName,
        parentAgentId: options.callerAgentId,
        taskPath,
        contextPolicy: policy,
      });
      const task = this.tasksByAgentId.get(handle.id);
      if (task === undefined) {
        throw new Error2(ErrorCodes.AGENT_NOT_FOUND, `Agent "${handle.id}" does not exist`);
      }
      task.claimedPaths.add(taskPath);
      task.workspaceIsolation = this.lifecycle.getIsolationLease?.(handle.id);
      this.enforceCapabilitySubset(parent.handle, handle);
      this.applyContextPolicy(options.callerAgentId, handle, policy);
      await this.persistTaskMetadata(task);
      return { handle, task: this.toInfo(task) };
    } catch (error) {
      await this.rollbackSpawn(handle, taskPath, error);
      throw error;
    }
  }

  resolve(address: AgentAddress, callerAgentId?: string): AgentCoordinationTaskInfo | undefined {
    const task = this.resolveMutable(address);
    if (task === undefined) return undefined;
    if (callerAgentId !== undefined && !this.sameTree(callerAgentId, task)) return undefined;
    this.refreshStatus(task);
    return this.toInfo(task);
  }

  list(callerAgentId?: string): readonly AgentCoordinationTaskInfo[] {
    const caller = callerAgentId === undefined ? undefined : this.requireTask(callerAgentId);
    return [...this.tasksByAgentId.values()]
      .filter((task) => caller === undefined || task.rootTaskPath === caller.rootTaskPath)
      .map((task) => {
        this.refreshStatus(task);
        return this.toInfo(task);
      })
      .toSorted((a, b) => a.taskPath.localeCompare(b.taskPath));
  }

  async sendMessage(
    callerAgentId: string,
    target: AgentAddress,
    message: string,
  ): Promise<AgentCoordinationTaskInfo> {
    this.requireEnabled();
    if (message.length === 0) {
      throw new Error2(ErrorCodes.VALIDATION_FAILED, 'Agent message must not be empty');
    }
    const sender = this.requireTask(callerAgentId);
    const task = this.requireTarget(sender, target);
    const targetHandle = this.requireLiveHandle(task);
    const loop = targetHandle.accessor.get(IAgentLoopService);
    const queued = new MessageStepRequest(
      {
        id: newMessageId(),
        role: 'user',
        content: [{ type: 'text', text: `[Message from ${sender.taskPath}] ${message}` }],
        toolCalls: [],
        origin: { kind: 'system_trigger', name: 'agent_message' },
      },
      { kind: 'send_message', mergeable: true, turnScoped: false },
    );
    loop.enqueue(queued);
    task.mailboxCount += 1;
    task.updatedAt = Date.now();
    this.publish(task);
    return this.toInfo(task);
  }

  async followupTask(
    callerAgentId: string,
    target: AgentAddress,
    prompt: string,
    signal: AbortSignal,
    contextPolicy?: ContextPolicy,
  ): Promise<AgentCoordinationFollowupResult> {
    this.requireEnabled();
    if (prompt.trim().length === 0) {
      throw new Error2(ErrorCodes.VALIDATION_FAILED, 'Follow-up prompt must not be empty');
    }
    const sender = this.requireTask(callerAgentId);
    const task = this.requireTarget(sender, target);
    this.refreshStatus(task);
    const targetHandle = this.requireLiveHandle(task);
    const loopState = targetHandle.accessor.get(IAgentLoopService).status().state;
    if (task.status !== 'idle' && task.status !== 'completed') {
      throw new Error2(
        ErrorCodes.AGENT_ALREADY_RUNNING,
        `Agent "${task.taskPath}" is not idle or completed and cannot receive a follow-up turn`,
        { details: { taskPath: task.taskPath, status: task.status } },
      );
    }
    if (loopState === 'running') {
      throw new Error2(
        ErrorCodes.AGENT_ALREADY_RUNNING,
        `Agent "${task.taskPath}" is already running and cannot receive a follow-up turn`,
        { details: { taskPath: task.taskPath, status: 'running' } },
      );
    }
    signal.throwIfAborted();
    task.workspaceIsolation = await this.lifecycle.ensureIsolation?.(task.agentId);
    task.updatedAt = Date.now();
    this.publish(task);
    const policy = normalizePolicy(contextPolicy ?? { kind: 'fresh' });
    task.contextPolicy = policy;
    this.applyContextPolicy(sender.agentId, targetHandle, policy);
    this.markRunStarted(task.agentId);
    try {
      const run = await this.subagents.run(
        task.agentId,
        { kind: 'prompt', prompt },
        { signal },
      );
      const completion = await run.completion;
      this.markRunFinished(task.agentId, 'completed');
      await this.releaseTaskIsolation(task);
      return {
        task: this.toInfo(task),
        summary: completion.summary,
        usage: completion.usage,
      };
    } catch (error) {
      this.markRunFinished(task.agentId, signal.aborted ? 'interrupted' : 'failed');
      await this.releaseTaskIsolation(task);
      throw error;
    }
  }

  async interrupt(callerAgentId: string, target: AgentAddress): Promise<AgentCoordinationTaskInfo> {
    this.requireEnabled();
    const sender = this.requireTask(callerAgentId);
    const task = this.requireTarget(sender, target);
    if (task.status === 'interrupted' || task.status === 'completed' || task.status === 'failed') {
      return this.toInfo(task);
    }
    const handle = this.requireLiveHandle(task);
    const loop = handle.accessor.get(IAgentLoopService);
    if (task.status !== 'running' && loop.status().state !== 'running') {
      return this.toInfo(task);
    }
    loop.cancel(undefined, abortError('Agent interrupted'));
    this.setStatus(task, 'interrupted');
    await this.releaseTaskIsolation(task);
    return this.toInfo(task);
  }

  async wait(
    callerAgentId: string,
    target: AgentAddress,
    options: { readonly timeoutMs?: number } = {},
  ): Promise<AgentCoordinationTaskInfo> {
    this.requireEnabled();
    const sender = this.requireTask(callerAgentId);
    const task = this.requireTarget(sender, target);
    const handle = this.requireLiveHandle(task);
    const loop = handle.accessor.get(IAgentLoopService);
    this.refreshStatus(task);
    if (task.status === 'running' || (loop.status().state === 'running' && task.status === 'idle')) {
      if (loop.status().state === 'running' && task.status === 'idle') {
        this.setStatus(task, 'running');
      }
      const wait = loop.settled();
      if (options.timeoutMs !== undefined && options.timeoutMs > 0) {
        await waitWithTimeout(wait, options.timeoutMs);
      } else {
        await wait;
      }
      this.refreshStatus(task);
    }
    return this.toInfo(task);
  }

  markRunStarted(agentId: string): AgentCoordinationTaskInfo | undefined {
    const task = this.tasksByAgentId.get(agentId);
    if (task === undefined) return undefined;
    if (task.status !== 'interrupted') this.setStatus(task, 'running');
    return this.toInfo(task);
  }

  markRunFinished(
    agentId: string,
    status: Extract<AgentCoordinationStatus, 'completed' | 'failed' | 'interrupted'>,
  ): AgentCoordinationTaskInfo | undefined {
    const task = this.tasksByAgentId.get(agentId);
    if (task === undefined) return undefined;
    if (task.status === 'interrupted' && status !== 'interrupted') {
      void this.releaseTaskIsolation(task);
      return this.toInfo(task);
    }
    this.setStatus(task, status);
    void this.releaseTaskIsolation(task);
    return this.toInfo(task);
  }

  contextSnapshot(sourceAgentId: string, policy: ContextPolicy): readonly ContextMessage[] {
    const source = this.requireTask(sourceAgentId);
    const sourceMemory = source.handle.accessor.get(IAgentContextMemoryService);
    return snapshotContext(sourceMemory.get(), normalizePolicy(policy));
  }

  private observeHandle(handle: IAgentScopeHandle): void {
    if (this.retiredHandles.has(handle)) return;
    if (!this.tasksByAgentId.has(handle.id)) this.register(handle);
    void this.metadata.read().then(async (meta) => {
      if (this.retiredHandles.has(handle)) return;
      if (this.lifecycle.get(handle.id) !== handle) return;
      const agent = meta.agents?.[handle.id];
      if (agent !== undefined) {
        const labels = agent.labels;
        this.register(handle, {
          parentAgentId: agent.parentAgentId ?? labels?.['parentAgentId'] ?? undefined,
          taskName: labels?.['taskName'],
          taskPath: labels?.['taskPath'],
        });
      }
      const task = this.tasksByAgentId.get(handle.id);
      if (
        task !== undefined &&
        !this.retiredHandles.has(handle) &&
        this.lifecycle.get(handle.id) === handle
      ) {
        await this.persistTaskMetadata(task);
      }
    }).catch(() => {});
  }

  private requireEnabled(): void {
    if (!this.isEnabled()) {
      throw new Error2(ErrorCodes.NOT_IMPLEMENTED, 'Agent coordination is disabled');
    }
  }

  private requireTask(agentId: string): MutableTask {
    const existing = this.tasksByAgentId.get(agentId);
    if (existing !== undefined) return existing;
    const handle = this.lifecycle.get(agentId);
    if (handle !== undefined && !this.retiredHandles.has(handle)) {
      this.register(handle);
      const registered = this.tasksByAgentId.get(agentId);
      if (registered !== undefined) return registered;
    }
    throw new Error2(ErrorCodes.AGENT_NOT_FOUND, `Agent "${agentId}" does not exist`, {
      details: { agentId },
    });
  }

  private requireTarget(sender: MutableTask, address: AgentAddress): MutableTask {
    const task = this.resolveMutable(address);
    if (task === undefined) {
      throw new Error2(ErrorCodes.AGENT_NOT_FOUND, `Agent task "${address}" does not exist`, {
        details: { address },
      });
    }
    if (task.agentId === sender.agentId) {
      throw new Error2(ErrorCodes.VALIDATION_FAILED, 'An agent cannot target itself');
    }
    if (!this.sameTree(sender.agentId, task)) {
      throw new Error2(
        ErrorCodes.AGENT_NOT_OWNED,
        `Agent task "${task.taskPath}" is outside the caller's session tree`,
        { details: { taskPath: task.taskPath, callerAgentId: sender.agentId } },
      );
    }
    return task;
  }

  private requireLiveHandle(task: MutableTask): IAgentScopeHandle {
    const live = this.lifecycle.get(task.agentId);
    if (live === undefined) {
      throw new Error2(ErrorCodes.AGENT_NOT_FOUND, `Agent "${task.agentId}" is no longer live`, {
        details: { agentId: task.agentId, taskPath: task.taskPath },
      });
    }
    return live;
  }

  private resolveMutable(address: AgentAddress): MutableTask | undefined {
    const byId = this.tasksByAgentId.get(address);
    if (byId !== undefined) return byId;
    const normalized = normalizePath(address);
    const agentId = this.taskPathToAgentId.get(normalized);
    if (agentId !== undefined) return this.tasksByAgentId.get(agentId);
    const live = this.lifecycle.get(address);
    if (live === undefined || this.retiredHandles.has(live)) return undefined;
    this.register(live);
    return this.tasksByAgentId.get(live.id);
  }

  private findParent(parentAgentId: string, childAgentId: string): MutableTask | undefined {
    if (parentAgentId === childAgentId) return undefined;
    const existing = this.tasksByAgentId.get(parentAgentId);
    if (existing !== undefined) return existing;
    const handle = this.lifecycle.get(parentAgentId);
    if (handle === undefined || this.retiredHandles.has(handle)) return undefined;
    this.register(handle);
    return this.tasksByAgentId.get(parentAgentId);
  }

  private reconcileChildren(parent: MutableTask): void {
    for (const child of this.tasksByAgentId.values()) {
      if (child.parentAgentId !== parent.agentId || child === parent) continue;
      const previousPath = child.taskPath;
      const previousParent = child.parentTaskPath;
      const previousRoot = child.rootTaskPath;
      this.setParent(child, parent.agentId);
      if (!child.pathPinned) {
        this.remapTaskPath(child, `${parent.taskPath}/${child.taskName}`);
      }
      if (
        previousPath !== child.taskPath ||
        previousParent !== child.parentTaskPath ||
        previousRoot !== child.rootTaskPath
      ) {
        child.updatedAt = Date.now();
        this.publish(child);
        void this.persistTaskMetadata(child).catch(() => {});
      }
    }
  }

  private sameTree(callerAgentId: string, target: MutableTask): boolean {
    const caller = this.tasksByAgentId.get(callerAgentId);
    return caller !== undefined && caller.rootTaskPath === target.rootTaskPath;
  }

  private refreshStatus(task: MutableTask): void {
    try {
      const state = task.handle.accessor.get(IAgentLoopService).status().state;
      if (state === 'running' && task.status === 'idle') {
        this.setStatus(task, 'running');
      } else if (state !== 'running' && task.status === 'running') {
        this.setStatus(task, 'completed');
      }
    } catch {
      this.setStatus(task, 'interrupted');
    }
  }

  private setParent(task: MutableTask, parentAgentId: string): void {
    if (parentAgentId === task.agentId) return;
    const parent = this.findParent(parentAgentId, task.agentId);
    if (parent === undefined) return;
    task.parentTaskPath = parent.taskPath;
    task.rootTaskPath = parent.rootTaskPath;
    if (!task.pathPinned) this.remapTaskPath(task, `${parent.taskPath}/${task.taskName}`);
  }

  private proposedPath(parent: MutableTask | undefined, taskName: string, agentId: string): string {
    return parent === undefined ? normalizePath(taskName || agentId) : `${parent.taskPath}/${taskName}`;
  }

  private allocateChildPath(parent: MutableTask, taskName: string): string {
    return this.claimPath(`${parent.taskPath}/${taskName}`);
  }

  private claimPath(proposed: string, agentId?: string): string {
    const normalized = normalizePath(proposed) || normalizeTaskName(agentId ?? 'agent');
    if (!this.claimedTaskPaths.has(normalized) && this.taskPathToAgentId.get(normalized) === undefined) {
      this.claimedTaskPaths.add(normalized);
      return normalized;
    }
    if (agentId !== undefined && this.taskPathToAgentId.get(normalized) === agentId) return normalized;
    let suffix = 2;
    while (this.claimedTaskPaths.has(`${normalized}~${String(suffix)}`)) suffix += 1;
    const unique = `${normalized}~${String(suffix)}`;
    this.claimedTaskPaths.add(unique);
    return unique;
  }

  private releasePath(path: string): void {
    if (this.taskPathToAgentId.has(path)) return;
    this.claimedTaskPaths.delete(path);
  }

  private remapTaskPath(task: MutableTask, requested: string): void {
    const old = task.taskPath;
    const normalized = normalizePath(requested) || normalizeTaskName(task.agentId);
    const next =
      this.claimedTaskPaths.has(normalized) && this.taskPathToAgentId.get(normalized) === undefined
        ? normalized
        : this.claimPath(requested, task.agentId);
    if (next === old) return;
    const affected = [...this.tasksByAgentId.values()]
      .filter(
        (candidate) =>
          candidate === task || candidate.taskPath.startsWith(`${old}/`),
      )
      .toSorted((a, b) => a.taskPath.length - b.taskPath.length);
    const pathMap = new Map<string, string>();
    for (const candidate of affected) {
      const suffix = candidate === task ? '' : candidate.taskPath.slice(old.length + 1);
      const proposedPath = suffix.length === 0 ? next : `${next}/${suffix}`;
      const candidatePath = candidate === task ? next : this.claimPath(proposedPath, candidate.agentId);
      pathMap.set(candidate.taskPath, candidatePath);
    }
    for (const candidate of affected) {
      const previousPath = candidate.taskPath;
      const candidatePath = pathMap.get(previousPath);
      if (candidatePath === undefined) continue;
      candidate.claimedPaths.add(candidatePath);
      this.taskPathToAgentId.delete(previousPath);
      this.taskPathToAgentId.set(candidatePath, candidate.agentId);
      candidate.taskPath = candidatePath;
      const parentPath = candidate.parentTaskPath;
      if (parentPath !== undefined) {
        candidate.parentTaskPath = pathMap.get(parentPath) ?? parentPath;
      }
      const rootPath = candidate.rootTaskPath;
      candidate.rootTaskPath = pathMap.get(rootPath) ?? rootPath;
      if (candidate === task && candidate.parentTaskPath !== undefined) {
        const parentId = this.taskPathToAgentId.get(candidate.parentTaskPath);
        candidate.rootTaskPath =
          this.tasksByAgentId.get(parentId ?? '')?.rootTaskPath ?? candidate.rootTaskPath;
      }
    }
  }

  private setStatus(task: MutableTask, status: AgentCoordinationStatus): void {
    if (task.status === status) return;
    task.status = status;
    task.updatedAt = Date.now();
    this.publish(task);
    if (status === 'completed' || status === 'failed' || status === 'interrupted') {
      void this.releaseTaskIsolation(task);
    }
  }

  private async releaseTaskIsolation(task: MutableTask): Promise<void> {
    try {
      const lease = await this.lifecycle.releaseIsolation?.(task.agentId);
      if (lease === undefined && task.workspaceIsolation === undefined) return;
      task.workspaceIsolation = lease;
      task.updatedAt = Date.now();
      this.publish(task);
      await this.persistTaskMetadata(task);
    } catch (error) {
      this.log?.warn('agent workspace isolation release failed', {
        agentId: task.agentId,
        taskPath: task.taskPath,
        leaseId: task.workspaceIsolation?.id,
        error,
      });
    }
  }

  private async persistTaskMetadata(task: MutableTask): Promise<void> {
    if (!this.isEnabled()) return;
    if (typeof this.metadata.registerAgent !== 'function') return;
    const metadata = await this.metadata.read();
    const existing = metadata.agents?.[task.agentId];
    const labels: Record<string, string> = {
      ...(existing?.labels ?? {}),
      taskPath: task.taskPath,
      taskName: task.taskName,
    };
    const lease = task.workspaceIsolation;
    if (lease !== undefined) {
      labels['isolationLeaseId'] = lease.id;
      labels['isolationMode'] = lease.mode;
      labels['isolationState'] = lease.state;
      labels['isolationPath'] = lease.path;
    }
    await this.metadata.registerAgent(task.agentId, {
      ...existing,
      type: existing?.type ?? (task.agentId === 'main' ? 'main' : 'sub'),
      parentAgentId: existing?.parentAgentId,
      labels,
    });
  }

  private async rollbackSpawn(
    handle: IAgentScopeHandle,
    taskPath: string,
    originalError: unknown,
  ): Promise<void> {
    this.retiredHandles.add(handle);
    this.removeTaskRecord(handle.id, taskPath);

    try {
      await this.lifecycle.remove(handle.id);
    } catch (cleanupError) {
      try {
        handle.dispose();
      } catch (disposeError) {
        this.reportCleanupFailure({
          agentId: handle.id,
          taskPath,
          error: originalError,
          cleanupError,
          disposeError,
        });
        return;
      }
      this.reportCleanupFailure({
        agentId: handle.id,
        taskPath,
        error: originalError,
        cleanupError,
      });
    }
  }

  private reportCleanupFailure(payload: Readonly<Record<string, unknown>>): void {
    try {
      this.log?.error('agent coordination spawn cleanup failed', payload);
    } catch {}
  }

  private removeTaskRecord(agentId: string, taskPath: string): void {
    const task = this.tasksByAgentId.get(agentId);
    if (task !== undefined) {
      this.tasksByAgentId.delete(agentId);
    }
    const paths = new Set<string>([
      taskPath,
      normalizePath(agentId),
      ...(task?.claimedPaths ?? []),
    ]);
    for (const [path, pathAgentId] of this.taskPathToAgentId) {
      if (pathAgentId !== agentId) continue;
      this.taskPathToAgentId.delete(path);
      paths.add(path);
    }
    for (const path of paths) {
      if (this.taskPathToAgentId.has(path)) continue;
      this.claimedTaskPaths.delete(path);
    }
  }

  private enforceCapabilitySubset(parent: IAgentScopeHandle, child: IAgentScopeHandle): void {
    try {
      const parentProfile = parent.accessor.get(IAgentProfileService).data();
      const childProfile = child.accessor.get(IAgentProfileService);
      const childData = childProfile.data();
      const parentTools = parentProfile.activeToolNames;
      const childTools = childData.activeToolNames;
      const parentDenied = new Set(parentProfile.disallowedTools ?? []);
      const childDenied = new Set(childData.disallowedTools ?? []);
      for (const name of parentDenied) childDenied.add(name);
      const activeToolNames =
        parentTools === undefined
          ? childTools
          : childTools === undefined
            ? parentTools
            : childTools.filter((name) => parentTools.includes(name));
      childProfile.update({
        activeToolNames,
        disallowedTools: [...childDenied],
      });
    } catch {
      return;
    }
    try {
      const parentPermission = parent.accessor.get(IAgentPermissionModeService);
      const childPermission = child.accessor.get(IAgentPermissionModeService);
      if (parentPermission !== undefined && childPermission !== undefined) {
        childPermission.setMode(parentPermission.mode);
      }
    } catch {
      return;
    }
  }

  private applyContextPolicy(
    sourceAgentId: string,
    target: IAgentScopeHandle,
    policy: ContextPolicy,
  ): void {
    const messages = this.contextSnapshot(sourceAgentId, policy);
    if (messages.length === 0) return;
    target.accessor.get(IAgentContextMemoryService).append(...messages);
  }

  private toInfo(task: MutableTask): AgentCoordinationTaskInfo {
    const children = [...this.tasksByAgentId.values()]
      .filter((candidate) => candidate.parentTaskPath === task.taskPath)
      .map((candidate) => candidate.taskPath)
      .toSorted();
    return {
      taskPath: task.taskPath,
      agentId: task.agentId,
      taskName: task.taskName,
      parentTaskPath: task.parentTaskPath,
      rootTaskPath: task.rootTaskPath,
      children,
      status: task.status,
      mailboxCount: task.mailboxCount,
      contextPolicy: task.contextPolicy,
      workspaceIsolation: task.workspaceIsolation,
      createdAt: task.createdAt,
      updatedAt: task.updatedAt,
    };
  }

  private publish(task: MutableTask): void {
    this.onDidChangeEmitter.fire(this.toInfo(task));
  }
}

function normalizePolicy(policy: ContextPolicy): ContextPolicy {
  switch (policy.kind) {
    case 'fresh':
    case 'full':
      return { kind: policy.kind };
    case 'lastN': {
      const count = 'count' in policy ? policy.count : policy.n;
      return {
        kind: 'lastN',
        count: Math.max(0, Math.floor(count)),
      };
    }
    case 'digest':
      return {
        kind: 'digest',
        maxChars:
          policy.maxChars === undefined
            ? undefined
            : Math.max(1, Math.floor(policy.maxChars)),
      };
    default: {
      const exhaustive: never = policy;
      return exhaustive;
    }
  }
}

function lastNCount(policy: Extract<ContextPolicy, { readonly kind: 'lastN' }>): number {
  return 'count' in policy ? policy.count : policy.n;
}

function normalizeTaskName(name: string): string {
  const trimmed = name.trim();
  const normalized = trimmed
    .replaceAll(/[^\p{L}\p{N}._~-]+/gu, '-')
    .replaceAll(/^-+|-+$/g, '')
    .slice(0, 80);
  return normalized.length === 0 || normalized === '.' || normalized === '..'
    ? 'agent'
    : normalized;
}

function normalizePath(path: string): string {
  return path
    .trim()
    .replaceAll('\\', '/')
    .split('/')
    .filter((part) => part.length > 0 && part !== '.' && part !== '..')
    .map(normalizeTaskName)
    .join('/');
}

function snapshotContext(
  history: readonly ContextMessage[],
  policy: ContextPolicy,
): readonly ContextMessage[] {
  if (policy.kind === 'fresh') return [];
  const sanitized = history
    .filter((message) => message.role === 'user' || message.role === 'assistant')
    .filter((message) => message.role !== 'user' || isRealUserInput(message))
    .filter(
      (message) =>
        message.origin === undefined ||
        message.origin.kind === 'user' ||
        ((message.origin.kind === 'skill_activation' || message.origin.kind === 'plugin_command') &&
          message.origin.trigger === 'user-slash'),
    )
    .map(sanitizeMessage)
    .filter((message): message is ContextMessage => message !== undefined);
  if (policy.kind === 'lastN') {
    const lastN = policy as { readonly count?: number; readonly n?: number };
    const rawCount = lastN.count ?? lastN.n ?? 0;
    return sanitized.slice(-rawCount);
  }
  if (policy.kind === 'digest') {
    const userText = sanitized
      .filter((message) => message.role === 'user')
      .map((message) => textOf(message.content).trim())
      .filter((text) => text.length > 0);
    if (userText.length === 0) return [];
    const maxChars = policy.maxChars ?? DEFAULT_DIGEST_CHARS;
    const prefix = '<parent-context>\n';
    const suffix = '\n</parent-context>';
    const contentBudget = Math.max(0, maxChars - prefix.length - suffix.length);
    const lines: string[] = [];
    let used = 0;
    for (let index = userText.length - 1; index >= 0; index--) {
      const line = `${String(index + 1)}) ${userText[index]}`;
      if (used + line.length > contentBudget) {
        if (lines.length === 0 && contentBudget > 0) lines.unshift(line.slice(-contentBudget));
        break;
      }
      lines.unshift(line);
      used += line.length;
    }
    return [inheritedMessage(`${prefix}${lines.join('\n')}${suffix}`.slice(0, maxChars))];
  }
  let total = 0;
  const bounded: ContextMessage[] = [];
  for (const message of sanitized) {
    const size = textOf(message.content).length;
    if (total + size > MAX_INHERITED_CONTEXT_CHARS) break;
    bounded.push(message);
    total += size;
  }
  return bounded;
}

function sanitizeMessage(message: ContextMessage): ContextMessage | undefined {
  const text = textOf(message.content).trim();
  if (text.length === 0) return undefined;
  return {
    id: newMessageId(),
    role: message.role,
    content: [{ type: 'text', text }],
    toolCalls: [],
    origin: INHERITED_CONTEXT_ORIGIN,
  };
}

function inheritedMessage(text: string): ContextMessage {
  return {
    id: newMessageId(),
    role: 'user',
    content: [{ type: 'text', text }],
    toolCalls: [],
    origin: INHERITED_CONTEXT_ORIGIN,
  };
}

function textOf(content: ContextMessage['content']): string {
  if (typeof content === 'string') return content;
  return content
    .filter((part): part is Extract<(typeof content)[number], { type: 'text' }> => part.type === 'text')
    .map((part) => part.text)
    .join('\n');
}

function waitWithTimeout(wait: Promise<void>, ms: number): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, ms);
  });
  return Promise.race([wait, deadline]).finally(() => {
    if (timer !== undefined) clearTimeout(timer);
  });
}

registerScopedService(
  LifecycleScope.Session,
  IAgentCoordinationService,
  AgentCoordinationService,
  ScopeActivation.OnDemand,
  'agentCoordination',
);
