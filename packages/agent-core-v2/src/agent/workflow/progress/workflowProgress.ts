/**
 * `workflow.progress` domain — wire Model (`WorkflowProgressModel`) and the
 * five live progress Ops (`workflow.started`, `workflow.phase_changed`,
 * `workflow.agent_spawned`, `workflow.agent_completed`, `workflow.completed`)
 * that broadcast the lifecycle of a workflow run, plus the telemetry hook the
 * runtime uses to report `tengu_workflow_launched` / `tengu_workflow_completed`.
 *
 * The Model is the replayable per-run progress ledger: `Map<WorkflowRunId,
 * WorkflowRunProgressState>` (initial empty) tracking status, active phase,
 * spawned/completed agent counters, and the terminal result. Each Op folds one
 * lifecycle event into the ledger by run id, keeps `apply` pure (all
 * timestamps are caller-supplied payload fields — never `Date.now()` inside
 * `apply`, so replay is deterministic), and returns the same state reference
 * on a no-op (re-starting the same run, re-entering the same phase, or a
 * terminal completion) so the wire reference-equality gate stays quiet. Every
 * Op carries a `toEvent` that maps to a single `'workflow.progress'`
 * `IEventBus` domain event wrapping the `WorkflowProgressEvent` discriminator,
 * so a single consumer subscription sees every kind of progress.
 *
 * The Ops are deliberately transient (`persist: false`, declared in
 * `TransientOpMap`): the wire journal is not the durability channel for
 * workflow progress — the run journal (`journal.jsonl`, see
 * `persist/journal.ts`) is. Transience keeps `wire.jsonl` lean (no per-agent
 * progress records) while still giving the model replay-independent live
 * semantics and the event broadcast. The telemetry hook is a separate
 * side-effect surface the runtime invokes after `wire.dispatch` (mirroring the
 * plan/task domains: side effects never run inside `apply`); `noop` is the
 * default and `telemetryWorkflowHook` adapts `ITelemetryService.track`.
 */

import { z } from 'zod';

import type { ITelemetryService } from '#/app/telemetry/telemetry';
import { defineModel } from '#/wire/model';

import type {
  WorkflowProgressEvent,
  WorkflowRunId,
  WorkflowRunStatus,
  WorkflowScriptMeta,
} from '#/agent/workflow/types';

/** Telemetry event names for the workflow lifecycle (transport adds the `kfc_` server prefix). */
export const TENGU_WORKFLOW_LAUNCHED = 'tengu_workflow_launched' as const;
export const TENGU_WORKFLOW_COMPLETED = 'tengu_workflow_completed' as const;

/**
 * Per-run progress state kept by the wire Model. `startedAt` is the
 * caller-supplied run start (ISO string); the counters are incremented purely
 * from the dispatched spawn/completion Ops, so the ledger rebuilds identically
 * from replayed records. `result` / `error` are the terminal run outcome.
 */
export interface WorkflowRunProgressState {
  readonly runId: WorkflowRunId;
  readonly taskId?: string;
  readonly taskPath?: string;
  readonly nodeId?: string;
  readonly status: WorkflowRunStatus;
  readonly phase?: string;
  readonly model?: string;
  readonly usageTokens?: number;
  readonly durationMs?: number;
  readonly cache?: string;
  readonly replayed?: boolean;
  readonly isolationLease?: string;
  readonly worktreePath?: string;
  readonly spawnedAgents: number;
  readonly completedAgents: number;
  readonly startedAt: string;
  readonly result?: unknown;
  readonly error?: string;
}

export type WorkflowProgressModelState = Map<WorkflowRunId, WorkflowRunProgressState>;

export const WorkflowProgressModel = defineModel<WorkflowProgressModelState>(
  'workflow.progress',
  () => new Map(),
);

/**
 * The single `IEventBus` domain event a workflow run emits. `event` carries the
 * full `WorkflowProgressEvent` discriminator so consumers switch on
 * `event.event.type` to see started / phase_changed / agent_spawned /
 * agent_completed / completed.
 */
export interface WorkflowProgressBusEvent {
  readonly runId: WorkflowRunId;
  readonly event: WorkflowProgressEvent;
}

declare module '#/app/event/eventBus' {
  interface DomainEventMap {
    'workflow.progress': WorkflowProgressBusEvent;
  }
}

declare module '#/wire/types' {
  interface TransientOpMap {
    'workflow.started': typeof workflowStarted;
    'workflow.phase_changed': typeof workflowPhaseChanged;
    'workflow.agent_spawned': typeof workflowAgentSpawned;
    'workflow.agent_completed': typeof workflowAgentCompleted;
    'workflow.log': typeof workflowLog;
    'workflow.completed': typeof workflowCompleted;
  }
}

