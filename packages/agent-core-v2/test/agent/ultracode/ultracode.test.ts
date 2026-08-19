import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { SyncDescriptor } from '#/_base/di/descriptors';
import { DisposableStore } from '#/_base/di/lifecycle';
import { TestInstantiationService } from '#/_base/di/test';
import { IAgentContextMemoryService } from '#/agent/contextMemory/contextMemory';
import { IAgentPromptService, type PromptSubmitContext } from '#/agent/prompt/prompt';
import { IAgentProfileService, ProfileError, ProfileErrors } from '#/agent/profile/profile';
import { IAgentSystemReminderService } from '#/agent/systemReminder/systemReminder';
import { AgentSystemReminderService } from '#/agent/systemReminder/systemReminderService';
import { IAgentToolPolicyService } from '#/agent/toolPolicy/toolPolicy';
import { containsUltracodeToken, userPromptText } from '#/agent/ultracode/ultracodeDetector';
import { IAgentUltracodeService } from '#/agent/ultracode/ultracode';
import { AgentUltracodeService } from '#/agent/ultracode/ultracodeService';
import { UltracodeModel } from '#/agent/ultracode/ultracodeOps';
import { WORKFLOW_TOOL_NAME } from '#/agent/tools/workflow/workflow';
import { type DomainEvent, IEventBus } from '#/app/event/eventBus';
import { EventBusService } from '#/app/event/eventBusService';
import { IConfigService } from '#/app/config/config';
import { IModelCatalog } from '#/kosong/model/catalog';
import { AppendLogStore } from '#/persistence/backends/node-fs/appendLogStore';
import { InMemoryStorageService } from '#/persistence/backends/memory/inMemoryStorageService';
import { IAppendLogStore } from '#/persistence/interface/appendLogStore';
import { IFileSystemStorageService } from '#/persistence/interface/storage';
import { AGENT_WIRE_RECORD_KEY, type WireRecord } from '#/wire/record';

import { stubContextMemory } from '../contextMemory/stubs';
import { registerTestAgentWire, restoreTestAgentWire, testWireScope } from '../../wire/stubs';

function stubProfile(supportEfforts: readonly string[] = ['low', 'medium', 'high', 'xhigh', 'max']) {
  const setThinking = vi.fn((level: string) => {
    if (!supportEfforts.includes(level)) {
      throw new ProfileError(
        ProfileErrors.codes.MODEL_CONFIG_INVALID,
        `Thinking effort "${level}" is not supported by model "model-x".`,
      );
    }
  });
  return {
    _serviceBrand: undefined,
    getModel: () => 'model-x',
    setThinking,
  } as unknown as IAgentProfileService;
}

function stubCatalog(supportEfforts: readonly string[] = ['low', 'medium', 'high', 'xhigh', 'max']) {
  return {
    _serviceBrand: undefined,
    get: () => ({ supportEfforts }),
  } as unknown as IModelCatalog;
}

function stubPrompt() {
  let hook: ((ctx: PromptSubmitContext, next: () => Promise<void>) => Promise<void>) | undefined;
  const service = {
    _serviceBrand: undefined,
    hooks: {
      onBeforeSubmitPrompt: {
        register: (_name: string, fn: typeof hook) => {
          hook = fn;
          return { dispose() {} };
        },
      },
    },
  } as unknown as IAgentPromptService;
  const runHook = (content: string): Promise<void> => {
    const ctx: PromptSubmitContext = {
      promptMessage: {
        role: 'user',
        content: [{ type: 'text', text: content }],
        toolCalls: [],
      },
      isSteer: false,
      block: false,
    };
    return hook?.(ctx, async () => {}) ?? Promise.resolve();
  };
  return { service, runHook };
}

