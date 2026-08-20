/**
 * `workflow.runtime` domain — executes a verified WorkflowGraph with stable
 * node-state transitions, retry policy, restart resume, and budget admission.
 */

import {
  blockedNodeResult,
  completedNodeResult,
  failedNodeResult,
  skippedNodeResult,
  validateWorkflowSchema,
} from '#/agent/workflow/ir/result';
import { compileWorkflowGraph, type CompiledWorkflowGraph } from '#/agent/workflow/compile/graphCompiler';
import { computeWorkflowFingerprint } from '#/agent/workflow/ir/fingerprint';
import { nodeDependencies } from '#/agent/workflow/ir/graph';
import type {
  WorkflowAgentNode,
  WorkflowAgentResult,
  WorkflowConditionNode,
  WorkflowGraph,
  WorkflowNode,
  WorkflowNodeId,
  WorkflowNodeProvenance,
  WorkflowNodeResult,
  WorkflowNodeStatus,
  WorkflowRetryPolicy,
} from '#/agent/workflow/types';
import type { TokenUsage } from '#/kosong/contract/usage';
import type { WorkflowDagJournalSummary, WorkflowNodeCheckpoint } from '#/agent/workflow/persist/dagJournal';

export interface WorkflowDagBudgetOptions {
  readonly total: number;
  readonly spent?: number;
}

export class WorkflowDagBudgetLedger {
  private readonly reservations = new Map<WorkflowNodeId, number>();
  private currentSpent: number;
  private currentReserved = 0;
  private budgetExceeded = false;

  constructor(private readonly totalBudget: number, spent = 0) {
    this.currentSpent = Math.max(0, spent);
    this.budgetExceeded = this.currentSpent > this.totalBudget;
  }

  get total(): number { return this.totalBudget; }
  get spent(): number { return this.currentSpent; }
  get reserved(): number { return this.currentReserved; }
  get available(): number { return Math.max(0, this.totalBudget - this.currentSpent - this.currentReserved); }
  get exceeded(): boolean { return this.budgetExceeded; }

  canReserve(amount: number): boolean {
    if (amount < 0 || !Number.isFinite(amount)) return false;
    return this.currentSpent + this.currentReserved + amount <= this.totalBudget;
  }

  reserve(nodeId: WorkflowNodeId, amount: number): boolean {
    if (!this.canReserve(amount) || this.reservations.has(nodeId)) return false;
    this.reservations.set(nodeId, amount);
    this.currentReserved += amount;
    return true;
  }

  reconcile(nodeId: WorkflowNodeId, spent: number): WorkflowDagBudgetReconciliation {
    const reserved = this.reservations.get(nodeId);
    if (reserved === undefined) {
      return {
        nodeId,
        reserved: 0,
        spent: Math.max(0, spent),
        exceeded: this.budgetExceeded,
        duplicate: true,
      };
    }
    this.reservations.delete(nodeId);
    this.currentReserved -= reserved;
    const actual = Math.max(0, spent);
    this.currentSpent += actual;
    this.budgetExceeded = this.currentSpent > this.totalBudget;
    return {
      nodeId,
      reserved,
      spent: actual,
      exceeded: this.budgetExceeded,
      duplicate: false,
    };
  }

  release(nodeId: WorkflowNodeId): void {
    const reserved = this.reservations.get(nodeId);
    if (reserved === undefined) return;
    this.reservations.delete(nodeId);
    this.currentReserved = Math.max(0, this.currentReserved - reserved);
  }
}

export interface WorkflowDagBudgetReconciliation {
  readonly nodeId: WorkflowNodeId;
  readonly reserved: number;
  readonly spent: number;
  readonly exceeded: boolean;
  readonly duplicate: boolean;
}

export interface WorkflowDagNodeExecutionContext {
  readonly graph: CompiledWorkflowGraph;
  readonly node: WorkflowNode;
  readonly attempt: number;
  readonly signal: AbortSignal;
  readonly dependencies: ReadonlyMap<WorkflowNodeId, WorkflowNodeResult>;
  readonly budget: WorkflowDagBudgetLedger;
}

