import { createDecorator } from "#/_base/di/instantiation";

export type PlanData = null | {
  readonly id: string;
  readonly content: string;
  readonly path: string;
};

export type PlanFilePath = string | null;

export interface IAgentPlanService {
  readonly _serviceBrand: undefined;

  enter(id?: string, createFile?: boolean): Promise<void>;
  cancel(id?: string): void;
  clear(): Promise<void>;
  exit(id?: string): void;
  recordRevision(content?: string): Promise<void>;
  status(): Promise<PlanData>;
  /**
   * Synchronous, file-system-free read of the current plan file path. Returns
   * `null` when plan mode is inactive. Hot-path callers that only need the
   * path or the active flag must use this instead of `status()`, which reads
   * the plan file from disk on every call.
   */
  currentPlanFilePath(): PlanFilePath;
}

export const IAgentPlanService =
  createDecorator<IAgentPlanService>('agentPlanService');
