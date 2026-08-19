import { Text, visibleWidth } from '@moonshot-ai/pi-tui';
import type { TUI } from '@moonshot-ai/pi-tui';
import chalk from 'chalk';

import { SPINNER_FRAMES } from '#/tui/constant/rendering';
import { randomSpinnerVerb } from '#/tui/constant/spinner-verbs';
import { currentTheme } from '#/tui/theme';
import { isReducedMotion } from '#/tui/utils/accessibility';
import { interpolateHexColor } from '#/tui/utils/color';

export type SpinnerStyle = 'moon' | 'braille';

/** Activity-pane mode driving per-mode label animation (glimmer vs flash). */
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
const GLIMMER_SPEED_MS = 200;
const GLIMMER_CYCLE_PAD = 20;
const GLIMMER_BAND = 1;

// Thinking glow: pulse between two greys (Claude's THINKING_INACTIVE↔SHIMMER).
const THINKING_INACTIVE = '#999999';
const THINKING_SHIMMER = '#b9b9b9';
const GLOW_PERIOD_S = 2;

// Tool-use flash: whole label pulses base↔strong on a ~2s sine.
const FLASH_PERIOD_S = 2;

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
const TICK_REQUESTING_MS = 80;
const TICK_CALM_MS = 100;

export class MoonLoader extends Text {
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

  /** Switch the per-mode label animation: `tool` flashes, others glimmer. */
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

  /** Ladder phrase for the current thinking run, by elapsed thinking time. */
  private thinkingPhrase(startedAtMs: number): string {
    const elapsed = Date.now() - startedAtMs;
    let index = 0;
    for (let i = 0; i < THINKING_PHRASE_THRESHOLDS.length; i++) {
      if (elapsed >= THINKING_PHRASE_THRESHOLDS[i]!) index = i;
    }
    return THINKING_PHRASES[index]!;
  }

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
    const intensity = this.thinkingIntensity(reduced);
    if (this.mode === 'tool') return this.flashText(text, intensity);
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
    const center = (Math.floor(Date.now() / GLIMMER_SPEED_MS) % cycle) - 10;
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

  /** Whole-label sine pulse between primary and strong text. */
  private flashText(text: string, intensity: number): string {
    const opacity = (Math.sin((Date.now() / 1000) * Math.PI * 2 * (1 / FLASH_PERIOD_S)) + 1) / 2;
    let hex = interpolateHexColor(currentTheme.color('primary'), currentTheme.color('textStrong'), opacity);
    if (intensity > 0) {
      hex = interpolateHexColor(hex, currentTheme.color('warning'), intensity);
    }
    const colored = chalk.hex(hex)(text);
    return intensity > 0.5 ? chalk.bold(colored) : colored;
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
    // While thinking is active the label climbs the thinking phrase ladder
    // (still thinking → … → almost done thinking); otherwise the caller's
    // label wins, falling back to the per-run working verb.
    const thinkingActive =
      this.mode !== 'compacting' && this.thinkingStatusProvider?.() === 'thinking';
    const thinkingStart = this.thinkingStartProvider?.();
    const thinkingPhrase =
      thinkingActive && thinkingStart !== undefined ? this.thinkingPhrase(thinkingStart) : undefined;
    const rowLabel = thinkingPhrase ?? (this.label !== '' ? this.label : this.fallbackVerb);
    const stall = this.stallIntensity(reduced);

    const coloredFrame = this.colorFrame(frameChar, stall, reduced);
    this.inlineText = this.label ? `${coloredFrame} ${this.colorFn(this.label)}` : coloredFrame;

    let text = `${coloredFrame} ${this.colorLabel(rowLabel, stall, reduced)}`;

    // A retry/rate-limit line replaces the normal status suffix while a step
    // is being retried.
    const retryStatus = this.retryStatusProvider?.();
    const retrying = retryStatus !== undefined && retryStatus.length > 0;
    const status = retrying ? retryStatus : this.statusProvider?.();
    if (status) {
      text += retrying
        ? reduced
          ? currentTheme.fg('textDim', status)
          : currentTheme.fg('warning', status)
        : this.colorStatus(status, reduced);
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
