// bench/search-live.ts
//
// Per-request cost of the LIVE (in-memory transcript) search route and the
// full-index sync build cost of the search core. Fixed synthetic scale, wall
// time only (human readable) — enough to compare before/after of the live
// route memoization and the index-core COW counter fix, because the db I/O
// is identical across both runs.
//
// Run:  pnpm bench:search-live            (from packages/kap-server)
//       node --import tsx bench/search-live.ts
//
// Scenarios:
//   1. live-search ×50 — a live session of 100 turns × 20 messages, the same
//      query searched 50 times (what the UI does while typing); reports the
//      warm-up (first) search and the 50-search total.
//   2. index-build-10k — a 10k-turn wire file synced into a fresh search
//      index (turn/step counter replay + doc projection + minidb writes).
//   3. index-append-1 — one appended turn re-synced on top (incremental
//      resume path with persisted counter states).

import { mkdtemp, mkdir, rm, appendFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';

import type {
  IBootstrapService,
  IFlagService,
  ILogService,
  ISessionIndex,
  SessionSummary,
} from '@moonshot-ai/agent-core-v2';
import { TranscriptStore, type TranscriptOperation } from '@moonshot-ai/transcript';

import { SearchIndexCore, type SyncSessionInput } from '../src/search/indexCore';
import {
  GlobalSearchService,
  SEARCH_WORKER_FLAG_ID,
  type LiveTranscriptSource,
} from '../src/search/searchService';

// ---------------------------------------------------------------------------
// knobs (fixed scale)
// ---------------------------------------------------------------------------

const TURNS = 100;
const FRAMES_PER_TURN = 19; // + 1 user prompt = 20 messages per turn
const LIVE_SEARCHES = 50;
const INDEX_TURNS = 10_000;
const QUERY = 'walrus'; // planted in every message → every doc matches
const SESSION_ID = 's_bench';
const WS = 'ws_bench';
const T0 = 1_700_000_000_000;

const fmt = (n: number) => n.toLocaleString('en-US', { maximumFractionDigits: 1 });
const ms = (n: number) => `${fmt(n)} ms`;
const msPerOp = (n: number, ops: number) => `${fmt(n / ops)} ms/op`;

// ---------------------------------------------------------------------------
// fixed-seed synthetic data
// ---------------------------------------------------------------------------

/** mulberry32: tiny deterministic PRNG so every bench run sees the same data. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const LATIN_VOCAB =
  'walrus query index cache token frame step turn session store text prompt reply review merge flush'.split(
    ' ',
  );
const CJK_VOCAB = ['持久化', '快照', '索引', '恢复', '压缩', '查询', '缓存', '日志', '苹果', '香蕉'];

/** Live transcript store: `TURNS` turns × `FRAMES_PER_TURN` assistant frames. */
function makeLiveStore(seed: number): TranscriptStore {
  const store = new TranscriptStore(SESSION_ID);
  store.ensureAgent('main', { agentId: 'main', type: 'main' });
  const agent = store.getAgent('main')!;
  const rng = mulberry32(seed);
  const pick = (arr: string[]) => arr[(rng() * arr.length) | 0]!;
  const ops: TranscriptOperation[] = [];
  for (let t = 0; t < TURNS; t++) {
    const startedAt = T0 + t * 1000;
    const turnId = `t${t}`;
    ops.push({
      op: 'turn.upsert',
      turn: {
        kind: 'turn',
        turnId,
        ordinal: t,
        state: 'completed',
        origin: { kind: 'user' },
        prompt: `第 ${t} 个问题 ${pick(LATIN_VOCAB)} ${pick(CJK_VOCAB)} walrus`,
        startedAt: new Date(startedAt).toISOString(),
      },
    });
    ops.push({
      op: 'step.upsert',
      turnId,
      step: {
        kind: 'step',
        stepId: `${turnId}.1`,
        turnId,
        ordinal: 1,
        state: 'completed',
        startedAt: new Date(startedAt + 1).toISOString(),
        endedAt: new Date(startedAt + 900).toISOString(),
      },
    });
    for (let f = 0; f < FRAMES_PER_TURN; f++) {
      ops.push({
        op: 'frame.upsert',
        turnId,
        stepId: `${turnId}.1`,
        frame: {
          kind: 'text',
          frameId: `${turnId}.1.f${f}`,
          role: 'assistant',
          text: `第 ${t} 个回答 ${f} ${pick(LATIN_VOCAB)} ${pick(CJK_VOCAB)} walrus`,
        },
      });
    }
  }
  agent.apply(ops);
  return store;
}

// ---------------------------------------------------------------------------
// wire-file lines (same shapes the test suite uses)
// ---------------------------------------------------------------------------

function userLine(text: string, time: number): string {
  return JSON.stringify({
    type: 'context.append_message',
    time,
    message: { role: 'user', content: [{ type: 'text', text }], origin: { kind: 'user' } },
  });
}

function stepBeginLine(uuid: string, step: number, time: number): string {
  return JSON.stringify({
    type: 'context.append_loop_event',
    time,
    event: { type: 'step.begin', uuid, turnId: '0', step },
  });
}

function assistantStepLine(text: string, stepUuid: string, time: number): string {
  return JSON.stringify({
    type: 'context.append_loop_event',
    time,
    event: { type: 'content.part', stepUuid, part: { type: 'text', text } },
  });
}

/** `count` turns, each with a user line + step.begin + assistant text line. */
function wireLines(count: number): string[] {
  const lines: string[] = [];
  for (let t = 0; t < count; t++) {
    const time = T0 + t * 1000;
    lines.push(userLine(`第 ${t} 个问题 walrus 苹果`, time));
    lines.push(stepBeginLine(`uuid-${t}`, 1, time + 1));
    lines.push(assistantStepLine(`第 ${t} 个回答 walrus 香蕉 ${t}`, `uuid-${t}`, time + 2));
  }
  return lines;
}

// ---------------------------------------------------------------------------
// stubs
// ---------------------------------------------------------------------------

const noopLog = {
  error: () => {},
  warn: () => {},
  info: () => {},
  debug: () => {},
} as unknown as ILogService;

const coreLog = { info: () => {}, warn: () => {} };

function makeBootstrap(home: string): IBootstrapService {
  return { homeDir: home, scope: (name: string) => name } as unknown as IBootstrapService;
}

function makeFlags(workerEnabled: boolean): IFlagService {
  return {
    enabled: (id: string) => id === SEARCH_WORKER_FLAG_ID && workerEnabled,
  } as unknown as IFlagService;
}

function makeSessionIndex(summary: SessionSummary | undefined): ISessionIndex {
  return {
    _serviceBrand: undefined,
    prepare: async () => ({ state: 'uninitialized', degradedCount: 0 }),
    status: () => ({ state: 'uninitialized', degradedCount: 0 }),
    listRecent: async () => ({ items: [], nextCursor: undefined }),
    get: async (id: string) => (id === SESSION_ID ? summary : undefined),
    count: async () => (summary === undefined ? 0 : 1),
    remove: async () => {},
  } as unknown as ISessionIndex;
}

// ---------------------------------------------------------------------------
// scenario 1: live search ×50
// ---------------------------------------------------------------------------

async function benchLiveSearch(): Promise<void> {
  const summary: SessionSummary = {
    id: SESSION_ID,
    workspaceId: WS,
    title: '基准会话标题',
    createdAt: T0,
    updatedAt: T0,
    archived: false,
  };
  const home = await mkdtemp(join(tmpdir(), 'kap-search-live-'));
  const service = new GlobalSearchService(
    makeSessionIndex(summary),
    makeBootstrap(home),
    noopLog,
    makeFlags(false), // inline host: the live route never touches the backend
  );
  service.syncDebounceMs = 0;
  const stores = new Map([[SESSION_ID, makeLiveStore(42)]]);
  const liveSource: LiveTranscriptSource = {
    forSessionLive: (sessionId) => stores.get(sessionId),
    whenReady: async () => {},
    ensureAgentHistory: async () => {},
  };
  service.setLiveTranscriptSource(liveSource);

  const query = { query: QUERY, mode: 'terms' as const, container: { sessionId: SESSION_ID } };

  const t0 = performance.now();
  await service.search(query); // warm-up (fills the memo caches)
  const warmUpMs = performance.now() - t0;

  let hits = 0;
  const t1 = performance.now();
  for (let i = 0; i < LIVE_SEARCHES; i++) {
    const page = await service.search(query);
    hits = page.items.length;
  }
  const totalMs = performance.now() - t1;
  await service.dispose();
  await rm(home, { recursive: true, force: true });

  console.log(`[live-search ×${LIVE_SEARCHES}]`);
  console.log(`  session: ${TURNS} turns × ${FRAMES_PER_TURN + 1} messages, query '${QUERY}'`);
  console.log(`  warm-up search (memo fill): ${ms(warmUpMs)}`);
  console.log(`  ${LIVE_SEARCHES} searches total:          ${ms(totalMs)}  (${msPerOp(totalMs, LIVE_SEARCHES)}, ${hits} hits/page)`);
}

// ---------------------------------------------------------------------------
// scenario 2+3: index build 10k turns, then a 1-turn append
// ---------------------------------------------------------------------------

async function benchIndexBuild(): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), 'kap-search-index-'));
  const agentsDir = join(dir, 'agents', 'main');
  await mkdir(agentsDir, { recursive: true });
  const wirePath = join(agentsDir, 'wire.jsonl');
  await writeFile(wirePath, wireLines(INDEX_TURNS).map((l) => `${l}\n`).join(''), 'utf8');

  const input: SyncSessionInput = {
    id: SESSION_ID,
    workspaceId: WS,
    title: '基准索引',
    updatedAt: T0 + INDEX_TURNS * 1000,
    dir,
  };
  const core = new SearchIndexCore({
    indexDir: join(dir, 'index'),
    log: coreLog,
    bootSalt: 'bench',
  });

  const t0 = performance.now();
  const outcome = await core.sync([input]);
  const buildMs = performance.now() - t0;

  await appendFile(wirePath, `${wireLines(1).map((l) => `${l}\n`).join('')}`, 'utf8');
  const t1 = performance.now();
  await core.sync([input]);
  const appendMs = performance.now() - t1;

  await core.close();
  await rm(dir, { recursive: true, force: true });

  console.log(`[index-build ${INDEX_TURNS.toLocaleString()} turns]`);
  console.log(`  full sync:   ${ms(buildMs)}  (${outcome.sessions} session, ${outcome.documents} docs)`);
  console.log(`  1-turn append: ${ms(appendMs)}`);
}

// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  console.log('kap-server search bench (search-live.ts)\n');
  await benchLiveSearch();
  console.log('');
  await benchIndexBuild();
}

await main();
