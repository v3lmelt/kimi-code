/**
 * Footer/status bar — multi-line status display at the bottom of the TUI.
 *
 * Layout (always two lines):
 *   Line 1: <mode pills> <goal> <model>  <esc to interrupt / ? for shortcuts>
 *   Line 2: <quota> <cache> <tasks> [transient hint]  context: N% (tokens/max)
 *
 * The default layout stays minimal: cwd and git badge are left out (still
 * available via `[status_line].items`), and the context readout only
 * appears once usage approaches the window limit.
 */

import { bumpVersion, type Component } from '@moonshot-ai/pi-tui';
import { truncateToWidth, visibleWidth } from '@moonshot-ai/pi-tui';
import chalk from 'chalk';
import { formatDuration } from '@moonshot-ai/kimi-code-oauth';
import { effectiveModelAlias } from '@moonshot-ai/kimi-code-sdk';

import { ALL_TIPS, type ToolbarTip } from '#/tui/constant/tips';
import { isManagedUsageProvider, isOpenCodeGoProvider } from '#/tui/constant/kimi-tui';
import { isRainbowDancing, renderDanceFooterModel } from '#/tui/easter-eggs/dance';
import { AUTO_ACCEPT_DARK, AUTO_ACCEPT_LIGHT, currentTheme } from '#/tui/theme';
import type { ColorPalette } from '#/tui/theme/colors';
import type { AppState, RunningAgentSummary } from '#/tui/types';
import {
  StatusLineCommandRunner,
  type StatusLinePayload,
} from '#/tui/utils/status-line-command';
import { QuotaRunner, type QuotaSnapshot } from '#/tui/utils/quota-runner';
import {
  createGitStatusCache,
  formatGitBadgeBase,
  formatPullRequestBadge,
  type GitStatus,
  type GitStatusCache,
} from '#/utils/git/git-status';
import {
  formatTokenCount,
  usagePercent,
  usagePercentFromRatio,
} from '#/utils/usage/usage-format';
import { isReducedMotion } from '#/tui/utils/accessibility';
import { rippleText } from '#/tui/utils/color';
import { turnOutputTokens } from '#/tui/utils/turn-usage';

const DEFAULT_STATUS_LINE_ITEMS = [
  'mode',
  'goal',
  'model',
  'quota',
  'cache',
  'tasks',
] as const;

/**
 * Slots that always stay on footer line 1 (mode/goal/model); every other
 * configured slot wraps onto line 2 so the model identity never gets pushed
 * off by quota/cache/tasks noise on narrow terminals.
 */
const PRIMARY_STATUS_SLOTS = new Set(['mode', 'goal', 'model']);

/** Claude-style TokenWarning appears once usage reaches this percentage. */
const CONTEXT_WARNING_MIN_PERCENT = 60;
/** Context readout appears only once usage reaches this percentage of the window. */
const CONTEXT_DISPLAY_MIN_PERCENT = 80;

const MAX_CWD_SEGMENTS = 3;
const GOAL_TIMER_INTERVAL_MS = 1_000;
/** Repaint cadence while the ultracode pill's yellow ripple is animating. */
const ULTRACODE_RIPPLE_INTERVAL_MS = 150;
/** Lighter yellow the ultracode ripple sweeps toward from `effortUltra`. */
const ULTRACODE_RIPPLE_LIGHT = '#FFE082';

// Toolbar tips — rotates every 10s. Most tips are short and pair up (two
// joined by " · ") when space allows; tips flagged `solo` are long or
// important enough to take the whole slot on their own. A `priority` weight
// makes a tip recur more often in the rotation (default 1). Width is always
// the final arbiter (a pair that doesn't fit falls back to its first tip).
const TIP_ROTATE_INTERVAL_MS = 10_000;
const TIP_SEPARATOR = ' · ';
const AGENT_TIMER_INTERVAL_MS = 1_000;
// Claude Code-style catch-up cadence for the main-agent token counter: the
// displayed value is nudged toward the true estimate in small steps so it
// scrolls smoothly instead of jumping straight to the final number.
const TOKEN_ANIMATION_INTERVAL_MS = 50;

/**
 * Expand tips into a rotation sequence using smooth weighted round-robin
 * (the nginx SWRR algorithm). Higher-`priority` tips appear more often while
 * staying evenly spread, so a tip generally does not land next to its own
 * duplicate. Deterministic and computed once at module load. Exported for
 * unit testing.
 */
export function buildWeightedTips(tips: readonly ToolbarTip[]): readonly ToolbarTip[] {
  const items = tips.map((t) => ({
    tip: t,
    weight: Math.max(1, Math.trunc(t.priority ?? 1)),
    current: 0,
  }));
  const total = items.reduce((sum, it) => sum + it.weight, 0);
  const seq: ToolbarTip[] = [];
  for (let n = 0; n < total; n++) {
    let best = items[0]!;
    for (const it of items) {
      it.current += it.weight;
      if (it.current > best.current) best = it;
    }
    best.current -= total;
    seq.push(best.tip);
  }
  return seq;
}

const ROTATION: readonly ToolbarTip[] = buildWeightedTips(ALL_TIPS);

function currentTipIndex(): number {
  return Math.floor(Date.now() / TIP_ROTATE_INTERVAL_MS);
}

