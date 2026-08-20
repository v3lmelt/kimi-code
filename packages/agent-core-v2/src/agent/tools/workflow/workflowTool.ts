/**
 * `tools` domain — `WorkflowTool` implementation (the `Workflow` tool).
 *
 * The LLM-facing entry point of the workflow orchestration engine. The model
 * authors a plain-JS workflow script against the deterministic DSL
 * (`meta` + `agent`/`parallel`/`pipeline`/`phase`/`log`/`args`/`budget`/
 * `workflow`) and calls this tool with the inline `script` (or a `scriptPath`
 * to load one from disk), optional `args`, and an optional `resumeFromRunId`
 * that replays a prior run's completed subagents.
 *
 * `execute()` is deliberately non-blocking: it validates + compiles the script
 * (fail fast), mints the run id, persists the script into the session dir,
 * loads the resume ledger when requested, registers a detached `WorkflowTask`
 * through `IAgentTaskService.registerTask`, and returns `{task_id, run_id}`
 * immediately. The task drives the real run in the background — sandbox
 * execution, subagent fan-out, progress Ops, run journal — and the task
 * service delivers the terminal `<task-notification>` with the run summary.
 * The model-facing JSON Schema preserves the input union between `script` and
 * `scriptPath`, including the refinement that exactly one source is required.
 *
 * The tool's `when` predicate activates it by default: the `[agent]`
 * `workflowToolEnabled` switch (default `true`) keeps it in every session's
 * tool set, and ultracode mode (activation or the keyword) also activates it
 * even when the switch is off. The `agent.status.updated` event that ultracode
 * enter/exit emit re-runs the activation fold, so entering ultracode activates
 * the tool without a restart.
 *
 * Registered via the module-level `registerAgentToolService(IWorkflowTool,
 * WorkflowTool)` at the bottom of this file — the same "import = register"
 * pattern used by every agent tool. Bound at Agent scope.
 */

import { ILogService } from '#/_base/log/log';
import { Error2, ErrorCodes } from '#/errors';
import { IConfigService } from '#/app/config/config';
import { IFlagService } from '#/app/flag/flag';
import { ITelemetryService } from '#/app/telemetry/telemetry';
import { IWireService } from '#/wire/wire';
import { IAppendLogStore } from '#/persistence/interface/appendLogStore';
import { IFileSystemStorageService } from '#/persistence/interface/storage';
import { IHostFileSystem } from '#/os/interface/hostFileSystem';
import { IHostEnvironment } from '#/os/interface/hostEnvironment';
import {
  ToolAccesses,
  type ExecutableToolContext,
  type ExecutableToolResult,
  type ToolExecution,
} from '#/tool/toolContract';
import { toInputJsonSchema } from '#/tool/input-schema';
import { canonicalizePath, isWithinDirectory } from '#/tool/path-access';
import { registerAgentToolService } from '#/agent/toolRegistry/toolContribution';
import { IAgentTaskService, type RegisterAgentTaskOptions } from '#/agent/task/task';
import { IAgentUltracodeService } from '#/agent/ultracode/ultracode';
import { AGENT_SECTION, type AgentConfig } from '#/agent/ultracode/configSection';
import { ISessionContext } from '#/session/sessionContext/sessionContext';
import { IAgentLifecycleService } from '#/session/agentLifecycle/agentLifecycle';
import { ISessionSubagentService } from '#/session/subagent/subagent';
import { ISessionAgentProfileCatalog } from '#/session/sessionAgentProfileCatalog/sessionAgentProfileCatalog';
import { ISessionProcessRunner } from '#/session/process/processRunner';
import { IAgentProfileService } from '#/agent/profile/profile';
import { IModelCatalog } from '#/kosong/model/catalog';
import { IAgentScopeContext } from '#/agent/scopeContext/scopeContext';
import { compileWorkflowScript } from '#/agent/workflow/compile/index';
import {
  WorkflowJournal,
  generateWorkflowRunId,
  isWorkflowRunId,
  workflowJournalDir,
  workflowJournalScope,
  workflowScriptSha256,
} from '#/agent/workflow/persist/journal';
import { telemetryWorkflowHook } from '#/agent/workflow/progress/workflowProgress';
import { IWorkflowBudgetService } from '#/agent/workflow/budget/workflowBudget';
import {
  WorkflowCompileError,
  type WorkflowRunId,
  type WorkflowScriptMeta,
} from '#/agent/workflow/types';