describe('AgentUltracodeService', () => {
  let disposables: DisposableStore;
  let ix: TestInstantiationService;
  let runHook: (content: string) => Promise<void>;
  let configState: { agent?: { workflowKeywordTriggerEnabled?: boolean; ultracode?: boolean } };
  let toolPolicyState: { workflowActive: boolean };
  let isToolActive: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    disposables = new DisposableStore();
    ix = disposables.add(new TestInstantiationService());
    ix.stub(IAgentContextMemoryService, stubContextMemory());
    ix.stub(IFileSystemStorageService, new InMemoryStorageService());
    ix.set(IAppendLogStore, new SyncDescriptor(AppendLogStore));
    ix.set(IEventBus, new SyncDescriptor(EventBusService));
    registerTestAgentWire(ix, testWireScope('wire', 'ultracode-test'), {
      log: ix.get(IAppendLogStore),
      eventBus: ix.get(IEventBus),
    });
    ix.set(IAgentSystemReminderService, new SyncDescriptor(AgentSystemReminderService));
    ix.stub(IAgentProfileService, stubProfile());
    ix.stub(IModelCatalog, stubCatalog());
    configState = {};
    toolPolicyState = { workflowActive: true };
    isToolActive = vi.fn(() => toolPolicyState.workflowActive);
    ix.stub(IConfigService, { get: vi.fn(() => configState.agent) } as unknown as IConfigService);
    ix.stub(IAgentToolPolicyService, { isToolActive } as unknown as IAgentToolPolicyService);
    const prompt = stubPrompt();
    runHook = prompt.runHook;
    ix.stub(IAgentPromptService, prompt.service);
    ix.set(IAgentUltracodeService, new SyncDescriptor(AgentUltracodeService));
  });
  afterEach(() => disposables.dispose());

  it('enter / exit toggle isActive and emit agent.status.updated via wire', () => {
    const ultracode = ix.get(IAgentUltracodeService);
    const events: DomainEvent[] = [];
    disposables.add(ix.get(IEventBus).subscribe((e) => events.push(e)));

    expect(ultracode.isActive).toBe(false);
    ultracode.enter('manual');
    expect(ultracode.isActive).toBe(true);
    ultracode.exit();
    expect(ultracode.isActive).toBe(false);

    expect(events).toEqual([
      { type: 'agent.status.updated', ultracode: true },
      { type: 'agent.status.updated', ultracode: false },
      { type: 'context.spliced', start: 0, deleteCount: 1, messages: [] },
    ]);
  });

  it('dispatch persists enter/exit records and replay rebuilds the flag', async () => {
    const ultracode = ix.get(IAgentUltracodeService);
    ultracode.enter('keyword');

    const log = ix.get(IAppendLogStore);
    const records: WireRecord[] = [];
    for await (const record of log.read<WireRecord>(
      testWireScope('wire', 'ultracode-test'),
      AGENT_WIRE_RECORD_KEY,
    )) {
      records.push(record);
    }
    expect(records).toEqual([
      { type: 'ultracode_mode.enter', trigger: 'keyword', time: expect.any(Number) },
    ]);

    const ix2 = disposables.add(new TestInstantiationService());
    ix2.stub(IFileSystemStorageService, new InMemoryStorageService());
    ix2.set(IAppendLogStore, new SyncDescriptor(AppendLogStore));
    const fresh = registerTestAgentWire(ix2, testWireScope('wire', 'ultracode-replay'), {
      log: ix2.get(IAppendLogStore),
    });
    await restoreTestAgentWire(
      fresh,
      ix2.get(IAppendLogStore),
      testWireScope('wire', 'ultracode-replay'),
      records,
    );
    expect(fresh.getModel(UltracodeModel)).toBe(true);
  });

  it('enters when a user prompt contains the bare "chesto!" keyword', async () => {
    const ultracode = ix.get(IAgentUltracodeService);

    await runHook('Please run this with chesto! mode');

    expect(ultracode.isActive).toBe(true);
  });

  it('ignores "chesto!" inside code blocks, quotes, and slash commands', async () => {
    const ultracode = ix.get(IAgentUltracodeService);

    await runHook('```\nchesto!\n```');
    expect(ultracode.isActive).toBe(false);
    await runHook('say `chesto!`');
    expect(ultracode.isActive).toBe(false);
    await runHook('"chesto!" is a keyword');
    expect(ultracode.isActive).toBe(false);
    await runHook('/ultracode on');
    expect(ultracode.isActive).toBe(false);
  });

  it('is case-insensitive', async () => {
    const ultracode = ix.get(IAgentUltracodeService);

    await runHook('CHESTO! NOW');

    expect(ultracode.isActive).toBe(true);
  });

  it('does not re-enter when already active', async () => {
    const ultracode = ix.get(IAgentUltracodeService);
    ultracode.enter('manual');

    const profile = ix.get(IAgentProfileService);
    await runHook('chesto! again');

    expect(ultracode.isActive).toBe(true);
    expect(profile.setThinking).toHaveBeenCalledTimes(1);
  });

  it('falls back to the highest supported effort when xhigh is unsupported', () => {
    ix.stub(IAgentProfileService, stubProfile(['low', 'medium', 'high']));
    ix.stub(IModelCatalog, stubCatalog(['low', 'medium', 'high']));
    ix.set(IAgentUltracodeService, new SyncDescriptor(AgentUltracodeService));
    const ultracode = ix.get(IAgentUltracodeService);
    const profile = ix.get(IAgentProfileService);

    ultracode.enter('manual');

    expect(ultracode.isActive).toBe(true);
    expect(profile.setThinking).toHaveBeenCalledWith('high');
  });

  it('does not enter when the model has no thinking effort', () => {
    ix.stub(IAgentProfileService, stubProfile([]));
    ix.stub(IModelCatalog, stubCatalog([]));
    ix.set(IAgentUltracodeService, new SyncDescriptor(AgentUltracodeService));
    const ultracode = ix.get(IAgentUltracodeService);
    const events: DomainEvent[] = [];
    disposables.add(ix.get(IEventBus).subscribe((e) => events.push(e)));

    ultracode.enter('manual');

    expect(ultracode.isActive).toBe(false);
    expect(events).toContainEqual(
      expect.objectContaining({ type: 'warning', code: 'ultracode.thinking_unsupported' }),
    );
  });

  it('pops the enter reminder on exit when it is the last message', () => {
    const ultracode = ix.get(IAgentUltracodeService);
    const context = ix.get(IAgentContextMemoryService);
    const events: DomainEvent[] = [];
    disposables.add(ix.get(IEventBus).subscribe((e) => events.push(e)));
    ultracode.enter('manual');
    expect(context.get().length).toBe(1);

    ultracode.exit();

    // The cross-model fold pops the enter reminder; the service publishes the
    // splice event for injector bookkeeping (stub context memory does not
    // actually perform the splice).
    expect(events).toContainEqual({
      type: 'context.spliced',
      start: 0,
      deleteCount: 1,
      messages: [],
    });
  });

  it('appends the exit reminder when the last message is not the enter reminder', () => {
    const ultracode = ix.get(IAgentUltracodeService);
    const context = ix.get(IAgentContextMemoryService);
    ultracode.enter('manual');
    context.append({
      role: 'user',
      content: [{ type: 'text', text: 'a later message' }],
      toolCalls: [],
      origin: { kind: 'user' },
    });

    ultracode.exit();

    const messages = context.get();
    const origin = messages[messages.length - 1]!.origin;
    expect(origin?.kind).toBe('injection');
    if (origin?.kind !== 'injection') throw new Error('expected an injection origin');
    expect(origin.variant).toBe('ultracode_mode_exit');
  });

  it('re-injects a sparse maintenance reminder every N ended turns', () => {
    const ultracode = ix.get(IAgentUltracodeService);
    const context = ix.get(IAgentContextMemoryService);
    const eventBus = ix.get(IEventBus);
    ultracode.enter('manual');
    const afterEnter = context.get().length;

    for (let i = 0; i < 4; i++) {
      eventBus.publish({ type: 'turn.ended', turnId: i, reason: 'completed' });
    }

    expect(context.get().length).toBe(afterEnter + 1);
    const last = context.get().at(-1)!;
    const origin = last.origin;
    expect(origin?.kind).toBe('injection');
    if (origin?.kind !== 'injection') throw new Error('expected an injection origin');
    expect(origin.variant).toBe('ultracode_mode');
    expect(
      (last.content[0] as { text?: string }).text ?? '',
    ).toContain('Ultracode is still on');
  });

  it('verifies the Workflow tool is active on enter and warns when a policy blocks it', () => {
    const ultracode = ix.get(IAgentUltracodeService);
    const events: DomainEvent[] = [];
    disposables.add(ix.get(IEventBus).subscribe((e) => events.push(e)));

    ultracode.enter('manual');

    expect(isToolActive).toHaveBeenCalledWith(WORKFLOW_TOOL_NAME);
    expect(events).not.toContainEqual(
      expect.objectContaining({ code: 'ultracode.workflow_tool_blocked' }),
    );

    ultracode.exit();
    toolPolicyState.workflowActive = false;
    events.length = 0;
    ultracode.enter('keyword');

    expect(events).toContainEqual(
      expect.objectContaining({ type: 'warning', code: 'ultracode.workflow_tool_blocked' }),
    );
  });

  it('does not enter on the keyword when workflowKeywordTriggerEnabled is false', async () => {
    configState.agent = { workflowKeywordTriggerEnabled: false };
    const ultracode = ix.get(IAgentUltracodeService);

    await runHook('Please run this with chesto! mode');

    expect(ultracode.isActive).toBe(false);
  });

  it('is forced on by config and cannot be exited while config stays set', () => {
    configState.agent = { ultracode: true };
    const ultracode = ix.get(IAgentUltracodeService);

    expect(ultracode.isActive).toBe(true);

    ultracode.enter('manual');
    expect(ultracode.isActive).toBe(true);

    ultracode.exit();
    expect(ultracode.isActive).toBe(true);
  });
});

