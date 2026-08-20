import {
  WORKFLOW_LEDGER_LIMITS,
  type WorkflowRunAgentView,
  type WorkflowRunView,
} from './workflow-model';

/** Minimal task contract shared by legacy SDK tasks and v2 workflow tasks. */
export interface RuntimeCenterTaskInfo {
  readonly taskId: string;
  readonly kind: string;
  readonly description: string;
  readonly status: string;
  /** `false` identifies a foreground task that is still owned by its tool call. */
  readonly detached?: boolean;
  readonly startedAt: number;
  readonly endedAt: number | null;
  readonly stopReason?: string;
}

/** The three projections exposed by the Runtime Center. */
export type RuntimeCenterView = 'tasks' | 'agents' | 'workflows';

export type RuntimeCenterAction =
  | 'stop'
  | 'output'
  | 'resume'
  | 'retry'
  | 'message'
  | 'followup'
  | 'interrupt'
  | 'transcript';

export interface RuntimeCenterActionState {
  readonly enabled: boolean;
  readonly reason?: string;
}

export interface RuntimeCenterIdentity {
  /** Background task identity. Different from a workflow run or agent id. */
  readonly taskId?: string;
  /** Workflow execution identity. A run may own one task record. */
  readonly runId?: string;
  /** Agent scope identity. An agent may own several task records. */
  readonly agentId?: string;
  /** Canonical task path when the engine exposes one. */
  readonly taskPath?: string;
  /** DAG node identity when a graph-backed workflow exposes one. */
  readonly nodeId?: string;
}

export interface RuntimeCenterTask extends RuntimeCenterIdentity {
  readonly key: string;
  readonly kind: string;
  readonly label: string;
  readonly description: string;
  readonly status: string;
  readonly model?: string;
  readonly usageTokens?: number;
  readonly durationMs?: number;
  readonly cache?: string;
  readonly replayed?: boolean;
  readonly isolationLease?: string;
  readonly worktreePath?: string;
  readonly actions: Readonly<Record<RuntimeCenterAction, RuntimeCenterActionState>>;
  readonly source: RuntimeCenterTaskInfo;
}

export interface RuntimeCenterAgent extends RuntimeCenterIdentity {
  readonly key: string;
  readonly treePath: string;
  readonly parentAgentId?: string;
  readonly label: string;
  readonly status: string;
  readonly currentActivity: string;
  readonly workspaceMode?: string;
  readonly actions: Readonly<Record<RuntimeCenterAction, RuntimeCenterActionState>>;
}

export interface RuntimeCenterWorkflow extends RuntimeCenterIdentity {
  readonly key: string;
  readonly name: string;
  readonly description: string;
  readonly status: string;
  readonly phase?: string;
  readonly phases: readonly string[];
  readonly nodes: readonly RuntimeCenterWorkflowNode[];
  readonly dependencies: readonly string[];
  readonly model?: string;
  readonly usageTokens?: number;
  readonly durationMs?: number;
  readonly cache?: string;
  readonly replayed?: boolean;
  readonly isolationLease?: string;
  readonly worktreePath?: string;
  readonly actions: Readonly<Record<RuntimeCenterAction, RuntimeCenterActionState>>;
  readonly source: WorkflowRunView;
}

export interface RuntimeCenterWorkflowNode extends RuntimeCenterIdentity {
  readonly nodeId: string;
  readonly label?: string;
  readonly status: string;
  readonly dependencies: readonly string[];
  readonly model?: string;
  readonly usageTokens?: number;
  readonly durationMs?: number;
  readonly cache?: string;
  readonly replayed?: boolean;
  readonly isolationLease?: string;
  readonly worktreePath?: string;
}

export interface RuntimeCenterProjection {
  readonly tasks: readonly RuntimeCenterTask[];
  readonly agents: readonly RuntimeCenterAgent[];
  readonly workflows: readonly RuntimeCenterWorkflow[];
}

export interface RuntimeCenterProjectionInput {
  readonly tasks: readonly RuntimeCenterTaskInfo[];
  readonly workflows: readonly WorkflowRunView[];
  /** Session metadata is intentionally structural: old SDKs do not expose it. */
  readonly agentMetadata?: Readonly<Record<string, unknown>>;
}

