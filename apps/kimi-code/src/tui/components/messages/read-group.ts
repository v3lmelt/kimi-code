/**
 * ReadGroupComponent renders 2+ Read/Grep/Glob calls from the same step as one group.
 *
 * It follows the same structure as `AgentGroupComponent`, with a smaller
 * surface:
 * - one summary header and a tree body listing each path/pattern and status;
 * - permanently grouped, while the body remains visible;
 * - 200ms throttling, matching AgentGroup;
 * - state stays in each `ToolCallComponent`; the group only reads snapshots.
 *
 * Header forms (mixed tools):
 *   pending:     Reading 2 files · Grepping…
 *   all done:    Read 3 files · Grepped 2 · Found 12
 *   some failed: append · {F} failed
 */

import type { TUI } from '@moonshot-ai/pi-tui';
import { Container, Spacer, Text } from '@moonshot-ai/pi-tui';

import { STATUS_BULLET } from '#/tui/constant/symbols';
import { currentTheme } from '#/tui/theme';

import type { ToolCallComponent, ToolCallReadSnapshot } from './tool-call';

const THROTTLE_MS = 200;

function snapshotLabel(snap: ToolCallReadSnapshot): string {
  if (snap.toolName === 'Grep' || snap.toolName === 'Glob') {
    return snap.pattern ?? snap.filePath ?? '';
  }
  return snap.filePath ?? snap.pattern ?? '';
}

function pendingTail(toolName: string): string {
  if (toolName === 'Grep') return ' · grepping…';
  if (toolName === 'Glob') return ' · listing…';
  return ' · reading…';
}

function summarizeSearchRead(
  snapshots: readonly ToolCallReadSnapshot[],
  pending: boolean,
): string[] {
  const reads = snapshots.filter((snap) => snap.toolName === 'Read');
  const greps = snapshots.filter((snap) => snap.toolName === 'Grep');
  const globs = snapshots.filter((snap) => snap.toolName === 'Glob');
  const parts: string[] = [];
  if (reads.length > 0) {
    parts.push(
      pending
        ? `Reading ${String(reads.length)} ${reads.length === 1 ? 'file' : 'files'}…`
        : `Read ${String(reads.length)} ${reads.length === 1 ? 'file' : 'files'}`,
    );
    if (!pending) {
      const lines = reads.reduce((sum, snap) => sum + (snap.phase === 'done' ? snap.lines : 0), 0);
      parts[parts.length - 1] += ` · ${String(lines)} ${lines === 1 ? 'line' : 'lines'}`;
    }
  }
  if (greps.length > 0) {
    if (pending) {
      parts.push(greps.length === 1 ? 'Grepping…' : `Grepping ${String(greps.length)}…`);
    } else {
      const matches = greps.reduce((sum, snap) => sum + (snap.phase === 'done' ? snap.lines : 0), 0);
      parts.push(
        `Grepped ${String(greps.length)} · Found ${String(matches)}`,
      );
    }
  }
  if (globs.length > 0) {
    if (pending) {
      parts.push(globs.length === 1 ? 'Listing…' : `Listing ${String(globs.length)}…`);
    } else {
      const matches = globs.reduce((sum, snap) => sum + (snap.phase === 'done' ? snap.lines : 0), 0);
      parts.push(`Found ${String(matches)}`);
    }
  }
  return parts;
}

interface ReadEntry {
  readonly toolCallId: string;
  readonly tc: ToolCallComponent;
}

export class ReadGroupComponent extends Container {
  private readonly entries: ReadEntry[] = [];
  private readonly headerText: Text;
  private readonly bodyContainer: Container;
  private throttleTimer: ReturnType<typeof setTimeout> | null = null;
  private lastFlushPhases = new Map<string, ToolCallReadSnapshot['phase']>();
  private _invalidating = false;

  constructor(private readonly ui: TUI | undefined) {
    super();
    this.addChild(new Spacer(1));
    this.headerText = new Text('', 0, 0);
    this.addChild(this.headerText);
    this.bodyContainer = new Container();
    this.addChild(this.bodyContainer);
  }

  size(): number {
    return this.entries.length;
  }

  /**
   * Borrows a standalone `ToolCallComponent` into the group as a hidden state
   * container. Snapshot changes trigger throttled refreshes. Re-attaching the
   * same toolCallId is a no-op.
   */
  attach(toolCallId: string, tc: ToolCallComponent): void {
    if (this.entries.some((e) => e.toolCallId === toolCallId)) return;
    this.entries.push({ toolCallId, tc });
    tc.setSnapshotListener(() => {
      this.scheduleRender();
    });
    this.flushRender();
  }

