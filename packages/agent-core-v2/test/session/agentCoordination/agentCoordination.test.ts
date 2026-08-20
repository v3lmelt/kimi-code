/**
 * `agentCoordination` domain — Session-scoped task-tree and collaboration tests.
 *
 * Resolves the coordination service by interface through the test container
 * and exercises canonical addressing, same-tree permissions, queue-only
 * messaging, follow-up and interruption control, waiting, context policy
 * sanitization, and child capability restriction.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { DisposableStore } from '#/_base/di/lifecycle';
import { Emitter } from '#/_base/event';
import { createServices, type TestInstantiationService } from '#/_base/di/test';
import type { IAgentScopeHandle } from '#/_base/di/scope';
import { IFlagService } from '#/app/flag/flag';
import { IAgentContextMemoryService } from '#/agent/contextMemory/contextMemory';
import type { ContextMessage } from '#/agent/contextMemory/types';
import { IAgentLoopService } from '#/agent/loop/loop';
import { IAgentProfileService, type ProfileUpdateData } from '#/agent/profile/profile';
import { IAgentLifecycleService } from '#/session/agentLifecycle/agentLifecycle';
import { ISessionSubagentService } from '#/session/subagent/subagent';
import { ISessionMetadata } from '#/session/sessionMetadata/sessionMetadata';
import { Error2, ErrorCodes } from '#/errors';

import { IAgentCoordinationService } from '#/session/agentCoordination/agentCoordination';
import { AgentCoordinationService } from '#/session/agentCoordination/agentCoordinationService';

type LoopStub = {
  readonly loop: IAgentLoopService;
  readonly enqueue: ReturnType<typeof vi.fn>;
  readonly cancel: ReturnType<typeof vi.fn>;
  setState(state: 'idle' | 'running'): void;
  settle(): void;
};

type MemoryStub = {
  readonly memory: IAgentContextMemoryService;
  readonly messages: ContextMessage[];
};

function loopStub(initial: 'idle' | 'running' = 'idle'): LoopStub {
  let state = initial;
  let resolveSettled: (() => void) | undefined;
  let settled = Promise.resolve();
  const enqueue = vi.fn();
  const cancel = vi.fn(() => {
    state = 'idle';
    resolveSettled?.();
    resolveSettled = undefined;
    return true;
  });
  const loop = {
    status: () => ({
      state,
      pendingTurnIds: [],
      hasPendingRequests: false,
    }),
    enqueue,
    cancel,
    settled: () => settled,
  } as unknown as IAgentLoopService;
  return {
    loop,
    enqueue,
    cancel,
    setState(next) {
      state = next;
      if (next === 'running') {
        settled = new Promise<void>((resolve) => {
          resolveSettled = resolve;
        });
      }
    },
    settle() {
      state = 'idle';
      resolveSettled?.();
      resolveSettled = undefined;
    },
  };
}

function memoryStub(messages: readonly ContextMessage[] = []): MemoryStub {
  const memoryMessages = [...messages];
  const memory = {
    get: () => memoryMessages,
    append: (...next: readonly ContextMessage[]) => memoryMessages.push(...next),
  } as unknown as IAgentContextMemoryService;
  return { memory, messages: memoryMessages };
}

function profileStub(activeToolNames: readonly string[] = ['Read']): IAgentProfileService {
  const data: {
    activeToolNames: string[];
    disallowedTools: string[];
    profileName: string;
    thinkingLevel: string;
    systemPrompt: string;
    modelCapabilities: Record<string, never>;
  } = {
    activeToolNames: [...activeToolNames],
    disallowedTools: [],
    profileName: 'coder',
    thinkingLevel: 'off',
    systemPrompt: '',
    modelCapabilities: {},
  };
  return {
    data: () => data,
    update: vi.fn((changed: ProfileUpdateData) => {
      if (changed.activeToolNames !== undefined) data.activeToolNames = [...changed.activeToolNames];
      if (changed.disallowedTools !== undefined) data.disallowedTools = [...changed.disallowedTools];
    }),
  } as unknown as IAgentProfileService;
}

function handle(
  id: string,
  loop: LoopStub,
  memory: MemoryStub,
  profile = profileStub(),
): IAgentScopeHandle {
  return {
    id,
    accessor: {
      get: (service: unknown) => {
        if (service === IAgentLoopService) return loop.loop;
        if (service === IAgentContextMemoryService) return memory.memory;
        if (service === IAgentProfileService) return profile;
        return undefined;
      },
    },
  } as unknown as IAgentScopeHandle;
}

describe('AgentCoordinationService', () => {
  let disposables: DisposableStore;
  let ix: TestInstantiationService;
  let lifecycle: IAgentLifecycleService;
  let service: IAgentCoordinationService;
  let handles: Record<string, IAgentScopeHandle>;
  let loops: Record<string, LoopStub>;
  let memories: Record<string, MemoryStub>;
  let metadata: ISessionMetadata;
  let run: ReturnType<typeof vi.fn>;
  let create: ReturnType<typeof vi.fn>;
  let createdEvent: Emitter<IAgentScopeHandle>;
  let disposedEvent: Emitter<string>;
  let createMemoryError: Error | undefined;

  beforeEach(() => {
    disposables = new DisposableStore();
    handles = {};
    loops = {};
    memories = {};
    createMemoryError = undefined;
    createdEvent = new Emitter<IAgentScopeHandle>();
    disposedEvent = new Emitter<string>();
    const addHandle = (id: string, state: 'idle' | 'running' = 'idle', tools = ['Read']) => {
      loops[id] = loopStub(state);
      memories[id] = memoryStub();
      const appendError = createMemoryError;
      if (appendError !== undefined) {
        memories[id]!.memory.append = () => {
          throw appendError;
        };
      }
      handles[id] = handle(id, loops[id]!, memories[id]!, profileStub(tools));
      return handles[id]!;
    };
    addHandle('main');
    create = vi.fn(async ({ agentId }: { readonly agentId?: string }) => {
      const id = agentId ?? `agent-${Object.keys(handles).length}`;
      const child = addHandle(id, 'idle', ['Read', 'Write', 'Bash']);
      createdEvent.fire(child);
      return child;
    });
    lifecycle = {
      onDidCreate: createdEvent.event,
      onDidDispose: disposedEvent.event,
      create,
      fork: vi.fn(),
      get: (id: string) => handles[id],
      list: () => Object.values(handles),
      broadcastPermissionMode: vi.fn(),
      remove: vi.fn(async (id: string) => {
        delete handles[id];
        disposedEvent.fire(id);
      }),
    } as unknown as IAgentLifecycleService;
    run = vi.fn(async (id: string) => {
      loops[id]?.setState('running');
      return { completion: Promise.resolve({ summary: `finished ${id}` }) };
    });
    metadata = { read: vi.fn(async () => ({ agents: {} })) } as unknown as ISessionMetadata;
    ix = createServices(disposables, {
      additionalServices: (reg) => {
        reg.defineInstance(IAgentLifecycleService, lifecycle);
        reg.defineInstance(ISessionSubagentService, {
          run,
        } as unknown as ISessionSubagentService);
        reg.defineInstance(ISessionMetadata, metadata);
        reg.defineInstance(IFlagService, {
          enabled: () => true,
        } as unknown as IFlagService);
        reg.define(IAgentCoordinationService, AgentCoordinationService);
      },
    });
    service = ix.get(IAgentCoordinationService);
    service.register(handles['main']!);
  });

  afterEach(() => {
    disposables.dispose();
  });

  it('assigns unique canonical paths and preserves the agent id address', async () => {
    const first = await service.spawn({ callerAgentId: 'main', taskName: 'review' });
    const second = await service.spawn({ callerAgentId: 'main', taskName: 'review' });

    expect(first.task.taskPath).toBe('main/review');
    expect(second.task.taskPath).toBe('main/review~2');
    expect(service.resolve(first.task.taskPath)?.agentId).toBe(first.handle.id);
    expect(service.resolve(first.handle.id)?.taskPath).toBe(first.task.taskPath);
  });

  it('rolls back a child when applying inherited context fails and reuses its task path', async () => {
    memories['main']!.messages.push({
      role: 'user',
      content: [{ type: 'text', text: 'context' }],
      toolCalls: [],
      origin: { kind: 'user' },
    });
    const contextError = new Error2(ErrorCodes.VALIDATION_FAILED, 'context application failed');
    createMemoryError = contextError;

    await expect(
      service.spawn({
        callerAgentId: 'main',
        taskName: 'rollback-context',
        contextPolicy: { kind: 'full' },
      }),
    ).rejects.toBe(contextError);

    expect(lifecycle.remove).toHaveBeenCalledWith('agent-1');
    expect(handles['agent-1']).toBeUndefined();
    expect(service.resolve('main/rollback-context')).toBeUndefined();

    createMemoryError = undefined;
    const retry = await service.spawn({ callerAgentId: 'main', taskName: 'rollback-context' });
    expect(retry.task.taskPath).toBe('main/rollback-context');
  });

  it('rolls back a child when metadata persistence fails and reuses its task path', async () => {
    const metadataError = new Error2(ErrorCodes.VALIDATION_FAILED, 'metadata persistence failed');
    metadata.registerAgent = vi.fn(async () => {
      throw metadataError;
    });

    await expect(
      service.spawn({ callerAgentId: 'main', taskName: 'rollback-metadata' }),
    ).rejects.toBe(metadataError);

    expect(lifecycle.remove).toHaveBeenCalledWith('agent-1');
    expect(handles['agent-1']).toBeUndefined();
    expect(service.resolve('main/rollback-metadata')).toBeUndefined();

    metadata.registerAgent = vi.fn(async () => {});
    const retry = await service.spawn({ callerAgentId: 'main', taskName: 'rollback-metadata' });
    expect(retry.task.taskPath).toBe('main/rollback-metadata');
  });

  it('queues same-level messages and rejects a different root tree', async () => {
    const left = await service.spawn({ callerAgentId: 'main', taskName: 'left' });
    const right = await service.spawn({ callerAgentId: 'main', taskName: 'right' });

    await service.sendMessage(left.handle.id, right.task.taskPath, 'coordinate');
    expect(loops[right.handle.id]!.enqueue).toHaveBeenCalledTimes(1);

    const otherRootLoop = loopStub();
    const otherRootMemory = memoryStub();
    const other = handle('other', otherRootLoop, otherRootMemory);
    handles['other'] = other;
    service.register(other, { taskName: 'other' });
    await expect(service.sendMessage('main', other.id, 'no')).rejects.toThrow(/outside.*tree/i);
  });

  it('follows up completed targets, interrupts running targets, and waits for settlement', async () => {
    const target = await service.spawn({ callerAgentId: 'main', taskName: 'worker' });
    const result = await service.followupTask('main', target.task.taskPath, 'continue', new AbortController().signal);
    expect(result.summary).toContain('finished');
    expect(run).toHaveBeenCalledWith(target.handle.id, expect.anything(), expect.anything());
    expect(service.resolve(target.task.taskPath)?.status).toBe('completed');

    service.markRunStarted(target.handle.id);
    loops[target.handle.id]!.setState('running');
    await service.interrupt('main', target.task.taskPath);
    expect(loops[target.handle.id]!.cancel).toHaveBeenCalledTimes(1);
    service.markRunFinished(target.handle.id, 'completed');
    expect(service.resolve(target.task.taskPath)?.status).toBe('interrupted');

    const waitTarget = await service.spawn({ callerAgentId: 'main', taskName: 'waiter' });
    loops[waitTarget.handle.id]!.setState('running');
    service.markRunStarted(waitTarget.handle.id);
    const waiting = service.wait('main', waitTarget.task.taskPath);
    loops[waitTarget.handle.id]!.settle();
    const waited = await waiting;
    expect(waited.status).toBe('completed');
  });

  it('sanitizes full, lastN, and digest context while fresh stays empty', () => {
    const source = memories['main']!;
    source.messages.push(
      { role: 'user', content: [{ type: 'text', text: 'first' }], toolCalls: [], origin: { kind: 'user' } },
      { role: 'assistant', content: [{ type: 'text', text: 'tool payload' }], toolCalls: [], origin: { kind: 'system_trigger', name: 'old_agent' } },
      { role: 'user', content: [{ type: 'text', text: 'second' }], toolCalls: [], origin: { kind: 'user' } },
      { role: 'user', content: [{ type: 'text', text: 'ignored control' }], toolCalls: [], origin: { kind: 'system_trigger', name: 'usage' } },
    );

    expect(service.contextSnapshot('main', { kind: 'fresh' })).toHaveLength(0);
    const full = service.contextSnapshot('main', { kind: 'full' });
    expect(full).toHaveLength(2);
    expect(full.every((message) => message.toolCalls.length === 0)).toBe(true);
    expect(full.every((message) => message.origin?.kind === 'system_trigger')).toBe(true);
    expect(service.contextSnapshot('main', { kind: 'lastN', count: 1 })[0]?.content).toEqual([
      { type: 'text', text: 'second' },
    ]);
    expect(service.contextSnapshot('main', { kind: 'digest', maxChars: 100 })[0]?.content[0]).toEqual(
      expect.objectContaining({ type: 'text' }),
    );
  });

  it('restricts a child capability set to the parent capability set', async () => {
    const parent = handles['main']!;
    const child = await service.spawn({ callerAgentId: parent.id, taskName: 'limited' });
    const childProfile = child.handle.accessor.get(IAgentProfileService) as IAgentProfileService;
    expect(childProfile.data().activeToolNames).toEqual(['Read']);
    expect((childProfile.update as unknown as ReturnType<typeof vi.fn>)).toBeDefined();
  });
});