export type WorkflowDagNodeExecutor = (
  node: WorkflowNode,
  context: WorkflowDagNodeExecutionContext,
) => Promise<unknown> | unknown;

export interface WorkflowDagJournalSink {
  writeNodePlanned?(nodeId: WorkflowNodeId, fingerprint: string, provenance: WorkflowNodeProvenance, at: string): void;
  writeNodeReady?(nodeId: WorkflowNodeId, fingerprint: string, at: string): void;
  writeNodeRunning?(nodeId: WorkflowNodeId, fingerprint: string, attempt: number, at: string): void;
  writeNodeCompleted?(nodeId: WorkflowNodeId, fingerprint: string, attempt: number, result: WorkflowNodeResult, at: string): void;
  writeNodeFailed?(nodeId: WorkflowNodeId, fingerprint: string, attempt: number, error: NonNullable<WorkflowNodeResult['error']>, at: string, result?: WorkflowNodeResult): void;
  writeNodeSkipped?(nodeId: WorkflowNodeId, fingerprint: string, at: string, reason?: string): void;
  writeNodeBlocked?(nodeId: WorkflowNodeId, fingerprint: string, at: string, reason?: string): void;
  writeCheckpoint?(checkpoint: {
    readonly checkpointId: string;
    readonly graphVersion: string;
    readonly nodes: readonly WorkflowNodeCheckpoint[];
    readonly spent: number;
    readonly reserved: number;
    readonly at: string;
  }): void;
}

export interface WorkflowDagSchedulerOptions {
  readonly graph: WorkflowGraph | CompiledWorkflowGraph;
  readonly execute?: WorkflowDagNodeExecutor;
  readonly executeNode?: WorkflowDagNodeExecutor;
  readonly executeAgent?: (
    node: WorkflowAgentNode,
    context: WorkflowDagNodeExecutionContext,
  ) => Promise<unknown> | unknown;
  readonly signal?: AbortSignal;
  readonly journal?: WorkflowDagJournalSink;
  readonly resume?: WorkflowDagJournalSummary | ReadonlyMap<WorkflowNodeId, WorkflowDagNodeStateLike>;
  readonly budget?: WorkflowDagBudgetOptions | WorkflowDagBudgetLedger;
  readonly fingerprintContext?: Parameters<typeof computeWorkflowFingerprint>[2];
  readonly now?: () => string;
  readonly conditionEvaluator?: (node: WorkflowConditionNode, context: WorkflowDagNodeExecutionContext) => boolean | Promise<boolean>;
  readonly onNodeState?: (state: WorkflowDagNodeStateLike) => void;
  readonly onSubagentUsage?: (usage: TokenUsage) => void;
  readonly maxConcurrency?: number;
}

export interface WorkflowDagNodeStateLike {
  readonly nodeId: WorkflowNodeId;
  readonly status: WorkflowNodeStatus;
  readonly fingerprint: string;
  readonly attempt: number;
  readonly result?: WorkflowNodeResult;
  readonly error?: WorkflowNodeResult['error'];
  readonly updatedAt?: string;
}

export interface WorkflowDagRunResult {
  readonly status: 'completed' | 'failed' | 'blocked' | 'budget_exceeded' | 'aborted';
  readonly result?: unknown;
  readonly nodes: ReadonlyMap<WorkflowNodeId, WorkflowDagNodeStateLike>;
  readonly spent: number;
  readonly reserved: number;
  readonly budgetExceeded: boolean;
}

export class WorkflowDagScheduler {
  private readonly graph: CompiledWorkflowGraph;
  private readonly options: WorkflowDagSchedulerOptions;
  private readonly signal: AbortSignal;
  private readonly budget: WorkflowDagBudgetLedger;
  private readonly fingerprintContext: Parameters<typeof computeWorkflowFingerprint>[2];
  private readonly states = new Map<WorkflowNodeId, WorkflowDagNodeStateLike>();
  private readonly results = new Map<WorkflowNodeId, WorkflowNodeResult>();
  private readonly conditionValues = new Map<WorkflowNodeId, boolean>();
  private readonly now: () => string;
  private readonly maxConcurrency: number;

