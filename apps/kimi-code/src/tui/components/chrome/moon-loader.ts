import { Text, truncateToWidth, visibleWidth } from '@moonshot-ai/pi-tui';
import type { TUI } from '@moonshot-ai/pi-tui';
import chalk from 'chalk';

import { SPINNER_FRAMES } from '#/tui/constant/rendering';
import { randomSpinnerVerb } from '#/tui/constant/spinner-verbs';
import { currentTheme } from '#/tui/theme';
import { isReducedMotion } from '#/tui/utils/accessibility';
import { interpolateHexColor } from '#/tui/utils/color';

export type SpinnerStyle = 'moon' | 'braille';

/** Activity-pane mode driving per-mode animation timing and status treatment. */
export type LoaderMode = 'waiting' | 'thinking' | 'composing' | 'tool' | 'compacting';

/** Stall input: `lastActivityAtMs` is the last time the model produced output. */
export interface StallInput {
  lastActivityAtMs: number;
  hasActiveTools: boolean;
}

const STALL_THRESHOLD_MS = 10_000;
const STALL_FADE_MS = 10_000;

// Glimmer sweep: a brighter band travels across the label. Same palette idea as
// Claude's GlimmerMessage — base dim, highlight strong — but with a simpler
// ±1-column band driven by wall-clock.
const GLIMMER_CYCLE_PAD = 20;
const GLIMMER_BAND = 1;

// Thinking glow: pulse between two greys (Claude's THINKING_INACTIVE↔SHIMMER).
const THINKING_INACTIVE = '#999999';
const THINKING_SHIMMER = '#b9b9b9';
const GLOW_PERIOD_S = 2;

// Long-thinking emphasis: after ~10s of continuous thinking the glow and label
// start blending toward the palette warning colour, ramping over the next 10s
// and going bold once the ramp passes the halfway point (Claude's long-thinking
// amber/bold treatment).
const THINKING_INTENSITY_START_MS = 10_000;
const THINKING_INTENSITY_RAMP_MS = 10_000;

// Thinking phrase ladder: the label climbs through these phrases the longer a
// single thinking run takes (wall-clock thresholds in ms).
const THINKING_PHRASE_THRESHOLDS = [10_000, 20_000, 30_000, 45_000] as const;
const THINKING_PHRASES = [
  'thinking',
  'still thinking',
  'thinking more',
  'thinking some more',
  'almost done thinking',
] as const;

// Glyph sweep: wall-clock cosine ping-pong period (ms) that drives the frame
// position along the ping-pong SPINNER_FRAMES array. The cosine is flat at its
// extrema, so the sequence dwells at the two ends instead of stepping.
const GLYPH_SWEEP_MS = 2_000;

// Adaptive clock: the spinner tick runs faster while a request is in flight
// (`waiting`), and calms to 100ms while the model is streaming/composing.
const TICK_REQUESTING_MS = 50;
const TICK_CALM_MS = 100;

const COMPACT_PROGRESS_WIDTH = 24;
const COMPACT_PROGRESS_BLOCK_WIDTH = 5;

export function thinkingPhraseForElapsed(elapsedMs: number): string {
  let index = 0;
  for (let i = 0; i < THINKING_PHRASE_THRESHOLDS.length; i++) {
    if (elapsedMs >= THINKING_PHRASE_THRESHOLDS[i]!) index = i + 1;
  }
  return THINKING_PHRASES[index] ?? THINKING_PHRASES[0];
}