function progressBusEvent(
  event: WorkflowProgressEvent,
): { readonly type: 'workflow.progress' } & WorkflowProgressBusEvent {
  return { type: 'workflow.progress', runId: event.runId, event };
}

export interface WorkflowStartedPayload {
  readonly runId: WorkflowRunId;
  readonly meta: WorkflowScriptMeta;
  readonly startedAt: string;
  readonly taskId?: string;
  readonly taskPath?: string;
  readonly nodeId?: string;
  readonly model?: string;
  readonly isolationLease?: string;
  readonly worktreePath?: string;
}

const workflowStartedSchema = z.object({
  runId: z.custom<WorkflowRunId>(),
  meta: z.custom<WorkflowScriptMeta>(),
  startedAt: z.string(),
  taskId: z.string().optional(),
  taskPath: z.string().optional(),
  nodeId: z.string().optional(),
  model: z.string().optional(),
  isolationLease: z.string().optional(),
  worktreePath: z.string().optional(),
});

/** Start a workflow run: seeds the ledger with a `running` entry. */
export const workflowStarted = WorkflowProgressModel.defineOp('workflow.started', {
  schema: workflowStartedSchema,
  persist: false,
  apply: (s, p) => {
    if (s.has(p.runId)) return s;
    const next = new Map(s);
    next.set(p.runId, {
      runId: p.runId,
      status: 'running',
      taskId: p.taskId,
      taskPath: p.taskPath,
      nodeId: p.nodeId,
      model: p.model,
      isolationLease: p.isolationLease,
      worktreePath: p.worktreePath,
      spawnedAgents: 0,
      completedAgents: 0,
      startedAt: p.startedAt,
    });
    return next;
  },
  toEvent: (p) =>
    progressBusEvent({
      type: 'workflow.started',
      runId: p.runId,
      meta: p.meta,
      startedAt: p.startedAt,
      ...(p.taskId === undefined ? {} : { taskId: p.taskId }),
      ...(p.taskPath === undefined ? {} : { taskPath: p.taskPath }),
      ...(p.nodeId === undefined ? {} : { nodeId: p.nodeId }),
      ...(p.model === undefined ? {} : { model: p.model }),
      ...(p.isolationLease === undefined ? {} : { isolationLease: p.isolationLease }),
      ...(p.worktreePath === undefined ? {} : { worktreePath: p.worktreePath }),
    }),
});

export interface WorkflowPhaseChangedPayload {
  readonly runId: WorkflowRunId;
  readonly phase: string;
  readonly nodeId?: string;
  readonly dependencies?: readonly string[];
}

const workflowPhaseChangedSchema = z.object({
  runId: z.custom<WorkflowRunId>(),
  phase: z.string(),
  nodeId: z.string().optional(),
  dependencies: z.array(z.string()).optional(),
});

/** Mark the run's active phase. Re-emitting the current phase is a no-op. */
export const workflowPhaseChanged = WorkflowProgressModel.defineOp(
  'workflow.phase_changed',
  {
    schema: workflowPhaseChangedSchema,
    persist: false,
    apply: (s, p) => {
      const current = s.get(p.runId);
      if (current === undefined || current.phase === p.phase) return s;
      const next = new Map(s);
      next.set(p.runId, { ...current, phase: p.phase });
      return next;
    },
    toEvent: (p) =>
      progressBusEvent({
        type: 'workflow.phase_changed',
        runId: p.runId,
        phase: p.phase,
        ...(p.nodeId === undefined ? {} : { nodeId: p.nodeId }),
        ...(p.dependencies === undefined ? {} : { dependencies: p.dependencies }),
      }),
  },
);

export interface WorkflowAgentSpawnedPayload {
  readonly runId: WorkflowRunId;
  readonly agentId: string;
  readonly label?: string;
  readonly phase?: string;
  readonly taskId?: string;
  readonly taskPath?: string;
  readonly nodeId?: string;
  readonly model?: string;
  readonly isolationLease?: string;
  readonly worktreePath?: string;
  readonly cache?: string;
  readonly replayed?: boolean;
}

const workflowAgentSpawnedSchema = z.object({
  runId: z.custom<WorkflowRunId>(),
  agentId: z.string(),
  label: z.string().optional(),
  phase: z.string().optional(),
  taskId: z.string().optional(),
  taskPath: z.string().optional(),
  nodeId: z.string().optional(),
  model: z.string().optional(),
  isolationLease: z.string().optional(),
  worktreePath: z.string().optional(),
  cache: z.string().optional(),
  replayed: z.boolean().optional(),
});

