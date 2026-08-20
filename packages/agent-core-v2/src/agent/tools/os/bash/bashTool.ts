/**
 * `tools` domain — `BashTool` implementation, the model's shell command
 * runner.
 *
 * Invokes the execution-environment shell (POSIX bash; Git Bash on Windows)
 * through the injected `ISessionProcessRunner`. The command runs as
 * `cd <cwd> && <command>` inside the environment's working directory.
 *
 * Collaborators injected via constructor:
 *   - `runner`     — `ISessionProcessRunner`, spawns the shell process
 *   - `env`        — `IHostEnvironment`, host OS / shell probe (osKind / shellName / shellPath)
 *   - `ctx`        — `ISessionContext`, session cwd used to render the shell prompt
 *   - `workspace`  — Agent workspace view used for lease cwd and command-boundary checks
 *   - `tasks`      — `IAgentTaskService`, owns foreground/detached task
 *                    lifecycle (timeouts, detach, user interrupt)
 *   - `toolPolicy` — `IAgentToolPolicyService`, gates background execution on
 *                    the Task* tools being active
 *   - `config`     — `IConfigService`, task config (auto-background on
 *                    timeout, detach timeout)
 *
 * Execution goes through `ISessionProcessRunner`, never directly via
 * `node:child_process`.
 *
 * Hardening:
 *   - `args.timeout` (seconds) arms the manager-owned deadline; a foreground
 *     command whose deadline fires is moved to the background instead of
 *     being killed (unless disabled via config), while the ambient `signal`
 *     always stops the task.
 *   - stdin is closed immediately so interactive commands (`cat`, `read`,
 *     `python -c 'input()'`) receive EOF instead of hanging.
 *   - Two-phase kill is owned by `IAgentTaskService`: SIGTERM → grace → SIGKILL.
 *   - stdout/stderr are captured by `ProcessTask` for task output;
 *     foreground runs pass a callback to collect chunks for this call.
 *
 * Ported from v1. The
 * v1 `process.env` spread is intentionally dropped: v2's `ISessionProcessRunner.exec`
 * already overlays the per-call `env` on `process.env`, so only the
 * noninteractive knobs are passed here.
 *
 * Bound at Agent scope; self-registers via `registerAgentToolService(...)` at module
 * load.
 */

import { IAgentTaskService } from '#/agent/task/task';
import { resolveAgentTaskConfig } from '#/agent/task/configSection';
import { IConfigService } from '#/app/config/config';
import { IBashParserService } from '#/app/bashParser/bashParser';
import type { BashSyntaxNode } from '#/app/bashParser/bashParser';
import { Error2, ErrorCodes } from '#/errors';
import { IHostEnvironment } from '#/os/interface/hostEnvironment';
import { ISessionContext } from '#/session/sessionContext/sessionContext';
import { ISessionProcessRunner, type IProcess } from '#/session/process/processRunner';
import {
  assertWorkspacePathBeforeIO,
  ISessionWorkspaceContext,
} from '#/session/workspaceContext/workspaceContext';
import { IAgentToolPolicyService } from '#/agent/toolPolicy/toolPolicy';
import {
  ToolAccesses,
  type ExecutableToolResult,
  type ToolExecution,
  type ToolFileAccessOperation,
  type ToolResourceAccess,
  type ToolUpdate,
} from '#/tool/toolContract';
import {
  type ExecutableToolResultBuilderResult,
  ToolResultBuilder,
} from '#/tool/result-builder';
import { registerAgentToolService } from '#/agent/toolRegistry/toolContribution';
import { toInputJsonSchema } from '#/tool/input-schema';
import { literalRulePattern, matchesGlobRuleSubject } from '#/tool/rule-match';
import { renderPrompt } from '#/_base/utils/render-prompt';
import { userCancellationReason } from '#/_base/utils/abort';
import bashDescriptionTemplate from './bash.md?raw';
import { ProcessTask } from './process-task';
import {
  type BashInput,
  BashInputSchema,
  DEFAULT_BACKGROUND_TIMEOUT_S,
  DEFAULT_TIMEOUT_S,
  IBashTool,
  MAX_BACKGROUND_TIMEOUT_S,
  MAX_TIMEOUT_S,
} from './bash';

const MS_PER_SECOND = 1000;

const SHELL_TIMEOUT_VARS = {
  DEFAULT_TIMEOUT_S,
  DEFAULT_BACKGROUND_TIMEOUT_S,
  MAX_TIMEOUT_S,
  MAX_BACKGROUND_TIMEOUT_S,
};

function timeoutCapS(isBackground: boolean): number {
  return isBackground ? MAX_BACKGROUND_TIMEOUT_S : MAX_TIMEOUT_S;
}

function normalizeTimeoutMs(timeout: number | undefined, isBackground: boolean): number {
  const defaultSeconds = isBackground ? DEFAULT_BACKGROUND_TIMEOUT_S : DEFAULT_TIMEOUT_S;
  const value = timeout ?? defaultSeconds;
  return Math.min(value, timeoutCapS(isBackground)) * MS_PER_SECOND;
}

async function disposeProcess(proc: IProcess): Promise<void> {
  try {
    await proc.dispose();
  } catch {
  }
}

function renderBashDescription(shellName: string): string {
  return renderPrompt(bashDescriptionTemplate, { ...SHELL_TIMEOUT_VARS, SHELL_NAME: shellName });
}

function withoutBackgroundDescription(description: string): string {
  return description
    .replace(
      /\r?\n\r?\nIf `run_in_background=true`,[\s\S]*?point them to the `\/tasks` command, which opens an interactive panel; it has no subcommands\./,
      '\n\nBackground execution is disabled for this agent. Do not set `run_in_background=true`.',
    )
    .replace(
      ` For possibly long-running foreground commands, set the \`timeout\` argument in seconds. Foreground commands default to ${String(DEFAULT_TIMEOUT_S)}s and allow up to ${String(MAX_TIMEOUT_S)}s. When a foreground command hits its timeout it is moved to the background instead of being killed, and you will be automatically notified when it completes.`,
      ` For possibly long-running commands, set the \`timeout\` argument in seconds. The default is ${String(DEFAULT_TIMEOUT_S)}s; foreground commands allow up to ${String(MAX_TIMEOUT_S)}s; a foreground command that hits its timeout is killed.`,
    )
    .replace(
      /\r?\n- Prefer `run_in_background=true`[\s\S]*?conversation to continue before the command finishes\./,
      '\n- Do not set `run_in_background=true`; background task management tools are not available.',
    );
}

function withoutAutoBackgroundOnTimeout(description: string): string {
  return description.replace(
    ' When a foreground command hits its timeout it is moved to the background instead of being killed, and you will be automatically notified when it completes.',
    ' A foreground command that hits its timeout is killed.',
  );
}

export class BashTool implements IBashTool {
  declare readonly _serviceBrand: undefined;
  readonly name = 'Bash' as const;
  readonly parameters: Record<string, unknown> = toInputJsonSchema(BashInputSchema);

  private readonly isWindowsBash: boolean;

  private readonly renderedDescription: string;

  constructor(
    @ISessionProcessRunner private readonly runner: ISessionProcessRunner,
    @IHostEnvironment private readonly env: IHostEnvironment,
    @ISessionContext private readonly ctx: ISessionContext,
    @IAgentTaskService private readonly tasks: IAgentTaskService,
    @IAgentToolPolicyService private readonly toolPolicy: IAgentToolPolicyService,
    @IConfigService private readonly config: IConfigService,
    @IBashParserService private readonly bashParser?: IBashParserService,
    @ISessionWorkspaceContext private readonly workspace?: ISessionWorkspaceContext,
  ) {
    this.isWindowsBash = this.env.osKind === 'Windows';
    this.renderedDescription = renderBashDescription(this.env.shellName);
  }