/**
 * Pick the tip(s) for a rotation index over the weighted ROTATION sequence.
 * `primary` is always shown when it fits; `pair` (primary + next tip joined
 * by the separator) is offered for wide terminals. Pairing is skipped when
 * the current/next tip is `solo` or when the neighbour is a duplicate of the
 * current tip (which can happen at the wrap boundary), keeping long/important
 * tips on their own and avoiding "X | X".
 */
function tipsForIndex(index: number): { primary: string; pair: string | null } {
  const n = ROTATION.length;
  if (n === 0) return { primary: '', pair: null };
  const offset = ((index % n) + n) % n;
  const current = ROTATION[offset]!;
  if (n === 1 || current.solo) return { primary: current.text, pair: null };
  const next = ROTATION[(offset + 1) % n]!;
  if (next.solo || next.text === current.text) return { primary: current.text, pair: null };
  return { primary: current.text, pair: current.text + TIP_SEPARATOR + next.text };
}

/**
 * Footer goal badge, e.g. `[goal ● active · 4m · 7 turns]`. Only shown for a
 * live (active/paused) goal; terminal/no goal -> no badge. Turn count is a raw
 * count unless an explicit turn budget is set, in which case it shows used/limit.
 */
function formatGoalBadge(
  goal: AppState['goal'],
  colors: ColorPalette,
  wallClockMs?: number,
): string | null {
  if (goal === null || goal === undefined) return null;
  // Show the badge for every persisted, resumable status. `complete` clears the
  // goal, so it never reaches here; only the unset case returns null.
  if (goal.status !== 'active' && goal.status !== 'paused' && goal.status !== 'blocked') {
    return null;
  }
  const dotColor =
    goal.status === 'active'
      ? colors.primary
      : goal.status === 'blocked'
        ? colors.warning
        : colors.textMuted;
  const turns =
    goal.budget.turnBudget !== null
      ? `${goal.turnsUsed}/${goal.budget.turnBudget} turns`
      : `${goal.turnsUsed} ${goal.turnsUsed === 1 ? 'turn' : 'turns'}`;
  const label = `${goal.status} · ${formatBadgeElapsed(wallClockMs ?? goal.wallClockMs)} · ${turns}`;
  return (
    chalk.hex(colors.textMuted)('[goal ') +
    chalk.hex(dotColor)('●') +
    chalk.hex(colors.textMuted)(` ${label}]`)
  );
}

function formatBadgeElapsed(ms: number): string {
  const totalSeconds = Math.round(ms / 1000);
  if (totalSeconds < 60) return `${totalSeconds}s`;
  const minutes = Math.floor(totalSeconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h${minutes % 60}m`;
}

function formatFooterAgentElapsed(seconds: number): string {
  if (seconds < 60) return `${String(seconds)}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) {
    // Minute+second granularity (`1m10s`), dropping the seconds on exact
    // minutes so `60s` reads `1m` rather than `1m0s`.
    return `${String(minutes)}m${seconds % 60 > 0 ? `${String(seconds % 60)}s` : ''}`;
  }
  const hours = Math.floor(minutes / 60);
  return `${String(hours)}h${String(minutes % 60)}m`;
}

/**
 * Map workflow child rows (`workflow:<runId>:<agentId>`) to their tree-branch
 * kind so a run's agents render as `├──` branches under the run row, with
 * `└──` for the last child. Only children contiguously following their run
 * row count — an orphan (or non-contiguous) row keeps the plain bullet.
 */
function workflowBranchMap(
  agents: readonly RunningAgentSummary[],
): ReadonlyMap<string, 'mid' | 'last'> {
  const childrenByRun = new Map<string, string[]>();
  let currentRunId: string | undefined;
  for (const agent of agents) {
    if (!agent.id.startsWith('workflow:')) {
      currentRunId = undefined;
      continue;
    }
    const rest = agent.id.slice('workflow:'.length);
    const separator = rest.indexOf(':');
    if (separator === -1) {
      // The run row itself.
      currentRunId = rest;
      continue;
    }
    if (rest.slice(0, separator) !== currentRunId) continue;
    const children = childrenByRun.get(currentRunId) ?? [];
    children.push(agent.id);
    childrenByRun.set(currentRunId, children);
  }
  const branches = new Map<string, 'mid' | 'last'>();
  for (const ids of childrenByRun.values()) {
    ids.forEach((id, index) => {
      branches.set(id, index === ids.length - 1 ? 'last' : 'mid');
    });
  }
  return branches;
}

function modelDisplayName(state: AppState): string {
  const model = state.availableModels[state.model];
  const effective = model === undefined ? undefined : effectiveModelAlias(model);
  return effective?.displayName ?? effective?.model ?? state.model;
}

/**
 * Claude's autoAccept violet for the auto-mode pill. Light palettes use
 * near-black text tokens, so a quick brightness probe on `text` picks the
 * darker variant that keeps contrast on white.
 */
function autoAcceptColor(): string {
  const hex = currentTheme.palette.text;
  const r = Number.parseInt(hex.slice(1, 3), 16);
  const g = Number.parseInt(hex.slice(3, 5), 16);
  const b = Number.parseInt(hex.slice(5, 7), 16);
  return r + g + b < 3 * 128 ? AUTO_ACCEPT_LIGHT : AUTO_ACCEPT_DARK;
}

function shortenCwd(path: string): string {
  if (!path) return path;
  const home = process.env['HOME'] ?? '';
  let work = path;
  if (home && path === home) {
    return '~';
  }
  if (home && path.startsWith(home + '/')) {
    work = '~' + path.slice(home.length);
  }

  const segments = work.split('/').filter((s) => s.length > 0);
  if (segments.length <= MAX_CWD_SEGMENTS) return work;
  const tail = segments.slice(-MAX_CWD_SEGMENTS).join('/');
  return `…/${tail}`;
}

