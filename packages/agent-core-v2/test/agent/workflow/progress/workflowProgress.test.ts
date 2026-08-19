/**
 * `workflow.progress` — unit tests for the progress wire Model and Ops.
 *
 * Covers: each Op folds the right per-run ledger state; every Op publishes the
 * single `'workflow.progress'` bus event with the runId and the discriminator;
 * no-op applies keep the same state reference (re-start, same phase, terminal
 * settle); the Ops are transient (nothing lands in the wire journal); and the
 * telemetry hook adapts `ITelemetryService.track` onto the
 * `tengu_workflow_launched` / `tengu_workflow_completed` event names.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { SyncDescriptor } from '#/_base/di/descriptors';
import { DisposableStore } from '#/_base/di/lifecycle';
import { TestInstantiationService } from '#/_base/di/test';
import {
  WorkflowProgressModel,
  noopWorkflowTelemetryHook,
  telemetryWorkflowHook,
  workflowAgentCompleted,
  workflowAgentSpawned,
  workflowCompleted,
  workflowPhaseChanged,
  workflowStarted,
} from '#/agent/workflow/progress/workflowProgress';
import { type WorkflowRunId } from '#/agent/workflow/types';
import { type DomainEvent, IEventBus } from '#/app/event/eventBus';
import { EventBusService } from '#/app/event/eventBusService';
import type { ITelemetryService } from '#/app/telemetry/telemetry';
import { AppendLogStore } from '#/persistence/backends/node-fs/appendLogStore';
import { InMemoryStorageService } from '#/persistence/backends/memory/inMemoryStorageService';
import { IAppendLogStore } from '#/persistence/interface/appendLogStore';
import { IFileSystemStorageService } from '#/persistence/interface/storage';
import { type IWireService } from '#/wire/wire';
import { AGENT_WIRE_RECORD_KEY, type WireRecord } from '#/wire/record';

import { registerTestAgentWire, testWireScope } from '../../../wire/stubs';

const RUN_ID = 'wf_0123456789abcdef' as WorkflowRunId;

const META = {
  name: 'demo',
  description: 'A demo workflow',
  phases: [{ title: 'gather' }],
};

describe('WorkflowProgressModel', () => {
  let disposables: DisposableStore;
  let ix: TestInstantiationService;
  let wire: IWireService;
  let eventBus: IEventBus;
  let scope: string;

  beforeEach(() => {
    disposables = new DisposableStore();
    ix = disposables.add(new TestInstantiationService());
    ix.stub(IFileSystemStorageService, new InMemoryStorageService());
    ix.set(IAppendLogStore, new SyncDescriptor(AppendLogStore));
    ix.set(IEventBus, new SyncDescriptor(EventBusService));
    scope = testWireScope('wire', 'workflow-progress-test');
    wire = registerTestAgentWire(ix, scope, {
      log: ix.get(IAppendLogStore),
      eventBus: ix.get(IEventBus),
    });
    eventBus = ix.get(IEventBus);
  });

  afterEach(() => disposables.dispose());

  it('folds the full run lifecycle into the ledger and emits one bus event per Op', () => {
    const events: DomainEvent[] = [];
    disposables.add(eventBus.subscribe((event) => events.push(event)));

    wire.dispatch(workflowStarted({ runId: RUN_ID, meta: META, startedAt: 't0' }));
    wire.dispatch(workflowPhaseChanged({ runId: RUN_ID, phase: 'gather' }));
    wire.dispatch(
      workflowAgentSpawned({ runId: RUN_ID, agentId: 'agent-1', label: 'collector', phase: 'gather' }),
    );
    wire.dispatch(
      workflowAgentCompleted({ runId: RUN_ID, agentId: 'agent-1', ok: true, durationMs: 120 }),
    );
    wire.dispatch(workflowCompleted({ runId: RUN_ID, ok: true, result: { done: true } }));

    const state = wire.getModel(WorkflowProgressModel).get(RUN_ID);
    expect(state).toMatchObject({
      runId: RUN_ID,
      status: 'completed',
      phase: 'gather',
      spawnedAgents: 1,
      completedAgents: 1,
      startedAt: 't0',
    });
    expect(state?.result).toEqual({ done: true });

    expect(events).toEqual([
      {
        type: 'workflow.progress',
        runId: RUN_ID,
        event: { type: 'workflow.started', runId: RUN_ID, meta: META, startedAt: 't0' },
      },
      {
        type: 'workflow.progress',
        runId: RUN_ID,
        event: { type: 'workflow.phase_changed', runId: RUN_ID, phase: 'gather' },
      },
      {
        type: 'workflow.progress',
        runId: RUN_ID,
        event: {
          type: 'workflow.agent_spawned',
          runId: RUN_ID,
          agentId: 'agent-1',
          label: 'collector',
          phase: 'gather',
        },
      },
      {
        type: 'workflow.progress',
        runId: RUN_ID,
        event: {
          type: 'workflow.agent_completed',
          runId: RUN_ID,
          agentId: 'agent-1',
          ok: true,
          durationMs: 120,
        },
      },
      {
        type: 'workflow.progress',
        runId: RUN_ID,
        event: { type: 'workflow.completed', runId: RUN_ID, ok: true, result: { done: true } },
      },
    ]);
  });

  it('no-ops keep the same state reference: re-start, same phase, terminal settle', () => {
    wire.dispatch(workflowStarted({ runId: RUN_ID, meta: META, startedAt: 't0' }));
    const before = wire.getModel(WorkflowProgressModel);

    // Re-starting the same run is a no-op.
    wire.dispatch(workflowStarted({ runId: RUN_ID, meta: META, startedAt: 't1' }));
    expect(wire.getModel(WorkflowProgressModel)).toBe(before);

    // Re-entering the same phase (after it was applied) is a no-op.
    wire.dispatch(workflowPhaseChanged({ runId: RUN_ID, phase: 'gather' }));
    const afterPhase = wire.getModel(WorkflowProgressModel);
    expect(afterPhase).not.toBe(before);
    wire.dispatch(workflowPhaseChanged({ runId: RUN_ID, phase: 'gather' }));
    expect(wire.getModel(WorkflowProgressModel)).toBe(afterPhase);

    // Settling an already-terminal run is a no-op.
    wire.dispatch(workflowCompleted({ runId: RUN_ID, ok: true }));
    const afterCompleted = wire.getModel(WorkflowProgressModel);
    expect(afterCompleted).not.toBe(afterPhase);
    expect(afterCompleted.get(RUN_ID)?.status).toBe('completed');
    wire.dispatch(workflowCompleted({ runId: RUN_ID, ok: false, error: 'ignored' }));
    expect(wire.getModel(WorkflowProgressModel)).toBe(afterCompleted);
    expect(afterCompleted.get(RUN_ID)?.error).toBeUndefined();
  });

  it('a failed completion records status failed and the error', () => {
    wire.dispatch(workflowStarted({ runId: RUN_ID, meta: META, startedAt: 't0' }));
    wire.dispatch(workflowCompleted({ runId: RUN_ID, ok: false, error: 'boom' }));

    const state = wire.getModel(WorkflowProgressModel).get(RUN_ID);
    expect(state?.status).toBe('failed');
    expect(state?.error).toBe('boom');
  });

  it('ignores spawn/completion events for a run that never started', () => {
    wire.dispatch(workflowAgentSpawned({ runId: RUN_ID, agentId: 'agent-1' }));
    wire.dispatch(
      workflowAgentCompleted({ runId: RUN_ID, agentId: 'agent-1', ok: true, durationMs: 1 }),
    );

    expect(wire.getModel(WorkflowProgressModel).has(RUN_ID)).toBe(false);
  });

  it('is transient: nothing is persisted to the wire journal', async () => {
    wire.dispatch(workflowStarted({ runId: RUN_ID, meta: META, startedAt: 't0' }));
    wire.dispatch(
      workflowAgentSpawned({ runId: RUN_ID, agentId: 'agent-1', label: 'collector' }),
    );
    wire.dispatch(workflowCompleted({ runId: RUN_ID, ok: true }));

    const records: WireRecord[] = [];
    const log = ix.get(IAppendLogStore);
    for await (const record of log.read<WireRecord>(scope, AGENT_WIRE_RECORD_KEY)) {
      records.push(record);
    }
    expect(records.filter((record) => record.type.startsWith('workflow.'))).toEqual([]);
  });
});

describe('WorkflowTelemetryHook', () => {
  it('noop hook is safe to call', () => {
    expect(() => {
      noopWorkflowTelemetryHook.launched(RUN_ID, META);
      noopWorkflowTelemetryHook.completed(RUN_ID, true);
      noopWorkflowTelemetryHook.completed(RUN_ID, false, 'boom');
    }).not.toThrow();
  });

  it('adapts track onto the tengu event names', () => {
    const track = vi.fn();
    const telemetry = { track } as unknown as ITelemetryService;
    const hook = telemetryWorkflowHook(telemetry);

    hook.launched(RUN_ID, META);
    hook.completed(RUN_ID, true);
    hook.completed(RUN_ID, false, 'boom');

    expect(track).toHaveBeenCalledTimes(3);
    expect(track).toHaveBeenNthCalledWith(1, 'tengu_workflow_launched', {
      run_id: RUN_ID,
      workflow_name: 'demo',
    });
    expect(track).toHaveBeenNthCalledWith(2, 'tengu_workflow_completed', {
      run_id: RUN_ID,
      ok: true,
    });
    expect(track).toHaveBeenNthCalledWith(3, 'tengu_workflow_completed', {
      run_id: RUN_ID,
      ok: false,
      error: 'boom',
    });
  });
});