describe('containsUltracodeToken', () => {
  it('matches a bare keyword case-insensitively', () => {
    expect(containsUltracodeToken('use chesto!')).toBe(true);
    expect(containsUltracodeToken('CHESTO!')).toBe(true);
  });

  it('rejects empty, slash commands, code blocks, inline code, and quotes', () => {
    expect(containsUltracodeToken('')).toBe(false);
    expect(containsUltracodeToken('/chesto!')).toBe(false);
    expect(containsUltracodeToken('```\nchesto!\n```')).toBe(false);
    expect(containsUltracodeToken('`chesto!`')).toBe(false);
    expect(containsUltracodeToken('"chesto!"')).toBe(false);
    expect(containsUltracodeToken("'chesto!'")).toBe(false);
  });

  it('matches after stripping surrounding context', () => {
    expect(containsUltracodeToken('refactor this with chesto! please')).toBe(true);
  });

  it('does not match a longer word', () => {
    expect(containsUltracodeToken('xchesto!')).toBe(false);
  });

  it('userPromptText joins text parts', () => {
    expect(
      userPromptText([
        { type: 'text', text: 'hello' },
        { type: 'text', text: ' world' },
        { type: 'image_url', imageUrl: { url: 'data:image/png;base64,x' } },
      ]),
    ).toBe('hello\n world');
  });
});
