// bench/tokens.ts
//
// Token-estimation benchmarks for `src/utils/tokens.ts`, on fixed-size
// synthetic data. Scenarios cover the two hot paths found by the repo-wide
// perf analysis:
//
//   1. `estimateTokens` over ~1M mixed chars (ASCII + CJK + emoji), 20 runs —
//      every LLM round-trip and compaction estimate rescans the full history.
//   2. `estimateTokensForTools` over 50 tool schemas, 1000 runs, two flavors:
//      - same schema objects every run  (stringify-cache friendly)
//      - fresh schema objects every run (forces a JSON.stringify each time)
//
// Run:  pnpm bench:tokens
//       node --import tsx bench/tokens.ts

import type { Tool } from '@moonshot-ai/kosong';

import { estimateTokens, estimateTokensForTools } from '../src/utils/tokens';

const fmt = (n: number) => n.toLocaleString('en-US', { maximumFractionDigits: 0 });
const ops = (n: number, ms: number) => `${fmt((n / ms) * 1000)} ops/s`;

/** Run `fn` `runs` times and print the human line; returns total ms. */
function scenario(name: string, fn: () => void, runs: number): number {
  fn(); // warmup
  const t0 = performance.now();
  for (let i = 0; i < runs; i++) fn();
  const ms = performance.now() - t0;
  console.log(`  ${name.padEnd(58)} ${ms.toFixed(1).padStart(9)} ms   (${fmt(runs)} runs -> ${ops(runs, ms)})`);
  return ms;
}

// ---- scenario 1: ~1M mixed chars -------------------------------------------
const SEGMENT = 'The quick brown fox 敏捷的棕色狐狸 😀🚀 jumps over the lazy dog 懒狗。';
const REPEAT = Math.max(1, Math.ceil(1_000_000 / SEGMENT.length));
const MIXED_TEXT = SEGMENT.repeat(REPEAT);

// ---- scenario 2: 50 tool schemas --------------------------------------------
function makeTool(i: number): Tool {
  return {
    name: `mcp__service__tool_${i}`,
    description: `Tool ${i} does something useful for the user with a fairly long description.`,
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: `search query parameter ${i}` },
        limit: { type: 'number', minimum: 1, maximum: 100, default: 20 },
        filters: {
          type: 'object',
          properties: { region: { type: 'string' }, owner: { type: 'string' } },
        },
      },
      required: ['query'],
    },
  };
}
const TOOLS = Array.from({ length: 50 }, (_, i) => makeTool(i));

// ---- main --------------------------------------------------------------------
let sink = 0;

console.log(`\ntokens benchmark (node ${process.version})`);
console.log(`  scenario 1: ${fmt(MIXED_TEXT.length)} chars, ${fmt(REPEAT)} segments, 20 runs`);
console.log(`  scenario 2: ${TOOLS.length} schemas, 1000 runs\n`);

scenario('estimateTokens ~1M mixed chars x20', () => {
  sink += estimateTokens(MIXED_TEXT);
}, 20);

scenario('estimateTokensForTools same 50 schemas x1000 (cache path)', () => {
  sink += estimateTokensForTools(TOOLS);
}, 1000);

scenario('estimateTokensForTools fresh 50 schemas x1000 (stringify path)', () => {
  const fresh = Array.from({ length: 50 }, (_, i) => makeTool(i));
  sink += estimateTokensForTools(fresh);
}, 1000);

console.log(`\ndone. (sink=${sink})\n`);