/** Record one subagent spawn; bumps the spawned counter for the run. */
export const workflowAgentSpawned = WorkflowProgressModel.defineOp(
  'workflow.agent_spawned',
  {
    schema: workflowAgentSpawnedSchema,
    persist: false,
    apply: (s, p) => {
      const current = s.get(p.runId);
      if (current === undefined) return s;
      const next = new Map(s);
      next.set(p.runId, { ...current, spawnedAgents: current.spawnedAgents + 1 });
      return next;
    },
    toEvent: (p) =>
      progressBusEvent({
        type: 'workflow.agent_spawned',
        runId: p.runId,
        agentId: p.agentId,
        ...(p.label === undefined ? {} : { label: p.label }),
        ...(p.phase === undefined ? {} : { phase: p.phase }),
        ...(p.taskId === undefined ? {} : { taskId: p.taskId }),
        ...(p.taskPath === undefined ? {} : { taskPath: p.taskPath }),
        ...(p.nodeId === undefined ? {} : { nodeId: p.nodeId }),
        ...(p.model === undefined ? {} : { model: p.model }),
        ...(p.isolationLease === undefined ? {} : { isolationLease: p.isolationLease }),
        ...(p.worktreePath === undefined ? {} : { worktreePath: p.worktreePath }),
        ...(p.cache === undefined ? {} : { cache: p.cache }),
        ...(p.replayed === undefined ? {} : { replayed: p.replayed }),
      }),
  },
);

export interface WorkflowAgentCompletedPayload {
  readonly runId: WorkflowRunId;
  readonly agentId: string;
  readonly ok: boolean;
  readonly durationMs: number;
  readonly model?: string;
  readonly tokens?: number;
  readonly summary?: string;
  readonly taskId?: string;
  readonly taskPath?: string;
  readonly nodeId?: string;
  readonly cache?: string;
  readonly replayed?: boolean;
  readonly isolationLease?: string;
  readonly worktreePath?: string;
}

const workflowAgentCompletedSchema = z.object({
  runId: z.custom<WorkflowRunId>(),
  agentId: z.string(),
  ok: z.boolean(),
  durationMs: z.number(),
  model: z.string().optional(),
  tokens: z.number().optional(),
  summary: z.string().optional(),
  taskId: z.string().optional(),
  taskPath: z.string().optional(),
  nodeId: z.string().optional(),
  cache: z.string().optional(),
  replayed: z.boolean().optional(),
  isolationLease: z.string().optional(),
  worktreePath: z.string().optional(),
});

/** Record one subagent completion; bumps the completed counter for the run. */
export const workflowAgentCompleted = WorkflowProgressModel.defineOp(
  'workflow.agent_completed',
  {
    schema: workflowAgentCompletedSchema,
    persist: false,
    apply: (s, p) => {
      const current = s.get(p.runId);
      if (current === undefined) return s;
      const next = new Map(s);
      next.set(p.runId, { ...current, completedAgents: current.completedAgents + 1 });
      return next;
    },
    toEvent: (p) =>
      progressBusEvent({
        type: 'workflow.agent_completed',
        runId: p.runId,
        agentId: p.agentId,
        ok: p.ok,
        durationMs: p.durationMs,
        ...(p.model === undefined ? {} : { model: p.model }),
        ...(p.tokens === undefined ? {} : { tokens: p.tokens }),
        ...(p.summary === undefined ? {} : { summary: p.summary }),
        ...(p.taskId === undefined ? {} : { taskId: p.taskId }),
        ...(p.taskPath === undefined ? {} : { taskPath: p.taskPath }),
        ...(p.nodeId === undefined ? {} : { nodeId: p.nodeId }),
        ...(p.cache === undefined ? {} : { cache: p.cache }),
        ...(p.replayed === undefined ? {} : { replayed: p.replayed }),
        ...(p.isolationLease === undefined ? {} : { isolationLease: p.isolationLease }),
        ...(p.worktreePath === undefined ? {} : { worktreePath: p.worktreePath }),
      }),
  },
);

export interface WorkflowLogPayload {
  readonly runId: WorkflowRunId;
  readonly message: string;
}

const workflowLogSchema = z.object({
  runId: z.custom<WorkflowRunId>(),
  message: z.string(),
});

/**
 * Append a narrator `log()` line. Model apply is a no-op (the run ledger does
 * not retain log lines; the durable channel is the run journal) — the Op
 * exists for the `workflow.log` bus event so live consumers (the TUI's
 * `/workflows` view) can render narrator lines as they happen.
 */
export const workflowLog = WorkflowProgressModel.defineOp('workflow.log', {
  schema: workflowLogSchema,
  persist: false,
  apply: (s) => s,
  toEvent: (p) =>
    progressBusEvent({ type: 'workflow.log', runId: p.runId, message: p.message }),
});

