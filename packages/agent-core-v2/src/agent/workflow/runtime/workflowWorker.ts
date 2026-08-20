/**
 * `workflow.runtime` domain — Worker entry for one isolated workflow run.
 *
 * The Worker owns the vm context and all functions visible to the workflow.
 * Host capabilities are represented only by structured RPC messages; no host
 * realm function, Service, signal, or module object crosses this boundary.
 */

import os from 'node:os';
import vm from 'node:vm';
import { parentPort, workerData } from 'node:worker_threads';

import type {
  WorkflowWorkerAgentResult,
  WorkflowWorkerControlMessage,
  WorkflowWorkerData,
  WorkflowWorkerErrorPayload,
  WorkflowWorkerMessage,
} from './workflowWorkerProtocol.ts';
import { WORKFLOW_WORKER_PROTOCOL_VERSION } from './workflowWorkerProtocol.ts';
import type { TokenUsage } from '#/kosong/contract/usage';
import type {
  WorkflowFanOutOpts,
  WorkflowPipelineOpts,
  WorkflowStageFn,
  WorkflowAgentOpts,
} from '../types.ts';

type ContextFunction = (value: unknown) => unknown;
type ContextErrorFactory = (payload: WorkflowWorkerErrorPayload) => Error;

interface WorkerState {
  readonly controller: AbortController;
  readonly pending: Map<number, { resolve: (value: unknown) => void; reject: (error: unknown) => void }>;
  readonly makeContextValue: ContextFunction;
  readonly makeContextError: ContextErrorFactory;
  readonly functionPrototype: object;
  readonly objectPrototype: object;
  readonly maxItems: number;
  readonly maxConcurrency: number;
  readonly agentCap: number;
  readonly tokenBudgetTotal: number;
  readonly budgetStack: Array<{ readonly total: number; readonly startSpent: number }>;
  spent: number;
  nextRequestId: number;
  agentsSpawned: number;
  nestingDepth: number;
}

const data = workerData as WorkflowWorkerData;
if (parentPort === null) {
  throw new Error('workflow Worker must have a parent port');
}
if (data.protocolVersion !== WORKFLOW_WORKER_PROTOCOL_VERSION) {
  throw new Error(`Unsupported workflow Worker protocol version: ${String(data.protocolVersion)}`);
}

const port = parentPort;
const controller = new AbortController();
const pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: unknown) => void }>();

function serializeError(error: unknown): WorkflowWorkerErrorPayload {
  let name = 'Error';
  let message = String(error);
  let stack: string | undefined;
  try {
    if (typeof error === 'object' && error !== null) {
      const candidate = error as { name?: unknown; message?: unknown; stack?: unknown };
      if (typeof candidate.name === 'string') name = candidate.name;
      if (typeof candidate.message === 'string') message = candidate.message;
      if (typeof candidate.stack === 'string') stack = candidate.stack;
    } else if (error instanceof Error) {
      name = error.name;
      message = error.message;
      stack = error.stack;
    }
  } catch {
    name = 'Error';
    message = 'Workflow execution failed while serializing an error.';
  }
  const payload: WorkflowWorkerErrorPayload = { name, message, ...(stack === undefined ? {} : { stack }) };
  if (typeof error === 'object' && error !== null) {
    const value = error as { cap?: unknown; spent?: unknown; total?: unknown };
    if (typeof value.cap === 'number') (payload as { cap?: number }).cap = value.cap;
    if (typeof value.spent === 'number') (payload as { spent?: number }).spent = value.spent;
    if (typeof value.total === 'number') (payload as { total?: number }).total = value.total;
  }
  return payload;
}

function send(message: WorkflowWorkerMessage): void {
  port.postMessage(message);
}

function safeSend(message: WorkflowWorkerMessage, fallback: WorkflowWorkerMessage): void {
  try {
    send(message);
  } catch {
    send(fallback);
  }
}

function hardenFunction<T extends (...args: never[]) => unknown>(fn: T, prototype: object): T {
  Object.setPrototypeOf(fn, prototype);
  Object.freeze(fn);
  return fn;
}