import { WorkflowTask, type WorkflowResumeLedger } from './workflowTask';
import type { WorkflowSpawnHostDeps } from './spawnHost';
import {
  IWorkflowTool,
  WORKFLOW_TOOL_NAME,
  WorkflowToolInputSchema,
  type WorkflowToolInput,
} from './workflow';
import WORKFLOW_DESCRIPTION from './workflow-doc.md?raw';

/** Storage key the inline script is persisted to: `<sessionDir>/workflows/<runId>/script.js`. */
export const WORKFLOW_SCRIPT_KEY = 'script.js';

const WORKFLOW_PARAMETERS = {
  ...toInputJsonSchema(WorkflowToolInputSchema),
  oneOf: [
    { required: ['script'], not: { required: ['scriptPath'] } },
    { required: ['scriptPath'], not: { required: ['script'] } },
  ],
};
const textEncoder = new TextEncoder();

export class WorkflowTool implements IWorkflowTool {
  declare readonly _serviceBrand: undefined;
  readonly name = WORKFLOW_TOOL_NAME;

  private readonly callerAgentId: string;
  private readonly tasks: IAgentTaskService;
  private readonly session: ISessionContext;
  private readonly logStore: IAppendLogStore;
  private readonly bytes: IFileSystemStorageService;
  private readonly hostFs: IHostFileSystem;
  private readonly hostEnvironment: IHostEnvironment;
  private readonly wire: IWireService;
  private readonly telemetry: ITelemetryService;
  private readonly log: ILogService;
  private readonly config: IConfigService;
  private readonly budget: IWorkflowBudgetService;
  private readonly spawnDeps: WorkflowSpawnHostDeps;

  constructor(
    @IAgentScopeContext scopeContext: IAgentScopeContext,
    @IAgentTaskService tasks: IAgentTaskService,
    @ISessionContext session: ISessionContext,
    @IAppendLogStore logStore: IAppendLogStore,
    @IFileSystemStorageService bytes: IFileSystemStorageService,
    @IHostFileSystem hostFs: IHostFileSystem,
    @IHostEnvironment hostEnvironment: IHostEnvironment,
    @IWireService wire: IWireService,
    @ITelemetryService telemetry: ITelemetryService,
    @ILogService log: ILogService,
    @IConfigService config: IConfigService,
    @IWorkflowBudgetService budget: IWorkflowBudgetService,
    @IAgentLifecycleService lifecycle: IAgentLifecycleService,
    @ISessionSubagentService subagents: ISessionSubagentService,
    @ISessionAgentProfileCatalog catalog: ISessionAgentProfileCatalog,
    @ISessionProcessRunner processRunner: ISessionProcessRunner,
    @IAgentProfileService profile: IAgentProfileService,
    @IModelCatalog modelCatalog: IModelCatalog,
    @IFlagService flags: IFlagService,
  ) {
    this.callerAgentId = scopeContext.agentId;
    this.tasks = tasks;
    this.session = session;
    this.logStore = logStore;
    this.bytes = bytes;
    this.hostFs = hostFs;
    this.hostEnvironment = hostEnvironment;
    this.wire = wire;
    this.telemetry = telemetry;
    this.log = log;
    this.config = config;
    this.budget = budget;
    this.spawnDeps = {
      callerAgentId: scopeContext.agentId,
      lifecycle,
      subagents,
      catalog,
      sessionContext: session,
      processRunner,
      log,
      modelCatalog,
      config,
      flags,
      profile,
    };
  }

  get parameters(): Record<string, unknown> {
    return WORKFLOW_PARAMETERS;
  }

  get description(): string {
    return WORKFLOW_DESCRIPTION;
  }

  resolveExecution(args: WorkflowToolInput): ToolExecution {
    const inline = args.script?.trim();
    const rawScriptPath = args.scriptPath?.trim();
    if (inline !== undefined && inline.length > 0 && rawScriptPath !== undefined && rawScriptPath.length > 0) {
      throw new Error2(ErrorCodes.VALIDATION_FAILED, 'Provide either `script` or `scriptPath`, not both.');
    }
    const hint = scriptNameHint(args);
    const scriptPath = this.resolveScriptPath(rawScriptPath);
    return {
      description: `Running workflow${hint === undefined ? '' : `: ${hint}`}`,
      accesses: scriptPath === undefined ? ToolAccesses.none() : ToolAccesses.readFile(scriptPath),
      approvalRule: this.name,
      execute: (ctx) => this.execution(args, ctx, scriptPath),
    };
  }

