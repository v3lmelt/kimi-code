/**
 * `workflow.persist` — the run journal, the workflow engine's durability and
 * resume channel.
 *
 * A run's journal lives at `<sessionDir>/workflows/<runId>/journal.jsonl` (the
 * storage scope is `<sessionScope>/workflows/<runId>` with key `journal.jsonl`,
 * so `IAppendLogStore`'s scope/key → `<baseDir>/<scope>/<key>` mapping puts it
 * exactly there). It is an append-only JSONL stream recording, in order:
 *
 * - `workflow.started` — the full script with its `scriptSha256` pin, the meta
 *   (name/description/phases), args and the start timestamp;
 * - `phase.changed` / `agent.spawned` — phase transitions and spawns, so a
 *   resumed run can rebuild the phase cursor and the spawned-agent ledger;
 * - `agent.completed` — each completed subagent's agentId, ok flag and result
 *   (the `output`, or the validated structured output), duration, and error;
 * - `workflow.completed` — the terminal settlement (ok, result/error);
 * - `workflow.resume.reserved` / `.committed` / `.released` — the restartable
 *   source-to-destination resume claim state machine.
 *
 * `readJournal` folds the stream back into a `WorkflowJournalSummary` whose
 * `completedAgentIds` is exactly what resume consumes: the executor replays
 * completed agents as `kind: 'resume'` and skips re-running them. Run ids are
 * always `wf_<16 hex>` (see `generateWorkflowRunId` / `isWorkflowRunId`).
 *
 * Identity helpers live here too: `generateWorkflowRunId` mints a run id, and
 * `workflowScriptSha256` pins a script so a resume can verify the same script
 * is being re-run (a changed script invalidates the journal).
 */

import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { join } from 'pathe';

import { BugIndicatingError } from '#/errors';
import type { IDisposable } from '#/_base/di/lifecycle';
import type { IAppendLogStore } from '#/persistence/interface/appendLogStore';
import type {
  WorkflowNodeId,
  WorkflowNodeProvenance,
  WorkflowNodeResult,
  WorkflowPhaseMeta,
  WorkflowRunId,
  WorkflowRunStatus,
} from '#/agent/workflow/types';
import {
  type FoldWorkflowJournalOptions,
  type WorkflowNodeJournalRecord,
  type WorkflowNodeJournalRecordError,
  type WorkflowRunLease,
  type WorkflowRunLeaseState,
  type WorkflowRunTerminal,
  type WorkflowRunLeaseRecord,
  type WorkflowResumeClaimRecord,
  type WorkflowResumeClaimHandle,
  type WorkflowResumeClaimState,
  assertWorkflowNodeJournalRecord,
  foldWorkflowJournal,
  foldWorkflowRunLease,
  foldWorkflowResumeClaim,
  createWorkflowRunLease,
  isWorkflowResumeClaimExpired,
  workflowDestinationJournalScope,
  workflowResumeClaimExpiresAt,
  WorkflowRunAlreadyClaimedError,
  WorkflowRunAlreadyLeasedError,
  WorkflowJournalCorruptionError,
  type WorkflowDagJournalSummary,
} from './dagJournal';

/** Directory name (under the session dir) that hosts workflow run journals. */
export const WORKFLOWS_DIR = 'workflows' as const;
/** Append-log key holding the run journal. */
export const WORKFLOW_JOURNAL_KEY = 'journal.jsonl' as const;
/** The run-id prefix mandated by `WorkflowRunId` (`wf_${string}`). */
export const WORKFLOW_RUN_ID_PREFIX = 'wf_' as const;

const RUN_ID_BYTES = 8;

const VALID_RUN_ID: RegExp = /^wf_[a-f0-9]{16}$/;

/**
 * Mint a fresh workflow run id: `wf_` + 16 lowercase hex chars (8 bytes of
 * entropy). Collisions are negligible (64 bits of entropy); the shape is
 * validated by `isWorkflowRunId` wherever a run id is used as a path segment.
 */
export function generateWorkflowRunId(): WorkflowRunId {
  const bytes = randomBytes(RUN_ID_BYTES);
  let suffix = '';
  for (const byte of bytes) {
    suffix += byte.toString(16).padStart(2, '0');
  }
  return `${WORKFLOW_RUN_ID_PREFIX}${suffix}`;
}

