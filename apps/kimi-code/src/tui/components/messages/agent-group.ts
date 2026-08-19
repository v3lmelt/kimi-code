/**
 * AgentGroupComponent renders 2+ Agent tool calls from the same step as one group.
 *
 * Design:
 * - State container: each child Agent keeps its real state in its
 *   `ToolCallComponent` (subagent meta, phase, sub-tool calls, tokens, text).
 *   AgentGroup only stores references and does not copy state. Event handlers
 *   still route through `state.pendingToolComponents.get(parent_tool_call_id)`.
 * - Subscription: `attach` registers a snapshot listener on each child so the
 *   group can refresh when child state changes.
 * - Throttling: normal changes are coalesced into one render every 200ms.
 *   Phase transitions (spawning -> running -> done/failed) flush immediately.
 * - Mounting: `KimiTUI` attaches the group to the transcript at the
 *   right time; the group handles `invalidate` plus `ui.requestRender`.
 * - Ungrouping is not implemented. Once formed, a group stays grouped.
 */

import type { TUI } from '@moonshot-ai/pi-tui';
import { Container, Spacer, Text } from '@moonshot-ai/pi-tui';

import { STATUS_BULLET } from '#/tui/constant/symbols';
import { currentTheme } from '#/tui/theme';
import { formatTokenCount } from '#/utils/usage/usage-format';

import { formatDetachHint } from './tool-call';
import type { ToolCallComponent, ToolCallSubagentSnapshot } from './tool-call';

const THROTTLE_MS = 200;

interface AgentEntry {
  readonly toolCallId: string;
  readonly tc: ToolCallComponent;
}

interface PhaseCounts {
  readonly done: number;
  readonly failed: number;
  readonly backgrounded: number;
  readonly running: number;
  readonly waiting: number;
  readonly starting: number;
  readonly terminal: number;
}

