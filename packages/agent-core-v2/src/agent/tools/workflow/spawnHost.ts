/**
 * `tools` domain — the workflow subagent spawn host.
 *
 * Implements the runtime's `agentSpawn` seam: one `agent(prompt, opts)` call
 * from a workflow script becomes one real subagent. The host follows the
 * session-swarm spawn path (`sessionSwarmService.spawnAttempt`) — resolve
 * profile + model binding, `IAgentLifecycleService.create`, mirror the spawn
 * on the caller's record stream (`emitAgentRunSpawned`), report the spawn to
 * the caller (`hooks.onSpawned`, fired before the turn starts), apply the
 * profile's prompt prefix, drive one turn via `ISessionSubagentService.run`,
 * and mirror the run (`mirrorAgentRun`) — and additionally threads the
 * structured-output options (`requiresStructuredOutput` / `structuredSchema`)
 * through `RunAgentOptions` when the script author passed
 * `agent(prompt, { schema })`.
 *
 * Unlike `SessionSwarmService` the host spawns exactly one subagent per call
 * (the workflow fan-out scheduler, `AgentRunPool`, already owns concurrency)
 * and does not use a `SessionSwarmTask` batch — the schema passthrough is a
 * direct `RunAgentOptions` field that the swarm task shape does not carry. A
 * validated structured result is returned as its original value while plain
 * runs retain the text summary handoff.
 */

import { Error2, ErrorCodes } from '#/errors';
import { ILogService } from '#/_base/log/log';
import type { IAgentScopeHandle } from '#/_base/di/scope';
import { IConfigService } from '#/app/config/config';
import { IFlagService } from '#/app/flag/flag';
import { applyProfilePromptPrefix } from '#/app/agentProfileCatalog/promptPrefix';
import { ISessionAgentProfileCatalog } from '#/session/sessionAgentProfileCatalog/sessionAgentProfileCatalog';
import { ISessionContext } from '#/session/sessionContext/sessionContext';
import { ISessionProcessRunner } from '#/session/process/processRunner';
import { IAgentLifecycleService } from '#/session/agentLifecycle/agentLifecycle';
import { subagentLabels } from '#/session/agentLifecycle/subagentMetadata';
import { emitAgentRunSpawned, mirrorAgentRun } from '#/session/subagent/mirrorAgentRun';
import { ISessionSubagentService } from '#/session/subagent/subagent';
import {
  resolveSubagentBinding,
  subagentDisplayModel,
  wrapSubagentModelError,
} from '#/session/subagent/configSection';
import { IModelCatalog } from '#/kosong/model/catalog';
import { IAgentPermissionModeService } from '#/agent/permissionMode/permissionMode';
import { IAgentProfileService } from '#/agent/profile/profile';
import { IAgentUserToolService } from '#/agent/userTool/userTool';
import type { TokenUsage } from '#/kosong/contract/usage';
import type {
  WorkflowAgentOpts,
  WorkflowAgentResult,
} from '#/agent/workflow/types';

/** The tool's default subagent type for workflow spawns. */
export const WORKFLOW_DEFAULT_SUBAGENT_TYPE = 'coder';

/**
 * Lifecycle hooks for one spawn. `onSpawned` fires as soon as the child agent
 * exists — before its turn starts — so progress ledgers can show the agent as
 * running instead of only learning about it on completion.
 */
export interface WorkflowSpawnHooks {
  readonly onSpawned?: (agentId: string) => void;
}

/** Services the spawn host needs, injected once by the `Workflow` tool. */
export interface WorkflowSpawnHostDeps {
  readonly callerAgentId: string;
  readonly lifecycle: IAgentLifecycleService;
  readonly subagents: ISessionSubagentService;
  readonly catalog: ISessionAgentProfileCatalog;
  readonly sessionContext: ISessionContext;
  readonly processRunner: ISessionProcessRunner;
  readonly log: ILogService;
  readonly modelCatalog: IModelCatalog;
  readonly config: IConfigService;
  readonly flags: IFlagService;
  readonly profile: IAgentProfileService;
}

/**
 * Result of one spawn, as the spawn host reports it: the sandbox-facing
 * `WorkflowAgentResult` fields plus the subagent's display model and token
 * usage so progress events and budget accounting can carry real numbers.
 */
export interface WorkflowSpawnOutcome extends WorkflowAgentResult {
  readonly model?: string;
  readonly usage?: TokenUsage;
}

/**
 * Spawn one real subagent for a workflow `agent()` call. Resolves to the
 * `WorkflowAgentResult` the sandbox sees. Spawn-level failures (unknown
 * profile, model binding problems, aborts) reject — the runtime surfaces a
 * rejecting `agent()` as an aborted run, matching per-item null-on-throw
 * semantics for the fan-out schedulers.
 */