function createContextHelpers(sandbox: vm.Context): {
  readonly functionPrototype: object;
  readonly objectPrototype: object;
  readonly makeContextValue: ContextFunction;
  readonly makeContextError: ContextErrorFactory;
} {
  const functionPrototype = vm.runInContext('Function.prototype', sandbox) as object;
  const objectPrototype = vm.runInContext('Object.prototype', sandbox) as object;
  const makeContextValue = vm.runInContext(
    `(value) => {
      const seen = new Map();
      const copy = (input) => {
        if (input === null || (typeof input !== 'object' && typeof input !== 'function')) return input;
        if (seen.has(input)) return seen.get(input);
        const tag = Object.prototype.toString.call(input);
        if (tag === '[object Date]') return new Date(input.getTime());
        if (tag === '[object RegExp]') return new RegExp(input.source, input.flags);
        if (tag === '[object Map]') {
          const out = new Map();
          seen.set(input, out);
          for (const [key, value] of input) out.set(copy(key), copy(value));
          return out;
        }
        if (tag === '[object Set]') {
          const out = new Set();
          seen.set(input, out);
          for (const value of input) out.add(copy(value));
          return out;
        }
        if (Array.isArray(input)) {
          const out = [];
          seen.set(input, out);
          for (const value of input) out.push(copy(value));
          return out;
        }
        const out = {};
        seen.set(input, out);
        for (const key of Object.keys(input)) Object.defineProperty(out, key, {
          value: copy(input[key]), enumerable: true, writable: true, configurable: true,
        });
        return out;
      };
      return copy(value);
    }`,
    sandbox,
  ) as ContextFunction;
  const makeContextError = vm.runInContext(
    `(payload) => {
      const error = new Error(String(payload.message));
      error.name = typeof payload.name === 'string' ? payload.name : 'Error';
      if (typeof payload.stack === 'string') error.stack = payload.stack;
      if (typeof payload.cap === 'number') error.cap = payload.cap;
      if (typeof payload.spent === 'number') error.spent = payload.spent;
      if (typeof payload.total === 'number') error.total = payload.total;
      return error;
    }`,
    sandbox,
  ) as ContextErrorFactory;
  return { functionPrototype, objectPrototype, makeContextValue, makeContextError };
}

function resolveConcurrency(requested: number | undefined, ceiling: number): number {
  const cores = typeof os.cpus === 'function' ? os.cpus().length : 4;
  const resolvedCeiling = Math.min(16, Math.max(2, cores - 2));
  const max = Math.max(2, Math.min(ceiling, resolvedCeiling));
  if (requested === undefined || !Number.isInteger(requested) || requested < 1) return max;
  return Math.max(2, Math.min(requested, max));
}

function activeBudget(state: WorkerState): {
  readonly total: number;
  readonly spent: number;
  readonly remaining: number;
} {
  const frame = state.budgetStack[state.budgetStack.length - 1];
  const spent = frame === undefined ? state.spent : Math.max(0, state.spent - frame.startSpent);
  const total = frame?.total ?? state.tokenBudgetTotal;
  let remaining = total > 0 ? Math.max(0, total - spent) : 0;
  if (state.tokenBudgetTotal > 0) remaining = Math.min(remaining, Math.max(0, state.tokenBudgetTotal - state.spent));
  return { total, spent, remaining };
}

function exhaustedBudget(state: WorkerState): { readonly spent: number; readonly total: number } | undefined {
  const frames = [
    { total: state.tokenBudgetTotal, startSpent: 0 },
    ...state.budgetStack,
  ];
  for (const frame of frames) {
    if (frame.total <= 0 || state.spent - frame.startSpent < frame.total) continue;
    return { spent: Math.max(0, state.spent - frame.startSpent), total: frame.total };
  }
  return undefined;
}

function readTokenUsage(value: unknown): TokenUsage | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const candidate = value as Partial<TokenUsage>;
  if (
    typeof candidate.inputOther !== 'number' ||
    typeof candidate.output !== 'number' ||
    typeof candidate.inputCacheRead !== 'number' ||
    typeof candidate.inputCacheCreation !== 'number'
  ) {
    return undefined;
  }
  return {
    inputOther: candidate.inputOther,
    output: candidate.output,
    inputCacheRead: candidate.inputCacheRead,
    inputCacheCreation: candidate.inputCacheCreation,
  };
}

class WorkerItemCapError extends Error {
  constructor(readonly cap: number) {
    super(`Workflow fan-out item budget exceeded: no more than ${String(cap)} items per parallel()/pipeline() call.`);
    this.name = 'WorkflowItemCapExceededError';
  }
}

class WorkerNestingError extends Error {
  constructor() {
    super('workflow() may only be nested one level deep.');
    this.name = 'WorkflowNestingExceededError';
  }
}

