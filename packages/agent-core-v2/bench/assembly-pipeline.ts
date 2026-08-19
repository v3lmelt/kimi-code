// bench/assembly-pipeline.ts
//
// LLM request-assembly pipeline benchmark — the per-request hot path of
// `llmRequesterService` plus the Anthropic history conversion
// (`kosong/provider/bases/anthropic`).
//
// Scenario 1: a 60-round session × REPS. Every rep runs the assembly a request
// would do before hitting the wire: `defaultTools()` (registry list + shaping),
// the tools-signature hash used by `logRequest` / `recordRequest`, and the full
// Anthropic history conversion (30 messages / 50 tools) through the real
// `AnthropicChatProvider` against a stub SDK client. The `logInput` carries the
// precomputed signature fields exactly like the fixed `run()` does; the
// unfixed code ignores them and recomputes, the fixed code reuses them.
//
// Scenario 2: history-conversion growth — 60 rounds, each appending assistant
// tool_use + user tool_result messages. Compares one provider instance reused
// across rounds (incremental conversion after the fix; full re-conversion
// before it) against a fresh provider per round (always full re-conversion).
//
// Run:  pnpm bench:assembly-pipeline
//       node --import tsx bench/assembly-pipeline.ts
// Knobs (env): ROUNDS (scenario rounds, default 60), REPS (scenario-1 reps per
// round, default 100).

import { performance } from 'node:perf_hooks';

import { AnthropicChatProvider } from '../src/kosong/provider/bases/anthropic/anthropic';
import {
  AgentLLMRequesterService,
  providerVisibleTools,
  toolSignature,
} from '../src/agent/llmRequester/llmRequesterService';
import { AgentToolRegistryService } from '../src/agent/toolRegistry/toolRegistryService';
import type { Tool } from '../src/kosong/contract/tool';
import type { Message } from '../src/kosong/contract/message';
import type { ExecutableTool } from '../src/tool/toolContract';

const ROUNDS = Number(process.env.ROUNDS ?? 60);
const REPS = Number(process.env.REPS ?? 100);
const TOOL_COUNT = 50;
const fmt = (n: number) => n.toLocaleString('en-US', { maximumFractionDigits: 1 });
const fmtMs = (n: number) => `${fmt(n)} ms`;
const ms = (start: number) => (performance.now() - start);

// ---- fixtures ---------------------------------------------------------------

function makeTool(index: number): ExecutableTool {
  return {
    name: `tool_${index}`,
    description: `Tool ${index} performs a small, well-scoped operation for the agent.`,
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'The search query to run.' },
        limit: { type: 'number', description: 'Maximum number of results to return.' },
        options: {
          type: 'object',
          properties: { verbose: { type: 'boolean' }, format: { type: 'string' } },
        },
      },
      required: ['query'],
    },
  } as unknown as ExecutableTool;
}

const TOOLS: Tool[] = Array.from({ length: TOOL_COUNT }, (_, i) => ({
  name: `tool_${i}`,
  description: `Tool ${i} performs a small, well-scoped operation for the agent.`,
  parameters: makeTool(i).parameters,
}));

function makeUserMessage(text: string): Message {
  return { role: 'user', content: [{ type: 'text', text }], toolCalls: [] };
}

function makeAssistantToolUse(turn: number): Message {
  return {
    role: 'assistant',
    content: [{ type: 'text', text: `Assistant reasoning for turn ${turn}.` }],
    toolCalls: [
      {
        type: 'function',
        id: `toolu_${turn}_1`,
        name: `tool_${turn % TOOL_COUNT}`,
        arguments: JSON.stringify({
          query: `query for turn ${turn}`,
          limit: turn,
          options: { verbose: true, format: 'json' },
        }),
      },
      {
        type: 'function',
        id: `toolu_${turn}_2`,
        name: `tool_${(turn + 1) % TOOL_COUNT}`,
        arguments: JSON.stringify({ query: 'second call', limit: 5 }),
      },
    ],
  };
}

function makeToolResult(turn: number): Message {
  return {
    role: 'tool',
    toolCallId: `toolu_${turn}_1`,
    content: [
      {
        type: 'text',
        text: `Result payload for turn ${turn}: ${'x'.repeat(2048)}`,
      },
    ],
    toolCalls: [],
  };
}

/** A 30-message conversation: user prompt + tool round-trips. */
function buildHistory(messageCount: number): Message[] {
  const history: Message[] = [makeUserMessage('Let us begin the session.')];
  let turn = 0;
  while (history.length < messageCount) {
    history.push(makeAssistantToolUse(turn));
    if (history.length >= messageCount) break;
    history.push(makeToolResult(turn));
    turn += 1;
  }
  return history;
}

// ---- scenario 1: full per-request assembly -------------------------------

function buildRequester(registry: AgentToolRegistryService) {
  const map = new Map<unknown, unknown>();
  const states = {
    register: () => undefined,
    get: (key: unknown) => map.get(key),
    set: (key: unknown, value: unknown) => {
      map.set(key, value);
    },
  };
  const activeNames = new Set(TOOLS.map((tool) => tool.name));
  const toolSelect = {
    enabled: () => false,
    shapeTools: (entries: readonly { name: string }[]) =>
      entries.filter((entry) => activeNames.has(entry.name)),
  };
  const wire = {
    getModel: () => ({ seenToolsHashes: [] as string[] }),
    dispatch: () => undefined,
  };
  const noop = () => undefined;
  const service = new AgentLLMRequesterService(
    { get: () => [] } as never,
    {} as never,
    {} as never,
    registry as never,
    toolSelect as never,
    {} as never,
    { data: () => ({ modelAlias: undefined, systemPrompt: 'system' }) } as never,
    {} as never,
    { get: () => undefined } as never,
    {} as never,
    {} as never,
    { info: noop, warn: noop, error: noop } as never,
    {} as never,
    wire as never,
    {} as never,
    states as never,
    undefined as never,
    { disabledTools: () => [], onDidChange: () => noop } as never,
    { disabledTools: [], onDidChange: () => noop } as never,
  );
  return service as unknown as {
    defaultTools(): readonly Tool[];
    logRequest(input: Record<string, unknown>): void;
    recordRequest(input: Record<string, unknown>): void;
  };
}