function contextPercent(usage: number, tokens?: number, maxTokens?: number): number {
  if (maxTokens !== undefined && maxTokens > 0 && tokens !== undefined) {
    return usagePercent(tokens, maxTokens);
  }
  return usagePercentFromRatio(usage);
}

/**
 * Footer context readout. Percent comes from the exact token counts when
 * both are known (the ratio can lag a step behind); otherwise it falls
 * back to the precomputed ratio. Counts use the shared 1024-based
 * formatter. Renders nothing until usage approaches the window limit so
 * the bottom line stays minimal for most of a session.
 */
function formatContextStatus(usage: number, tokens?: number, maxTokens?: number): string {
  const pct = contextPercent(usage, tokens, maxTokens);
  if (pct < CONTEXT_DISPLAY_MIN_PERCENT) return '';
  if (maxTokens !== undefined && maxTokens > 0 && tokens !== undefined) {
    return `context: ${pct}% (${formatTokenCount(tokens)}/${formatTokenCount(maxTokens)})`;
  }
  return `context: ${String(pct)}%`;
}

/**
 * Claude-style TokenWarning. Auto-compact is always on in this engine, so
 * the copy counts down to that event rather than prompting `/compact`.
 * Hidden while a compaction is already running.
 */
export function formatContextWarning(
  usage: number,
  tokens: number | undefined,
  maxTokens: number | undefined,
  isCompacting: boolean,
): string {
  if (isCompacting) return '';
  const pct = contextPercent(usage, tokens, maxTokens);
  if (pct < CONTEXT_WARNING_MIN_PERCENT) return '';
  if (pct < CONTEXT_DISPLAY_MIN_PERCENT) {
    return `${String(Math.max(0, 100 - pct))}% until auto-compact`;
  }
  return 'auto-compact soon';
}

export function formatFooterGitBadge(status: GitStatus, colors: ColorPalette): string {
  const base = chalk.hex(colors.textDim)(formatGitBadgeBase(status));
  if (status.pullRequest === null) return base;

  const pullRequest = chalk.hex(colors.primary)(
    formatPullRequestBadge(status.pullRequest, { linkPullRequest: true }),
  );
  return `${base} ${pullRequest}`;
}

export class FooterComponent implements Component {
  version = 0;
  private state: AppState;
  private readonly onRefresh: () => void;
  private gitCache: GitStatusCache;
  private gitCacheWorkDir: string;
  private transientHint: string | null = null;
  private goalSnapshotKey: string | null = null;
  private goalObservedAtMs = Date.now();
  private goalTimer: ReturnType<typeof setInterval> | null = null;
  /** Timer keeping the ultracode pill's yellow ripple repainting while active. */
  private ultracodeTimer: ReturnType<typeof setInterval> | null = null;
  /** Timer that keeps per-agent elapsed counters ticking while agents run. */
  private agentTimer: ReturnType<typeof setInterval> | null = null;
  /** Signature of the last elapsed readout the agent timer bumped for, so a
   *  settled footer isn't redrawn once a second for nothing. */
  private lastAgentElapsedSignature: string | null = null;
  /** Displayed main-agent token count, chased toward the estimate on each render. */
  private tokenDisplay = 0;
  /** Supplies the live streamed output-token estimate (see turn-usage.ts). */
  private tokenTargetProvider: (() => number) | undefined = undefined;
  /** Last time the catch-up animation advanced (for the 50ms throttle). */
  private tokenLastTickMs = 0;
  private statusLineRunner: StatusLineCommandRunner | null = null;
  /** Background quota snapshot source for the compact quota slot. */
  private quotaRunner: QuotaRunner | null = null;
  /** Non-terminal background-task counts split by kind so the footer can
   * render two distinct badges. `bashTasks` covers `bash-*` BPM tasks
   * spawned via `Shell run_in_background=true`; `agentTasks` covers
   * `agent-*` BPM tasks (background subagents); `workflowTasks` covers
   * `workflow` runs. Either zero hides its respective badge.
   */
  private backgroundBashTaskCount = 0;
  private backgroundAgentCount = 0;
  private backgroundWorkflowCount = 0;
  /** Live per-agent rows shown below the standard footer lines. */
  private runningAgents: readonly RunningAgentSummary[] = [];

  constructor(state: AppState, onRefresh: () => void = () => {}) {
    this.state = state;
    this.onRefresh = onRefresh;
    this.gitCacheWorkDir = state.workDir;
    this.gitCache = createGitStatusCache(state.workDir, { onChange: this.onRefresh });
    this.syncGoalClock(state.goal);
    this.syncGoalTimer(state.goal);
    this.syncStatusLineRunner(state);
    this.syncUltracodeTimer(state);
  }

  setState(state: AppState): void {
    if (state.workDir !== this.gitCacheWorkDir) {
      this.gitCacheWorkDir = state.workDir;
      this.gitCache = createGitStatusCache(state.workDir, { onChange: this.onRefresh });
    }
    this.syncGoalClock(state.goal);
    this.syncGoalTimer(state.goal);
    this.syncStatusLineRunner(state);
    this.syncUltracodeTimer(state);
    this.state = state;
    bumpVersion(this);
  }

