/**
 * `workflow.persist` domain — append-only DAG node journal records and a
 * restart-safe fold for node state, checkpoints, lost running attempts, and
 * resume claim state.
 */

import type { IDisposable } from '#/_base/di/lifecycle';
import type { IAppendLogStore } from '#/persistence/interface/appendLogStore';
import { canonicalWorkflowJson } from '#/agent/workflow/ir/fingerprint';
import { randomUUID } from 'node:crypto';
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
  /** A terminal run with an unreleased legacy lease can be recovered safely. */
  readonly recoverable?: boolean;
  /** Diagnostic retained when a legacy terminal-held lease was observed. */
  readonly diagnostic?: 'terminal-held-lease';
}

export class WorkflowRunAlreadyLeasedError extends Error {
  readonly code = 'workflow.run_locked' as const;

  constructor(
    readonly scope: string,
    readonly runId: WorkflowRunId,
    readonly owner?: string,
  ) {
    super(
      owner === undefined
        ? `Workflow run "${runId}" is already leased for execution.`
        : `Workflow run "${runId}" is already leased for execution by lease "${owner}".`,
    );
    this.name = 'WorkflowRunAlreadyLeasedError';
  }
}

export class WorkflowRunAlreadyClaimedError extends Error {
  readonly code = 'workflow.resume_claimed' as const;

  constructor(
    readonly runId: WorkflowRunId,
    readonly claimedBy: WorkflowRunId,
  ) {
    super(`Workflow run "${runId}" has already been claimed for resume by run "${claimedBy}".`);
    this.name = 'WorkflowRunAlreadyClaimedError';
  }
}

export type WorkflowRunLeaseRecord =
  | {
      readonly kind: 'workflow.lease.acquired';
      readonly runId: WorkflowRunId;
      readonly leaseId: string;
      readonly at: string;
    }
  | {
      readonly kind: 'workflow.lease.released';
      readonly runId: WorkflowRunId;
      readonly leaseId: string;
      readonly at: string;
  };

export type WorkflowResumeClaimRecord =
  | {
      readonly kind: 'workflow.resume.reserved';
      readonly runId: WorkflowRunId;
      readonly claimedBy: WorkflowRunId;
      readonly claimId: string;
      readonly reservedAt: string;
      readonly expiresAt?: string;
    }
  | {
      readonly kind: 'workflow.resume.committed';
      readonly runId: WorkflowRunId;
      readonly claimedBy: WorkflowRunId;
      readonly claimId: string;
      readonly committedAt: string;
    }
  | {
      readonly kind: 'workflow.resume.released';
      readonly runId: WorkflowRunId;
      readonly claimedBy: WorkflowRunId;
      readonly claimId: string;
      readonly releasedAt: string;
    }
  /** Pre-state-machine records are durable commits for compatibility. */
  | {
      readonly kind: 'workflow.resume_claimed';
      readonly runId: WorkflowRunId;
      readonly claimedBy: WorkflowRunId;
      readonly claimedAt: string;
    };

export type WorkflowResumeClaimStatus = 'reserved' | 'committed' | 'released';

export interface WorkflowResumeClaimState {
  readonly state: WorkflowResumeClaimStatus;
  readonly runId: WorkflowRunId;
  readonly claimedBy: WorkflowRunId;
  readonly claimId: string;
  readonly reservedAt?: string;
  readonly expiresAt?: string;
  readonly committedAt?: string;
  readonly releasedAt?: string;
  /** True when the state came from the pre-state-machine event. */
  readonly legacy?: boolean;
}

export interface WorkflowResumeClaimHandle extends IDisposable {
  readonly sourceRunId: WorkflowRunId;
  readonly destinationRunId: WorkflowRunId;
  readonly claimId: string;
  readonly state: WorkflowResumeClaimStatus;
  readonly claim: WorkflowResumeClaimState;
  commit(): Promise<void>;
  release(): Promise<void>;
}

export interface WorkflowRunLease extends IDisposable {
  readonly leaseId: string;
  readonly state: 'held' | 'released';
  /** Persist the release while retaining the physical coordination lock. */
  release(): Promise<void>;
  /** Flush all journal writes and then release the physical coordination lock. */
  finalize(): Promise<void>;
}

export interface WorkflowRunLeaseOperations {
  readonly writeRelease: () => void;
  readonly flush: () => Promise<void>;
  readonly lock: IDisposable | undefined;
  readonly onError?: (error: unknown) => void;
}

