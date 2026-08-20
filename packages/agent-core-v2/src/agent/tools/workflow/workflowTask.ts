/**
 * `tools` domain — `WorkflowTask`, the background-task embodiment of a
 * workflow run.
 *
 * Wraps a workflow execution as an `AgentTask` so the run registers in the
 * owning agent's task store and — being detached — fires the standard terminal
 * `<task-notification>` the model consumes (`AgentTaskService` delivers it via
 * `TaskNotificationStepRequest`). `start(sink)` drives the real run: it writes
 * the run journal (`workflow.started` … `workflow.completed`), dispatches the
 * five progress Ops (`workflow.started` / `workflow.phase_changed` /
 * `workflow.agent_spawned` / `workflow.agent_completed` / `workflow.completed`),
 * runs the script through the `WorkflowRuntime` sandbox with an
 * `AgentRunPool`, spawns real subagents through `spawnWorkflowAgent`, and
 * settles the task with the run summary as its output.
 *
 * Resume: when constructed with a `WorkflowResumeLedger` (built from a prior
 * run's journal via `readJournal().completedByCacheKey`), every `agent()`
 * call is keyed by `sha256(prompt, effectiveOpts)` and replayed from the
 * ledger when the key matches — unchanged calls return their cached results
 * instantly no matter where they sit in the script; the first edited or new
 * call and everything cache-missing after it runs live. Because scripts are
 * deterministic, the same script produces the same key sequence (a 100%
 * cache hit); editing the script only invalidates the calls whose prompt or
 * effective opts actually changed.
 */

import type { ILogService } from '#/_base/log/log';
import type { IWireService } from '#/wire/wire';
import type {
  AgentTask,
  AgentTaskInfoBase,
  AgentTaskSink,
} from '#/agent/task/types';
import {
  WorkflowJournal,
  workflowAgentCacheKey,
  type WorkflowJournalAgent,
} from '#/agent/workflow/persist/journal';
import {
  workflowAgentSpawned,
  workflowAgentCompleted,
  workflowCompleted,
  workflowLog,
  workflowPhaseChanged,
  workflowStarted,
  type WorkflowTelemetryHook,
} from '#/agent/workflow/progress/workflowProgress';
import { AgentRunPool } from '#/agent/workflow/runtime/agentPool';
import {
  WorkflowRuntime,
  type WorkflowAgentSpawnResult,
  type WorkflowRunOutput,
} from '#/agent/workflow/runtime/workflowRuntime';
import type {
  WorkflowAgentOpts,
  WorkflowAgentResult,
  WorkflowBudget,
  WorkflowPhaseMeta,
  WorkflowRunId,
  WorkflowScriptMeta,
} from '#/agent/workflow/types';
import type { TokenUsage } from '#/kosong/contract/usage';
import { grandTotal } from '#/kosong/contract/usage';

import {
  spawnWorkflowAgent,
  type WorkflowSpawnHostDeps,
} from './spawnHost';

/** A cached completed subagent from a prior run, keyed by cache key. */
export interface WorkflowResumeLedger {
  readonly sourceRunId: WorkflowRunId;
  /**
   * Successful prior completions keyed by `workflowAgentCacheKey(prompt,
   * opts)`. A replayed `agent()` call whose key hits the map returns the
   * cached result instantly; a miss (edited prompt/opts) re-runs live.
   */
  readonly completedByCacheKey: ReadonlyMap<string, WorkflowJournalAgent>;
}

/** Display facts a workflow task carries onto its task record. */
export interface WorkflowTaskInfo extends AgentTaskInfoBase {
  readonly kind: 'workflow';
  readonly runId: WorkflowRunId;
  readonly workflowName: string;
  readonly scriptSha256: string;
}

declare module '#/agent/task/types' {
  interface AgentTaskInfoByKind {
    readonly workflow: WorkflowTaskInfo;
  }
}

