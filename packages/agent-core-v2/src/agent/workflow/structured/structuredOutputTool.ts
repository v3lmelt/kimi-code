/**
 * `workflow.structured` — the `StructuredOutput` tool and its per-run state.
 *
 * When a workflow spawns a subagent with `agent(prompt, { schema })`, the
 * subagent's turn is given a single mandatory `StructuredOutput` tool. The
 * model must call it exactly once with `result` set to a value matching the
 * declared JSON schema; the tool validates the value and, on failure, returns
 * an error the model can fix and retry. After a retry cap the tool tells the
 * model to give up and return the result as plain text, and the run falls back
 * to the subagent's last text output.
 *
 * The tool carries its own per-run `StructuredOutputState` so the driver
 * (`runAgentTurn`) can read the validated value back after the turn settles.
 * Validation uses ajv (draft-07, the same target the repo's tool-parameter
 * helper renders) with `ajv-formats` registered for `format` keywords.
 */

import Ajv, { type ValidateFunction } from 'ajv';
import addFormats from 'ajv-formats';

import {
  ToolAccesses,
  type ExecutableTool,
  type ExecutableToolResult,
  type ToolExecution,
} from '#/tool/toolContract';

/** The tool's model-facing name. */
export const STRUCTURED_OUTPUT_TOOL_NAME = 'StructuredOutput';

/** How many failed validation attempts the tool tolerates before bailing. */
export const STRUCTURED_OUTPUT_RETRY_CAP = 5;

/**
 * Per-run state the tool mutates and the driver reads back. A single tool
 * instance is registered for one subagent run, so the state is run-scoped
 * (the run spans the main turn plus any driver-initiated structured-output
 * retry rounds). The tool mutates this object in place, so a caller that
 * injected it can observe attempts/errors as they accumulate.
 */
export interface StructuredOutputState {
  validated: boolean;
  value: unknown;
  attempts: number;
  errors: string[];
}

/** Fresh (not-yet-validated) state for a structured-output turn. */
export function createStructuredOutputState(): StructuredOutputState {
  return { validated: false, value: undefined, attempts: 0, errors: [] };
}

/** The input the model supplies to the tool: the candidate structured value. */
export interface StructuredOutputInput {
  readonly result?: unknown;
}

/**
 * Build the JSON-schema parameters the tool advertises: an object with a
 * single required `result` property shaped by the caller's schema.
 */
export function createStructuredOutputParameters(
  schema: Record<string, unknown>,
): Record<string, unknown> {
  return {
    type: 'object',
    properties: { result: schema },
    required: ['result'],
    additionalProperties: false,
  };
}

/**
 * The `StructuredOutput` tool. Validates the submitted value against the
 * declared schema, records the validated value in its state, and enforces the
 * retry cap. Idempotent after a successful call.
 */
export class StructuredOutputTool implements ExecutableTool<StructuredOutputInput> {
  readonly name = STRUCTURED_OUTPUT_TOOL_NAME;
  readonly description =
    'Deliver the final result of this run as structured data. You MUST call this tool exactly ' +
    'once, passing `result` set to a value that satisfies the declared JSON schema. The value is ' +
    'validated; a rejected value returns an error that you must fix and retry. If you cannot ' +
    'produce a valid value after several attempts, return the result as plain text instead.';

  readonly parameters: Record<string, unknown>;

  private readonly state: StructuredOutputState;
  private readonly validate: ValidateFunction | undefined;
  private readonly schemaError: string | undefined;
  private readonly retryCap: number;

  constructor(
    schema: Record<string, unknown>,
    state: StructuredOutputState = createStructuredOutputState(),
    retryCap: number = STRUCTURED_OUTPUT_RETRY_CAP,
  ) {
    this.parameters = createStructuredOutputParameters(schema);
    this.state = state;
    this.retryCap = retryCap;
    try {
      const ajv = new Ajv({ allErrors: true, strict: false });
      addFormats(ajv);
      this.validate = ajv.compile(schema);
      this.schemaError = undefined;
    } catch (error) {
      this.validate = undefined;
      this.schemaError = error instanceof Error ? error.message : String(error);
    }
  }

  /** Whether the model produced a schema-valid value. */
  get validated(): boolean {
    return this.state.validated;
  }

  /** The validated value, or `undefined` before/without validation. */
  get value(): unknown {
    return this.state.value;
  }

  /** Validation errors accumulated so far (for the driver's retry prompt). */
  get errors(): readonly string[] {
    return this.state.errors;
  }

  /** Whether a driver-initiated retry round can still succeed (valid schema). */
  get retryable(): boolean {
    return !this.state.validated && this.schemaError === undefined && this.validate !== undefined;
  }

  /**
   * Reset the attempt counter for a new driver-initiated retry round, so a
   * model re-prompted via a continuation turn gets a fresh retry budget.
   * Errors are kept so the retry prompt can reference them.
   */
  resetRetryBudget(): void {
    this.state.attempts = 0;
  }

  resolveExecution(input: StructuredOutputInput): ToolExecution {
    return {
      accesses: ToolAccesses.none(),
      description: 'Deliver the final structured result',
      approvalRule: this.name,
      execute: async () => this.deliver(input.result),
    };
  }

  private deliver(value: unknown): ExecutableToolResult {
    if (this.state.validated) {
      return { output: 'Structured output already accepted.' };
    }
    this.state.attempts += 1;

    if (this.schemaError !== undefined || this.validate === undefined) {
      this.state.errors.push(`invalid schema: ${this.schemaError ?? 'unknown error'}`);
      return {
        output: `Structured output cannot be validated because the schema is invalid: ${this.schemaError ?? 'unknown error'}. Return the result as plain text in your final message instead.`,
        isError: true,
      };
    }

    const ok = this.validate(value);
    if (ok) {
      this.state.validated = true;
      this.state.value = value;
      return { output: 'Structured output accepted.' };
    }

    const message = formatValidationErrors(this.validate.errors ?? []);
    this.state.errors.push(message);
    if (this.state.attempts >= this.retryCap) {
      return {
        output:
          `Structured output was rejected after ${String(this.state.attempts)} attempts: ${message}. ` +
          'Give up on StructuredOutput and return the result as plain text in your final message instead.',
        isError: true,
      };
    }
    return {
      output: `Structured output failed schema validation: ${message}. Fix the value and call StructuredOutput again.`,
      isError: true,
    };
  }
}

function formatValidationErrors(
  errors: ReadonlyArray<{ readonly instancePath?: string; readonly message?: string }>,
): string {
  const rendered = errors.map((error) => {
    const path = error.instancePath ?? '';
    const message = error.message ?? 'invalid value';
    return path.length === 0 ? message : `${path}: ${message}`;
  });
  return rendered.length === 0 ? 'value does not match the schema' : rendered.join('; ');
}
