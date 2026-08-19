/**
 * `ultracode` domain — `IAgentUltracodeService` implementation.
 *
 * Tracks ultracode-mode enter/exit in the `wire` `UltracodeModel` (mutated only
 * through the `ultracode_mode.enter` / `ultracode_mode.exit` Ops, read through
 * `wire.getModel`), mirrors the mode into `systemReminder` as live-only side
 * effects, and re-injects a sparse maintenance reminder every
 * `ULTRA_MODE_MAINTENANCE_EVERY_TURNS` ended turns while the mode is on. The
 * enter-reminder removal on exit is a cross-model fold on `ContextModel`:
 * dispatching `ultracode_mode.exit` pops the reminder when it is the last
 * message, exactly like swarm mode. A keyword trigger hooks
 * `IAgentPromptService.hooks.onBeforeSubmitPrompt`: a user prompt containing
 * the bare `chesto!` token opts the turn in, switching the profile to the
 * highest supported thinking effort (xhigh when available) and injecting the
 * enter reminder. Bound at Agent scope.
 *
 * The `[agent]` config section gates both behaviors: `workflowKeywordTriggerEnabled`
 * (default true) switches the keyword trigger, and `ultracode` (default false)
 * forces the mode on from the start so the `Workflow` tool is active without
 * the keyword. While the mode is on, entering it also verifies — through
 * `IAgentToolPolicyService` — that the `Workflow` tool is in the caller's
 * active tool set alongside `Agent`; a policy that blocks it (profile
 * allowlist / denylist or global `[tools]` config) surfaces a warning instead
 * of silently running the mode without the orchestration tool. The tool's own
 * contribution `when` predicate (gated on `isActive`) plus the
 * `agent.status.updated` re-fold is what actually registers the tool.
 */

import { Service } from '#/_base/di/service';
import { LifecycleScope } from '#/app/scopes';
import { ScopeActivation, registerScopedService } from '#/_base/di/scope';
import { IConfigService } from '#/app/config/config';
import { IAgentContextMemoryService } from '#/agent/contextMemory/contextMemory';
import { USER_PROMPT_ORIGIN } from '#/agent/contextMemory/types';
import { IEventBus } from '#/app/event/eventBus';
import { IAgentPromptService } from '#/agent/prompt/prompt';
import { IAgentProfileService, ProfileError } from '#/agent/profile/profile';
import { IAgentSystemReminderService } from '#/agent/systemReminder/systemReminder';
import { IAgentToolPolicyService } from '#/agent/toolPolicy/toolPolicy';
import { WORKFLOW_TOOL_NAME } from '#/agent/tools/workflow/workflow';
import { IModelCatalog } from '#/kosong/model/catalog';
import { IWireService } from '#/wire/wire';

import { containsUltracodeToken, userPromptText } from './ultracodeDetector';
import { AGENT_SECTION, type AgentConfig } from './configSection';
import ULTRACODE_ENTER_REMINDER from './enter-reminder.md?raw';
import ULTRACODE_MAINTENANCE_REMINDER from './maintenance-reminder.md?raw';
import ULTRACODE_EXIT_REMINDER from './exit-reminder.md?raw';
import { IAgentUltracodeService, type UltracodeTrigger } from './ultracode';
import { UltracodeModel, ultracodeEnter, ultracodeExit } from './ultracodeOps';

/** How many ended turns pass before the sparse "still on" reminder repeats. */
const ULTRA_MODE_MAINTENANCE_EVERY_TURNS = 4;

export class AgentUltracodeService extends Service implements IAgentUltracodeService {
  declare readonly _serviceBrand: undefined;

  private turnsSinceReminder = 0;

  constructor(
    @IWireService private readonly wire: IWireService,
    @IAgentSystemReminderService private readonly reminders: IAgentSystemReminderService,
    @IAgentContextMemoryService private readonly context: IAgentContextMemoryService,
    @IEventBus private readonly eventBus: IEventBus,
    @IAgentProfileService private readonly profile: IAgentProfileService,
    @IModelCatalog private readonly catalog: IModelCatalog,
    @IConfigService private readonly configService: IConfigService,
    @IAgentToolPolicyService private readonly toolPolicy: IAgentToolPolicyService,
    @IAgentPromptService prompt: IAgentPromptService,
  ) {
    super();
    this._register(
      prompt.hooks.onBeforeSubmitPrompt.register('ultracode', async (ctx, next) => {
        if ((ctx.promptMessage.origin ?? USER_PROMPT_ORIGIN).kind !== 'user') return next();
        if (this.isActive) return next();
        if (!this.keywordTriggerEnabled()) return next();
        if (!containsUltracodeToken(userPromptText(ctx.promptMessage.content))) return next();
        this.enter('keyword');
        return next();
      }),
    );
    this._register(
      this.eventBus.subscribe('turn.ended', () => {
        if (!this.isActive) {
          this.turnsSinceReminder = 0;
          return;
        }
        this.turnsSinceReminder += 1;
        if (this.turnsSinceReminder >= ULTRA_MODE_MAINTENANCE_EVERY_TURNS) {
          this.turnsSinceReminder = 0;
          this.reminders.appendSystemReminder(ULTRACODE_MAINTENANCE_REMINDER, {
            kind: 'injection',
            variant: 'ultracode_mode',
          });
        }
      }),
    );
  }