  constructor(options: WorkflowDagSchedulerOptions) {
    this.options = options;
    const graphInput = isCompiledGraph(options.graph) ? options.graph.graph : options.graph;
    const fingerprintContext = options.fingerprintContext ??
      (isCompiledGraph(options.graph) ? options.graph.fingerprintContext : undefined);
    this.fingerprintContext = fingerprintContext;
    this.graph = compileWorkflowGraph(graphInput, fingerprintContext);
    this.signal = options.signal ?? new AbortController().signal;
    this.budget = options.budget instanceof WorkflowDagBudgetLedger
      ? options.budget
      : new WorkflowDagBudgetLedger(options.budget?.total ?? Number.MAX_SAFE_INTEGER, options.budget?.spent ?? 0);
    this.now = options.now ?? (() => new Date().toISOString());
    this.maxConcurrency = normalizeConcurrency(options.maxConcurrency);
    this.seedResume(options.resume);
  }

  get compiledGraph(): CompiledWorkflowGraph { return this.graph; }
  get budgetLedger(): WorkflowDagBudgetLedger { return this.budget; }

  async run(): Promise<WorkflowDagRunResult> {
    try {
      return await this.runInternal();
    } catch (error) {
      if (!this.signal.aborted) throw error;
      return {
        status: 'aborted',
        nodes: new Map(this.states),
        spent: this.budget.spent,
        reserved: this.budget.reserved,
        budgetExceeded: this.budget.exceeded,
      };
    }
  }

  private async runInternal(): Promise<WorkflowDagRunResult> {
    this.signal.throwIfAborted();
    this.planNodes();
    const order = this.graph.order;
    let progress = true;
    while (progress) {
      this.signal.throwIfAborted();
      progress = false;
      const running: Promise<WorkflowNodeResult>[] = [];
      for (const nodeId of order) {
        if (running.length >= this.maxConcurrency) break;
        const state = this.states.get(nodeId);
        if (state === undefined || isTerminalState(state.status)) continue;
        const node = this.node(nodeId);
        const dependencies = nodeDependencies(node);
        const dependencyStates = dependencies.map((id) => this.states.get(id));
        if (dependencyStates.some((dependency) => dependency === undefined || !isTerminalState(dependency.status))) continue;
        if (this.budget.exceeded) {
          this.markBlocked(node, 'Workflow budget exceeded; no new node was started.');
          progress = true;
          continue;
        }
        if (this.shouldBlock(node, dependencies, dependencyStates)) {
          this.markBlocked(node, 'An upstream node failed or was blocked.');
          progress = true;
          continue;
        }
        if (node.kind === 'condition') {
          const condition = await this.evaluateCondition(node);
          this.conditionValues.set(node.id, condition);
          if (!condition) {
            this.markSkipped(node, 'Condition evaluated to false.');
            this.skipBranch(node.whenTrue);
            progress = true;
            continue;
          }
          this.skipBranch(node.whenFalse);
        }
        const estimate = estimateBudget(node);
        if (!this.budget.reserve(node.id, estimate)) {
          this.markBlocked(node, 'Workflow budget is exhausted; no new node was started.');
          progress = true;
          continue;
        }
        this.markReady(node);
        const completed = this.executeWithRetry(node);
        running.push(completed);
        void completed.then((result) => {
          if (result.status === 'failed') this.blockDependents(node.id);
        });
        progress = true;
      }
      if (running.length > 0) await Promise.all(running);
      if (this.states.size === this.graph.graph.nodes.length && [...this.states.values()].every((state) => isTerminalState(state.status))) break;
    }
    for (const node of this.graph.graph.nodes) {
      const state = this.states.get(node.id);
      if (state !== undefined && isTerminalState(state.status)) continue;
      this.markBlocked(node, this.budget.exceeded
        ? 'Workflow budget exceeded; no new node was started.'
        : 'Node could not become ready from the verified dependency graph.');
    }
    this.writeCheckpoint();
    this.signal.throwIfAborted();
    const values = this.graph.graph.nodes.filter((node) => node.id === this.graph.graph.root).map((node) => this.results.get(node.id)?.value);
    const failed = this.hasFatalFailure();
    const blocked = [...this.states.values()].some((state) => state.status === 'blocked');
    return {
      status: this.budget.exceeded ? 'budget_exceeded' : failed ? 'failed' : blocked ? 'blocked' : 'completed',
      ...(values.length === 0 ? {} : { result: values[0] }),
      nodes: new Map(this.states),
      spent: this.budget.spent,
      reserved: this.budget.reserved,
      budgetExceeded: this.budget.exceeded,
    };
  }