  private allowBackground(): boolean {
    return (
      this.toolPolicy.isToolActive('TaskList') &&
      this.toolPolicy.isToolActive('TaskOutput') &&
      this.toolPolicy.isToolActive('TaskStop')
    );
  }

  private autoBackgroundOnTimeout(): boolean {
    return resolveAgentTaskConfig(this.config)?.bashAutoBackgroundOnTimeout ?? true;
  }

  private detachTimeoutMs(): number {
    const configuredS = resolveAgentTaskConfig(this.config)?.bashTaskTimeoutS;
    if (configuredS === undefined) return DEFAULT_BACKGROUND_TIMEOUT_S * MS_PER_SECOND;
    return configuredS * MS_PER_SECOND;
  }

  get description(): string {
    if (!this.allowBackground()) return withoutBackgroundDescription(this.renderedDescription);
    if (!this.autoBackgroundOnTimeout()) {
      return withoutAutoBackgroundOnTimeout(this.renderedDescription);
    }
    return this.renderedDescription;
  }

  resolveExecution(args: BashInput): ToolExecution {
    const preview = args.command.length > 50 ? `${args.command.slice(0, 50)}…` : args.command;
    // Parse once into per-subcommand argv so every `matchesRule` probe (one per
    // permission rule) reuses the same tree instead of re-parsing. Fails safe:
    // an unavailable parser, a budget-aborted parse, a syntax-error tree, or a
    // tree with no command nodes degrades to whole-string matching and
    // conservative `all()` accesses. Isolation turns that uncertainty into a
    // hard boundary error before a shell is spawned.
    const subcommands =
      this.bashParser === undefined ? undefined : splitCommandArgvs(args.command, this.bashParser);
    this.assertIsolationCommandAccess(args, subcommands);
    const accesses =
      subcommands === undefined || subcommands.length === 0
        ? ToolAccesses.all()
        : (bashFileAccesses(subcommands) ?? ToolAccesses.all());
    return {
      description: args.run_in_background
        ? `Starting background: ${preview}`
        : `Running: ${preview}`,
      display: {
        kind: 'command',
        command: args.command,
        cwd: args.cwd ?? this.workspaceCwd(),
        description: args.description,
        language: 'bash',
      },
      approvalRule: literalRulePattern(this.name, args.command),
      matchesRule: (ruleArgs) =>
        subcommands === undefined || subcommands.length === 0
          ? matchesGlobRuleSubject(ruleArgs, args.command)
          : matchesGlobRuleSubject(ruleArgs, args.command) ||
            subcommands.some((sub) => matchesGlobRuleSubject(ruleArgs, sub.argv.join(' '))),
      accesses,
      execute: ({ signal, onUpdate, onForegroundTaskStart }) =>
        this.execution(args, signal, onUpdate, onForegroundTaskStart, subcommands),
    };
  }

  private spawn(effectiveCwd: string, command: string): Promise<IProcess> {
    const shellCwd = this.isWindowsBash ? windowsPathToPosixPath(effectiveCwd) : effectiveCwd;
    const shellArgs = [
      this.env.shellPath,
      '-c',
      `cd ${shellQuote(shellCwd)} && ${command}`,
    ];

    const noninteractiveEnv: Record<string, string> = {
      NO_COLOR: '1',
      TERM: 'dumb',
      GIT_TERMINAL_PROMPT: process.env['GIT_TERMINAL_PROMPT'] ?? '0',
      SHELL: this.env.shellPath,
    };

    const options =
      this.workspace?.isolation === undefined
        ? { env: noninteractiveEnv }
        : { cwd: effectiveCwd, env: noninteractiveEnv };
    return this.runner.exec(shellArgs, options);
  }

  private async execution(
    args: BashInput,
    signal: AbortSignal,
    onUpdate?: (update: ToolUpdate) => void,
    onForegroundTaskStart?: (taskId: string) => void,
    subcommands?: readonly BashSubcommand[],
  ): Promise<ExecutableToolResult> {
    const validationError = this.validateRunRequest(args, signal);
    if (validationError !== undefined) return validationError;

    const startsInBackground = args.run_in_background === true;
    const foregroundTimeoutMs = normalizeTimeoutMs(args.timeout, false);
    const command = this.isWindowsBash ? rewriteWindowsNullRedirect(args.command) : args.command;
    const effectiveCwd =
      args.cwd === undefined
        ? this.workspaceCwd()
        : this.workspace?.isolation === undefined
          ? args.cwd
          : this.workspace.assertAllowed(args.cwd, 'execute');
    const description = startsInBackground ? args.description!.trim() : foregroundDescription(args);
    const timeoutMs = startsInBackground
      ? args.disable_timeout
        ? undefined
        : normalizeTimeoutMs(args.timeout, true)
      : foregroundTimeoutMs;

    const builder = new ToolResultBuilder();
    let proc: IProcess;
    try {
      if (this.workspace?.isolation !== undefined) {
        await assertWorkspacePathBeforeIO(this.workspace, effectiveCwd, 'execute');
        if (subcommands !== undefined) await this.assertIsolationCommandRealPaths(subcommands);
      }
      proc = await this.spawn(effectiveCwd, command);
    } catch (error) {
      return {
        isError: true,
        output: error instanceof Error ? error.message : String(error),
      };
    }
    closeProcessStdin(proc);

    let collectForegroundOutput = !startsInBackground;
    let foregroundOutputPersisted = false;
    let foregroundTaskId: string | undefined;
    const onProcessOutput = startsInBackground
      ? undefined
      : (kind: 'stdout' | 'stderr', text: string): void => {
          if (!collectForegroundOutput) return;
          onUpdate?.({ kind, text });
          builder.write(text);
          if (!foregroundOutputPersisted && builder.truncated && foregroundTaskId !== undefined) {
            this.tasks.persistOutput(foregroundTaskId);
            foregroundOutputPersisted = true;
          }
        };

    let taskId: string;
    try {
      taskId = this.tasks.registerTask(
        new ProcessTask(proc, command, description, onProcessOutput),
        {
          detached: startsInBackground,
          timeoutMs,
          detachTimeoutMs: this.detachTimeoutMs(),
          autoBackgroundOnTimeout: this.allowBackground() && this.autoBackgroundOnTimeout(),
          signal: startsInBackground ? undefined : signal,
        },
      );
      foregroundTaskId = startsInBackground ? undefined : taskId;
    } catch (error) {
      collectForegroundOutput = false;
      await killSpawnedProcess(proc);
      return {
        isError: true,
        output: error instanceof Error ? error.message : String(error),
      };
    }

    if (!startsInBackground) onForegroundTaskStart?.(taskId);

    if (startsInBackground) {
      return this.backgroundStartedResult(taskId, proc, description, {
        title: 'Background task started',
        brief: `Started ${taskId}`,
      });
    }

    try {
      const release = await this.tasks.waitForForegroundRelease(taskId);
      if (release === 'detached' || release === 'timeout_detached') {
        collectForegroundOutput = false;
        const labels =
          release === 'timeout_detached'
            ? {
                title: 'Command timed out and moved to background',
                brief: `Backgrounded ${taskId} after timeout`,
              }
            : {
                title: 'Task moved to background',
                brief: `Backgrounded ${taskId}`,
              };
        return this.backgroundStartedResult(
          taskId,
          proc,
          description,
          labels,
          builder,
          'foreground_detached',
        );
      }

      return await this.foregroundCompletionResult(taskId, proc, builder, foregroundTimeoutMs);
    } finally {
      collectForegroundOutput = false;
    }
  }

