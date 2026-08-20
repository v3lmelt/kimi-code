/**
 * `workflow.runtime` domain — the isolated Workflow host executor.
 *
 * Compiles a workflow on the host, then runs it in a fresh Worker containing
 * its own `node:vm` context. The Worker receives only structured-cloneable
 * data. Host capabilities are proxy call handles backed by structured RPC, so
 * no host realm function or process object is placed in the sandbox. The host
 * watchdog terminates the Worker when its heartbeat stops, covering a sync
 * loop entered after an `await`; cancellation uses the same hard termination.
 */

import fs from 'node:fs';
import { Worker } from 'node:worker_threads';
import type { Program } from 'acorn';

import { grandTotal, type TokenUsage } from '#/kosong/contract/usage';
import { linkAbortSignal } from '#/_base/utils/abort';

import { compileWorkflowScript } from '../compile/index';
import type { WorkflowAgentOpts, WorkflowBudget, WorkflowSandboxGlobals, WorkflowScriptMeta } from '../types';

import {
  AgentRunPool,
  WorkflowItemCapExceededError,
} from './agentPool';
import { WORKFLOW_DEFAULT_TIMEOUT_MS, WORKFLOW_SANDBOX_PRELUDE } from './sandboxHardening';
import {
  WORKFLOW_WORKER_PROTOCOL_VERSION,
  type WorkflowWorkerAgentResult,
  type WorkflowWorkerControlMessage,
  type WorkflowWorkerData,
  type WorkflowWorkerErrorPayload,
  type WorkflowWorkerMessage,
} from './workflowWorkerProtocol';

export const WORKFLOW_SANDBOX_FILENAME = 'workflow.js';
export const WORKFLOW_DEFAULT_AGENT_CAP = 1000;

export class WorkflowRunError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WorkflowRunError';
  }
}

export class WorkflowAgentCapExceededError extends WorkflowRunError {
  constructor(readonly cap: number) {
    super(`Workflow agent budget ceiling exceeded: no more than ${String(cap)} agents may be spawned per workflow run.`);
    this.name = 'WorkflowAgentCapExceededError';
  }
}

export class WorkflowNestingExceededError extends WorkflowRunError {
  constructor() {
    super('workflow() may only be nested one level deep.');
    this.name = 'WorkflowNestingExceededError';
  }
}

export class WorkflowBudgetExceededError extends WorkflowRunError {
  constructor(readonly spent: number, readonly total: number) {
    super(
      `Workflow token budget exceeded (${spent.toLocaleString()} / ${total.toLocaleString()} tokens). ` +
        `Stopping further agent() calls. In-flight agents will complete; their results are preserved.`,
    );
    this.name = 'WorkflowBudgetExceededError';
  }
}

export class WorkflowRunCancelledError extends WorkflowRunError {
  constructor() {
    super('Workflow run was cancelled.');
    this.name = 'WorkflowRunCancelledError';
  }
}

export class WorkflowTimeoutError extends WorkflowRunError {
  constructor(readonly timeoutMs: number) {
    super(`Workflow execution timed out after ${String(timeoutMs)}ms.`);
    this.name = 'WorkflowTimeoutError';
  }
}

export interface WorkflowAgentSpawnResult {
  readonly ok: boolean;
  readonly agentId: string;
  readonly output: unknown;
  readonly error?: string;
  readonly durationMs: number;
  readonly usage?: TokenUsage;
}

export interface WorkflowRuntimeOptions {
  readonly source: string;
  readonly args?: unknown;
  readonly signal?: AbortSignal;
  readonly tokenBudgetTotal: number;
  readonly budget?: WorkflowBudget;
  readonly agentSpawn: (
    prompt: string,
    opts: WorkflowAgentOpts | undefined,
    signal?: AbortSignal,
  ) => Promise<WorkflowAgentSpawnResult>;
  readonly pool: AgentRunPool;
  readonly onPhaseChanged?: (title: string) => void;
  readonly onLog?: (parts: readonly unknown[]) => void;
  readonly onSubagentUsage?: (usage: TokenUsage) => void;
  readonly agentCap?: number;
  readonly timeoutMs?: number;
}

export interface WorkflowRunOutput {
  readonly result: unknown;
  readonly meta: WorkflowScriptMeta;
  readonly agentsSpawned: number;
  readonly tokensSpent: number;
}

