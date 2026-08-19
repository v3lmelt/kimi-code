/**
 * `tools` domain — `AgentSwarmTool` implementation (the `AgentSwarm`
 * tool).
 *
 * Launches a batch of child agents (an ordinary Agent scope each) through the
 * session swarm coordinator (`ISessionSwarmService`) and renders the
 * per-subagent XML result. Reads persisted swarm item labels through the
 * Session-scoped coordinator so later `resume_agent_ids` calls relabel
 * resumed subagents like v1. When the caller has a model bound, the tool
 * resolves the explicit or target-profile model preference up front via
 * `resolveSubagentBinding` (against `IConfigService`, `IFlagService`,
 * `ISessionAgentProfileCatalog`, and the caller's `IAgentProfileService`) and
 * threads it through the swarm tasks; otherwise binding is left to the
 * service, which keeps its own "no model bound" check and inherit-caller
 * fallback. The advertised `model` parameter lists the secondary/primary
 * pair via `buildSubagentModelDescriptions`, suffixing each line with the
 * entry's capability flags resolved through `IModelCatalog`. Swarm mode is
 * entered through `IAgentSwarmService`; the caller's agent id comes from
 * `IAgentScopeContext`. When the `[agent_swarm_security]` section is enabled,
 * each subagent prompt is pre-screened by a two-stage classifier (a fast round
 * that escalates suspicious prompts to a careful review round) before spawn —
 * blocked prompts fail that item without running, and completed results are
 * post-scanned for secret / PII risk patterns, prefixing hits with a
 * `SECURITY WARNING` marker. Pure tool — owns no scoped state.
 *
 * Registered via the module-level `registerAgentToolService(IAgentSwarmTool,
 * AgentSwarmTool)` at the bottom of this file — the same "import = register"
 * pattern used by every agent tool. Bound at Agent scope.
 */

import {
  ToolAccesses,
  type ExecutableToolContext,
  type ExecutableToolResult,
  type ToolExecution,
} from '#/tool/toolContract';
import { Error2, ErrorCodes } from '#/errors';
import { registerAgentToolService } from '#/agent/toolRegistry/toolContribution';
import { toInputJsonSchema } from '#/tool/input-schema';
import { IConfigService } from '#/app/config/config';
import { IFlagService } from '#/app/flag/flag';
import { IModelCatalog } from '#/kosong/model/catalog';
import {
  ISessionSwarmService,
  type SessionSwarmRunResult,
  type SessionSwarmTask,
} from '#/session/swarm/sessionSwarm';
import { ISessionAgentProfileCatalog } from '#/session/sessionAgentProfileCatalog/sessionAgentProfileCatalog';
import { IAgentProfileService } from '#/agent/profile/profile';
import { IAgentLLMRequesterService } from '#/agent/llmRequester/llmRequester';
import { ITelemetryService } from '#/app/telemetry/telemetry';
import { ILogService } from '#/_base/log/log';
import { createUserMessage, extractText, type Message } from '#/kosong/contract/message';
import type { ThinkingEffort } from '#/kosong/contract/provider';
import type { ModelRequester } from '#/kosong/model/modelRequester';
import {
  subagentAllowlistFor,
  subagentTypeNotAllowedMessage,
} from '#/app/agentProfileCatalog/profile-shared';
import { IAgentScopeContext } from '#/agent/scopeContext/scopeContext';
import { IAgentSwarmService } from '#/agent/swarm/swarm';
import {
  parseSecurityVerdict,
  resolveAgentSwarmSecurity,
  scanSecurityRisk,
  securityClassifierInstruction,
  SWARM_SECURITY_REJECTED_MESSAGE,
  type ResolvedSwarmSecurity,
  type SecurityClassifierStage,
} from '#/agent/swarm/securityConfig';
import {
  buildSubagentModelDescriptions,
  resolveSubagentBinding,
  resolveSubagentTimeoutMs,
  stripSubagentModelParameter,
} from '#/session/subagent/configSection';
import { SECONDARY_MODEL_FLAG_ID } from '#/session/subagent/flag';
import {
  AgentSwarmToolInputSchema,
  IAgentSwarmTool,
  MAX_AGENT_SWARM_SUBAGENTS,
  PROMPT_TEMPLATE_PLACEHOLDER,
  type AgentSwarmToolInput,
} from './agent-swarm';
import AGENT_SWARM_DESCRIPTION from './agent-swarm.md?raw';

