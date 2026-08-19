/**
 * `tools` domain — `ISendMessageTool` contract (the `SendMessage` tool).
 *
 * Public contract of the parent→subagent message channel: the input zod
 * schema the model-facing parameters are derived from, the message size cap,
 * the injection origin stamped on delivered messages, the fixed output
 * messages, and the `ISendMessageTool` DI decorator that the implementation
 * registers against via `registerAgentToolService`. Bound at Agent scope.
 */

import { z } from 'zod';

import { createDecorator } from '#/_base/di/instantiation';
import type { SystemTriggerOrigin } from '#/agent/contextMemory/types';
import type { AgentTool } from '#/tool/toolContract';

export const SEND_MESSAGE_TOOL_NAME = 'SendMessage';

/** Maximum length of a delivered message body, in characters. */
export const SEND_MESSAGE_MAX_CHARS = 8000;

/** Origin stamped on messages injected into the target agent's context. */
export const SEND_MESSAGE_ORIGIN: SystemTriggerOrigin = {
  kind: 'system_trigger',
  name: 'send_message',
};

/** Prefix prepended to the message body at injection time. */
export const SEND_MESSAGE_PREFIX = '[Message from parent]';

export const SendMessageToolInputSchema = z.object({
  to: z.string().describe('Agent ID of the running subagent to message (as returned by the Agent tool)'),
  message: z.string().describe('Message text to deliver to the subagent; injected at the start of its next round'),
});

export type SendMessageToolInput = z.infer<typeof SendMessageToolInputSchema>;

export const MESSAGE_TOO_LONG_MESSAGE = (maxChars: number) =>
  `Message is too long (${maxChars} characters maximum).`;
export const MESSAGE_DELIVERED_MESSAGE = (agentId: string) =>
  `Message delivered to agent "${agentId}". It will see the message at the start of its next round.`;

export interface ISendMessageTool extends AgentTool<SendMessageToolInput> {
  readonly _serviceBrand: undefined;
}

export const ISendMessageTool = createDecorator<ISendMessageTool>('sendMessageTool');
