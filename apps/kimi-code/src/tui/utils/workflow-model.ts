/**
 * `tui.workflow` — TUI-side model of workflow run progress.
 *
 * The agent-core-v2 workflow engine broadcasts run lifecycle as
 * `workflow.progress` wire events (`IEventBus`); the SDK event wiring forwards
 * them to the client through `session.onWorkflowProgress` whose `event` payload
 * is a `WorkflowProgressEvent` discriminator (started / phase_changed /
 * agent_spawned / agent_completed / completed). The TUI does not poll — it
 * folds each event into a lightweight `WorkflowRunView` ledger stored on
 * `AppState` (`appState.workflowRuns`), which the `/workflows` command renders
 * as the saved workflow run tree.
 *
 * The reducer (`applyWorkflowProgressEvent`) is pure and reference-stable: it
 * returns the same array reference when an event changes nothing, so
 * `setAppState`'s `Object.is` gate (`hasPatchChanges`) stays quiet and no
 * extra render is scheduled. Runs are stored newest-first (a new
 * `workflow.started` is prepended); agents are stored in spawn order.
 *
 * Deliberately a projection of the engine's live `workflow.progress` model,
 * not a copy of the durable journal: the per-agent completion payload on the
 * wire carries only `{ok, durationMs}` (no result text), so agent "summaries"
 * here are the label + status + duration shown next to the run tree.
 */

import type { WorkflowPhaseMeta, WorkflowProgressEvent } from '@moonshot-ai/agent-core-v2';

/** Lifecycle status of a workflow run as shown in the TUI. */
export type WorkflowRunViewStatus = 'running' | 'completed' | 'failed' | 'aborted';

/** Status of one subagent spawned by a workflow. `aborted` means the agent was
 *  spawned but the run ended before it reported a completion. */
export type WorkflowRunAgentStatus = 'running' | 'completed' | 'failed' | 'aborted';

/** One declared phase of the run's `meta.phases`. */
export interface WorkflowRunViewPhase extends WorkflowPhaseMeta {}

/** One subagent of a workflow run, folded from spawn/completion events. */
export interface WorkflowRunAgentView {
  readonly agentId: string;
  readonly label?: string;
  /** The workflow phase this agent belongs to (from `agent({ phase })`). */
  readonly phase?: string;
  readonly status: WorkflowRunAgentStatus;
  /** Agent wall-clock duration in ms; set once a completion event arrives. */
  readonly durationMs?: number;
  /** Display model of the subagent, when the completion event carried one. */
  readonly model?: string;
  /** Total tokens the subagent consumed, when the completion event carried it. */
  readonly tokens?: number;
  /** One-line outcome summary (whitespace-collapsed preview of the output). */
  readonly summary?: string;
  readonly taskId?: string;
  readonly taskPath?: string;
  readonly nodeId?: string;
  readonly cache?: string;
  readonly replayed?: boolean;
  readonly isolationLease?: string;
  readonly worktreePath?: string;
}

/** The per-run ledger the `/workflows` command renders. */
export interface WorkflowRunView {
  readonly runId: string;
  readonly taskId?: string;
  readonly taskPath?: string;
  readonly nodeId?: string;
  readonly name: string;
  readonly description: string;
  /** Declared phases from `meta.phases`; agent groups are matched against these. */
  readonly phases: readonly WorkflowRunViewPhase[];
  readonly status: WorkflowRunViewStatus;
  /** The run's currently active phase (from `workflow.phase_changed`). */
  readonly phase?: string;
  readonly dependencies?: readonly string[];
  readonly model?: string;
  readonly cache?: string;
  readonly replayed?: boolean;
  readonly isolationLease?: string;
  readonly worktreePath?: string;
  /** Total subagents spawned (cap-counted attempts, mirroring the runtime). */
  readonly spawnedAgents: number;
  /** Subagents that reported a completion. */
  readonly completedAgents: number;
  readonly startedAt: string;
  /** Terminal result of a completed run (`workflow.completed` result). */
  readonly result?: unknown;
  /** Terminal error of a failed run. */
  readonly error?: string;
  /** Run wall-clock duration in ms, set by the terminal event. */
  readonly durationMs?: number;
  /** Total tokens spent by the run's subagents, set by the terminal event. */
  readonly tokensSpent?: number;
  readonly agents: readonly WorkflowRunAgentView[];
  /** Narrator log lines (`log(...)`), folded from `workflow.log` events. */
  readonly logLines: readonly string[];
  /** Node identities observed on progress events, capped for a long-lived TUI session. */
  readonly nodeIds?: readonly string[];
}

/** Ledger of all workflow runs the TUI has observed this session. */
export type WorkflowRunsViewState = readonly WorkflowRunView[];