function setup(): { readonly sandbox: vm.Context; readonly state: WorkerState; readonly cleanup: () => void } {
  const sandbox = vm.createContext({}, { codeGeneration: { strings: false, wasm: false } });
  const helpers = createContextHelpers(sandbox);
  const state: WorkerState = {
    controller,
    pending,
    ...helpers,
    maxItems: data.maxItemsPerFanOut,
    maxConcurrency: data.maxConcurrency,
    agentCap: data.agentCap,
    tokenBudgetTotal: data.tokenBudgetTotal,
    budgetStack: [],
    spent: data.initialBudgetSpent,
    nextRequestId: 0,
    agentsSpawned: 0,
    nestingDepth: 0,
  };

  const rpcAgent = hardenFunction(async (prompt: string, opts?: WorkflowAgentOpts): Promise<unknown> => {
    state.controller.signal.throwIfAborted();
    if (state.agentsSpawned >= state.agentCap) {
      throw state.makeContextError({
        name: 'WorkflowAgentCapExceededError',
        message: `Workflow agent budget ceiling exceeded: no more than ${String(state.agentCap)} agents may be spawned per workflow run.`,
        cap: state.agentCap,
      });
    }
    const exhausted = exhaustedBudget(state);
    if (exhausted !== undefined) {
      throw state.makeContextError({
        name: 'WorkflowBudgetExceededError',
        message: `Workflow token budget exceeded (${exhausted.spent.toLocaleString()} / ${exhausted.total.toLocaleString()} tokens). Stopping further agent() calls.`,
        spent: exhausted.spent,
        total: exhausted.total,
      });
    }
    state.agentsSpawned += 1;
    const id = state.nextRequestId++;
    const result = await new Promise<unknown>((resolve, reject) => {
      state.pending.set(id, { resolve, reject });
      try {
        port.postMessage({ type: 'agent', id, prompt, opts });
      } catch (error) {
        state.pending.delete(id);
        reject(state.makeContextError(serializeError(error)));
      }
    });
    state.controller.signal.throwIfAborted();
    return result;
  }, state.functionPrototype);

  const phase = hardenFunction((title: unknown): void => {
    safeSend(
      { type: 'phase', title },
      { type: 'phase', title: String(title) },
    );
  }, state.functionPrototype);
  const log = hardenFunction((...parts: readonly unknown[]): void => {
    safeSend(
      { type: 'log', parts },
      { type: 'log', parts: parts.map((part) => String(part)) },
    );
  }, state.functionPrototype);

  const runParallel = async <I, O>(
    items: readonly I[],
    fn: (item: I, index: number) => Promise<O> | O,
    opts?: WorkflowFanOutOpts,
  ): Promise<readonly (O | null)[]> => {
    if (items.length > state.maxItems) throw new WorkerItemCapError(state.maxItems);
    const output: Array<O | null> = new Array(items.length).fill(null);
    let next = 0;
    const worker = async (): Promise<void> => {
      while (true) {
        state.controller.signal.throwIfAborted();
        const index = next++;
        if (index >= items.length) return;
        try {
          output[index] = await fn(items[index]!, index);
        } catch (error) {
          if (state.controller.signal.aborted) throw error;
          output[index] = null;
        }
      }
    };
    const concurrency = resolveConcurrency(opts?.maxConcurrency, state.maxConcurrency);
    await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, () => worker()));
    return output;
  };

  const runChain = async (
    stages: readonly WorkflowStageFn<unknown, unknown, unknown>[],
    seed: unknown,
    item: unknown,
  ): Promise<unknown> => {
    let previous = seed;
    for (let index = 0; index < stages.length; index += 1) {
      state.controller.signal.throwIfAborted();
      const stage = stages[index];
      if (stage === undefined) break;
      try {
        previous = await stage(previous, item, index);
      } catch (error) {
        if (state.controller.signal.aborted) throw error;
        return null;
      }
    }
    return previous;
  };

  const runPipeline = async <O>(
    stages: readonly WorkflowStageFn<unknown, unknown, O>[],
    opts?: WorkflowPipelineOpts,
  ): Promise<O | readonly (O | null)[] | null> => {
    if (opts?.items === undefined) return (await runChain(stages, opts?.input, undefined)) as O | null;
    if (opts.items.length > state.maxItems) throw new WorkerItemCapError(state.maxItems);
    return runParallel(opts.items, (item) => runChain(stages, opts?.input, item), opts) as Promise<
      readonly (O | null)[]
    >;
  };

  const parallel = hardenFunction(runParallel, state.functionPrototype);
  const pipeline = hardenFunction(runPipeline, state.functionPrototype);
  const workflow = hardenFunction(async (spec: { fn: () => unknown; budget?: number; isolation?: string } | (() => unknown)) => {
    if (state.nestingDepth >= 1) throw new WorkerNestingError();
    const body = typeof spec === 'function' ? spec : spec.fn;
    const nestedBudget = typeof spec === 'function' ? undefined : spec.budget;
    const isolation = typeof spec === 'function' ? undefined : spec.isolation;
    if (nestedBudget !== undefined && (!Number.isFinite(nestedBudget) || nestedBudget <= 0)) {
      throw state.makeContextError({
        name: 'WorkflowRunError',
        message: 'workflow() budget must be a finite positive number.',
      });
    }
    if (isolation === 'worktree') {
      throw state.makeContextError({
        name: 'WorkflowIsolationUnsupportedError',
        message: 'Workflow isolation "worktree" is not available in this runtime.',
      });
    }
    state.nestingDepth += 1;
    if (nestedBudget !== undefined) state.budgetStack.push({ total: nestedBudget, startSpent: state.spent });
    try {
      return await body();
    } finally {
      if (nestedBudget !== undefined) state.budgetStack.pop();
      state.nestingDepth -= 1;
    }
  }, state.functionPrototype);
  const spent = hardenFunction(() => activeBudget(state).spent, state.functionPrototype);
  const remaining = hardenFunction(() => activeBudget(state).remaining, state.functionPrototype);
  const budget = {
    get total(): number {
      return activeBudget(state).total;
    },
    spent,
    remaining,
  };
  Object.setPrototypeOf(budget, state.objectPrototype);
  Object.freeze(budget);

  Object.defineProperties(sandbox, {
    agent: { value: rpcAgent, enumerable: false, configurable: false, writable: true },
    parallel: { value: parallel, enumerable: false, configurable: false, writable: true },
    pipeline: { value: pipeline, enumerable: false, configurable: false, writable: true },
    phase: { value: phase, enumerable: false, configurable: false, writable: true },
    log: { value: log, enumerable: false, configurable: false, writable: true },
    args: {
      value: state.makeContextValue(structuredClone(data.args)),
      enumerable: false,
      configurable: false,
      writable: true,
    },
    budget: { value: budget, enumerable: false, configurable: false, writable: true },
    workflow: { value: workflow, enumerable: false, configurable: false, writable: true },
  });
  vm.runInContext(data.sandboxPrelude, sandbox, { timeout: data.timeoutMs });

  const onMessage = (message: WorkflowWorkerControlMessage): void => {
    if (message.type === 'cancel') {
      state.controller.abort();
      const error = state.makeContextError({ name: 'AbortError', message: 'Workflow run was cancelled.' });
      for (const entry of state.pending.values()) entry.reject(error);
      state.pending.clear();
      return;
    }
    if (message.type === 'budgetUpdate') {
      state.spent = message.spent;
      return;
    }
    const entry = state.pending.get(message.id);
    if (entry === undefined) return;
    state.pending.delete(message.id);
    if (!message.ok) {
      entry.reject(state.makeContextError(message.error));
      return;
    }
    state.spent = message.budgetSpent;
    try {
      const raw = state.makeContextValue(message.result) as Record<string, unknown>;
      const usage = readTokenUsage(raw['usage']);
      const result: WorkflowWorkerAgentResult = {
        ok: Boolean(raw['ok']),
        agentId: String(raw['agentId']),
        output: raw['output'],
        durationMs: Number(raw['durationMs']),
        ...(raw['error'] === undefined ? {} : { error: String(raw['error']) }),
        ...(usage === undefined ? {} : { usage }),
      };
      entry.resolve(result);
    } catch (error) {
      entry.reject(state.makeContextError(serializeError(error)));
    }
  };
  port.on('message', onMessage);
  const heartbeat = setInterval(() => {
    try {
      send({ type: 'heartbeat', spent: state.spent });
    } catch {
      clearInterval(heartbeat);
    }
  }, Math.max(10, Math.min(100, Math.floor(data.timeoutMs / 4))));

  return {
    sandbox,
    state,
    cleanup: () => {
      clearInterval(heartbeat);
      port.off('message', onMessage);
      port.close();
    },
  };
}

async function run(): Promise<void> {
  const { sandbox, state, cleanup } = setup();
  send({ type: 'ready', protocolVersion: WORKFLOW_WORKER_PROTOCOL_VERSION });
  try {
    const script = new vm.Script(data.wrappedSource, { filename: 'workflow.js' });
    const result = await script.runInContext(sandbox, { timeout: data.timeoutMs });
    send({ type: 'done', result, agentsSpawned: state.agentsSpawned });
  } catch (error) {
    try {
      send({ type: 'error', error: serializeError(error) });
    } catch {
      port.postMessage({ type: 'error', error: { name: 'Error', message: 'Workflow Worker failed.' } });
    }
  } finally {
    cleanup();
  }
}

void run();