  private validateRunRequest(
    args: BashInput,
    signal: AbortSignal,
  ): ExecutableToolResult | undefined {
    if (signal.aborted) return { isError: true, output: 'Aborted before command started' };
    if (args.command.length === 0) return { isError: true, output: 'Command cannot be empty.' };
    if (args.run_in_background !== true) return undefined;
    if (!this.allowBackground()) {
      return {
        isError: true,
        output:
          'Background execution is not available for this agent because TaskOutput and TaskStop are not enabled.',
      };
    }
    if (!args.description?.trim()) {
      return {
        isError: true,
        output: 'description is required when run_in_background is true.',
      };
    }
    return undefined;
  }

  private workspaceCwd(): string {
    return this.workspace?.workDir ?? this.ctx.cwd;
  }

  private assertIsolationCommandAccess(
    args: BashInput,
    subcommands: readonly BashSubcommand[] | undefined,
  ): void {
    const workspace = this.workspace;
    if (workspace?.isolation === undefined) return;
    if (workspace.isolation.state === 'active' && /(?:^|[\s;&|()])git(?:\s|$)/i.test(args.command)) {
      throw unsupportedIsolatedGitError();
    }
    if (args.cwd !== undefined) workspace.assertAllowed(args.cwd, 'execute');
    if (subcommands === undefined || subcommands.length === 0) {
      throw isolationBoundaryError(
        'The shell command could not be parsed, so its workspace access cannot be verified.',
      );
    }
    for (const subcommand of subcommands) {
      const name = commandName(subcommand.argv[0]);
      if (name === undefined) {
        throw isolationBoundaryError(
          "A shell command without a command name cannot be safely analyzed inside an isolated workspace.",
        );
      }
      if (name === 'git' && workspace.isolation.state === 'active') {
        throw unsupportedIsolatedGitError();
      }
      if (DYNAMIC_COMMANDS.has(name)) {
        throw isolationBoundaryError(
          `The shell command '${name}' is a dynamic wrapper and is not allowed inside an isolated workspace.`,
        );
      }
      if (!ISOLATION_SAFE_COMMANDS.has(name)) {
        throw isolationBoundaryError(
          `The shell command '${name}' cannot be safely analyzed inside an isolated workspace.`,
        );
      }
      const analysis = analyzeIsolationCommand(subcommand.argv);
      if (!workspace.isolation.writable && analysis.operation === 'write') {
        throw isolationBoundaryError(
          `The shell command '${name}' may write or otherwise mutate the workspace.`,
        );
      }
      for (const path of analysis.paths) {
        assertIsolationPath(workspace, path, analysis.pathOperation);
      }
      for (const redirect of subcommand.redirects) {
        assertIsolationPath(
          workspace,
          redirect.target,
          READ_REDIRECT_OPERATORS.has(redirect.operator) ? 'read' : 'write',
        );
        const operation = READ_REDIRECT_OPERATORS.has(redirect.operator) ? 'read' : 'write';
        if (!workspace.isolation.writable && operation === 'write') {
          throw isolationBoundaryError(
            'The active workspace isolation lease is read-only; shell redirection may write files.',
          );
        }
      }
    }
  }

  private async assertIsolationCommandRealPaths(
    subcommands: readonly BashSubcommand[],
  ): Promise<void> {
    const workspace = this.workspace;
    if (workspace === undefined) return;
    for (const subcommand of subcommands) {
      const analysis = analyzeIsolationCommand(subcommand.argv);
      for (const path of analysis.paths) {
        await assertWorkspacePathBeforeIO(
          workspace,
          workspace.resolve(path),
          analysis.pathOperation,
        );
      }
      for (const redirect of subcommand.redirects) {
        const operation = READ_REDIRECT_OPERATORS.has(redirect.operator) ? 'read' : 'write';
        await assertWorkspacePathBeforeIO(
          workspace,
          workspace.resolve(redirect.target),
          operation,
        );
      }
    }
  }

  private async foregroundCompletionResult(
    taskId: string,
    proc: IProcess,
    builder: ToolResultBuilder,
    foregroundTimeoutMs: number,
  ): Promise<ExecutableToolResult> {
    const current = this.tasks.getTask(taskId);
    const exitCode = current?.kind === 'process' ? current.exitCode : proc.exitCode;
    let result: ExecutableToolResultBuilderResult;
    if (current?.status === 'timed_out') {
      const timeoutLabel = formatTimeoutLabel(foregroundTimeoutMs);
      result = builder.error(`Command killed by timeout (${timeoutLabel})`, {
        brief: `Killed by timeout (${timeoutLabel})`,
      });
    } else if (
      current?.status === 'killed' &&
      current.stopReason === userCancellationReason().message
    ) {
      result = builder.error('Interrupted by user', { brief: 'Interrupted by user' });
    } else if (
      (current?.status === 'failed' || current?.status === 'killed') &&
      current.stopReason !== undefined
    ) {
      result = builder.error(current.stopReason, { brief: current.stopReason });
    } else if (exitCode === 0) {
      result = builder.ok('Command executed successfully.');
    } else {
      if (builder.nChars === 0) builder.write(`Process exited with code ${String(exitCode)}`);
      result = builder.error(`Command failed with exit code: ${String(exitCode)}.`, {
        brief: `Failed with exit code: ${String(exitCode)}`,
      });
    }
    return this.addForegroundOutputReference(taskId, result);
  }

  private async addForegroundOutputReference(
    taskId: string,
    result: ExecutableToolResultBuilderResult,
  ): Promise<ExecutableToolResult> {
    if (!result.truncated) return result;
    const output = await this.tasks.getOutputSnapshot(taskId, 0);
    if (!output.fullOutputAvailable || output.outputPath === undefined) return result;

    const taskOutputHint = this.allowBackground()
      ? `, or TaskOutput(task_id="${taskId}")`
      : '';
    const reference =
      `\n\n[Full output saved]\n` +
      `task_id: ${taskId}\n` +
      `output_path: ${output.outputPath}\n` +
      `output_size_bytes: ${String(output.outputSizeBytes)}\n` +
      `next_step: Use Read with output_path to page through the full log${taskOutputHint}.`;
    return { ...result, output: `${result.output}${reference}` };
  }

  private backgroundStartedResult(
    taskId: string,
    proc: IProcess,
    description: string,
    labels: { title: string; brief: string },
    builder = new ToolResultBuilder(),
    scenario: 'background_started' | 'foreground_detached' = 'background_started',
  ): ExecutableToolResult {
    const status = this.tasks.getTask(taskId)?.status ?? 'running';
    const metadata =
      `task_id: ${taskId}\n` +
      `pid: ${String(proc.pid)}\n` +
      `description: ${description}\n` +
      `status: ${status}\n` +
      `automatic_notification: true\n` +
      this.nextStepLines(scenario) +
      'human_shell_hint: Tell the human to run /tasks to open the interactive background-task panel.';

    const foregroundResult = builder.ok('');
    const foregroundOutput = foregroundResult.output.length > 0 ? foregroundResult.output : '';
    const result: ExecutableToolResult & {
      readonly brief: string;
      readonly truncated: boolean;
    } = {
      isError: false,
      output:
        foregroundOutput.length === 0
          ? metadata
          : `${metadata}\n\nforeground_output:\n${foregroundOutput}`,
      brief: labels.brief,
      truncated: foregroundResult.truncated,
    };
    return result;
  }

  private nextStepLines(
    scenario: 'background_started' | 'foreground_detached',
  ): string {
    if (scenario === 'foreground_detached') {
      const avoid = this.allowBackground()
        ? 'do NOT wait, poll, or call TaskOutput on it'
        : 'do NOT wait or poll';
      return (
        'next_step: The task now runs in the background. You will be automatically notified ' +
        `when it completes — ${avoid}; continue with your current work.\n`
      );
    }
    if (!this.allowBackground()) {
      return 'next_step: You will be automatically notified when it completes.\n';
    }
    return (
      'next_step: The completion arrives automatically in a later turn — do NOT wait, poll, ' +
      'or call TaskOutput on it; continue with your current work.\n' +
      'next_step: Use TaskStop only if the task must be cancelled.\n'
    );
  }
}

