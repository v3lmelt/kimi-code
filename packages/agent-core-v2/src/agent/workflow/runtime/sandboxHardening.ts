/**
 * `workflow.runtime` — runtime hardening for the workflow sandbox.
 *
 * The compile-time determinism validator rejects `Date.now()` /
 * `Math.random()` / `new Date()` statically, but static analysis can be
 * sidestepped (computed access `Date['now']`, aliasing, a library constant
 * string evaluated indirectly). This module provides the defense in depth
 * the official engine ships: a prelude that runs inside the sandbox context
 * before the user script and *breaks* the non-deterministic builtins at
 * runtime (so a bypass fails loudly instead of silently poisoning resume
 * caching), plus a frozen error-object helper so cross-realm errors thrown
 * at the host cannot be turned into setter traps by a hostile script.
 */

/** Message thrown when the script reaches a non-deterministic builtin. */
export const WORKFLOW_NOW_ERROR =
  'Date.now() / new Date() are non-deterministic and unavailable inside a workflow script (they would break resume caching). Pass timestamps in via `args`, or stamp results after the workflow returns.';

export const WORKFLOW_RANDOM_ERROR =
  'Math.random() is non-deterministic and unavailable inside a workflow script (it would break resume caching). Derive bounded randomness deterministically from the input values, or vary the agent prompt/label by index.';

/**
 * Source of the sandbox prelude. Runs inside the vm context before the user
 * script: `Math.random` and `Date.now` become throwing functions, `Date`
 * becomes a shim that rejects `new Date()` and bare `Date()` while keeping
 * `new Date(x)` / `Date.parse` / `Date.UTC` usable, and the real `Date` is
 * frozen so the `(new Date(x)).constructor` backdoor cannot restore
 * `RealDate.now`.
 */
export const WORKFLOW_SANDBOX_PRELUDE = `(() => {
  const NOW_ERR = ${JSON.stringify(WORKFLOW_NOW_ERROR)};
  const RANDOM_ERR = ${JSON.stringify(WORKFLOW_RANDOM_ERROR)};
  Math.random = function random() { throw new Error(RANDOM_ERR); };
  const RealDate = Date;
  RealDate.now = function now() { throw new Error(NOW_ERR); };
  function ShimDate(...a) {
    if (!new.target) throw new Error(NOW_ERR);
    if (a.length === 0) throw new Error(NOW_ERR);
    return Reflect.construct(RealDate, a, new.target);
  }
  ShimDate.now = RealDate.now;
  ShimDate.parse = RealDate.parse;
  ShimDate.UTC = RealDate.UTC;
  ShimDate.prototype = RealDate.prototype;
  // Close the (new Date(x)).constructor backdoor to RealDate.now — point
  // .constructor at the shim, then freeze RealDate so it can't be undone.
  RealDate.prototype.constructor = ShimDate;
  Object.freeze(RealDate);
  globalThis.Date = ShimDate;
})()`;

/**
 * Registry of the frozen error objects this process has handed to sandboxed
 * code. Lets `isFrozenWorkflowError` distinguish them from script-crafted
 * lookalikes without trusting any property read.
 */
const frozenErrors = new WeakSet<object>();

/**
 * Build a plain, null-prototype, deeply frozen error object from parts the
 * host has already validated. Property reads on a sandbox-crafted error can
 * be setter traps that run script code on the host stack; a frozen plain
 * object carries no getters/setters and cannot gain any.
 */
export function frozenWorkflowError(
  message: string,
  name = 'Error',
  stack?: string,
): Readonly<{ name: string; message: string; stack: string; toString: () => string }> {
  const toString = (): string => `${name}: ${message}`;
  Object.setPrototypeOf(toString, null);
  Object.freeze(toString);
  const error = Object.freeze({
    __proto__: null,
    name,
    message,
    stack: stack ?? `${name}: ${message}`,
    toString,
  } as { name: string; message: string; stack: string; toString: () => string });
  frozenErrors.add(error);
  return error;
}

/** True when `value` is a frozen error object minted by this module. */
export function isFrozenWorkflowError(value: unknown): boolean {
  return typeof value === 'object' && value !== null && frozenErrors.has(value);
}

/**
 * Default wall-clock timeout (ms) for one `await`-free slice of script
 * execution. `vm.Script.runInContext({timeout})` bounds each synchronous
 * stretch between awaits — the only place a script can pin the host's event
 * loop (e.g. `while (true) {}`). Async waits (subagent `agent()` calls)
 * resolve from already-queued microtasks and are NOT bounded by this, so
 * long-running workflows are unaffected. The official engine uses the same
 * per-slice bound for its synchronous entry slice.
 */
export const WORKFLOW_DEFAULT_TIMEOUT_MS = 30 * 1000;
