/**
 * `workflow.budget` — the main-loop token-budget accounting contract.
 *
 * The Workflow DSL's `budget` global reports `{ total, spent(), remaining() }`.
 * `total` and `spent()` are fed by REAL main-loop accounting rather than a
 * placeholder: the host tracks the current turn's token target (from a
 * `+500k`-style directive in the user prompt, or a configured default) and the
 * tokens the agent has actually consumed, and the workflow runtime consumes
 * that live budget for the sandbox `budget` global.
 *
 * This module is the contract (`IWorkflowBudgetService` + the pure directive
 * parser); the Agent-scoped implementation lives in `workflowBudgetService.ts`.
 * The parser is a pure function so it is unit-testable without a container and
 * shared between the service's prompt hook and any other consumer.
 */

import type { TokenUsage } from '#/kosong/contract/usage';

import type { WorkflowBudget } from '#/agent/workflow/types';

import { createDecorator } from '#/_base/di/instantiation';

/**
 * Parse a `+500k`-style token-budget directive out of natural-language text.
 *
 * The directive is a `+` immediately followed by a positive integer with an
 * optional `k` / `m` suffix, appearing as its own token (`+500k`, `+ 500000`,
 * `+1m`, `+250K`). The `+` prefix is the signal — a bare number is ordinary
 * prose — so a `+` inside a word or after a non-space char is ignored. Returns
 * the resolved token count, or `undefined` when no directive is present.
 */
export function parseTokenBudgetDirective(text: string): number | undefined {
  const match = TOKEN_BUDGET_DIRECTIVE.exec(text);
  if (match === null) return undefined;
  const raw = Number(match[1]);
  const suffix = match[2]?.toLowerCase();
  if (!Number.isInteger(raw) || raw <= 0) return undefined;
  if (suffix === 'k') return raw * 1_000;
  if (suffix === 'm') return raw * 1_000_000;
  return raw;
}

/** `+<digits> <k|m>` at the start of the text or after whitespace / `(`. */
const TOKEN_BUDGET_DIRECTIVE = /(?:^|[\s(])\+\s*(\d+)\s*([km])?(?=[\s,)\].!?;:]|$)/i;

/**
 * Host-facing token-budget accounting for workflow runs. Agent-scoped; the
 * Workflow tool reads it to resolve `budget.total` and feeds each spawned
 * subagent's usage back into it so `spent()` reflects the full real effort
 * (the agent's own main-loop tokens plus every subagent it fanned out).
 */
export interface IWorkflowBudgetService {
  readonly _serviceBrand: undefined;

  /** The current token target: `+500k`-style directive, else the configured default. */
  total(): number;
  /** Tokens actually consumed so far (main-loop records + recorded subagent usage). */
  spent(): number;
  /** Live `{ total, spent(), remaining() }` surface for the workflow runtime. */
  budget(): WorkflowBudget;
  /** Fold one subagent's `TokenUsage` into the running spent total. */
  recordSubagentUsage(usage: TokenUsage): void;
}

export const IWorkflowBudgetService = createDecorator<IWorkflowBudgetService>(
  'workflowBudgetService',
);
