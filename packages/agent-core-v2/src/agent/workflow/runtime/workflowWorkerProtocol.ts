/**
 * `workflow.runtime` domain — structured messages exchanged by the workflow
 * host and its short-lived execution Worker.
 *
 * The protocol deliberately contains only structured-cloneable values. The
 * host never sends a callback, Service, AbortSignal, or other live object into
 * the Worker; calls from the workflow are represented by request messages and
 * completed through response messages.
 */

import type { TokenUsage } from '#/kosong/contract/usage';

import type { WorkflowAgentOpts } from '../types';

export const WORKFLOW_WORKER_PROTOCOL_VERSION = 1;

export interface WorkflowWorkerData {
  readonly protocolVersion: number;
  readonly wrappedSource: string;
  readonly args: unknown;
  readonly sandboxPrelude: string;
  readonly tokenBudgetTotal: number;
  readonly initialBudgetSpent: number;
  readonly agentCap: number;
  readonly maxItemsPerFanOut: number;
  readonly maxConcurrency: number;
  readonly timeoutMs: number;
}

export interface WorkflowWorkerErrorPayload {
  readonly name: string;
  readonly message: string;
  readonly stack?: string;
  readonly cap?: number;
  readonly spent?: number;
  readonly total?: number;
}

export interface WorkflowWorkerAgentResult {
  readonly ok: boolean;
  readonly agentId: string;
  readonly output: unknown;
  readonly error?: string;
  readonly durationMs: number;
  readonly usage?: TokenUsage;
}

export type WorkflowWorkerHostMessage =
  | { readonly type: 'ready'; readonly protocolVersion: number }
  | { readonly type: 'heartbeat'; readonly spent: number }
  | {
      readonly type: 'agent';
      readonly id: number;
      readonly prompt: string;
      readonly opts?: WorkflowAgentOpts;
    }
  | { readonly type: 'phase'; readonly title: unknown }
  | { readonly type: 'log'; readonly parts: readonly unknown[] };

export type WorkflowWorkerTerminalMessage =
  | {
      readonly type: 'done';
      readonly result: unknown;
      readonly agentsSpawned: number;
    }
  | { readonly type: 'error'; readonly error: WorkflowWorkerErrorPayload };

export type WorkflowWorkerMessage =
  | WorkflowWorkerHostMessage
  | WorkflowWorkerTerminalMessage;

export type WorkflowWorkerControlMessage =
  | { readonly type: 'cancel' }
  | { readonly type: 'budgetUpdate'; readonly spent: number }
  | {
      readonly type: 'agentResult';
      readonly id: number;
      readonly ok: true;
      readonly result: WorkflowWorkerAgentResult;
      readonly budgetSpent: number;
    }
  | {
      readonly type: 'agentResult';
      readonly id: number;
      readonly ok: false;
      readonly error: WorkflowWorkerErrorPayload;
    };
