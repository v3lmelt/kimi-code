/**
 * `readState` domain — `IAgentReadStateService` implementation.
 *
 * Stores {path -> mtime + total line count + read ranges + LRU timestamp} in
 * `agentState` (the entries map), gated by the `[read_state]` config section
 * killswitch. `recordRead` merges ranges for an unchanged file and resets them
 * when the file changes; `recordEdit` refreshes the recorded mtime after the
 * model edits the file; `recentFiles` returns the LRU paths in most-recent
 * order for post-compaction reattachment. Bound at Agent scope.
 */

import { Disposable } from '#/_base/di/lifecycle';
import { LifecycleScope } from '#/app/scopes';
import { ScopeActivation, registerScopedService } from '#/_base/di/scope';
import { defineState } from '#/_base/state/stateRegistry';
import { IConfigService } from '#/app/config/config';
import { IAgentStateService } from '#/agent/state/agentState';
import { READ_STATE_SECTION, type ReadStateConfig } from './configSection';
import {
  IAgentReadStateService,
  type ReadStateEntry,
  type RecordReadInput,
} from './readState';

const MAX_RECORDED_RANGES_PER_FILE = 32;

export const agentReadStateEntriesKey = defineState<Map<string, ReadStateEntry>>(
  'readState.entries',
  () => new Map(),
);

// NOTE: stays Disposable — `Service` owns `config`/`get` members that collide
export class AgentReadStateService extends Disposable implements IAgentReadStateService {
  declare readonly _serviceBrand: undefined;

  constructor(
    @IAgentStateService private readonly states: IAgentStateService,
    @IConfigService private readonly config: IConfigService,
  ) {
    super();
    this.states.register(agentReadStateEntriesKey);
  }

  isEnabled(): boolean {
    return this.config.get<ReadStateConfig>(READ_STATE_SECTION)?.enabled ?? true;
  }

  private get entries(): Map<string, ReadStateEntry> {
    return this.states.get(agentReadStateEntriesKey);
  }

  find(path: string): ReadStateEntry | undefined {
    return this.entries.get(path);
  }

  recordRead(path: string, input: RecordReadInput): void {
    const entries = this.entries;
    const existing = entries.get(path);
    const ranges =
      existing === undefined ||
      existing.mtimeMs !== input.mtimeMs ||
      existing.totalLines !== input.totalLines
        ? [{ offset: input.offset, lines: input.lines }]
        : [...existing.ranges, { offset: input.offset, lines: input.lines }].slice(
            -MAX_RECORDED_RANGES_PER_FILE,
          );
    entries.set(path, {
      mtimeMs: input.mtimeMs,
      totalLines: input.totalLines,
      ranges,
      lastReadAt: Date.now(),
    });
    this.states.set(agentReadStateEntriesKey, entries);
  }

  recordEdit(path: string, mtimeMs: number | undefined): void {
    const entries = this.entries;
    const existing = entries.get(path);
    if (existing === undefined) return;
    entries.set(path, { ...existing, mtimeMs, lastReadAt: Date.now() });
    this.states.set(agentReadStateEntriesKey, entries);
  }

  recentFiles(limit: number): readonly string[] {
    const entries = [...this.entries.entries()];
    entries.sort((a, b) => b[1].lastReadAt - a[1].lastReadAt);
    return entries.slice(0, limit).map(([path]) => path);
  }
}

registerScopedService(
  LifecycleScope.Agent,
  IAgentReadStateService,
  AgentReadStateService,
  ScopeActivation.OnScopeCreated,
  'readState',
);
