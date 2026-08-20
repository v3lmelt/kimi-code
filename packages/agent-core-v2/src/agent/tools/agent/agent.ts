/**
 * `tools` domain — `ISubagentTool` contract (the `Agent` tool).
 *
 * Public contract of the `Agent` collaboration tool: the input/output zod
 * schemas the model-facing parameters are derived from, the tool-owned
 * constants (default profile name, resumed-agent label, fixed output
 * messages), and the `ISubagentTool` DI decorator that the implementation
 * registers against via `registerAgentToolService`. Bound at Agent scope.
 */

import { z } from 'zod';

import { createDecorator } from '#/_base/di/instantiation';
import { type AgentTool } from '#/tool/toolContract';

export const DEFAULT_PROFILE_NAME = 'coder';
export const RESUMED_LABEL = 'subagent';

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

export const SubagentToolInputSchema = z.preprocess(
  (input) => {
    if (typeof input !== 'object' || input === null || Array.isArray(input)) {
      return input;
    }
    const record = input as Record<string, unknown>;
    const normalized = { ...record };
    const hasResumeId =
      typeof normalized['resume'] === 'string' && normalized['resume'].trim().length > 0;
    const hasSubagentType =
      typeof normalized['subagent_type'] === 'string' && normalized['subagent_type'].length > 0;
    if (!hasSubagentType && !hasResumeId) {
      normalized['subagent_type'] = DEFAULT_PROFILE_NAME;
    } else if (!hasSubagentType) {
      delete normalized['subagent_type'];
    }
    return normalized;
  },
  z.object({
    prompt: z.string().describe('Full task prompt for the subagent'),
    description: z.string().describe('Short task description (3-5 words) for UI display'),
    task_name: z
      .string()
      .optional()
      .describe('Stable task name used as the child segment of its canonical task path.'),
    context_policy: ContextPolicySchema
      .optional()
      .describe('Explicit context inherited from the caller: fresh, full, lastN, or digest.'),
    subagent_type: z
      .string()
      .optional()
      .describe(
        'One of the available agent types (see "Available agent types" in this tool description). Defaults to "coder" when omitted.',
      ),
    resume: z
      .string()
      .optional()
      .describe(
        'Optional agent ID to resume instead of creating a new instance. When set, do not also pass subagent_type — the resumed agent keeps its own type, and supplying both is rejected.',
      ),
    run_in_background: z
      .boolean()
      .optional()
      .describe(
        'If true, return immediately without waiting for completion. Prefer false unless the task can run independently and there is a clear benefit to not waiting.',
      ),
    model: z
      .string()
      .optional()
      .describe(
        'Which model to run the subagent on: any model alias configured in [models] (see "Available models" in this tool description), or the special values "secondary" (the configured secondary model, the default when one is set), "primary" (the main model you are running on, for hard quality-sensitive tasks), and "inherit" (your own model, the default otherwise). This choice overrides the selected agent type\'s model_preference. Ignored when resuming — resumed subagents keep their own model.',
      ),
  }),
);

export type SubagentToolInput = z.infer<typeof SubagentToolInputSchema>;

/**
 * The pre-coordination Agent contract.  Keeping this schema separate lets the
 * experimental fields stay out of the wire signature while the flag is off.
 */
export const LegacySubagentToolInputSchema = z.preprocess(
  (input) => {
    if (typeof input !== 'object' || input === null || Array.isArray(input)) {
      return input;
    }
    const record = input as Record<string, unknown>;
    const normalized = { ...record };
    const hasResumeId =
      typeof normalized['resume'] === 'string' && normalized['resume'].trim().length > 0;
    const hasSubagentType =
      typeof normalized['subagent_type'] === 'string' && normalized['subagent_type'].length > 0;
    if (!hasSubagentType && !hasResumeId) {
      normalized['subagent_type'] = DEFAULT_PROFILE_NAME;
    } else if (!hasSubagentType) {
      delete normalized['subagent_type'];
    }
    return normalized;
  },
  z.object({
    prompt: z.string().describe('Full task prompt for the subagent'),
    description: z.string().describe('Short task description (3-5 words) for UI display'),
    subagent_type: z
      .string()
      .optional()
      .describe(
        'One of the available agent types (see "Available agent types" in this tool description). Defaults to "coder" when omitted.',
      ),
    resume: z
      .string()
      .optional()
      .describe(
        'Optional agent ID to resume instead of creating a new instance. When set, do not also pass subagent_type — the resumed agent keeps its own type, and supplying both is rejected.',
      ),
    run_in_background: z
      .boolean()
      .optional()
      .describe(
        'If true, return immediately without waiting for completion. Prefer false unless the task can run independently and there is a clear benefit to not waiting.',
      ),
    model: z
      .string()
      .optional()
      .describe(
        'Which model to run the subagent on: any model alias configured in [models] (see "Available models" in this tool description), or the special values "secondary" (the configured secondary model, the default when one is set), "primary" (the main model you are running on, for hard quality-sensitive tasks), and "inherit" (your own model, the default otherwise). This choice overrides the selected agent type\'s model_preference. Ignored when resuming — resumed subagents keep their own model.',
      ),
  }),
);


export const SubagentToolOutputSchema = z.object({
  result: z.string().describe('Aggregated text output from the subagent'),
  usage: z
    .object({
      input: z.number().int().nonnegative(),
      output: z.number().int().nonnegative(),
      cache_read: z.number().int().nonnegative().optional(),
      cache_write: z.number().int().nonnegative().optional(),
    })
    .describe('Cumulative token usage'),
});

export type SubagentToolOutput = z.infer<typeof SubagentToolOutputSchema>;

export const BACKGROUND_AGENT_UNAVAILABLE =
  'Background agent execution is not available for this agent because TaskList, TaskOutput, and TaskStop are not enabled.';
export const RESUME_WITH_TYPE_UNAVAILABLE =
  'Cannot set subagent_type when resuming an existing agent. Resume by agent id only.';
export const USER_INTERRUPTED_SUBAGENT_MESSAGE =
  'The subagent was stopped before it finished by user.';
export const SUBAGENT_STOPPED_MESSAGE = 'The subagent was stopped before it finished.';


export interface ISubagentTool extends AgentTool<SubagentToolInput> {
  readonly _serviceBrand: undefined;
}

export const ISubagentTool = createDecorator<ISubagentTool>('subagentTool');
