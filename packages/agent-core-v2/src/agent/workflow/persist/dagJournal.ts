/**
 * `workflow.persist` domain — append-only DAG node journal records and a
 * restart-safe fold for node state, checkpoints, and lost running attempts.
 */

import type { IDisposable } from '#/_base/di/lifecycle';
import type { IAppendLogStore } from '#/persistence/interface/appendLogStore';
import { canonicalWorkflowJson } from '#/agent/workflow/ir/fingerprint';
import type {
  WorkflowNodeId,
  WorkflowNodeProvenance,
  WorkflowNodeResult,
  WorkflowNodeStatus,
  WorkflowProvenance,
  WorkflowRunId,
} from '#/agent/workflow/types';

export type WorkflowRunTerminal = 'completed' | 'failed' | 'cancelled';

export interface WorkflowRunLeaseState {
  readonly state: 'held' | 'available';
  readonly held: boolean;
  readonly owner?: string;
}

export class WorkflowRunAlreadyLeasedError extends Error {
  readonly code = 'workflow.run_locked' as const;

  constructor(readonly scope: string, readonly runId: WorkflowRunId) {
    super(`Workflow run "${runId}" is already leased for execution.`);
    this.name = 'WorkflowRunAlreadyLeasedError';
  }
}

const workflowRunLeases = new Map<string, string>();
let nextWorkflowLeaseId = 0;

export interface WorkflowRunLease extends IDisposable {
  readonly leaseId: string;
  readonly state: 'held' | 'released';
}

export function acquireWorkflowRunLease(scope: string, runId: WorkflowRunId): WorkflowRunLease {
  const key = `${scope}\n${runId}`;
  if (workflowRunLeases.has(key)) throw new WorkflowRunAlreadyLeasedError(scope, runId);
  const leaseId = `workflow-lease-${String(++nextWorkflowLeaseId)}`;
  workflowRunLeases.set(key, leaseId);
  let state: WorkflowRunLease['state'] = 'held';
  return {
    leaseId,
    get state() { return state; },
    dispose: () => {
      if (state === 'released') return;
      state = 'released';
      if (workflowRunLeases.get(key) === leaseId) workflowRunLeases.delete(key);
    },
  };
}

export function workflowRunLeaseState(scope: string, runId: WorkflowRunId): WorkflowRunLeaseState {
  const owner = workflowRunLeases.get(`${scope}\n${runId}`);
  return owner === undefined
    ? { state: 'available', held: false }
    : { state: 'held', held: true, owner };
}

export type WorkflowNodeJournalRecord =
  | {
      readonly kind: 'node.planned';
      readonly runId: WorkflowRunId;
      readonly nodeId: WorkflowNodeId;
      readonly fingerprint: string;
      readonly provenance: WorkflowNodeProvenance;
      readonly at: string;
    }
  | {
      readonly kind: 'node.ready';
      readonly runId: WorkflowRunId;
      readonly nodeId: WorkflowNodeId;
      readonly fingerprint: string;
      readonly at: string;
    }
  | {
      readonly kind: 'node.running';
      readonly runId: WorkflowRunId;
      readonly nodeId: WorkflowNodeId;
      readonly fingerprint: string;
      readonly attempt: number;
      readonly at: string;
    }
  | {
      readonly kind: 'node.completed';
      readonly runId: WorkflowRunId;
      readonly nodeId: WorkflowNodeId;
      readonly fingerprint: string;
      readonly attempt: number;
      readonly result: WorkflowNodeResult;
      readonly at: string;
    }
  | {
      readonly kind: 'node.failed';
      readonly runId: WorkflowRunId;
      readonly nodeId: WorkflowNodeId;
      readonly fingerprint: string;
      readonly attempt: number;
      readonly error: { readonly code: string; readonly message: string; readonly details?: unknown };
      readonly result?: WorkflowNodeResult;
      readonly at: string;
    }
  | {
      readonly kind: 'node.skipped' | 'node.blocked' | 'node.lost';
      readonly runId: WorkflowRunId;
      readonly nodeId: WorkflowNodeId;
      readonly fingerprint: string;
      readonly attempt?: number;
      readonly reason?: string;
      readonly at: string;
    }
  | {
      readonly kind: 'checkpoint';
      readonly runId: WorkflowRunId;
      readonly checkpointId: string;
      readonly graphVersion: string;
      readonly nodes: readonly WorkflowNodeCheckpoint[];
      readonly spent: number;
      readonly reserved: number;
      readonly at: string;
    };

