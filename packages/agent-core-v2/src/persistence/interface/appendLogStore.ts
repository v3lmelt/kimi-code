/**
 * `persistence/interface` — `IAppendLogStore` contract.
 *
 * The append-log access-pattern store: turns a byte stream into an ordered
 * sequence of typed JSON records on top of `IFileSystemStorageService`. Owns the
 * concerns the storage service deliberately ignores: line framing, batching,
 * and crash-tolerant decoding. Acquired handles share a keyed buffer; its final
 * owner release starts a flush and retires that buffer once the flush settles,
 * before a replacement buffer starts storage I/O for the same key. `rewrite`
 * takes ownership at its call boundary: `records` replaces the history already
 * durable before that cutover, while appends still queued or in flight remain
 * a live tail that is drained after the atomic replacement. Callers must not
 * also include those outstanding appends in `records`. An ambiguous append or
 * rewrite failure remains sticky for that acquired buffer generation so a
 * later flush cannot duplicate data by guessing whether storage committed it.
 * A valid explicit `rewrite` is the recovery boundary: a successful atomic
 * replacement clears that failure before the preserved live tail drains.
 * `flush` and `close` wait for every keyed buffer to settle before reporting
 * the first failure in stable key insertion order.
 *
 * This file ships the interface, error class, and DI token only.
 */

import { createDecorator, type ServiceIdentifier } from '#/_base/di/instantiation';
import { type IDisposable } from '#/_base/di/lifecycle';

import { StorageError, StorageErrors } from '#/persistence/interface/storage';

export class AppendLogCorruptedError extends StorageError {
  constructor(scope: string, key: string, lineNumber: number, cause: unknown) {
    super(
      StorageErrors.codes.STORAGE_CORRUPTED,
      `append-log ${scope}/${key}: corrupted line ${lineNumber}`,
      {
        details: { scope, key, lineNumber },
        cause,
      },
    );
    this.name = 'AppendLogCorruptedError';
  }
}

export interface AppendLogOptions {
  readonly onError?: (error: unknown) => void;
}

/**
 * Result of an offset-based incremental read (`readFrom`).
 *
 * `nextByte` is the byte offset just past the last complete line returned
 * (the `'\n'` of its terminating newline, or EOF for a final line without
 * one) — pass it back as the next `fromByte` to read only the delta.
 *
 * `truncated` reports that the log is now SHORTER than `fromByte` — an
 * atomic `rewrite` replaced it with less content. The caller's fold state is
 * then stale and must be rebuilt from `fromByte = 0`; `records` is empty and
 * `nextByte` is meaningless in that case.
 */
export interface AppendLogReadFromResult<R> {
  readonly records: readonly R[];
  readonly nextByte: number;
  readonly truncated: boolean;
}

export interface IAppendLogStore {
  readonly _serviceBrand: undefined;

  append<R>(scope: string, key: string, record: R, options?: AppendLogOptions): void;
  read<R>(scope: string, key: string): AsyncIterable<R>;
  /**
   * Read the records whose lines start at or after byte `fromByte`.
   *
   * `fromByte` must be a line boundary (a `nextByte` returned by a previous
   * call, or 0); a first line that fails to parse is treated as a torn line
   * cut by the offset and dropped. Same framing, decoding, and crash
   * tolerance as `read`: one JSON value per `'\n'`-terminated line, a torn
   * final line is dropped, corruption elsewhere throws
   * `AppendLogCorruptedError` (line numbers are relative to this delta, not
   * the whole log). Unlike `read`, only `[fromByte, size)` bytes are pulled
   * from storage — the incremental read path.
   */
  readFrom<R>(
    scope: string,
    key: string,
    fromByte: number,
  ): Promise<AppendLogReadFromResult<R>>;
  rewrite<R>(scope: string, key: string, records: readonly R[]): Promise<void>;
  flush(): Promise<void>;
  close(): Promise<void>;
  acquire(scope: string, key: string): IDisposable;
  /**
   * Take a short-lived exclusive coordination lock for one log key.
   *
   * The lock serializes read/check/append transactions that need to make a
   * durable journal decision. It does not replace the journal records: the
   * resulting state must still be represented by the append log so a fresh
   * process can fold it after restart.
   *
   * Filesystem backends may need asynchronous coordination with other
   * processes; synchronous implementations remain valid for compatibility
   * with in-process stores. Backends without a process-shared primitive may
   * omit this optional capability.
   */
  acquireExclusive?(scope: string, key: string): IDisposable | Promise<IDisposable>;
}

export const IAppendLogStore: ServiceIdentifier<IAppendLogStore> =
  createDecorator<IAppendLogStore>('appendLogStore');