  private planNodes(): void {
    for (const node of this.graph.graph.nodes) {
      const fingerprint = this.fingerprintFor(node);
      const current = this.states.get(node.id);
      const retryableFailure = current?.status === 'failed' && current.fingerprint === fingerprint &&
        current.attempt < normalizeRetryPolicy(node.retry).maxAttempts;
      const shouldPlan = current === undefined || current.fingerprint !== fingerprint ||
        (current.status === 'completed' && !this.cacheable(node)) || retryableFailure;
      if (!shouldPlan) continue;
      this.options.journal?.writeNodePlanned?.(node.id, fingerprint, node.provenance === undefined ? { authoring: 'ir', nodeId: node.id, fingerprint } : { ...node.provenance, nodeId: node.id, fingerprint }, this.now());
      this.results.delete(node.id);
      this.setState({
        nodeId: node.id,
        status: 'planned',
        fingerprint,
        attempt: retryableFailure ? current.attempt : 0,
        updatedAt: this.now(),
      });
    }
  }

  private seedResume(resume: WorkflowDagSchedulerOptions['resume']): void {
    if (resume === undefined) return;
    const entries = isResumeMap(resume)
      ? [...resume.values()]
      : [...resume.nodes.values()];
    for (const state of entries) {
      const node = this.graph.graph.nodes.find((candidate) => candidate.id === state.nodeId);
      if (node === undefined) continue;
      const fingerprint = this.fingerprintFor(node);
      if (fingerprint !== state.fingerprint) continue;
      if (state.status === 'completed' && (!this.cacheable(node) || state.result === undefined)) continue;
      this.states.set(state.nodeId, state);
      if (state.status === 'completed' && state.result !== undefined) this.results.set(state.nodeId, state.result);
    }
  }