export function createWorkflowRunLease(
  leaseId: string,
  operations: WorkflowRunLeaseOperations,
): WorkflowRunLease {
  let state: WorkflowRunLease['state'] = 'held';
  let releaseRecordWritten = false;
  let releaseAttempt: Promise<void> | undefined;
  let finalizeAttempt: Promise<void> | undefined;

  const release = (): Promise<void> => {
    if (state === 'released') return Promise.resolve();
    if (releaseAttempt !== undefined) return releaseAttempt;
    if (!releaseRecordWritten) {
      operations.writeRelease();
      releaseRecordWritten = true;
    }

    let attempt!: Promise<void>;
    attempt = Promise.resolve().then(async () => {
      try {
        await operations.flush();
        state = 'released';
      } catch (error) {
        if (releaseAttempt === attempt) releaseAttempt = undefined;
        throw error;
      }
      if (releaseAttempt === attempt) releaseAttempt = undefined;
    });
    releaseAttempt = attempt;
    return attempt;
  };

  const finalize = (): Promise<void> => {
    if (finalizeAttempt !== undefined) return finalizeAttempt;
    let attempt!: Promise<void>;
    attempt = Promise.resolve().then(async () => {
      await release();
      await operations.flush();
      operations.lock?.dispose();
    }).catch((error) => {
      if (finalizeAttempt === attempt) finalizeAttempt = undefined;
      throw error;
    });
    finalizeAttempt = attempt;
    return attempt;
  };

  return {
    leaseId,
    get state() { return state; },
    release,
    finalize,
    dispose: () => { void finalize().catch((error) => operations.onError?.(error)); },
  };
}

export function foldWorkflowRunLease(
  records: readonly WorkflowRunLeaseRecord[],
  runId: WorkflowRunId,
  terminal?: WorkflowRunTerminal,
): WorkflowRunLeaseState {
  let owner: string | undefined;
  for (const record of records) {
    if (record.runId !== runId) continue;
    if (record.kind === 'workflow.lease.acquired') {
      owner = record.leaseId;
    } else if (owner === record.leaseId) {
      owner = undefined;
    }
  }
  if (owner !== undefined && terminal !== undefined) {
    return {
      state: 'held',
      held: true,
      owner,
      recoverable: true,
      diagnostic: 'terminal-held-lease',
    };
  }
  return owner === undefined
    ? { state: 'available', held: false }
    : { state: 'held', held: true, owner };
}

/** Fold resume-claim records without relying on process-local state. */
export function foldWorkflowResumeClaim(
  records: readonly WorkflowResumeClaimRecord[],
  runId: WorkflowRunId,
): WorkflowResumeClaimState | undefined {
  let state: WorkflowResumeClaimState | undefined;
  for (const record of records) {
    if (record.runId !== runId) continue;
    if (record.kind === 'workflow.resume_claimed') {
      if (state === undefined) {
        state = {
          state: 'committed',
          runId,
          claimedBy: record.claimedBy,
          claimId: `legacy:${record.claimedBy}`,
          committedAt: record.claimedAt,
          legacy: true,
        };
      } else if (state.claimedBy !== record.claimedBy && state.state !== 'released') {
        throw new WorkflowJournalCorruptionError(
          `Conflicting workflow resume claims for run "${runId}".`,
        );
      }
      continue;
    }
    if (record.kind === 'workflow.resume.reserved') {
      if (state?.state === 'committed') {
        if (state.claimedBy !== record.claimedBy) {
          throw new WorkflowRunAlreadyClaimedError(runId, state.claimedBy);
        }
        continue;
      }
      if (state?.state === 'reserved') {
        if (state.claimId === record.claimId && state.claimedBy === record.claimedBy) continue;
        throw new WorkflowJournalCorruptionError(
          `Conflicting workflow resume reservations for run "${runId}".`,
        );
      }
      state = {
        state: 'reserved',
        runId,
        claimedBy: record.claimedBy,
        claimId: record.claimId,
        reservedAt: record.reservedAt,
        ...(record.expiresAt === undefined ? {} : { expiresAt: record.expiresAt }),
      };
      continue;
    }
    if (record.kind === 'workflow.resume.committed') {
      if (state === undefined) {
        state = {
          state: 'committed',
          runId,
          claimedBy: record.claimedBy,
          claimId: record.claimId,
          committedAt: record.committedAt,
        };
      } else if (state.state === 'reserved') {
        if (state.claimId !== record.claimId || state.claimedBy !== record.claimedBy) {
          throw new WorkflowJournalCorruptionError(
            `Resume commit does not match reservation for run "${runId}".`,
          );
        }
        state = {
          ...state,
          state: 'committed',
          committedAt: record.committedAt,
        };
      } else if (state.state === 'committed') {
        if (state.claimedBy !== record.claimedBy || state.claimId !== record.claimId) {
          throw new WorkflowRunAlreadyClaimedError(runId, state.claimedBy);
        }
      }
      continue;
    }
    if (state?.state === 'reserved') {
      if (state.claimId !== record.claimId || state.claimedBy !== record.claimedBy) {
        throw new WorkflowJournalCorruptionError(
          `Resume release does not match reservation for run "${runId}".`,
        );
      }
      state = { ...state, state: 'released', releasedAt: record.releasedAt };
    }
    // A release after commit is deliberately ignored: commit is permanent.
  }
  return state;
}

