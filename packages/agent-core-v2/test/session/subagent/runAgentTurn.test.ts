/**
 * `subagent.runAgentTurn` — unit tests for the subagent turn driver.
 *
 * Covers the `StructuredOutput` registration gate: `requiresStructuredOutput`
 * is an explicit driver request, so the tool must be injected even when the
 * target profile's static tool policy does not list `StructuredOutput` (the
 * workflow `agent({ schema })` path). Also covers the no-op branches.
 */

import { describe, expect, it, vi } from 'vitest';

import type { IAgentScopeHandle } from '#/_base/di/scope';
import { IAgentLoopService } from '#/agent/loop/loop';
import { IAgentPromptService } from '#/agent/prompt/prompt';
import { IAgentUsageService } from '#/agent/usage/usage';
import { IAgentProfileService } from '#/agent/profile/profile';
import { IAgentToolRegistryService } from '#/agent/toolRegistry/toolRegistry';
import type { TokenUsage } from '#/kosong/contract/usage';
import {
  STRUCTURED_OUTPUT_TOOL_NAME,
  StructuredOutputValidationError,
} from '#/agent/workflow/structured/structuredOutputTool';
import { runAgentTurn, setupStructuredOutput } from '#/session/subagent/runAgentTurn';

const SCHEMA = { type: 'object', required: ['answer'], properties: { answer: { type: 'string' } } };

function scopeWithRegistry(): {
  scope: IAgentScopeHandle;
  register: ReturnType<typeof vi.fn>;
  addActiveTool: ReturnType<typeof vi.fn>;
  removeActiveTool: ReturnType<typeof vi.fn>;
} {
  const register = vi.fn(() => ({ dispose: () => {} }));
  const addActiveTool = vi.fn();
  const removeActiveTool = vi.fn();
  const registry = {
    revision: 0,
    register,
    list: () => [],
    listReferences: () => [],
    resolve: () => undefined,
  } as unknown as IAgentToolRegistryService;
  const profile = { addActiveTool, removeActiveTool } as unknown as IAgentProfileService;
  const scope = {
    id: 'test-agent',
    accessor: {
      get: (id: unknown) =>
        id === IAgentToolRegistryService
          ? registry
          : id === IAgentProfileService
            ? profile
            : undefined,
    },
  } as unknown as IAgentScopeHandle;
  return { scope, register, addActiveTool, removeActiveTool };
}

describe('setupStructuredOutput', () => {
  it('registers the StructuredOutput tool when explicitly requested with a schema', () => {
    const { scope, register, addActiveTool } = scopeWithRegistry();
    const structured = setupStructuredOutput(scope, {
      signal: new AbortController().signal,
      requiresStructuredOutput: true,
      structuredSchema: SCHEMA,
    });
    expect(structured).toBeDefined();
    expect(register).toHaveBeenCalledTimes(1);
    const tool = register.mock.calls[0]?.[0] as { name: string } | undefined;
    expect(tool?.name).toBe(STRUCTURED_OUTPUT_TOOL_NAME);
    structured?.registration.dispose();
    structured?.deactivate();
  });

  it('registers the tool regardless of the target tool policy (explicit request wins)', () => {
    const { scope, register, addActiveTool } = scopeWithRegistry();
    // The target accessor does not resolve a tool-policy service at all — the
    // fix is that the explicit request must not be gated on it.
    const structured = setupStructuredOutput(scope, {
      signal: new AbortController().signal,
      requiresStructuredOutput: true,
      structuredSchema: SCHEMA,
    });
    expect(structured).toBeDefined();
    expect(register).toHaveBeenCalledTimes(1);
    structured?.registration.dispose();
    structured?.deactivate();
  });

  it('activates the tool in the profile overlay for the turn and revokes it on deactivate', () => {
    const { scope, addActiveTool, removeActiveTool } = scopeWithRegistry();
    const structured = setupStructuredOutput(scope, {
      signal: new AbortController().signal,
      requiresStructuredOutput: true,
      structuredSchema: SCHEMA,
    });
    // The request tool table and the executor preflight both filter against
    // the profile's active-tool policy, so the tool must be granted there for
    // the duration of the turn — otherwise the model never sees it.
    expect(addActiveTool).toHaveBeenCalledWith(STRUCTURED_OUTPUT_TOOL_NAME);
    structured?.deactivate();
    expect(removeActiveTool).toHaveBeenCalledWith(STRUCTURED_OUTPUT_TOOL_NAME);
  });

  it('does nothing without requiresStructuredOutput', () => {
    const { scope, register, addActiveTool } = scopeWithRegistry();
    const structured = setupStructuredOutput(scope, {
      signal: new AbortController().signal,
      structuredSchema: SCHEMA,
    });
    expect(structured).toBeUndefined();
    expect(register).not.toHaveBeenCalled();
    expect(addActiveTool).not.toHaveBeenCalled();
  });

  it('does nothing when the schema is missing', () => {
    const { scope, register, addActiveTool } = scopeWithRegistry();
    const structured = setupStructuredOutput(scope, {
      signal: new AbortController().signal,
      requiresStructuredOutput: true,
    });
    expect(structured).toBeUndefined();
    expect(register).not.toHaveBeenCalled();
    expect(addActiveTool).not.toHaveBeenCalled();
  });
});