  private async executeWithRetry(node: WorkflowNode): Promise<WorkflowNodeResult> {
    const state = this.states.get(node.id);
    const priorAttempt = state?.status === 'lost' || state?.status === 'running'
      ? Math.max(0, (state.attempt ?? 1) - 1)
      : state?.attempt ?? 0;
    const policy = normalizeRetryPolicy(node.retry);
    let attempt = priorAttempt;
    while (attempt < policy.maxAttempts) {
      this.signal.throwIfAborted();
      attempt += 1;
      const fingerprint = this.fingerprintFor(node);
      if (attempt > 1 && !this.budget.reserve(node.id, estimateBudget(node))) {
        const blocked = blockedNodeResult(provenanceFor(this.graph.graph, node, fingerprint), 'Workflow budget is exhausted before retry.');
        this.setState({ nodeId: node.id, status: 'blocked', fingerprint, attempt, result: blocked, error: blocked.error, updatedAt: this.now() });
        return blocked;
      }
      this.options.journal?.writeNodeRunning?.(node.id, fingerprint, attempt, this.now());
      this.setState({ nodeId: node.id, status: 'running', fingerprint, attempt, updatedAt: this.now() });
      try {
        const result = await this.executeNode(node, attempt);
        const usage = result.usage;
        if (usage !== undefined) this.options.onSubagentUsage?.(usage);
        this.budget.reconcile(node.id, usageTotal(usage));
        if (result.status === 'completed') {
          this.options.journal?.writeNodeCompleted?.(node.id, fingerprint, attempt, result, this.now());
          this.results.set(node.id, result);
          this.setState({ nodeId: node.id, status: 'completed', fingerprint, attempt, result, updatedAt: this.now() });
          this.emitState(this.states.get(node.id)!);
          return result;
        }
        this.options.journal?.writeNodeFailed?.(node.id, fingerprint, attempt, result.error ?? { code: 'workflow.node_failed', message: 'Node failed.' }, this.now(), result);
        if (attempt < policy.maxAttempts) {
          await retryDelay(policy, attempt, this.signal);
          continue;
        }
        this.setState({ nodeId: node.id, status: 'failed', fingerprint, attempt, result, error: result.error, updatedAt: this.now() });
        this.emitState(this.states.get(node.id)!);
        return result;
      } catch (error) {
        this.budget.reconcile(node.id, 0);
        const failure = failedNodeResult({ code: 'workflow.node_failed', message: error instanceof Error ? error.message : String(error) }, provenanceFor(this.graph.graph, node, fingerprint));
        this.options.journal?.writeNodeFailed?.(node.id, fingerprint, attempt, failure.error!, this.now(), failure);
        if (attempt < policy.maxAttempts) {
          await retryDelay(policy, attempt, this.signal);
          continue;
        }
        this.setState({ nodeId: node.id, status: 'failed', fingerprint, attempt, result: failure, error: failure.error, updatedAt: this.now() });
        this.emitState(this.states.get(node.id)!);
        return failure;
      }
    }
    const fingerprint = node.fingerprint?.value ?? '';
    const failure = failedNodeResult({ code: 'workflow.retry_exhausted', message: 'Node retry policy is exhausted.' }, provenanceFor(this.graph.graph, node, fingerprint));
    this.setState({ nodeId: node.id, status: 'failed', fingerprint, attempt, result: failure, error: failure.error, updatedAt: this.now() });
    return failure;
  }

  private async executeNode(node: WorkflowNode, attempt: number): Promise<WorkflowNodeResult> {
    const fingerprint = this.fingerprintFor(node);
    const provenance = provenanceFor(this.graph.graph, node, fingerprint);
    const context = this.contextFor(node, attempt);
    let raw: unknown;
    if (node.kind === 'sequence') {
      raw = nodeDependencies(node).map((id) => context.dependencies.get(id)?.value);
    } else if (node.kind === 'join') {
      const values = nodeDependencies(node).map((id) => context.dependencies.get(id));
      raw = node.strategy === 'any' || node.strategy === 'first'
        ? values.find((entry) => entry?.status === 'completed')?.value
        : values.map((entry) => entry?.value);
    } else if (node.kind === 'condition') {
      const condition = this.conditionValues.get(node.id);
      raw = condition ?? await this.evaluateCondition(node, context);
    } else if (this.options.execute !== undefined || this.options.executeNode !== undefined) {
      raw = await (this.options.execute ?? this.options.executeNode)!(node, context);
    } else if (node.kind === 'agent' && this.options.executeAgent !== undefined) {
      raw = await this.options.executeAgent(node, context);
    } else {
      throw new Error(`No executor was provided for workflow node "${node.id}".`);
    }
    const normalized = normalizeExecutorResult(raw, provenance);
    if (node.kind === 'agent' && node.schema !== undefined && normalized.status === 'completed') {
      const schemaError = validateWorkflowSchema(normalized.value, node.schema);
      if (schemaError !== undefined) {
        return failedNodeResult({ code: 'workflow.schema_invalid', message: schemaError }, provenance, normalized.usage);
      }
    }
    return normalized;
  }