  private async execution(
    args: WorkflowToolInput,
    ctx: ExecutableToolContext,
    scriptPath: string | undefined,
  ): Promise<ExecutableToolResult> {
    try {
      ctx.signal.throwIfAborted();

      const source = await this.resolveSource(args, scriptPath);
      const compiled = compileWorkflowScript(source);
      if ('error' in compiled) {
        return { output: formatCompileFailure(compiled.error), isError: true };
      }

      const runId = generateWorkflowRunId();
      const scriptSha256 = workflowScriptSha256(source);
      const journal = this.createJournal(runId);
      await this.persistScript(runId, source);

      const resume = await this.loadResume(args.resumeFromRunId, source, scriptSha256);

      const task = new WorkflowTask({
        runId,
        script: source,
        scriptSha256,
        name: compiled.meta.name,
        description: workflowTaskDescription(compiled.meta),
        phases: compiled.meta.phases,
        phaseTitles: compiled.phaseTitles,
        args: args.args,
        meta: compiled.meta,
        tokenBudgetTotal: this.budget.total(),
        budget: this.budget.budget(),
        onSubagentUsage: (usage) => this.budget.recordSubagentUsage(usage),
        journal,
        wire: this.wire,
        telemetry: telemetryWorkflowHook(this.telemetry),
        log: this.log,
        spawnDeps: this.spawnDeps,
        parentToolCallId: ctx.toolCallId,
        resume,
      });

      const registerOptions: RegisterAgentTaskOptions = {
        detached: true,
      };
      const taskId = this.tasks.registerTask(task, registerOptions);

      return { output: formatWorkflowLaunch(taskId, runId, compiled.meta) };
    } catch (error) {
      return { output: `workflow error: ${errorMessage(error)}`, isError: true };
    }
  }

  private async resolveSource(args: WorkflowToolInput, resolvedScriptPath?: string): Promise<string> {
    const inline = args.script?.trim();
    const path = args.scriptPath?.trim();
    if (inline !== undefined && inline.length > 0 && path !== undefined && path.length > 0) {
      throw new Error2(ErrorCodes.VALIDATION_FAILED, 'Provide either `script` or `scriptPath`, not both.');
    }
    if (inline !== undefined && inline.length > 0) return inline;
    if (path !== undefined && path.length > 0 && resolvedScriptPath !== undefined) {
      return this.hostFs.readText(resolvedScriptPath);
    }
    throw new Error2(ErrorCodes.VALIDATION_FAILED, 'Workflow requires a `script` (or `scriptPath`).');
  }

  private resolveScriptPath(rawPath: string | undefined): string | undefined {
    const path = rawPath?.trim();
    if (path === undefined || path.length === 0) return undefined;
    rejectControlCharacters(path);
    const normalized = canonicalizePath(path, this.session.sessionDir, this.hostEnvironment.pathClass);
    if (!isWithinDirectory(normalized, this.session.sessionDir, this.hostEnvironment.pathClass)) {
      throw new Error2(
        ErrorCodes.FS_PATH_ESCAPES,
        `Workflow scriptPath escapes the session directory: ${normalized}`,
        { details: { path: normalized, sessionDir: this.session.sessionDir } },
      );
    }
    return normalized;
  }

  private createJournal(runId: WorkflowRunId): WorkflowJournal {
    return new WorkflowJournal({
      runId,
      scope: workflowJournalScope(this.session.scope(), runId),
      dir: workflowJournalDir(this.session.sessionDir, runId),
      log: this.logStore,
      onError: (error) => this.log.warn('workflow journal write failed', { runId, error }),
    });
  }

  private async persistScript(runId: WorkflowRunId, script: string): Promise<void> {
    await this.bytes.write(
      workflowJournalScope(this.session.scope(), runId),
      WORKFLOW_SCRIPT_KEY,
      textEncoder.encode(script),
    );
  }