export class WorkflowRuntime {
  private spentTokens = 0;
  private agentsSpawned = 0;
  private readonly source: string;
  private readonly args: unknown;
  private readonly signal: AbortSignal | undefined;
  private readonly tokenBudgetTotal: number;
  private readonly externalBudget: WorkflowRuntimeOptions['budget'];
  private readonly agentSpawn: WorkflowRuntimeOptions['agentSpawn'];
  private readonly pool: AgentRunPool;
  private readonly onPhaseChanged?: (title: string) => void;
  private readonly onLog?: (parts: readonly unknown[]) => void;
  private readonly onSubagentUsage?: (usage: TokenUsage) => void;
  private readonly agentCap: number;
  private readonly timeoutMs: number;

  constructor(options: WorkflowRuntimeOptions) {
    this.source = options.source;
    this.args = options.args;
    this.signal = options.signal;
    this.tokenBudgetTotal = options.tokenBudgetTotal;
    this.externalBudget = options.budget;
    this.agentSpawn = options.agentSpawn;
    this.pool = options.pool;
    this.onPhaseChanged = options.onPhaseChanged;
    this.onLog = options.onLog;
    this.onSubagentUsage = options.onSubagentUsage;
    this.agentCap = options.agentCap ?? WORKFLOW_DEFAULT_AGENT_CAP;
    this.timeoutMs = Math.max(1, options.timeoutMs ?? WORKFLOW_DEFAULT_TIMEOUT_MS);
  }