  private async evaluateCondition(node: WorkflowConditionNode, context?: WorkflowDagNodeExecutionContext): Promise<boolean> {
    if (this.options.conditionEvaluator !== undefined) return await this.options.conditionEvaluator(node, context ?? this.contextFor(node, 0));
    const spec = node.condition;
    if (spec?.value !== undefined) return Boolean(spec.value);
    const first = context === undefined ? undefined : [...context.dependencies.values()][0]?.value;
    const actual = spec?.path === undefined ? first : readPath(first, spec.path);
    if (spec?.equals !== undefined) return deepEqual(actual, spec.equals);
    if (spec?.notEquals !== undefined) return !deepEqual(actual, spec.notEquals);
    return Boolean(actual);
  }

  private contextFor(node: WorkflowNode, attempt: number): WorkflowDagNodeExecutionContext {
    const dependencies = new Map<WorkflowNodeId, WorkflowNodeResult>();
    for (const dependency of nodeDependencies(node)) {
      const result = this.results.get(dependency);
      if (result !== undefined) dependencies.set(dependency, result);
    }
    return {
      graph: this.graph,
      node,
      attempt,
      signal: this.signal,
      dependencies,
      budget: this.budget,
    };
  }

  private markReady(node: WorkflowNode): void {
    const fingerprint = this.fingerprintFor(node);
    this.options.journal?.writeNodeReady?.(node.id, fingerprint, this.now());
    const current = this.states.get(node.id);
    if (current?.status === 'lost' || current?.status === 'running') return;
    this.setState({ nodeId: node.id, status: 'ready', fingerprint, attempt: this.states.get(node.id)?.attempt ?? 0, updatedAt: this.now() });
  }

  private markSkipped(node: WorkflowNode, reason: string): void {
    const fingerprint = this.fingerprintFor(node);
    const result = skippedNodeResult(provenanceFor(this.graph.graph, node, fingerprint), reason);
    this.options.journal?.writeNodeSkipped?.(node.id, fingerprint, this.now(), reason);
    this.results.set(node.id, result);
    this.setState({ nodeId: node.id, status: 'skipped', fingerprint, attempt: this.states.get(node.id)?.attempt ?? 0, result, updatedAt: this.now() });
    this.emitState(this.states.get(node.id)!);
  }

  private markBlocked(node: WorkflowNode, reason: string): void {
    if (this.states.get(node.id)?.status === 'blocked') return;
    const fingerprint = this.fingerprintFor(node);
    const result = blockedNodeResult(provenanceFor(this.graph.graph, node, fingerprint), reason);
    this.options.journal?.writeNodeBlocked?.(node.id, fingerprint, this.now(), reason);
    this.results.set(node.id, result);
    this.setState({ nodeId: node.id, status: 'blocked', fingerprint, attempt: this.states.get(node.id)?.attempt ?? 0, result, error: result.error, updatedAt: this.now() });
    this.emitState(this.states.get(node.id)!);
  }

  private blockDependents(nodeId: WorkflowNodeId): void {
    for (const node of this.graph.graph.nodes) {
      if (!nodeDependencies(node).includes(nodeId) || isTerminalState(this.states.get(node.id)?.status)) continue;
      const dependencies = nodeDependencies(node).map((id) => this.states.get(id));
      const dependencyIds = nodeDependencies(node);
      if (dependencies.every((dependency) => dependency !== undefined && isTerminalState(dependency.status)) &&
        this.shouldBlock(node, dependencyIds, dependencies)) {
        this.markBlocked(node, `Dependency "${nodeId}" failed.`);
      }
    }
  }

  private skipBranch(nodeId: WorkflowNodeId | undefined): void {
    if (nodeId === undefined) return;
    const node = this.graph.graph.nodes.find((candidate) => candidate.id === nodeId);
    if (node === undefined || isTerminalState(this.states.get(node.id)?.status)) return;
    this.markSkipped(node, 'Condition branch was not selected.');
  }

  private node(nodeId: WorkflowNodeId): WorkflowNode {
    const node = this.graph.graph.nodes.find((candidate) => candidate.id === nodeId);
    if (node === undefined) throw new Error(`Unknown workflow node "${nodeId}".`);
    return node;
  }