registerAgentToolService(IBashTool, BashTool, { name: 'Bash', domain: 'os/backends' });

export interface BashRedirect {
  readonly operator: string;
  readonly target: string;
}

export interface BashSubcommand {
  readonly argv: readonly string[];
  readonly redirects: readonly BashRedirect[];
}

const BASH_REDIRECT_OPERATORS = new Set(['<', '>', '>>', '>&', '<&', '&>', '&>>', '>|', '<>']);
const READ_REDIRECT_OPERATORS = new Set(['<']);

// Isolation intentionally accepts only commands for which the option grammar
// and every path-bearing argument are known. An unrecognised option is a hard
// error; skipping it would allow options such as `--target-directory` or
// `--file` to redirect an otherwise safe-looking command.
const PATH_ARG_COMMANDS = new Set([
  'ls',
  'rm',
  'rmdir',
  'mv',
  'cp',
  'ln',
  'touch',
  'cat',
  'head',
  'tail',
  'less',
  'more',
  'wc',
  'stat',
  'file',
  'grep',
  'rg',
  'mkdir',
  'install',
  'chmod',
  'chown',
  'truncate',
  'tee',
  'tar',
]);

const READ_PATH_COMMANDS = new Set([
  'ls',
  'cat',
  'head',
  'tail',
  'less',
  'more',
  'wc',
  'stat',
  'file',
  'grep',
  'rg',
]);
const ISOLATION_SAFE_COMMANDS = new Set([
  ...READ_PATH_COMMANDS,
  ...PATH_ARG_COMMANDS,
  'cd',
  'pushd',
  'echo',
  'printf',
  'pwd',
  'true',
  'false',
]);
const DYNAMIC_COMMANDS = new Set([
  'bash',
  'sh',
  'dash',
  'zsh',
  'ksh',
  'fish',
  'python',
  'python2',
  'python3',
  'pypy',
  'node',
  'nodejs',
  'deno',
  'bun',
  'ruby',
  'perl',
  'php',
  'find',
  'xargs',
  'parallel',
  'eval',
  'exec',
  'source',
  '.',
  'env',
  'sudo',
  'doas',
  'command',
  'builtin',
]);
const UNSAFE_SYNTAX_NODE_TYPES = new Set([
  'ERROR',
  'error',
  'arithmetic_expansion',
  'command_substitution',
  'process_substitution',
  'expansion',
  'simple_expansion',
  'variable_assignment',
  'variable_assignments',
  'function_definition',
  'subshell',
  'if_statement',
  'for_statement',
  'while_statement',
  'until_statement',
  'case_statement',
  'compound_statement',
  'test_command',
  'heredoc_redirect',
  'herestring_redirect',
  'coprocess',
  'negated_command',
]);

type IsolationCommandOperation = 'read' | 'write';
type IsolationPathOperation = 'read' | 'write' | 'execute';
type PositionalKind =
  | 'none'
  | 'paths'
  | 'pattern-paths'
  | 'mode-paths'
  | 'owner-paths'
  | 'tar';

interface IsolationOptionSpec {
  readonly flags: ReadonlySet<string>;
  readonly values: ReadonlySet<string>;
  readonly pathValues: ReadonlySet<string>;
  readonly allowDoubleDash: boolean;
  readonly positional: PositionalKind;
}

interface ParsedIsolationArguments {
  readonly positional: readonly string[];
  readonly beforeDoubleDash: readonly string[];
  readonly afterDoubleDash: readonly string[];
  readonly optionPaths: readonly string[];
  readonly flags: ReadonlySet<string>;
}

interface IsolationCommandAnalysis {
  readonly operation: IsolationCommandOperation;
  readonly pathOperation: IsolationPathOperation;
  readonly paths: readonly string[];
}

const setOf = (...values: readonly string[]): ReadonlySet<string> => new Set(values);

const COMMON_READ_FLAGS = setOf('-a', '-A', '-b', '-e', '-E', '-h', '-H', '-i', '-k', '-L', '-l', '-m', '-n', '-N', '-P', '-q', '-R', '-r', '-s', '-S', '-t', '-T', '-v', '-w', '-x', '--all', '--brief', '--bytes', '--chars', '--dereference', '--files', '--human-readable', '--lines', '--long', '--mime-encoding', '--mime-type', '--number', '--quiet', '--recursive', '--show-all', '--show-nonprinting', '--show-tabs', '--silent', '--size', '--squeeze-blank', '--terse', '--verbose', '--words');

const NO_VALUE_SPEC = (flags: ReadonlySet<string>, positional: PositionalKind): IsolationOptionSpec => ({
  flags,
  values: setOf(),
  pathValues: setOf(),
  allowDoubleDash: true,
  positional,
});

