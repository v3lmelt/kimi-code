import { createDecorator } from "#/_base/di/instantiation";

export type UltracodeTrigger = 'manual' | 'keyword';

export interface IAgentUltracodeService {
  readonly _serviceBrand: undefined;

  readonly isActive: boolean;
  enter(trigger: UltracodeTrigger): void;
  exit(): void;
}

export const IAgentUltracodeService = createDecorator<IAgentUltracodeService>(
  'agentUltracodeService',
);