export class WorkflowJournalCorruptionError extends Error {
  readonly code = 'workflow.journal_corrupt' as const;

  constructor(message: string) {
    super(message);
    this.name = 'WorkflowJournalCorruptionError';
  }
}

const WORKFLOW_NODE_JOURNAL_KINDS = new Set([
  'node.planned',
  'node.ready',
  'node.running',
  'node.completed',
  'node.failed',
  'node.skipped',
  'node.blocked',
  'node.lost',
  'checkpoint',
]);

export interface WorkflowNodeCheckpoint {
  readonly nodeId: WorkflowNodeId;
  readonly status: WorkflowNodeStatus;
  readonly fingerprint: string;
  readonly attempt: number;
  readonly result?: WorkflowNodeResult;
  readonly error?: { readonly code: string; readonly message: string; readonly details?: unknown };
  readonly provenance?: WorkflowNodeProvenance;
  readonly updatedAt: string;
}

export interface WorkflowDagNodeState extends WorkflowNodeCheckpoint {
  readonly status: WorkflowNodeStatus;
  readonly lostAt?: string;
}

export interface WorkflowDagJournalSummary {
  readonly runId: WorkflowRunId | undefined;
  readonly started: boolean;
  readonly terminal: WorkflowRunTerminal | undefined;
  readonly lease: WorkflowRunLeaseState;
  readonly graphVersion: string | undefined;
  readonly nodes: ReadonlyMap<WorkflowNodeId, WorkflowDagNodeState>;
  readonly checkpoints: readonly WorkflowNodeCheckpoint[];
  readonly spent: number;
  readonly reserved: number;
}

export interface FoldWorkflowJournalOptions {
  readonly recoverRunning?: boolean;
  readonly lostAt?: string;
  readonly started?: boolean;
  readonly terminal?: WorkflowRunTerminal;
  readonly lease?: WorkflowRunLeaseState;
}