const DEFAULT_SUBAGENT_TYPE = 'coder';

const AGENT_SWARM_PARAMETERS = toInputJsonSchema(AgentSwarmToolInputSchema);
const AGENT_SWARM_PARAMETERS_NO_MODEL = stripSubagentModelParameter(AGENT_SWARM_PARAMETERS);

interface AgentSwarmSpawnSpec {
  readonly kind: 'spawn';
  readonly index: number;
  readonly item: string;
  readonly prompt: string;
}

interface AgentSwarmResumeSpec {
  readonly kind: 'resume';
  readonly index: number;
  readonly agentId: string;
  readonly item?: string;
  readonly prompt: string;
}

type AgentSwarmSpec = AgentSwarmSpawnSpec | AgentSwarmResumeSpec;

interface SwarmRunResult {
  readonly spec: AgentSwarmSpec;
  readonly agentId?: string;
  readonly status: 'completed' | 'failed' | 'aborted';
  readonly state?: 'started' | 'not_started';
  readonly result?: string;
  readonly error?: string;
}

export class AgentSwarmTool implements IAgentSwarmTool {
  declare readonly _serviceBrand: undefined;
  readonly name = 'AgentSwarm' as const;

  get parameters(): Record<string, unknown> {
    return this.flags.enabled(SECONDARY_MODEL_FLAG_ID)
      ? AGENT_SWARM_PARAMETERS
      : AGENT_SWARM_PARAMETERS_NO_MODEL;
  }

  private readonly callerAgentId: string;

  constructor(
    @ISessionSwarmService private readonly swarmService: ISessionSwarmService,
    @IAgentScopeContext scopeContext: IAgentScopeContext,
    @IAgentSwarmService private readonly swarmMode: IAgentSwarmService,
    @IConfigService private readonly config: IConfigService,
    @IFlagService private readonly flags: IFlagService,
    @ISessionAgentProfileCatalog private readonly catalog: ISessionAgentProfileCatalog,
    @IAgentProfileService private readonly profile: IAgentProfileService,
    @IModelCatalog private readonly modelCatalog: IModelCatalog,
    @IAgentLLMRequesterService private readonly llmRequester?: IAgentLLMRequesterService,
    @ITelemetryService private readonly telemetry?: ITelemetryService,
    @ILogService private readonly log?: ILogService,
  ) {
    this.callerAgentId = scopeContext.agentId;
  }

  get description(): string {
    const modelLines = buildSubagentModelDescriptions(
      this.config,
      this.flags,
      this.profile.data().modelAlias,
      this.modelCatalog,
    );
    return modelLines === undefined
      ? AGENT_SWARM_DESCRIPTION
      : `${AGENT_SWARM_DESCRIPTION}\n\n${modelLines}`;
  }

  resolveExecution(args: AgentSwarmToolInput): ToolExecution {
    const agentCount = (args.items?.length ?? 0) + Object.keys(args.resume_agent_ids ?? {}).length;
    return {
      accesses: ToolAccesses.all(),
      description: `Launching agent swarm: ${args.description}`,
      display: {
        kind: 'agent_call',
        agent_name: `swarm (${agentCount} subagents)`,
        prompt: args.description,
      },
      approvalRule: this.name,
      execute: (ctx) => this.execution(args, ctx),
    };
  }