  private fingerprintFor(node: WorkflowNode): string {
    return computeWorkflowFingerprint(this.graph.graph, node, this.fingerprintContext).value;
  }

  private cacheable(node: WorkflowNode): boolean {
    return computeWorkflowFingerprint(this.graph.graph, node, this.fingerprintContext).cacheable;
  }

  private shouldBlock(
    node: WorkflowNode,
    dependencyIds: readonly WorkflowNodeId[],
    dependencies: readonly (WorkflowDagNodeStateLike | undefined)[],
  ): boolean {
    if (node.kind === 'join' && (node.strategy === 'any' || node.strategy === 'first')) {
      if (dependencies.some((dependency) => dependency?.status === 'completed')) return false;
      if (node.acceptsSkipped === true && dependencies.some((dependency) => dependency?.status === 'skipped')) return false;
      return true;
    }
    return dependencies.some((dependency, index) => {
      if (dependency === undefined) return true;
      if (dependency.status === 'failed' || dependency.status === 'blocked') return true;
      if (dependency.status !== 'skipped' || node.acceptsSkipped === true) return false;
      const dependencyId = dependencyIds[index];
      if (dependencyId === undefined) return true;
      const owner = this.graph.graph.nodes.find((candidate) => candidate.id === dependencyId);
      if (owner?.kind !== 'condition') return true;
      const condition = this.conditionValues.get(owner.id);
      return !((condition === true && owner.whenTrue === node.id) ||
        (condition === false && owner.whenFalse === node.id));
    });
  }

  private hasFatalFailure(): boolean {
    const rootId = this.graph.graph.root ?? this.graph.order[this.graph.order.length - 1];
    if (rootId === undefined) return [...this.states.values()].some((state) => state.status === 'failed');

    const visited = new Set<WorkflowNodeId>();
    const visit = (nodeId: WorkflowNodeId): boolean => {
      if (visited.has(nodeId)) return false;
      visited.add(nodeId);
      const state = this.states.get(nodeId);
      if (state?.status === 'failed') return true;
      const node = this.graph.graph.nodes.find((candidate) => candidate.id === nodeId);
      if (node === undefined) return false;
      const dependencies = nodeDependencies(node);
      if (node.kind === 'join' && (node.strategy === 'any' || node.strategy === 'first')) {
        const selected = dependencies.find((dependency) => this.states.get(dependency)?.status === 'completed');
        return selected === undefined ? false : visit(selected);
      }
      return dependencies.some((dependency) => visit(dependency));
    };

    return visit(rootId);
  }

  private setState(state: WorkflowDagNodeStateLike): void {
    this.states.set(state.nodeId, state);
    this.emitState(state);
  }

  private emitState(state: WorkflowDagNodeStateLike): void {
    this.options.onNodeState?.(state);
  }

  private writeCheckpoint(): void {
    this.options.journal?.writeCheckpoint?.({
      checkpointId: `checkpoint-${this.now()}`,
      graphVersion: this.graph.graph.version,
      nodes: [...this.states.values()].map((state) => ({ ...state, updatedAt: state.updatedAt ?? this.now() })),
      spent: this.budget.spent,
      reserved: this.budget.reserved,
      at: this.now(),
    });
  }
}

export async function runWorkflowGraph(options: WorkflowDagSchedulerOptions): Promise<WorkflowDagRunResult> {
  return new WorkflowDagScheduler(options).run();
}

function isCompiledGraph(value: WorkflowGraph | CompiledWorkflowGraph): value is CompiledWorkflowGraph {
  return typeof value === 'object' && value !== null && 'verified' in value && value.verified === true &&
    'executable' in value && value.executable === true;
}

function isResumeMap(
  value: WorkflowDagJournalSummary | ReadonlyMap<WorkflowNodeId, WorkflowDagNodeStateLike>,
): value is ReadonlyMap<WorkflowNodeId, WorkflowDagNodeStateLike> {
  return value instanceof Map || typeof (value as { values?: unknown }).values === 'function';
}

