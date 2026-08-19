// bench/write-search-hot.ts
//
// Micro-benchmarks for the hot-loop fixes (perf analysis Top 9):
//   1) same-key overwrite writes: applyOp() decoded the previous value even
//      when no secondary index is registered (write-path.ts)
//   2) hot-term search over a 10k-doc text index: readBaseBounded rebuilt a
//      full Map from the cached postings array and livePostingsBounded copied
//      it into a second Map (text-index/index.ts)
//   3) TF-IDF scoring: scoreTermMaps repeated termMaps.get(t) + this.idf()
//      per (candidate × query term) though both are constant per term
//
// Fixed sizes by default (N=2000 overwrites, 10k docs, 100 searches); pass
// --quick for a smoke-sized run. Output is human-readable plus machine JSON
// (--json <path> or BENCH_JSON), same schema conventions as bench.ts.
//
// Run:  pnpm bench:hot
//       node --import tsx bench/write-search-hot.ts --quick
//       node --import tsx bench/write-search-hot.ts --json .tmp/hot.json

import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { MiniDb } from '../src/index.js';

const fmt = (n) => n.toLocaleString('en-US', { maximumFractionDigits: 0 });
const ops = (n, ms) => `${fmt((n / ms) * 1000)} ops/s`;

async function tmpDir() {
  return fs.mkdtemp(path.join(os.tmpdir(), 'minidb-hot-'));
}

// ---- fixed-seed synthetic data (same PRNG + corpus as bench.ts) ---------------

/** mulberry32: tiny deterministic PRNG so every run sees the same data. */
function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const LATIN_VOCAB =
  'wal sync snapshot compaction recovery index query cache buffer frame codec store delta merge rotate flush token parse schema server client socket thread worker queue stream ledger journal cursor segment batch commit'.split(
    ' ',
  );
const CJK_VOCAB = ['持久化', '快照', '索引', '恢复', '压缩', '查询', '缓存', '日志', '事务', '复制'];
// Needles planted at deterministic intervals so query hit counts are stable.
const NEEDLES = [
  { term: 'walrus', every: 97 },
  { term: '持久化', every: 131 },
  { term: 'checkpoint', every: 257 },
];

/** Deterministic pseudo-message corpus: `count` docs of ~25 words each. */
function makeMessages(count, seed) {
  const rng = mulberry32(seed);
  const pick = (arr) => arr[(rng() * arr.length) | 0];
  const docs = [];
  for (let i = 0; i < count; i++) {
    const words = [];
    const n = 20 + ((rng() * 15) | 0);
    for (let w = 0; w < n; w++) words.push(rng() < 0.15 ? pick(CJK_VOCAB) : pick(LATIN_VOCAB));
    for (const { term, every } of NEEDLES) if (i % every === 0) words.push(term);
    docs.push({ key: `m${i}`, body: words.join(' '), ts: 1_700_000_000_000 + i * 1000 });
  }
  return docs;
}

// ---- measurement machinery ----------------------------------------------------

const results = [];

/** Run one scenario: time it and record a stable-shaped JSON row. */
async function scenario(name, fn, { ops: opCount } = {}) {
  if (global.gc) global.gc();
  const t0 = performance.now();
  const out = (await fn()) || {};
  const durationMs = performance.now() - t0;
  const row = {
    name,
    durationMs: Math.round(durationMs * 1000) / 1000,
    ops: opCount,
    opsPerSec: opCount ? Math.round((opCount / durationMs) * 1000) : undefined,
    ...out,
  };
  results.push(row);
  const tail = opCount ? `   -> ${ops(opCount, durationMs)}` : '';
  console.log(`  ${name.padEnd(60)} ${durationMs.toFixed(1).padStart(9)} ms${tail}`);
  return row;
}

// ---- scenarios ----------------------------------------------------------------

async function overwriteScenario({ N }) {
  const dir = await tmpDir();
  const db = await MiniDb.open({ dir, valueCodec: 'json', fsyncPolicy: 'no', autoCompact: false });
  await db.set('hot', { i: -1, body: '' }); // first write: create, not overwrite
  await scenario(`overwrite same key N=${fmt(N)} (json codec, no secondary index)`, async () => {
    for (let i = 0; i < N; i++) await db.set('hot', { i, body: 'x'.repeat(100) });
  }, { ops: N });
  await db.close();
  await fs.rm(dir, { recursive: true, force: true });
}