const UNSUPPORTED_TARGETED_AGENT_ACTION =
  'Targeted agent message, follow-up, and interrupt are not exposed by this SDK version.';
const UNSUPPORTED_TRANSCRIPT_ACTION =
  'Agent and workflow transcript lookup is not exposed by this SDK version.';
const UNSUPPORTED_WORKFLOW_RETRY =
  'Workflow resume and retry are not exposed by this SDK version.';
const FOREGROUND_STOP_UNAVAILABLE =
  'Foreground tasks cannot be stopped from Runtime Center.';
const NO_OWNING_TASK_OUTPUT =
  'Output is unavailable because this agent has no owning background task.';

function action(enabled: boolean, reason?: string): RuntimeCenterActionState {
  return reason === undefined ? { enabled } : { enabled, reason };
}

function isTerminal(status: string): boolean {
  return status === 'completed' || status === 'failed' || status === 'timed_out' || status === 'killed' || status === 'lost' || status === 'aborted';
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : undefined;
}

function stringField(record: Record<string, unknown> | undefined, ...keys: string[]): string | undefined {
  for (const key of keys) {
    const value = record?.[key];
    if (typeof value === 'string' && value.length > 0) return value;
  }
  return undefined;
}

function numberField(record: Record<string, unknown> | undefined, ...keys: string[]): number | undefined {
  for (const key of keys) {
    const value = record?.[key];
    if (typeof value === 'number' && Number.isFinite(value)) return value;
  }
  return undefined;
}

function booleanField(record: Record<string, unknown> | undefined, ...keys: string[]): boolean | undefined {
  for (const key of keys) {
    const value = record?.[key];
    if (typeof value === 'boolean') return value;
  }
  return undefined;
}

function identityFrom(value: unknown): RuntimeCenterIdentity {
  const record = asRecord(value);
  return {
    taskId: stringField(record, 'taskId', 'task_id'),
    runId: stringField(record, 'runId', 'run_id'),
    agentId: stringField(record, 'agentId', 'agent_id'),
    taskPath: stringField(record, 'taskPath', 'task_path', 'canonicalTaskPath', 'canonical_task_path'),
    nodeId: stringField(record, 'nodeId', 'node_id', 'dagNodeId', 'dag_node_id'),
  };
}

function isolationFields(record: Record<string, unknown> | undefined): {
  readonly lease?: string;
  readonly worktree?: string;
} {
  const isolation = asRecord(record?.['isolation']);
  return {
    lease: stringField(record, 'isolationLease', 'isolation_lease', 'leaseId', 'lease_id') ??
      stringField(isolation, 'isolationLease', 'isolation_lease', 'leaseId', 'lease_id'),
    worktree: stringField(record, 'worktreePath', 'worktree_path') ??
      stringField(isolation, 'worktreePath', 'worktree_path'),
  };
}

function actionSetForTask(task: RuntimeCenterTaskInfo): Readonly<Record<RuntimeCenterAction, RuntimeCenterActionState>> {
  const terminal = isTerminal(task.status);
  const canStop = task.detached !== false && !terminal;
  return {
    stop: action(
      canStop,
      terminal
        ? 'This task has already reached a terminal state.'
        : task.detached === false
          ? FOREGROUND_STOP_UNAVAILABLE
          : undefined,
    ),
    output: action(true),
    resume: action(false, 'Task resume is not exposed by this SDK version.'),
    retry: action(false, 'Task retry is not exposed by this SDK version.'),
    message: action(false, UNSUPPORTED_TARGETED_AGENT_ACTION),
    followup: action(false, UNSUPPORTED_TARGETED_AGENT_ACTION),
    interrupt: action(false, UNSUPPORTED_TARGETED_AGENT_ACTION),
    transcript: action(false, UNSUPPORTED_TRANSCRIPT_ACTION),
  };
}