  /**
   * The pending -> done/failed transition is the important visible change, so
   * it refreshes immediately. Other changes are throttled.
   */
  private scheduleRender(): void {
    if (this.detectPhaseTransition()) {
      this.flushRender();
      return;
    }
    if (this.throttleTimer !== null) return;
    this.throttleTimer = setTimeout(() => {
      this.throttleTimer = null;
      this.flushRender();
    }, THROTTLE_MS);
  }

  private detectPhaseTransition(): boolean {
    for (const e of this.entries) {
      const phase = e.tc.getReadSnapshot().phase;
      if (this.lastFlushPhases.get(e.toolCallId) !== phase) return true;
    }
    return false;
  }

  private flushRender(): void {
    if (this.throttleTimer !== null) {
      clearTimeout(this.throttleTimer);
      this.throttleTimer = null;
    }

    const snapshots = this.entries.map((e) => e.tc.getReadSnapshot());
    this.headerText.setText(this.buildHeader(snapshots));

    this.bodyContainer.clear();
    const visibleSnapshots = snapshots.filter((snap) => snapshotLabel(snap).length > 0);
    visibleSnapshots.forEach((snap, idx) => {
      const isLast = idx === visibleSnapshots.length - 1;
      this.bodyContainer.addChild(new Text(this.buildBodyLine(snap, isLast), 0, 0));
    });

    this.lastFlushPhases.clear();
    this.entries.forEach((entry, i) => {
      const snap = snapshots[i];
      if (snap !== undefined) this.lastFlushPhases.set(entry.toolCallId, snap.phase);
    });

    this.invalidate();
    this.ui?.requestRender();
  }

  private buildHeader(snapshots: readonly ToolCallReadSnapshot[]): string {
    const pending = snapshots.filter((snap) => snap.phase === 'pending').length;
    const failed = snapshots.filter((snap) => snap.phase === 'failed').length;
    const parts = summarizeSearchRead(snapshots, pending > 0);
    const labelText = parts.join(' · ') || (pending > 0 ? 'Searching…' : 'Searched');

    if (pending > 0) {
      const bullet = currentTheme.fg('text', STATUS_BULLET);
      const label = currentTheme.boldFg('primary', labelText);
      return `${bullet}${label}`;
    }

    if (failed === snapshots.length && snapshots.length > 0) {
      const bullet = currentTheme.fg('error', '✗ ');
      const label = currentTheme.boldFg('error', labelText);
      return `${bullet}${label}${currentTheme.fg('error', ' · failed')}`;
    }

    const bullet = currentTheme.fg('success', STATUS_BULLET);
    const label = currentTheme.boldFg('primary', labelText);
    const failPart = failed > 0 ? currentTheme.fg('error', ` · ${String(failed)} failed`) : '';
    return `${bullet}${label}${failPart}`;
  }

  private buildBodyLine(snap: ToolCallReadSnapshot, isLast: boolean): string {
    const dim = (text: string): string => currentTheme.dim(text);
    const branch = isLast ? '└─' : '├─';
    const pathPart = currentTheme.fg('text', snapshotLabel(snap));

    let tail: string;
    if (snap.phase === 'pending') {
      tail = dim(pendingTail(snap.toolName));
    } else if (snap.phase === 'failed') {
      tail = currentTheme.fg('error', ' · failed');
    } else if (snap.toolName === 'Read') {
      tail = dim(` · ${String(snap.lines)} ${snap.lines === 1 ? 'line' : 'lines'}`);
    } else {
      tail = dim(` · ${String(snap.lines)} ${snap.lines === 1 ? 'match' : 'matches'}`);
    }
    return `  ${branch} ${pathPart}${tail}`;
  }

  override invalidate(): void {
    if (this._invalidating) {
      super.invalidate();
      return;
    }
    this._invalidating = true;
    this.flushRender();
    this._invalidating = false;
  }

  /** Releases throttle timers so destroyed components cannot refresh later. */
  dispose(): void {
    if (this.throttleTimer !== null) {
      clearTimeout(this.throttleTimer);
      this.throttleTimer = null;
    }
    for (const e of this.entries) {
      e.tc.setSnapshotListener(undefined);
    }
  }
}