async function searchScenario({ docs, searches, seed }) {
  const dir = await tmpDir();
  const messages = makeMessages(docs, seed);
  const db = await MiniDb.open({ dir, valueCodec: 'json', fsyncPolicy: 'no', autoCompact: false });
  const CHUNK = 2000;
  for (let base = 0; base < messages.length; base += CHUNK) {
    await db.batch(messages.slice(base, base + CHUNK).map((d) => ({ op: 'set', key: d.key, value: d })));
  }
  await db.createTextIndex('word', { fields: ['body'] });

  // 'wal' is a high-df corpus word (~50% of docs): the hot-term path exercises
  // the cached-postings decode + tombstone filter + merge on a long list.
  await scenario(`hot-term search 'wal' over ${fmt(docs)} docs x ${fmt(searches)} runs`, async () => {
    let hits = 0;
    for (let r = 0; r < searches; r++) hits += db.search('word', 'wal', { limit: 10 }).length;
    return { extra: { hits } };
  }, { ops: searches });

  await db.close();
  await fs.rm(dir, { recursive: true, force: true });
}

/** Direct hit on the scoreTermMaps inner loop: 3 query terms x 10k candidates,
 *  every candidate scoring against all three terms. The index instance and its
 *  per-doc tables are filled so the loop runs the real workload. */
async function scoringScenario({ docs }) {
  const dir = await tmpDir();
  const db = await MiniDb.open({ dir, valueCodec: 'json', fsyncPolicy: 'no', autoCompact: false });
  await db.createTextIndex('word', { fields: ['body'] });
  // No public accessor for TextIndex instances; reach into the package-internal
  // registry view (a plain runtime property, so `as any` is enough).
  const ti = (db as any).textRegistry.text.get('word') as any;
  const termMaps = new Map();
  for (const t of ['alpha', 'beta', 'gamma']) {
    const m = new Map();
    for (let id = 0; id < docs; id++) m.set(id, 1 + (id % 5));
    termMaps.set(t, m);
  }
  for (let id = 0; id < docs; id++) ti.docLen.set(id, 25);
  for (let id = 0; id < docs; id++) ti.keys[id] = `k${id}`;
  const qtokens = ['alpha', 'beta', 'gamma'];
  await scenario(`scoreTermMaps 3 terms x ${fmt(docs)} candidates x 100 runs`, async () => {
    for (let r = 0; r < 100; r++) {
      ti.scoreTermMaps(qtokens, termMaps, 'AND', 10, 0, false);
    }
  }, { ops: 100 * docs * qtokens.length });
  await db.close();
  await fs.rm(dir, { recursive: true, force: true });
}

async function main() {
  const argv = process.argv.slice(2);
  const jsonIdx = argv.indexOf('--json');
  const jsonPath = jsonIdx !== -1 ? argv[jsonIdx + 1] : process.env.BENCH_JSON;
  const quick = argv.includes('--quick') || process.env.BENCH_QUICK === '1';

  const SEED = Number(process.env.BENCH_SEED || 42);
  const N = quick ? 500 : Number(process.env.N || 2000);
  const DOCS = quick ? 2000 : Number(process.env.BENCH_DOCS || 10_000);
  const SEARCHES = quick ? 20 : Number(process.env.BENCH_SEARCHES || 100);

  console.log(
    `\nminidb hot-loop benchmark  (overwrites=${fmt(N)}, docs=${fmt(DOCS)}, searches=${fmt(SEARCHES)}, seed=${SEED}${quick ? ', QUICK' : ''}, node ${process.version})\n`,
  );

  await overwriteScenario({ N });
  await searchScenario({ docs: DOCS, searches: SEARCHES, seed: SEED });
  await scoringScenario({ docs: DOCS });

  const report = {
    schemaVersion: 1,
    tool: 'minidb/bench-hot',
    quick,
    startedAt: new Date().toISOString(),
    node: process.version,
    platform: process.platform,
    arch: process.arch,
    seed: SEED,
    scenarios: results,
  };
  const json = JSON.stringify(report, null, 2);
  if (jsonPath) {
    await fs.mkdir(path.dirname(path.resolve(jsonPath)), { recursive: true });
    await fs.writeFile(jsonPath, json + '\n', 'utf8');
    console.log(`\nJSON report written to ${jsonPath}`);
  } else {
    console.log('\n--- bench JSON ---');
    console.log(json);
  }
  console.log('\ndone.\n');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