  private syncStatusLineRunner(state: AppState): void {
    const command = state.statusLine?.command ?? null;
    if (command === null) {
      this.statusLineRunner?.dispose();
      this.statusLineRunner = null;
      return;
    }
    if (this.statusLineRunner?.command !== command) {
      // A reload can swap one command for another; the old runner would
      // otherwise keep executing the previous script until restart.
      this.statusLineRunner?.dispose();
      this.statusLineRunner = new StatusLineCommandRunner(command, this.onRefresh);
    }
  }

  /**
   * Replace the background quota snapshot source for the compact quota slot.
   * The previous runner is disposed first; passing `null` clears the slot.
   */
  setQuotaRunner(runner: QuotaRunner | null): void {
    if (this.quotaRunner === runner) return;
    this.quotaRunner?.dispose();
    this.quotaRunner = runner;
    bumpVersion(this);
  }

  /**
   * Short-lived hint shown at the bottom-left of footer line 2 (before the
   * context readout on the right). Used by the exit-confirmation double-tap
   * flow to show "Press Ctrl+C again to exit" without requiring a
   * toast/overlay subsystem. When secondary slots occupy line 2, the hint is
   * appended after them and dropped first if it does not fit.
   * Pass `null` to clear.
   */
  setTransientHint(hint: string | null): void {
    this.transientHint = hint;
    bumpVersion(this);
  }

  getTransientHint(): string | null {
    return this.transientHint;
  }

  /**
   * Sync both background-task badges with live counts. Each non-zero
   * count produces its own bracketed badge on line 1; zeros hide them
   * independently.
   */
  setBackgroundCounts(counts: {
    bashTasks: number;
    agentTasks: number;
    workflowTasks: number;
  }): void {
    this.backgroundBashTaskCount = Math.max(0, counts.bashTasks);
    this.backgroundAgentCount = Math.max(0, counts.agentTasks);
    this.backgroundWorkflowCount = Math.max(0, counts.workflowTasks);
    bumpVersion(this);
  }

  /**
   * Replace the per-agent rows rendered below the standard footer lines.
   * Passing an empty array hides the rows.
   */
  setRunningAgents(agents: readonly RunningAgentSummary[]): void {
    this.runningAgents = agents;
    this.syncAgentTimer();
    bumpVersion(this);
  }

  /**
   * Supply the live streamed output-token estimate for the in-flight turn. The
   * footer chases its displayed main-agent token count toward
   * `turnOutputTokens(turnUsage, estimate)` in small steps on each render
   * (throttled to ~50ms), so the counter scrolls smoothly like Claude Code's
   * without a dedicated timer — the footer is already redrawn ~120ms while the
   * activity spinner animates. The display is seeded to the current target on
   * set so an already-progressed turn (e.g. resume) shows real tokens
   * immediately. Pass `undefined` to stop animating (e.g. on shutdown).
   */
  setTokenEstimateProvider(provider: (() => number) | undefined): void {
    this.tokenTargetProvider = provider;
    if (provider === undefined) {
      this.stopTokenAnimation();
      return;
    }
    // Seed the display to the current target so the first render reflects
    // settled output instead of starting a long catch-up from 0.
    this.tokenDisplay = turnOutputTokens(this.state.turnUsage, provider());
    this.tokenLastTickMs = Date.now();
    bumpVersion(this);
  }

  /**
   * The main-agent token counter currently shown in the footer (the smoothed
   * `tokenDisplay`). The activity-spinner row reads this same value so both
   * display positions stay in lock-step instead of showing different totals.
   * While no turn is in flight the value falls back to the session-cumulative
   * output tokens (`sessionOutputTokens` on AppState, supplied by the state
   * layer; absent states read as 0), so an idle `main` row keeps its total.
   */
  getDisplayedMainTokens(): number {
    if (this.state.turnUsage !== undefined) return this.tokenDisplay;
    return this.state.sessionOutputTokens ?? 0;
  }

  private stopTokenAnimation(): void {
    this.tokenDisplay = 0;
    this.tokenLastTickMs = 0;
  }

  /**
   * Claude Code-style catch-up: nudge `tokenDisplay` toward the current target
   * by a small fixed/ratio step per tick, clamped so it never overshoots. A
   * shrinking target (turn reset) snaps down instead of animating backwards.
   * Called from `render` and throttled to `TOKEN_ANIMATION_INTERVAL_MS` so the
   * counter advances smoothly with the render cadence but never faster than
   * ~50ms per step.
   */
  private tickTokenAnimation(): void {
    if (this.tokenTargetProvider === undefined) return;
    const now = Date.now();
    if (now - this.tokenLastTickMs < TOKEN_ANIMATION_INTERVAL_MS) return;
    this.tokenLastTickMs = now;

    const before = this.tokenDisplay;
    const target = turnOutputTokens(this.state.turnUsage, this.tokenTargetProvider());
    if (target <= 0) {
      this.tokenDisplay = 0;
    } else if (target < this.tokenDisplay) {
      this.tokenDisplay = target;
    } else {
      const gap = target - this.tokenDisplay;
      if (gap > 0) {
        const increment =
          gap < 70 ? 3 : gap < 200 ? Math.max(8, Math.ceil(gap * 0.15)) : 50;
        this.tokenDisplay = Math.min(this.tokenDisplay + increment, target);
      }
    }
    // Only a display change is worth a re-render: once caught up to the target
    // (stream paused / settled) stop bumping, so the footer stops redrawing the
    // same line on every frame while the estimate keeps coming in.
    if (this.tokenDisplay !== before) bumpVersion(this);
  }

