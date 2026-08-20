/**
 * `workflow` domain — contributes the opt-in flag for verified DAG Workflow
 * execution while the existing JavaScript Workflow entry remains compatible.
 */

import { registerFlagDefinition, type FlagDefinitionInput } from '#/app/flag/flagRegistry';

export const WORKFLOW_DAG_FLAG_ID = 'workflow_dag';

export const workflowDagFlag: FlagDefinitionInput = {
  id: WORKFLOW_DAG_FLAG_ID,
  title: 'Workflow DAG execution',
  description: 'Enable explicit WorkflowGraph authoring and resumable DAG execution.',
  env: 'KIMI_CODE_EXPERIMENTAL_WORKFLOW_DAG',
  default: false,
  surface: 'both',
};

registerFlagDefinition(workflowDagFlag);