  get isActive(): boolean {
    return this.wire.getModel(UltracodeModel) === true || this.configForced();
  }

  enter(trigger: UltracodeTrigger): void {
    if (this.isActive) return;
    if (!this.applyXhigh()) return;
    this.turnsSinceReminder = 0;
    this.wire.dispatch(ultracodeEnter({ trigger }));
    this.reminders.appendSystemReminder(ULTRACODE_ENTER_REMINDER, {
      kind: 'injection',
      variant: 'ultracode_mode',
    });
    this.assertWorkflowToolActive();
  }

  exit(): void {
    if (this.configForced()) return;
    if (!this.isActive) return;
    this.turnsSinceReminder = 0;
    const history = this.context.get();
    const last = history[history.length - 1];
    const willPop =
      last?.origin?.kind === 'injection' && last.origin.variant === 'ultracode_mode';
    this.wire.dispatch(ultracodeExit({}));
    if (willPop) {
      this.eventBus.publish({
        type: 'context.spliced',
        start: history.length - 1,
        deleteCount: 1,
        messages: [],
      });
      return;
    }
    this.reminders.appendSystemReminder(ULTRACODE_EXIT_REMINDER, {
      kind: 'injection',
      variant: 'ultracode_mode_exit',
    });
  }

  private applyXhigh(): boolean {
    const alias = this.profile.getModel();
    try {
      this.profile.setThinking('xhigh');
      return true;
    } catch (error) {
      if (!(error instanceof ProfileError)) throw error;
      let fallback: string | undefined;
      try {
        fallback = this.catalog.get(alias)?.supportEfforts?.at(-1);
      } catch {
        fallback = undefined;
      }
      if (fallback === undefined) {
        this.publishUnsupported(alias);
        return false;
      }
      try {
        this.profile.setThinking(fallback);
        return true;
      } catch {
        this.publishUnsupported(alias);
        return false;
      }
    }
  }

  private publishUnsupported(modelAlias: string): void {
    this.eventBus.publish({
      type: 'warning',
      code: 'ultracode.thinking_unsupported',
      message:
        `Ultracode needs thinking effort, but "${modelAlias}" does not support it. ` +
        `Ultracode mode was not enabled.`,
    });
  }

  /** Whether the `[agent]` section forces ultracode mode on. */
  private configForced(): boolean {
    try {
      return this.configService.get<AgentConfig | undefined>(AGENT_SECTION)?.ultracode === true;
    } catch {
      return false;
    }
  }

  /** Whether the bare-`chesto!` keyword may opt a turn in. */
  private keywordTriggerEnabled(): boolean {
    try {
      return this.configService.get<AgentConfig | undefined>(AGENT_SECTION)
        ?.workflowKeywordTriggerEnabled !== false;
    } catch {
      return true;
    }
  }

  /**
   * While ultracode is on, the `Workflow` tool must be in the caller's active
   * tool set alongside `Agent` (its contribution `when` predicate activates it
   * via the `agent.status.updated` re-fold). Verify through
   * `IAgentToolPolicyService` and warn when a policy layer blocks it, so the
   * mode never silently runs without its orchestration tool.
   */
  private assertWorkflowToolActive(): void {
    let active: boolean;
    try {
      active = this.toolPolicy.isToolActive(WORKFLOW_TOOL_NAME);
    } catch {
      return;
    }
    if (active) return;
    this.eventBus.publish({
      type: 'warning',
      code: 'ultracode.workflow_tool_blocked',
      message:
        `Ultracode mode is on, but the Workflow tool is disabled by the active tool policy ` +
        `(profile allowlist/denylist or global [tools] config). ` +
        `Add "Workflow" to the active tools to author and run workflow scripts.`,
    });
  }
}

registerScopedService(
  LifecycleScope.Agent,
  IAgentUltracodeService,
  AgentUltracodeService,
  ScopeActivation.OnScopeCreated,
  'ultracode',
);