function isTerminalState(status: WorkflowNodeStatus | undefined): boolean {
  return status === 'completed' || status === 'failed' || status === 'skipped' || status === 'blocked';
}

function normalizeRetryPolicy(policy: WorkflowRetryPolicy | undefined): Required<Pick<WorkflowRetryPolicy, 'maxAttempts' | 'backoffMs' | 'backoffMultiplier'>> {
  return {
    maxAttempts: Math.max(1, Math.floor(policy?.maxAttempts ?? 1)),
    backoffMs: Math.max(0, policy?.backoffMs ?? 0),
    backoffMultiplier: Math.max(1, policy?.backoffMultiplier ?? 1),
  };
}

async function retryDelay(policy: ReturnType<typeof normalizeRetryPolicy>, attempt: number, signal: AbortSignal): Promise<void> {
  const delay = Math.floor(policy.backoffMs * Math.pow(policy.backoffMultiplier, Math.max(0, attempt - 1)));
  if (delay <= 0) return;
  let abort: (() => void) | undefined;
  try {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(resolve, delay);
      abort = (): void => { clearTimeout(timer); reject(signal.reason); };
      signal.addEventListener('abort', abort, { once: true });
    });
  } finally {
    if (abort !== undefined) signal.removeEventListener('abort', abort);
  }
}

function estimateBudget(node: WorkflowNode): number {
  return Math.max(1, Math.floor(node.budget ?? 1));
}

function normalizeConcurrency(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value)) return 1;
  return Math.max(1, Math.floor(value));
}

function usageTotal(usage: TokenUsage | undefined): number {
  if (usage === undefined) return 0;
  return usage.inputOther + usage.output + usage.inputCacheRead + usage.inputCacheCreation;
}

function normalizeExecutorResult(raw: unknown, provenance: WorkflowNodeProvenance): WorkflowNodeResult {
  if (isNodeResult(raw)) return { ...raw, provenance: raw.provenance ?? provenance };
  if (isAgentResult(raw)) {
    if (!raw.ok) return failedNodeResult({ code: 'workflow.agent_failed', message: raw.error ?? 'Agent failed.' }, provenance, raw.usage);
    return completedNodeResult(raw.output, provenance, raw.usage);
  }
  return completedNodeResult(raw, provenance);
}

function provenanceFor(graph: WorkflowGraph, node: WorkflowNode, fingerprint: string): WorkflowNodeProvenance {
  return {
    ...(node.provenance ?? graph.provenance ?? { authoring: 'ir' as const }),
    nodeId: node.id,
    fingerprint,
  };
}

function isNodeResult(value: unknown): value is WorkflowNodeResult {
  return typeof value === 'object' && value !== null && ['completed', 'failed', 'skipped', 'blocked'].includes(String((value as { status?: unknown }).status));
}

type WorkflowAgentResultWithUsage = WorkflowAgentResult & { readonly usage?: TokenUsage };

function isAgentResult(value: unknown): value is WorkflowAgentResultWithUsage {
  return typeof value === 'object' && value !== null && typeof (value as { ok?: unknown }).ok === 'boolean' && 'output' in value;
}

function readPath(value: unknown, path: string): unknown {
  let current = value;
  for (const key of path.split('.')) {
    if (typeof current !== 'object' || current === null) return undefined;
    current = (current as Record<string, unknown>)[key];
  }
  return current;
}

function deepEqual(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true;
  if (typeof left !== 'object' || left === null || typeof right !== 'object' || right === null) return false;
  const leftKeys = Object.keys(left as Record<string, unknown>);
  const rightKeys = Object.keys(right as Record<string, unknown>);
  return leftKeys.length === rightKeys.length && leftKeys.every((key) => key in (right as Record<string, unknown>) && deepEqual((left as Record<string, unknown>)[key], (right as Record<string, unknown>)[key]));
}
