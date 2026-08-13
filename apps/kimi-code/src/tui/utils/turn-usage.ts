/**
 * Formats the live per-turn token counter shown next to the activity
 * spinner, e.g. ` (36s · ↓ 340 tokens)`.
 *
 * This mirrors Claude Code's behaviour: a single token counter with an ↑ while
 * the request is in flight and a ↓ while the model is streaming back thinking /
 * assistant / tool output. Output tokens are only reported by providers at
 * stream end (Anthropic) or in a trailing usage chunk (OpenAI/Kimi), so while a
 * step is streaming the counter is fed from a local estimate over the received
 * text — the same trick Claude Code uses for its per-frame counter. The
 * provider's exact usage supersedes the estimate as soon as it arrives
 * (`turn.step.usage`), and the settled per-step totals always come from exact
 * usage.
 */

export interface TurnUsageSnapshot {
  input: number;
  output: number;
  turnStartedAt: number;
  live?: { input: number; output: number };
}

/** CJK glyphs (Kana, Han ext-A/unified, Hangul, fullwidth forms) tokenize far denser than Latin text. */
const CJK_CHAR = /[\u3000-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uac00-\ud7af\uff00-\uffef]/;

/**
 * Rough token estimate for streamed text: ~0.7 token per CJK glyph, ~1 per
 * 4 Latin/code characters. Cosmetic only — exact provider usage replaces it.
 */
export function estimateStreamedTokens(text: string): number {
  let cjk = 0;
  let other = 0;
  for (const char of text) {
    if (CJK_CHAR.test(char)) cjk += 1;
    else other += 1;
  }
  return Math.ceil(cjk * 0.7) + Math.ceil(other / 4);
}

export function formatTokenCount(count: number): string {
  if (count < 1000) return String(count);
  return `${(count / 1000).toFixed(1).replace('.0', '')}k`;
}

/** Streaming phase of the in-flight turn, used to pick the arrow direction. */
type TurnPhase = 'idle' | 'waiting' | 'thinking' | 'composing' | 'shell';
function formatElapsed(now: number, startedAt: number): string {
  const seconds = Math.max(0, Math.floor((now - startedAt) / 1000));
  if (seconds < 60) return `${String(seconds)}s`;
  const minutes = Math.floor(seconds / 60);
  const remainder = seconds % 60;
  return `${String(minutes)}m${String(remainder).padStart(2, '0')}s`;
}

/**
 * Total output tokens shown for an in-flight turn: settled output plus the
 * larger of the step's live output and the local streamed estimate. Shared by
 * the spinner row (`formatTurnUsage`) and the footer's main-agent line so both
 * display positions agree. Input tokens are deliberately excluded — they are
 * the full context of each step request, not tokens produced this turn, and
 * folding them in made the footer jump straight to the context size.
 */
export function turnOutputTokens(
  usage: TurnUsageSnapshot | undefined,
  estimatedOutput = 0,
): number {
  if (usage === undefined) return 0;
  return usage.output + Math.max(usage.live?.output ?? 0, estimatedOutput);
}

/**
 * Returns the spinner-row suffix for the in-flight turn, or an empty string
 * when there is nothing to show yet. `estimatedOutput` is the locally
 * estimated output tokens of the in-flight step (see
 * {@link estimateStreamedTokens}); the larger of it and the exact live usage
 * wins so the counter never jumps backwards when the estimate overshoots.
 */
export function formatTurnUsage(
  phase: TurnPhase,
  usage: TurnUsageSnapshot | undefined,
  now: number = Date.now(),
  estimatedOutput = 0,
  thinkingStatus: 'thinking' | number | null = null,
): string {
  if (usage === undefined || usage.turnStartedAt <= 0 || phase === 'idle') return '';
  const totalOutput = turnOutputTokens(usage, estimatedOutput);
  const parts: string[] = [];
  if (thinkingStatus === 'thinking') {
    parts.push('thinking');
  } else if (typeof thinkingStatus === 'number') {
    parts.push(`thought for ${Math.max(1, Math.round(thinkingStatus / 1000))}s`);
  }
  parts.push(formatElapsed(now, usage.turnStartedAt));
  if (totalOutput > 0) {
    const arrow = phase === 'waiting' ? '↑' : '↓';
    parts.push(`${arrow} ${formatTokenCount(totalOutput)} tokens`);
  }
  return ` (${parts.join(' · ')})`;
}