const COMMAND_OPTION_SPECS: Readonly<Record<string, IsolationOptionSpec>> = {
  ls: NO_VALUE_SPEC(setOf('-1', '-A', '-a', '-B', '-C', '-d', '-F', '-G', '-h', '-i', '-l', '-n', '-p', '-q', '-r', '-S', '-t', '-U', '-X', '--all', '--almost-all', '--classify', '--directory', '--group-directories-first', '--human-readable', '--inode', '--long', '--numeric-uid-gid', '--reverse', '--sort', '--time-style'), 'paths'),
  cat: NO_VALUE_SPEC(setOf('-A', '-b', '-e', '-E', '-n', '-s', '-t', '-T', '-v', '--number', '--show-all', '--show-nonprinting', '--show-tabs', '--squeeze-blank'), 'paths'),
  head: { ...NO_VALUE_SPEC(setOf('-q', '-v', '--quiet', '--silent', '--verbose'), 'paths'), values: setOf('-c', '-n', '--bytes', '--lines') },
  tail: { ...NO_VALUE_SPEC(setOf('-f', '-F', '-q', '-v', '--follow', '--quiet', '--retry', '--silent', '--verbose'), 'paths'), values: setOf('-c', '-n', '--bytes', '--lines', '--pid') },
  less: NO_VALUE_SPEC(setOf('-E', '-F', '-X', '-R', '-S', '-M', '-N', '-q', '-Q', '-s'), 'paths'),
  more: NO_VALUE_SPEC(setOf('-d', '-f', '-l', '-p', '-c', '-s'), 'paths'),
  wc: { ...NO_VALUE_SPEC(setOf('-c', '-m', '-l', '-L', '-w', '--bytes', '--chars', '--lines', '--max-line-length', '--words'), 'paths'), pathValues: setOf('--files0-from') },
  stat: { ...NO_VALUE_SPEC(setOf('-f', '--filesystem', '--terse'), 'paths'), values: setOf('-c', '--format', '--printf') },
  file: NO_VALUE_SPEC(setOf('-b', '-c', '-C', '-h', '-i', '-k', '-n', '-N', '-p', '-r', '-s', '-z', '--brief', '--checking-printout', '--exclude', '--keep-going', '--mime', '--mime-type', '--mime-encoding', '--no-pad', '--print0', '--preserve-date', '--raw', '--special-files', '--uncompress'), 'paths'),
  du: { ...NO_VALUE_SPEC(setOf('-a', '-b', '-c', '-h', '-k', '-m', '-P', '-s', '-x', '--all', '--bytes', '--human-readable', '--summarize', '--one-file-system'), 'paths'), values: setOf('-d', '--max-depth') },
  rmdir: NO_VALUE_SPEC(setOf('-p', '-v', '--ignore-fail-on-non-empty', '--parents', '--verbose'), 'paths'),
  rm: NO_VALUE_SPEC(setOf('-d', '-f', '-i', '-I', '-v', '--dir', '--force', '--interactive', '--one-file-system', '--preserve-root', '--no-preserve-root', '--verbose'), 'paths'),
  cp: NO_VALUE_SPEC(setOf('-f', '-i', '-n', '-p', '-P', '-T', '-u', '-v', '--attributes-only', '--backup', '--force', '--interactive', '--link', '--no-clobber', '--no-dereference', '--no-target-directory', '--parents', '--reflink', '--remove-destination', '--sparse', '--update', '--verbose'), 'paths'),
  mv: NO_VALUE_SPEC(setOf('-b', '-f', '-i', '-n', '-S', '-T', '-u', '-v', '--backup', '--force', '--interactive', '--no-clobber', '--no-target-directory', '--strip-trailing-slashes', '--update', '--verbose'), 'paths'),
  ln: NO_VALUE_SPEC(setOf('-b', '-d', '-f', '-i', '-n', '-P', '-T', '-v', '--backup', '--directory', '--force', '--interactive', '--no-dereference', '--no-target-directory', '--verbose'), 'paths'),
  touch: { ...NO_VALUE_SPEC(setOf('-a', '-c', '-m', '--no-create'), 'paths'), values: setOf('-d', '-t', '--date', '--time'), pathValues: setOf('-r', '--reference') },
  mkdir: { ...NO_VALUE_SPEC(setOf('-p', '-v', '--parents', '--verbose'), 'paths'), values: setOf('-m', '--mode'), pathValues: setOf('--parent', '--target-directory') },
  install: { ...NO_VALUE_SPEC(setOf('-D', '-d', '-p', '-s', '-T', '-v', '--compare', '--directory', '--no-target-directory', '--preserve-timestamps', '--strip', '--verbose'), 'paths'), values: setOf('-g', '-m', '-o', '--backup', '--context', '--group', '--mode', '--owner', '--suffix'), pathValues: setOf('-t', '--target-directory', '--parent') },
  chmod: { ...NO_VALUE_SPEC(setOf('-c', '-f', '-v', '--changes', '--no-preserve-root', '--preserve-root', '--quiet', '--silent', '--verbose'), 'mode-paths'), pathValues: setOf('--reference') },
  chown: { ...NO_VALUE_SPEC(setOf('-c', '-f', '-h', '-v', '--changes', '--from', '--no-dereference', '--no-preserve-root', '--preserve-root', '--quiet', '--silent', '--verbose'), 'owner-paths'), pathValues: setOf('--reference') },
  truncate: { ...NO_VALUE_SPEC(setOf('-c', '--no-create'), 'paths'), values: setOf('-s', '--size'), pathValues: setOf('-r', '--reference') },
  tee: NO_VALUE_SPEC(setOf('-a', '-i', '--append', '--ignore-interrupts'), 'paths'),
  grep: { ...NO_VALUE_SPEC(setOf('-E', '-F', '-G', '-P', '-a', '-b', '-c', '-h', '-H', '-i', '-l', '-n', '-o', '-q', '-s', '-v', '-w', '-x', '--binary-files', '--color', '--directories', '--exclude', '--exclude-dir', '--extended-regexp', '--fixed-strings', '--help', '--ignore-case', '--include', '--line-number', '--only-matching', '--quiet', '--silent', '--text', '--word-regexp'), 'pattern-paths'), values: setOf('-A', '-B', '-C', '-e', '-m', '--after-context', '--before-context', '--context', '--max-count', '--regexp'), pathValues: setOf('-f', '--file') },
  rg: { ...NO_VALUE_SPEC(setOf('-E', '-F', '-G', '-I', '-M', '-N', '-P', '-a', '-b', '-c', '-g', '-h', '-H', '-i', '-l', '-n', '-o', '-q', '-r', '-s', '-v', '-w', '-x', '--binary-files', '--color', '--count', '--files', '--files-with-matches', '--hidden', '--ignore-case', '--ignore-file', '--json', '--line-number', '--no-ignore', '--no-ignore-vcs', '--null', '--only-matching', '--quiet', '--regexp', '--text', '--type', '--type-add', '--type-not', '--word-regexp'), 'pattern-paths'), values: setOf('-A', '-B', '-C', '-e', '-M', '--after-context', '--before-context', '--context', '--max-count', '--regexp', '--type'), pathValues: setOf('-f', '--file', '--ignore-file') },
  tar: { ...NO_VALUE_SPEC(setOf('-c', '-j', '-J', '-k', '-O', '-p', '-t', '-v', '-x', '-z', '--anchored', '--atime-preserve', '--create', '--extract', '--keep-old-files', '--list', '--no-anchored', '--no-recursion', '--no-same-owner', '--no-overwrite-dir', '--no-unquote', '--one-file-system', '--preserve-permissions', '--same-owner', '--skip-old-files', '--to-stdout', '--verbose'), 'tar'), values: setOf('--exclude', '--null', '--occurrence', '--warning'), pathValues: setOf('-C', '-f', '--directory', '--exclude-from', '--file') },
};

const GIT_READ_ONLY_COMMANDS = new Set(['status', 'diff', 'log', 'show', 'branch', 'rev-parse', 'ls-files', 'grep', 'cat-file', 'remote', 'describe', 'shortlog']);
const GIT_KNOWN_COMMANDS = new Set([
  ...GIT_READ_ONLY_COMMANDS,
  'add',
  'apply',
  'checkout',
  'clone',
  'commit',
  'config',
  'cp',
  'fetch',
  'init',
  'merge',
  'mv',
  'pull',
  'push',
  'rebase',
  'restore',
  'reset',
  'rm',
  'switch',
  'tag',
  'worktree',
]);
const GIT_SAFE_GLOBAL_FLAGS = new Set([
  '--bare',
  '--git-dir',
  '--literal-pathspecs',
  '--glob-pathspecs',
  '--noglob-pathspecs',
  '--icase-pathspecs',
  '--no-pager',
  '--paginate',
  '--no-replace-objects',
  '--no-optional-locks',
  '--version',
  '--help',
]);
const GIT_SAFE_GLOBAL_VALUES = new Set(['--namespace']);
const GIT_SAFE_GLOBAL_PATH_VALUES = new Set(['-C', '--git-dir', '--work-tree']);
const GIT_REJECTED_GLOBAL_OPTIONS = new Set([
  '-c',
  '--config',
  '--config-env',
  '--exec-path',
  '--file',
  '--global',
  '--includes',
  '--local',
  '--no-includes',
  '--system',
  '--worktree',
]);

const GIT_COMMON_FLAGS = setOf('-q', '-v', '--quiet', '--verbose', '--progress', '--no-progress', '--force', '--dry-run', '--keep-going', '--stat', '--summary', '--porcelain', '--short', '--branch', '--cached', '--staged', '--patch', '-p', '--all', '--amend', '--no-edit', '--continue', '--abort', '--skip', '--detach', '--orphan', '--track', '--no-track', '--ignore-other-worktrees', '--no-verify', '--signoff', '--no-signoff', '--follow', '--decorate', '--oneline', '--name-only', '--name-status', '--check', '--binary', '--text', '--no-textconv', '--submodule', '--recurse-submodules', '--no-recurse-submodules', '--untracked-files', '--ignore-submodules', '--unified', '--no-renames', '--find-renames', '--find-copies', '--no-commit', '--no-ff', '--ff-only', '--edit', '--no-edit', '--force-with-lease', '--delete', '--annotate', '--list', '--contains', '--merged', '--no-merged');

interface GitParsedCommand {
  readonly operation: IsolationCommandOperation;
  readonly paths: readonly string[];
}

