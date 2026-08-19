import { createReadStream } from 'node:fs';
import { mkdir, open } from 'node:fs/promises';
import { dirname } from 'pathe';

import { syncDir } from '../../utils/fs';
import type { BlobStore } from './blobref';
import { type AgentRecord, type AgentRecordPersistence } from './types';

/**
 * 自动落盘的合并窗口:窗口内到达的邻近记录合并为一批写入,避免
 * LLM 流式输出期间每条记录都触发一次 open + fsync + close。
 */
const FLUSH_WINDOW_MS = 20;
/** 积压条数阈值:超过后不等合并窗口,立即落盘。 */
const FLUSH_BATCH_SIZE = 64;

export interface FileSystemAgentRecordPersistenceOptions {
  readonly onError?: ((error: unknown) => void) | undefined;
  readonly blobStore?: BlobStore | undefined;
}

export interface InMemoryAgentRecordPersistenceOptions {
  readonly onRecord?: ((record: AgentRecord) => void) | undefined;
}

export class InMemoryAgentRecordPersistence implements AgentRecordPersistence {
  readonly records: AgentRecord[] = [];

  constructor(
    records: readonly AgentRecord[] = [],
    private readonly options: InMemoryAgentRecordPersistenceOptions = {},
  ) {
    this.records.push(...records);
  }

  async *read(): AsyncIterable<AgentRecord> {
    for (const record of this.records) {
      yield record;
    }
  }

  append(input: AgentRecord): void {
    this.records.push(input);
    this.options.onRecord?.(input);
  }

  rewrite(records: readonly AgentRecord[]): void {
    this.records.splice(0, this.records.length, ...records);
  }

  async flush(): Promise<void> {}

  async close(): Promise<void> {}
}

export class FileSystemAgentRecordPersistence implements AgentRecordPersistence {
  private readonly pendingRecords: AgentRecord[] = [];
  private shouldClear = false;
  private directorySynced = false;
  /** 日志目录已确保存在:mkdir 结果按实例缓存,不再每批重复创建。 */
  private directoryCreated = false;
  /** 自动落盘的合并窗口定时器(窗口内到达的记录合并为一批)。 */
  private flushTimer: ReturnType<typeof setTimeout> | undefined;
  /** 合并窗口或立即落盘是否已排定。 */
  private flushScheduled = false;
  private flushPromise: Promise<void> | undefined;
  private error: unknown;

  constructor(
    private readonly filePath: string,
    private readonly options: FileSystemAgentRecordPersistenceOptions = {},
  ) {}

  async *read(): AsyncIterable<AgentRecord> {
    await this.flush();

    let line = '';
    let lineNumber = 0;
    const stream = createReadStream(this.filePath, { encoding: 'utf8' });
    try {
      for await (const chunk of stream) {
        line += chunk;
        let newlineIndex = line.indexOf('\n');
        while (newlineIndex !== -1) {
          const rawLine = line.slice(0, newlineIndex);
          line = line.slice(newlineIndex + 1);
          lineNumber++;

          const record = parseRecordLine(
            rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine,
            lineNumber,
            this.filePath,
            false,
          );
          if (record !== undefined) yield record;

          newlineIndex = line.indexOf('\n');
        }
      }
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === 'ENOENT') return;
      throw error;
    }