export function foldWorkflowJournal(
  records: readonly WorkflowNodeJournalRecord[],
  options: FoldWorkflowJournalOptions = {},
): WorkflowDagJournalSummary {
  const nodes = new Map<WorkflowNodeId, WorkflowDagNodeState>();
  const checkpoints: WorkflowNodeCheckpoint[] = [];
  let runId: WorkflowRunId | undefined;
  let graphVersion: string | undefined;
  let spent = 0;
  let reserved = 0;
  const terminalEvents = new Map<string, string>();
  const checkpointIds = new Set<string>();
  for (const record of records) {
    assertWorkflowNodeJournalRecord(record);
    runId ??= record.runId;
    switch (record.kind) {
      case 'node.planned':
        nodes.set(record.nodeId, {
          nodeId: record.nodeId,
          status: 'planned',
          fingerprint: record.fingerprint,
          attempt: 0,
          provenance: record.provenance,
          updatedAt: record.at,
        });
        break;
      case 'node.ready':
        updateState(nodes, record.nodeId, {
          status: 'ready',
          fingerprint: record.fingerprint,
          updatedAt: record.at,
        });
        break;
      case 'node.running':
        updateState(nodes, record.nodeId, {
          status: options.recoverRunning === false ? 'running' : 'lost',
          fingerprint: record.fingerprint,
          attempt: record.attempt,
          updatedAt: record.at,
          ...(options.recoverRunning === false ? {} : { lostAt: options.lostAt ?? record.at }),
        });
        break;
      case 'node.completed':
        if (isDuplicateTerminalEvent(terminalEvents, record)) break;
        updateState(nodes, record.nodeId, {
          status: 'completed',
          fingerprint: record.fingerprint,
          attempt: record.attempt,
          result: record.result,
          updatedAt: record.at,
        });
        spent += usageTotal(record.result.usage);
        break;
      case 'node.failed':
        if (isDuplicateTerminalEvent(terminalEvents, record)) break;
        updateState(nodes, {
          nodeId: record.nodeId,
          status: 'failed',
          fingerprint: record.fingerprint,
          attempt: record.attempt,
          ...(record.result === undefined ? {} : { result: record.result }),
          error: record.error,
          updatedAt: record.at,
        });
        spent += usageTotal(record.result?.usage);
        break;
      case 'node.skipped':
      case 'node.blocked':
      case 'node.lost':
        updateState(nodes, record.nodeId, {
          status: record.kind.slice('node.'.length) as WorkflowNodeStatus,
          fingerprint: record.fingerprint,
          attempt: record.attempt ?? nodes.get(record.nodeId)?.attempt ?? 0,
          ...(record.reason === undefined ? {} : { error: { code: `workflow.${record.kind.replace('node.', '')}`, message: record.reason } }),
          updatedAt: record.at,
          ...(record.kind === 'node.lost' ? { lostAt: record.at } : {}),
        });
        break;
      case 'checkpoint':
        if (checkpointIds.has(record.checkpointId)) break;
        checkpointIds.add(record.checkpointId);
        graphVersion = record.graphVersion;
        spent = record.spent;
        reserved = record.reserved;
        checkpoints.push(...record.nodes);
        for (const checkpoint of record.nodes) {
          const recovered = checkpoint.status === 'running' && options.recoverRunning !== false;
          nodes.set(checkpoint.nodeId, {
            ...checkpoint,
            ...(recovered ? { status: 'lost' as const, lostAt: options.lostAt ?? checkpoint.updatedAt } : {}),
          });
        }
        break;
    }
  }
  return {
    runId,
    started: options.started ?? false,
    terminal: options.terminal,
    lease: options.lease ?? { state: 'available', held: false },
    graphVersion,
    nodes,
    checkpoints,
    spent,
    reserved,
  };
}

export interface WorkflowDagJournalOptions {
  readonly runId: WorkflowRunId;
  readonly scope: string;
  readonly log: IAppendLogStore;
  readonly onError?: (error: unknown) => void;
}

export class WorkflowDagJournal {
  constructor(private readonly options: WorkflowDagJournalOptions) {}

  get runId(): WorkflowRunId { return this.options.runId; }

  acquire(key = 'journal.jsonl'): IDisposable { return this.options.log.acquire(this.options.scope, key); }

  acquireRunLease(): WorkflowRunLease {
    return acquireWorkflowRunLease(this.options.scope, this.runId);
  }

  writeNodePlanned(nodeId: WorkflowNodeId, fingerprint: string, provenance: WorkflowNodeProvenance, at: string): void {
    this.write({ kind: 'node.planned', runId: this.runId, nodeId, fingerprint, provenance, at });
  }

  writeNodeReady(nodeId: WorkflowNodeId, fingerprint: string, at: string): void {
    this.write({ kind: 'node.ready', runId: this.runId, nodeId, fingerprint, at });
  }

  writeNodeRunning(nodeId: WorkflowNodeId, fingerprint: string, attempt: number, at: string): void {
    this.write({ kind: 'node.running', runId: this.runId, nodeId, fingerprint, attempt, at });
  }

  writeNodeCompleted(nodeId: WorkflowNodeId, fingerprint: string, attempt: number, result: WorkflowNodeResult, at: string): void {
    this.write({ kind: 'node.completed', runId: this.runId, nodeId, fingerprint, attempt, result, at });
  }

  writeNodeFailed(nodeId: WorkflowNodeId, fingerprint: string, attempt: number, error: WorkflowNodeJournalRecordError, at: string, result?: WorkflowNodeResult): void {
    this.write({ kind: 'node.failed', runId: this.runId, nodeId, fingerprint, attempt, error, ...(result === undefined ? {} : { result }), at });
  }

  writeNodeSkipped(nodeId: WorkflowNodeId, fingerprint: string, at: string, reason?: string): void {
    this.write({ kind: 'node.skipped', runId: this.runId, nodeId, fingerprint, ...(reason === undefined ? {} : { reason }), at });
  }