/** Type guard for the `wf_<16 hex>` run-id shape. */
export function isWorkflowRunId(value: string): value is WorkflowRunId {
  return VALID_RUN_ID.test(value);
}

/** Hex sha256 of a workflow script source — the `scriptSha256` pin. */
export function workflowScriptSha256(script: string): string {
  return createHash('sha256').update(script, 'utf8').digest('hex');
}

/** On-disk directory of a run's journal: `<sessionDir>/workflows/<runId>`. */
export function workflowJournalDir(sessionDir: string, runId: WorkflowRunId): string {
  assertWorkflowRunId(runId);
  return join(sessionDir, WORKFLOWS_DIR, runId);
}

/** On-disk path of a run's journal file: `<sessionDir>/workflows/<runId>/journal.jsonl`. */
export function workflowJournalFile(sessionDir: string, runId: WorkflowRunId): string {
  return join(workflowJournalDir(sessionDir, runId), WORKFLOW_JOURNAL_KEY);
}

/** Storage scope of a run's journal: `<sessionScope>/workflows/<runId>`. */
export function workflowJournalScope(sessionScope: string, runId: WorkflowRunId): string {
  assertWorkflowRunId(runId);
  return `${sessionScope}/${WORKFLOWS_DIR}/${runId}`;
}

function assertWorkflowRunId(runId: WorkflowRunId): void {
  if (!VALID_RUN_ID.test(runId)) {
    throw new BugIndicatingError(`Invalid workflow run id: "${runId}"`);
  }
}

/** One line of the run journal (append-only, JSON-serializable). */
export type WorkflowJournalRecord =
  | {
      readonly kind: 'workflow.started';
      readonly runId: WorkflowRunId;
      readonly script: string;
      readonly scriptSha256: string;
      readonly name: string;
      readonly description: string;
      readonly phases?: readonly WorkflowPhaseMeta[];
      readonly args?: unknown;
      readonly startedAt: string;
    }
  | {
      readonly kind: 'phase.changed';
      readonly runId: WorkflowRunId;
      readonly phase: string;
      readonly at: string;
    }
  | {
      readonly kind: 'agent.spawned';
      readonly runId: WorkflowRunId;
      readonly agentId: string;
      readonly cacheKey?: string;
      readonly label?: string;
      readonly phase?: string;
      readonly at: string;
    }
  | {
      readonly kind: 'agent.completed';
      readonly runId: WorkflowRunId;
      readonly agentId: string;
      readonly cacheKey?: string;
      readonly ok: boolean;
      readonly result?: unknown;
      readonly error?: string;
      readonly durationMs: number;
      readonly at: string;
    }
  | {
      readonly kind: 'workflow.completed';
      readonly runId: WorkflowRunId;
      readonly ok: boolean;
      readonly result?: unknown;
      readonly error?: string;
      readonly completedAt: string;
    }
  | {
      readonly kind: 'workflow.failed';
      readonly runId: WorkflowRunId;
      readonly error?: string;
      readonly result?: unknown;
      readonly failedAt: string;
    }
  | {
      readonly kind: 'workflow.cancelled';
      readonly runId: WorkflowRunId;
      readonly reason?: string;
      readonly cancelledAt: string;
    }
  | WorkflowRunLeaseRecord
  | WorkflowResumeClaimRecord
  | WorkflowNodeJournalRecord;

/** Version prefix of the resume cache key; bump when the hashing contract changes. */
export const WORKFLOW_CACHE_KEY_VERSION = 'v1';

/**
 * The subset of `agent()` opts that changes what the subagent does. A cached
 * result is only replayable when every one of these matches; `label` and
 * `phase` are display metadata and deliberately excluded.
 */
export const WORKFLOW_CACHE_OPTS_FIELDS = [
  'schema',
  'model',
  'effort',
  'isolation',
  'agentType',
] as const;

/**
 * Deterministically serialize the effective part of an `agent()` opts object:
 * only `WORKFLOW_CACHE_OPTS_FIELDS`, with object keys sorted and `__proto__`
 * dropped (mirrors the hashing contract — two opts objects hash equal iff
 * their effective fields deep-equal).
 */
