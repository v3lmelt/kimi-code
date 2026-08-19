// bench/bench-message-history.ts
//
// Message-history read path benchmarks (performance-analysis Top 5):
//   - A. readTranscript: full re-read + re-fold of a long wire journal per
//        request (before) vs incremental fold that reuses the previous
//        reducer state (after). Uses a REAL AppendLogStore over a temp dir,
//        so file IO + JSON parsing are included.
//   - D. offset read: full journal re-read + re-parse per request (before)
//        vs `readFrom` byte-delta read (after) — the read half A could not
//        isolate before the store gained an offset read.
//   - B. projection: re-projecting every folded message per request
//        (before) vs reusing the cached projection (after).
//   - C. pagination cursor: full reverse + findIndex per page (before) vs
//        O(1) id-formula parse (after).
//
// Coverage: the pure logic of the hot loop — DI/agent-scope assembly is not
// exercised here (see the report).
//
// Run:  node --import tsx bench/bench-message-history.ts

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';

import {
  AGENT_WIRE_RECORD_KEY,
  AppendLogStore,
  createContextTranscriptReducer,
  FileStorageService,
  type ContextMessage,
  type WireRecord,
} from '@moonshot-ai/agent-core-v2';

import { toProtocolMessage } from '../src/services/messages/messageProjection';
import type { Message } from '../src/protocol/message';

const fmt = (n: number): string => n.toLocaleString('en-US', { maximumFractionDigits: 0 });
const round = (n: number): string => n.toFixed(1);

// ---- deterministic synthetic journal --------------------------------------

const TURNS = 200;
const PARTS_PER_TURN = 20;
const RECORDS_PER_TURN = PARTS_PER_TURN + 5; // user msg + step.begin + tool.call + tool.result + step.end
const TOTAL_RECORDS = TURNS * RECORDS_PER_TURN + 2; // metadata + trailing undo

function makeRecords(): WireRecord[] {
  const records: WireRecord[] = [{ type: 'metadata', protocol_version: '1', created_at: 0 }];
  let now = 1_700_000_000_000;
  for (let t = 0; t < TURNS; t++) {
    const stepUuid = `s_${t}`;
    records.push({
      type: 'context.append_message',
      time: now++,
      message: { role: 'user', content: [{ type: 'text', text: `user message ${t}` }], toolCalls: [] },
    });
    records.push({
      type: 'context.append_loop_event',
      time: now++,
      event: { type: 'step.begin', stepUuid },
    });
    for (let p = 0; p < PARTS_PER_TURN; p++) {
      records.push({
        type: 'context.append_loop_event',
        time: now++,
        event: { type: 'content.part', stepUuid, part: { type: 'text', text: `think block ${t}.${p} `.repeat(8) } },
      });
    }
    records.push({
      type: 'context.append_loop_event',
      time: now++,
      event: { type: 'tool.call', stepUuid, toolCallId: `call_${t}`, name: 'Bash', args: { cmd: 'ls' } },
    });
    records.push({
      type: 'context.append_loop_event',
      time: now++,
      event: { type: 'tool.result', toolCallId: `call_${t}`, output: `tool output ${t}`, isError: false },
    });
    records.push({
      type: 'context.append_loop_event',
      time: now++,
      event: { type: 'step.end', stepUuid },
    });
  }
  records.push({ type: 'context.undo', time: now++, count: 0 }); // no-op undo, exercises the undo branch
  return records;
}

// ---- helpers --------------------------------------------------------------

function ms(fn: () => void): number {
  const start = performance.now();
  fn();
  return performance.now() - start;
}

async function msAsync(fn: () => Promise<void>): Promise<number> {
  const start = performance.now();
  await fn();
  return performance.now() - start;
}

// ---- A. journal read + fold ------------------------------------------------

