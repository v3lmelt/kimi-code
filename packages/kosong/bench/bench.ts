// bench/bench.ts
//
// Hot-path micro-benchmarks for kosong:
//   1. deepCopyPart — the per-streamed-chunk copy the generate() loop makes
//      before handing each part to the onMessagePart callback.
//   2. normalizeKimiToolSchema — the per-request Kimi tool-schema
//      normalization (deref + type completion) over the tool list.
//
// Fixed sizes, deterministic synthetic data, human-readable output; pass
// `--json <path>` to also emit a machine-readable report (stable field names).
//
// Run:  pnpm bench                 (in packages/kosong)
//       node --import tsx bench/bench.ts --quick
// Knobs (env): PARTS, ROUNDS, TOOLS.

import fs from 'node:fs/promises';
import path from 'node:path';
import { deepCopyPart } from '../src/generate';
import { normalizeKimiToolSchema } from '../src/providers/kimi-schema';
import type { StreamedMessagePart } from '../src/message';

const fmt = (n: number): string => n.toLocaleString('en-US', { maximumFractionDigits: 0 });
const opsPerSec = (n: number, ms: number): string => `${fmt((n / ms) * 1000)} ops/s`;

// ---- fixed synthetic data --------------------------------------------------

/** Deterministic mixed-type part stream: ~10 types, text-heavy like a real
 *  completion stream. */
function makeParts(count: number): StreamedMessagePart[] {
  const parts: StreamedMessagePart[] = [];
  for (let i = 0; i < count; i++) {
    switch (i % 10) {
      case 0:
        parts.push({ type: 'text', text: `chunk ${i} `.repeat(8) });
        break;
      case 1:
        parts.push({ type: 'think', think: `reasoning ${i}` });
        break;
      case 2:
        parts.push({ type: 'tool_call_part', argumentsPart: `"arg${i}":` });
        break;
      case 3:
        parts.push({ type: 'function', id: `call_${i}`, name: 'tool_a', arguments: '{}' });
        break;
      case 4:
        parts.push({ type: 'image_url', imageUrl: { url: 'https://example.com/i.png', id: `img-${i}` } });
        break;
      case 5:
        parts.push({
          type: 'usage',
          usage: { inputOther: 1, output: 2, inputCacheRead: 3, inputCacheCreation: 4 },
        });
        break;
      case 6:
        parts.push({ type: 'text', text: 'plain' });
        break;
      case 7:
        parts.push({
          type: 'function',
          id: `call_${i}`,
          name: 'tool_b',
          arguments: null,
          extras: { meta: { provider: 'kimi' }, tags: ['a', 'b'] },
        });
        break;
      case 8:
        parts.push({ type: 'think', think: 't', encrypted: `sig-${i}` });
        break;
      default:
        parts.push({ type: 'tool_call_part', argumentsPart: 'x', index: i });
        break;
    }
  }
  return parts;
}

/** Deterministic tool list with nested property schemas (enum-only and typed). */
function makeToolSchemas(count: number): Record<string, unknown>[] {
  const schemas: Record<string, unknown>[] = [];
  for (let i = 0; i < count; i++) {
    schemas.push({
      type: 'object',
      description: `tool ${i}`,
      properties: {
        input: { type: 'string', description: `input ${i}` },
        mode: { enum: ['fast', 'slow', `mode${i}`] },
        filters: {
          type: 'object',
          properties: {
            tag: { enum: ['a', 'b', 'c'] },
            limit: { type: 'integer' },
          },
          required: ['tag'],
        },
      },
      required: ['input'],
    });
  }
  return schemas;
}

// ---- measurement machinery --------------------------------------------------

const results: { name: string; durationMs: number; ops: number }[] = [];

async function scenario(
  name: string,
  fn: () => number | Promise<number>,
  { rounds }: { rounds: number },
): Promise<void> {
  if (global.gc) global.gc();
  const t0 = performance.now();
  const ops = await fn();
  const durationMs = performance.now() - t0;
  const perOp = durationMs / rounds;
  results.push({ name, durationMs, ops });
  console.log(
    `  ${name.padEnd(52)} ${durationMs.toFixed(1).padStart(9)} ms` +
      `   (${fmt(ops)} ops, ${opsPerSec(ops, durationMs)}, ${perOp.toFixed(3)} ms/op)`,
  );
}

// ---- scenarios ------------------------------------------------------------------

async function deepCopyScenario(parts: StreamedMessagePart[], rounds: number): Promise<void> {
  // Warmup + correctness sanity (copies must be detached objects).
  const probe = deepCopyPart(parts[0]);
  if (probe === parts[0]) throw new Error('deepCopyPart returned the same object');

  await scenario(
    `deepCopyPart x ${fmt(parts.length * rounds)} (${fmt(parts.length)} parts x ${rounds})`,
    () => {
      let sink = 0;
      for (let r = 0; r < rounds; r++) {
        for (const part of parts) {
          const copy = deepCopyPart(part);
          sink += (copy as { text?: string }).text?.length ?? 1;
        }
      }
      return sink;
    },
    { rounds },
  );
}

async function toolSchemaScenario(schemas: Record<string, unknown>[], rounds: number): Promise<void> {
  // Warmup + correctness sanity (normalized schema gains inferred `type`).
  const probe = normalizeKimiToolSchema(schemas[0]);
  const modeProp = (probe['properties'] as Record<string, unknown>)['mode'] as Record<string, unknown>;
  if (modeProp['type'] !== 'string') throw new Error('normalizeKimiToolSchema did not infer types');

  await scenario(
    `normalizeKimiToolSchema x ${fmt(schemas.length * rounds)} (${schemas.length} tools x ${rounds})`,
    () => {
      let sink = 0;
      for (let r = 0; r < rounds; r++) {
        for (const schema of schemas) {
          sink += Object.keys(normalizeKimiToolSchema(schema)).length;
        }
      }
      return sink;
    },
    { rounds },
  );
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const jsonIdx = argv.indexOf('--json');
  const jsonPath = jsonIdx !== -1 ? argv[jsonIdx + 1] : process.env.BENCH_JSON;
  const quick = argv.includes('--quick') || process.env.BENCH_QUICK === '1';

  const parts = quick ? 2_000 : Number(process.env.PARTS || 10_000);
  const tools = quick ? 20 : Number(process.env.TOOLS || 50);
  const rounds = quick ? 10 : Number(process.env.ROUNDS || 50);

  console.log(
    `\nkosong hot-path benchmark  (parts=${fmt(parts)}, tools=${tools}, rounds=${rounds}${quick ? ', QUICK' : ''}, node ${process.version})\n`,
  );

  const partSet = makeParts(parts);
  const toolSet = makeToolSchemas(tools);
  await deepCopyScenario(partSet, rounds);
  await toolSchemaScenario(toolSet, rounds);

  if (jsonPath) {
    const report = {
      schemaVersion: 1,
      tool: 'kosong/bench',
      quick,
      startedAt: new Date().toISOString(),
      node: process.version,
      scenarios: results,
    };
    await fs.mkdir(path.dirname(path.resolve(jsonPath)), { recursive: true });
    await fs.writeFile(jsonPath, JSON.stringify(report, null, 2) + '\n', 'utf8');
    console.log(`\nJSON report written to ${jsonPath}`);
  }
  console.log('\ndone.\n');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
