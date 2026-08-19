/**
 * `readState` domain — `IAgentReadStateService` contract.
 *
 * Agent-scope record of what the model has recently Read, keyed by resolved
 * path. EditTool consumes it to reject edits against stale or unread files;
 * ReadTool consumes it to return a stub for repeat reads of the same range on
 * an unchanged file; fullCompaction consumes it (as an LRU) to re-attach the
 * files being edited right after compaction. The entries map is registered
 * into `agentState` (`IAgentStateService`) so it snapshots/restores with the
 * agent. Bound at Agent scope.
 */

import { createDecorator } from '#/_base/di/instantiation';

export interface ReadStateRange {
  readonly offset: number;
  readonly lines: number;
}

export interface ReadStateEntry {
  readonly mtimeMs: number | undefined;
  readonly totalLines: number;
  readonly ranges: readonly ReadStateRange[];
  readonly lastReadAt: number;
}

export interface RecordReadInput {
  readonly mtimeMs: number | undefined;
  readonly totalLines: number;
  readonly offset: number;
  readonly lines: number;
}

export interface IAgentReadStateService {
  readonly _serviceBrand: undefined;

  /** Whether read-state enforcement is on (config killswitch). */
  isEnabled(): boolean;

  find(path: string): ReadStateEntry | undefined;

  recordRead(path: string, input: RecordReadInput): void;

  /** Record that the model edited `path`; bumps the recorded mtime to
   *  `mtimeMs` so consecutive edits do not trip the stale-file check. */
  recordEdit(path: string, mtimeMs: number | undefined): void;

  /** Most-recently-read paths first (LRU). */
  recentFiles(limit: number): readonly string[];
}

export const IAgentReadStateService = createDecorator<IAgentReadStateService>(
  'agentReadStateService',
);
