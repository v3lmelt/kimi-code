/**
 * `workflow.budget` — unit tests for the main-loop token-budget accounting.
 *
 * Covers the pure `parseTokenBudgetDirective` parser and the Agent-scoped
 * `AgentWorkflowBudgetService`: total resolution (directive > configured
 * default), spent accumulation from real usage telemetry (`onDidRecord`) plus
 * folded subagent usage, per-turn directive capture + reset, and the live
 * `budget()` surface the workflow runtime consumes.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { DisposableStore } from '#/_base/di/lifecycle';
import { SyncDescriptor } from '#/_base/di/descriptors';
import { Emitter } from '#/_base/event';
import { TestInstantiationService } from '#/_base/di/test';
import { IAgentPromptService, type PromptSubmitContext } from '#/agent/prompt/prompt';
import { IAgentUsageService, type UsageRecordedContext } from '#/agent/usage/usage';
import { IWorkflowBudgetService, parseTokenBudgetDirective } from '#/agent/workflow/budget/workflowBudget';
import { AgentWorkflowBudgetService } from '#/agent/workflow/budget/workflowBudgetService';
import { IEventBus } from '#/app/event/eventBus';
import { EventBusService } from '#/app/event/eventBusService';
import { IConfigService } from '#/app/config/config';
import { WORKFLOW_DEFAULT_TOKEN_BUDGET } from '#/agent/tools/workflow/workflow';
import type { TokenUsage } from '#/kosong/contract/usage';

const SAMPLE_USAGE: TokenUsage = {
  inputOther: 100,
  output: 50,
  inputCacheRead: 0,
  inputCacheCreation: 0,
};

function stubUsage() {
  const emitter = new Emitter<UsageRecordedContext>();
  return {
    _serviceBrand: undefined,
    record: vi.fn(),
    status: () => ({}),
    onDidRecord: emitter.event,
    fire: (ctx: UsageRecordedContext) => emitter.fire(ctx),
  } as unknown as IAgentUsageService & { fire: (ctx: UsageRecordedContext) => void };
}

function stubPrompt() {
  let hook: ((ctx: PromptSubmitContext, next: () => Promise<void>) => Promise<void>) | undefined;
  const service = {
    _serviceBrand: undefined,
    hooks: {
      onBeforeSubmitPrompt: {
        register: (_name: string, fn: typeof hook) => {
          hook = fn;
          return { dispose() {} };
        },
      },
    },
  } as unknown as IAgentPromptService;
  const runHook = (content: string): Promise<void> => {
    const ctx: PromptSubmitContext = {
      promptMessage: {
        role: 'user',
        content: [{ type: 'text', text: content }],
        toolCalls: [],
      },
      isSteer: false,
      block: false,
    };
    return hook?.(ctx, async () => {}) ?? Promise.resolve();
  };
  return { service, runHook };
}

describe('parseTokenBudgetDirective', () => {
  it('parses +<digits> with optional k/m suffix', () => {
    expect(parseTokenBudgetDirective('use +500k tokens')).toBe(500_000);
    expect(parseTokenBudgetDirective('+250K ceiling')).toBe(250_000);
    expect(parseTokenBudgetDirective('set +1m budget')).toBe(1_000_000);
    expect(parseTokenBudgetDirective('+ 500000 here')).toBe(500_000);
    expect(parseTokenBudgetDirective('spend +200 on this')).toBe(200);
  });

  it('returns undefined when no directive is present', () => {
    expect(parseTokenBudgetDirective('')).toBeUndefined();
    expect(parseTokenBudgetDirective('plain text')).toBeUndefined();
    expect(parseTokenBudgetDirective('500k without plus')).toBeUndefined();
    expect(parseTokenBudgetDirective('a+500k inside word')).toBeUndefined();
    expect(parseTokenBudgetDirective('+0 tokens')).toBeUndefined();
  });
});

describe('AgentWorkflowBudgetService', () => {
  let disposables: DisposableStore;
  let ix: TestInstantiationService;
  let runHook: (content: string) => Promise<void>;
  let usage: ReturnType<typeof stubUsage>;
  let configState: Record<string, { tokenBudget?: number; workflowKeywordTriggerEnabled?: boolean; ultracode?: boolean }>;
  let eventBus: IEventBus;

  beforeEach(() => {
    disposables = new DisposableStore();
    ix = disposables.add(new TestInstantiationService());
    usage = stubUsage();
    ix.stub(IAgentUsageService, usage);
    configState = {};
    ix.stub(IConfigService, { get: vi.fn((domain: string) => configState[domain]) } as unknown as IConfigService);
    const prompt = stubPrompt();
    runHook = prompt.runHook;
    ix.stub(IAgentPromptService, prompt.service);
    ix.set(IEventBus, new SyncDescriptor(EventBusService));
    eventBus = ix.get(IEventBus);
    ix.set(IWorkflowBudgetService, new SyncDescriptor(AgentWorkflowBudgetService));
  });
  afterEach(() => disposables.dispose());

  it('defaults total() to the configured [workflow] token_budget ceiling', () => {
    const budget = ix.get(IWorkflowBudgetService);
    expect(budget.total()).toBe(WORKFLOW_DEFAULT_TOKEN_BUDGET);

    configState['workflow'] = { tokenBudget: 5_000 };
    expect(budget.total()).toBe(5_000);
  });

  it('spent() accumulates real usage records from the main loop', () => {
    const budget = ix.get(IWorkflowBudgetService);
    usage.fire({ model: 'model-x', usage: SAMPLE_USAGE });
    expect(budget.spent()).toBe(150);
    usage.fire({ model: 'model-x', usage: { ...SAMPLE_USAGE, output: 50 } });
    expect(budget.spent()).toBe(300);
  });

  it('recordSubagentUsage folds subagent spend into spent()', () => {
    const budget = ix.get(IWorkflowBudgetService);
    budget.recordSubagentUsage(SAMPLE_USAGE);
    expect(budget.spent()).toBe(150);
  });

  it('budget() exposes a live { total, spent(), remaining() } surface', () => {
    configState['workflow'] = { tokenBudget: 1_000 };
    const budget = ix.get(IWorkflowBudgetService);
    const view = budget.budget();
    expect(view.total).toBe(1_000);
    expect(view.remaining()).toBe(1_000);
    usage.fire({ model: 'model-x', usage: SAMPLE_USAGE });
    expect(view.spent()).toBe(150);
    expect(view.remaining()).toBe(850);
  });

  it('captures a +<N>k directive from the user prompt for the turn and resets it on turn.ended', async () => {
    const budget = ix.get(IWorkflowBudgetService);

    await runHook('please do this with a +200k budget');

    expect(budget.total()).toBe(200_000);

    eventBus.publish({ type: 'turn.ended', turnId: 1, reason: 'completed' });

    expect(budget.total()).toBe(WORKFLOW_DEFAULT_TOKEN_BUDGET);
  });

  it('keeps total() at the default when the prompt has no directive', async () => {
    const budget = ix.get(IWorkflowBudgetService);
    await runHook('no directive here');

    expect(budget.total()).toBe(WORKFLOW_DEFAULT_TOKEN_BUDGET);
  });
});
