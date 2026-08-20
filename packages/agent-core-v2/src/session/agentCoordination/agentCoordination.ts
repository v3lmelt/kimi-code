/**
 * `agentCoordination` domain — Session-scoped task-tree, context, and mailbox contract.
 *
 * Owns the stable task-path address for every agent in the current session,
 * the parent/child tree, run state, and the queued message channel. The
 * legacy `agentId` remains a valid address; task paths are the additional
 * canonical address used by the collaboration surface. Bound at Session
 * scope.
 */

import { createDecorator, type ServiceIdentifier } from '#/_base/di/instantiation';
import type { Event } from '#/_base/event';
import type { IAgentScopeHandle } from '#/_base/di/scope';
import type { ContextMessage } from '#/agent/contextMemory/types';
import type { BindAgentInput } from '#/agent/profile/profile';
import type { TokenUsage } from '#/kosong/contract/usage';

export type AgentCoordinationStatus =
  | 'running'
  | 'idle'
  | 'completed'
  | 'failed'
  | 'interrupted';

export type ContextPolicy =
  | { readonly kind: 'fresh' }
  | { readonly kind: 'full' }
  | { readonly kind: 'lastN'; readonly count: number }
  | { readonly kind: 'lastN'; readonly n: number }
  | { readonly kind: 'digest'; readonly maxChars?: number };

export type AgentAddress = string;

export interface AgentCoordinationTaskInfo {
  readonly taskPath: string;
  readonly agentId: string;
  readonly taskName: string;
  readonly parentTaskPath?: string;
  readonly rootTaskPath: string;
  readonly children: readonly string[];
  readonly status: AgentCoordinationStatus;
  readonly mailboxCount: number;
  readonly contextPolicy: ContextPolicy;
  readonly createdAt: number;
  readonly updatedAt: number;
}

export interface AgentCoordinationSpawnOptions {
  readonly callerAgentId: string;
  readonly taskName?: string;
  readonly agentId?: string;
  readonly binding?: BindAgentInput;
  readonly contextPolicy?: ContextPolicy;
}

export interface AgentCoordinationSpawnResult {
  readonly handle: IAgentScopeHandle;
  readonly task: AgentCoordinationTaskInfo;
}

export interface AgentCoordinationFollowupResult {
  readonly task: AgentCoordinationTaskInfo;
  readonly summary: string;
  readonly usage?: TokenUsage;
}

export interface AgentCoordinationWaitOptions {
  readonly timeoutMs?: number;
}

export interface IAgentCoordinationService {
  readonly _serviceBrand: undefined;

  readonly onDidChange: Event<AgentCoordinationTaskInfo>;

  isEnabled(): boolean;

  register(
    handle: IAgentScopeHandle,
    options?: {
      readonly taskName?: string;
      readonly parentAgentId?: string;
      readonly taskPath?: string;
      readonly contextPolicy?: ContextPolicy;
    },
  ): AgentCoordinationTaskInfo;

  spawn(options: AgentCoordinationSpawnOptions): Promise<AgentCoordinationSpawnResult>;

  resolve(address: AgentAddress, callerAgentId?: string): AgentCoordinationTaskInfo | undefined;

  list(callerAgentId?: string): readonly AgentCoordinationTaskInfo[];

  sendMessage(
    callerAgentId: string,
    target: AgentAddress,
    message: string,
  ): Promise<AgentCoordinationTaskInfo>;

  followupTask(
    callerAgentId: string,
    target: AgentAddress,
    prompt: string,
    signal: AbortSignal,
    contextPolicy?: ContextPolicy,
  ): Promise<AgentCoordinationFollowupResult>;

  interrupt(callerAgentId: string, target: AgentAddress): Promise<AgentCoordinationTaskInfo>;

  wait(
    callerAgentId: string,
    target: AgentAddress,
    options?: AgentCoordinationWaitOptions,
  ): Promise<AgentCoordinationTaskInfo>;

  markRunStarted(agentId: string): AgentCoordinationTaskInfo | undefined;

  markRunFinished(
    agentId: string,
    status: Extract<AgentCoordinationStatus, 'completed' | 'failed' | 'interrupted'>,
  ): AgentCoordinationTaskInfo | undefined;

  contextSnapshot(sourceAgentId: string, policy: ContextPolicy): readonly ContextMessage[];
}

export const IAgentCoordinationService: ServiceIdentifier<IAgentCoordinationService> =
  createDecorator<IAgentCoordinationService>('agentCoordinationService');