export function canonicalWorkflowOptsJson(opts: unknown): string {
  if (opts === null || opts === undefined || typeof opts !== 'object') return '{}';
  const source = opts as Record<string, unknown>;
  const picked: Record<string, unknown> = {};
  for (const field of WORKFLOW_CACHE_OPTS_FIELDS) {
    const value = source[field];
    if (value === undefined || typeof value === 'function') continue;
    picked[field] = value;
  }
  return JSON.stringify(canonicalize(picked));
}

function canonicalize(value: unknown): unknown {
  if (value === null || typeof value !== 'object') {
    return typeof value === 'function' ? undefined : value;
  }
  if (Array.isArray(value)) {
    return value.map((item) => canonicalize(item));
  }
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(value as Record<string, unknown>).sort()) {
    if (key === '__proto__') continue;
    out[key] = canonicalize((value as Record<string, unknown>)[key]);
  }
  return out;
}

/**
 * Compute the resume cache key of one `agent()` call:
 * `sha256(prompt \0 canonicalOptsJson)` with the version prefix. Two runs of
 * the same deterministic script produce the same sequence of keys, so a
 * resumed run replays exactly the unchanged `agent()` calls and re-runs the
 * edited ones — no matter where in the script the edit happened.
 */
export function workflowAgentCacheKey(prompt: string, opts: unknown): string {
  const digest = createHash('sha256')
    .update(prompt, 'utf8')
    .update('')
    .update(canonicalWorkflowOptsJson(opts), 'utf8')
    .digest('hex');
  return `${WORKFLOW_CACHE_KEY_VERSION}:${digest}`;
}

/** Payload for `writeWorkflowStarted`. */
export interface WorkflowJournalStarted {
  readonly script: string;
  readonly scriptSha256: string;
  readonly name: string;
  readonly description: string;
  readonly phases?: readonly WorkflowPhaseMeta[];
  readonly args?: unknown;
  readonly startedAt: string;
}

/** Payload for `writeAgentSpawned`. */
export interface WorkflowJournalAgentSpawn {
  readonly agentId: string;
  readonly cacheKey?: string;
  readonly label?: string;
  readonly phase?: string;
  readonly at: string;
}

/** Payload for `writeAgentCompleted`. */
export interface WorkflowJournalAgentCompletion {
  readonly agentId: string;
  readonly cacheKey?: string;
  readonly ok: boolean;
  readonly result?: unknown;
  readonly error?: string;
  readonly durationMs: number;
  readonly at: string;
}

/** Payload for `writeWorkflowCompleted`. */
export interface WorkflowJournalCompletion {
  readonly ok: boolean;
  readonly result?: unknown;
  readonly error?: string;
  readonly completedAt: string;
}

/**
 * One subagent as folded by `readJournal`. Completion fields are always
 * present on the returned object (`ok`/`durationMs`/`completedAt` are
 * `undefined` for a spawned-but-not-yet-completed agent), so consumers can
 * read `agent.ok === undefined` to mean "still running".
 */
export interface WorkflowJournalAgent {
  readonly agentId: string;
  readonly cacheKey?: string;
  readonly label?: string;
  readonly phase?: string;
  readonly spawnedAt: string;
  readonly ok?: boolean;
  readonly result?: unknown;
  readonly error?: string;
  readonly durationMs?: number;
  readonly completedAt?: string;
}

/**
 * The folded view of a run journal. `status` is derived (`running` until a
 * `workflow.completed` record settles it), `ok`/`result`/`error` come from the
 * terminal record, `phaseTransitions` preserves the order of `phase()` calls,
 * and `agents` preserves spawn order with completion folded in. `completedAgentIds`
 * is the resume contract: a resume replays those agents as `kind: 'resume'`.
 */
export interface WorkflowJournalSummary {
  readonly runId: WorkflowRunId;
  readonly script: string;
  readonly scriptSha256: string;
  readonly name: string;
  readonly description: string;
  readonly phases?: readonly WorkflowPhaseMeta[];
  readonly args?: unknown;
  readonly status: WorkflowRunStatus;
  readonly terminal: WorkflowRunTerminal | undefined;
  readonly lease: WorkflowRunLeaseState;
  readonly claimedBy?: WorkflowRunId;
  readonly resumeClaim?: WorkflowResumeClaimState;
  readonly startedAt: string;
  readonly completedAt?: string;
  readonly ok?: boolean;
  readonly result?: unknown;
  readonly error?: string;
  readonly phaseTransitions: readonly string[];
  readonly agents: readonly WorkflowJournalAgent[];
  readonly completedAgentIds: readonly string[];
  /**
   * Successful agent completions keyed by cache key (the newest record wins
   * on duplicates). This is the resume cache: a replayed `agent()` call with
   * an unchanged `(prompt, opts)` returns the cached result instantly.
   */
  readonly completedByCacheKey: ReadonlyMap<string, WorkflowJournalAgent>;
  readonly nodes: ReadonlyMap<WorkflowNodeId, import('./dagJournal').WorkflowDagNodeState>;
  readonly checkpoints: readonly import('./dagJournal').WorkflowNodeCheckpoint[];
  readonly graphVersion?: string;
  readonly spent: number;
  readonly reserved: number;
}