/** Options for constructing a `WorkflowTask`. */
export interface WorkflowTaskOptions {
  readonly runId: WorkflowRunId;
  readonly script: string;
  readonly scriptSha256: string;
  readonly name: string;
  readonly description: string;
  readonly phases?: readonly WorkflowPhaseMeta[];
  readonly phaseTitles?: ReadonlySet<string>;
  readonly args?: unknown;
  readonly meta: WorkflowScriptMeta;
  readonly tokenBudgetTotal: number;
  readonly journal: WorkflowJournal;
  readonly wire: IWireService;
  readonly telemetry: WorkflowTelemetryHook;
  readonly log: ILogService;
  readonly spawnDeps: WorkflowSpawnHostDeps;
  readonly parentToolCallId: string;
  readonly resume?: WorkflowResumeLedger;
  /**
   * Optional live budget source (REAL main-loop accounting). Forwarded to the
   * runtime so the sandbox `budget` global reads the host's token target and
   * the agent's actual consumption.
   */
  readonly budget?: WorkflowBudget;
  /**
   * Called with each subagent's usage so the host budget accounting can fold
   * subagent spend into its own `spent()`.
   */
  readonly onSubagentUsage?: (usage: TokenUsage) => void;
}

/**
 * The background-task embodiment of one workflow run. Bound to the run's
 * identity, script, journal and spawn host; `start()` runs it to completion.
 */
export class WorkflowTask implements AgentTask {
  readonly kind = 'workflow' as const;
  readonly idPrefix = 'wf' as const;
  readonly description: string;
  readonly runId: WorkflowRunId;
  readonly workflowName: string;
  readonly scriptSha256: string;

  private readonly script: string;
  private readonly name: string;
  private readonly phases: readonly WorkflowPhaseMeta[] | undefined;
  private readonly phaseTitles: ReadonlySet<string> | undefined;
  private readonly args: unknown;
  private readonly meta: WorkflowScriptMeta;
  private readonly tokenBudgetTotal: number;
  private readonly journal: WorkflowJournal;
  private readonly wire: IWireService;
  private readonly telemetry: WorkflowTelemetryHook;
  private readonly log: ILogService;
  private readonly spawnDeps: WorkflowSpawnHostDeps;
  private readonly parentToolCallId: string;
  private readonly resume: WorkflowResumeLedger | undefined;
  private readonly budget: WorkflowBudget | undefined;
  private readonly onSubagentUsage: ((usage: TokenUsage) => void) | undefined;

  constructor(options: WorkflowTaskOptions) {
    this.runId = options.runId;
    this.script = options.script;
    this.scriptSha256 = options.scriptSha256;
    this.name = options.name;
    this.description = options.description;
    this.phases = options.phases;
    this.phaseTitles = options.phaseTitles ?? new Set(options.meta.phases?.map((phase) => phase.title) ?? []);
    this.args = options.args;
    this.meta = options.meta;
    this.tokenBudgetTotal = options.tokenBudgetTotal;
    this.journal = options.journal;
    this.wire = options.wire;
    this.telemetry = options.telemetry;
    this.log = options.log;
    this.spawnDeps = options.spawnDeps;
    this.parentToolCallId = options.parentToolCallId;
    this.resume = options.resume;
    this.budget = options.budget;
    this.onSubagentUsage = options.onSubagentUsage;
    this.workflowName = options.name;
  }

