/**
 * Scenario: the plan-mode hot path must not read the plan file from disk.
 *
 * The `onBeforeExecuteTool` guard runs for every tool call while plan mode is
 * active, and the `plan_mode` context injector runs for every step. Neither
 * needs the plan content — only the plan file path (a synchronous wire read)
 * and, on the active transition, the content once. This test wraps
 * `IHostFileSystem` with a `readText` counter and drives 10 guard checks plus
 * 5 injections, asserting the plan file is read once (the transition), not
 * once per guard/injection (which would be 15 reads).
 *
 * Run: `pnpm --filter @moonshot-ai/agent-core-v2 exec vitest run test/features/plan/planHotPathReads.test.ts`.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { DisposableStore } from '#/_base/di/lifecycle';
import { createServices, type TestInstantiationService } from '#/_base/di/test';
import {
  IAgentContextInjectorService,
  type ContextInjectionProvider,
} from '#/agent/contextInjector/contextInjector';
import { IAgentContextMemoryService } from '#/agent/contextMemory/contextMemory';
import { IAgentPermissionModeService } from '#/agent/permissionMode/permissionMode';
import { IAgentPlanService } from '#/features/plan/plan';
import { AgentPlanService } from '#/features/plan/planService';
import { IAgentStateService } from '#/agent/state/agentState';
import { AgentStateService } from '#/agent/state/agentStateService';
import { IAgentToolApprovalService } from '#/agent/toolApproval/toolApproval';
import { IAgentToolExecutorService } from '#/agent/toolExecutor/toolExecutor';
import type { ResolvedToolExecutionHookContext } from '#/agent/toolExecutor/toolHooks';
import { IAgentTelemetryContextService } from '#/app/telemetry/agentTelemetryContext';
import { ITelemetryService } from '#/app/telemetry/telemetry';
import type { ToolCall } from '#/kosong/contract/message';
import { IHostFileSystem } from '#/os/interface/hostFileSystem';
import { ISessionContext } from '#/session/sessionContext/sessionContext';
import { ToolAccesses } from '#/tool/toolContract';

import { recordingTelemetry } from '../../app/telemetry/stubs';
import { createFakeHostFs } from '../../tools/fixtures/fake-exec';
import { registerTestAgentWireServices } from '../../wire/stubs';
import { stubPermissionModeService } from '../../agent/permissionMode/stubs';
import { stubToolExecutorEvents, type ToolExecutorEventStubs } from '../../agent/toolExecutor/stubs';

const signal = new AbortController().signal;
const SESSION_DIR = '/session';
const PLAN_ID = 'plan-1';
const PLAN_PATH = `${SESSION_DIR}/agents/test-agent/plans/${PLAN_ID}.md`;

function toolCall(name: string, args: Record<string, unknown>): ToolCall {
  return {
    type: 'function',
    id: `call_${name.toLowerCase()}`,
    name,
    arguments: JSON.stringify(args),
  };
}

function hookContext(
  toolName: string,
  input: {
    readonly args?: Record<string, unknown>;
    readonly accesses?: ToolAccesses;
  } = {},
): ResolvedToolExecutionHookContext {
  const args = input.args ?? {};
  const call = toolCall(toolName, args);
  return {
    turnId: 0,
    signal,
    toolCall: call,
    toolCalls: [call],
    args,
    execution: {
      accesses: input.accesses,
      display: undefined,
      approvalRule: toolName,
      execute: async () => ({ output: '' }),
    },
  };
}

describe('plan-mode hot path read counts', () => {
  let disposables: DisposableStore;
  let ix: TestInstantiationService;
  let executorEvents: ToolExecutorEventStubs;
  let readCount: number;
  let files: Map<string, string>;
  let planModeProvider: ContextInjectionProvider | undefined;

  beforeEach(() => {
    readCount = 0;
    files = new Map();
    planModeProvider = undefined;
    executorEvents = stubToolExecutorEvents();
    disposables = new DisposableStore();

    const toolApproval: IAgentToolApprovalService = {
      _serviceBrand: undefined,
      resolvePermissionResolution: async () => {
        throw new Error('resolvePermissionResolution is not used by the plan-guard listener');
      },
      requestToolApproval: async () => ({ veto: undefined }),
      formatDenyMessage: (message: string) => message,
      formatApprovalRejectionMessage: (toolName, result) =>
        `Tool "${toolName}" was not run (${result.decision}).`,
    };

    ix = createServices(disposables, {
      additionalServices: (reg) => {
        registerTestAgentWireServices(reg);
        reg.defineInstance(
          IHostFileSystem,
          createFakeHostFs({
            mkdir: vi.fn().mockResolvedValue(undefined),
            readText: vi.fn(async (path: string) => {
              readCount += 1;
              return files.get(path) ?? '';
            }),
            writeText: vi.fn(async (path: string, content: string) => {
              files.set(path, content);
            }),
          }),
        );
        reg.definePartialInstance(ISessionContext, {
          sessionId: 'session-1',
          sessionDir: SESSION_DIR,
        });
        reg.definePartialInstance(IAgentContextMemoryService, { get: () => [] });
        reg.definePartialInstance(IAgentContextInjectorService, {
          register: (_name: string, provider: ContextInjectionProvider) => {
            planModeProvider = provider;
            return { dispose: () => {} };
          },
        });
        reg.definePartialInstance(IAgentTelemetryContextService, { set: () => {} });
        reg.defineInstance(IAgentToolExecutorService, executorEvents.executor);
        reg.defineInstance(IAgentToolApprovalService, toolApproval);
        reg.defineInstance(IAgentPermissionModeService, stubPermissionModeService(() => 'manual'));
        reg.defineInstance(ITelemetryService, recordingTelemetry([]));
        reg.defineInstance(IAgentStateService, new AgentStateService());
        reg.define(IAgentPlanService, AgentPlanService);
      },
    });
  });

  afterEach(() => disposables.dispose());

  it('runs 10 tool-call guards and 5 injections with a single plan-file read', async () => {
    const plan = ix.get(IAgentPlanService);
    await plan.enter(PLAN_ID);
    expect(readCount).toBe(0);

    // 10 guard checks for tool calls while plan mode is active: plan-file
    // writes (allow), a non-plan write (veto), and a TaskStop (veto).
    for (let i = 0; i < 8; i++) {
      await executorEvents.fireBeforeExecute(
        hookContext('Write', {
          args: { path: PLAN_PATH },
          accesses: ToolAccesses.writeFile(PLAN_PATH),
        }),
      );
    }
    await executorEvents.fireBeforeExecute(
      hookContext('Write', {
        args: { path: '/workspace/src/main.ts' },
        accesses: ToolAccesses.writeFile('/workspace/src/main.ts'),
      }),
    );
    await executorEvents.fireBeforeExecute(
      hookContext('TaskStop', { args: { task_id: 'bash-abc12345' } }),
    );
    expect(readCount).toBe(0);

    // 5 step injections: the active transition reads the content once (to
    // pick re-entry vs full reminder); the steady-state steps never read.
    expect(planModeProvider).toBeDefined();
    const provider = planModeProvider!;
    const first = await provider({ injectedPositions: [], lastInjectedAt: null, isNewTurn: true });
    expect(first).toBeTypeOf('string');
    expect(readCount).toBe(1);
    for (let i = 0; i < 4; i++) {
      const result = await provider({ injectedPositions: [], lastInjectedAt: 0, isNewTurn: false });
      expect(result).toBeUndefined();
    }
    expect(readCount).toBe(1);

    // Exit reminder after plan exit: still no read.
    plan.exit();
    const exitReminder = await provider({ injectedPositions: [], lastInjectedAt: 0, isNewTurn: true });
    expect(exitReminder).toBeTypeOf('string');
    expect(readCount).toBe(1);
  });

  it('still serves the plan content through status()', async () => {
    files.set(PLAN_PATH, '# Plan');
    const plan = ix.get(IAgentPlanService);
    await plan.enter(PLAN_ID);
    const data = await plan.status();
    expect(data).not.toBeNull();
    expect(data?.path).toBe(PLAN_PATH);
    expect(data?.content).toBe('# Plan');
    expect(readCount).toBe(1);
  });
});