  private async execution(
    args: AgentSwarmToolInput,
    context: ExecutableToolContext,
  ): Promise<ExecutableToolResult> {
    try {
      this.swarmMode.enter('tool');
      const result = await this.runSwarm(args, context.signal, context.toolCallId);
      return {
        output: result,
      };
    } catch (error) {
      return {
        output: error instanceof Error ? error.message : String(error),
        isError: true,
      };
    }
  }

  private async runSwarm(
    args: AgentSwarmToolInput,
    signal: AbortSignal,
    toolCallId: string,
  ): Promise<string> {
    const profileName = normalizeOptionalString(args.subagent_type) ?? DEFAULT_SUBAGENT_TYPE;
    let binding: { model: string; thinking?: string } | undefined;
    if ((args.items?.length ?? 0) > 0) {
      await this.catalog.ready;
      const own = this.profile.data();
      const allowlist = subagentAllowlistFor(this.catalog, own);
      if (allowlist !== undefined && !allowlist.includes(profileName)) {
        throw new Error2(
          ErrorCodes.AGENT_TYPE_NOT_ALLOWED,
          subagentTypeNotAllowedMessage(profileName, allowlist),
          { details: { profileName, allowlist } },
        );
      }
      const targetProfile = this.catalog.get(profileName);
      if (targetProfile === undefined) {
        throw new Error2(ErrorCodes.PROFILE_UNKNOWN, `Unknown agent type: "${profileName}"`, {
          details: { profileName },
        });
      }
      if (own.modelAlias !== undefined) {
        const resolved = resolveSubagentBinding(
          this.config,
          this.flags,
          { modelAlias: own.modelAlias, thinkingLevel: own.thinkingLevel },
          args.model ?? targetProfile.modelPreference,
        );
        binding = { model: resolved.model, thinking: resolved.thinking };
      }
    }
    const timeoutMs = resolveSubagentTimeoutMs(this.config);
    const specs = await createAgentSwarmSpecs(args, (agentId) =>
      this.swarmService.getSwarmItem({ callerAgentId: this.callerAgentId, agentId }),
    );
    const security = resolveAgentSwarmSecurity(
      this.config,
      this.flags,
      this.profile.data().modelAlias,
      this.modelCatalog,
    );
    const blocked = new Set<number>();
    if (security !== undefined && specs.length > 0) {
      await this.classifySwarmSpecs(security, specs, blocked, signal);
    }
    const tasks: SessionSwarmTask<AgentSwarmSpec>[] = specs
      .filter((spec) => !blocked.has(spec.index))
      .map((spec) => {
        const descriptionName = spec.kind === 'resume' ? 'resume' : profileName;
        const common = {
          data: spec,
          profileName: spec.kind === 'resume' ? 'subagent' : profileName,
          parentToolCallId: toolCallId,
          prompt: spec.prompt,
          description: childDescription(args.description, spec.index, descriptionName),
          swarmIndex: spec.index,
          runInBackground: false,
          swarmItem: spec.item,
          signal,
          timeout: timeoutMs,
        };
        if (spec.kind === 'resume') {
          return {
            ...common,
            kind: 'resume' as const,
            resumeAgentId: spec.agentId,
          };
        }
        return {
          ...common,
          kind: 'spawn' as const,
          binding,
        };
      });
    const results = await this.swarmService.run({
      callerAgentId: this.callerAgentId,
      tasks,
    });
    const combined = mergeSwarmResults(specs, blocked, results);
    const reviewed =
      security !== undefined && security.reviewResults ? applySecurityReview(combined) : combined;
    return renderSwarmResults(reviewed);
  }

