// bench/apply.ts
//
// Streaming-apply benchmark for the transcript L2 reducer (`ops/apply.ts`),
// on fixed-seed synthetic data:
//   - scenario A: 5000 mixed ops (frame/step/turn upserts, backfill markers,
//     new turns appended like the live delta stream) applied one op at a time
//     over an initial 500-turn state — total wall time;
//   - scenario B: getTurn lookups over the 500-turn state (turn-index
//     micro-benchmark through the public store API).
//
// Run:  pnpm bench   (or: node --import tsx bench/apply.ts)

import { AgentTranscript } from '../src/index.js';
import type { StepHeader, TranscriptOperation, TurnHeader } from '../src/index.js';

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

const TURNS = 500;
const STREAM_OPS = 5000;
const LOOKUPS = 10000;
const ROUNDS = 5;

function turnHeader(i: number): TurnHeader {
  return {
    turnId: `t${i}`,
    ordinal: i,
    state: 'running',
    origin: { kind: 'user' },
    prompt: `prompt for turn ${i} (deterministic seed text)`,
  };
}

function stepHeader(turnId: string): StepHeader {
  return {
    stepId: `${turnId}.1`,
    turnId,
    ordinal: 1,
    state: 'running',
  };
}

/** Seed a store with `count` turns (one step each). */
function seedStore(count: number): AgentTranscript {
  const tx = new AgentTranscript('main');
  for (let i = 0; i < count; i += 1) {
    const header = turnHeader(i);
    tx.apply([{ op: 'turn.upsert', turn: header }, { op: 'step.upsert', turnId: header.turnId, step: stepHeader(header.turnId) }]);
  }
  return tx;
}

/**
 * Deterministic streaming op mix, mirroring the live delta shape:
 * text frames stream into the current step, step/turn headers terminalize,
 * new turns open at monotonically increasing ordinals, and backfill markers
 * land on anchored positions.
 */
function streamOps(seed: number): TranscriptOperation[] {
  const rng = mulberry32(seed);
  const ops: TranscriptOperation[] = [];
  let nextTurn = TURNS; // ordinals continue past the seeded state
  let nextOrdinal = 0;
  let frameSeq = 0;
  for (let i = 0; i < STREAM_OPS; i += 1) {
    const r = rng();
    const turnN = (rng() * TURNS) | 0; // target an existing seeded turn
    const turnId = `t${turnN}`;
    if (r < 0.6) {
      // frame.upsert: streamed text into the turn's step
      frameSeq += 1;
      ops.push({
        op: 'frame.upsert',
        turnId,
        stepId: `${turnId}.1`,
        frame: { kind: 'text', frameId: `f${frameSeq}`, role: 'assistant', text: `chunk ${frameSeq} of streamed output` },
      });
    } else if (r < 0.8) {
      // step.upsert: state transitions on the step
      ops.push({
        op: 'step.upsert',
        turnId,
        step: { ...stepHeader(turnId), state: 'completed', endedAt: `2026-08-14T08:${(i % 60).toString().padStart(2, '0')}:00.000Z` },
      });
    } else if (r < 0.9) {
      // turn.upsert: header updates (activity, state)
      ops.push({
        op: 'turn.upsert',
        turn: { ...turnHeader(turnN), state: i % 3 === 0 ? 'completed' : 'running', prompt: `updated prompt ${i}` },
      });
    } else if (r < 0.95) {
      // new turn: opens at the stream's tail (monotonic ordinal, like live)
      nextOrdinal += 1;
      const header = turnHeader(nextTurn);
      nextTurn += 1;
      ops.push({ op: 'turn.upsert', turn: header });
      ops.push({ op: 'step.upsert', turnId: header.turnId, step: stepHeader(header.turnId) });
    } else {
      // backfill marker: anchored before a random turn
      nextOrdinal += 1;
      ops.push({
        op: 'marker.upsert',
        item: { kind: 'marker', markerId: `m${nextOrdinal}`, marker: 'task', payload: { text: `backfill ${nextOrdinal}` } },
        beforeTurn: (rng() * TURNS) | 0,
      });
    }
  }
  return ops;
}

function median(sorted: number[]): number {
  const n = sorted.length;
  return (sorted[(n / 2) | 0] ?? 0) / 1;
}

function fmt(n: number): string {
  return n.toLocaleString('en-US', { maximumFractionDigits: 1 });
}

const opsPerSec = (n: number, ms: number): string => `${fmt((n / ms) * 1000)} ops/s`;

function main(): void {
  console.log(
    `\ntranscript apply benchmark  (T=${TURNS} turns, ${STREAM_OPS} stream ops, ${LOOKUPS} lookups, seed=42, node ${process.version})\n`,
  );

  const stream = streamOps(42);

  // scenario A: streaming apply, one op per apply call
  const aTimes: number[] = [];
  for (let round = 0; round < ROUNDS; round += 1) {
    const tx = seedStore(TURNS);
    const t0 = performance.now();
    for (const op of stream) {
      tx.apply([op]);
    }
    aTimes.push(performance.now() - t0);
  }
  aTimes.sort((x, y) => x - y);
  const aMs = median(aTimes);
  const applied = stream.length + TURNS * 2; // seed applies + stream ops
  console.log(
    `  A: ${STREAM_OPS} stream ops over ${TURNS}+ turns (one-by-one apply)`.padEnd(58) +
      `${fmt(aMs).padStart(8)} ms   -> ${opsPerSec(applied, aMs)}`,
  );

  // scenario B: getTurn lookups over a 500-turn state
  const tx = seedStore(TURNS);
  const targets: string[] = [];
  const rng = mulberry32(7);
  for (let i = 0; i < LOOKUPS; i += 1) targets.push(`t${(rng() * TURNS) | 0}`);
  const bTimes: number[] = [];
  for (let round = 0; round < ROUNDS; round += 1) {
    const t0 = performance.now();
    let hits = 0;
    for (const target of targets) {
      if (tx.getTurn(target)) hits += 1;
    }
    bTimes.push(performance.now() - t0);
    if (hits !== LOOKUPS) throw new Error(`lookup sanity failed: ${hits}/${LOOKUPS}`);
  }
  bTimes.sort((x, y) => x - y);
  const bMs = median(bTimes);
  console.log(
    `  B: ${LOOKUPS} getTurn lookups (${TURNS} turns)`.padEnd(58) +
      `${fmt(bMs).padStart(8)} ms   -> ${opsPerSec(LOOKUPS, bMs)}`,
  );

  console.log('\ndone.\n');
}

main();