function commandOptionSpec(name: string): IsolationOptionSpec {
  const spec = COMMAND_OPTION_SPECS[name];
  if (spec === undefined) {
    throw isolationBoundaryError(`The shell command '${name}' has no safe option grammar.`);
  }
  return spec;
}

function parseIsolationArguments(
  args: readonly string[],
  spec: IsolationOptionSpec,
): ParsedIsolationArguments {
  const positional: string[] = [];
  const beforeDoubleDash: string[] = [];
  const afterDoubleDash: string[] = [];
  const optionPaths: string[] = [];
  const flags = new Set<string>();
  let after = false;

  const addPositional = (value: string): void => {
    positional.push(value);
    (after ? afterDoubleDash : beforeDoubleDash).push(value);
  };

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]!;
    if (!after && arg === '--') {
      if (!spec.allowDoubleDash) {
        throw isolationBoundaryError(`The shell command does not permit '--' before a path.`);
      }
      after = true;
      continue;
    }
    if (after || !arg.startsWith('-') || arg === '-') {
      addPositional(arg);
      continue;
    }

    if (arg.startsWith('--')) {
      const equals = arg.indexOf('=');
      const name = equals === -1 ? arg : arg.slice(0, equals);
      const inline = equals === -1 ? undefined : arg.slice(equals + 1);
      if (spec.flags.has(name)) {
        if (inline !== undefined) {
          throw isolationBoundaryError(`The option '${arg}' does not accept a value.`);
        }
        flags.add(name);
        continue;
      }
      if (spec.values.has(name) || spec.pathValues.has(name)) {
        const value = inline ?? args[++index];
        if (value === undefined || value.length === 0) {
          throw isolationBoundaryError(`The option '${name}' requires a value.`);
        }
        if (spec.pathValues.has(name)) optionPaths.push(value);
        flags.add(name);
        continue;
      }
      throw isolationBoundaryError(`The option '${arg}' is not allowed in an isolated workspace.`);
    }

    const chars = arg.slice(1);
    if (chars.length === 0) {
      addPositional(arg);
      continue;
    }
    let consumedValue = false;
    for (let charIndex = 0; charIndex < chars.length; charIndex += 1) {
      const short = `-${chars[charIndex]!}`;
      if (spec.flags.has(short)) {
        flags.add(short);
        continue;
      }
      if (spec.values.has(short) || spec.pathValues.has(short)) {
        const inline = chars.slice(charIndex + 1);
        const value = inline.length > 0 ? inline : args[++index];
        if (value === undefined || value.length === 0) {
          throw isolationBoundaryError(`The option '${short}' requires a value.`);
        }
        if (spec.pathValues.has(short)) optionPaths.push(value);
        flags.add(short);
        consumedValue = true;
        break;
      }
      throw isolationBoundaryError(`The option '${arg}' is not allowed in an isolated workspace.`);
    }
    if (consumedValue) continue;
  }

  return { positional, beforeDoubleDash, afterDoubleDash, optionPaths, flags };
}

function analyzeIsolationCommand(argv: readonly string[]): IsolationCommandAnalysis {
  const name = commandName(argv[0]);
  if (name === undefined) {
    throw isolationBoundaryError(
      'A shell command without a command name cannot be safely analyzed inside an isolated workspace.',
    );
  }
  if (name === 'cd' || name === 'pushd') return analyzeDirectoryCommand(name, argv.slice(1));
  if (name === 'git') return analyzeGitCommand(argv);
  if (name === 'echo' || name === 'printf') {
    const flags = name === 'echo' ? setOf('-e', '-E', '-n') : setOf();
    const parsed = parseIsolationArguments(argv.slice(1), NO_VALUE_SPEC(flags, 'none'));
    return { operation: 'read', pathOperation: 'read', paths: [] };
  }
  if (name === 'pwd') {
    parseIsolationArguments(argv.slice(1), NO_VALUE_SPEC(setOf('-L', '-P'), 'none'));
    return { operation: 'read', pathOperation: 'read', paths: [] };
  }
  if (name === 'true' || name === 'false') {
    parseIsolationArguments(argv.slice(1), NO_VALUE_SPEC(setOf(), 'none'));
    return { operation: 'read', pathOperation: 'read', paths: [] };
  }
  const spec = commandOptionSpec(name);
  const parsed = parseIsolationArguments(argv.slice(1), spec);
  let paths: string[] = [...parsed.optionPaths];
  switch (spec.positional) {
    case 'none':
      break;
    case 'paths':
      paths.push(...parsed.positional);
      break;
    case 'pattern-paths':
      if (parsed.flags.has('--files') || parsed.flags.has('--files-with-matches')) {
        paths.push(...parsed.positional);
      } else {
        if (parsed.positional.length === 0) {
          throw isolationBoundaryError(`The shell command '${name}' has no analyzable pattern.`);
        }
        paths.push(...parsed.positional.slice(1));
      }
      break;
    case 'mode-paths':
      if (parsed.positional.length < 2) {
        throw isolationBoundaryError(`The shell command '${name}' requires a mode and a path.`);
      }
      paths.push(...parsed.positional.slice(1));
      break;
    case 'owner-paths':
      if (parsed.positional.length < 2) {
        throw isolationBoundaryError(`The shell command '${name}' requires an owner and a path.`);
      }
      paths.push(...parsed.positional.slice(1));
      break;
    case 'tar':
      return analyzeTarCommand(parsed);
  }
  return {
    operation: READ_PATH_COMMANDS.has(name) ? 'read' : 'write',
    pathOperation: READ_PATH_COMMANDS.has(name) ? 'read' : 'write',
    paths,
  };
}

function analyzeDirectoryCommand(
  name: 'cd' | 'pushd',
  args: readonly string[],
): IsolationCommandAnalysis {
  const allowed = name === 'cd' ? setOf('-L', '-P', '-e') : setOf('-n');
  const parsed = parseIsolationArguments(args, {
    flags: allowed,
    values: setOf(),
    pathValues: setOf(),
    allowDoubleDash: false,
    positional: 'paths',
  });
  if (parsed.positional.length !== 1) {
    throw isolationBoundaryError(`The shell command '${name}' requires exactly one directory path.`);
  }
  return { operation: 'read', pathOperation: 'execute', paths: parsed.positional };
}

function analyzeTarCommand(parsed: ParsedIsolationArguments): IsolationCommandAnalysis {
  const hasCreate = parsed.flags.has('-c') || parsed.flags.has('--create');
  const hasExtract = parsed.flags.has('-x') || parsed.flags.has('--extract');
  const hasList = parsed.flags.has('-t') || parsed.flags.has('--list');
  if (hasExtract) {
    throw isolationBoundaryError(
      'Tar extraction is not allowed in an isolated workspace because archive entries cannot be verified before execution.',
    );
  }
  if (hasCreate && !parsed.flags.has('--no-recursion')) {
    throw isolationBoundaryError(
      'Tar directory recursion is not allowed in an isolated workspace; use --no-recursion with explicit file paths.',
    );
  }
  if ((hasCreate ? 1 : 0) + (hasList ? 1 : 0) !== 1) {
    throw isolationBoundaryError('Tar must specify exactly one safe operation: create or list.');
  }
  const operation: IsolationCommandOperation = hasCreate ? 'write' : 'read';
  return {
    operation,
    pathOperation: operation,
    paths: [...parsed.optionPaths, ...parsed.positional],
  };
}

