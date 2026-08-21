import type {
  ApprovalRequest,
  ApprovalResponse,
  QuestionRequest,
  QuestionResult,
} from '@moonshot-ai/agent-core';
import type { WorkflowProgressEvent } from '@moonshot-ai/agent-core-v2';

// Event union plus shared fields/payloads used across event families.
export type { KimiErrorPayload, Event } from '@moonshot-ai/agent-core';

/**
 * v2 workflow progress is an additive event on the SDK wire. It remains
 * separate from the closed legacy `Event` union so existing consumers keep
 * their exhaustive switch compatibility while v2 clients can feature-detect
 * the richer projection. The index signature intentionally preserves future
 * optional identity fields such as DAG node and isolation metadata.
 */
export interface WorkflowProgressEventEnvelope {
  readonly type: 'workflow.progress';
  readonly runId: string;
  readonly event: WorkflowProgressEvent;
  readonly sessionId?: string;
  readonly agentId?: string;
  readonly [key: string]: unknown;
}

export type SDKEvent = Event | WorkflowProgressEventEnvelope;

export function isWorkflowProgressEventEnvelope(
  value: unknown,
): value is WorkflowProgressEventEnvelope {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as {
    readonly type?: unknown;
    readonly runId?: unknown;
    readonly event?: unknown;
  };
  if (
    candidate.type !== 'workflow.progress' ||
    typeof candidate.runId !== 'string' ||
    typeof candidate.event !== 'object' ||
    candidate.event === null
  ) {
    return false;
  }
  const progress = candidate.event as { readonly type?: unknown; readonly runId?: unknown };
  return (
    typeof progress.type === 'string' &&
    progress.type.startsWith('workflow.') &&
    progress.runId === candidate.runId
  );
}

export { MCP_OAUTH_AUTHORIZATION_URL_TOOL_UPDATE } from '@moonshot-ai/agent-core';

// Session lifecycle/status events and their status payload.
export type {
  AgentStatusUpdatedEvent,
  SessionMetaUpdatedEvent,
  GoalUpdatedEvent,
  SkillActivatedEvent,
  PluginCommandActivatedEvent,
  ErrorEvent,
  WarningEvent,
  UsageStatus,
} from '@moonshot-ai/agent-core';

// Turn and step lifecycle events plus the turn-ending reason enum.
export type {
  TurnStartedEvent,
  TurnEndedEvent,
  TurnStepStartedEvent,
  TurnStepCompletedEvent,
  TurnStepUsageEvent,
  HostedSearchAction,
  HostedSearchCitation,
  HostedSearchEvent,
  HostedSearchLifecycle,
  HostedSearchPhase,
  HostedSearchSource,
  TurnStepRetryingEvent,
  TurnStepInterruptedEvent,
  TurnEndReason,
} from '@moonshot-ai/agent-core';

// Streaming content and hook-result events.
export type {
  AssistantDeltaEvent,
  HookResultEvent,
  ThinkingDeltaEvent,
} from '@moonshot-ai/agent-core';

// Tool-call events and incremental progress payloads.
export type {
  ToolCallStartedEvent,
  ToolCallDeltaEvent,
  ToolProgressEvent,
  ToolResultEvent,
  ToolCallRequest,
  ToolCallResponse,
  ToolUpdate,
  McpOAuthAuthorizationUrlUpdateData,
} from '@moonshot-ai/agent-core';

// MCP tool-list and server status events.
export type {
  ToolListUpdatedEvent,
  ToolListUpdatedReason,
  McpServerStatusEvent,
  McpServerStatusPayload,
} from '@moonshot-ai/agent-core';

// Approval reverse-RPC request and response/display payloads.
export type {
  ApprovalRequest,
  ApprovalDecision,
  ApprovalScope,
  ApprovalResponse,
  ToolInputDisplay,
} from '@moonshot-ai/agent-core';

// Question reverse-RPC request and answer payloads.
export type {
  QuestionRequest,
  QuestionItem,
  QuestionOption,
  QuestionAnswerMethod,
  QuestionAnswers,
  QuestionResponse,
  QuestionResult,
} from '@moonshot-ai/agent-core';

// Subagent lifecycle events.
export type {
  SubagentSpawnedEvent,
  SubagentStartedEvent,
  SubagentSuspendedEvent,
  SubagentCompletedEvent,
  SubagentFailedEvent,
} from '@moonshot-ai/agent-core';

// Compaction lifecycle events and compaction result payload.
export type {
  CompactionStartedEvent,
  CompactionBlockedEvent,
  CompactionCancelledEvent,
  CompactionCompletedEvent,
  CompactionResult,
} from '@moonshot-ai/agent-core';

// Background task lifecycle events emitted by the BPM. Covers both
// bash (`bash-*`) and agent (`agent-*`) tasks under one wire format.
export type {
  BackgroundTaskStartedEvent,
  BackgroundTaskTerminatedEvent,
} from '@moonshot-ai/agent-core';

export type { CronFiredEvent } from '@moonshot-ai/agent-core';

export type MaybePromise<T> = T | Promise<T>;

export type ApprovalHandler = (request: ApprovalRequest) => MaybePromise<ApprovalResponse>;

export type QuestionHandler = (request: QuestionRequest) => MaybePromise<QuestionResult>;
