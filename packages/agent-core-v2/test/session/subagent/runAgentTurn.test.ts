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
import { IAgentProfileService } from '#/agent/profile/profile';
import { IAgentToolRegistryService } from '#/agent/toolRegistry/toolRegistry';
import { STRUCTURED_OUTPUT_TOOL_NAME } from '#/agent/workflow/structured/structuredOutputTool';
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
});