async function benchFold(log: AppendLogStore, scope: string, rounds: number): Promise<{ before: number; after: number }> {
  // before: every round creates a fresh reducer and folds the whole journal.
  const before = await msAsync(async () => {
    for (let r = 0; r < rounds; r++) {
      const reducer = createContextTranscriptReducer();
      for await (const record of log.read<WireRecord>(scope, AGENT_WIRE_RECORD_KEY)) {
        reducer.add(record);
      }
      reducer.result();
    }
  });

  // after: first round folds everything, later rounds skip the already-folded
  // prefix and only fold the delta (0 records in this steady-state benchmark).
  const after = await msAsync(async () => {
    const reducer = createContextTranscriptReducer();
    let folded = 0;
    for (let r = 0; r < rounds; r++) {
      let count = 0;
      for await (const record of log.read<WireRecord>(scope, AGENT_WIRE_RECORD_KEY)) {
        if (count >= folded) reducer.add(record);
        count++;
      }
      folded = count;
      reducer.result();
    }
  });

  return { before, after };
}

// ---- D. byte-offset incremental read ---------------------------------------
// The read+parse half of the incremental path, isolated: before pays the full
// journal re-read + re-parse every round, after reads only the bytes appended
// since the previous round's offset (`readFrom`; 0 new records here) — this
// is the delta the fold-skip benchmark A could not isolate because the store
// read had no offset before.

async function benchOffsetRead(log: AppendLogStore, scope: string, rounds: number): Promise<{ before: number; after: number }> {
  // before: every round reads + parses the whole journal from byte 0.
  const before = await msAsync(async () => {
    for (let r = 0; r < rounds; r++) {
      let count = 0;
      for await (const record of log.read<WireRecord>(scope, AGENT_WIRE_RECORD_KEY)) {
        count++;
      }
      void count;
    }
  });

  // after: each round pulls only [nextByte, EOF) and parses nothing (the log
  // does not grow during the benchmark).
  const after = await msAsync(async () => {
    let nextByte = 0;
    for (let r = 0; r < rounds; r++) {
      const delta = await log.readFrom<WireRecord>(scope, AGENT_WIRE_RECORD_KEY, nextByte);
      nextByte = delta.nextByte;
    }
  });

  return { before, after };
}

// ---- A2. pure fold (no I/O — isolates the incremental-fold gain from the
// file-read noise; the journal-read scenario A above pays the same full
// read+parse cost in both branches because the store read has no offset) ----

function benchPureFold(records: WireRecord[], rounds: number): { before: number; after: number } {
  // before: a fresh reducer folds the whole journal every round.
  const before = ms(() => {
    for (let r = 0; r < rounds; r++) {
      const reducer = createContextTranscriptReducer();
      for (const record of records) reducer.add(record);
      reducer.result();
    }
  });

  // after: fold once, then reuse — later rounds fold only the delta (0).
  const after = ms(() => {
    const reducer = createContextTranscriptReducer();
    for (const record of records) reducer.add(record);
    const cached = reducer.result();
    for (let r = 0; r < rounds; r++) void cached;
  });

  return { before, after };
}

function benchProjection(messages: ContextMessage[], sessionId: string, rounds: number): { before: number; after: number } {
  const project = (): Message[] => {
    let previousMs = Number.NEGATIVE_INFINITY;
    return messages.map((msg, index) => {
      const createdAtMs = Math.max(previousMs + 1, 1_700_000_000_000 + index);
      previousMs = createdAtMs;
      return toProtocolMessage(sessionId, index, msg, 1_700_000_000_000, createdAtMs);
    });
  };

  // before: re-project all messages every round.
  const before = ms(() => {
    for (let r = 0; r < rounds; r++) void project();
  });

  // after: project once, reuse the cached array afterwards.
  const after = ms(() => {
    const cached = project();
    for (let r = 0; r < rounds; r++) void cached;
  });

  return { before, after };
}

// ---- C. pagination cursor ---------------------------------------------------

/** Standalone large corpus: 5,000 projected messages (a long session). */
function makeProjectedMessages(sessionId: string, count = 5000): Message[] {
  const out: Message[] = [];
  for (let i = 0; i < count; i++) {
    out.push({
      id: `msg_${sessionId}_${String(i).padStart(6, '0')}`,
      session_id: sessionId,
      role: i % 3 === 0 ? 'user' : 'assistant',
      content: [{ type: 'text', text: `message ${i}` }],
      created_at: new Date(1_700_000_000_000 + i).toISOString(),
    } as Message);
  }
  return out;
}

