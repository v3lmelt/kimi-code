/**
 * `workflow.budget` — the main-loop token-budget accounting service.
 *
 * The Workflow DSL's `budget` global is backed by REAL accounting, not a
 * placeholder. `AgentWorkflowBudgetService` is an Agent-scoped counter that
 * tracks:
 *
 * - the current token target — a `+500k`-style directive parsed from the most
 *   recent user prompt (a `+`-prefixed integer with an optional `k`/`m`
 *   suffix), falling back to the configured `[workflow] token_budget` ceiling
 *   (`resolveWorkflowTokenBudget`, default `WORKFLOW_DEFAULT_TOKEN_BUDGET`);
 * - the spent total — every usage record the agent's own main loop reports
 *   through `IAgentUsageService.onDidRecord`, plus each workflow subagent's
 *   usage folded back in via `recordSubagentUsage` (the workflow runtime calls
 *   it on every subagent completion).
 *
 * `budget()` exposes the live `{ total, spent(), remaining() }` surface the
 * workflow runtime installs as the sandbox `budget` global, so a script's
 * `budget.remaining()` reflects the whole effort's real consumption — the
 * orchestrating agent's tokens and the tokens of every subagent it spawned.
 *
 * The directive is per-turn state: it is captured when a user prompt submits
 * and cleared on `turn.ended`, so each turn re-evaluates the target against
 * its own prompt. When no directive was given for the turn, `total()` resolves
 * to the configured default. Bound at Agent scope.
 */

import { Service } from '#/_base/di/service';
import { LifecycleScope } from '#/app/scopes';
import { ScopeActivation, registerScopedService } from '#/_base/di/scope';
import { IEventBus } from '#/app/event/eventBus';
import { IConfigService } from '#/app/config/config';
import { IAgentPromptService } from '#/agent/prompt/prompt';
import { IAgentUsageService } from '#/agent/usage/usage';
import { USER_PROMPT_ORIGIN } from '#/agent/contextMemory/types';
import { userPromptText } from '#/agent/ultracode/ultracodeDetector';
import { grandTotal, type TokenUsage } from '#/kosong/contract/usage';
import type { WorkflowBudget } from '#/agent/workflow/types';
import { resolveWorkflowTokenBudget } from '#/agent/tools/workflow/configSection';

import {
  IWorkflowBudgetService,
  parseTokenBudgetDirective,
} from './workflowBudget';

export class AgentWorkflowBudgetService extends Service implements IWorkflowBudgetService {
  declare readonly _serviceBrand: undefined;

  /** Real tokens consumed so far (main loop + recorded subagent usage). */
  private spentTokens = 0;
  /** Directive-derived target for the current turn; cleared on `turn.ended`. */
  private tokenTarget: number | undefined;

  constructor(
    @IAgentUsageService usage: IAgentUsageService,
    @IConfigService private readonly configService: IConfigService,
    @IAgentPromptService prompt: IAgentPromptService,
    @IEventBus eventBus: IEventBus,
  ) {
    super();
    this._register(
      usage.onDidRecord(({ usage: recorded }) => {
        this.spentTokens += grandTotal(recorded);
      }),
    );
    this._register(
      prompt.hooks.onBeforeSubmitPrompt.register('workflowBudget', async (ctx, next) => {
        if ((ctx.promptMessage.origin ?? USER_PROMPT_ORIGIN).kind !== 'user') return next();
        const parsed = parseTokenBudgetDirective(userPromptText(ctx.promptMessage.content));
        if (parsed !== undefined) this.tokenTarget = parsed;
        return next();
      }),
    );
    this._register(
      eventBus.subscribe('turn.ended', () => {
        this.tokenTarget = undefined;
      }),
    );
  }

  total(): number {
    return this.tokenTarget ?? resolveWorkflowTokenBudget(this.configService);
  }

  spent(): number {
    return this.spentTokens;
  }

  budget(): WorkflowBudget {
    const total = this.total();
    return {
      total,
      spent: () => this.spentTokens,
      remaining: () => Math.max(0, total - this.spentTokens),
    };
  }

  recordSubagentUsage(usage: TokenUsage): void {
    this.spentTokens += grandTotal(usage);
  }
}

registerScopedService(
  LifecycleScope.Agent,
  IWorkflowBudgetService,
  AgentWorkflowBudgetService,
  ScopeActivation.OnScopeCreated,
  'workflow.budget',
);