export async function spawnWorkflowAgent(
  deps: WorkflowSpawnHostDeps,
  prompt: string,
  opts: WorkflowAgentOpts | undefined,
  signal: AbortSignal,
  parentToolCallId: string,
  hooks?: WorkflowSpawnHooks,
): Promise<WorkflowSpawnOutcome> {
  signal.throwIfAborted();
  if (opts?.isolation === 'worktree') {
    throw new Error2(
      ErrorCodes.VALIDATION_FAILED,
      'Workflow agent isolation "worktree" is not available in this runtime.',
      { details: { field: 'isolation', value: opts.isolation } },
    );
  }
  const caller = deps.lifecycle.get(deps.callerAgentId);
  if (caller === undefined) {
    throw new Error2(ErrorCodes.AGENT_NOT_FOUND, `Caller agent "${deps.callerAgentId}" does not exist`, {
      details: { agentId: deps.callerAgentId },
    });
  }

  await deps.catalog.ready;
  const profileName = normalizeAgentType(opts?.agentType, caller);
  const profile = deps.catalog.get(profileName);
  if (profile === undefined) {
    throw new Error2(ErrorCodes.PROFILE_UNKNOWN, `Unknown agent type: "${profileName}"`, {
      details: { profileName },
    });
  }
  const callerData = caller.accessor.get(IAgentProfileService).data();
  if (callerData.modelAlias === undefined) {
    throw new Error2(ErrorCodes.MODEL_NOT_CONFIGURED, 'Caller agent has no model bound', {
      details: { agentId: deps.callerAgentId },
    });
  }
  const binding = resolveSubagentBinding(
    deps.config,
    deps.flags,
    { modelAlias: callerData.modelAlias, thinkingLevel: callerData.thinkingLevel },
    opts?.model,
  );

  let child: IAgentScopeHandle;
  try {
    deps.modelCatalog.get(binding.model);
    child = await deps.lifecycle.create({
      binding: {
        profile: profile.name,
        model: binding.model,
        thinking: opts?.effort ?? binding.thinking,
      },
      labels: subagentLabels(deps.callerAgentId),
    });
  } catch (error) {
    throw wrapSubagentModelError(
      error,
      binding.model,
      callerData.modelAlias,
    );
  }
  let cleanupStarted = false;
  const cleanupChild = async (): Promise<void> => {
    if (cleanupStarted) return;
    cleanupStarted = true;
    try {
      await deps.lifecycle.remove(child.id);
    } catch (cleanupError) {
      try {
        deps.log.warn('workflow subagent cleanup failed', {
          agentId: child.id,
          error: cleanupError,
        });
      } catch {
        // Preserve the original spawn error even when cleanup diagnostics fail.
      }
    }
  };

  try {
    child.accessor
      .get(IAgentPermissionModeService)
      .setMode(caller.accessor.get(IAgentPermissionModeService).mode);
    child.accessor
      .get(IAgentUserToolService)
      .inheritUserTools(caller.accessor.get(IAgentUserToolService));

    const description = opts?.label ?? summarizePrompt(prompt);
    emitAgentRunSpawned(caller, child.id, {
      profileName,
      parentToolCallId,
      description,
      runInBackground: false,
      model: subagentDisplayModel(deps.config, binding.model),
    });
    // The child now exists and its spawn mirror has landed on the caller's
    // record stream — report the spawn before the turn starts so progress
    // ledgers see the agent as running for the whole turn.
    hooks?.onSpawned?.(child.id);

    const promptText = await applyProfilePromptPrefix(profile, prompt, {
      cwd: deps.sessionContext.cwd,
      runner: deps.processRunner,
      log: deps.log,
    });

    const run = await deps.subagents.run(
      child.id,
      { kind: 'prompt', prompt: promptText },
      {
        signal,
        requiresStructuredOutput: opts?.schema !== undefined,
        structuredSchema: opts?.schema,
      },
    );
    const mirrored = mirrorAgentRun(caller, run, {
      profileName,
      prompt: promptText,
      signal,
    });

    const completion = await mirrored;
    return {
      ok: true,
      agentId: child.id,
      output: completion.output === undefined ? completion.summary : completion.output,
      durationMs: 0,
      model: subagentDisplayModel(deps.config, binding.model),
      ...(completion.usage === undefined ? {} : { usage: completion.usage }),
    };
  } catch (error) {
    await cleanupChild();
    throw error;
  }
}

/** Resolve the subagent type for a spawn: `opts.agentType` or the caller's own. */
function normalizeAgentType(
  agentType: string | undefined,
  caller: IAgentScopeHandle,
): string {
  const requested = agentType?.trim();
  if (requested !== undefined && requested.length > 0) return requested;
  const own = caller.accessor.get(IAgentProfileService).data().profileName;
  return own ?? WORKFLOW_DEFAULT_SUBAGENT_TYPE;
}

/** Shorten a prompt into a task-list-friendly label when no label was given. */
function summarizePrompt(prompt: string): string {
  const singleLine = prompt.trim().split(/\s+/).join(' ');
  return singleLine.length <= 80 ? singleLine : `${singleLine.slice(0, 77)}...`;
}