/** A reservation remains valid until explicitly released or its expiry. */
export const WORKFLOW_RESUME_CLAIM_TTL_MS = 5 * 60 * 1000;

export function workflowResumeClaimExpiresAt(reservedAt: string): string {
  const timestamp = Date.parse(reservedAt);
  if (!Number.isFinite(timestamp)) return reservedAt;
  return new Date(timestamp + WORKFLOW_RESUME_CLAIM_TTL_MS).toISOString();
}

export function isWorkflowResumeClaimExpired(claim: WorkflowResumeClaimState, now: string): boolean {
  return claim.expiresAt !== undefined && Date.parse(claim.expiresAt) <= Date.parse(now);
}

export function workflowDestinationJournalScope(sourceScope: string, sourceRunId: WorkflowRunId, destinationRunId: WorkflowRunId): string {
  const suffix = `/workflows/${sourceRunId}`;
  const parent = sourceScope.endsWith(suffix)
    ? sourceScope.slice(0, -suffix.length)
    : sourceScope;
  return `${parent}/workflows/${destinationRunId}`;
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
  readonly claimedBy?: WorkflowRunId;
  readonly resumeClaim?: WorkflowResumeClaimState;
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
  readonly claimedBy?: WorkflowRunId;
  readonly resumeClaim?: WorkflowResumeClaimState;
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
    ...(options.claimedBy === undefined ? {} : { claimedBy: options.claimedBy }),
    ...(options.resumeClaim === undefined ? {} : { resumeClaim: options.resumeClaim }),
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
  /**
   * Test-only escape hatch for stores that intentionally have no physical
   * cross-process lock. Production journals must leave this disabled so a
   * missing coordination primitive is surfaced instead of becoming a
   * process-local best effort.
   */
  readonly allowMissingExclusiveLock?: boolean;
}

export class WorkflowDagJournal {
  constructor(private readonly options: WorkflowDagJournalOptions) {}

  get runId(): WorkflowRunId { return this.options.runId; }

  acquire(key = 'journal.jsonl'): IDisposable { return this.options.log.acquire(this.options.scope, key); }

  async flush(): Promise<void> { await this.options.log.flush(); }

  async acquireRunLease(): Promise<WorkflowRunLease> {
    const lock = await this.takeLeaseLock();
    try {
      const leaseId = `workflow-lease-${randomUUID()}`;
      this.writeLeaseAcquired(leaseId, new Date().toISOString());
      await this.options.log.flush();
      return this.createLease(leaseId, lock);
    } catch (error) {
      lock?.dispose();
      throw error;
    }
  }

  private async acquireRunLeaseForResume(): Promise<WorkflowRunLease> {
    const lock = await this.takeLeaseLock();
    try {
      const existing = await this.readDagSummary();
      if (existing.lease.held && existing.lease.recoverable !== true) {
        throw new WorkflowRunAlreadyLeasedError(this.options.scope, this.runId, existing.lease.owner);
      }
      if (existing.lease.held && existing.lease.owner !== undefined) {
        this.writeLeaseReleased(existing.lease.owner, new Date().toISOString());
        await this.options.log.flush();
      }
      const leaseId = `workflow-lease-${randomUUID()}`;
      this.writeLeaseAcquired(leaseId, new Date().toISOString());
      await this.options.log.flush();
      return this.createLease(leaseId, lock);
    } catch (error) {
      lock?.dispose();
      throw error;
    }
  }