  writeNodeBlocked(nodeId: WorkflowNodeId, fingerprint: string, at: string, reason?: string): void {
    this.write({ kind: 'node.blocked', runId: this.runId, nodeId, fingerprint, ...(reason === undefined ? {} : { reason }), at });
  }

  writeCheckpoint(checkpoint: Omit<Extract<WorkflowNodeJournalRecord, { readonly kind: 'checkpoint' }>, 'kind' | 'runId'>): void {
    this.write({ kind: 'checkpoint', runId: this.runId, ...checkpoint });
  }

  async readDagSummary(options?: FoldWorkflowJournalOptions): Promise<WorkflowDagJournalSummary> {
    const records: WorkflowNodeJournalRecord[] = [];
    let started = false;
    let terminal: WorkflowRunTerminal | undefined;
    for await (const record of this.options.log.read<unknown>(this.options.scope, 'journal.jsonl')) {
      if (isDagRecord(record)) {
        records.push(record);
      } else if (isNodeJournalEvent(record)) {
        throw new WorkflowJournalCorruptionError(`Unknown workflow DAG journal event "${String((record as { kind?: unknown }).kind)}".`);
      } else if (isWorkflowRunLifecycleEvent(record)) {
        if (record.kind === 'workflow.started') started = true;
        else if (terminal === undefined) terminal = terminalForLifecycleEvent(record);
      }
    }
    return foldWorkflowJournal(records, {
      ...options,
      started,
      ...(terminal === undefined ? {} : { terminal }),
      lease: workflowRunLeaseState(this.options.scope, this.runId),
    });
  }

  private write(record: WorkflowNodeJournalRecord): void {
    this.options.log.append(this.options.scope, 'journal.jsonl', record, { onError: this.options.onError });
  }
}

export type WorkflowNodeJournalRecordError = NonNullable<Extract<WorkflowNodeJournalRecord, { readonly kind: 'node.failed' }>['error']>;

export function assertWorkflowNodeJournalRecord(value: unknown): asserts value is WorkflowNodeJournalRecord {
  if (!isWorkflowNodeJournalRecord(value)) {
    const kind = isRecord(value) ? String(value['kind']) : typeof value;
    throw new WorkflowJournalCorruptionError(`Invalid workflow DAG journal event "${kind}".`);
  }
}

export function nodeProvenance(
  nodeId: WorkflowNodeId,
  fingerprint: string,
  provenance: WorkflowProvenance = { authoring: 'ir' },
): WorkflowNodeProvenance {
  return { ...provenance, nodeId, fingerprint };
}

function updateState(
  nodes: Map<WorkflowNodeId, WorkflowDagNodeState>,
  nodeId: WorkflowNodeId,
  patch: Partial<WorkflowDagNodeState>,
): void;
function updateState(nodes: Map<WorkflowNodeId, WorkflowDagNodeState>, state: WorkflowDagNodeState): void;
function updateState(
  nodes: Map<WorkflowNodeId, WorkflowDagNodeState>,
  nodeIdOrState: WorkflowNodeId | WorkflowDagNodeState,
  patch?: Partial<WorkflowDagNodeState>,
): void {
  const nodeId = typeof nodeIdOrState === 'string' ? nodeIdOrState : nodeIdOrState.nodeId;
  const current = nodes.get(nodeId);
  if (typeof nodeIdOrState !== 'string') {
    nodes.set(nodeId, nodeIdOrState);
    return;
  }
  if (current === undefined) {
    nodes.set(nodeId, {
      nodeId,
      status: patch?.status ?? 'planned',
      fingerprint: patch?.fingerprint ?? '',
      attempt: patch?.attempt ?? 0,
      updatedAt: patch?.updatedAt ?? '',
      ...patch,
    });
    return;
  }
  nodes.set(nodeId, { ...current, ...patch });
}

function isDagRecord(value: unknown): value is WorkflowNodeJournalRecord {
  return isWorkflowNodeJournalRecord(value);
}