function actionSetForWorkflow(task: RuntimeCenterTaskInfo | undefined, status: string): Readonly<Record<RuntimeCenterAction, RuntimeCenterActionState>> {
  const canStop = task !== undefined && task.detached !== false && !isTerminal(task.status);
  return {
    stop: action(
      canStop,
      task?.detached === false
        ? FOREGROUND_STOP_UNAVAILABLE
        : canStop
          ? undefined
          : 'No active workflow task is available to stop.',
    ),
    output: action(task !== undefined),
    resume: action(false, UNSUPPORTED_WORKFLOW_RETRY),
    retry: action(false, UNSUPPORTED_WORKFLOW_RETRY),
    message: action(false, UNSUPPORTED_TARGETED_AGENT_ACTION),
    followup: action(false, UNSUPPORTED_TARGETED_AGENT_ACTION),
    interrupt: action(false, UNSUPPORTED_TARGETED_AGENT_ACTION),
    transcript: action(false, UNSUPPORTED_TRANSCRIPT_ACTION),
  };
}

function taskLabel(task: RuntimeCenterTaskInfo): string {
  const record = asRecord(task);
  return stringField(record, 'workflowName', 'workflow_name', 'subagentType', 'subagent_type') ?? task.kind;
}

function taskDescription(task: RuntimeCenterTaskInfo): string {
  const record = asRecord(task);
  return stringField(record, 'description') ?? task.kind;
}

function taskDuration(task: RuntimeCenterTaskInfo): number | undefined {
  const explicit = numberField(asRecord(task), 'durationMs', 'duration_ms');
  if (explicit !== undefined) return explicit;
  if (task.endedAt !== null && task.endedAt !== undefined) return Math.max(0, task.endedAt - task.startedAt);
  return undefined;
}

function taskProjection(task: RuntimeCenterTaskInfo): RuntimeCenterTask {
  const record = asRecord(task);
  const isolation = isolationFields(record);
  const identity = identityFrom(task);
  const agentId = identity.agentId ?? (task.kind === 'agent' ? stringField(record, 'agentId', 'agent_id') : undefined);
  return {
    ...identity,
    agentId,
    key: `task:${task.taskId}`,
    kind: task.kind,
    label: taskLabel(task),
    description: taskDescription(task),
    status: task.status,
    model: stringField(record, 'model'),
    usageTokens: numberField(record, 'usageTokens', 'usage_tokens', 'tokens', 'tokensSpent', 'tokens_spent'),
    durationMs: taskDuration(task),
    cache: stringField(record, 'cache', 'cacheStatus', 'cache_status'),
    replayed: booleanField(record, 'replayed', 'isReplayed', 'is_replayed'),
    isolationLease: isolation.lease,
    worktreePath: isolation.worktree,
    actions: actionSetForTask(task),
    source: task,
  };
}

function workflowProjection(
  run: WorkflowRunView,
  task: RuntimeCenterTaskInfo | undefined,
): RuntimeCenterWorkflow {
  const record = asRecord(run);
  const taskRecord = asRecord(task);
  const isolation = isolationFields(record);
  const taskIsolation = isolationFields(taskRecord);
  const identity = identityFrom(run);
  const taskIdentity = identityFrom(task);
  const phases = run.phases.map((phase) => phase.title);
  const dependenciesValue = record?.['dependencies'];
  const dependencies = Array.isArray(dependenciesValue)
    ? dependenciesValue.filter((value): value is string => typeof value === 'string')
    : [];
  const rawNodes = record?.['nodes'] ?? record?.['dagNodes'] ?? record?.['dag_nodes'];
  const nodes = Array.isArray(rawNodes)
    ? rawNodes.slice(0, WORKFLOW_LEDGER_LIMITS.nodes).flatMap((value): RuntimeCenterWorkflowNode[] => {
        const node = asRecord(value);
        const nodeId = stringField(node, 'nodeId', 'node_id', 'id');
        if (nodeId === undefined) return [];
        const nodeDependencies = node?.['dependencies'];
        return [{
          ...identityFrom(node),
          nodeId,
          label: stringField(node, 'label', 'name'),
          status: stringField(node, 'status') ?? 'unknown',
          dependencies: Array.isArray(nodeDependencies)
            ? nodeDependencies.filter((entry): entry is string => typeof entry === 'string')
            : [],
          model: stringField(node, 'model'),
          usageTokens: numberField(node, 'usageTokens', 'usage_tokens', 'tokens', 'tokensSpent', 'tokens_spent'),
          durationMs: numberField(node, 'durationMs', 'duration_ms'),
          cache: stringField(node, 'cache', 'cacheStatus', 'cache_status'),
          replayed: booleanField(node, 'replayed', 'isReplayed', 'is_replayed'),
          isolationLease: isolationFields(node).lease,
          worktreePath: isolationFields(node).worktree,
        }];
      })
    : [];
  return {
    ...identity,
    taskId: identity.taskId ?? taskIdentity.taskId,
    runId: identity.runId ?? run.runId,
    key: `workflow:${run.runId}`,
    name: run.name,
    description: run.description,
    status: run.status,
    phase: run.phase,
    phases,
    nodes,
    dependencies,
    model: stringField(record, 'model') ?? stringField(taskRecord, 'model'),
    usageTokens: run.tokensSpent ?? numberField(record, 'usageTokens', 'usage_tokens', 'tokensSpent', 'tokens_spent'),
    durationMs: run.durationMs,
    cache: stringField(record, 'cache', 'cacheStatus', 'cache_status'),
    replayed: booleanField(record, 'replayed', 'isReplayed', 'is_replayed'),
    isolationLease: isolation.lease ?? taskIsolation.lease,
    worktreePath: isolation.worktree ?? taskIsolation.worktree,
    actions: actionSetForWorkflow(task, run.status),
    source: run,
  };
}

