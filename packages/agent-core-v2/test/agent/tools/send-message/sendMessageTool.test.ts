/**
 * `tools.sendMessage` — unit tests for the `SendMessage` tool contract and
 * the loop-level delivery mechanism.
 *
 * Part 1 covers the tool's validation surface with mocked lifecycle /
 * metadata / loop boundaries (delivery to a running subagent, and the
 * not-found / not-a-subagent / not-owned / finished / too-long rejections).
 * Part 2 drives a real loop through the test harness to verify the queued
 * message materializes as a user message at the start of the target's next
 * round — both while the agent is idle (standalone queue → next turn) and
 * while it is busy (queued during a tool step → next round).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createControlledPromise } from '@antfu/utils';

import { IAgentLoopService } from '#/agent/loop/loop';
import { MessageStepRequest } from '#/agent/loop/stepRequest';
import { IAgentScopeContext } from '#/agent/scopeContext/scopeContext';
import { IAgentLifecycleService } from '#/session/agentLifecycle/agentLifecycle';
import { ISessionMetadata, type AgentMeta } from '#/session/sessionMetadata/sessionMetadata';
import { IAgentToolRegistryService } from '#/agent/toolRegistry/toolRegistry';
import { SEND_MESSAGE_ORIGIN, SEND_MESSAGE_PREFIX } from '#/agent/tools/send-message/sendMessage';
import { SendMessageTool } from '#/agent/tools/send-message/sendMessageTool';
import type { IAgentScopeHandle } from '#/_base/di/scope';
import type { ExecutableTool, ExecutableToolContext } from '#/tool/toolContract';

import { createTestAgent, permissionModeServices } from '../../../harness';

const TOOL_CONTEXT: ExecutableToolContext = {
  turnId: 0,
  toolCallId: 'call_send_1',
  signal: new AbortController().signal,
};

function subagentMeta(parentAgentId: string): AgentMeta {
  return { type: 'sub', parentAgentId, labels: { parentAgentId } };
}

describe('SendMessageTool', () => {
  let enqueue: ReturnType<typeof vi.fn>;
  let loopState: 'running' | 'idle';
  let targets: Record<string, IAgentScopeHandle>;
  let agents: Record<string, AgentMeta>;
  let tool: SendMessageTool;

  beforeEach(() => {
    enqueue = vi.fn();
    loopState = 'running';
    targets = {};
    agents = {
      main: { type: 'main' },
      'agent-1': subagentMeta('main'),
      'agent-2': subagentMeta('other'),
    };
    const lifecycle = {
      get: (agentId: string) => targets[agentId],
    } as unknown as IAgentLifecycleService;
    const metadata = {
      read: async () => ({ agents }),
    } as unknown as ISessionMetadata;
    const scopeContext = { agentId: 'main' } as unknown as IAgentScopeContext;
    tool = new SendMessageTool(lifecycle, metadata, scopeContext);

    targets['main'] = {
      id: 'main',
      accessor: { get: () => undefined },
    } as unknown as IAgentScopeHandle;
    targets['agent-1'] = {
      id: 'agent-1',
      accessor: {
        get: (id: unknown) =>
          id === IAgentLoopService
            ? {
                status: () => ({ state: loopState }),
                enqueue,
              }
            : undefined,
      },
    } as unknown as IAgentScopeHandle;
  });

  async function runTool(args: { readonly to: string; readonly message: string }) {
    const execution = tool.resolveExecution(args);
    if (execution.isError === true) throw new Error('execution should not be an error');
    return execution.execute(TOOL_CONTEXT);
  }

  it('queues a parent-prefixed user message into the running target loop', async () => {
    const result = await runTool({ to: 'agent-1', message: 'please switch to plan mode' });

    expect(result.isError).toBeFalsy();
    expect(result.output).toContain('agent-1');
    expect(enqueue).toHaveBeenCalledTimes(1);

    const request = enqueue.mock.calls[0]![0] as MessageStepRequest;
    expect(request).toBeInstanceOf(MessageStepRequest);
    expect(request.kind).toBe('send_message');
    expect(request.mergeable).toBe(true);
    expect(request.turnScoped).toBe(false);

    const [message] = request.resolveContextMessages();
    expect(message).toBeDefined();
    expect(message!.role).toBe('user');
    expect(message!.content).toEqual([
      { type: 'text', text: `${SEND_MESSAGE_PREFIX} please switch to plan mode` },
    ]);
    expect(message!.origin).toEqual(SEND_MESSAGE_ORIGIN);
  });

  it('rejects an unknown target agent', async () => {
    const result = await runTool({ to: 'ghost', message: 'hello' });

    expect(result.isError).toBe(true);
    expect(String(result.output)).toContain('does not exist');
    expect(enqueue).not.toHaveBeenCalled();
  });

  it('rejects the main agent as a delivery target', async () => {
    const result = await runTool({ to: 'main', message: 'hello' });

    expect(result.isError).toBe(true);
    expect(String(result.output)).toContain('not a subagent');
    expect(enqueue).not.toHaveBeenCalled();
  });

  it('rejects a subagent spawned by a different parent', async () => {
    targets['agent-2'] = targets['agent-1']!;
    const result = await runTool({ to: 'agent-2', message: 'hello' });

    expect(result.isError).toBe(true);
    expect(String(result.output)).toContain('does not belong');
    expect(enqueue).not.toHaveBeenCalled();
  });

  it('rejects a target whose loop is no longer running', async () => {
    loopState = 'idle';
    const result = await runTool({ to: 'agent-1', message: 'hello' });

    expect(result.isError).toBe(true);
    expect(String(result.output)).toContain('already finished');
    expect(enqueue).not.toHaveBeenCalled();
  });

  it('rejects a message body longer than the cap', async () => {
    const result = await runTool({ to: 'agent-1', message: 'x'.repeat(8001) });

    expect(result.isError).toBe(true);
    expect(String(result.output)).toContain('too long');
    expect(enqueue).not.toHaveBeenCalled();
  });

  it('delivers a message body exactly at the cap', async () => {
    const result = await runTool({ to: 'agent-1', message: 'x'.repeat(8000) });

    expect(result.isError).toBeFalsy();
    expect(enqueue).toHaveBeenCalledTimes(1);
  });
});

describe('SendMessage delivery into a live loop', () => {
  let ctx: ReturnType<typeof createTestAgent>;
  let loop: IAgentLoopService;

  beforeEach(() => {
    ctx = createTestAgent(permissionModeServices('yolo'));
    loop = ctx.get(IAgentLoopService);
  });

  afterEach(async () => {
    try {
      await ctx.expectResumeMatches();
    } finally {
      await ctx.dispose();
    }
  });

  it('injects a message queued while idle at the start of the next turn', async () => {
    ctx.mockNextProviderResponse({
      parts: [{ type: 'text', text: 'first answer' }],
      finishReason: 'completed',
    });
    await ctx.rpc.prompt({ input: [{ type: 'text', text: 'Question 1' }] });
    await ctx.untilTurnEnd();

    loop.enqueue(
      new MessageStepRequest(
        {
          role: 'user',
          content: [{ type: 'text', text: `${SEND_MESSAGE_PREFIX} wait for me` }],
          toolCalls: [],
          origin: SEND_MESSAGE_ORIGIN,
        },
        { kind: 'send_message', mergeable: true, turnScoped: false },
      ),
    );

    ctx.mockNextProviderResponse({
      parts: [{ type: 'text', text: 'second answer' }],
      finishReason: 'completed',
    });
    await ctx.rpc.prompt({ input: [{ type: 'text', text: 'Question 2' }] });
    await ctx.untilTurnEnd();

    const inputs = ctx.llmInputs().inputs;
    expect(inputs).toHaveLength(2);
    expect(
      inputs.flatMap((input) =>
        input.history.flatMap((message) =>
          message.content.filter((part) => part.type === 'text').map((part) => part.text),
        ),
      ).join('\n'),
    ).toContain(`${SEND_MESSAGE_PREFIX} wait for me`);
  });

  it('keeps a message queued while the agent is busy and injects it on the next round', async () => {
    // First step: the model calls the slow Work tool; the message is queued
    // while that tool is still executing, so it cannot land before round 2.
    const workStarted = createControlledPromise<void>();
    const releaseWork = createControlledPromise<void>();
    const workTool: ExecutableTool = {
      name: 'Work',
      description: 'A slow tool.',
      parameters: { type: 'object', properties: {}, additionalProperties: false },
      resolveExecution: () => ({
        approvalRule: 'Work',
        execute: async () => {
          workStarted.resolve();
          await releaseWork;
          return { output: 'work done' };
        },
      }),
    };
    ctx.get(IAgentToolRegistryService).register(workTool);

    ctx.mockNextProviderResponse({
      parts: [{ type: 'function', id: 'call_work_1', name: 'Work', arguments: '{}' }],
      finishReason: 'tool_calls',
    });
    ctx.mockNextProviderResponse({
      parts: [{ type: 'text', text: 'done' }],
      finishReason: 'completed',
    });

    const prompt = ctx.rpc.prompt({ input: [{ type: 'text', text: 'Run the work' }] });
    await workStarted;
    loop.enqueue(
      new MessageStepRequest(
        {
          role: 'user',
          content: [{ type: 'text', text: `${SEND_MESSAGE_PREFIX} mid-flight note` }],
          toolCalls: [],
          origin: SEND_MESSAGE_ORIGIN,
        },
        { kind: 'send_message', mergeable: true, turnScoped: false },
      ),
    );
    releaseWork.resolve();
    await prompt;
    await ctx.untilTurnEnd();

    const inputs = ctx.llmInputs().inputs;
    expect(inputs.length).toBeGreaterThanOrEqual(2);
    expect(
      inputs.flatMap((input) =>
        input.history.flatMap((message) =>
          message.content.filter((part) => part.type === 'text').map((part) => part.text),
        ),
      ).join('\n'),
    ).toContain(`${SEND_MESSAGE_PREFIX} mid-flight note`);
  });
});