    if (line.length > 0) {
      lineNumber++;
      const record = parseRecordLine(line, lineNumber, this.filePath, true);
      if (record !== undefined) yield record;
    }
  }

  append(input: AgentRecord): void {
    this.throwIfError();
    this.pendingRecords.push(input);
    this.scheduleFlush();
  }

  rewrite(records: readonly AgentRecord[]): void {
    this.throwIfError();
    this.shouldClear = true;
    this.pendingRecords.splice(0, this.pendingRecords.length, ...records);
    this.scheduleFlush();
  }

  async flush(): Promise<void> {
    this.throwIfError();
    // 手动排空:取消挂起的合并窗口,立即写入,不等窗口到期。
    this.cancelScheduledFlush();
    while (
      this.flushPromise !== undefined ||
      this.shouldClear ||
      this.pendingRecords.length > 0
    ) {
      await this.ensureFlush(false);
      this.throwIfError();
    }
  }

  async close(): Promise<void> {
    await this.flush();
  }

  private scheduleFlush(): void {
    if (this.flushScheduled || this.flushPromise !== undefined) return;
    this.flushScheduled = true;
    if (this.shouldClear || this.pendingRecords.length >= FLUSH_BATCH_SIZE) {
      // rewrite(shouldClear)与积压阈值:不等合并窗口,立即落盘。
      this.flushScheduled = false;
      void this.ensureFlush(true).catch((error) => {
        this.options.onError?.(error);
      });
      return;
    }
    // 时间窗合并:窗口内到达的邻近记录只触发一批写入。
    this.flushTimer = setTimeout(() => {
      this.flushTimer = undefined;
      this.flushScheduled = false;
      if (
        this.error === undefined &&
        (this.shouldClear || this.pendingRecords.length > 0)
      ) {
        void this.ensureFlush(true).catch((error) => {
          this.options.onError?.(error);
        });
      }
    }, FLUSH_WINDOW_MS);
  }

  private cancelScheduledFlush(): void {
    if (this.flushTimer !== undefined) {
      clearTimeout(this.flushTimer);
      this.flushTimer = undefined;
    }
    this.flushScheduled = false;
  }

  /**
   * 排空全部待写记录。
   *
   * `coalesce=true`(自动 flush 链)时,批与批之间等待 `FLUSH_WINDOW_MS`
   * 让邻近记录积累成批,避免流式写入期间每条记录都独立 fsync;手动
   * flush() 传 `false`,保持立即排空的语义。
   */
  private ensureFlush(coalesce = false): Promise<void> {
    if (this.flushPromise !== undefined) return this.flushPromise;

    const promise = this.drainPendingRecords(coalesce)
      .catch((error: unknown) => {
        this.error = error;
        // oxlint-disable-next-line typescript-eslint/only-throw-error
        throw error;
      })
      .finally(() => {
        if (this.flushPromise === promise) {
          this.flushPromise = undefined;
        }
        if (
          this.error === undefined &&
          (this.shouldClear || this.pendingRecords.length > 0)
        ) {
          this.scheduleFlush();
        }
      });
    this.flushPromise = promise;
    return promise;
  }

  private throwIfError(): void {
    // oxlint-disable-next-line typescript-eslint/only-throw-error
    if (this.error !== undefined) throw this.error;
  }

  private async drainPendingRecords(coalesce: boolean): Promise<void> {
    while (this.shouldClear || this.pendingRecords.length > 0) {
      await this.drainBatch();
      // 批间合并窗口(仅自动 flush 链):等待期间新记录积累为下一批。
      if (coalesce && this.pendingRecords.length > 0) {
        await new Promise<void>((resolve) => setTimeout(resolve, FLUSH_WINDOW_MS));
      }
    }
  }

  private async drainBatch(): Promise<void> {
    const shouldClear = this.shouldClear;
    const batch = this.pendingRecords.splice(0);
    this.shouldClear = false;

    const writable = this.options.blobStore !== undefined
      ? await Promise.all(
          batch.map((record) => this.options.blobStore!.offload(record)),
        )
      : batch;

    const content = writable.map((e) => JSON.stringify(e) + '\n').join('');
    const directory = dirname(this.filePath);
    if (!this.directoryCreated) {
      await mkdir(directory, { recursive: true });
      this.directoryCreated = true;
    }

    const fh = await open(this.filePath, shouldClear ? 'w' : 'a');
    try {
      if (content.length > 0) {
        await fh.writeFile(content, 'utf8');
      }
      await fh.sync();
    } finally {
      await fh.close();
    }

    if (!this.directorySynced) {
      await syncDir(directory);
      this.directorySynced = true;
    }
  }
}

function parseRecordLine(
  line: string,
  lineNumber: number,
  filePath: string,
  allowTruncated: boolean,
): AgentRecord | undefined {
  if (line.length === 0) return undefined;
  try {
    return JSON.parse(line) as AgentRecord;
  } catch (parseError) {
    // Tolerate a truncated trailing line — last write may have crashed
    // mid-flush; everything before is still well-formed.
    if (allowTruncated) return undefined;
    throw new Error(
      `wire.jsonl: corrupted line ${lineNumber} in ${filePath}: ${String(parseError)}`,
      { cause: parseError },
    );
  }
}