function analyzeGitCommand(argv: readonly string[]): IsolationCommandAnalysis {
  const globalPaths: string[] = [];
  let index = 1;
  while (index < argv.length) {
    const option = argv[index]!;
    if (!option.startsWith('-') || option === '-') break;
    if (GIT_REJECTED_GLOBAL_OPTIONS.has(option) || option.startsWith('--config-env=')) {
      throw isolationBoundaryError(`Git global option '${option}' is not allowed in an isolated workspace.`);
    }
    const equals = option.indexOf('=');
    const name = equals === -1 ? option : option.slice(0, equals);
    const inline = equals === -1 ? undefined : option.slice(equals + 1);
    if (GIT_SAFE_GLOBAL_PATH_VALUES.has(name)) {
      const value = inline ?? argv[++index];
      if (value === undefined || value.length === 0) {
        throw isolationBoundaryError(`Git option '${name}' requires a path.`);
      }
      globalPaths.push(value);
      index += 1;
      continue;
    }
    if (GIT_SAFE_GLOBAL_VALUES.has(name)) {
      const value = inline ?? argv[++index];
      if (value === undefined || value.length === 0) {
        throw isolationBoundaryError(`Git option '${name}' requires a value.`);
      }
      index += 1;
      continue;
    }
    if (GIT_SAFE_GLOBAL_FLAGS.has(name) && inline === undefined) {
      index += 1;
      continue;
    }
    throw isolationBoundaryError(`Git global option '${option}' is not allowed in an isolated workspace.`);
  }
  const subcommand = argv[index];
  if (subcommand === undefined || subcommand === '--') {
    throw isolationBoundaryError('Git command has no analyzable subcommand.');
  }
  const lower = subcommand.toLowerCase();
  if (subcommand.startsWith('!') || lower.startsWith('alias.') || lower === 'include' || !GIT_KNOWN_COMMANDS.has(lower)) {
    throw isolationBoundaryError(`Git subcommand '${subcommand}' is not allowed; aliases and external commands are rejected.`);
  }
  const rest = argv.slice(index + 1);
  const operation: IsolationCommandOperation = GIT_READ_ONLY_COMMANDS.has(lower) ? 'read' : 'write';
  const paths = [...globalPaths];
  const spec = gitSubcommandSpec(lower);
  const parsed = parseIsolationArguments(rest, spec);
  if (lower === 'log' || lower === 'show' || lower === 'diff' || lower === 'rev-parse' || lower === 'ls-files' || lower === 'grep') {
    paths.push(...parsed.optionPaths, ...parsed.afterDoubleDash);
  } else if (lower === 'clone') {
    const positional = [...parsed.positional];
    if (positional.length === 0) {
      throw isolationBoundaryError('Git clone has no source.');
    }
    if (!isRemoteGitSource(positional[0]!)) paths.push(positional[0]!);
    if (positional[1] !== undefined) paths.push(positional[1]!);
    paths.push(...parsed.optionPaths);
  } else if (lower === 'worktree') {
    const action = parsed.positional[0];
    if (action === undefined) throw isolationBoundaryError('Git worktree has no subcommand.');
    const actionPaths = parsed.positional.slice(1);
    switch (action) {
      case 'add':
      case 'move':
      case 'remove':
      case 'lock':
      case 'unlock':
        if (actionPaths.length === 0) throw isolationBoundaryError(`Git worktree ${action} has no path.`);
        paths.push(...actionPaths.slice(0, action === 'move' ? 2 : 1));
        break;
      case 'prune':
        break;
      default:
        throw isolationBoundaryError(`Git worktree subcommand '${action}' is not allowed.`);
    }
    paths.push(...parsed.optionPaths);
  } else {
    paths.push(...parsed.optionPaths, ...parsed.positional);
  }
  return {
    operation,
    pathOperation: operation,
    paths,
  };
}

function gitSubcommandSpec(name: string): IsolationOptionSpec {
  const common = GIT_COMMON_FLAGS;
  const noPaths = (values: readonly string[] = [], pathValues: readonly string[] = []): IsolationOptionSpec => ({
    flags: common,
    values: setOf(...values),
    pathValues: setOf(...pathValues),
    allowDoubleDash: true,
    positional: 'paths',
  });
  switch (name) {
    case 'clone':
      return { ...noPaths(['-b', '--branch', '--depth', '--origin', '--upload-pack', '--config']), pathValues: setOf('-c', '--separate-git-dir', '--reference', '--reference-if-able', '--template'), positional: 'paths' };
    case 'init':
      return { ...noPaths(['--template', '--separate-git-dir']), pathValues: setOf('--template', '--separate-git-dir'), positional: 'paths' };
    case 'worktree':
      return { ...noPaths(['-b', '-B', '--reason']), values: setOf('-b', '-B', '--reason'), pathValues: setOf('--lock'), positional: 'paths' };
    case 'commit':
      return { ...noPaths(['-m', '--message', '-F', '--file']), values: setOf('-m', '--message'), pathValues: setOf('-F', '--file'), positional: 'paths' };
    case 'status':
      return { ...noPaths(['--untracked-files', '--ignored', '--column', '--ahead-behind']), values: setOf('--untracked-files', '--ignored', '--column'), positional: 'paths' };
    case 'diff':
    case 'log':
    case 'show':
      return { ...noPaths(['-U', '--unified', '--format', '--pretty', '--output', '--relative']), values: setOf('-U', '--unified', '--format', '--pretty', '--relative'), pathValues: setOf('--output'), positional: 'paths' };
    case 'rev-parse':
      return { ...noPaths(['--abbrev-ref', '--symbolic-full-name', '--verify', '--sq-quote']), positional: 'paths' };
    case 'ls-files':
    case 'grep':
      return { ...noPaths(['-e', '--cached', '--exclude-standard', '--break', '--heading', '--full-name']), values: setOf('-e', '--regexp'), pathValues: setOf('--exclude-from'), positional: 'paths' };
    case 'cat-file':
    case 'branch':
    case 'remote':
    case 'describe':
    case 'shortlog':
      return noPaths(['--format', '--sort', '--contains', '--merged', '--points-at']);
    case 'add':
    case 'apply':
    case 'checkout':
    case 'config':
    case 'fetch':
    case 'merge':
    case 'mv':
    case 'pull':
    case 'push':
    case 'rebase':
    case 'restore':
    case 'reset':
    case 'rm':
    case 'switch':
    case 'tag':
      return noPaths(['-m', '--message', '-b', '-B', '--branch', '--strategy', '--strategy-option', '--recurse-submodules', '--rebase', '--autostash', '--onto', '--exec', '--format'], ['--pathspec-from-file', '--output', '--file']);
    default:
      throw isolationBoundaryError(`Git subcommand '${name}' is not safely described.`);
  }
}

function isRemoteGitSource(value: string): boolean {
  return /^[A-Za-z][A-Za-z0-9+.-]*:\/\//.test(value) || /^[^/\\\s@]+@[^/\\\s:]+:/.test(value);
}

/**
 * Split a bash command into its top-level subcommand argv lists using the
 * injected tree-sitter parser. Pure: callers cache the result across
 * `matchesRule` probes. Returns `undefined` on a budget-aborted parse or when
 * no command node could be extracted (callers fall back to whole-string
 * matching).
 */
export function splitCommandArgvs(
  source: string,
  parser: IBashParserService,
): readonly BashSubcommand[] | undefined {
  if (source.trim().length === 0) return [];
  const parsed = parser.parse(source);
  if (!parsed.ok || parsed.hasError || containsUnsafeSyntax(parsed.root)) return undefined;
  const subcommands = collectSubcommands(parsed.root);
  return subcommands.length === 0 ? undefined : subcommands;
}

/**
 * Map parsed subcommands onto resource accesses so the permission chain can
 * ask/deny for sensitive targets (`.env`, SSH keys, `.git` control files):
 * redirect targets (`cat < .env`, `echo x > out`) and the positional paths of
 * path-class commands (`rm -- -/secret`, `mv a b`). Returns `undefined` when
 * no file access could be extracted, so the caller keeps the conservative
 * `all()` fallback.
 */