function isWorkflowNodeJournalRecord(value: unknown): value is WorkflowNodeJournalRecord {
  if (!isRecord(value) || typeof value['kind'] !== 'string' || !WORKFLOW_NODE_JOURNAL_KINDS.has(value['kind'])) return false;
  if (typeof value['runId'] !== 'string' || typeof value['at'] !== 'string') return false;
  if (value['kind'] === 'checkpoint') {
    return typeof value['checkpointId'] === 'string' && typeof value['graphVersion'] === 'string' &&
      Array.isArray(value['nodes']) && typeof value['spent'] === 'number' && typeof value['reserved'] === 'number';
  }
  if (typeof value['nodeId'] !== 'string' || typeof value['fingerprint'] !== 'string') return false;
  switch (value['kind']) {
    case 'node.planned': return isRecord(value['provenance']);
    case 'node.ready':
    case 'node.skipped':
    case 'node.blocked':
    case 'node.lost': return value['attempt'] === undefined || typeof value['attempt'] === 'number';
    case 'node.running': return typeof value['attempt'] === 'number';
    case 'node.completed': return typeof value['attempt'] === 'number' && isRecord(value['result']);
    case 'node.failed': return typeof value['attempt'] === 'number' && isRecord(value['error']) &&
      (value['result'] === undefined || isRecord(value['result']));
  }
  return false;
}

function isNodeJournalEvent(value: unknown): boolean {
  return isRecord(value) && typeof value['kind'] === 'string' &&
    (value['kind'] === 'checkpoint' || value['kind'].startsWith('node.'));
}

type WorkflowRunLifecycleRecord =
  | { readonly kind: 'workflow.started'; readonly runId: string }
  | { readonly kind: 'workflow.completed'; readonly runId: string; readonly ok: boolean }
  | { readonly kind: 'workflow.failed'; readonly runId: string }
  | { readonly kind: 'workflow.cancelled'; readonly runId: string };

function isWorkflowRunLifecycleEvent(value: unknown): value is WorkflowRunLifecycleRecord {
  if (!isRecord(value) || typeof value['kind'] !== 'string' || typeof value['runId'] !== 'string') return false;
  switch (value['kind']) {
    case 'workflow.started': return true;
    case 'workflow.completed': return typeof value['ok'] === 'boolean';
    case 'workflow.failed':
    case 'workflow.cancelled': return true;
    default: return false;
  }
}

function terminalForLifecycleEvent(record: Exclude<WorkflowRunLifecycleRecord, { readonly kind: 'workflow.started' }>): WorkflowRunTerminal {
  if (record.kind === 'workflow.cancelled') return 'cancelled';
  if (record.kind === 'workflow.failed') return 'failed';
  return record.ok ? 'completed' : 'failed';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function terminalIdentity(record: Extract<WorkflowNodeJournalRecord, { readonly kind: 'node.completed' | 'node.failed' }>): string {
  return `${record.nodeId}:${String(record.attempt)}:${record.kind}`;
}

function isDuplicateTerminalEvent(
  terminalEvents: Map<string, string>,
  record: Extract<WorkflowNodeJournalRecord, { readonly kind: 'node.completed' | 'node.failed' }>,
): boolean {
  const identity = terminalIdentity(record);
  const content = canonicalWorkflowJson({
    kind: record.kind,
    nodeId: record.nodeId,
    fingerprint: record.fingerprint,
    attempt: record.attempt,
    ...(record.kind === 'node.completed'
      ? { result: record.result }
      : { error: record.error, ...(record.result === undefined ? {} : { result: record.result }) }),
  });
  const previous = terminalEvents.get(identity);
  if (previous === undefined) {
    terminalEvents.set(identity, content);
    return false;
  }
  if (previous !== content) {
    throw new WorkflowJournalCorruptionError(`Conflicting duplicate terminal event for node "${record.nodeId}" attempt ${String(record.attempt)}.`);
  }
  return true;
}

function usageTotal(usage: WorkflowNodeResult['usage'] | undefined): number {
  if (usage === undefined) return 0;
  return usage.inputOther + usage.output + usage.inputCacheRead + usage.inputCacheCreation;
}