  async run(): Promise<WorkflowRunOutput> {
    if (this.signal?.aborted) throw new WorkflowRunCancelledError();
    const compiled = compileWorkflowScript(this.source);
    if ('error' in compiled) throw compiled.error;
    const wrappedSource = buildWrappedSource(compiled.source, compiled.ast);
    let args: unknown;
    try {
      args = structuredClone(this.args);
    } catch (error) {
      throw new WorkflowRunError(
        `Workflow args must be structured-cloneable: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    const budgetTotal = this.externalBudget?.total ?? this.tokenBudgetTotal;
    const initialBudgetSpent = this.externalBudget?.spent() ?? this.spentTokens;
    const poolConfig = this.pool.runtimeConfig();
    const workerData: WorkflowWorkerData = {
      protocolVersion: WORKFLOW_WORKER_PROTOCOL_VERSION,
      wrappedSource,
      args,
      sandboxPrelude: WORKFLOW_SANDBOX_PRELUDE,
      tokenBudgetTotal: budgetTotal,
      initialBudgetSpent,
      agentCap: this.agentCap,
      maxItemsPerFanOut: poolConfig.maxItemsPerFanOut,
      maxConcurrency: poolConfig.maxConcurrency,
      timeoutMs: this.timeoutMs,
    };
    return this.runInWorker(workerData, compiled.meta);
  }

  private runInWorker(data: WorkflowWorkerData, meta: WorkflowScriptMeta): Promise<WorkflowRunOutput> {
    const entry = resolveWorkerEntry();
    let worker: Worker;
    try {
      worker = new Worker(entry.url, {
        workerData: data,
        execArgv: entry.source
          ? ['--experimental-transform-types', '--disable-warning=ExperimentalWarning']
          : [],
      });
    } catch (error) {
      throw new WorkflowRunError(
        `Unable to start the workflow Worker: ${error instanceof Error ? error.message : String(error)}`,
      );
    }

    return new Promise<WorkflowRunOutput>((resolve, reject) => {
      let settled = false;
      let watchdog: ReturnType<typeof setTimeout> | null = null;
      let ownerAbort: (() => void) | null = null;
      const runController = new AbortController();
      const unlinkRunAbort = this.signal === undefined ? undefined : linkAbortSignal(this.signal, runController);
      const inFlightHostCalls = new Map<number, {
        readonly controller: AbortController;
        readonly unlink: () => void;
      }>();
      const inFlightHostHandlers = new Set<Promise<void>>();
      const abortInFlight = (reason: unknown): void => {
        if (!runController.signal.aborted) runController.abort(reason);
        for (const call of inFlightHostCalls.values()) call.controller.abort(reason);
        this.pool.abort(reason);
      };
      const waitForCleanup = async (reason: unknown): Promise<void> => {
        abortInFlight(reason);
        while (inFlightHostHandlers.size > 0) {
          await Promise.allSettled([...inFlightHostHandlers]);
        }
        await this.pool.waitForIdle();
      };
      const resetWatchdog = (): void => {
        if (watchdog !== null) clearTimeout(watchdog);
        watchdog = setTimeout(() => {
          void finishError(new WorkflowTimeoutError(this.timeoutMs));
        }, this.timeoutMs + Math.max(10, Math.min(100, Math.floor(this.timeoutMs / 4))));
      };
      const cleanup = (): void => {
        if (watchdog !== null) clearTimeout(watchdog);
        watchdog = null;
        if (ownerAbort !== null && this.signal !== undefined) this.signal.removeEventListener('abort', ownerAbort);
        unlinkRunAbort?.();
        worker.off('message', onMessage);
        worker.off('error', onError);
        worker.off('exit', onExit);
      };
      const finish = async (value: WorkflowRunOutput): Promise<void> => {
        if (settled) return;
        settled = true;
        cleanup();
        await waitForCleanup(new WorkflowRunCancelledError());
        await worker.terminate().catch(() => undefined);
        resolve(value);
      };
      const finishError = async (error: unknown): Promise<void> => {
        if (settled) return;
        settled = true;
        cleanup();
        await waitForCleanup(error);
        await worker.terminate().catch(() => undefined);
        reject(error);
      };
      const sendControl = (message: WorkflowWorkerControlMessage): void => {
        if (settled) return;
        try {
          worker.postMessage(message);
        } catch (error) {
          void finishError(error);
        }
      };
      const handleAgent = async (message: Extract<WorkflowWorkerMessage, { type: 'agent' }>): Promise<void> => {
        if (settled) return;
        const rpcController = new AbortController();
        const unlinkRpcAbort = linkAbortSignal(runController.signal, rpcController);
        inFlightHostCalls.set(message.id, { controller: rpcController, unlink: unlinkRpcAbort });
        let hostCallReleased = false;
        const releaseHostCall = (): void => {
          if (hostCallReleased) return;
          hostCallReleased = true;
          inFlightHostCalls.delete(message.id);
          unlinkRpcAbort();
        };
        try {
          if (this.agentsSpawned >= this.agentCap) {
            sendControl({ type: 'agentResult', id: message.id, ok: false, error: errorPayload(new WorkflowAgentCapExceededError(this.agentCap)) });
            return;
          }
          const budgetTotal = this.externalBudget?.total ?? this.tokenBudgetTotal;
          const spent = this.externalBudget?.spent() ?? this.spentTokens;
          if (budgetTotal > 0 && spent >= budgetTotal) {
            sendControl({ type: 'agentResult', id: message.id, ok: false, error: errorPayload(new WorkflowBudgetExceededError(spent, budgetTotal)) });
            return;
          }
          this.agentsSpawned += 1;
          const outcome = await this.agentSpawn(message.prompt, message.opts, rpcController.signal);
          releaseHostCall();
          if (settled || rpcController.signal.aborted) return;
          if (outcome.usage !== undefined) {
            this.spentTokens += grandTotal(outcome.usage);
            this.onSubagentUsage?.(outcome.usage);
          }
          const result: WorkflowWorkerAgentResult = {
            ok: outcome.ok,
            agentId: outcome.agentId,
            output: outcome.output,
            durationMs: outcome.durationMs,
            ...(outcome.error === undefined ? {} : { error: outcome.error }),
            ...(outcome.usage === undefined ? {} : { usage: outcome.usage }),
          };
          const budgetSpent = this.externalBudget?.spent() ?? this.spentTokens;
          let cloned: WorkflowWorkerAgentResult;
          try {
            cloned = structuredClone(result);
          } catch {
            cloned = { ok: false, agentId: outcome.agentId, output: null, error: 'Workflow agent result is not structured-cloneable.', durationMs: outcome.durationMs };
          }
          sendControl({ type: 'agentResult', id: message.id, ok: true, result: cloned, budgetSpent });
        } catch (error) {
          releaseHostCall();
          if (settled) return;
          sendControl({ type: 'agentResult', id: message.id, ok: false, error: errorPayload(error) });
        } finally {
          releaseHostCall();
        }
      };
      const trackHostHandler = (handler: Promise<void>): void => {
        inFlightHostHandlers.add(handler);
        void handler.then(
          () => inFlightHostHandlers.delete(handler),
          () => inFlightHostHandlers.delete(handler),
        );
      };
      const onMessage = (message: WorkflowWorkerMessage): void => {
        if (message.type === 'ready') {
          resetWatchdog();
          return;
        }
        if (message.type === 'heartbeat') {
          resetWatchdog();
          if (this.externalBudget !== undefined) sendControl({ type: 'budgetUpdate', spent: this.externalBudget.spent() });
          return;
        }
        if (message.type === 'agent') {
          trackHostHandler(handleAgent(message));
          return;
        }
        if (message.type === 'phase') {
          try {
            this.onPhaseChanged?.(typeof message.title === 'string' ? message.title : String(message.title));
          } catch (error) {
            void finishError(error);
          }
          return;
        }
        if (message.type === 'log') {
          try {
            this.onLog?.(message.parts);
          } catch (error) {
            void finishError(error);
          }
          return;
        }
        if (message.type === 'done') {
          void finish({ result: message.result, meta, agentsSpawned: this.agentsSpawned, tokensSpent: this.spentTokens });
          return;
        }
        if (message.type === 'error') void finishError(errorFromPayload(message.error));
      };
      function onError(error: Error): void {
        void finishError(error);
      }
      function onExit(code: number): void {
        if (!settled) void finishError(new WorkflowRunError(`Workflow Worker exited before completion (code ${String(code)}).`));
      }
      worker.on('message', onMessage);
      worker.on('error', onError);
      worker.on('exit', onExit);
      ownerAbort = () => {
        if (settled) return;
        abortInFlight(this.signal?.reason ?? new WorkflowRunCancelledError());
        try {
          worker.postMessage({ type: 'cancel' } satisfies WorkflowWorkerControlMessage);
        } catch {
        }
        void finishError(new WorkflowRunCancelledError());
      };
      if (this.signal !== undefined) {
        if (this.signal.aborted) ownerAbort();
        else this.signal.addEventListener('abort', ownerAbort, { once: true });
      }
      resetWatchdog();
    });
  }
}

function resolveWorkerEntry(): { readonly url: URL; readonly source: boolean } {
  for (const pathname of ['./workflowWorker.mjs', './agent/workflow/runtime/workflowWorker.mjs']) {
    const packaged = new URL(pathname, import.meta.url);
    if (fs.existsSync(packaged)) return { url: packaged, source: false };
  }
  const source = new URL('./workflowWorker.ts', import.meta.url);
  if (fs.existsSync(source)) return { url: source, source: true };
  throw new WorkflowRunError('Workflow Worker entry is not available.');
}

function errorPayload(error: unknown): WorkflowWorkerErrorPayload {
  const value = error as { name?: unknown; message?: unknown; stack?: unknown; cap?: unknown; spent?: unknown; total?: unknown };
  return {
    name: typeof value?.name === 'string' ? value.name : 'Error',
    message: typeof value?.message === 'string' ? value.message : String(error),
    ...(typeof value?.stack === 'string' ? { stack: value.stack } : {}),
    ...(typeof value?.cap === 'number' ? { cap: value.cap } : {}),
    ...(typeof value?.spent === 'number' ? { spent: value.spent } : {}),
    ...(typeof value?.total === 'number' ? { total: value.total } : {}),
  };
}

function errorFromPayload(payload: WorkflowWorkerErrorPayload): Error {
  let error: Error;
  if (payload.name === 'WorkflowAgentCapExceededError' && payload.cap !== undefined) error = new WorkflowAgentCapExceededError(payload.cap);
  else if (payload.name === 'WorkflowBudgetExceededError' && payload.spent !== undefined && payload.total !== undefined) error = new WorkflowBudgetExceededError(payload.spent, payload.total);
  else if (payload.name === 'WorkflowNestingExceededError') error = new WorkflowNestingExceededError();
  else if (payload.name === 'WorkflowItemCapExceededError' && payload.cap !== undefined) error = new WorkflowItemCapExceededError(payload.cap);
  else {
    error = new WorkflowRunError(payload.message);
    error.name = payload.name;
  }
  if (payload.stack !== undefined) error.stack = payload.stack;
  return error;
}

export function buildWrappedSource(source: string, ast: Program): string {
  const stripped = stripExports(source, ast);
  return `(async () => {\n'use strict';\n${stripped}\nreturn await main(args);\n})()\n`;
}

export function installWorkflowGlobals(context: Record<string, unknown>, globals: WorkflowSandboxGlobals): void {
  for (const name of Object.keys(globals)) {
    Object.defineProperty(context, name, { value: globals[name as keyof WorkflowSandboxGlobals], enumerable: false, configurable: false, writable: true });
  }
}

export function stripExports(source: string, ast: Program): string {
  const exports = ast.body.filter((node) => node.type === 'ExportNamedDeclaration' || node.type === 'ExportDefaultDeclaration');
  let stripped = source;
  for (const node of exports.reverse() as readonly { readonly start: number }[]) {
    const start = node.start;
    const after = source[start + 'export'.length];
    const skip = after === ' ' || after === '\t' ? 1 : 0;
    stripped = stripped.slice(0, start) + stripped.slice(start + 'export'.length + skip);
  }
  return stripped;
}
