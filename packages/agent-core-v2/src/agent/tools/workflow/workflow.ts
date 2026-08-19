/**
 * `tools` domain — `IWorkflowTool` contract (the `Workflow` tool).
 *
 * Public contract of the `Workflow` collaboration tool: the input zod schema
 * the model-facing parameters are derived from (re-exported from the
 * `workflow` domain's single source of truth, `#/agent/workflow/types`), the
 * tool name constant, and the `IWorkflowTool` DI decorator that the
 * implementation registers against via `registerAgentToolService`. Bound at
 * Agent scope.
 */

import { createDecorator } from '#/_base/di/instantiation';
import { type AgentTool } from '#/tool/toolContract';
import { WorkflowToolInputSchema } from '#/agent/workflow/types';
import type { WorkflowToolInput } from '#/agent/workflow/types';

export { WorkflowToolInputSchema };
export type { WorkflowToolInput };

/** The tool's model-facing name. */
export const WORKFLOW_TOOL_NAME = 'Workflow' as const;

/** Default ceiling on the token budget the `budget` global reports as `total`. */
export const WORKFLOW_DEFAULT_TOKEN_BUDGET = 1_000_000;

export interface IWorkflowTool extends AgentTool<WorkflowToolInput> {
  readonly _serviceBrand: undefined;
}

export const IWorkflowTool = createDecorator<IWorkflowTool>('workflowTool');