export class MoonLoader extends Text {
  private intervalId: ReturnType<typeof setInterval> | null = null;
  private ui: TUI;
  private colorFn: (s: string) => string;
  private label: string;
  private displayText = '';
  private retryText = '';
  private progressText = '';
  private tipText = '';
  // Inline text used when the spinner is embedded into another line (e.g. the
  // agent-swarm progress status line). It intentionally excludes the tip and
  // the random fallback verb: the host row supplies its own status text, and
  // extra copy would get squeezed against whatever follows the inline spinner
  // (like the swarm progress bar).
  private inlineText = '';
  private tip: string = '';
  // Optional live status suffix (e.g. per-turn token counters) recomputed on
  // every spinner frame, so it ticks without any extra timer.
  private statusProvider?: () => string;
  // Optional stall input (spinner turns red after a stall). Recomputed on each
  // frame like the status provider.
  private stallProvider?: () => StallInput;
  // Optional thinking-state signal driving the `thinking` glow on the status.
  private thinkingStatusProvider?: () => 'thinking' | number | null;
  // Optional wall-clock start of the current thinking run, driving the
  // long-thinking intensity ramp and the thinking phrase ladder.
  private thinkingStartProvider?: () => number | undefined;
  // Optional live retry/rate-limit line (e.g. `Retrying in 5s · attempt 2/3`)
  // shown instead of the normal status suffix while a step is retrying.
  private retryStatusProvider?: () => string;
  private mode: LoaderMode = 'waiting';
  private availableWidth = 0;
  // Claude Code-style working verb shown when the caller never set a label.
  // Picked once per loader so it stays stable for the whole run.
  private readonly fallbackVerb = `${randomSpinnerVerb()}…`;

  constructor(
    ui: TUI,
    // Legacy style key kept for call-site/state compatibility — both styles
    // render Claude's frame set at 120ms now.
    style: SpinnerStyle = 'moon',
    colorFn?: (s: string) => string,
    label: string = '',
  ) {
    super('', 1, 0);
    this.ui = ui;
    void style;
    this.colorFn = colorFn ?? ((s) => currentTheme.fg('primary', s));
    this.label = label;
    this.start();
  }

  start(): void {
    this.updateDisplay();
    this.restartTick();
  }