describe('runAgentTurn', () => {
  it('rejects when the turn cannot start', async () => {
    // The signal check runs before any service is touched.
    await expect(
      runAgentTurn({} as unknown as IAgentScopeHandle, { kind: 'prompt', prompt: 'x' }, {
        signal: AbortSignal.abort(),
      } as Parameters<typeof runAgentTurn>[2]),
    ).rejects.toThrow();
  });

  function scopeForTurn(
    candidate: unknown,
    usageBefore?: TokenUsage,
    usageAfter?: TokenUsage,
  ): {
    scope: IAgentScopeHandle;
    enqueueCount: { value: number };
  } {
    let registeredTool: {
      resolveExecution(input: { result: unknown }): { execute(ctx: unknown): Promise<unknown> };
    } | undefined;
    const enqueueCount = { value: 0 };
    const turn = {
      id: 1,
      signal: new AbortController().signal,
      ready: Promise.resolve(),
      result: Promise.resolve({ type: 'completed', steps: 1, truncated: false } as const),
      cancel: vi.fn(() => true),
    };
    let usageTotal = usageBefore;
    const prompt = {
      enqueue: vi.fn(async () => {
        enqueueCount.value += 1;
        if (registeredTool !== undefined) {
          const result = registeredTool.resolveExecution({ result: candidate });
          await result.execute({});
          if (usageAfter !== undefined) usageTotal = usageAfter;
        }
        return { launched: Promise.resolve(turn) };
      }),
      retry: vi.fn(async () => turn),
    } as unknown as IAgentPromptService;
    const usage = {
      status: () => ({ total: usageTotal }),
    } as unknown as IAgentUsageService;
    const registry = {
      register: vi.fn((tool: typeof registeredTool) => {
        registeredTool = tool;
        return { dispose: vi.fn() };
      }),
    } as unknown as IAgentToolRegistryService;
    const profile = {
      addActiveTool: vi.fn(),
      removeActiveTool: vi.fn(),
    } as unknown as IAgentProfileService;
    const scope = {
      id: 'test-agent',
      accessor: {
        get: (id: unknown) => {
          if (id === IAgentToolRegistryService) return registry;
          if (id === IAgentProfileService) return profile;
          if (id === IAgentPromptService) return prompt;
          if (id === IAgentLoopService) return { cancel: vi.fn() };
          if (id === IAgentUsageService) return usage;
          return undefined;
        },
      },
    } as unknown as IAgentScopeHandle;
    return { scope, enqueueCount };
  }

  it('returns the validated structured value without JSON-stringifying it', async () => {
    const value = { answer: 'ok', nested: [1, 2] };
    const { scope } = scopeForTurn(value);
    const run = await runAgentTurn(scope, { kind: 'prompt', prompt: 'return data' }, {
      signal: new AbortController().signal,
      requiresStructuredOutput: true,
      structuredSchema: SCHEMA,
    });

    await expect(run.completion).resolves.toMatchObject({
      output: value,
      summary: JSON.stringify(value),
    });
  });

  it('reports only the child turn usage delta', async () => {
    const before: TokenUsage = { inputOther: 100, output: 20, inputCacheRead: 4, inputCacheCreation: 1 };
    const after: TokenUsage = { inputOther: 130, output: 26, inputCacheRead: 9, inputCacheCreation: 3 };
    const { scope } = scopeForTurn({ answer: 'ok' }, before, after);
    const run = await runAgentTurn(scope, { kind: 'prompt', prompt: 'return data' }, {
      signal: new AbortController().signal,
      requiresStructuredOutput: true,
      structuredSchema: SCHEMA,
    });

    await expect(run.completion).resolves.toMatchObject({
      usage: { inputOther: 30, output: 6, inputCacheRead: 5, inputCacheCreation: 2 },
    });
  });

  it('rejects with a typed failure when structured retries are exhausted', async () => {
    const { scope, enqueueCount } = scopeForTurn({ answer: 42 });
    const run = await runAgentTurn(scope, { kind: 'prompt', prompt: 'return data' }, {
      signal: new AbortController().signal,
      requiresStructuredOutput: true,
      structuredSchema: SCHEMA,
    });

    await expect(run.completion).rejects.toMatchObject({
      name: 'StructuredOutputValidationError',
      code: 'workflow.structured_output_failed',
    });
    expect(enqueueCount.value).toBeGreaterThan(1);
    await expect(run.completion).rejects.toBeInstanceOf(StructuredOutputValidationError);
  });
});
