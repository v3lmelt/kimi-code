/**
 * `workflow.structured` — unit tests for the `StructuredOutputTool`.
 *
 * Covers: schema-valid values are accepted and recorded on the tool's state,
 * invalid values are rejected with an error (so the model can retry), the
 * retry cap fails closed, a malformed schema fails closed
 * instead of throwing, and the advertised parameter shape is an object with a
 * single required `result` property.
 */

import { describe, expect, it } from 'vitest';

import type {
  ExecutableToolContext,
  ExecutableToolResult,
  ToolExecution,
} from '#/tool/toolContract';

import {
  StructuredOutputTool,
  createStructuredOutputState,
  STRUCTURED_OUTPUT_RETRY_CAP,
} from '#/agent/workflow/structured/structuredOutputTool';

const SCHEMA = {
  type: 'object',
  properties: {
    name: { type: 'string' },
    count: { type: 'integer', minimum: 0 },
  },
  required: ['name', 'count'],
  additionalProperties: false,
};

const CONTEXT = {} as ExecutableToolContext;

async function runExecution(execution: ToolExecution): Promise<ExecutableToolResult> {
  if (!('execute' in execution)) throw new Error('expected a runnable execution');
  return execution.execute(CONTEXT);
}

describe('StructuredOutputTool', () => {
  it('advertises an object parameter with a single required result', () => {
    const tool = new StructuredOutputTool(SCHEMA);
    expect(tool.name).toBe('StructuredOutput');
    expect(tool.parameters['type']).toBe('object');
    expect(tool.parameters['required']).toEqual(['result']);
    expect(tool.parameters['properties']).toMatchObject({ result: SCHEMA });
  });

  it('accepts a valid value and records it on the shared state', async () => {
    const state = createStructuredOutputState();
    const tool = new StructuredOutputTool(SCHEMA, state);
    const result = await runExecution(tool.resolveExecution({ result: { name: 'ok', count: 3 } }));

    expect(result.isError).toBeUndefined();
    expect(tool.validated).toBe(true);
    expect(tool.value).toEqual({ name: 'ok', count: 3 });
    expect(state.validated).toBe(true);
  });

  it('rejects an invalid value with an error and does not mark validated', async () => {
    const tool = new StructuredOutputTool(SCHEMA);
    const result = await runExecution(tool.resolveExecution({ result: { name: 'ok', count: -1 } }));

    expect(result.isError).toBe(true);
    expect(String(result.output)).toContain('failed schema validation');
    expect(tool.validated).toBe(false);
    expect(tool.value).toBeUndefined();
  });

  it('reports a terminal structured-output failure after the retry cap', async () => {
    const tool = new StructuredOutputTool(SCHEMA, createStructuredOutputState(), 2);
    let last = '';
    for (let attempt = 0; attempt < 3; attempt++) {
      const result = await runExecution(
        tool.resolveExecution({ result: { name: 'bad', count: -1 } }),
      );
      last = String(result.output);
    }
    expect(last).toContain('structured-output run will fail');
    expect(tool.validated).toBe(false);
  });

  it('is idempotent after a successful call', async () => {
    const tool = new StructuredOutputTool(SCHEMA);
    await runExecution(tool.resolveExecution({ result: { name: 'ok', count: 1 } }));
    const second = await runExecution(
      tool.resolveExecution({ result: { name: 'other', count: 2 } }),
    );
    expect(second.isError).toBeUndefined();
    expect(tool.value).toEqual({ name: 'ok', count: 1 });
  });

  it('exposes the default retry cap constant', () => {
    expect(STRUCTURED_OUTPUT_RETRY_CAP).toBe(5);
  });

  it('fails closed when the schema itself is invalid', async () => {
    const tool = new StructuredOutputTool({ type: 'not-a-real-json-type' });
    const result = await runExecution(tool.resolveExecution({ result: { anything: true } }));
    expect(result.isError).toBe(true);
    expect(String(result.output)).toContain('cannot be validated');
    expect(tool.validated).toBe(false);
  });
});
