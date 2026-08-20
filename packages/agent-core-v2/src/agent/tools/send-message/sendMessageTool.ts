/**
 * `tools` domain — `ISendMessageTool` implementation (the `SendMessage` tool).
 *
 * The parent→subagent message channel: validates that the target exists, is a
 * subagent spawned by the caller, and is still running, then queues the
 * message into the target agent's loop as a `MessageStepRequest`. The loop
 * drains queued requests one batch per round, so the message materializes as
 * a user message at the start of the target's next round — while it is busy,
 * the message simply waits in the queue.
 *
 * Validation failures (unknown / finished / not-a-subagent / not-owned
 * targets) are returned as error tool results with a human-readable message,
 * following the `Agent` tool's error convention. The message body is capped
 * at `SEND_MESSAGE_MAX_CHARS` and injected with a `[Message from parent]`
 * prefix plus the `send_message` system-trigger origin so the target can
 * distinguish it from user input.
 *
 * Registered via the module-level `registerAgentToolService(ISendMessageTool,
 * SendMessageTool)` at the bottom of this file — the same "import = register"
 * pattern used by every agent tool.
 */

import { Error2, ErrorCodes } from '#/errors';
import { type ContextMessage } from '#/agent/contextMemory/types';
import { newMessageId } from '#/agent/contextMemory/messageId';
import { IAgentLoopService } from '#/agent/loop/loop';
import { MessageStepRequest } from '#/agent/loop/stepRequest';
import { IAgentScopeContext } from '#/agent/scopeContext/scopeContext';
import type { IAgentScopeHandle } from '#/_base/di/scope';
import { IAgentLifecycleService } from '#/session/agentLifecycle/agentLifecycle';
import { IAgentCoordinationService } from '#/session/agentCoordination/agentCoordination';
import {
  isSubagentMeta,
  subagentParentAgentId,
} from '#/session/agentLifecycle/subagentMetadata';
import { ISessionMetadata } from '#/session/sessionMetadata/sessionMetadata';
import { toInputJsonSchema } from '#/tool/input-schema';
import type { ExecutableToolContext, ExecutableToolResult, ToolExecution } from '#/tool/toolContract';
import { registerAgentToolService } from '#/agent/toolRegistry/toolContribution';

import SEND_MESSAGE_DESCRIPTION from './send-message.md?raw';
import {
  ISendMessageTool,
  MESSAGE_DELIVERED_MESSAGE,
  MESSAGE_TOO_LONG_MESSAGE,
  SEND_MESSAGE_MAX_CHARS,
  SEND_MESSAGE_ORIGIN,
  SEND_MESSAGE_PREFIX,
  SEND_MESSAGE_TOOL_NAME,
  SendMessageToolInputSchema,
  type SendMessageToolInput,
} from './sendMessage';

const SEND_MESSAGE_TOOL_PARAMETERS = toInputJsonSchema(SendMessageToolInputSchema);

function errorResult(message: string): ExecutableToolResult {
  return { output: message, isError: true };
}

export class SendMessageTool implements ISendMessageTool {
  declare readonly _serviceBrand: undefined;
  readonly name: string = SEND_MESSAGE_TOOL_NAME;

  get description(): string {
    return SEND_MESSAGE_DESCRIPTION;
  }

  get parameters(): Record<string, unknown> {
    return SEND_MESSAGE_TOOL_PARAMETERS;
  }

  private readonly callerAgentId: string;

  constructor(
    @IAgentLifecycleService private readonly lifecycle: IAgentLifecycleService,
    @ISessionMetadata private readonly sessionMetadata: ISessionMetadata,
    @IAgentScopeContext scopeContext: IAgentScopeContext,
    @IAgentCoordinationService private readonly coordination?: IAgentCoordinationService,
  ) {
    this.callerAgentId = scopeContext.agentId;
  }

  resolveExecution(args: SendMessageToolInput): ToolExecution {
    return {
      description: `Delivering a message to subagent "${args.to}"`,
      approvalRule: this.name,
      execute: (ctx) => this.execution(args, ctx),
    };
  }

  private buildMessage(text: string): ContextMessage {
    return {
      id: newMessageId(),
      role: 'user',
      content: [{ type: 'text', text: `${SEND_MESSAGE_PREFIX} ${text}` }],
      toolCalls: [],
      origin: SEND_MESSAGE_ORIGIN,
    };
  }

  private async validateTarget(agentId: string): Promise<IAgentScopeHandle> {
    const handle = this.lifecycle.get(agentId);
    if (handle === undefined) {
      throw new Error2(ErrorCodes.AGENT_NOT_FOUND, `Agent instance "${agentId}" does not exist`, {
        details: { agentId },
      });
    }
    const meta = (await this.sessionMetadata.read()).agents?.[agentId];
    if (!isSubagentMeta(meta)) {
      throw new Error2(
        ErrorCodes.AGENT_NOT_A_SUBAGENT,
        `Agent instance "${agentId}" is not a subagent`,
        { details: { agentId } },
      );
    }
    if (subagentParentAgentId(meta) !== this.callerAgentId) {
      throw new Error2(
        ErrorCodes.AGENT_NOT_OWNED,
        `Agent instance "${agentId}" does not belong to this parent agent`,
        { details: { agentId, callerAgentId: this.callerAgentId } },
      );
    }
    if (handle.accessor.get(IAgentLoopService).status().state !== 'running') {
      throw new Error2(
        ErrorCodes.AGENT_NOT_RUNNING,
        `Agent instance "${agentId}" has already finished and cannot receive messages; resume it with the Agent tool first`,
        { details: { agentId } },
      );
    }
    return handle;
  }

  private async execution(
    args: SendMessageToolInput,
    { signal }: ExecutableToolContext,
  ): Promise<ExecutableToolResult> {
    try {
      signal.throwIfAborted();
      if (args.message.length > SEND_MESSAGE_MAX_CHARS) {
        return errorResult(MESSAGE_TOO_LONG_MESSAGE(SEND_MESSAGE_MAX_CHARS));
      }
      if (this.coordination?.isEnabled() === true) {
        await this.coordination.sendMessage(this.callerAgentId, args.to, args.message);
        return { output: MESSAGE_DELIVERED_MESSAGE(args.to) };
      }
      const handle = await this.validateTarget(args.to);
      handle.accessor
        .get(IAgentLoopService)
        .enqueue(
          new MessageStepRequest(this.buildMessage(args.message), {
            kind: 'send_message',
            mergeable: true,
            turnScoped: false,
          }),
        );
      return { output: MESSAGE_DELIVERED_MESSAGE(args.to) };
    } catch (error) {
      return errorResult(
        error instanceof Error ? error.message : `Failed to deliver message: ${String(error)}`,
      );
    }
  }
}

registerAgentToolService(ISendMessageTool, SendMessageTool, {
  name: SEND_MESSAGE_TOOL_NAME,
  domain: 'subagent',
});