  /**
   * Deterministic snapshot of the time-driven part of the agent rows — the
   * elapsed readout per rendered row. Every other row input (name, phase,
   * tokens, activity) changes only through `setRunningAgents`, which bumps the
   * footer on its own; the 1s timer exists solely to advance elapsed readouts,
   * so this is all it needs to compare between ticks.
   */
  private agentElapsedSignature(): string {
    const now = Date.now();
    const parts: string[] = [];
    if (this.state.streamingPhase !== 'idle') {
      const seconds = Math.max(0, Math.floor((now - (this.state.streamingStartTime ?? now)) / 1000));
      parts.push(`main:${formatFooterAgentElapsed(seconds)}`);
    }
    for (const agent of this.runningAgents) {
      const seconds = Math.max(0, Math.floor((now - agent.startedAtMs) / 1000));
      parts.push(`${agent.id}:${formatFooterAgentElapsed(seconds)}`);
    }
    return parts.join('|');
  }

  private syncAgentTimer(): void {
    const needsTimer = this.runningAgents.length > 0;
    if (!needsTimer) {
      if (this.agentTimer !== null) {
        clearInterval(this.agentTimer);
        this.agentTimer = null;
      }
      this.lastAgentElapsedSignature = null;
      return;
    }
    if (this.agentTimer !== null) return;
    const requestRender = this.onRefresh;
    this.agentTimer = setInterval(() => {
      // Only bump when the elapsed readout actually changed. `formatFooterAgentElapsed`
      // now shows second granularity below a minute and minute+seconds above it, so
      // a run's elapsed text changes every second — the signature check stays so a
      // tick that did not cross a whole-second boundary still skips the redraw
      // (byte-identical output never forces one).
      const signature = this.agentElapsedSignature();
      if (signature !== this.lastAgentElapsedSignature) {
        this.lastAgentElapsedSignature = signature;
        bumpVersion(this);
        requestRender();
      }
    }, AGENT_TIMER_INTERVAL_MS);
    this.agentTimer.unref?.();
  }

  invalidate(): void {
    bumpVersion(this);
  }

  render(width: number): string[] {
    const colors = currentTheme.palette;
    const state = this.state;

    // Advance the main-agent token counter's catch-up animation before reading
    // it below; throttled to ~50ms so it scrolls smoothly with the render
    // cadence (the spinner redraws ~120ms while animating).
    this.tickTokenAnimation();

    // ── Line 1: primary slots (mode/goal/model) or a user command ──
    let line1: string;
    let customLine: string | null = null;
    if (this.statusLineRunner !== null) {
      this.statusLineRunner.maybeRefresh(this.statusLinePayload());
      customLine = this.statusLineRunner.current();
    }

    // Secondary slots (quota/cache/tasks/cwd/git/…) render on line 2. With a
    // custom status_line.command the whole status readout is suppressed,
    // leaving line 2 to the transient hint + context as before.
    let secondaryLine = '';
    if (customLine !== null) {
      // status_line.command: the first stdout line takes over line 1.
      line1 = chalk.hex(colors.text)(customLine);
    } else {
      const slots = this.buildSlots(colors);
      const configured = this.state.statusLine?.items ?? null;
      const order: readonly string[] = configured ?? DEFAULT_STATUS_LINE_ITEMS;
      const primary: string[] = [];
      const secondary: string[] = [];
      for (const slot of order) {
        const pieces = slots[slot];
        if (pieces !== undefined) {
          (PRIMARY_STATUS_SLOTS.has(slot) ? primary : secondary).push(...pieces);
        }
      }
      secondaryLine = secondary.join('  ');

      const leftLine = primary.join('  ');
      const leftWidth = visibleWidth(leftLine);

      // Claude-style right hint on the default layout: 'esc to interrupt'
      // while a turn is running, '? for shortcuts' when idle. Configured
      // status_line layouts (including an inline 'tips' slot) suppress it,
      // matching Claude's behaviour around custom status lines.
      let hintText = '';
      if (configured === null) {
        const hint =
          state.streamingPhase !== 'idle' || state.isCompacting
            ? 'esc to interrupt'
            : '? for shortcuts';
        const gap = 2;
        if (leftWidth + gap + visibleWidth(hint) <= width) {
          hintText = hint;
        }
      }

      if (hintText) {
        const pad = width - leftWidth - visibleWidth(hintText);
        line1 = leftLine + ' '.repeat(Math.max(0, pad)) + chalk.hex(colors.textDim)(hintText);
      } else if (leftWidth <= width) {
        line1 = leftLine;
      } else {
        line1 = truncateToWidth(leftLine, width, '…');
      }
    }

    // ── Line 2: secondary slots + transient hint (left) + context (right) ──
    const contextStatus = formatContextStatus(
      state.contextUsage,
      state.contextTokens,
      state.maxContextTokens,
    );
    const contextWarning = formatContextWarning(
      state.contextUsage,
      state.contextTokens,
      state.maxContextTokens,
      state.isCompacting,
    );
    const contextParts: string[] = [];
    if (contextStatus) contextParts.push(chalk.hex(colors.text)(contextStatus));
    if (contextWarning) contextParts.push(chalk.hex(colors.textDim)(contextWarning));
    const contextText = contextParts.join(' · ');
    const contextWidth = visibleWidth(contextText);
    const maxLeftWidth = Math.max(0, width - contextWidth - 1);
    let line2: string;
    if (secondaryLine) {
      // Secondary slots take the left side; the transient hint is appended
      // only when it fits, and is the first thing dropped under pressure so
      // the quota/cache/cwd/git readout stays intact.
      let left = secondaryLine;
      if (this.transientHint) {
        const combined = `${secondaryLine}  ${this.transientHint}`;
        if (visibleWidth(combined) <= maxLeftWidth) left = combined;
      }
      left = truncateToWidth(left, maxLeftWidth, '…');
      const leftWidth = visibleWidth(left);
      const pad = Math.max(0, width - leftWidth - contextWidth);
      line2 = left + ' '.repeat(pad) + contextText;
    } else if (this.transientHint) {
      const maxHintWidth = Math.max(0, width - contextWidth - 1);
      const shownHint =
        visibleWidth(this.transientHint) <= maxHintWidth
          ? this.transientHint
          : truncateToWidth(this.transientHint, maxHintWidth, '…');
      const hintWidth = visibleWidth(shownHint);
      const pad = Math.max(0, width - hintWidth - contextWidth);
      line2 = chalk.hex(colors.warning).bold(shownHint) + ' '.repeat(pad) + contextText;
    } else {
      const leftPad = Math.max(0, width - contextWidth);
      line2 = ' '.repeat(leftPad) + contextText;
    }

    // ── Agent status rows: one line per running agent when details exist ──
    const agentLines = this.renderAgentLines(width, colors);

    return [
      truncateToWidth(line1, width),
      truncateToWidth(line2, width),
      ...agentLines.map((line) => truncateToWidth(line, width)),
    ];
  }