  private async takeLeaseLock(): Promise<IDisposable | undefined> {
    if (this.options.allowMissingExclusiveLock === true) return undefined;
    if (this.options.log.acquireExclusive === undefined) {
      throw new Error(
        `Workflow DAG journal ${this.options.scope}/journal.jsonl requires an exclusive append-log lock.`,
      );
    }
    try {
      return await this.options.log.acquireExclusive(this.options.scope, 'journal.jsonl');
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (message.includes('cross-process append-log locks require a filesystem storage backend')) {
        throw error;
      }
      throw new WorkflowRunAlreadyLeasedError(this.options.scope, this.runId);
    }
  }

  async claimResume(
    claimedBy: WorkflowRunId,
    at = new Date().toISOString(),
  ): Promise<WorkflowDagJournalSummary & WorkflowResumeClaimHandle> {
    const journalHandle = this.acquire();
    let lease: WorkflowRunLease | undefined;
    try {
      lease = await this.acquireRunLeaseForResume();
      let summary = await this.readDagSummary();
      if (summary.terminal === undefined) {
        throw new Error(`Workflow run "${this.runId}" is still running and cannot be resumed.`);
      }
      let claim = summary.resumeClaim;
      if (claim?.state === 'committed') {
        if (claim.claimedBy !== claimedBy) {
          throw new WorkflowRunAlreadyClaimedError(this.runId, claim.claimedBy);
        }
        return this.createClaimHandle(this.claimResultSummary(summary), claim);
      }
      if (claim?.state === 'reserved') {
        const destinationStarted = await this.destinationStarted(claim.claimedBy);
        if (destinationStarted) {
          if (claim.claimedBy !== claimedBy) {
            this.writeResumeCommitted(claim, at);
            await this.options.log.flush();
            throw new WorkflowRunAlreadyClaimedError(this.runId, claim.claimedBy);
          }
          this.writeResumeCommitted(claim, at);
          await this.options.log.flush();
          claim = { ...claim, state: 'committed', committedAt: at };
          summary = { ...summary, claimedBy, resumeClaim: claim };
          return this.createClaimHandle(this.claimResultSummary(summary), claim);
        }
        if (claim.claimedBy === claimedBy) {
          if (isWorkflowResumeClaimExpired(claim, at)) {
            this.writeResumeReleased(claim, at);
            await this.options.log.flush();
            claim = undefined;
          } else {
            return this.createClaimHandle(this.claimResultSummary(summary), claim);
          }
        }
        if (claim?.state === 'reserved' && !isWorkflowResumeClaimExpired(claim, at)) {
          throw new WorkflowRunAlreadyClaimedError(this.runId, claim.claimedBy);
        }
        if (claim?.state === 'reserved') {
          this.writeResumeReleased(claim, at);
          await this.options.log.flush();
          claim = undefined;
        }
      }
      if (claim?.state === 'released') claim = undefined;
      const nextClaim: WorkflowResumeClaimState = {
        state: 'reserved',
        runId: this.runId,
        claimedBy,
        claimId: `workflow-resume-${randomUUID()}`,
        reservedAt: at,
        expiresAt: workflowResumeClaimExpiresAt(at),
      };
      this.writeResumeReserved(nextClaim);
      await this.options.log.flush();
      summary = { ...summary, claimedBy, resumeClaim: nextClaim };
      return this.createClaimHandle(this.claimResultSummary(summary), nextClaim);
    } finally {
      try {
        if (lease !== undefined) await lease.finalize();
      } finally {
        journalHandle.dispose();
      }
    }
  }

  writeResumeClaim(claimedBy: WorkflowRunId, at: string): void {
    this.write({ kind: 'workflow.resume_claimed', runId: this.runId, claimedBy, claimedAt: at });
  }

  private writeResumeReserved(claim: WorkflowResumeClaimState): void {
    this.write({
      kind: 'workflow.resume.reserved',
      runId: this.runId,
      claimedBy: claim.claimedBy,
      claimId: claim.claimId,
      reservedAt: claim.reservedAt ?? new Date().toISOString(),
      ...(claim.expiresAt === undefined ? {} : { expiresAt: claim.expiresAt }),
    });
  }

  private writeResumeCommitted(claim: WorkflowResumeClaimState, at: string): void {
    this.write({
      kind: 'workflow.resume.committed',
      runId: this.runId,
      claimedBy: claim.claimedBy,
      claimId: claim.claimId,
      committedAt: at,
    });
  }

  private writeResumeReleased(claim: WorkflowResumeClaimState, at: string): void {
    this.write({
      kind: 'workflow.resume.released',
      runId: this.runId,
      claimedBy: claim.claimedBy,
      claimId: claim.claimId,
      releasedAt: at,
    });
  }

