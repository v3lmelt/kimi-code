/**
 * `tools` domain — unit tests for the `Workflow` tool (`WorkflowTool`).
 *
 * Covers the non-blocking launch contract: `resolveExecution` returns
 * `ToolAccesses.none()` with the tool's approval rule; a valid script compiles,
 * persists to the session dir (`<sessionDir>/workflows/<runId>/script.js`),
 * registers a detached `WorkflowTask`, and returns `{task_id, run_id}` without
 * awaiting the run; an invalid script fails fast with a compile error; and a
 * `resumeFromRunId` pointing at a non-existent run is rejected.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { toDisposable, DisposableStore } from '#/_base/di/lifecycle';
import { TestInstantiationService } from '#/_base/di/test';
import { ILogService } from '#/_base/log/log';
import { IAgentScopeContext } from '#/agent/scopeContext/scopeContext';
import { IAgentTaskService } from '#/agent/task/task';
import type { AgentTask } from '#/agent/task/types';
import { ISessionContext, makeSessionContext } from '#/session/sessionContext/sessionContext';
import { IAppendLogStore } from '#/persistence/interface/appendLogStore';
import { IFileSystemStorageService } from '#/persistence/interface/storage';
import { IHostFileSystem } from '#/os/interface/hostFileSystem';
import { IWireService } from '#/wire/wire';
import { ITelemetryService } from '#/app/telemetry/telemetry';
import { IConfigService } from '#/app/config/config';
import { IFlagService } from '#/app/flag/flag';
import { IAgentLifecycleService } from '#/session/agentLifecycle/agentLifecycle';
import { ISessionSubagentService } from '#/session/subagent/subagent';
import { ISessionAgentProfileCatalog } from '#/session/sessionAgentProfileCatalog/sessionAgentProfileCatalog';
import { ISessionProcessRunner } from '#/session/process/processRunner';
import { IAgentProfileService } from '#/agent/profile/profile';
import { IModelCatalog } from '#/kosong/model/catalog';
import {
  ToolAccesses,
  type ExecutableToolContext,
  type ExecutableToolResult,
} from '#/tool/toolContract';
import { InMemoryStorageService } from '#/persistence/backends/memory/inMemoryStorageService';
import { workflowJournalScope } from '#/agent/workflow/persist/journal';
import { IWorkflowBudgetService } from '#/agent/workflow/budget/workflowBudget';
import {
  WorkflowTool,
  WORKFLOW_SCRIPT_KEY,
} from '#/agent/tools/workflow/workflowTool';
import { WorkflowTask } from '#/agent/tools/workflow/workflowTask';

const SESSION = makeSessionContext({
  sessionId: 's1',
  workspaceId: 'w1',
  sessionDir: 'D:/sessions/s1',
  sessionScope: 'sessions/s1',
  cwd: 'D:/work',
});

const VALID_SCRIPT = [
  "export const meta = { name: 'demo', description: 'A demo workflow', phases: [{ title: 'gather' }] };",
  'export async function main() {',
  "  const first = await agent('gather');",
  '  return { output: first.output };',
  '}',
].join('\n');

const INVALID_SCRIPT = [
  "export const meta = { name: 'bad', description: 'x' };",
  'export async function main() {',
  '  return Date.now();',
  '}',
].join('\n');

const noopAppendLog: IAppendLogStore = {
  _serviceBrand: undefined,
  append: () => {},
  read: async function* () {},
  readFrom: async () => ({ records: [], nextByte: 0, truncated: false }),
  rewrite: async () => {},
  flush: async () => {},
  close: async () => {},
  acquire: () => toDisposable(() => {}),
};

function toolContext(toolCallId = 'tc-1'): ExecutableToolContext {
  return {
    turnId: 1,
    toolCallId,
    signal: new AbortController().signal,
  };
}

async function runTool(
  tool: WorkflowTool,
  args: { script: string; scriptPath?: string; resumeFromRunId?: string },
  ctx: ExecutableToolContext = toolContext(),
): Promise<ExecutableToolResult> {
  const execution = tool.resolveExecution(args);
  if (execution.isError === true) return execution;
  return execution.execute(ctx);
}

describe('WorkflowTool', () => {
  let disposables: DisposableStore;
  let ix: TestInstantiationService;
  let registeredTasks: AgentTask[];
  let bytes: InMemoryStorageService;
  let readText: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    disposables = new DisposableStore();
    ix = disposables.add(new TestInstantiationService());
    bytes = new InMemoryStorageService();
    registeredTasks = [];
    readText = vi.fn(async () => VALID_SCRIPT);

    ix.stub(IFileSystemStorageService, bytes);
    ix.set(IAppendLogStore, noopAppendLog);
    ix.stub(IHostFileSystem, { readText } as unknown as IHostFileSystem);
    ix.stub(ISessionContext, SESSION);
    ix.stub(IAgentScopeContext, { agentId: 'main' } as unknown as IAgentScopeContext);
    ix.stub(IAgentTaskService, {
      registerTask: (task: AgentTask) => {
        registeredTasks.push(task);
        return 'wf-task-abcdef12';
      },
      getTask: () => undefined,
      list: () => [],
    } as unknown as IAgentTaskService);
    ix.stub(IWireService, {
      dispatch: vi.fn(),
      getModel: () => undefined,
      hooks: { onDidRestore: {} },
      seal: async () => {},
      restore: async () => {},
      flush: async () => {},
    } as unknown as IWireService);
    ix.stub(ITelemetryService, { track: vi.fn(), track2: vi.fn() } as unknown as ITelemetryService);
    ix.stub(ILogService, { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } as unknown as ILogService);
    ix.stub(IConfigService, { get: vi.fn(() => undefined) } as unknown as IConfigService);
    ix.stub(IWorkflowBudgetService, {
      total: () => 1_000_000,
      spent: () => 0,
      budget: () => ({ total: 1_000_000, spent: () => 0, remaining: () => 1_000_000 }),
      recordSubagentUsage: vi.fn(),
    } as unknown as IWorkflowBudgetService);
    ix.stub(IFlagService, { enabled: vi.fn(() => false) } as unknown as IFlagService);
    ix.stub(IAgentLifecycleService, {} as unknown as IAgentLifecycleService);
    ix.stub(ISessionSubagentService, {} as unknown as ISessionSubagentService);
    ix.stub(ISessionAgentProfileCatalog, {
      ready: Promise.resolve(),
      get: () => undefined,
      list: () => [],
    } as unknown as ISessionAgentProfileCatalog);
    ix.stub(ISessionProcessRunner, {} as unknown as ISessionProcessRunner);
    ix.stub(IAgentProfileService, {
      data: () => ({ profileName: 'coder', modelAlias: 'model-x', thinkingLevel: 'high' }),
    } as unknown as IAgentProfileService);
    ix.stub(IModelCatalog, { get: () => undefined } as unknown as IModelCatalog);
  });

  afterEach(() => disposables.dispose());

  it('resolveExecution returns no resource accesses and the tool approval rule', () => {
    const tool = ix.createInstance(WorkflowTool);
    const execution = tool.resolveExecution({ script: VALID_SCRIPT });
    if (execution.isError === true) throw new Error('expected a runnable execution');
    expect(execution.accesses).toEqual(ToolAccesses.none());
    expect(execution.approvalRule).toBe('Workflow');
  });

  it('launches a workflow in the background: compiles, persists the script, registers a WorkflowTask, returns task_id + run_id', async () => {
    const tool = ix.createInstance(WorkflowTool);
    const result = await runTool(tool, { script: VALID_SCRIPT });

    expect(result.isError).toBeFalsy();
    const output = typeof result.output === 'string' ? result.output : '';
    expect(output).toContain('task_id: wf-task-abcdef12');
    expect(output).toContain('status: running');
    expect(output).toContain('workflow: demo');

    const runId = /run_id: (wf_[a-f0-9]{16})/.exec(output)?.[1] as `wf_${string}` | undefined;
    expect(runId).toBeDefined();

    expect(registeredTasks).toHaveLength(1);
    const task = registeredTasks[0];
    expect(task).toBeInstanceOf(WorkflowTask);
    expect((task as WorkflowTask).runId).toBe(runId);

    const persisted = await bytes.read(
      workflowJournalScope(SESSION.scope(), runId!),
      WORKFLOW_SCRIPT_KEY,
    );
    expect(new TextDecoder().decode(persisted)).toBe(VALID_SCRIPT);
  });

  it('loads the script from scriptPath when only a path is provided', async () => {
    const tool = ix.createInstance(WorkflowTool);
    const result = await runTool(tool, { script: '', scriptPath: '/tmp/wf.js' });

    expect(result.isError).toBeFalsy();
    expect(readText).toHaveBeenCalledWith('/tmp/wf.js');
    expect(registeredTasks).toHaveLength(1);
  });

  it('fails fast with a compile error for a script that violates the determinism contract', async () => {
    const tool = ix.createInstance(WorkflowTool);
    const result = await runTool(tool, { script: INVALID_SCRIPT });

    expect(result.isError).toBe(true);
    const output = typeof result.output === 'string' ? result.output : '';
    expect(output).toContain('did not compile');
    expect(registeredTasks).toHaveLength(0);
  });

  it('rejects a resume id that does not exist', async () => {
    const tool = ix.createInstance(WorkflowTool);
    const result = await runTool(tool, {
      script: VALID_SCRIPT,
      resumeFromRunId: 'wf_ffffffffffffffff',
    });

    expect(result.isError).toBe(true);
    const output = typeof result.output === 'string' ? result.output : '';
    expect(output).toContain('was found to resume');
    expect(registeredTasks).toHaveLength(0);
  });
});