  /**
   * Footer agent status rows. One line per running agent, with the main session
   * agent rendered first. Gated on at least one agent running (subagent or
   * background task): with `runningAgents` empty the footer keeps its two
   * standard lines even while a turn is active. When agents run, an idle `main`
   * row is still shown when the main agent is idle so the footer never lists
   * subagents without their root.
   */
  private renderAgentLines(width: number, colors: ColorPalette): string[] {
    if (this.runningAgents.length === 0) return [];
    const lines: string[] = [];
    const main = this.mainAgentSummary(colors, width);
    if (main !== undefined) {
      lines.push(main);
    } else if (this.runningAgents.length > 0) {
      // Keep `main` visible as the root row even while it is idle.
      const idleMain: RunningAgentSummary = {
        id: 'main',
        name: 'main',
        phase: 'running',
        startedAtMs: Date.now(),
        // Session-cumulative output tokens once idle (0 before any turn).
        tokens: this.getDisplayedMainTokens(),
      };
      lines.push(this.formatAgentLine(idleMain, true, colors, width));
    }
    // Workflow child rows render as tree branches under their run row.
    const branches = workflowBranchMap(this.runningAgents);
    for (const agent of this.runningAgents) {
      lines.push(this.formatAgentLine(agent, false, colors, width, branches.get(agent.id)));
    }
    return lines;
  }

  private mainAgentSummary(colors: ColorPalette, width: number): string | undefined {
    if (this.state.streamingPhase === 'idle') return undefined;
    const summary: RunningAgentSummary = {
      id: 'main',
      name: 'main',
      phase: this.state.streamingPhase === 'waiting' ? 'waiting' : 'running',
      startedAtMs: this.state.streamingStartTime,
      // Display-only count chased toward the estimate by the 50ms animation
      // timer (input tokens excluded — see getDisplayedMainTokens).
      tokens: this.getDisplayedMainTokens(),
    };
    return this.formatAgentLine(summary, true, colors, width);
  }

  private formatAgentLine(
    agent: RunningAgentSummary,
    isMain: boolean,
    colors: ColorPalette,
    width: number,
    branch?: 'mid' | 'last',
  ): string {
    let bullet: string;
    if (isMain) {
      bullet = chalk.hex(colors.primary)('●');
    } else if (branch !== undefined) {
      bullet = chalk.hex(colors.textDim)(branch === 'last' ? '└──' : '├──');
    } else {
      bullet = chalk.hex(colors.textDim)('○');
    }
    const name = chalk.hex(colors.text)(agent.name);
    const leftParts: string[] = [bullet, name];

    if (agent.description !== undefined && agent.description.length > 0) {
      leftParts.push(chalk.hex(colors.textDim)(agent.description));
    }

    if (agent.latestActivity !== undefined && agent.latestActivity.length > 0) {
      leftParts.push(chalk.hex(colors.textDim)(`→ ${agent.latestActivity}`));
    }
    const left = leftParts.join(' ');

    // Right-fixed stats: elapsed + token count. The stats are preserved at the
    // cost of truncating the middle activity text, matching line2's
    // right-aligned context readout instead of tail-truncating the whole row.
    const elapsedSeconds = Math.max(0, Math.floor((Date.now() - agent.startedAtMs) / 1000));
    const stats: string[] = [];
    if (elapsedSeconds > 0) {
      stats.push(formatFooterAgentElapsed(elapsedSeconds));
    }
    if (agent.tokens > 0) {
      stats.push(`↓ ${formatTokenCount(agent.tokens)} tok`);
    }
    const statsText = chalk.hex(colors.textDim)(stats.join(' '));
    if (statsText.length === 0) {
      return truncateToWidth(left, Math.max(1, width), '…');
    }

    // Cap stats at half the row so a narrow terminal keeps room for the left.
    const maxStatsWidth = Math.max(1, Math.floor(width / 2));
    const shownStats = truncateToWidth(statsText, maxStatsWidth);
    const leftWidth = Math.max(0, width - visibleWidth(shownStats) - 1);
    const shownLeft = truncateToWidth(left, Math.max(1, leftWidth), '…');
    const pad = Math.max(0, width - visibleWidth(shownLeft) - visibleWidth(shownStats));
    return shownLeft + ' '.repeat(pad) + shownStats;
  }