  async start(sink: AgentTaskSink): Promise<void> {
    const controller = new AbortController();
    const requestAbort = (): void => {
      controller.abort(sink.signal.reason);
    };
    if (sink.signal.aborted) {
      requestAbort();
    } else {
      sink.signal.addEventListener('abort', requestAbort, { once: true });
    }
    const runStartedMs = Date.now();

    try {
      const startedAt = isoNow();
      this.journal.writeWorkflowStarted({
        script: this.script,
        scriptSha256: this.scriptSha256,
        name: this.name,
        description: this.description,
        ...(this.phases === undefined ? {} : { phases: this.phases }),
        ...(this.args === undefined ? {} : { args: this.args }),
        startedAt,
      });
      this.wire.dispatch(workflowStarted({ runId: this.runId, meta: this.meta, startedAt }));
      this.telemetry.launched(this.runId, this.meta);

      const resume = this.resume;
      const pool = new AgentRunPool({ signal: controller.signal });
      const runtime = new WorkflowRuntime({
        source: this.script,
        args: this.args,
        signal: controller.signal,
        tokenBudgetTotal: this.tokenBudgetTotal,
        budget: this.budget,
        onSubagentUsage: this.onSubagentUsage,
        agentSpawn: (prompt, opts, runtimeSignal) =>
          this.agentSpawn(prompt, opts, runtimeSignal ?? controller.signal, resume),
        pool,
        onPhaseChanged: (title) => {
          if (this.phaseTitles?.has(title) !== true) {
            throw new Error(`Workflow phase "${title}" is not declared in meta.phases.`);
          }
          this.journal.writePhaseChanged(title, isoNow());
          this.wire.dispatch(workflowPhaseChanged({ runId: this.runId, phase: title }));
        },
        onLog: (parts) => {
          const message = parts.map(stringifyPart).join(' ');
          this.log.info('workflow', { runId: this.runId, log: message });
          this.wire.dispatch(workflowLog({ runId: this.runId, message }));
        },
      });

      try {
        const output = await runtime.run();
        const summary = formatWorkflowRunSummary(this.runId, this.name, output, this.journal.dir);
        sink.appendOutput(summary);
        this.journal.writeWorkflowCompleted({
          ok: true,
          ...(output.result === undefined ? {} : { result: output.result }),
          completedAt: isoNow(),
        });
        this.wire.dispatch(workflowCompleted({
          runId: this.runId,
          ok: true,
          ...(output.result === undefined ? {} : { result: output.result }),
          agentsSpawned: output.agentsSpawned,
          tokensSpent: output.tokensSpent,
          durationMs: Date.now() - runStartedMs,
        }));
        this.telemetry.completed(this.runId, true);
        await sink.settle({ status: 'completed' });
      } catch (error) {
        const message = errorMessage(error);
        sink.appendOutput(
          [
            `Workflow failed: ${this.name} (${this.runId})`,
            'status: failed',
            '',
            `error: ${message}`,
            '',
            '<recovery>',
            `To resume after fixing the script, call Workflow again with resumeFromRunId: "${this.runId}" — ` +
              'completed agent() calls with unchanged (prompt, opts) replay from cache; only edited or new calls re-run.',
            `Run journal: ${this.journal.dir}/journal.jsonl — one record per agent with its actual return value.`,
            '</recovery>',
          ].join('\n'),
        );
        this.journal.writeWorkflowCompleted({
          ok: false,
          ...(message === undefined ? {} : { error: message }),
          completedAt: isoNow(),
        });
        this.wire.dispatch(workflowCompleted({
          runId: this.runId,
          ok: false,
          ...(message === undefined ? {} : { error: message }),
          durationMs: Date.now() - runStartedMs,
        }));
        this.telemetry.completed(this.runId, false, message);
        await sink.settle({ status: 'failed', stopReason: message });
      }
    } finally {
      sink.signal.removeEventListener('abort', requestAbort);
    }
  }

  toInfo(base: AgentTaskInfoBase): WorkflowTaskInfo {
    return {
      ...base,
      kind: 'workflow',
      runId: this.runId,
      workflowName: this.workflowName,
      scriptSha256: this.scriptSha256,
    };
  }

