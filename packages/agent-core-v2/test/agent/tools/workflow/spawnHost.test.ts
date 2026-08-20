/**
 * `tools` domain — failure-path tests for the workflow subagent spawn host.
 *
 * The lifecycle, profile, and model services are local contract stubs. The
 * prompt-prefix, subagent-run, and mirror seams are the only injected
 * failures. Each scenario verifies that a child created before the failure is
 * removed through `IAgentLifecycleService` and that the original error is
 * rethrown unchanged.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { Event, type Event as EventType } from '#/_base/event';
import { type IAgentScopeHandle } from '#/_base/di/scope';
import { LifecycleScope } from '#/app/scopes';
import { createHooks } from '#/hooks';
import { ILogService } from '#/_base/log/log';
import {
  IAgentPermissionModeService,
  type PermissionModeChangedContext,
} from '#/agent/permissionMode/permissionMode';
import { IAgentProfileService, type ProfileData } from '#/agent/profile/profile';
import { IAgentUserToolService } from '#/agent/userTool/userTool';
import { IAgentLifecycleService } from '#/session/agentLifecycle/agentLifecycle';
import { ISessionAgentProfileCatalog } from '#/session/sessionAgentProfileCatalog/sessionAgentProfileCatalog';
import { ISessionContext } from '#/session/sessionContext/sessionContext';
import { ISessionProcessRunner } from '#/session/process/processRunner';
import {
  ISessionSubagentService,
  type AgentRunHandle,
  type AgentTaskStopHookContext,
} from '#/session/subagent/subagent';
import { IConfigService } from '#/app/config/config';
import { IFlagService } from '#/app/flag/flag';
import { IModelCatalog } from '#/kosong/model/catalog';
import {
  spawnWorkflowAgent,
  type WorkflowSpawnHostDeps,
} from '#/agent/tools/workflow/spawnHost';

vi.mock('#/app/agentProfileCatalog/promptPrefix', () => ({
  applyProfilePromptPrefix: vi.fn(),
}));
vi.mock('#/session/subagent/mirrorAgentRun', () => ({
  emitAgentRunSpawned: vi.fn(),
  mirrorAgentRun: vi.fn(),
}));

import { applyProfilePromptPrefix } from '#/app/agentProfileCatalog/promptPrefix';
import { mirrorAgentRun } from '#/session/subagent/mirrorAgentRun';

const callerAgentId = 'caller';
const childAgentId = 'child';
const prompt = 'do the work';

function profileData(): ProfileData {
  return {
    modelAlias: 'model-x',
    modelCapabilities: {} as ProfileData['modelCapabilities'],
    profileName: 'coder',
    thinkingLevel: 'high',
    systemPrompt: '',
  };
}

function profileService(): IAgentProfileService {
  return {
    _serviceBrand: undefined,
    configure: vi.fn(),
    update: vi.fn(),
    applyBindingSnapshot: vi.fn(),
    bind: vi.fn(async () => {}),
    syncMemoryScope: vi.fn(async () => {}),
    setModel: vi.fn(async () => ({ model: 'model-x' })),
    setThinking: vi.fn(),
    republishStatus: vi.fn(),
    getModel: vi.fn(() => 'model-x'),
    useProfile: vi.fn(),
    applyProfile: vi.fn(async () => {}),
    refreshSystemPrompt: vi.fn(async () => {}),
    getAgentsMdWarning: vi.fn(() => undefined),
    data: vi.fn(profileData),
    getEffectiveThinkingLevel: vi.fn(() => 'high'),
    resolveModelContext: vi.fn(() => ({
      modelAlias: 'model-x',
      modelCapabilities: {} as ProfileData['modelCapabilities'],
      maxOutputSize: undefined,
      alwaysThinking: undefined,
      thinkingLevel: 'high',
      reservedContextSize: undefined,
      compactionTriggerRatio: undefined,
    })),
    resolveRequestParams: vi.fn(() => ({})),
    getModelCapabilities: vi.fn(() => ({})),
    getMaxOutputSize: vi.fn(() => undefined),
    hasModel: vi.fn(() => true),
    isRunnable: vi.fn(() => true),
    hasProvider: vi.fn(() => true),
    getSystemPrompt: vi.fn(() => ''),
    getActiveToolNames: vi.fn(() => undefined),
    addActiveTool: vi.fn(),
    removeActiveTool: vi.fn(),
  } as unknown as IAgentProfileService;
}

function permissionMode(): IAgentPermissionModeService {
  return {
    _serviceBrand: undefined,
    mode: 'auto',
    setMode: vi.fn(),
    onDidChangeMode: Event.None as EventType<PermissionModeChangedContext>,
  };
}

function userTools(): IAgentUserToolService {
  return {
    _serviceBrand: undefined,
    list: () => [],
    inheritUserTools: vi.fn(),
    register: vi.fn(),
    unregister: vi.fn(),
  };
}

function agentHandle(id: string): IAgentScopeHandle {
  const profile = profileService();
  const permission = permissionMode();
  const tools = userTools();
  return {
    id,
    kind: LifecycleScope.Agent,
    accessor: {
      get: ((serviceId: unknown) => {
        if (serviceId === IAgentProfileService) return profile;
        if (serviceId === IAgentPermissionModeService) return permission;
        if (serviceId === IAgentUserToolService) return tools;
        return undefined;
      }) as IAgentScopeHandle['accessor']['get'],
    },
    dispose: vi.fn(),
  };
}

function runHandle(): AgentRunHandle {
  return {
    agentId: childAgentId,
    turn: {} as never,
    completion: Promise.resolve({ summary: 'child completed' }),
  };
}

function makeDeps(): WorkflowSpawnHostDeps {
  const caller = agentHandle(callerAgentId);
  const child = agentHandle(childAgentId);
  const lifecycle: IAgentLifecycleService = {
    _serviceBrand: undefined,
    onDidCreate: Event.None as EventType<IAgentScopeHandle>,
    onDidDispose: Event.None as EventType<string>,
    create: vi.fn(async () => child),
    fork: vi.fn(async () => child),
    get: vi.fn((id: string) => (id === callerAgentId ? caller : undefined)),
    list: vi.fn(() => [caller]),
    broadcastPermissionMode: vi.fn(),
    remove: vi.fn(async () => {}),
  };
  const subagents: ISessionSubagentService = {
    _serviceBrand: undefined,
    hooks: createHooks(['onWillStartAgentTask']),
    onDidStopAgentTask: Event.None as EventType<AgentTaskStopHookContext>,
    run: vi.fn(async () => runHandle()),
    notifyAgentTaskStopped: vi.fn(),
  };
  return {
    callerAgentId,
    lifecycle,
    subagents,
    catalog: {
      ready: Promise.resolve(),
      get: vi.fn(() => ({
        name: 'coder',
        systemPrompt: () => '',
        renderSystemPrompt: () => ({ text: '', environment: { cwd: '', date: { disclosed: false } } }),
      })),
      list: vi.fn(() => []),
    } as unknown as ISessionAgentProfileCatalog,
    sessionContext: { cwd: 'D:/work' } as ISessionContext,
    processRunner: {} as ISessionProcessRunner,
    log: { warn: vi.fn() } as unknown as ILogService,
    modelCatalog: { get: vi.fn(() => undefined) } as unknown as IModelCatalog,
    config: { get: vi.fn(() => undefined) } as unknown as IConfigService,
    flags: { enabled: vi.fn(() => false) } as unknown as IFlagService,
    profile: {} as IAgentProfileService,
  };
}

describe('workflow spawn host failure cleanup', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(applyProfilePromptPrefix).mockResolvedValue('prefixed prompt');
    vi.mocked(mirrorAgentRun).mockResolvedValue({ summary: 'child completed' });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it.each([
    {
      phase: 'profile prompt prefix',
      inject: (deps: WorkflowSpawnHostDeps, error: Error) => {
        void deps;
        vi.mocked(applyProfilePromptPrefix).mockRejectedValue(error);
      },
    },
    {
      phase: 'subagent run',
      inject: (deps: WorkflowSpawnHostDeps, error: Error) => {
        (deps.subagents.run as ReturnType<typeof vi.fn>).mockRejectedValue(error);
      },
    },
    {
      phase: 'mirror startup',
      inject: (_deps: WorkflowSpawnHostDeps, error: Error) => {
        vi.mocked(mirrorAgentRun).mockImplementation(() => { throw error; });
      },
    },
    {
      phase: 'mirror wait',
      inject: (_deps: WorkflowSpawnHostDeps, error: Error) => {
        vi.mocked(mirrorAgentRun).mockRejectedValue(error);
      },
    },
  ])('removes the child and preserves the original error when $phase fails', async ({ phase, inject }) => {
    const deps = makeDeps();
    const error = new Error(`${phase} failed`);
    inject(deps, error);

    await expect(
      spawnWorkflowAgent(deps, prompt, undefined, new AbortController().signal, 'tool-call'),
    ).rejects.toBe(error);
    expect(deps.lifecycle.remove).toHaveBeenCalledTimes(1);
    expect(deps.lifecycle.remove).toHaveBeenCalledWith(childAgentId);
  });

  it('does not remove a child after normal completion', async () => {
    const deps = makeDeps();

    await expect(
      spawnWorkflowAgent(deps, prompt, undefined, new AbortController().signal, 'tool-call'),
    ).resolves.toMatchObject({ ok: true, agentId: childAgentId });
    expect(deps.lifecycle.remove).not.toHaveBeenCalled();
  });

  it('keeps the original failure when child removal itself fails', async () => {
    const deps = makeDeps();
    const error = new Error('mirror failed');
    const cleanupError = new Error('remove failed');
    (deps.lifecycle.remove as ReturnType<typeof vi.fn>).mockRejectedValue(cleanupError);
    vi.mocked(mirrorAgentRun).mockRejectedValue(error);

    await expect(
      spawnWorkflowAgent(deps, prompt, undefined, new AbortController().signal, 'tool-call'),
    ).rejects.toBe(error);
    expect(deps.lifecycle.remove).toHaveBeenCalledTimes(1);
    expect(deps.log.warn).toHaveBeenCalledWith('workflow subagent cleanup failed', {
      agentId: childAgentId,
      error: cleanupError,
    });
  });
});