  /**
   * Ultracode mode pill (yellow). When motion is
   * allowed, the label ripples through a per-character yellow sweep on a 2s
   * wall-clock loop; under reduced motion it stays a static yellow pill.
   */
  private renderUltracodePill(): string {
    const hex = currentTheme.palette.effortUltra;
    if (isReducedMotion()) return chalk.hex(hex).bold('ultracode');
    return rippleText('ultracode', hex, ULTRACODE_RIPPLE_LIGHT, Date.now(), true);
  }

  /**
   * Rendered pieces per status-line slot. Empty-content slots (e.g. no goal,
   * outside a git repo) yield an empty list so composition just skips them.
   */
  private buildSlots(colors: ColorPalette): Record<string, string[]> {
    const state = this.state;
    const slots: Record<string, string[]> = {
      mode: [],
      goal: [],
      model: [],
      quota: [],
      cache: [],
      tasks: [],
      cwd: [],
      git: [],
      tips: [],
    };

    {
      const { primary, pair } = tipsForIndex(currentTipIndex());
      const tip = pair ?? primary;
      if (tip) slots['tips'] = [chalk.hex(colors.textMuted)(tip)];
    }

    const modes: string[] = [];
    if (state.permissionMode === 'auto')
      modes.push(chalk.hex(autoAcceptColor())('⏵⏵ auto-accept edits on'));
    if (state.permissionMode === 'yolo')
      modes.push(chalk.hex(colors.error)('⏵⏵ bypass permissions on'));
    // Auto/yolo imply plan mode is off (the ACP 4-mode taxonomy), so never
    // render the plan pill alongside a permission pill even if the session
    // reports a stale planMode.
    if (state.planMode && state.permissionMode !== 'auto' && state.permissionMode !== 'yolo')
      modes.push(chalk.hex(colors.primary)('⏸ plan mode on'));
    if (state.swarmMode) modes.push(chalk.hex(colors.accent).bold('swarm'));
    if (state.ultracode) modes.push(this.renderUltracodePill());
    if (modes.length > 0) slots['mode'] = [modes.join(' ')];

    const goalBadge = formatGoalBadge(state.goal, colors, this.goalWallClockMs(state.goal));
    if (goalBadge !== null) slots['goal'] = [goalBadge];

    const model = modelDisplayName(state);
    if (model) {
      const effort = state.thinkingEffort;
      const rawCurrentModel = state.availableModels[state.model];
      const currentModel =
        rawCurrentModel === undefined ? undefined : effectiveModelAlias(rawCurrentModel);
      // Only effort-capable models (those declaring support_efforts) show the
      // bare effort value (`model max`); legacy boolean models keep the plain
      // "thinking" suffix.
      const hasEfforts = (currentModel?.supportEfforts?.length ?? 0) > 0;
      const thinkingLabel =
        effort !== 'off'
          ? hasEfforts && effort !== 'on'
            ? ` ${effort}`
            : ' thinking'
          : '';
      const modelLabel = `${model}${thinkingLabel}`;
      let renderedModelLabel = chalk.hex(colors.text)(modelLabel);
      if (isRainbowDancing()) {
        renderedModelLabel = renderDanceFooterModel(modelLabel);
      }
      slots['model'] = [renderedModelLabel];
    }

    const quota = this.buildQuotaSlot(colors);
    if (quota.length > 0) slots['quota'] = quota;

    const cache = this.buildCacheSlot(colors);
    if (cache.length > 0) slots['cache'] = cache;

    // Background-task badges. `bash-*` tasks (shell processes) are shown as a
    // count; `agent-*` tasks show a compact count on line 1 regardless of the
    // detailed per-agent rows below — the badge stays visible even while a
    // foreground subagent occupies the rows, so a background agent can never
    // silently disappear.
    const taskBadges: string[] = [];
    if (this.backgroundBashTaskCount > 0) {
      const noun = this.backgroundBashTaskCount === 1 ? 'task' : 'tasks';
      taskBadges.push(
        chalk.hex(colors.primary)(`[${String(this.backgroundBashTaskCount)} ${noun} running]`),
      );
    }
    if (this.backgroundAgentCount > 0) {
      const noun = this.backgroundAgentCount === 1 ? 'agent' : 'agents';
      taskBadges.push(
        chalk.hex(colors.primary)(`[${String(this.backgroundAgentCount)} ${noun} running]`),
      );
    }
    if (this.backgroundWorkflowCount > 0) {
      const noun = this.backgroundWorkflowCount === 1 ? 'workflow' : 'workflows';
      taskBadges.push(
        chalk.hex(colors.primary)(`[${String(this.backgroundWorkflowCount)} ${noun} running]`),
      );
    }
    slots['tasks'] = taskBadges;

    const cwd = shortenCwd(state.workDir);
    if (cwd) slots['cwd'] = [chalk.hex(colors.textDim)(cwd)];

    const git = this.gitCache.getStatus();
    if (git !== null) slots['git'] = [formatFooterGitBadge(git, colors)];

    return slots;
  }