export type WorkflowJournalReadOptions = Pick<FoldWorkflowJournalOptions, 'recoverRunning' | 'lostAt'>;

/**
 * Fold the agent ledger into the cache-key → completion map used by resume.
 * Only successful (`ok === true`) completions with a cache key are replayable;
 * a failed `agent()` call re-runs on resume, and later records overwrite
 * earlier ones for the same key.
 */
export function foldCacheKeyResults(
  agents: readonly WorkflowJournalAgent[],
): ReadonlyMap<string, WorkflowJournalAgent> {
  const map = new Map<string, WorkflowJournalAgent>();
  for (const agent of agents) {
    if (agent.cacheKey === undefined || agent.ok !== true) continue;
    map.set(agent.cacheKey, agent);
  }
  return map;
}

export interface WorkflowJournalOptions {
  readonly runId: WorkflowRunId;
  /** Storage scope of the journal (see `workflowJournalScope`). */
  readonly scope: string;
  /** On-disk directory of the journal (see `workflowJournalDir`); informational. */
  readonly dir: string;
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

/**
 * Append-only run journal. Writes go through `IAppendLogStore` (fire-and-forget
 * appends that flush on microtask / `flush()`); reads fold the stream back into
 * a `WorkflowJournalSummary`. `acquire()` keeps the append-log buffer alive for
 * the journal's lifetime (mirroring how `WireService` acquires its own key) —
 * callers own the returned `IDisposable`.
 */
export class WorkflowJournal {
  constructor(private readonly options: WorkflowJournalOptions) {}

  get runId(): WorkflowRunId {
    return this.options.runId;
  }

  get scope(): string {
    return this.options.scope;
  }

  get dir(): string {
    return this.options.dir;
  }

  /** Keep the journal's append buffer alive until the caller disposes. */
  acquire(): IDisposable {
    return this.options.log.acquire(this.options.scope, WORKFLOW_JOURNAL_KEY);
  }

  /** Flush journal records before a lifecycle boundary is made durable. */
  async flush(): Promise<void> {
    await this.options.log.flush();
  }

  /** Reserve this run while it is being executed or used as a resume source. */
  async acquireRunLease(): Promise<WorkflowRunLease> {
    const lock = await this.takeLeaseLock();
    try {
      const leaseId = `workflow-lease-${randomUUID()}`;
      this.writeWorkflowLeaseAcquired(leaseId, new Date().toISOString());
      await this.options.log.flush();
      return this.createRunLease(leaseId, lock);
    } catch (error) {
      lock?.dispose();
      throw error;
    }
  }

  /** Acquire a run lease after checking the folded durable lease state. */
  private async acquireRunLeaseForResume(): Promise<WorkflowRunLease> {
    const lock = await this.takeLeaseLock();
    try {
      const existing = await this.readJournal({ recoverRunning: true, lostAt: new Date().toISOString() });
      if (existing?.lease.held && existing.lease.recoverable !== true) {
        throw new WorkflowRunAlreadyLeasedError(this.options.scope, this.options.runId, existing.lease.owner);
      }
      if (existing?.lease.held && existing.lease.owner !== undefined) {
        this.writeWorkflowLeaseReleased(existing.lease.owner, new Date().toISOString());
        await this.options.log.flush();
      }
      const leaseId = `workflow-lease-${randomUUID()}`;
      this.writeWorkflowLeaseAcquired(leaseId, new Date().toISOString());
      await this.options.log.flush();
      return this.createRunLease(leaseId, lock);
    } catch (error) {
      lock?.dispose();
      throw error;
    }
  }

