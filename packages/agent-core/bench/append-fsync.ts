// bench/append-fsync.ts
//
// Fsync-storm benchmark for `src/agent/records/persistence.ts`
// (`FileSystemAgentRecordPersistence`). Simulates one turn's wire-log write
// pattern: N records appended at a fixed interval (default 1ms, LLM-stream
// spacing), then a final flush. Counts the real fsync calls by instrumenting
// the FileHandle prototype's `sync` (every durable batch is exactly one
// open + write + fsync + close, so fsync count = open count).
//
// Run:  pnpm bench:append-fsync
//       node --import tsx bench/append-fsync.ts
// Knobs (env): N (records), INTERVAL_MS (spacing between appends).

import { open, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'pathe';

import {
  FileSystemAgentRecordPersistence,
  type AgentRecord,
} from '../src/agent/records';

const N = Number(process.env.N ?? 300);
const INTERVAL_MS = Number(process.env.INTERVAL_MS ?? 1);
const fmt = (n: number) => n.toLocaleString('en-US', { maximumFractionDigits: 0 });
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

// ---- instrument the real FileHandle prototype --------------------------------
// `node:fs` does not export the FileHandle class in ESM, so grab the shared
// prototype from a probe handle instead. Every durable write batch does
// exactly one `fh.sync()`, so the fsync count also equals the open count on
// this write path.
interface FileHandleProto {
  sync(): Promise<void>;
}
const probeDir = await mkdtemp(join(tmpdir(), 'fsync-probe-'));
const probe = await open(join(probeDir, 'probe'), 'w');
const fileHandleProto = Object.getPrototypeOf(probe) as unknown as FileHandleProto;
const origSync = fileHandleProto.sync;
let syncCount = 0;
fileHandleProto.sync = function (this: FileHandleProto) {
  syncCount++;
  return origSync.call(this);
};
await probe.close();
await rm(probeDir, { recursive: true, force: true });

function makeRecord(i: number): AgentRecord {
  return {
    type: 'turn.prompt',
    input: [{ type: 'text', text: `bench record ${i}` }],
    origin: { kind: 'user' },
  };
}

async function run(): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), 'append-fsync-bench-'));
  try {
    const persistence = new FileSystemAgentRecordPersistence(join(dir, 'wire.jsonl'));
    syncCount = 0;
    const t0 = performance.now();
    for (let i = 0; i < N; i++) {
      persistence.append(makeRecord(i));
      if (INTERVAL_MS > 0) await sleep(INTERVAL_MS);
    }
    await persistence.flush();
    const elapsed = performance.now() - t0;
    console.log(
      `  records ${fmt(N).padStart(6)}  interval ${INTERVAL_MS}ms  ` +
        `fsyncs ${fmt(syncCount).padStart(6)}  opens ${fmt(syncCount).padStart(6)} (1:1)  ` +
        `elapsed ${elapsed.toFixed(1).padStart(9)} ms  (${fmt((elapsed / Math.max(1, syncCount)) * 1000)} µs/fsync)`,
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

console.log(`\nappend-fsync benchmark (node ${process.version}) — v1 FileSystemAgentRecordPersistence`);
console.log(`  ${fmt(N)} records, ${INTERVAL_MS}ms interval, spread then one flush\n`);
await run();
console.log('\ndone.\n');
