/**
 * `plan` domain — plan-mode context injection.
 *
 * Owns the `plan_mode` context-injection provider: while plan mode is active it
 * emits the full / sparse / re-entry reminders (deduped against recent history),
 * and on the first inject after deactivation it emits the exit reminder. It reads
 * the live plan state through the synchronous `IAgentPlanService.currentPlanFilePath()`
 * and only falls back to the file-reading `IAgentPlanService.status()` on the
 * active transition (where the re-entry/full reminder split needs the content);
 * the recent history comes through `IAgentContextMemoryService`, so no
 * derived-state closures are needed.
 * The plain-data state (`wasActive`) is registered into `agentState`
 * (`IAgentStateService`) and read/written through it.
 */

import { Service } from '#/_base/di/service';
import { defineState } from '#/_base/state/stateRegistry';
import { IAgentContextInjectorService } from '#/agent/contextInjector/contextInjector';
import { IAgentContextMemoryService } from '#/agent/contextMemory/contextMemory';
import type { ContextMessage } from '#/agent/contextMemory/types';
import { IAgentPlanService } from '#/features/plan/plan';
import type { PlanFilePath } from '#/features/plan/plan';
import { IAgentStateService } from '#/agent/state/agentState';
import PLAN_MODE_EXIT_REMINDER from './plan-mode-exit-reminder.md?raw';
import PLAN_MODE_FULL_REMINDER from './plan-mode-full-reminder.md?raw';
import PLAN_MODE_INLINE_FULL_REMINDER from './plan-mode-inline-full-reminder.md?raw';
import PLAN_MODE_INLINE_REENTRY_REMINDER from './plan-mode-inline-reentry-reminder.md?raw';
import PLAN_MODE_INLINE_SPARSE_REMINDER from './plan-mode-inline-sparse-reminder.md?raw';
import PLAN_MODE_REENTRY_REMINDER from './plan-mode-reentry-reminder.md?raw';
import PLAN_MODE_SPARSE_REMINDER from './plan-mode-sparse-reminder.md?raw';

const PLAN_MODE_DEDUP_MIN_TURNS = 2;
const PLAN_MODE_FULL_REFRESH_TURNS = 5;
const PLAN_MODE_INJECTION_VARIANT = 'plan_mode';

export const planWasActiveKey = defineState<boolean>('plan.wasActive', () => false);

export class PlanModeInjection extends Service {
  constructor(
    @IAgentContextInjectorService dynamicInjector: IAgentContextInjectorService,
    @IAgentPlanService private readonly plan: IAgentPlanService,
    @IAgentContextMemoryService private readonly context: IAgentContextMemoryService,
    @IAgentStateService private readonly states: IAgentStateService,
  ) {
    super();
    this.states.register(planWasActiveKey);

    this._register(
      dynamicInjector.register(PLAN_MODE_INJECTION_VARIANT, async ({ lastInjectedAt: injectedAt }) => {
        // The steady-state branches only need the plan file path, so read it
        // from the replayed wire state synchronously — no disk I/O per step.
        const planFilePath = this.plan.currentPlanFilePath();
        if (planFilePath === null) {
          if (!this.states.get(planWasActiveKey)) return undefined;
          this.states.set(planWasActiveKey, false);
          return PLAN_MODE_EXIT_REMINDER;
        }
        if (!this.states.get(planWasActiveKey)) {
          this.states.set(planWasActiveKey, true);
          // Only the active transition needs the plan content, to pick the
          // re-entry reminder over the full reminder. Read it exactly once.
          const data = await this.plan.status();
          if (data === null) {
            this.states.set(planWasActiveKey, false);
            return PLAN_MODE_EXIT_REMINDER;
          }
          if (data.content.trim().length > 0) {
            return reentryReminder(planFilePath);
          }
          return fullReminder(planFilePath);
        }
        const variant = planModeReminderVariant(injectedAt, this.context.get());
        if (variant === 'full') return fullReminder(planFilePath);
        if (variant === 'sparse') return sparseReminder(planFilePath);
        return undefined;
      }),
    );
  }
}

type PlanModeReminderVariant = 'full' | 'sparse';

function planModeReminderVariant(
  injectedAt: number | null,
  history: readonly ContextMessage[],
): PlanModeReminderVariant | null {
  if (injectedAt === null) return 'full';
  let assistantTurnsSince = 0;
  for (let i = injectedAt + 1; i < history.length; i++) {
    const message = history[i];
    if (message === undefined) continue;
    if (message.role === 'assistant') {
      assistantTurnsSince += 1;
      continue;
    }
    if (message.role === 'user') {
      return 'full';
    }
  }
  if (assistantTurnsSince >= PLAN_MODE_FULL_REFRESH_TURNS) return 'full';
  if (assistantTurnsSince >= PLAN_MODE_DEDUP_MIN_TURNS) return 'sparse';
  return null;
}

function withPlanFileFooter(body: string, planFilePath: PlanFilePath): string {
  if (planFilePath === null || planFilePath.length === 0) return body;
  return `${body}\n\nPlan file: ${planFilePath}`;
}

function fullReminder(planFilePath: PlanFilePath): string {
  if (planFilePath === null || planFilePath.length === 0) {
    return PLAN_MODE_INLINE_FULL_REMINDER;
  }
  return withPlanFileFooter(PLAN_MODE_FULL_REMINDER, planFilePath);
}

function sparseReminder(planFilePath: PlanFilePath): string {
  if (planFilePath === null || planFilePath.length === 0) {
    return PLAN_MODE_INLINE_SPARSE_REMINDER;
  }
  return withPlanFileFooter(PLAN_MODE_SPARSE_REMINDER, planFilePath);
}

function reentryReminder(planFilePath: PlanFilePath): string {
  if (planFilePath === null || planFilePath.length === 0) {
    return PLAN_MODE_INLINE_REENTRY_REMINDER;
  }
  return withPlanFileFooter(PLAN_MODE_REENTRY_REMINDER, planFilePath);
}
