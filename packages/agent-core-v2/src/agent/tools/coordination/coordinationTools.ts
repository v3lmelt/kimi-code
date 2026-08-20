/**
 * `tools` domain — Agent-scope coordination tools.
 *
 * Exposes the experimental task-tree commands over the ordinary Agent tool
 * registry: `followup_task`, `list_agents`, `interrupt_agent`, and
 * `wait_agent`. Address fields accept either a canonical task path or the
 * legacy wire-compatible agent id; the Session coordination service performs
 * all same-tree validation and lifecycle work. Bound at Agent scope.
 */

import { z } from 'zod';

import { createDecorator, type ServicesAccessor } from '#/_base/di/instantiation';
import { IFlagService } from '#/app/flag/flag';
import { IAgentScopeContext } from '#/agent/scopeContext/scopeContext';
import { IAgentCoordinationService } from '#/session/agentCoordination/agentCoordination';
import { AGENT_COORDINATION_FLAG_ID } from '#/session/agentCoordination/flag';
import { registerAgentToolService } from '#/agent/toolRegistry/toolContribution';
import { toInputJsonSchema } from '#/tool/input-schema';
import type { AgentTool, ExecutableToolContext, ExecutableToolResult, ToolExecution } from '#/tool/toolContract';

const AddressInputSchema = z.preprocess(
  (input) => {
    if (typeof input !== 'object' || input === null || Array.isArray(input)) return input;
    const record = input as Record<string, unknown>;
    return {
      ...record,
      to: record['to'] ?? record['task_path'] ?? record['agent_id'],
    };
  },
  z.object({
    to: z.string().min(1).describe('Canonical task path or legacy agent id.'),
  }),
);

const ContextPolicySchema = z.preprocess(
  (input) => {
    if (typeof input !== 'object' || input === null || Array.isArray(input)) return input;
    const record = input as Record<string, unknown>;
    if (record['kind'] === 'lastN' && record['count'] === undefined && typeof record['n'] === 'number') {
      return { ...record, count: record['n'] };
    }
    return input;
  },
  z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('fresh') }),
    z.object({ kind: z.literal('full') }),
    z.object({ kind: z.literal('lastN'), count: z.number().int().nonnegative() }),
    z.object({ kind: z.literal('digest'), maxChars: z.number().int().positive().optional() }),
  ]),
);

const FollowupInputSchema = AddressInputSchema.and(
  z.object({
    prompt: z.string().min(1).describe('Prompt for the target follow-up turn.'),
    context_policy: ContextPolicySchema.optional(),
  }),
);

const WaitInputSchema = AddressInputSchema.and(
  z.object({
    timeout_ms: z.number().int().positive().optional(),
  }),
);

export type FollowupTaskToolInput = z.infer<typeof FollowupInputSchema>;
export type InterruptAgentToolInput = z.infer<typeof AddressInputSchema>;
export type WaitAgentToolInput = z.infer<typeof WaitInputSchema>;

export interface IFollowupTaskTool extends AgentTool<FollowupTaskToolInput> {
  readonly _serviceBrand: undefined;
}

export interface IListAgentsTool extends AgentTool<Record<string, never>> {
  readonly _serviceBrand: undefined;
}

export interface IInterruptAgentTool extends AgentTool<InterruptAgentToolInput> {
  readonly _serviceBrand: undefined;
}

export interface IWaitAgentTool extends AgentTool<WaitAgentToolInput> {
  readonly _serviceBrand: undefined;
}

export const IFollowupTaskTool = createDecorator<IFollowupTaskTool>('followupTaskTool');
export const IListAgentsTool = createDecorator<IListAgentsTool>('listAgentsTool');
export const IInterruptAgentTool = createDecorator<IInterruptAgentTool>('interruptAgentTool');
export const IWaitAgentTool = createDecorator<IWaitAgentTool>('waitAgentTool');

const FOLLOWUP_PARAMETERS = toInputJsonSchema(FollowupInputSchema);
const ADDRESS_PARAMETERS = toInputJsonSchema(AddressInputSchema);
const WAIT_PARAMETERS = toInputJsonSchema(WaitInputSchema);

function errorResult(error: unknown): ExecutableToolResult {
  return {
    output: error instanceof Error ? error.message : String(error),
    isError: true,
  };
}

function enabled(accessor: ServicesAccessor): boolean {
  return accessor.get(IFlagService).enabled(AGENT_COORDINATION_FLAG_ID);
}

export class FollowupTaskTool implements IFollowupTaskTool {
  declare readonly _serviceBrand: undefined;
  readonly name = 'followup_task' as const;

  constructor(
    @IAgentCoordinationService private readonly coordination: IAgentCoordinationService,
    @IAgentScopeContext scopeContext: IAgentScopeContext,
  ) {
    this.callerAgentId = scopeContext.agentId;
  }

