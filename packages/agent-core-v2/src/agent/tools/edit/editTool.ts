/**
 * `tools` domain — `EditTool` implementation, the Agent entry for exact
 * string replacement in a text file.
 *
 * Agent-scope adapter over the App-scope {@link IFileEditService} capability.
 * Keeps only the Agent-facing responsibilities: path resolution, the file
 * access declaration, the diff display, the approval rule, the no-op
 * pre-check, and mapping the domain-neutral `FileEditResult` into an
 * `ExecutableToolResult`. The actual read/edit/write is delegated to
 * {@link IFileEditService} (os-backed adapter over `IHostFileSystem`), which
 * runs the pure `TextModel` / `EditService` logic.
 *
 * Path semantics (home expansion, path class) come from the
 * `hostEnvironment` domain; the workspace and skill roots come from
 * `ISessionWorkspaceContext` / `ISessionSkillCatalog`.
 *
 * Ported from v1.
 * Bound at Agent scope; self-registers via `registerAgentToolService(...)` at module
 * load.
 */

import {
  extendWorkspaceWithSkillRoots,
  resolvePathAccessPath,
  type WorkspaceConfig,
} from '#/tool/path-access';
import { toInputJsonSchema } from '#/tool/input-schema';
import { literalRulePattern, matchesPathRuleSubject } from '#/tool/rule-match';
import { IFileEditService } from '#/app/edit/fileEdit';
import { IHostEnvironment } from '#/os/interface/hostEnvironment';
import { IHostFileSystem } from '#/os/interface/hostFileSystem';
import { ISessionSkillCatalog } from '#/session/sessionSkillCatalog/skillCatalog';
import {
  assertWorkspacePathBeforeIO,
  ISessionWorkspaceContext,
} from '#/session/workspaceContext/workspaceContext';
import { IAgentReadStateService } from '#/agent/readState/readState';
import '#/agent/readState/readStateService';
import {
  ToolAccesses,
  type ExecutableToolResult,
  type ToolExecution,
} from '#/tool/toolContract';
import { registerAgentToolService } from '#/agent/toolRegistry/toolContribution';

import { EditInputSchema, IEditTool, type EditInput } from './edit';
import editDescriptionTemplate from './edit.md?raw';

export class EditTool implements IEditTool {
  declare readonly _serviceBrand: undefined;
  readonly name = 'Edit' as const;
  readonly description = editDescriptionTemplate;
  readonly parameters: Record<string, unknown> = toInputJsonSchema(EditInputSchema);

  constructor(
    @IFileEditService private readonly editor: IFileEditService,
    @IHostEnvironment private readonly env: IHostEnvironment,
    @ISessionWorkspaceContext private readonly workspaceCtx: ISessionWorkspaceContext,
    @ISessionSkillCatalog private readonly skillCatalog?: ISessionSkillCatalog,
    @IAgentReadStateService private readonly readState?: IAgentReadStateService,
    @IHostFileSystem private readonly fs?: IHostFileSystem,
  ) {}

  private get workspaceConfig(): WorkspaceConfig {
    return extendWorkspaceWithSkillRoots(
      {
        workspaceDir: this.workspaceCtx.workDir,
        additionalDirs: this.workspaceCtx.additionalDirs,
        assertIsolationAllowed: (path, operation) =>
          this.workspaceCtx.isolation === undefined
            ? path
            : this.workspaceCtx.assertAllowed(path, operation === 'search' ? 'read' : operation),
      },
      this.skillCatalog?.catalog.getSkillRoots() ?? [],
      this.env.pathClass,
    );
  }

  resolveExecution(args: EditInput): ToolExecution {
    const path = resolvePathAccessPath(args.path, {
      env: this.env,
      workspace: this.workspaceConfig,
      operation: 'write',
    });
    return {
      accesses: ToolAccesses.readWriteFile(path),
      description: `Editing ${args.path}`,
      display: {
        kind: 'file_io',
        operation: 'edit',
        path,
        before: args.old_string,
        after: args.new_string,
      },
      approvalRule: literalRulePattern(this.name, path),
      matchesRule: (ruleArgs) =>
        matchesPathRuleSubject(ruleArgs, path, {
          cwd: this.workspaceConfig.workspaceDir,
          pathClass: this.env.pathClass,
          homeDir: this.env.homeDir,
        }),
      execute: () => this.execution(args, path),
    };
  }

  private async execution(args: EditInput, safePath: string): Promise<ExecutableToolResult> {
    try {
      safePath = await assertWorkspacePathBeforeIO(this.workspaceCtx, safePath, 'write');
    } catch (error) {
      return { isError: true, output: error instanceof Error ? error.message : String(error) };
    }
    if (args.old_string === args.new_string) {
      return {
        isError: true,
        output: 'No changes to make: old_string and new_string are exactly the same.',
      };
    }

    const stale = await this.staleReadCheck(args.path, safePath);
    if (stale !== undefined) return stale;

    const result = await this.editor.edit({
      path: safePath,
      displayPath: args.path,
      old_string: args.old_string,
      new_string: args.new_string,
      replace_all: args.replace_all ?? false,
    });
    if (!result.ok) {
      return { isError: true, output: result.error };
    }
    await this.refreshReadStateAfterEdit(safePath);
    const word = result.count === 1 ? 'occurrence' : 'occurrences';
    return { output: `Replaced ${String(result.count)} ${word} in ${args.path}` };
  }

  private async staleReadCheck(
    displayPath: string,
    safePath: string,
  ): Promise<ExecutableToolResult | undefined> {
    if (this.readState?.isEnabled() !== true) return undefined;
    const state = this.readState.find(safePath);
    if (state === undefined) {
      return {
        isError: true,
        output: `请先 Read "${displayPath}" 再 Edit：编辑前必须先用 Read 工具读取该文件。`,
      };
    }
    if (this.fs === undefined) return undefined;
    try {
      const stat = await this.fs.stat(safePath);
      if (
        stat.mtimeMs !== undefined &&
        state.mtimeMs !== undefined &&
        stat.mtimeMs !== state.mtimeMs
      ) {
        return {
          isError: true,
          output: `文件 "${displayPath}" 自上次 Read 后已变更，请重新 Read 后再 Edit。`,
        };
      }
    } catch {
      // stat failed — do not block the edit
    }
    return undefined;
  }

  private async refreshReadStateAfterEdit(safePath: string): Promise<void> {
    if (this.readState?.isEnabled() !== true) return;
    if (this.fs === undefined) return;
    try {
      const stat = await this.fs.stat(safePath);
      this.readState.recordEdit(safePath, stat.mtimeMs);
    } catch {
      this.readState.recordEdit(safePath, undefined);
    }
  }
}

registerAgentToolService(IEditTool, EditTool, { name: 'Edit', domain: 'edit' });