  /**
   * One `agent()` call: compute the call's cache key from `(prompt, opts)` and
   * replay the prior run's cached result when the key hits the resume ledger —
   * unchanged `agent()` calls return instantly no matter where in the script
   * they sit (the prior positional replay could only skip a leading prefix).
   * A cache miss spawns a real subagent. The spawn is journaled and broadcast
   * the moment the child agent exists (`onSpawned`), so progress consumers see
   * the agent as running for the whole turn instead of only learning about it
   * on completion. Spawn failures resolve to a failed
   * `WorkflowAgentSpawnResult` rather than rejecting, so a single bad spawn
   * does not abort the run; when the spawn was already reported, a failed
   * completion is recorded for the same agentId to close the ledger entry.
   */
  private async agentSpawn(
    prompt: string,
    opts: WorkflowAgentOpts | undefined,
    signal: AbortSignal,
    resume: WorkflowResumeLedger | undefined,
  ): Promise<WorkflowAgentSpawnResult> {
    const effectiveOpts = this.effectiveAgentOpts(opts);
    this.assertAgentOpts(effectiveOpts);
    const cacheKey = workflowAgentCacheKey(prompt, effectiveOpts);
    const prior = resume?.completedByCacheKey.get(cacheKey);
    if (prior !== undefined) {
      return this.replayResumedAgent(prior, cacheKey, effectiveOpts);
    }

    const startedAt = Date.now();
    let spawnedAgentId: string | undefined;
    try {
      const result = await spawnWorkflowAgent(
        this.spawnDeps,
        prompt,
        effectiveOpts,
        signal,
        this.parentToolCallId,
        {
          onSpawned: (agentId) => {
            spawnedAgentId = agentId;
            this.recordAgentSpawn(agentId, cacheKey, effectiveOpts);
          },
        },
      );
      const durationMs = Date.now() - startedAt;
      this.recordAgentCompletion(result, cacheKey, durationMs, {
        ...(result.model === undefined ? {} : { model: result.model }),
        ...(result.usage === undefined ? {} : { tokens: grandTotal(result.usage) }),
      });
      return {
        ok: result.ok,
        agentId: result.agentId,
        output: result.output,
        durationMs,
        ...(result.usage === undefined ? {} : { usage: result.usage }),
        ...(result.error === undefined ? {} : { error: result.error }),
      };
    } catch (error) {
      const message = errorMessage(error);
      const usage = errorTokenUsage(error);
      this.log.warn('workflow subagent spawn failed', { runId: this.runId, error });
      const durationMs = Date.now() - startedAt;
      if (spawnedAgentId !== undefined) {
        // The spawn already went out over the wire and the journal; close the
        // ledger entry so consumers do not keep showing a running agent.
        this.recordAgentCompletion(
          { ok: false, agentId: spawnedAgentId, output: null, error: message, durationMs },
          cacheKey,
          durationMs,
          usage === undefined ? undefined : { tokens: grandTotal(usage) },
        );
        return {
          ok: false,
          agentId: spawnedAgentId,
          output: null,
          error: message,
          durationMs,
          ...(usage === undefined ? {} : { usage }),
        };
      }
      return {
        ok: false,
        agentId: WORKFLOW_UNKNOWN_AGENT_ID,
        output: null,
        error: message,
        durationMs,
        ...(usage === undefined ? {} : { usage }),
      };
    }
  }

  private effectiveAgentOpts(opts: WorkflowAgentOpts | undefined): WorkflowAgentOpts | undefined {
    if (this.meta.model === undefined || opts?.model !== undefined) return opts;
    return { ...(opts ?? {}), model: this.meta.model };
  }

  private assertAgentOpts(opts: WorkflowAgentOpts | undefined): void {
    if (opts?.isolation === 'worktree') {
      throw new Error('Workflow agent isolation "worktree" is not available in this runtime.');
    }
    if (opts?.phase === undefined) return;
    if (this.phaseTitles?.has(opts.phase) !== true) {
      throw new Error(`Workflow agent phase "${opts.phase}" is not declared in meta.phases.`);
    }
  }

  /** Replay one cached completion into this run's journal + progress. */
  private replayResumedAgent(
    prior: WorkflowJournalAgent,
    cacheKey: string,
    opts: WorkflowAgentOpts | undefined,
  ): WorkflowAgentSpawnResult {
    const agentId = prior.agentId;
    const ok = prior.ok ?? true;
    const durationMs = prior.durationMs ?? 0;
    this.journal.writeAgentSpawned({
      agentId,
      cacheKey,
      ...(opts?.label === undefined ? {} : { label: opts.label }),
      ...(opts?.phase === undefined ? {} : { phase: opts.phase }),
      at: isoNow(),
    });
    this.journal.writeAgentCompleted({
      agentId,
      cacheKey,
      ok,
      ...(prior.result === undefined ? {} : { result: prior.result }),
      ...(prior.error === undefined ? {} : { error: prior.error }),
      durationMs,
      at: isoNow(),
    });
    this.wire.dispatch(workflowAgentSpawned({
      runId: this.runId,
      agentId,
      ...(opts?.label === undefined ? {} : { label: opts.label }),
      ...(opts?.phase === undefined ? {} : { phase: opts.phase }),
    }));
    this.wire.dispatch(workflowAgentCompleted({ runId: this.runId, agentId, ok, durationMs }));
    return {
      ok,
      agentId,
      output: prior.result ?? null,
      ...(prior.error === undefined ? {} : { error: prior.error }),
      durationMs,
    };
  }

