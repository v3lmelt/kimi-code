/**
 * `SessionEventJournal` — seq assignment, durability, recovery, epoch rotation.
 */

import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// The journal's `mkdir` call count is asserted below (one syscall per
// journal, not one per flush round). `node:fs/promises` exports are
// read-only, so spyOn cannot redefine them — mock the module and forward
// the real implementation; every other test is unaffected.
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return { ...actual, mkdir: vi.fn(actual.mkdir) };
});

import {
  type EventEnvelope,
  SessionEventJournal,
} from '../src/transport/ws/v1/sessionEventJournal';

function envelope(seq: number): EventEnvelope {
  return {
    type: 'turn.started',
    seq,
    timestamp: new Date().toISOString(),
    payload: { seq },
  };
}

describe('SessionEventJournal', () => {
  let dir: string;
  let filePath: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'kimi-journal-test-'));
    filePath = join(dir, 'sess_1.jsonl');
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('assigns monotonic seq and reads back in order', async () => {
    const j = await SessionEventJournal.open(filePath);
    expect(j.epoch).toMatch(/^ep_/);
    expect(j.seq).toBe(0);

    j.append(j.nextSeq(), envelope(1));
    j.append(j.nextSeq(), envelope(2));
    j.append(j.nextSeq(), envelope(3));
    expect(j.seq).toBe(3);

    const all = await j.readSince(0, 100);
    expect(all.map((e) => e.seq)).toEqual([1, 2, 3]);
    await j.close();
  });

  it('recovers seq and epoch across reopen', async () => {
    const j1 = await SessionEventJournal.open(filePath);
    const epoch = j1.epoch;
    j1.append(j1.nextSeq(), envelope(1));
    j1.append(j1.nextSeq(), envelope(2));
    await j1.close();

    const j2 = await SessionEventJournal.open(filePath);
    expect(j2.epoch).toBe(epoch);
    expect(j2.seq).toBe(2);
    expect(j2.nextSeq()).toBe(3);
    await j2.close();
  });

  it('rotates to a fresh epoch when the header is corrupt', async () => {
    const j1 = await SessionEventJournal.open(filePath);
    const epoch = j1.epoch;
    j1.append(j1.nextSeq(), envelope(1));
    await j1.close();

    // Corrupt the file: overwrite with a garbage first line (no header).
    await writeFile(filePath, 'this is not json\n', 'utf8');

    const j2 = await SessionEventJournal.open(filePath);
    expect(j2.epoch).toMatch(/^ep_/);
    expect(j2.epoch).not.toBe(epoch);
    expect(j2.seq).toBe(0);
    await j2.close();
  });

  it('readSince honors the exclusive lower bound and the limit', async () => {
    const j = await SessionEventJournal.open(filePath);
    for (let i = 1; i <= 5; i++) j.append(j.nextSeq(), envelope(i));

    const page = await j.readSince(2, 2);
    expect(page.map((e) => e.seq)).toEqual([3, 4]);
    await j.close();
  });

  it('readSince on a missing file returns empty', async () => {
    const j = await SessionEventJournal.open(filePath);
    const out = await j.readSince(0, 100);
    expect(out).toEqual([]);
    await j.close();
  });

  it('flushes appends that arrive while a flush is in flight', async () => {
    const j = await SessionEventJournal.open(filePath);
    // The first append starts an in-flight flush; the rest land in the same
    // synchronous burst (while it runs) and must be chained into a follow-up
    // round — not parked until a later append or `close()`.
    for (let i = 1; i <= 12; i++) j.append(j.nextSeq(), envelope(i));
    // Poll the raw file: `readSince`/`close` force a flush themselves and
    // would mask a missing chained round.
    const deadline = Date.now() + 2000;
    let lines = 0;
    while (Date.now() < deadline) {
      try {
        lines = (await readFile(filePath, 'utf8')).trim().split('\n').length;
      } catch {
        lines = 0;
      }
      if (lines >= 13) break; // header + 12 events
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect(lines).toBe(13);
    await j.close();
  });

  it('mkdirs the journal directory only once across flush rounds', async () => {
    const fsPromises = await import('node:fs/promises');
    const mkdirMock = vi.mocked(fsPromises.mkdir);
    mkdirMock.mockClear();
    try {
      const j = await SessionEventJournal.open(filePath);
      j.append(j.nextSeq(), envelope(1));
      await j.flush();
      expect(mkdirMock).toHaveBeenCalledTimes(1);

      // Second round: the directory is known-good — no mkdir syscall.
      j.append(j.nextSeq(), envelope(2));
      await j.flush();
      expect(mkdirMock).toHaveBeenCalledTimes(1);
      await j.close();
    } finally {
      mkdirMock.mockClear();
    }
  });

  it('re-tries mkdir after a failed write round (events stay live-only)', async () => {
    const fsPromises = await import('node:fs/promises');
    const mkdirMock = vi.mocked(fsPromises.mkdir);
    mkdirMock.mockClear();
    mkdirMock.mockRejectedValueOnce(new Error('disk error'));
    try {
      const j = await SessionEventJournal.open(filePath);
      j.append(j.nextSeq(), envelope(1));
      await j.flush();
      expect(mkdirMock).toHaveBeenCalledTimes(1);

      // A failed round resets the ready flag — the next round re-creates
      // the directory and the pending line lands.
      j.append(j.nextSeq(), envelope(2));
      await j.flush();
      expect(mkdirMock).toHaveBeenCalledTimes(2);
      await j.close();

      const all = await SessionEventJournal.open(filePath);
      expect((await all.readSince(0, 100)).map((e) => e.seq)).toEqual([2]);
      await all.close();
    } finally {
      mkdirMock.mockClear();
      mkdirMock.mockReset();
    }
  });
});