  private async mutateClaim(
    claim: WorkflowResumeClaimState,
    mutation: 'commit' | 'release',
  ): Promise<WorkflowResumeClaimState> {
    const lock = await this.takeLeaseLock();
    try {
      const summary = await this.readDagSummary();
      const current = summary.resumeClaim;
      if (current?.state === 'committed') {
        if (current.claimedBy !== claim.claimedBy) {
          throw new WorkflowRunAlreadyClaimedError(this.runId, current.claimedBy);
        }
        return current;
      }
      if (current?.state !== 'reserved' || current.claimId !== claim.claimId || current.claimedBy !== claim.claimedBy) {
        if (current?.state === 'released') return current;
        throw new WorkflowRunAlreadyClaimedError(this.runId, current?.claimedBy ?? claim.claimedBy);
      }
      if (mutation === 'commit') this.writeResumeCommitted(current, new Date().toISOString());
      else this.writeResumeReleased(current, new Date().toISOString());
      await this.options.log.flush();
      return {
        ...current,
        state: mutation === 'commit' ? 'committed' : 'released',
        ...(mutation === 'commit'
          ? { committedAt: new Date().toISOString() }
          : { releasedAt: new Date().toISOString() }),
      };
    } finally {
      lock?.dispose();
    }
  }

  private createClaimHandle(
    summary: WorkflowDagJournalSummary,
    initial: WorkflowResumeClaimState,
  ): WorkflowDagJournalSummary & WorkflowResumeClaimHandle {
    let current = initial;
    let operation: Promise<void> | undefined;
    const run = async (mutation: 'commit' | 'release'): Promise<void> => {
      const previous = operation ?? Promise.resolve();
      operation = previous.catch(() => undefined).then(async () => {
        if (current.state === 'committed' || current.state === 'released') return;
        current = await this.mutateClaim(current, mutation);
      });
      await operation;
    };
    const handle = {
      ...summary,
      sourceRunId: this.runId,
      destinationRunId: initial.claimedBy,
      claimId: initial.claimId,
      get state() { return current.state; },
      get claim() { return current; },
      get claimedBy() { return current.state === 'released' ? undefined : current.claimedBy; },
      get resumeClaim() { return current; },
      commit: () => run('commit'),
      release: () => run('release'),
      dispose: () => { void run('release').catch((error) => this.options.onError?.(error)); },
    } as WorkflowDagJournalSummary & WorkflowResumeClaimHandle;
    return handle;
  }

  private claimResultSummary(summary: WorkflowDagJournalSummary): WorkflowDagJournalSummary {
    return { ...summary, lease: { state: 'available', held: false } };
  }