/** Empty ledger — the `AppState.workflowRuns` default. */
export const EMPTY_WORKFLOW_RUNS: WorkflowRunsViewState = [];

/**
 * Memory limits for the live workflow projection. These are intentionally
 * conservative because progress is delivered over a session-lifetime stream,
 * while the durable workflow journal remains the source for full history.
 */
export const WORKFLOW_LEDGER_LIMITS = {
  runs: 100,
  agents: 100,
  logs: 200,
  nodes: 100,
  logLineCharacters: 4_096,
} as const;

/**
 * Type guard for the `workflow.progress` domain event as delivered by the SDK
 * event channel. The v1 `Event` union is closed, so the SDK surfaces the
 * engine's wire event without a static type; this guard narrows the runtime
 * shape `{ type: 'workflow.progress', runId, event: WorkflowProgressEvent }`
 * (plus the SDK-stamped `sessionId` / `agentId`).
 */
export function isWorkflowProgressEvent(
  value: unknown,
): value is { readonly type: 'workflow.progress'; readonly runId: string; readonly event: WorkflowProgressEvent } {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as { readonly type?: unknown; readonly runId?: unknown; readonly event?: unknown };
  if (candidate.type !== 'workflow.progress') return false;
  if (typeof candidate.runId !== 'string') return false;
  if (typeof candidate.event !== 'object' || candidate.event === null) return false;
  const event = candidate.event as { readonly type?: unknown; readonly runId?: unknown };
  return typeof event.type === 'string' && event.type.startsWith('workflow.') && event.runId === candidate.runId;
}

/**
 * Read the `WorkflowProgressEvent` payload out of an SDK-delivered
 * `workflow.progress` event, or `undefined` when `value` is not one. Callers
 * pass the raw `unknown` event here rather than narrowing it in place: the SDK
 * `Event` union is closed, so a type guard would narrow an `Event` to `never`
 * instead of the asserted shape.
 */
export function extractWorkflowProgressEvent(
  value: unknown,
): WorkflowProgressEvent | undefined {
  return isWorkflowProgressEvent(value) ? value.event : undefined;
}

/**
 * Fold one `WorkflowProgressEvent` into the run ledger. Returns the same array
 * reference when nothing changed (unknown run id, a phase re-entry, a terminal
 * run receiving a late event, or a completion for an unspawned agent), so
 * callers can compare by reference to decide whether to `setAppState`.
 */