function agentActivity(run: WorkflowRunView | undefined, agentId: string): { status: string; activity: string } {
  const agent = run?.agents.find((candidate) => candidate.agentId === agentId);
  if (agent === undefined) return { status: 'idle', activity: 'idle' };
  return {
    status: agent.status,
    activity: agent.phase ?? agent.summary ?? agent.status,
  };
}

function agentProjection(
  agentId: string,
  metadata: unknown,
  tasks: readonly RuntimeCenterTask[],
  workflows: readonly WorkflowRunView[],
): RuntimeCenterAgent {
  const record = asRecord(metadata);
  const parentAgentId = stringField(record, 'parentAgentId', 'parent_agent_id') ?? undefined;
  const parentPath = parentAgentId === undefined ? undefined : `agent/${parentAgentId}`;
  const task = tasks.find((candidate) => candidate.agentId === agentId);
  const workflow = workflows.find((run) => run.agents.some((agent) => agent.agentId === agentId));
  const workflowAgent = workflow?.agents.find((agent) => agent.agentId === agentId);
  const owningTaskId = task?.taskId ?? workflowAgent?.taskId;
  const activity = agentActivity(workflow, agentId);
  const status = task?.status ?? activity.status;
  const workspaceMode = stringField(record, 'workspaceMode', 'workspace_mode', 'mode', 'isolation');
  return {
    ...identityFrom(metadata),
    runId: workflow?.runId,
    taskId: owningTaskId,
    taskPath: workflowAgent?.taskPath,
    nodeId: workflowAgent?.nodeId,
    agentId,
    key: `agent:${agentId}`,
    treePath: `${parentPath === undefined ? 'agent' : parentPath}/${agentId}`,
    parentAgentId,
    label: stringField(record, 'label', 'name', 'type') ?? agentId,
    status,
    currentActivity: task?.description ?? activity.activity,
    workspaceMode,
    actions: {
      stop: action(false, 'Use the owning task stop action when this agent has a background task.'),
      output: action(owningTaskId !== undefined, owningTaskId === undefined ? NO_OWNING_TASK_OUTPUT : undefined),
      resume: action(false, 'Agent resume is not exposed by this SDK version.'),
      retry: action(false, 'Agent retry is not exposed by this SDK version.'),
      message: action(false, UNSUPPORTED_TARGETED_AGENT_ACTION),
      followup: action(false, UNSUPPORTED_TARGETED_AGENT_ACTION),
      interrupt: action(false, UNSUPPORTED_TARGETED_AGENT_ACTION),
      transcript: action(false, UNSUPPORTED_TRANSCRIPT_ACTION),
    },
  };
}

/**
 * Build all Runtime Center projections from one snapshot. Live refresh and
 * replay hydration both call this function, so the identity columns and
 * disabled-action copy remain consistent across the two paths.
 */