  private async destinationStarted(destinationRunId: WorkflowRunId): Promise<boolean> {
    const scope = workflowDestinationJournalScope(this.options.scope, this.runId, destinationRunId);
    for await (const raw of this.options.log.read<unknown>(scope, 'journal.jsonl')) {
      if (isRecord(raw) && raw['kind'] === 'workflow.started' && raw['runId'] === destinationRunId) return true;
    }
    return false;
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

  private writeLeaseAcquired(leaseId: string, at: string): void {
    this.write({ kind: 'workflow.lease.acquired', runId: this.runId, leaseId, at });
  }

  private writeLeaseReleased(leaseId: string, at: string): void {
    this.write({ kind: 'workflow.lease.released', runId: this.runId, leaseId, at });
  }

  private createLease(leaseId: string, lock: IDisposable | undefined): WorkflowRunLease {
    return createWorkflowRunLease(leaseId, {
      writeRelease: () => { this.writeLeaseReleased(leaseId, new Date().toISOString()); },
      flush: () => this.options.log.flush(),
      lock,
      onError: this.options.onError,
    });
  }

  async readDagSummary(options?: FoldWorkflowJournalOptions): Promise<WorkflowDagJournalSummary> {
    const records: WorkflowNodeJournalRecord[] = [];
    const leaseRecords: WorkflowRunLeaseRecord[] = [];
    let started = false;
    let terminal: WorkflowRunTerminal | undefined;
    const claimRecords: WorkflowResumeClaimRecord[] = [];
    for await (const record of this.options.log.read<unknown>(this.options.scope, 'journal.jsonl')) {
      if (isDagRecord(record)) {
        records.push(record);
      } else if (isNodeJournalEvent(record)) {
        throw new WorkflowJournalCorruptionError(`Unknown workflow DAG journal event "${String((record as { kind?: unknown }).kind)}".`);
      } else if (isWorkflowRunLifecycleEvent(record)) {
        if (record.kind === 'workflow.started') started = true;
        else if (isWorkflowResumeClaimRecord(record)) {
          claimRecords.push(record);
        } else if (isWorkflowRunTerminalEvent(record) && terminal === undefined) {
          terminal = terminalForLifecycleEvent(record);
        } else if (isWorkflowRunLeaseRecord(record)) {
          leaseRecords.push(record);
        }
      }
    }
    return foldWorkflowJournal(records, {
      ...options,
      started,
      ...(terminal === undefined ? {} : { terminal }),
      lease: foldWorkflowRunLease(leaseRecords, this.runId, terminal),
      ...resumeClaimFields(claimRecords, this.runId),
    });
  }

  private write(record: WorkflowNodeJournalRecord | WorkflowRunLeaseRecord | WorkflowResumeClaimRecord): void {
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
  | { readonly kind: 'workflow.cancelled'; readonly runId: string }
  | WorkflowResumeClaimRecord
  | WorkflowRunLeaseRecord;

function isWorkflowResumeClaimRecord(record: WorkflowRunLifecycleRecord): record is WorkflowResumeClaimRecord {
  return record.kind === 'workflow.resume_claimed' ||
    record.kind === 'workflow.resume.reserved' ||
    record.kind === 'workflow.resume.committed' ||
    record.kind === 'workflow.resume.released';
}

function resumeClaimFields(
  records: readonly WorkflowResumeClaimRecord[],
  runId: WorkflowRunId,
): { readonly claimedBy?: WorkflowRunId; readonly resumeClaim?: WorkflowResumeClaimState } {
  const resumeClaim = foldWorkflowResumeClaim(records, runId);
  if (resumeClaim === undefined) return {};
  return resumeClaim.state === 'released'
    ? { resumeClaim }
    : { claimedBy: resumeClaim.claimedBy, resumeClaim };
}

function isWorkflowRunLifecycleEvent(value: unknown): value is WorkflowRunLifecycleRecord {
  if (!isRecord(value) || typeof value['kind'] !== 'string' || typeof value['runId'] !== 'string') return false;
  switch (value['kind']) {
    case 'workflow.started': return true;
    case 'workflow.completed': return typeof value['ok'] === 'boolean';
    case 'workflow.failed':
    case 'workflow.cancelled': return true;
    case 'workflow.resume_claimed':
      return typeof value['claimedBy'] === 'string' && typeof value['claimedAt'] === 'string';
    case 'workflow.resume.reserved':
      return typeof value['claimedBy'] === 'string' && typeof value['claimId'] === 'string' &&
        typeof value['reservedAt'] === 'string' &&
        (value['expiresAt'] === undefined || typeof value['expiresAt'] === 'string');
    case 'workflow.resume.committed':
      return typeof value['claimedBy'] === 'string' && typeof value['claimId'] === 'string' &&
        typeof value['committedAt'] === 'string';
    case 'workflow.resume.released':
      return typeof value['claimedBy'] === 'string' && typeof value['claimId'] === 'string' &&
        typeof value['releasedAt'] === 'string';
    case 'workflow.lease.acquired':
    case 'workflow.lease.released':
      return typeof value['leaseId'] === 'string' && typeof value['at'] === 'string';
    default: return false;
  }
}

function isWorkflowRunTerminalEvent(
  record: WorkflowRunLifecycleRecord,
): record is Exclude<WorkflowRunLifecycleRecord, { readonly kind: 'workflow.started' | 'workflow.resume_claimed' | 'workflow.resume.reserved' | 'workflow.resume.committed' | 'workflow.resume.released' | 'workflow.lease.acquired' | 'workflow.lease.released' }> {
  return record.kind === 'workflow.completed' || record.kind === 'workflow.failed' || record.kind === 'workflow.cancelled';
}

function isWorkflowRunLeaseRecord(record: WorkflowRunLifecycleRecord): record is WorkflowRunLeaseRecord {
  return record.kind === 'workflow.lease.acquired' || record.kind === 'workflow.lease.released';
}

function terminalForLifecycleEvent(
  record: Exclude<WorkflowRunLifecycleRecord, { readonly kind: 'workflow.started' | 'workflow.resume_claimed' | 'workflow.resume.reserved' | 'workflow.resume.committed' | 'workflow.resume.released' | 'workflow.lease.acquired' | 'workflow.lease.released' }>,
): WorkflowRunTerminal {
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