export class AgentGroupComponent extends Container {
  private readonly entries: AgentEntry[] = [];
  private readonly headerText: Text;
  private readonly bodyContainer: Container;
  private throttleTimer: ReturnType<typeof setTimeout> | null = null;
  private lastFlushPhases = new Map<string, ToolCallSubagentSnapshot['phase']>();
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
   * Exposes the borrowed tool call components so external code (e.g.
   * routing background task terminal events back to the corresponding
   * Agent card) can reach them — the group renders the tcs' snapshots
   * but never mounts the tcs as Container children, so a plain tree
   * walk of `transcriptContainer` cannot discover them.
   */
  getToolComponents(): readonly ToolCallComponent[] {
    return this.entries.map((entry) => entry.tc);
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
   * Schedules a repaint. Real phase transitions force an immediate refresh;
   * other changes such as latestActivity, tokens, or toolCount are throttled.
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

  /**
   * Compares each child's current phase with the phase captured at the last
   * flush. Any change is treated as a phase transition.
   */
  private detectPhaseTransition(): boolean {
    let changed = false;
    for (const e of this.entries) {
      const phase = e.tc.getSubagentSnapshot().phase;
      if (this.lastFlushPhases.get(e.toolCallId) !== phase) {
        changed = true;
        break;
      }
    }
    return changed;
  }

  private flushRender(): void {
    if (this.throttleTimer !== null) {
      clearTimeout(this.throttleTimer);
      this.throttleTimer = null;
    }

    const snapshots = this.entries.map((e) => e.tc.getSubagentSnapshot());
    this.headerText.setText(this.buildHeader(snapshots));
    this.bodyContainer.clear();
    snapshots.forEach((snap, idx) => {
      const isLast = idx === snapshots.length - 1;
      this.appendLines(snap, isLast);
    });
    if (this.shouldShowDetachHint(snapshots)) {
      this.bodyContainer.addChild(new Text(currentTheme.dim(formatDetachHint()), 2, 0));
    }

    this.lastFlushPhases.clear();
    this.entries.forEach((entry, i) => {
      const snap = snapshots[i];
      if (snap !== undefined) this.lastFlushPhases.set(entry.toolCallId, snap.phase);
    });

    this.invalidate();
    this.ui?.requestRender();
  }

  private buildHeader(snapshots: readonly ToolCallSubagentSnapshot[]): string {
    const total = snapshots.length;
    const counts = countPhases(snapshots);
    const allTerminal = counts.terminal === total;
    const bullet = allTerminal
      ? currentTheme.fg('success', STATUS_BULLET)
      : currentTheme.fg('text', STATUS_BULLET);
    const breakdown = formatBreakdownParts(counts);
    const suffix = breakdown.length > 1 ? ` (${breakdown.join(', ')})` : '';
    const label = `${String(total)} ${total === 1 ? 'agent' : 'agents'}${suffix}`;
    return `${bullet}${currentTheme.boldFg('primary', label)}`;
  }

  private appendLines(snap: ToolCallSubagentSnapshot, isLast: boolean): void {
    const dim = (text: string) => currentTheme.dim(text);
    const branch1 = isLast ? '└─' : '├─';
    const branch2 = isLast ? '   ' : '│  ';
    const agentType = snap.agentName ?? 'agent';
    const namePart = currentTheme.fg('primary', agentType);
    const description = snap.toolCallDescription
      ? dim(` (${snap.toolCallDescription})`)
      : '';
    const stats = formatStats(snap);
    this.bodyContainer.addChild(
      new Text(`  ${branch1} ${namePart}${description}${stats}`, 0, 0),
    );

    const status = formatAgentStatus(snap);
    this.bodyContainer.addChild(new Text(`  ${branch2} ⎿  ${status}`, 0, 0));
  }

  /**
   * Show the Ctrl+B hint while at least one agent in the group is still
   * running in the foreground (i.e. can be detached). Hide it once every
   * agent is done, failed, or already backgrounded.
   */
  private shouldShowDetachHint(snapshots: readonly ToolCallSubagentSnapshot[]): boolean {
    return snapshots.some(
      (s) =>
        s.phase === 'running' ||
        s.phase === 'queued' ||
        s.phase === 'spawning' ||
        s.phase === undefined,
    );
  }

  /** Releases throttle timers so destroyed components cannot refresh later. */
  override invalidate(): void {
    if (this._invalidating) {
      super.invalidate();
      return;
    }
    this._invalidating = true;
    this.flushRender();
    this._invalidating = false;
  }

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

function countPhases(snapshots: readonly ToolCallSubagentSnapshot[]): PhaseCounts {
  let done = 0;
  let failed = 0;
  let backgrounded = 0;
  let running = 0;
  let waiting = 0;
  let starting = 0;

  for (const snap of snapshots) {
    switch (snap.phase) {
      case 'done':
        done += 1;
        break;
      case 'failed':
        failed += 1;
        break;
      case 'backgrounded':
        backgrounded += 1;
        break;
      case 'queued':
        waiting += 1;
        break;
      case 'running':
        running += 1;
        break;
      case 'spawning':
      case undefined:
        starting += 1;
        break;
    }
  }

  return {
    done,
    failed,
    backgrounded,
    running,
    waiting,
    starting,
    terminal: done + failed + backgrounded,
  };
}

function formatBreakdownParts(counts: PhaseCounts): string[] {
  const parts: string[] = [];
  if (counts.done > 0) parts.push(`${String(counts.done)} done`);
  if (counts.failed > 0) parts.push(`${String(counts.failed)} failed`);
  if (counts.backgrounded > 0) parts.push(`${String(counts.backgrounded)} backgrounded`);
  if (counts.running > 0) parts.push(`${String(counts.running)} running`);
  if (counts.waiting > 0) parts.push(`${String(counts.waiting)} waiting`);
  if (counts.starting > 0) parts.push(`${String(counts.starting)} starting`);
  return parts;
}

function formatStats(snap: ToolCallSubagentSnapshot): string {
  const parts: string[] = [];
  if (snap.model !== undefined) parts.push(snap.model);
  if (snap.effort !== undefined) parts.push(snap.effort);
  parts.push(`${String(snap.toolCount)} tool ${snap.toolCount === 1 ? 'use' : 'uses'}`);
  if (snap.tokens > 0) parts.push(`${formatTokenCount(snap.tokens)} tokens`);
  return currentTheme.dim(` · ${parts.join(' · ')}`);
}

function formatAgentStatus(snap: ToolCallSubagentSnapshot): string {
  switch (snap.phase) {
    case 'done':
      return currentTheme.fg('success', 'Done');
    case 'failed': {
      const error = (snap.errorText ?? 'Failed').split('\n').at(0) ?? 'Failed';
      return currentTheme.fg('error', `Error: ${error}`);
    }
    case 'backgrounded':
      return currentTheme.dim('Running in the background');
    case 'queued':
    case 'spawning':
    case undefined:
      return currentTheme.dim('Initializing…');
    case 'running':
      return currentTheme.dim(snap.latestActivity ?? 'Still working…');
  }
}