export function applyWorkflowProgressEvent(
  runs: WorkflowRunsViewState,
  progress: WorkflowProgressEvent,
): WorkflowRunsViewState {
  switch (progress.type) {
    case 'workflow.started': {
      if (runs.some((run) => run.runId === progress.runId)) return runs;
      const view: WorkflowRunView = {
        runId: progress.runId,
        taskId: progress.taskId,
        taskPath: progress.taskPath,
        nodeId: progress.nodeId,
        name: progress.meta.name,
        description: progress.meta.description,
        phases: progress.meta.phases ?? [],
        status: 'running',
        model: progress.model,
        isolationLease: progress.isolationLease,
        worktreePath: progress.worktreePath,
        startedAt: progress.startedAt,
        spawnedAgents: 0,
        completedAgents: 0,
        agents: [],
        logLines: [],
        nodeIds: progress.nodeId === undefined ? [] : [progress.nodeId],
      };
      return [view, ...runs].slice(0, WORKFLOW_LEDGER_LIMITS.runs);
    }
    case 'workflow.phase_changed':
      return mapRun(runs, progress.runId, (run) =>
        run.phase === progress.phase &&
        JSON.stringify(run.dependencies ?? []) === JSON.stringify(progress.dependencies ?? []) &&
        run.nodeId === (progress.nodeId ?? run.nodeId)
          ? run
          : {
              ...run,
              phase: progress.phase,
              nodeId: progress.nodeId ?? run.nodeId,
              dependencies: progress.dependencies ?? run.dependencies,
              nodeIds: appendNodeId(run.nodeIds, progress.nodeId),
            },
      );
    case 'workflow.agent_spawned':
      return mapRun(runs, progress.runId, (run) => ({
        ...run,
        spawnedAgents: run.spawnedAgents + 1,
        agents: appendAgent(run.agents, {
          agentId: progress.agentId,
          ...(progress.label === undefined ? {} : { label: progress.label }),
          ...(progress.phase === undefined ? {} : { phase: progress.phase }),
          status: 'running',
          taskId: progress.taskId,
          taskPath: progress.taskPath,
          nodeId: progress.nodeId,
          cache: progress.cache,
          replayed: progress.replayed,
          isolationLease: progress.isolationLease,
          worktreePath: progress.worktreePath,
        }, WORKFLOW_LEDGER_LIMITS.agents),
        nodeIds: appendNodeId(run.nodeIds, progress.nodeId),
      }));
    case 'workflow.agent_completed':
      return mapRun(runs, progress.runId, (run) => {
        let matched = false;
        const agents = run.agents.map((agent): WorkflowRunAgentView => {
          if (agent.agentId !== progress.agentId) return agent;
          matched = true;
          return {
            ...agent,
            status: progress.ok ? 'completed' : 'failed',
            durationMs: progress.durationMs,
            ...(progress.model === undefined ? {} : { model: progress.model }),
            ...(progress.tokens === undefined ? {} : { tokens: progress.tokens }),
            ...(progress.summary === undefined ? {} : { summary: progress.summary }),
            taskId: progress.taskId ?? agent.taskId,
            taskPath: progress.taskPath ?? agent.taskPath,
            nodeId: progress.nodeId ?? agent.nodeId,
            cache: progress.cache ?? agent.cache,
            replayed: progress.replayed ?? agent.replayed,
            isolationLease: progress.isolationLease ?? agent.isolationLease,
            worktreePath: progress.worktreePath ?? agent.worktreePath,
          };
        });
        if (!matched) return run;
        return {
          ...run,
          completedAgents: run.completedAgents + 1,
          agents,
          nodeIds: appendNodeId(run.nodeIds, progress.nodeId),
        };
      });
    case 'workflow.log':
      return mapRun(runs, progress.runId, (run) =>
        run.status !== 'running'
          ? run
          : {
              ...run,
              logLines: appendLogLine(run.logLines, progress.message),
            },
      );
    case 'workflow.completed':
      return mapRun(runs, progress.runId, (run) => {
        if (run.status !== 'running') return run;
        return {
          ...run,
          status: progress.ok ? 'completed' : 'failed',
          taskId: progress.taskId ?? run.taskId,
          taskPath: progress.taskPath ?? run.taskPath,
          nodeId: progress.nodeId ?? run.nodeId,
          nodeIds: appendNodeId(run.nodeIds, progress.nodeId),
          cache: progress.cache ?? run.cache,
          replayed: progress.replayed ?? run.replayed,
          isolationLease: progress.isolationLease ?? run.isolationLease,
          worktreePath: progress.worktreePath ?? run.worktreePath,
          ...(progress.result === undefined ? {} : { result: progress.result }),
          ...(progress.error === undefined ? {} : { error: progress.error }),
          ...(progress.durationMs === undefined ? {} : { durationMs: progress.durationMs }),
          ...(progress.tokensSpent === undefined ? {} : { tokensSpent: progress.tokensSpent }),
          // Subagents spawned but cut off before reporting a completion are
          // surfaced as aborted once the run settles, so the tree does not
          // show dangling "running" rows under a terminal run.
          agents: run.agents.map(
            (agent): WorkflowRunAgentView =>
              agent.status === 'running' ? { ...agent, status: 'aborted' } : agent,
          ),
        };
      });
    default:
      return runs;
  }
}

function appendAgent(
  agents: readonly WorkflowRunAgentView[],
  agent: WorkflowRunAgentView,
  limit: number,
): readonly WorkflowRunAgentView[] {
  return [...agents, agent].slice(-limit);
}

function appendLogLine(logLines: readonly string[], message: string): readonly string[] {
  const boundedMessage = message.length > WORKFLOW_LEDGER_LIMITS.logLineCharacters
    ? message.slice(0, WORKFLOW_LEDGER_LIMITS.logLineCharacters)
    : message;
  return [...logLines, boundedMessage].slice(-WORKFLOW_LEDGER_LIMITS.logs);
}

function appendNodeId(
  nodeIds: readonly string[] | undefined,
  nodeId: string | undefined,
): readonly string[] {
  if (nodeId === undefined || nodeId.length === 0) return nodeIds ?? [];
  if (nodeIds?.includes(nodeId) === true) return nodeIds;
  return [...(nodeIds ?? []), nodeId].slice(-WORKFLOW_LEDGER_LIMITS.nodes);
}

/**
 * Map the run with `runId` through `fn`. Returns the original array when the
 * run is unknown or `fn` returned the same run reference (no-op), so the
 * result is reference-stable for the `setAppState` gate.
 */
function mapRun(
  runs: WorkflowRunsViewState,
  runId: string,
  fn: (run: WorkflowRunView) => WorkflowRunView,
): WorkflowRunsViewState {
  let found = false;
  const next = runs.map((run) => {
    if (run.runId !== runId) return run;
    found = true;
    return fn(run);
  });
  if (!found) return runs;
  for (let i = 0; i < next.length; i++) {
    if (next[i] !== runs[i]) return next;
  }
  return runs;
}