  private async loadResume(
    resumeFromRunId: string | undefined,
    source: string,
    scriptSha256: string,
  ): Promise<WorkflowResumeLedger | undefined> {
    if (resumeFromRunId === undefined || resumeFromRunId.trim().length === 0) return undefined;
    const priorRunId = resumeFromRunId.trim();
    if (!isWorkflowRunId(priorRunId)) {
      throw new Error2(ErrorCodes.VALIDATION_FAILED, `Invalid workflow run id: "${priorRunId}"`);
    }
    const journal = new WorkflowJournal({
      runId: priorRunId,
      scope: workflowJournalScope(this.session.scope(), priorRunId),
      dir: workflowJournalDir(this.session.sessionDir, priorRunId),
      log: this.logStore,
    });
    const summary = await journal.readJournal();
    if (summary === undefined) {
      throw new Error2(
        ErrorCodes.VALIDATION_FAILED,
        `No workflow run "${priorRunId}" was found to resume.`,
      );
    }
    if (summary.status === 'running') {
      throw new Error2(
        ErrorCodes.VALIDATION_FAILED,
        `Workflow run "${priorRunId}" is still running and cannot be resumed.`,
      );
    }
    if (summary.scriptSha256 !== scriptSha256) {
      // A changed script is fine — the journal records each agent's cache key
      // (`sha256(prompt, effectiveOpts)`), so unchanged `agent()` calls replay
      // from cache and only edited or new calls re-run.
      this.log.info('workflow resume with edited script; cache-key replay applies', {
        runId: priorRunId,
      });
    }
    return { sourceRunId: priorRunId, completedByCacheKey: summary.completedByCacheKey };
  }
}

function scriptNameHint(args: WorkflowToolInput): string | undefined {
  const source = args.script ?? '';
  const match = /export\s+const\s+meta\s*=\s*\{\s*name\s*:\s*['"]([^'"]+)['"]/.exec(source);
  return match?.[1];
}

function workflowTaskDescription(meta: WorkflowScriptMeta): string {
  const detail = meta.description?.trim();
  return detail === undefined || detail.length === 0
    ? `Workflow: ${meta.name}`
    : `Workflow: ${meta.name} — ${detail}`;
}

function formatCompileFailure(error: WorkflowCompileError): string {
  const lines = [`Workflow script did not compile: ${error.message}`];
  for (const violation of error.violations ?? []) {
    lines.push(`  ${violation.message} (${String(violation.line)}:${String(violation.column)})`);
  }
  return lines.join('\n');
}

function formatWorkflowLaunch(taskId: string, runId: string, meta: WorkflowScriptMeta): string {
  return [
    `task_id: ${taskId}`,
    `run_id: ${runId}`,
    'status: running',
    `workflow: ${meta.name}`,
    'automatic_notification: true',
    '',
    'next_step: The completion arrives automatically in a later turn as a <task-notification> with the run summary/result. Do NOT wait, poll, or call TaskOutput on it; continue with other work or hand back to the user.',
    'resume_hint: To resume after a pause, kill, or script edit, call Workflow with resumeFromRunId set to the run_id above — completed agent() calls with unchanged (prompt, opts) return cached results instantly; only edited or new calls re-run. Read the run journal (<sessionDir>/workflows/<run_id>/journal.jsonl) before diagnosing an empty or unexpected result — it records each agent\'s actual return value.',
  ].join('\n');
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

/**
 * Reject control characters (other than tab/newline/carriage return) in a
 * `scriptPath`: they would be invisible or misleading in the approval dialog.
 * Mirrors the official tool's scriptPath rejection.
 */
function rejectControlCharacters(path: string): void {
  for (let index = 0; index < path.length; index++) {
    const code = path.charCodeAt(index);
    const isControl = (code < 0x20 && code !== 0x09 && code !== 0x0a && code !== 0x0d) || code === 0x7f;
    if (isControl) {
      throw new Error2(
        ErrorCodes.VALIDATION_FAILED,
        'scriptPath contains control characters that would be hidden in the approval dialog.',
      );
    }
  }
}

registerAgentToolService(IWorkflowTool, WorkflowTool, {
  name: WORKFLOW_TOOL_NAME,
  domain: 'workflow',
  when: (accessor) => {
    try {
      if (accessor.get(IAgentUltracodeService).isActive) return true;
      const config = accessor.get(IConfigService).get<AgentConfig | undefined>(AGENT_SECTION);
      return config?.workflowToolEnabled !== false;
    } catch {
      return false;
    }
  },
});