export function projectRuntimeCenter(input: RuntimeCenterProjectionInput): RuntimeCenterProjection {
  const taskRows = input.tasks.map(taskProjection);
  const workflowTasks = new Map<string, RuntimeCenterTaskInfo>();
  for (const task of input.tasks) {
    const runId = identityFrom(task).runId;
    if (runId !== undefined) workflowTasks.set(runId, task);
  }
  const workflowRows = input.workflows.map((run) => workflowProjection(run, workflowTasks.get(run.runId)));
  const agentIds = new Set<string>();
  for (const task of taskRows) if (task.agentId !== undefined) agentIds.add(task.agentId);
  for (const run of input.workflows) for (const agent of run.agents) agentIds.add(agent.agentId);
  for (const agentId of Object.keys(input.agentMetadata ?? {})) agentIds.add(agentId);
  const agents = [...agentIds].map((agentId) =>
    agentProjection(agentId, input.agentMetadata?.[agentId], taskRows, input.workflows),
  ).toSorted((a, b) => a.treePath.localeCompare(b.treePath));
  return {
    tasks: taskRows.toSorted((a, b) => Number(isTerminal(a.status)) - Number(isTerminal(b.status))),
    agents,
    workflows: workflowRows,
  };
}

/** Project one workflow task snapshot into a terminal workflow row when no live progress event arrived. */
export function workflowViewFromTask(task: RuntimeCenterTaskInfo): WorkflowRunView | undefined {
  const record = asRecord(task);
  const runId = stringField(record, 'runId', 'run_id');
  if (record?.['kind'] !== 'workflow' || runId === undefined) return undefined;
  const status = task.status === 'completed' ? 'completed' : task.status === 'running' ? 'running' : 'failed';
  const startedAt = new Date(task.startedAt).toISOString();
  return {
    runId,
    taskId: stringField(record, 'taskId', 'task_id'),
    taskPath: stringField(record, 'taskPath', 'task_path', 'canonicalTaskPath', 'canonical_task_path'),
    nodeId: stringField(record, 'nodeId', 'node_id', 'dagNodeId', 'dag_node_id'),
    name: stringField(record, 'workflowName', 'workflow_name') ?? 'workflow',
    description: task.description,
    phases: [],
    status,
    spawnedAgents: numberField(record, 'agentsSpawned', 'agents_spawned') ?? 0,
    completedAgents: numberField(record, 'agentsCompleted', 'agents_completed') ?? 0,
    startedAt,
    result: undefined,
    error: task.stopReason,
    durationMs: taskDuration(task),
    tokensSpent: numberField(record, 'tokensSpent', 'tokens_spent', 'usageTokens', 'usage_tokens'),
    agents: [],
    logLines: [],
    nodeIds: [],
  };
}

/** Merge task-derived workflow rows without replacing richer live progress. */
export function mergeWorkflowTaskSnapshots(
  runs: readonly WorkflowRunView[],
  tasks: readonly RuntimeCenterTaskInfo[],
): readonly WorkflowRunView[] {
  const limitedRuns = runs.length > WORKFLOW_LEDGER_LIMITS.runs
    ? runs.slice(0, WORKFLOW_LEDGER_LIMITS.runs)
    : runs;
  const byId = new Map(limitedRuns.map((run) => [run.runId, run] as const));
  let changed = limitedRuns !== runs;
  for (const task of tasks) {
    const fallback = workflowViewFromTask(task);
    if (fallback === undefined || byId.has(fallback.runId)) continue;
    byId.set(fallback.runId, fallback);
    changed = true;
  }
  if (!changed) return runs;
  return [...byId.values()]
    .toSorted((a, b) => b.startedAt.localeCompare(a.startedAt))
    .slice(0, WORKFLOW_LEDGER_LIMITS.runs);
}

export function runtimeCenterActionLabel(actionName: RuntimeCenterAction): string {
  switch (actionName) {
    case 'stop': return 'stop';
    case 'output': return 'output';
    case 'resume': return 'resume';
    case 'retry': return 'retry';
    case 'message': return 'message';
    case 'followup': return 'follow-up';
    case 'interrupt': return 'interrupt';
    case 'transcript': return 'transcript';
  }
}

export function runtimeCenterActionReason(
  item: RuntimeCenterTask | RuntimeCenterAgent | RuntimeCenterWorkflow,
  actionName: RuntimeCenterAction,
): string | undefined {
  return item.actions[actionName].reason;
}