  /**
   * Compact rolling/weekly usage readout for quota providers (opencode-go and
   * the kimi managed provider). Renders nothing when the current provider has
   * no quota data, the runner has not landed a snapshot yet, or a row carries
   * no usable ratio. Never throws: every row is guarded before formatting.
   */
  private buildQuotaSlot(colors: ColorPalette): string[] {
    const provider = this.state.availableModels[this.state.model]?.provider;
    if (!isOpenCodeGoProvider(provider) && !isManagedUsageProvider(provider)) return [];
    const snapshot: QuotaSnapshot | null | undefined = this.quotaRunner?.current();
    if (snapshot === null || snapshot === undefined || snapshot.rows.length === 0) return [];

    const parts: string[] = [];
    for (const row of snapshot.rows) {
      if (!Number.isFinite(row.used) || row.limit <= 0) continue;
      const pct = Math.round((row.used / row.limit) * 100);
      const symbol = row.unit === 'week' ? '◑' : '◱';
      let text = `${symbol} ${String(pct)}%`;
      if (row.resetAt !== undefined) {
        const parsed = Date.parse(row.resetAt);
        if (Number.isFinite(parsed)) {
          text += ` (${formatDuration(Math.floor((parsed - Date.now()) / 1000))})`;
        }
      }
      parts.push(chalk.hex(colors.textDim)(text));
    }
    return parts.length > 0 ? [parts.join('  ')] : [];
  }

  /**
   * Session prompt-cache hit rate, e.g. `cache 62%`. The rate is the share of
   * input tokens served from the provider cache (cache-read tokens over all
   * input tokens — read + creation + uncached), matching the vis analysis
   * definition. Renders nothing until a step with exact usage has completed;
   * never throws (every term is guarded before dividing).
   */
  private buildCacheSlot(colors: ColorPalette): string[] {
    const cache = this.state.sessionCacheUsage;
    if (cache === undefined) return [];
    const total = cache.inputOther + cache.inputCacheRead + cache.inputCacheCreation;
    if (!Number.isFinite(total) || total <= 0) return [];
    const pct = Math.round((cache.inputCacheRead / total) * 100);
    return [chalk.hex(colors.textDim)(`cache ${String(pct)}%`)];
  }

  private statusLinePayload(): StatusLinePayload {
    const state = this.state;
    return {
      model: modelDisplayName(state),
      cwd: state.workDir,
      gitBranch: this.gitCache.getStatus()?.branch ?? null,
      permissionMode: state.permissionMode,
      planMode: state.planMode,
      contextUsage: state.contextUsage,
      contextTokens: state.contextTokens,
      maxContextTokens: state.maxContextTokens,
      sessionId: state.sessionId,
      version: state.version,
    };
  }

  private syncGoalClock(goal: AppState['goal']): void {
    const key = goalSnapshotKey(goal);
    if (key === this.goalSnapshotKey) return;
    this.goalSnapshotKey = key;
    this.goalObservedAtMs = Date.now();
  }

  private syncGoalTimer(goal: AppState['goal']): void {
    if (goal?.status === 'active') {
      if (this.goalTimer !== null) return;
      this.goalTimer = setInterval(() => {
        bumpVersion(this);
        this.onRefresh();
      }, GOAL_TIMER_INTERVAL_MS);
      this.goalTimer.unref?.();
      return;
    }

    if (this.goalTimer !== null) {
      clearInterval(this.goalTimer);
      this.goalTimer = null;
    }
  }

  /**
   * Keeps the ultracode pill's yellow ripple repainting while ultracode mode
   * is active and motion is allowed. Stops the timer when the mode exits or
   * the user prefers reduced motion — the pill then renders static.
   */
  private syncUltracodeTimer(state: AppState): void {
    const animate = state.ultracode === true && !isReducedMotion();
    if (animate) {
      if (this.ultracodeTimer !== null) return;
      this.ultracodeTimer = setInterval(() => {
        bumpVersion(this);
        this.onRefresh();
      }, ULTRACODE_RIPPLE_INTERVAL_MS);
      this.ultracodeTimer.unref?.();
      return;
    }
    if (this.ultracodeTimer !== null) {
      clearInterval(this.ultracodeTimer);
      this.ultracodeTimer = null;
    }
  }

  dispose(): void {
    if (this.goalTimer !== null) {
      clearInterval(this.goalTimer);
      this.goalTimer = null;
    }
    if (this.ultracodeTimer !== null) {
      clearInterval(this.ultracodeTimer);
      this.ultracodeTimer = null;
    }
    if (this.agentTimer !== null) {
      clearInterval(this.agentTimer);
      this.agentTimer = null;
    }
    this.quotaRunner?.dispose();
    this.quotaRunner = null;
    this.stopTokenAnimation();
  }

  private goalWallClockMs(goal: AppState['goal']): number | undefined {
    if (goal === null || goal === undefined) return undefined;
    if (goal.status !== 'active') return goal.wallClockMs;
    return goal.wallClockMs + Math.max(0, Date.now() - this.goalObservedAtMs);
  }
}

function goalSnapshotKey(goal: AppState['goal']): string | null {
  if (goal === null || goal === undefined) return null;
  return [
    goal.goalId,
    goal.status,
    goal.terminalReason ?? '',
    String(goal.turnsUsed),
    String(goal.tokensUsed),
    String(goal.wallClockMs),
    String(goal.budget.tokenBudget),
    String(goal.budget.turnBudget),
    String(goal.budget.wallClockBudgetMs),
  ].join('\u0000');
}