  private async takeLeaseLock(): Promise<IDisposable | undefined> {
    if (this.options.allowMissingExclusiveLock === true) return undefined;
    if (this.options.log.acquireExclusive === undefined) {
      throw new Error(
        `Workflow journal ${this.options.scope}/${WORKFLOW_JOURNAL_KEY} requires an exclusive append-log lock.`,
      );
    }
    try {
      return await this.options.log.acquireExclusive(this.options.scope, WORKFLOW_JOURNAL_KEY);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (message.includes('cross-process append-log locks require a filesystem storage backend')) {
        throw error;
      }
      throw new WorkflowRunAlreadyLeasedError(this.options.scope, this.options.runId);
    }
  }

  /**
   * Atomically validate a terminal source run and reserve its resume claim.
   * The returned summary doubles as a handle: the destination commits after
   * its own `workflow.started` record is durable, or releases on registration
   * failure. The reservation itself is durable and restart-foldable.
   */
  async claimResume(
    claimedBy: WorkflowRunId,
    at = new Date().toISOString(),
  ): Promise<WorkflowJournalSummary & WorkflowResumeClaimHandle> {
    const journalHandle = this.acquire();
    let lease: WorkflowRunLease | undefined;
    try {
      lease = await this.acquireRunLeaseForResume();
      let summary = await this.readJournal({ recoverRunning: true, lostAt: at });
      if (summary === undefined) {
        throw new Error(`No workflow run "${this.runId}" was found to resume.`);
      }
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

  /** Record the run start, pinning the script by `scriptSha256`. */
  writeWorkflowStarted(started: WorkflowJournalStarted): void {
    this.write({
      kind: 'workflow.started',
      runId: this.options.runId,
      ...started,
    });
  }

  /** Record a `phase()` transition. */
  writePhaseChanged(phase: string, at: string): void {
    this.write({ kind: 'phase.changed', runId: this.options.runId, phase, at });
  }

  /** Record one subagent spawn. */
  writeAgentSpawned(spawn: WorkflowJournalAgentSpawn): void {
    this.write({ kind: 'agent.spawned', runId: this.options.runId, ...spawn });
  }

  /** Record one subagent completion (agentId, ok, result/error, duration). */
  writeAgentCompleted(completed: WorkflowJournalAgentCompletion): void {
    this.write({ kind: 'agent.completed', runId: this.options.runId, ...completed });
  }

  /** Record the terminal run settlement. */
  writeWorkflowCompleted(completed: WorkflowJournalCompletion): void {
    this.write({ kind: 'workflow.completed', runId: this.options.runId, ...completed });
  }

  writeWorkflowResumeClaim(claimedBy: WorkflowRunId, claimedAt: string): void {
    this.write({ kind: 'workflow.resume_claimed', runId: this.options.runId, claimedBy, claimedAt });
  }

  writeResumeClaim(claimedBy: WorkflowRunId, claimedAt: string): void {
    this.writeWorkflowResumeClaim(claimedBy, claimedAt);
  }

  private writeResumeReserved(claim: WorkflowResumeClaimState): void {
    this.write({
      kind: 'workflow.resume.reserved',
      runId: this.options.runId,
      claimedBy: claim.claimedBy,
      claimId: claim.claimId,
      reservedAt: claim.reservedAt ?? new Date().toISOString(),
      ...(claim.expiresAt === undefined ? {} : { expiresAt: claim.expiresAt }),
    });
  }

  private writeResumeCommitted(claim: WorkflowResumeClaimState, at: string): void {
    this.write({
      kind: 'workflow.resume.committed',
      runId: this.options.runId,
      claimedBy: claim.claimedBy,
      claimId: claim.claimId,
      committedAt: at,
    });
  }

  private writeResumeReleased(claim: WorkflowResumeClaimState, at: string): void {
    this.write({
      kind: 'workflow.resume.released',
      runId: this.options.runId,
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
      const summary = await this.readJournal();
      const current = summary?.resumeClaim;
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
      const at = new Date().toISOString();
      if (mutation === 'commit') this.writeResumeCommitted(current, at);
      else this.writeResumeReleased(current, at);
      await this.options.log.flush();
      return {
        ...current,
        state: mutation === 'commit' ? 'committed' : 'released',
        ...(mutation === 'commit' ? { committedAt: at } : { releasedAt: at }),
      };
    } finally {
      lock?.dispose();
    }
  }

  private createClaimHandle(
    summary: WorkflowJournalSummary,
    initial: WorkflowResumeClaimState,
  ): WorkflowJournalSummary & WorkflowResumeClaimHandle {
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
    } as WorkflowJournalSummary & WorkflowResumeClaimHandle;
    return handle;
  }

  private claimResultSummary(summary: WorkflowJournalSummary): WorkflowJournalSummary {
    return { ...summary, lease: { state: 'available', held: false } };
  }

  private async destinationStarted(destinationRunId: WorkflowRunId): Promise<boolean> {
    const scope = workflowDestinationJournalScope(this.options.scope, this.runId, destinationRunId);
    for await (const raw of this.options.log.read<unknown>(scope, WORKFLOW_JOURNAL_KEY)) {
      if (typeof raw === 'object' && raw !== null &&
        (raw as { kind?: unknown }).kind === 'workflow.started' &&
        (raw as { runId?: unknown }).runId === destinationRunId) return true;
    }
    return false;
  }

  writeNodePlanned(nodeId: WorkflowNodeId, fingerprint: string, provenance: WorkflowNodeProvenance, at: string): void {
    this.write({ kind: 'node.planned', runId: this.options.runId, nodeId, fingerprint, provenance, at });
  }

  writeNodeReady(nodeId: WorkflowNodeId, fingerprint: string, at: string): void {
    this.write({ kind: 'node.ready', runId: this.options.runId, nodeId, fingerprint, at });
  }

  writeNodeRunning(nodeId: WorkflowNodeId, fingerprint: string, attempt: number, at: string): void {
    this.write({ kind: 'node.running', runId: this.options.runId, nodeId, fingerprint, attempt, at });
  }

  writeNodeCompleted(nodeId: WorkflowNodeId, fingerprint: string, attempt: number, result: WorkflowNodeResult, at: string): void {
    this.write({ kind: 'node.completed', runId: this.options.runId, nodeId, fingerprint, attempt, result, at });
  }

  writeNodeFailed(nodeId: WorkflowNodeId, fingerprint: string, attempt: number, error: WorkflowNodeJournalRecordError, at: string, result?: WorkflowNodeResult): void {
    this.write({ kind: 'node.failed', runId: this.options.runId, nodeId, fingerprint, attempt, error, ...(result === undefined ? {} : { result }), at });
  }

  writeNodeSkipped(nodeId: WorkflowNodeId, fingerprint: string, at: string, reason?: string): void {
    this.write({ kind: 'node.skipped', runId: this.options.runId, nodeId, fingerprint, ...(reason === undefined ? {} : { reason }), at });
  }

  writeNodeBlocked(nodeId: WorkflowNodeId, fingerprint: string, at: string, reason?: string): void {
    this.write({ kind: 'node.blocked', runId: this.options.runId, nodeId, fingerprint, ...(reason === undefined ? {} : { reason }), at });
  }

  writeCheckpoint(checkpoint: Omit<Extract<WorkflowNodeJournalRecord, { readonly kind: 'checkpoint' }>, 'kind' | 'runId'>): void {
    this.write({ kind: 'checkpoint', runId: this.options.runId, ...checkpoint });
  }

  private writeWorkflowLeaseAcquired(leaseId: string, at: string): void {
    this.write({ kind: 'workflow.lease.acquired', runId: this.options.runId, leaseId, at });
  }

  private writeWorkflowLeaseReleased(leaseId: string, at: string): void {
    this.write({ kind: 'workflow.lease.released', runId: this.options.runId, leaseId, at });
  }

  private createRunLease(leaseId: string, lock: IDisposable | undefined): WorkflowRunLease {
    return createWorkflowRunLease(leaseId, {
      writeRelease: () => { this.writeWorkflowLeaseReleased(leaseId, new Date().toISOString()); },
      flush: () => this.options.log.flush(),
      lock,
      onError: this.options.onError,
    });
  }

  /**
   * Fold the journal back into a summary. Returns `undefined` when the run was
   * never started (no `workflow.started` record), which is how resume
   * distinguishes "no such run" from "run exists but is still running".
   */
  async readJournal(options: WorkflowJournalReadOptions = {}): Promise<WorkflowJournalSummary | undefined> {
    let started: Extract<WorkflowJournalRecord, { readonly kind: 'workflow.started' }> | undefined;
    let completed: Extract<WorkflowJournalRecord, { readonly kind: 'workflow.completed' }> | undefined;
    let terminal: WorkflowRunTerminal | undefined;
    const phaseTransitions: string[] = [];
    const agents = new Map<string, WorkflowJournalAgent>();
    const dagRecords: WorkflowNodeJournalRecord[] = [];
    const leaseRecords: WorkflowRunLeaseRecord[] = [];
    const claimRecords: WorkflowResumeClaimRecord[] = [];

    for await (const rawRecord of this.options.log.read<unknown>(
      this.options.scope,
      WORKFLOW_JOURNAL_KEY,
    )) {
      const record = assertWorkflowJournalRecord(rawRecord);
      switch (record.kind) {
        case 'workflow.started':
          started ??= record;
          break;
        case 'phase.changed':
          phaseTransitions.push(record.phase);
          break;
        case 'agent.spawned': {
          const existing = agents.get(record.agentId);
          agents.set(record.agentId, {
            agentId: record.agentId,
            ...(record.cacheKey === undefined
              ? existing?.cacheKey === undefined
                ? {}
                : { cacheKey: existing.cacheKey }
              : { cacheKey: record.cacheKey }),
            label: record.label ?? existing?.label,
            phase: record.phase ?? existing?.phase,
            spawnedAt: record.at,
            ok: existing?.ok,
            result: existing?.result,
            error: existing?.error,
            durationMs: existing?.durationMs,
            completedAt: existing?.completedAt,
          });
          break;
        }
        case 'agent.completed': {
          const existing = agents.get(record.agentId);
          agents.set(record.agentId, {
            agentId: record.agentId,
            ...(record.cacheKey === undefined
              ? existing?.cacheKey === undefined
                ? {}
                : { cacheKey: existing.cacheKey }
              : { cacheKey: record.cacheKey }),
            label: existing?.label,
            phase: existing?.phase,
            spawnedAt: existing?.spawnedAt ?? record.at,
            ok: record.ok,
            result: record.result,
            error: record.error,
            durationMs: record.durationMs,
            completedAt: record.at,
          });
          break;
        }
        case 'workflow.completed':
          completed ??= record;
          terminal ??= record.ok ? 'completed' : 'failed';
          break;
        case 'workflow.failed':
          terminal ??= 'failed';
          break;
        case 'workflow.cancelled':
          terminal ??= 'cancelled';
          break;
        case 'workflow.resume_claimed':
        case 'workflow.resume.reserved':
        case 'workflow.resume.committed':
        case 'workflow.resume.released':
          claimRecords.push(record);
          break;
        case 'workflow.lease.acquired':
        case 'workflow.lease.released':
          leaseRecords.push(record);
          break;
        case 'node.planned':
        case 'node.ready':
        case 'node.running':
        case 'node.completed':
        case 'node.failed':
        case 'node.skipped':
        case 'node.blocked':
        case 'node.lost':
        case 'checkpoint':
          assertWorkflowNodeJournalRecord(record);
          dagRecords.push(record);
          break;
      }
    }

    if (started === undefined) return undefined;

    const agentList = [...agents.values()];
    const dag: WorkflowDagJournalSummary = foldWorkflowJournal(dagRecords, {
      recoverRunning: options.recoverRunning ?? false,
      lostAt: options.lostAt,
    });
    return {
      runId: started.runId,
      script: started.script,
      scriptSha256: started.scriptSha256,
      name: started.name,
      description: started.description,
      ...(started.phases === undefined ? {} : { phases: started.phases }),
      ...(started.args === undefined ? {} : { args: started.args }),
      status: terminal === undefined ? 'running' : terminal === 'completed' ? 'completed' : 'failed',
      terminal,
      lease: foldWorkflowRunLease(leaseRecords, this.options.runId, terminal),
      ...resumeClaimFields(claimRecords, this.options.runId),
      startedAt: started.startedAt,
      ...(completed === undefined ? {} : { completedAt: completed.completedAt }),
      ...(completed === undefined
        ? {}
        : completed.ok
          ? { ok: true, ...(completed.result === undefined ? {} : { result: completed.result }) }
          : {
              ok: false,
              ...(completed.error === undefined ? {} : { error: completed.error }),
              ...(completed.result === undefined ? {} : { result: completed.result }),
            }),
      phaseTransitions,
      agents: agentList,
      completedAgentIds: agentList
        .filter((agent) => agent.ok !== undefined)
        .map((agent) => agent.agentId),
      completedByCacheKey: foldCacheKeyResults(agentList),
      nodes: dag.nodes,
      checkpoints: dag.checkpoints,
      ...(dag.graphVersion === undefined ? {} : { graphVersion: dag.graphVersion }),
      spent: dag.spent,
      reserved: dag.reserved,
    };
  }

  /** Append one record to the journal stream. */
  private write(record: WorkflowJournalRecord): void {
    this.options.log.append(this.options.scope, WORKFLOW_JOURNAL_KEY, record, {
      onError: this.options.onError,
    });
  }
}

export * from './dagJournal';

const WORKFLOW_JOURNAL_KINDS = new Set([
  'workflow.started',
  'phase.changed',
  'agent.spawned',
  'agent.completed',
  'workflow.completed',
  'workflow.failed',
  'workflow.cancelled',
  'workflow.lease.acquired',
  'workflow.lease.released',
  'workflow.resume_claimed',
  'workflow.resume.reserved',
  'workflow.resume.committed',
  'workflow.resume.released',
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

function assertWorkflowJournalRecord(value: unknown): WorkflowJournalRecord {
  if (typeof value !== 'object' || value === null ||
    typeof (value as { kind?: unknown }).kind !== 'string' ||
    !WORKFLOW_JOURNAL_KINDS.has((value as { kind: string }).kind)) {
    throw new WorkflowJournalCorruptionError('Unknown workflow journal event.');
  }
  const kind = (value as { kind: string }).kind;
  if (kind.startsWith('node.') || kind === 'checkpoint') {
    assertWorkflowNodeJournalRecord(value);
    return value;
  }
  if (kind === 'workflow.resume_claimed') {
    if (
      typeof (value as { runId?: unknown }).runId !== 'string' ||
      typeof (value as { claimedBy?: unknown }).claimedBy !== 'string' ||
      typeof (value as { claimedAt?: unknown }).claimedAt !== 'string'
    ) {
      throw new WorkflowJournalCorruptionError('Invalid workflow resume claim event.');
    }
  } else if (kind === 'workflow.lease.acquired' || kind === 'workflow.lease.released') {
    if (
      typeof (value as { runId?: unknown }).runId !== 'string' ||
      typeof (value as { leaseId?: unknown }).leaseId !== 'string' ||
      typeof (value as { at?: unknown }).at !== 'string'
    ) {
      throw new WorkflowJournalCorruptionError('Invalid workflow lease event.');
    }
  } else if (kind === 'workflow.resume.reserved') {
    if (
      typeof (value as { runId?: unknown }).runId !== 'string' ||
      typeof (value as { claimedBy?: unknown }).claimedBy !== 'string' ||
      typeof (value as { claimId?: unknown }).claimId !== 'string' ||
      typeof (value as { reservedAt?: unknown }).reservedAt !== 'string' ||
      ((value as { expiresAt?: unknown }).expiresAt !== undefined &&
        typeof (value as { expiresAt?: unknown }).expiresAt !== 'string')
    ) {
      throw new WorkflowJournalCorruptionError('Invalid workflow resume reservation event.');
    }
  } else if (kind === 'workflow.resume.committed') {
    if (
      typeof (value as { runId?: unknown }).runId !== 'string' ||
      typeof (value as { claimedBy?: unknown }).claimedBy !== 'string' ||
      typeof (value as { claimId?: unknown }).claimId !== 'string' ||
      typeof (value as { committedAt?: unknown }).committedAt !== 'string'
    ) {
      throw new WorkflowJournalCorruptionError('Invalid workflow resume commit event.');
    }
  } else if (kind === 'workflow.resume.released') {
    if (
      typeof (value as { runId?: unknown }).runId !== 'string' ||
      typeof (value as { claimedBy?: unknown }).claimedBy !== 'string' ||
      typeof (value as { claimId?: unknown }).claimId !== 'string' ||
      typeof (value as { releasedAt?: unknown }).releasedAt !== 'string'
    ) {
      throw new WorkflowJournalCorruptionError('Invalid workflow resume release event.');
    }
  }
  return value as WorkflowJournalRecord;
}
