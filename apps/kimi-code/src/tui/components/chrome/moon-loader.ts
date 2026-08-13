import { Text, visibleWidth } from '@moonshot-ai/pi-tui';
import type { TUI } from '@moonshot-ai/pi-tui';
import chalk from 'chalk';

import { SPINNER_FRAMES, SPINNER_INTERVAL_MS } from '#/tui/constant/rendering';
import { randomSpinnerVerb } from '#/tui/constant/spinner-verbs';
import { currentTheme } from '#/tui/theme';
import { isReducedMotion } from '#/tui/utils/accessibility';
import { interpolateHexColor } from '#/tui/utils/color';

export type SpinnerStyle = 'moon' | 'braille';

/** Activity-pane mode driving per-mode label animation (glimmer vs flash). */
export type LoaderMode = 'waiting' | 'thinking' | 'composing' | 'tool';

/** Stall input: `lastActivityAtMs` is the last time the model produced output. */
export interface StallInput {
  lastActivityAtMs: number;
  hasActiveTools: boolean;
}

const STALL_THRESHOLD_MS = 3_000;
const STALL_FADE_MS = 2_000;

// Glimmer sweep: a brighter band travels across the label. Same palette idea as
// Claude's GlimmerMessage — base dim, highlight strong — but with a simpler
// ±1-column band driven by wall-clock.
const GLIMMER_SPEED_MS = 200;
const GLIMMER_CYCLE_PAD = 20;
const GLIMMER_BAND = 1;

// Thinking glow: pulse between two greys (Claude's THINKING_INACTIVE↔SHIMMER).
const THINKING_INACTIVE = '#999999';
const THINKING_SHIMMER = '#b9b9b9';
const GLOW_PERIOD_S = 2;

// Tool-use flash: whole label pulses base↔strong on a ~2s sine.
const FLASH_PERIOD_S = 2;

export class MoonLoader extends Text {
  private currentFrame = 0;
  private intervalId: ReturnType<typeof setInterval> | null = null;
  private ui: TUI;
  private colorFn: (s: string) => string;
  private label: string;
  private displayText = '';
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
    this.intervalId = setInterval(() => {
      this.currentFrame = (this.currentFrame + 1) % SPINNER_FRAMES.length;
      this.updateDisplay();
    }, SPINNER_INTERVAL_MS);
  }

  stop(): void {
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
    }
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

  /** Switch the per-mode label animation: `tool` flashes, others glimmer. */
  setMode(mode: LoaderMode): void {
    if (this.mode === mode) return;
    this.mode = mode;
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

  private stallIntensity(reduced: boolean): number {
    if (reduced) return 0;
    const input = this.stallProvider?.();
    if (input === undefined) return 0;
    const stallMs = Date.now() - input.lastActivityAtMs;
    if (stallMs <= STALL_THRESHOLD_MS || input.hasActiveTools) return 0;
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
    if (this.mode === 'tool') return this.flashText(text);
    return this.glimmerText(text);
  }

  private colorStatus(status: string, reduced: boolean): string {
    if (reduced) return currentTheme.fg('textDim', status);
    if (this.thinkingStatusProvider?.() === 'thinking') return this.glowText(status);
    return currentTheme.fg('textDim', status);
  }

  /** Fade a plain-text span from primary toward the error red as it stalls. */
  private stallColor(text: string, intensity: number): string {
    if (intensity >= 1) return currentTheme.fg('error', text);
    const base = currentTheme.color('primary');
    const err = currentTheme.color('error');
    return chalk.hex(interpolateHexColor(base, err, intensity))(text);
  }

  /** A brighter ±1-column band sweeping across the label over wall-clock. */
  private glimmerText(text: string): string {
    const width = visibleWidth(text);
    if (width === 0) return text;
    const cycle = width + GLIMMER_CYCLE_PAD;
    const center = (Math.floor(Date.now() / GLIMMER_SPEED_MS) % cycle) - 10;
    let out = '';
    let col = 0;
    for (const ch of text) {
      const w = visibleWidth(ch);
      const lit = col >= center - GLIMMER_BAND && col <= center + GLIMMER_BAND;
      out += lit ? currentTheme.fg('textStrong', ch) : currentTheme.fg('textDim', ch);
      col += w;
    }
    return out;
  }

  /** Whole-label sine pulse between primary and strong text. */
  private flashText(text: string): string {
    const opacity = (Math.sin((Date.now() / 1000) * Math.PI * 2 * (1 / FLASH_PERIOD_S)) + 1) / 2;
    const hex = interpolateHexColor(currentTheme.color('primary'), currentTheme.color('textStrong'), opacity);
    return chalk.hex(hex)(text);
  }

  /** Status glow while thinking: pulse between two greys. */
  private glowText(text: string): string {
    const opacity = (Math.sin((Date.now() / 1000) * Math.PI * 2 * (1 / GLOW_PERIOD_S)) + 1) / 2;
    const hex = interpolateHexColor(THINKING_INACTIVE, THINKING_SHIMMER, opacity);
    return chalk.hex(hex)(text);
  }

  // ---------------------------------------------------------------------------
  // Display
  // ---------------------------------------------------------------------------

  private updateDisplay(): void {
    const reduced = isReducedMotion();
    const frameChar = reduced ? '●' : SPINNER_FRAMES[this.currentFrame]!;
    const rowLabel = this.label !== '' ? this.label : this.fallbackVerb;
    const stall = this.stallIntensity(reduced);

    const coloredFrame = this.colorFrame(frameChar, stall, reduced);
    this.inlineText = this.label ? `${coloredFrame} ${this.colorFn(this.label)}` : coloredFrame;

    let text = `${coloredFrame} ${this.colorLabel(rowLabel, stall, reduced)}`;

    const status = this.statusProvider?.();
    if (status) {
      text += this.colorStatus(status, reduced);
    }
    if (this.tip) {
      const withTip = text + currentTheme.fg('textDim', this.tip);
      if (this.availableWidth === 0 || visibleWidth(withTip) <= this.availableWidth) {
        text = withTip;
      }
    }
    this.displayText = text;
    this.setText(this.displayText);
    this.ui.requestRender();
  }
}