export interface WorkflowCompletedPayload {
  readonly runId: WorkflowRunId;
  readonly ok: boolean;
  readonly result?: unknown;
  readonly error?: string;
  readonly agentsSpawned?: number;
  readonly tokensSpent?: number;
  readonly durationMs?: number;
  readonly taskId?: string;
  readonly taskPath?: string;
  readonly nodeId?: string;
  readonly cache?: string;
  readonly replayed?: boolean;
  readonly isolationLease?: string;
  readonly worktreePath?: string;
}

const workflowCompletedSchema = z.object({
  runId: z.custom<WorkflowRunId>(),
  ok: z.boolean(),
  result: z.unknown().optional(),
  error: z.string().optional(),
  agentsSpawned: z.number().optional(),
  tokensSpent: z.number().optional(),
  durationMs: z.number().optional(),
  taskId: z.string().optional(),
  taskPath: z.string().optional(),
  nodeId: z.string().optional(),
  cache: z.string().optional(),
  replayed: z.boolean().optional(),
  isolationLease: z.string().optional(),
  worktreePath: z.string().optional(),
});

/** Settle the run: `ok` → `completed`, otherwise `failed`. Terminal runs ignore later settles. */
export const workflowCompleted = WorkflowProgressModel.defineOp('workflow.completed', {
  schema: workflowCompletedSchema,
  persist: false,
  apply: (s, p) => {
    const current = s.get(p.runId);
    if (current === undefined || current.status !== 'running') return s;
    const next = new Map(s);
    next.set(p.runId, {
      ...current,
      status: p.ok ? 'completed' : 'failed',
      taskId: p.taskId ?? current.taskId,
      taskPath: p.taskPath ?? current.taskPath,
      nodeId: p.nodeId ?? current.nodeId,
      cache: p.cache ?? current.cache,
      replayed: p.replayed ?? current.replayed,
      isolationLease: p.isolationLease ?? current.isolationLease,
      worktreePath: p.worktreePath ?? current.worktreePath,
      ...(p.result === undefined ? {} : { result: p.result }),
      ...(p.error === undefined ? {} : { error: p.error }),
    });
    return next;
  },
  toEvent: (p) =>
    progressBusEvent({
      type: 'workflow.completed',
      runId: p.runId,
      ok: p.ok,
      result: p.result,
      error: p.error,
      ...(p.agentsSpawned === undefined ? {} : { agentsSpawned: p.agentsSpawned }),
      ...(p.tokensSpent === undefined ? {} : { tokensSpent: p.tokensSpent }),
      ...(p.durationMs === undefined ? {} : { durationMs: p.durationMs }),
      ...(p.taskId === undefined ? {} : { taskId: p.taskId }),
      ...(p.taskPath === undefined ? {} : { taskPath: p.taskPath }),
      ...(p.nodeId === undefined ? {} : { nodeId: p.nodeId }),
      ...(p.cache === undefined ? {} : { cache: p.cache }),
      ...(p.replayed === undefined ? {} : { replayed: p.replayed }),
      ...(p.isolationLease === undefined ? {} : { isolationLease: p.isolationLease }),
      ...(p.worktreePath === undefined ? {} : { worktreePath: p.worktreePath }),
    }),
});

/**
 * Telemetry surface for workflow lifecycle reporting. The runtime invokes
 * `launched` right after dispatching `workflow.started` and `completed` after
 * `workflow.completed`. Kept as a hook (not inside the Ops) because telemetry
 * is a side effect: `apply` must stay pure and `toEvent` stays a pure event
 * derivation, matching how the plan/task domains report after dispatch.
 */
export interface WorkflowTelemetryHook {
  launched(runId: WorkflowRunId, meta: WorkflowScriptMeta): void;
  completed(runId: WorkflowRunId, ok: boolean, error?: string): void;
}

/** Default no-op hook — safe to use before telemetry is wired. */
export const noopWorkflowTelemetryHook: WorkflowTelemetryHook = {
  launched: () => {},
  completed: () => {},
};

/** Adapt `ITelemetryService.track` into the workflow telemetry hook. */
export function telemetryWorkflowHook(telemetry: ITelemetryService): WorkflowTelemetryHook {
  return {
    launched: (runId, meta) => {
      telemetry.track(TENGU_WORKFLOW_LAUNCHED, { run_id: runId, workflow_name: meta.name });
    },
    completed: (runId, ok, error) => {
      telemetry.track(TENGU_WORKFLOW_COMPLETED, {
        run_id: runId,
        ok,
        ...(error === undefined ? {} : { error }),
      });
    },
  };
}