  private async classifySwarmSpecs(
    security: ResolvedSwarmSecurity,
    specs: readonly AgentSwarmSpec[],
    blocked: Set<number>,
    signal: AbortSignal,
  ): Promise<void> {
    const startedAt = Date.now();
    let blockedCount = 0;
    let next = 0;
    const workers = Array.from({ length: SWARM_SECURITY_CLASSIFY_CONCURRENCY }, async () => {
      for (;;) {
        if (signal.aborted) return;
        const spec = specs[next];
        if (spec === undefined) return;
        next += 1;
        if (blocked.has(spec.index)) continue;
        if ((await this.classifySwarmSpec(security, spec, signal)) === 'block') {
          blocked.add(spec.index);
          blockedCount += 1;
          this.log?.info('swarm security classifier blocked subagent prompt', {
            index: spec.index,
            kind: spec.kind,
          });
        }
      }
    });
    await Promise.all(workers);
    this.telemetry?.track('swarm_security_classify', {
      total: specs.length,
      blocked: blockedCount,
      duration_ms: Date.now() - startedAt,
    });
  }

  private async classifySwarmSpec(
    security: ResolvedSwarmSecurity,
    spec: AgentSwarmSpec,
    signal: AbortSignal,
  ): Promise<'allow' | 'block'> {
    const context = buildSecurityClassifyContext(spec);
    const fast = await this.runClassifierRound(security, 'fast', context, signal);
    if (fast === undefined) return 'allow';
    const fastVerdict = parseSecurityVerdict(fast);
    if (fastVerdict === 'block') return 'block';
    if (fastVerdict === 'allow') return 'allow';
    if (!security.thinkingStage) return 'allow';
    const review = await this.runClassifierRound(security, 'review', context, signal);
    if (review === undefined) return 'allow';
    return parseSecurityVerdict(review) === 'block' ? 'block' : 'allow';
  }

  private async runClassifierRound(
    security: ResolvedSwarmSecurity,
    stage: SecurityClassifierStage,
    prompt: string,
    signal: AbortSignal,
  ): Promise<string | undefined> {
    const model = stage === 'fast' ? security.fastModel : security.reviewModel;
    const maxOutput =
      stage === 'fast' ? security.fastMaxOutputTokens : security.reviewMaxOutputTokens;
    const messages = [createUserMessage(`${securityClassifierInstruction(stage)}\n\n${prompt}`)];
    const { signal: classifySignal, cancel } = linkTimeoutSignal(signal, security.timeoutMs);
    try {
      const text =
        model === this.profile.data().modelAlias
          ? await this.requestViaLlmRequester(messages, maxOutput, classifySignal)
          : await runDirectClassifierRequest(
              this.modelCatalog.getRequester(model),
              messages,
              maxOutput,
              stage,
              classifySignal,
            );
      const trimmed = text.trim();
      return trimmed.length > 0 ? trimmed : undefined;
    } catch (error) {
      if (signal.aborted) throw error;
      this.log?.warn('swarm security classifier request failed; allowing prompt', {
        error: error instanceof Error ? error.message : String(error),
        model,
        stage,
      });
      return undefined;
    } finally {
      cancel();
    }
  }

  private async requestViaLlmRequester(
    messages: readonly Message[],
    maxOutput: number,
    signal: AbortSignal,
  ): Promise<string> {
    if (this.llmRequester === undefined) {
      throw new Error('swarm security classifier unavailable: llmRequester not injected');
    }
    const finish = await this.llmRequester.request(
      {
        messages,
        maxOutputSize: maxOutput,
        source: { type: 'operation', requestKind: 'swarm_security_classify' },
      },
      undefined,
      signal,
    );
    return extractText(finish.message);
  }
}

registerAgentToolService(IAgentSwarmTool, AgentSwarmTool, { name: 'AgentSwarm', domain: 'swarm' });

const SWARM_SECURITY_CLASSIFY_CONCURRENCY = 8;

function buildSecurityClassifyContext(spec: AgentSwarmSpec): string {
  const kind =
    spec.kind === 'resume'
      ? `Resume existing subagent (agent_id: ${spec.agentId})`
      : 'Spawn a new subagent';
  return `${kind}\nSubagent prompt:\n${spec.prompt}`;
}