function scenario1(): void {
  const registry = new AgentToolRegistryService();
  for (let i = 0; i < TOOL_COUNT; i += 1) {
    registry.register(makeTool(i), { source: 'builtin' });
  }
  const requester = buildRequester(registry);
  const provider = new AnthropicChatProvider({
    model: 'probe-model',
    stream: false,
    clientFactory: () =>
      ({
        messages: {
          create: async () => ({
            id: 'msg_probe',
            type: 'message',
            role: 'assistant',
            model: 'probe-model',
            content: [{ type: 'text', text: 'Hello' }],
            stop_reason: 'end_turn',
            usage: { input_tokens: 3, output_tokens: 1 },
          }),
        },
        beta: {
          messages: {
            create: async () => ({
              id: 'msg_probe',
              type: 'message',
              role: 'assistant',
              model: 'probe-model',
              content: [{ type: 'text', text: 'Hello' }],
              stop_reason: 'end_turn',
              usage: { input_tokens: 3, output_tokens: 1 },
            }),
          },
        },
      }) as never,
  });
  const history = buildHistory(30);
  const systemPrompt = 'You are a helpful assistant. '.repeat(20);

  let total = 0;
  for (let round = 0; round < ROUNDS; round += 1) {
    for (let rep = 0; rep < REPS; rep += 1) {
      const start = performance.now();
      const tools = requester.defaultTools();
      const wireTools = providerVisibleTools(tools);
      const signature = toolSignature(wireTools);
      const toolsHash = JSON.stringify(signature);
      // exactly what `run()` passes to `logRequest` / `recordRequest`
      const logInput = {
        protocol: 'anthropic',
        modelName: 'probe-model',
        systemPrompt,
        tools,
        messages: history,
        fields: {},
        wireTools,
        toolSignature: signature,
        toolsHash,
      };
      requester.logRequest(logInput);
      requester.recordRequest(logInput);
      void provider.generate(systemPrompt, [...tools], history);
      total += ms(start);
    }
  }
  console.log(`  total (${ROUNDS} rounds x ${REPS} reps): ${fmtMs(total)}`);
  console.log(`  per rep: ${fmtMs(total / (ROUNDS * REPS))}`);
}

// ---- scenario 2: history conversion growth --------------------------------

function makeAnthropicProvider(): AnthropicChatProvider {
  return new AnthropicChatProvider({
    model: 'probe-model',
    stream: false,
    clientFactory: () =>
      ({
        messages: {
          create: async () => ({
            id: 'msg_probe',
            type: 'message',
            role: 'assistant',
            model: 'probe-model',
            content: [{ type: 'text', text: 'Hello' }],
            stop_reason: 'end_turn',
            usage: { input_tokens: 3, output_tokens: 1 },
          }),
        },
        beta: {
          messages: {
            create: async () => ({
              id: 'msg_probe',
              type: 'message',
              role: 'assistant',
              model: 'probe-model',
              content: [{ type: 'text', text: 'Hello' }],
              stop_reason: 'end_turn',
              usage: { input_tokens: 3, output_tokens: 1 },
            }),
          },
        },
      }) as never,
  });
}

async function scenario2(): Promise<void> {
  // (a) one provider instance reused across rounds — the history array is
  // kept and appended in place, exactly like a session context (incremental
  // conversion after the fix; full re-conversion before it).
  const reused = makeAnthropicProvider();
  const reusedHistory: Message[] = [makeUserMessage('Let us begin the session.')];
  const reusedStart = performance.now();
  for (let round = 0; round < ROUNDS; round += 1) {
    reusedHistory.push(makeAssistantToolUse(round));
    reusedHistory.push(makeToolResult(round));
    void reused.generate('system', [], reusedHistory);
  }
  const reusedMs = ms(reusedStart);

  // (b) a fresh provider per round with the same append-only history — always
  // full re-conversion, the pre-fix behavior.
  const freshHistory: Message[] = [makeUserMessage('Let us begin the session.')];
  const freshStart = performance.now();
  for (let round = 0; round < ROUNDS; round += 1) {
    freshHistory.push(makeAssistantToolUse(round));
    freshHistory.push(makeToolResult(round));
    void makeAnthropicProvider().generate('system', [], freshHistory);
  }
  const freshMs = ms(freshStart);

  console.log(`  reused instance (${ROUNDS} rounds, appended history): ${fmtMs(reusedMs)}`);
  console.log(`  fresh provider per round (always full): ${fmtMs(freshMs)}`);
  console.log(`  speedup: ${fmt(freshMs / Math.max(reusedMs, 0.001))}x`);
}

// ---- main ------------------------------------------------------------------

console.log(`assembly-pipeline bench (ROUNDS=${ROUNDS}, REPS=${REPS})`);
console.log(`tools: ${TOOL_COUNT}, history: 30 messages`);
console.log('');
console.log('scenario 1 — full per-request assembly (defaultTools + tools hash + history conversion):');
scenario1();
console.log('');
console.log('scenario 2 — history conversion growth (cumulative):');
await scenario2();
