import { describe, expect, it } from 'vitest';

import {
  isWorkflowProgressEventEnvelope,
  type WorkflowProgressEventEnvelope,
} from '#/events';
import {
  translateDomainEvent,
  translateWorkflowProgressEvent,
} from '#/v2/event-mapper';

describe('v2 workflow event mapping', () => {
  it('preserves optional identity and replay fields while stamping the owning scope', () => {
    const event = {
      type: 'workflow.progress',
      runId: 'wf_demo',
      event: {
        type: 'workflow.agent_spawned',
        runId: 'wf_demo',
        agentId: 'agent-7',
        label: 'worker',
        nodeId: 'node-2',
        taskPath: 'main/workflow/node-2',
        cache: 'hit',
        replayed: true,
        isolation: { leaseId: 'lease-1', worktreePath: 'C:/worktree' },
      },
      sessionId: 'attacker-session',
      agentId: 'attacker-agent',
      futureField: { preserved: true },
    } as unknown as WorkflowProgressEventEnvelope;

    const mapped = translateWorkflowProgressEvent(event, 'session-1', 'agent-1') as unknown as Record<string, unknown>;
    expect(mapped).toMatchObject({
      type: 'workflow.progress',
      sessionId: 'session-1',
      agentId: 'agent-1',
      futureField: { preserved: true },
    });
    const mappedEvent = mapped['event'] as Record<string, unknown>;
    expect(mappedEvent['nodeId']).toBe('node-2');
    expect(mappedEvent['replayed']).toBe(true);
    expect(mappedEvent['isolation']).toEqual({
      leaseId: 'lease-1',
      worktreePath: 'C:/worktree',
    });
  });

  it('exposes an additive workflow mapper without changing the legacy Event union', () => {
    const event = {
      type: 'workflow.progress',
      runId: 'wf_demo',
      event: { type: 'workflow.log', runId: 'wf_demo', message: 'hello' },
      nodeId: 'node-1',
    } as unknown as WorkflowProgressEventEnvelope;
    expect(isWorkflowProgressEventEnvelope(event)).toBe(true);
    expect(translateWorkflowProgressEvent(event, 's1', 'main')).toEqual({
      ...event,
      sessionId: 's1',
      agentId: 'main',
    });
  });

  it('rejects an envelope whose outer and inner run ids differ', () => {
    const event = {
      type: 'workflow.progress',
      runId: 'wf_outer',
      event: { type: 'workflow.log', runId: 'wf_inner', message: 'bad' },
    } as unknown as WorkflowProgressEventEnvelope;
    expect(isWorkflowProgressEventEnvelope(event)).toBe(false);
    expect(translateWorkflowProgressEvent(event, 's1', 'main')).toBeUndefined();
  });

  it('does not map workflow progress into the legacy Event stream', () => {
    const event = {
      type: 'workflow.progress',
      runId: 'wf_demo',
      event: { type: 'workflow.log', runId: 'wf_demo', message: 'hello' },
    } as never;
    expect(translateDomainEvent(event, 's1', 'main')).toBeUndefined();
  });
});