  stop(): void {
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
    }
  }

  /** (Re)start the adaptive tick at the current mode's beat. */
  private restartTick(): void {
    this.stop();
    this.intervalId = setInterval(() => {
      this.updateDisplay();
    }, this.tickMs());
  }

  /** Tick beat: faster while a request is in flight, calmer while streaming. */
  private tickMs(): number {
    return this.mode === 'waiting' ? TICK_REQUESTING_MS : TICK_CALM_MS;
  }

  dispose(): void {
    this.stop();
  }

  setLabel(label: string): void {
    this.label = label;
    this.updateDisplay();
  }

  setColorFn(colorFn: (s: string) => string): void {
    this.colorFn = colorFn;
    this.updateDisplay();
  }

  setTip(tip: string): void {
    this.tip = tip;
    this.updateDisplay();
  }

  setStatusProvider(provider: (() => string) | undefined): void {
    this.statusProvider = provider;
    this.updateDisplay();
  }

  setStallProvider(provider: (() => StallInput) | undefined): void {
    this.stallProvider = provider;
    this.updateDisplay();
  }

  setThinkingStatusProvider(provider: (() => 'thinking' | number | null) | undefined): void {
    this.thinkingStatusProvider = provider;
    this.updateDisplay();
  }

  setThinkingStartProvider(provider: (() => number | undefined) | undefined): void {
    this.thinkingStartProvider = provider;
    this.updateDisplay();
  }

  setRetryStatusProvider(provider: (() => string) | undefined): void {
    this.retryStatusProvider = provider;
    this.updateDisplay();
  }

  /** Switch the per-mode animation timing and status treatment. */
  setMode(mode: LoaderMode): void {
    if (this.mode === mode) return;
    this.mode = mode;
    this.restartTick();
    this.updateDisplay();
  }

  setAvailableWidth(width: number): void {
    if (this.availableWidth === width) return;
    this.availableWidth = width;
    this.updateDisplay();
  }

  renderInline(): string {
    return this.inlineText;
  }

  // ---------------------------------------------------------------------------
  // Animation state
  // ---------------------------------------------------------------------------

  /** Wall-clock cosine ping-pong → frame index along the SPINNER_FRAMES array.
   *  The cosine is flat at its extrema, so the glyph dwells at both ends. */
  private glyphFrame(): number {
    const sweep = (1 - Math.cos((Date.now() / GLYPH_SWEEP_MS) * Math.PI * 2)) / 2;
    return Math.round(sweep * (SPINNER_FRAMES.length - 1));
  }

  /** 0..1 long-thinking emphasis: ramps up after THINKING_INTENSITY_START_MS of
   *  continuous thinking, reaching 1 after the ramp. 0 when not thinking. */
  private thinkingIntensity(reduced: boolean): number {
    if (reduced) return 0;
    if (this.thinkingStatusProvider?.() !== 'thinking') return 0;
    const start = this.thinkingStartProvider?.();
    if (start === undefined) return 0;
    const elapsed = Date.now() - start - THINKING_INTENSITY_START_MS;
    return Math.min(Math.max(elapsed / THINKING_INTENSITY_RAMP_MS, 0), 1);
  }

  private stallIntensity(reduced: boolean): number {
    if (reduced) return 0;
    const input = this.stallProvider?.();
    if (input === undefined) return 0;
    if (
      input.lastActivityAtMs <= 0 ||
      input.hasActiveTools ||
      this.mode === 'thinking' ||
      this.mode === 'compacting' ||
      this.thinkingStatusProvider?.() === 'thinking'
    ) {
      return 0;
    }
    const stallMs = Date.now() - input.lastActivityAtMs;
    if (stallMs <= STALL_THRESHOLD_MS) return 0;
    return Math.min((stallMs - STALL_THRESHOLD_MS) / STALL_FADE_MS, 1);
  }

  private colorFrame(char: string, stall: number, reduced: boolean): string {
    if (reduced) return currentTheme.fg('primary', char);
    if (stall > 0) return this.stallColor(char, stall);
    return this.colorFn(char);
  }

  private colorLabel(text: string, stall: number, reduced: boolean): string {
    if (reduced) return currentTheme.fg('textDim', text);
    if (stall > 0) return this.stallColor(text, stall);
    const intensity = this.thinkingIntensity(reduced);
    return this.glimmerText(text, intensity);
  }

  private colorStatus(status: string, reduced: boolean): string {
    if (reduced) return currentTheme.fg('textDim', status);
    if (this.thinkingStatusProvider?.() === 'thinking') {
      return this.thinkingText(status, this.thinkingIntensity(reduced));
    }
    return currentTheme.fg('textDim', status);
  }

  /** Fade a plain-text span from primary toward the error red as it stalls. */
  private stallColor(text: string, intensity: number): string {
    if (intensity >= 1) return currentTheme.fg('error', text);
    const base = currentTheme.color('primary');
    const err = currentTheme.color('error');
    return chalk.hex(interpolateHexColor(base, err, intensity))(text);
  }

  /** A brighter ±1-column band sweeping across the label over wall-clock.
   *  Long thinking pulls the highlight toward the palette warning colour and
   *  goes bold once the intensity ramp passes its midpoint. */
  private glimmerText(text: string, intensity: number): string {
    const width = visibleWidth(text);
    if (width === 0) return text;
    const cycle = width + GLIMMER_CYCLE_PAD;
    const stepMs = this.mode === 'waiting' ? 50 : 200;
    const step = Math.floor(Date.now() / stepMs) % cycle;
    const center = this.mode === 'waiting' ? step - 10 : cycle - step - 10;
    const strong =
      intensity > 0
        ? interpolateHexColor(currentTheme.color('textStrong'), currentTheme.color('warning'), intensity)
        : currentTheme.color('textStrong');
    let out = '';
    let col = 0;
    for (const ch of text) {
      const w = visibleWidth(ch);
      const lit = col >= center - GLIMMER_BAND && col <= center + GLIMMER_BAND;
      out += lit ? chalk.hex(strong)(ch) : currentTheme.fg('textDim', ch);
      col += w;
    }
    return intensity > 0.5 ? chalk.bold(out) : out;
  }

  /** Status glow while thinking: pulse between two greys, blending toward the
   *  palette warning colour as thinking drags on; bold past the ramp midpoint. */
  private thinkingText(text: string, intensity: number): string {
    const opacity = (Math.sin((Date.now() / 1000) * Math.PI * 2 * (1 / GLOW_PERIOD_S)) + 1) / 2;
    let hex = interpolateHexColor(THINKING_INACTIVE, THINKING_SHIMMER, opacity);
    if (intensity > 0) {
      hex = interpolateHexColor(hex, currentTheme.color('warning'), intensity);
    }
    const colored = chalk.hex(hex)(text);
    return intensity > 0.5 ? chalk.bold(colored) : colored;
  }

  // ---------------------------------------------------------------------------
  // Display
  // ---------------------------------------------------------------------------

  private updateDisplay(): void {
    const reduced = isReducedMotion();
    const frameChar = reduced ? '●' : SPINNER_FRAMES[this.glyphFrame()]!;
    const thinkingActive =
      this.mode !== 'compacting' && this.thinkingStatusProvider?.() === 'thinking';
    const thinkingStart = this.thinkingStartProvider?.();
    const thinkingPhrase =
      thinkingActive && thinkingStart !== undefined
        ? thinkingPhraseForElapsed(Date.now() - thinkingStart)
        : undefined;
    const rowLabel = this.label !== '' ? this.label : this.fallbackVerb;
    const stall = this.stallIntensity(reduced);

    const coloredFrame = this.colorFrame(frameChar, stall, reduced);
    this.inlineText = this.label ? `${coloredFrame} ${this.colorFn(this.label)}` : coloredFrame;

    const base = `${coloredFrame} ${this.colorLabel(rowLabel, stall, reduced)}`;
    let status = this.statusProvider?.() ?? '';
    if (thinkingPhrase !== undefined) {
      status = replaceThinkingStatus(status, thinkingPhrase);
    }

    const retryStatus = this.retryStatusProvider?.();
    this.retryText = retryStatus ? `  ${currentTheme.fg('error', retryStatus.trim())}` : '';

    const width = this.availableWidth;
    const tip = this.tip ? currentTheme.fg('textDim', this.tip) : '';
    const statusCandidates = compactStatusCandidates(status);
    let text = base;
    for (const candidate of statusCandidates) {
      const coloredStatus = candidate ? this.colorStatus(candidate, reduced) : '';
      const withStatus = base + coloredStatus;
      if (width === 0 || visibleWidth(withStatus) <= width) {
        text = withStatus;
        break;
      }
    }

    this.tipText = '';
    if (tip) {
      const withTip = text + tip;
      if (width === 0 || visibleWidth(withTip) <= width) text = withTip;
      else this.tipText = `  ${tip.trimStart()}`;
    }

    this.progressText =
      this.mode === 'compacting'
        ? `  ${renderIndeterminateProgress(width, Date.now(), reduced)}`
        : '';
    this.displayText = text;
    this.setText(this.displayText);
    this.ui.requestRender();
  }

  override render(width: number): string[] {
    this.setAvailableWidth(width);
    const rows = super.render(width);
    if (this.retryText) rows.push(truncateToWidth(this.retryText, width));
    if (this.progressText) rows.push(truncateToWidth(this.progressText, width));
    if (this.tipText) rows.push(truncateToWidth(this.tipText, width));
    return rows;
  }
}

