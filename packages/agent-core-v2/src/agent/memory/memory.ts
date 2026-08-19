/**
 * `memory` domain — `IMemoryService` contract.
 *
 * Owns the agent's cross-session memory. A `MEMORY.md` file lives under the
 * brand home (`~/.kimi-code/memory/`), survives across sessions, and is
 * injected into the system prompt so stable facts persist between
 * conversations. The file may be scoped per agent: `'user'` (the default)
 * keeps one shared file, `'project'` keeps one file per working directory
 * under `<memoryDir>/projects/<projectKey>/`. A fire-and-forget background
 * extraction distills finished turns into memory entries through an
 * `llmRequester` operation request with a read-only tool whitelist — time /
 * turn-count double gated, abortable on dispose, and never blocking the main
 * turn. A session-memory read lets full-compaction reuse the extracted memory
 * as a compaction summary instead of burning an LLM round. The extraction
 * boundary (the number of context messages already distilled) is tracked in
 * `agentState` so it survives snapshots and restores. Bound at Agent scope.
 */

import { createDecorator } from '#/_base/di/instantiation';

export const MEMORY_FILE_NAME = 'MEMORY.md';

/** Heading of the memory file; also the first line `loadMemoryText` reads. */
export const MEMORY_SECTION_HEADING = '# Kimi Code Memory';

/** Memory file scope bound at construction: `'user'` shares one `MEMORY.md`
 *  across machines; `'project'` keys the file by the working directory. */
export type MemoryScope = 'user' | 'project';

export const DEFAULT_MEMORY_SCOPE: MemoryScope = 'user';

export interface IMemoryService {
  readonly _serviceBrand: undefined;

  /** Whether the memory domain is on (config killswitch). */
  isEnabled(): boolean;

  /** Resolved memory directory (config override or brand-home default). */
  memoryDir(): string;

  /** The scope currently bound to this service (`'user'` until set). */
  memoryScope(): MemoryScope;

  /** Bind the memory file scope for this agent's lifetime; `'user'` keeps
   *  the current path exactly, `'project'` moves it under
   *  `<memoryDir>/projects/<projectKey>/`. Must be called before the first
   *  read to affect system-prompt injection. */
  setScope(scope: MemoryScope): void;

  /** Absolute path to the memory file (`MEMORY.md`), scoped. */
  memoryFilePath(): string;

  /** Read the persistent memory content for system-prompt injection. */
  loadMemoryText(): Promise<string>;

  /** Read the current session's extracted memory for memory-first compaction;
   *  `undefined` when absent or too thin to stand in for a summary. */
  loadCompactionSummary(): Promise<string | undefined>;

  /** Fire-and-forget background extraction; never blocks the turn. */
  maybeRunExtraction(): void;
}

export const IMemoryService = createDecorator<IMemoryService>('agentMemoryService');
