/**
 * `ultracode` domain — wire Model (`UltracodeModel`) and the
 * `ultracode_mode.enter` / `ultracode_mode.exit` Ops for the agent's
 * ultracode mode.
 *
 * Declares ultracode mode as a `boolean` wire Model plus the two Ops that set
 * and clear it. The `apply` functions are the pure state transition; `toEvent`
 * rides the shared `agent.status.updated` event into the client so the TUI can
 * mirror the flag.
 */

import { z } from 'zod';

import { defineModel } from '#/wire/model';

import type { UltracodeTrigger } from './ultracode';

export const UltracodeModel = defineModel<boolean>('ultracode', () => false);

declare module '#/wire/types' {
  interface PersistedOpMap {
    'ultracode_mode.enter': typeof ultracodeEnter;
    'ultracode_mode.exit': typeof ultracodeExit;
  }
}

export const ultracodeEnter = UltracodeModel.defineOp('ultracode_mode.enter', {
  schema: z.object({ trigger: z.custom<UltracodeTrigger>() }),
  apply: () => true,
  toEvent: () => ({ type: 'agent.status.updated' as const, ultracode: true }),
});

export const ultracodeExit = UltracodeModel.defineOp('ultracode_mode.exit', {
  schema: z.object({}),
  apply: () => false,
  toEvent: () => ({ type: 'agent.status.updated' as const, ultracode: false }),
});