  private readonly callerAgentId: string;

  get description(): string {
    return 'Start a follow-up turn on an idle or completed agent in this task tree.';
  }

  get parameters(): Record<string, unknown> {
    return FOLLOWUP_PARAMETERS;
  }

  resolveExecution(args: FollowupTaskToolInput): ToolExecution {
    return {
      description: `Starting follow-up task on "${args.to}"`,
      approvalRule: this.name,
      execute: (ctx) => this.execute(args, ctx),
    };
  }

  private async execute(
    args: FollowupTaskToolInput,
    context: ExecutableToolContext,
  ): Promise<ExecutableToolResult> {
    try {
      const result = await this.coordination.followupTask(
        this.callerAgentId,
        args.to,
        args.prompt,
        context.signal,
        args.context_policy,
      );
      return {
        output: `Follow-up completed for ${result.task.taskPath} (${result.task.agentId}).\n${result.summary}`,
      };
    } catch (error) {
      return errorResult(error);
    }
  }
}

export class ListAgentsTool implements IListAgentsTool {
  declare readonly _serviceBrand: undefined;
  readonly name = 'list_agents' as const;

  constructor(
    @IAgentCoordinationService private readonly coordination: IAgentCoordinationService,
    @IAgentScopeContext scopeContext: IAgentScopeContext,
  ) {
    this.callerAgentId = scopeContext.agentId;
  }

  private readonly callerAgentId: string;

  get description(): string {
    return 'List agents in the current session task tree with paths, parentage, and state.';
  }

  get parameters(): Record<string, unknown> {
    return { type: 'object', properties: {}, additionalProperties: false };
  }

  resolveExecution(): ToolExecution {
    return {
      description: 'Listing agents in the current task tree',
      approvalRule: this.name,
      execute: async () => ({ output: JSON.stringify(this.coordination.list(this.callerAgentId)) }),
    };
  }
}

export class InterruptAgentTool implements IInterruptAgentTool {
  declare readonly _serviceBrand: undefined;
  readonly name = 'interrupt_agent' as const;

  constructor(
    @IAgentCoordinationService private readonly coordination: IAgentCoordinationService,
    @IAgentScopeContext scopeContext: IAgentScopeContext,
  ) {
    this.callerAgentId = scopeContext.agentId;
  }

  private readonly callerAgentId: string;

  get description(): string {
    return 'Interrupt a running agent in the current session task tree.';
  }

  get parameters(): Record<string, unknown> {
    return ADDRESS_PARAMETERS;
  }

  resolveExecution(args: InterruptAgentToolInput): ToolExecution {
    return {
      description: `Interrupting agent "${args.to}"`,
      approvalRule: this.name,
      execute: async () => {
        try {
          const task = await this.coordination.interrupt(this.callerAgentId, args.to);
          return { output: `Interrupted ${task.taskPath} (${task.agentId}).` };
        } catch (error) {
          return errorResult(error);
        }
      },
    };
  }
}

export class WaitAgentTool implements IWaitAgentTool {
  declare readonly _serviceBrand: undefined;
  readonly name = 'wait_agent' as const;

  constructor(
    @IAgentCoordinationService private readonly coordination: IAgentCoordinationService,
    @IAgentScopeContext scopeContext: IAgentScopeContext,
  ) {
    this.callerAgentId = scopeContext.agentId;
  }

  private readonly callerAgentId: string;

  get description(): string {
    return 'Wait for a running agent to settle and return its current task state.';
  }

  get parameters(): Record<string, unknown> {
    return WAIT_PARAMETERS;
  }

  resolveExecution(args: WaitAgentToolInput): ToolExecution {
    return {
      description: `Waiting for agent "${args.to}"`,
      approvalRule: this.name,
      execute: async () => {
        try {
          const task = await this.coordination.wait(this.callerAgentId, args.to, {
            timeoutMs: args.timeout_ms,
          });
          return { output: JSON.stringify(task) };
        } catch (error) {
          return errorResult(error);
        }
      },
    };
  }
}

const coordinationToolWhen = { when: enabled };
registerAgentToolService(IFollowupTaskTool, FollowupTaskTool, {
  name: 'followup_task',
  domain: 'agentCoordination',
  ...coordinationToolWhen,
});
registerAgentToolService(IListAgentsTool, ListAgentsTool, {
  name: 'list_agents',
  domain: 'agentCoordination',
  ...coordinationToolWhen,
});
registerAgentToolService(IInterruptAgentTool, InterruptAgentTool, {
  name: 'interrupt_agent',
  domain: 'agentCoordination',
  ...coordinationToolWhen,
});
registerAgentToolService(IWaitAgentTool, WaitAgentTool, {
  name: 'wait_agent',
  domain: 'agentCoordination',
  ...coordinationToolWhen,
});
