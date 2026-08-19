/**
 * `toolApproval` domain — `IAgentToolApprovalService` contract.
 *
 * Shared approval round-trip for tool executions: builds the approval request,
 * drives the session approval broker, emits the `permission.approval.*`
 * events, records session-scope approval rules through `permissionRules`, and
 * resolves ask continuations. Bound at Agent scope.
 *
 * Approval is fail-closed: when no session approval broker is available the
 * ask resolves to the `unavailable` decision (a deny by default) instead of
 * silently approving, so an absent approval channel can never widen access.
 */

import { createDecorator } from '#/_base/di/instantiation';
import type {
  ApprovalResponse,
  PermissionPolicyResolution,
  PermissionPolicyResult,
} from '#/agent/permissionPolicy/types';
import type {
  BeforeExecuteDecision,
  ResolvedToolExecutionHookContext,
} from '#/agent/toolExecutor/toolHooks';

/**
 * The response a `requestToolApproval` ask can produce. `unavailable` means no
 * approval channel exists (no session approval broker) — a fail-closed outcome
 * that denies by default unless a policy explicitly resolves it to a pass.
 */
export type ToolApprovalResponse =
  | ApprovalResponse
  | { readonly decision: 'unavailable'; readonly feedback?: string };

export interface IAgentToolApprovalService {
  readonly _serviceBrand: undefined;

  resolvePermissionResolution(
    result: PermissionPolicyResolution,
    context: ResolvedToolExecutionHookContext,
    origin: string,
  ): Promise<BeforeExecuteDecision | undefined>;

  requestToolApproval(
    context: ResolvedToolExecutionHookContext,
    result: Extract<PermissionPolicyResult, { kind: 'ask' }>,
    origin: string,
  ): Promise<BeforeExecuteDecision | undefined>;

  formatDenyMessage(message: string): string;

  formatApprovalRejectionMessage(
    toolName: string,
    result: Pick<ToolApprovalResponse, 'decision' | 'feedback'>,
  ): string;
}

export const IAgentToolApprovalService = createDecorator<IAgentToolApprovalService>(
  'agentToolApprovalService',
);