function linkTimeoutSignal(signal: AbortSignal, timeoutMs: number): {
  readonly signal: AbortSignal;
  readonly cancel: () => void;
} {
  const controller = new AbortController();
  const onAbort = () => controller.abort();
  if (signal.aborted) {
    controller.abort();
  } else {
    signal.addEventListener('abort', onAbort, { once: true });
  }
  const timer = setTimeout(() => controller.abort(), Math.max(1, timeoutMs));
  return {
    signal: controller.signal,
    cancel: () => {
      clearTimeout(timer);
      signal.removeEventListener('abort', onAbort);
    },
  };
}

/** Restores the spec order the renderer expects, filling blocked specs with a
 *  synthetic failed result so the swarm never spawns them. */
function mergeSwarmResults(
  specs: readonly AgentSwarmSpec[],
  blocked: ReadonlySet<number>,
  runResults: readonly SessionSwarmRunResult<AgentSwarmSpec>[],
): SwarmRunResult[] {
  const ordered: SwarmRunResult[] = [];
  let runIndex = 0;
  for (const spec of specs) {
    if (blocked.has(spec.index)) {
      ordered.push({
        spec,
        status: 'failed',
        state: 'not_started',
        error: SWARM_SECURITY_REJECTED_MESSAGE,
      });
      continue;
    }
    const run = runResults[runIndex];
    if (run === undefined) continue;
    runIndex += 1;
    const { task, ...rest } = run;
    ordered.push({ spec: task.data as AgentSwarmSpec, ...rest });
  }
  return ordered;
}

/** Post-review: prefixes completed results that match a risk pattern. */
function applySecurityReview(results: readonly SwarmRunResult[]): SwarmRunResult[] {
  return results.map((result) => {
    if (result.status !== 'completed' || result.result === undefined) return result;
    const warning = scanSecurityRisk(result.result);
    return warning === undefined
      ? result
      : { ...result, result: `${warning}\n\n${result.result}` };
  });
}

async function runDirectClassifierRequest(
  requester: ModelRequester,
  messages: readonly Message[],
  maxCompletionTokens: number,
  stage: SecurityClassifierStage,
  signal: AbortSignal,
): Promise<string> {
  const thinkingEffort: ThinkingEffort | undefined =
    stage === 'review' && requester.model.capabilities.thinking === true ? 'on' : undefined;
  let text = '';
  for await (const event of requester.request(
    { systemPrompt: '', tools: [], messages },
    signal,
    { maxCompletionTokens, thinkingEffort },
  )) {
    if (event.type === 'finish') text = extractText(event.message);
  }
  return text;
}

