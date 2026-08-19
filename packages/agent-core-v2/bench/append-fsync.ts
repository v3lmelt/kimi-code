// bench/append-fsync.ts
//
// Fsync-storm benchmark for `src/persistence/backends/node-fs/appendLogStore.ts`
// (`AppendLogStore` over the real `FileStorageService` backend). Simulates a
// streaming write pattern: N records appended at a fixed interval (default
// 1ms), then one flush. Counts both the durable `storage.append` calls (each
// one is an open + write + fsync + close on the file backend) and the raw
// fsync count via `FileHandle.prototype.sync`.
//
// Run:  pnpm bench:append-fsync
//       node --import tsx bench/append-fsync.ts
// Knobs (env): N (records), INTERVAL_MS (spacing between appends).

import { open, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'pathe';

import { AppendLogStore } from '../src/persistence/backends/node-fs/appendLogStore';
import { FileStorageService } from '../src/persistence/backends/node-fs/fileStorageService';

const N = Number(process.env.N ?? 300);
const INTERVAL_MS = Number(process.env.INTERVAL_MS ?? 1);
const fmt = (n: number) => n.toLocaleString('en-US', { maximumFractionDigits: 0 });
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

// ---- instrument the real FileHandle prototype (fsync count) ------------------
// `node:fs` does not export the FileHandle class in ESM, so grab the shared
// prototype from a probe handle instead.
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

/** Wraps the real file backend and counts durable appends (= open+sync+close batches). */
class CountingStorage extends FileStorageService {
  appendCalls = 0;
  override async append(
    scope: string,
    key: string,
    data: Uint8Array,
    options?: { readonly durable?: boolean },
  ): Promise<void> {
    this.appendCalls++;
    return super.append(scope, key, data, options);
  }
}

const SCOPE = 'agents/main';
const KEY = 'wire.jsonl';

async function run(): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), 'append-fsync-bench-'));
  try {
    const storage = new CountingStorage(dir);
    const log = new AppendLogStore(storage);
    storage.appendCalls = 0;
    syncCount = 0;
    const t0 = performance.now();
    for (let i = 0; i < N; i++) {
      log.append(SCOPE, KEY, { n: i, s: `bench record ${i}` });
      if (INTERVAL_MS > 0) await sleep(INTERVAL_MS);
    }
    await log.flush();
    const elapsed = performance.now() - t0;
    console.log(
      `  records ${fmt(N).padStart(6)}  interval ${INTERVAL_MS}ms  ` +
        `appends ${fmt(storage.appendCalls).padStart(6)}  fsyncs ${fmt(syncCount).padStart(6)}  ` +
        `elapsed ${elapsed.toFixed(1).padStart(9)} ms  (${fmt((elapsed / Math.max(1, storage.appendCalls)) * 1000)} µs/append)`,
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

console.log(`\nappend-fsync benchmark (node ${process.version}) — v2 AppendLogStore`);
console.log(`  ${fmt(N)} records, ${INTERVAL_MS}ms interval, spread then one flush\n`);
await run();
console.log('\ndone.\n');