function replaceThinkingStatus(status: string, phrase: string): string {
  if (/\bthinking\b/.test(status)) return status.replace(/\bthinking\b/, phrase);
  if (status === '') return ` (${phrase})`;
  return status.replace(/\)\s*$/, ` · ${phrase})`);
}

function compactStatusCandidates(status: string): readonly string[] {
  const match = /^\s*\((.*)\)$/.exec(status);
  if (match === null) return status ? [status, ''] : [''];
  const parts = match[1]!.split(' · ');
  const candidates: string[] = [status];
  const withoutThinking = parts.filter((part) => !part.includes('thinking'));
  const withoutTokens = withoutThinking.filter((part) => !/^[↑↓]/.test(part));
  for (const candidateParts of [withoutThinking, withoutTokens]) {
    const candidate = candidateParts.length > 0 ? ` (${candidateParts.join(' · ')})` : '';
    if (!candidates.includes(candidate)) candidates.push(candidate);
  }
  candidates.push('');
  return candidates;
}

function renderIndeterminateProgress(width: number, now: number, reduced: boolean): string {
  const cells = Math.max(8, Math.min(COMPACT_PROGRESS_WIDTH, width > 0 ? width - 4 : COMPACT_PROGRESS_WIDTH));
  const maxStart = Math.max(0, cells - COMPACT_PROGRESS_BLOCK_WIDTH);
  const start = reduced || maxStart === 0 ? 0 : Math.floor(now / 100) % (maxStart * 2 || 1);
  const position = start > maxStart ? maxStart * 2 - start : start;
  let bar = '';
  for (let index = 0; index < cells; index++) {
    bar += index >= position && index < position + COMPACT_PROGRESS_BLOCK_WIDTH ? '━' : '─';
  }
  return currentTheme.fg('primary', bar);
}