async function createAgentSwarmSpecs(
  args: AgentSwarmToolInput,
  getResumeItem: (agentId: string) => Promise<string | undefined>,
): Promise<AgentSwarmSpec[]> {
  const resumeEntries = Object.entries(args.resume_agent_ids ?? {}).map(([agentId, prompt]) => ({
    agentId: agentId.trim(),
    prompt: prompt.trim(),
  }));
  const items = (args.items ?? []).map((item) => item.trim());
  const itemCount = items.length;
  const resumeCount = resumeEntries.length;
  const totalCount = resumeCount + itemCount;
  if (!hasMinimumAgentSwarmInputs(itemCount, resumeCount)) {
    throw new Error2(
      ErrorCodes.VALIDATION_FAILED,
      'AgentSwarm requires at least 2 items unless resume_agent_ids is provided.',
    );
  }
  if (totalCount > MAX_AGENT_SWARM_SUBAGENTS) {
    throw new Error2(
      ErrorCodes.VALIDATION_FAILED,
      `AgentSwarm supports at most ${String(MAX_AGENT_SWARM_SUBAGENTS)} subagents.`,
      { details: { total: totalCount, max: MAX_AGENT_SWARM_SUBAGENTS } },
    );
  }
  const promptTemplate = normalizeOptionalString(args.prompt_template);
  if (items.length > 0 && promptTemplate === undefined) {
    throw new Error2(
      ErrorCodes.VALIDATION_FAILED,
      'prompt_template is required when items are provided.',
    );
  }
  if (promptTemplate !== undefined && !promptTemplate.includes(PROMPT_TEMPLATE_PLACEHOLDER)) {
    throw new Error2(
      ErrorCodes.VALIDATION_FAILED,
      `prompt_template must include the ${PROMPT_TEMPLATE_PLACEHOLDER} placeholder.`,
      { details: { placeholder: PROMPT_TEMPLATE_PLACEHOLDER } },
    );
  }

  const seenPrompts = new Map<string, number>();
  const specs: AgentSwarmSpec[] = [];
  for (const entry of resumeEntries) {
    specs.push({
      kind: 'resume',
      index: specs.length + 1,
      agentId: entry.agentId,
      item: await getResumeItem(entry.agentId),
      prompt: entry.prompt,
    });
  }
  if (items.length > 0) {
    const itemPromptTemplate = promptTemplate!;
    items.forEach((item, index) => {
      const prompt = itemPromptTemplate.split(PROMPT_TEMPLATE_PLACEHOLDER).join(item);
      const previousIndex = seenPrompts.get(prompt);
      if (previousIndex !== undefined) {
        throw new Error2(
          ErrorCodes.VALIDATION_FAILED,
          `Duplicate subagent prompts from items ${String(previousIndex)} and ${String(index + 1)}. AgentSwarm requires distinct subagents.`,
          { details: { previousIndex, index: index + 1 } },
        );
      }
      seenPrompts.set(prompt, index + 1);
      specs.push({
        kind: 'spawn',
        index: specs.length + 1,
        item,
        prompt,
      });
    });
  }
  return specs;
}

function hasMinimumAgentSwarmInputs(itemCount: number, resumeCount: number): boolean {
  return resumeCount > 0 || itemCount >= 2;
}

function childDescription(swarmDescription: string, index: number, profileName: string): string {
  return `${swarmDescription} #${String(index)} (${profileName})`;
}

function renderSwarmResults(results: readonly SwarmRunResult[]): string {
  const completed = results.filter((result) => result.status === 'completed').length;
  const failed = results.filter((result) => result.status === 'failed').length;
  const aborted = results.filter((result) => result.status === 'aborted').length;
  const shouldRenderResumeHint =
    results.some((result) => result.status !== 'completed') &&
    results.some((result) => result.agentId !== undefined);
  const lines = [
    '<agent_swarm_result>',
    `<summary>${renderSwarmSummary(completed, failed, aborted)}</summary>`,
  ];

  if (shouldRenderResumeHint) {
    lines.push(
      '<resume_hint>Call AgentSwarm with resume_agent_ids using the agent_id values in this result to continue unfinished work.</resume_hint>',
    );
  }

  for (const result of results) {
    const agentId = result.agentId === undefined ? '' : ` agent_id="${result.agentId}"`;
    const mode = result.spec.kind === 'resume' ? ' mode="resume"' : '';
    const item = result.spec.item === undefined ? '' : ` item="${escapeXmlAttribute(result.spec.item)}"`;
    const state = result.state === undefined ? '' : ` state="${result.state}"`;
    const body = result.status === 'completed' ? (result.result ?? '') : (result.error ?? 'unknown error');
    lines.push(
      `<subagent${mode}${agentId}${item}${state} outcome="${result.status}">${body}</subagent>`,
    );
  }

  lines.push('</agent_swarm_result>');
  return lines.join('\n');
}

function normalizeOptionalString(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function renderSwarmSummary(completed: number, failed: number, aborted = 0): string {
  const parts: string[] = [];
  if (completed > 0) parts.push(`completed: ${String(completed)}`);
  if (failed > 0) parts.push(`failed: ${String(failed)}`);
  if (aborted > 0) parts.push(`aborted: ${String(aborted)}`);
  return parts.join(', ');
}

function escapeXmlAttribute(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('"', '&quot;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;');
}