export function bashFileAccesses(
  subcommands: readonly BashSubcommand[],
): ToolAccesses | undefined {
  const accesses: ToolResourceAccess[] = [];
  for (const subcommand of subcommands) {
    for (const redirect of subcommand.redirects) {
      if (!isPathLike(redirect.target)) continue;
      accesses.push({
        kind: 'file',
        operation: READ_REDIRECT_OPERATORS.has(redirect.operator) ? 'read' : 'write',
        path: redirect.target,
      });
    }
    const name = commandName(subcommand.argv[0]);
    if (name === undefined || !PATH_ARG_COMMANDS.has(name)) continue;
    const operation: ToolFileAccessOperation = READ_PATH_COMMANDS.has(name) ? 'read' : 'write';
    for (const path of positionalPaths(subcommand.argv)) {
      if (!isPathLike(path)) continue;
      accesses.push({ kind: 'file', operation, path });
    }
  }
  return accesses.length === 0 ? undefined : accesses;
}

function collectSubcommands(root: BashSyntaxNode): BashSubcommand[] {
  type MutableSubcommand = { argv: string[]; redirects: BashRedirect[] };
  const result: MutableSubcommand[] = [];
  walk(root, []);
  return result;

  function walk(node: BashSyntaxNode, pendingRedirects: readonly BashRedirect[]): void {
    switch (node.type) {
      case 'command': {
        const argv = commandArgv(node);
        const redirects: BashRedirect[] = [];
        for (const child of node.children) {
          if (child.type !== 'file_redirect') continue;
          const redirect = redirectFromNode(child);
          if (redirect !== undefined) redirects.push(redirect);
        }
        result.push({ argv, redirects: [...pendingRedirects, ...redirects] });
        return;
      }
      case 'redirected_statement': {
        const redirects: BashRedirect[] = [];
        for (const child of node.children) {
          if (child.type !== 'file_redirect') continue;
          const redirect = redirectFromNode(child);
          if (redirect !== undefined) redirects.push(redirect);
        }
        const before = result.length;
        for (const child of node.children) {
          if (child.type === 'file_redirect') continue;
          walk(child, pendingRedirects);
        }
        if (redirects.length === 0) return;
        // A bare redirect (`> file`) is valid bash; represent it as an
        // empty-argv command so the write is still visible to the chain.
        if (result.length === before) {
          result.push({ argv: [], redirects });
          return;
        }
        result[result.length - 1]!.redirects.push(...redirects);
        return;
      }
      case 'comment':
        return;
      default:
        // Structural wrappers (program/list/pipeline/if/for/while/function).
        for (const child of node.children) walk(child, pendingRedirects);
    }
  }
}

function containsUnsafeSyntax(root: BashSyntaxNode): boolean {
  const stack: BashSyntaxNode[] = [root];
  while (stack.length > 0) {
    const node = stack.pop()!;
    if (UNSAFE_SYNTAX_NODE_TYPES.has(node.type)) return true;
    stack.push(...node.children);
  }
  return false;
}

function commandArgv(node: BashSyntaxNode): string[] {
  const argv: string[] = [];
  for (const child of node.children) {
    switch (child.type) {
      case 'command_name':
        argv.push(child.text);
        break;
      case 'word':
      case 'string':
      case 'raw_string':
      case 'concatenation':
      case 'number':
        argv.push(child.text);
        break;
      default:
        // variable_assignment, redirects, expansion nodes: not argv.
        break;
    }
  }
  return argv;
}

function redirectFromNode(node: BashSyntaxNode): BashRedirect | undefined {
  let operator: string | undefined;
  let target: string | undefined;
  for (const child of node.children) {
    if (child.type === 'file_descriptor') continue;
    if (child.type === 'word' || child.type === 'number' || child.type === 'string') {
      target = child.text;
    } else if (!child.isNamed && BASH_REDIRECT_OPERATORS.has(child.type)) {
      operator = child.type;
    }
  }
  if (operator === undefined || target === undefined) return undefined;
  return { operator, target };
}

// Positional (non-flag) arguments, honoring the POSIX `--` end-of-options
// delimiter so a path that starts with `-` (`rm -- -/secret`) is still seen.
function positionalPaths(argv: readonly string[]): string[] {
  const paths: string[] = [];
  let afterDoubleDash = false;
  for (let i = 1; i < argv.length; i += 1) {
    const arg = argv[i]!;
    if (!afterDoubleDash) {
      if (arg === '--') {
        afterDoubleDash = true;
        continue;
      }
      if (arg === '-') continue;
      if (arg.startsWith('-') && arg.length > 1) continue;
    }
    paths.push(arg);
  }
  return paths;
}

function isPathLike(value: string): boolean {
  if (value.length === 0) return false;
  if (value === '~') return false;
  if (/[*?[\]{}]/.test(value)) return false;
  return true;
}

function commandName(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const slash = Math.max(value.lastIndexOf('/'), value.lastIndexOf('\\'));
  return value.slice(slash + 1).toLowerCase();
}

function assertIsolationPath(
  workspace: ISessionWorkspaceContext,
  rawPath: string,
  operation: 'read' | 'write' | 'execute',
): void {
  // Shell globbing and home expansion happen after parsing. Neither can be
  // mapped to one boundary path without executing the shell, so reject them
  // instead of attempting an incomplete string-based approximation.
  if (
    !isPathLike(rawPath) ||
    rawPath === '~' ||
    rawPath.startsWith('~/') ||
    rawPath.startsWith('~\\')
  ) {
    throw isolationBoundaryError(
      `The shell path '${rawPath}' cannot be safely resolved inside an isolated workspace.`,
    );
  }
  workspace.assertAllowed(workspace.resolve(rawPath), operation);
}

function isolationBoundaryError(message: string): Error2 {
  return new Error2(ErrorCodes.FS_PATH_ESCAPES, message);
}

function unsupportedIsolatedGitError(): Error2 {
  return isolationBoundaryError(
    'The Git CLI is not supported while a workspace isolation lease is active; isolated agents must not run Git commands.',
  );
}

function formatTimeoutLabel(timeoutMs: number): string {
  return timeoutMs % 1000 === 0 ? `${String(timeoutMs / 1000)}s` : `${String(timeoutMs)}ms`;
}

function foregroundDescription(args: BashInput): string {
  const explicit = args.description?.trim();
  if (explicit !== undefined && explicit.length > 0) return explicit;
  const preview = args.command.length > 60 ? `${args.command.slice(0, 60)}…` : args.command;
  return `Bash: ${preview}`;
}

function closeProcessStdin(proc: IProcess): void {
  try {
    proc.stdin.end();
  } catch {
  }
}

async function killSpawnedProcess(proc: IProcess): Promise<void> {
  try {
    await proc.kill('SIGTERM');
  } catch {
  } finally {
    await disposeProcess(proc);
  }
}

function shellQuote(s: string): string {
  return `'${s.replaceAll("'", "'\\''")}'`;
}

function windowsPathToPosixPath(path: string): string {
  if (path.startsWith('\\\\')) {
    return path.replaceAll('\\', '/');
  }

  const driveMatch = /^([A-Za-z]):(?:[\\/]|$)/.exec(path);
  if (driveMatch !== null) {
    const drive = driveMatch[1]!.toLowerCase();
    const rest = path.slice(2).replaceAll('\\', '/');
    return `/${drive}${rest.startsWith('/') ? rest : `/${rest}`}`;
  }

  return path.replaceAll('\\', '/');
}

const WINDOWS_NUL_REDIRECT = /(\d?&?>+\s*)[Nn][Uu][Ll](?=\s|$|[|&;)\n])/g;

function rewriteWindowsNullRedirect(command: string): string {
  return command.replace(WINDOWS_NUL_REDIRECT, '$1/dev/null');
}
