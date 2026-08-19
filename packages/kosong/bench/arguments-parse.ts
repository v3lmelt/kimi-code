// bench/arguments-parse.ts
//
// Hot-path micro-benchmark for the tool-call arguments parse cache:
// a 30-turn session (2 tool calls per assistant turn) is converted in full
// 100 times, comparing the pre-cache inline JSON.parse path against
// parseToolCallArguments (bounded cache, byte-stable strings hit on every
// turn after the first).
//
// Run:  pnpm bench:arguments-parse    (in packages/kosong)
// Knobs (env): TURNS, CALLS_PER_TURN, ROUNDS.

import { parseToolCallArguments } from '../src/providers/tool-arguments';
import type { Message, ToolCall } from '../src/message';

const fmt = (n: number): string => n.toLocaleString('en-US', { maximumFractionDigits: 0 });
const opsPerSec = (n: number, ms: number): string => `${fmt((n / ms) * 1000)} ops/s`;

// ---- fixed synthetic data --------------------------------------------------

/** Deterministic 30-turn session: each assistant turn carries 2 tool calls
 *  with realistic nested argument JSON; each is answered by a tool result. */
function makeHistory(turns: number, callsPerTurn: number): Message[] {
  const history: Message[] = [{ role: 'user', content: [{ type: 'text', text: 'start' }] }];
  for (let t = 0; t < turns; t++) {
    const toolCalls: ToolCall[] = [];
    for (let c = 0; c < callsPerTurn; c++) {
      toolCalls.push({
        type: 'function',
        id: `call_${t}_${c}`,
        name: c % 2 === 0 ? 'search_files' : 'read_file',
        arguments: JSON.stringify({
          query: `pattern-${t}`,
          limit: 10,
          filters: { include: ['src'], exclude: ['node_modules'], depth: t % 3 },
          tags: ['bench', `t${t}`],
        }),
      });
    }
    history.push({ role: 'assistant', content: [{ type: 'text', text: `analysis ${t}` }], toolCalls });
    for (const tc of toolCalls) {
      history.push({
        role: 'tool',
        toolCallId: tc.id,
        content: [{ type: 'text', text: `result for ${tc.id}` }],
      });
    }
  }
  return history;
}

// ---- measurement machinery --------------------------------------------------

async function scenario(
  name: string,
  fn: () => number,
  { rounds }: { rounds: number },
): Promise<number> {
  if (global.gc) global.gc();
  const t0 = performance.now();
  const ops = fn();
  const durationMs = performance.now() - t0;
  console.log(
    `  ${name.padEnd(52)} ${durationMs.toFixed(1).padStart(9)} ms` +
      `   (${fmt(ops)} ops, ${opsPerSec(ops, durationMs)})`,
  );
  return durationMs;
}

// ---- scenarios ------------------------------------------------------------------

/** Pre-cache semantics: inline JSON.parse + shape check per tool call. */
function parseInline(argumentsJson: string): Record<string, unknown> {
  const parsed: unknown = JSON.parse(argumentsJson);
  if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
    return parsed as Record<string, unknown>;
  }
  throw new Error('Tool call arguments must be a JSON object.');
}

function collectToolArguments(history: Message[]): string[] {
  const out: string[] = [];
  for (const message of history) {
    for (const tc of message.toolCalls ?? []) {
      if (tc.arguments) out.push(tc.arguments);
    }
  }
  return out;
}

async function main(): Promise<void> {
  const turns = Number(process.env.TURNS || 30);
  const callsPerTurn = Number(process.env.CALLS_PER_TURN || 2);
  const rounds = Number(process.env.ROUNDS || 100);

  console.log(
    `\nkosong tool-arguments parse benchmark  (turns=${turns}, calls/turn=${callsPerTurn}, rounds=${rounds}, node ${process.version})\n`,
  );

  const history = makeHistory(turns, callsPerTurn);
  const argsList = collectToolArguments(history);
  const totalCalls = argsList.length * rounds;
  console.log(`  history: ${history.length} messages, ${argsList.length} tool-call argument strings\n`);

  // Correctness sanity: both paths yield equal objects.
  for (const json of argsList) {
    if (JSON.stringify(parseInline(json)) !== JSON.stringify(parseToolCallArguments(json))) {
      throw new Error('parseInline and parseToolCallArguments disagree');
    }
  }

  // Warm the cache once (first full-history pass populates it).
  for (const json of argsList) parseToolCallArguments(json);

  const inlineMs = await scenario(
    `inline JSON.parse x ${fmt(totalCalls)} (${fmt(argsList.length)} strings x ${rounds})`,
    () => {
      let sink = 0;
      for (let r = 0; r < rounds; r++) {
        for (const json of argsList) {
          sink += Object.keys(parseInline(json)).length;
        }
      }
      return sink;
    },
    { rounds },
  );

  const cachedMs = await scenario(
    `parseToolCallArguments (cache hit) x ${fmt(totalCalls)} (${fmt(argsList.length)} strings x ${rounds})`,
    () => {
      let sink = 0;
      for (let r = 0; r < rounds; r++) {
        for (const json of argsList) {
          sink += Object.keys(parseToolCallArguments(json)).length;
        }
      }
      return sink;
    },
    { rounds },
  );

  console.log(`\n  speedup: ${(inlineMs / cachedMs).toFixed(2)}x`);
  console.log('\ndone.\n');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