  private recordAgentSpawn(
    agentId: string,
    cacheKey: string,
    opts: WorkflowAgentOpts | undefined,
  ): void {
    this.journal.writeAgentSpawned({
      agentId,
      cacheKey,
      ...(opts?.label === undefined ? {} : { label: opts.label }),
      ...(opts?.phase === undefined ? {} : { phase: opts.phase }),
      at: isoNow(),
    });
    this.wire.dispatch(workflowAgentSpawned({
      runId: this.runId,
      agentId,
      ...(opts?.label === undefined ? {} : { label: opts.label }),
      ...(opts?.phase === undefined ? {} : { phase: opts.phase }),
    }));
  }

  private recordAgentCompletion(
    result: WorkflowAgentResult,
    cacheKey: string,
    durationMs: number,
    extras?: { readonly model?: string; readonly tokens?: number },
  ): void {
    this.journal.writeAgentCompleted({
      agentId: result.agentId,
      cacheKey,
      ok: result.ok,
      ...(result.output === null || result.output === undefined ? {} : { result: result.output }),
      ...(result.error === undefined ? {} : { error: result.error }),
      durationMs,
      at: isoNow(),
    });
    this.wire.dispatch(workflowAgentCompleted({
      runId: this.runId,
      agentId: result.agentId,
      ok: result.ok,
      durationMs,
      ...(extras?.model === undefined ? {} : { model: extras.model }),
      ...(extras?.tokens === undefined ? {} : { tokens: extras.tokens }),
      ...(result.ok
        ? (() => {
            const summary = outputSummaryPreview(result.output);
            return summary === undefined ? {} : { summary };
          })()
        : {}),
    }));
  }
}

export const WORKFLOW_UNKNOWN_AGENT_ID = 'wf-unknown';

function formatWorkflowRunSummary(
  runId: WorkflowRunId,
  name: string,
  output: WorkflowRunOutput,
  journalDir: string,
): string {
  return [
    `Workflow completed: ${name} (${runId})`,
    'status: completed',
    `agents_spawned: ${String(output.agentsSpawned)}`,
    `tokens_spent: ${String(output.tokensSpent)}`,
    '',
    '[result]',
    stringifyResult(output.result),
    '',
    '[diagnostics]',
    `Run journal: ${journalDir}/journal.jsonl — one record per agent with its actual return value. ` +
      'If the result above is empty or unexpected, read the journal BEFORE diagnosing; do not assume agents returned non-empty results.',
  ].join('\n');
}

function stringifyResult(value: unknown): string {
  if (value === undefined || value === null) return 'null';
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function stringifyPart(value: unknown): string {
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

/** Cap (chars) of the one-line agent output preview on progress events. */
export const WORKFLOW_SUMMARY_PREVIEW_MAX = 80;

/**
 * One-line preview of an agent's output for the `workflow.agent_completed`
 * progress event: strings collapse whitespace; structured outputs are not
 * serialized (they belong in the journal, not the live tree).
 */
export function outputSummaryPreview(output: unknown): string | undefined {
  if (typeof output !== 'string') return undefined;
  const collapsed = output.trim().split(/\s+/).join(' ');
  if (collapsed.length === 0) return undefined;
  return collapsed.length <= WORKFLOW_SUMMARY_PREVIEW_MAX
    ? collapsed
    : `${collapsed.slice(0, WORKFLOW_SUMMARY_PREVIEW_MAX - 1)}…`;
}

function errorMessage(error: unknown): string | undefined {
  if (error === undefined || error === null) return undefined;
  if (error instanceof Error) return error.message;
  return String(error);
}

function errorTokenUsage(error: unknown): TokenUsage | undefined {
  if (typeof error !== 'object' || error === null) return undefined;
  const usage = (error as { readonly usage?: unknown }).usage;
  if (typeof usage !== 'object' || usage === null) return undefined;
  const value = usage as Partial<TokenUsage>;
  if (
    typeof value.inputOther !== 'number' ||
    typeof value.output !== 'number' ||
    typeof value.inputCacheRead !== 'number' ||
    typeof value.inputCacheCreation !== 'number'
  ) {
    return undefined;
  }
  return {
    inputOther: value.inputOther,
    output: value.output,
    inputCacheRead: value.inputCacheRead,
    inputCacheCreation: value.inputCacheCreation,
  };
}

function isoNow(): string {
  return new Date().toISOString();
}