function benchPagination(messages: Message[], sessionId: string, rounds: number): { before: number; after: number } {
  const cursorId = messages[messages.length - 11]!.id;
  const pageSize = 50;

  // before: full reverse copy + linear findIndex per page.
  const before = ms(() => {
    for (let r = 0; r < rounds; r++) {
      const desc = [...messages].reverse();
      const pivotIndex = desc.findIndex((m) => m.id === cursorId);
      if (pivotIndex >= 0) {
        const slice = desc.slice(pivotIndex + 1);
        void slice.slice(0, pageSize);
      }
    }
  });

  // after: parse the `msg_<session>_<index>` id formula (O(1)).
  const prefix = `msg_${sessionId}_`;
  const after = ms(() => {
    for (let r = 0; r < rounds; r++) {
      const idx = cursorId.startsWith(prefix) ? Number(cursorId.slice(prefix.length)) : -1;
      const pivot = Number.isFinite(idx) && idx >= 0 && idx < messages.length ? idx : -1;
      if (pivot >= 0) {
        const start = Math.max(0, pivot - pageSize);
        void messages.slice(start, pivot).reverse();
      }
    }
  });

  return { before, after };
}

// ---- main -------------------------------------------------------------------

async function main(): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), 'kap-server-bench-'));
  try {
    const log = new AppendLogStore(new FileStorageService(dir));
    const scope = `bench/session_bench/agent_main`;
    const records = makeRecords();

    for (const record of records) log.append(scope, AGENT_WIRE_RECORD_KEY, record);
    await log.flush();

    // Fold once to learn the resulting transcript (used by B).
    const reducer = createContextTranscriptReducer();
    for await (const record of log.read<WireRecord>(scope, AGENT_WIRE_RECORD_KEY)) reducer.add(record);
    const transcript = reducer.result();

    const messages = transcript.entries;
    const sessionId = 'bench_session';

    const ROUNDS = 20;
    const a = await benchFold(log, scope, ROUNDS);
    const a2 = benchPureFold(records, ROUNDS);
    const d = await benchOffsetRead(log, scope, ROUNDS);
    const b = benchProjection(messages, sessionId, ROUNDS);
    const c = benchPagination(makeProjectedMessages(sessionId), sessionId, ROUNDS);

    const bar = '------------------------------------------------------------';
    console.log(`kap-server message-history bench (${fmt(TOTAL_RECORDS)} records, ${fmt(TURNS)} turns, ${ROUNDS} rounds)`);
    console.log(bar);
    console.log(`A. readTranscript (read+fold)   before: ${round(a.before)}ms   after: ${round(a.after)}ms   ${(a.before / Math.max(a.after, 0.001)).toFixed(1)}x   (file IO noisy)`);
    console.log(`A2. pure fold (no IO)           before: ${round(a2.before)}ms   after: ${round(a2.after)}ms   ${(a2.before / Math.max(a2.after, 0.001)).toFixed(1)}x`);
    console.log(`D. journal read (offset)        before: ${round(d.before)}ms   after: ${round(d.after)}ms   ${(d.before / Math.max(d.after, 0.001)).toFixed(1)}x   (full re-read vs byte delta)`);
    console.log(`B. projection (${fmt(messages.length)} msgs)  before: ${round(b.before)}ms   after: ${round(b.after)}ms   ${(b.before / Math.max(b.after, 0.001)).toFixed(1)}x`);
    console.log(`C. pagination cursor            before: ${round(c.before)}ms   after: ${round(c.after)}ms   ${(c.before / Math.max(c.after, 0.001)).toFixed(1)}x`);
    console.log(bar);
    console.log(`folded entries: ${fmt(messages.length)}  foldedLength: ${transcript.foldedLength}`);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

void main();
