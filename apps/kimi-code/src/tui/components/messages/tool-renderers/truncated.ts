import { bumpVersion, Text, truncateToWidth, type Component } from '@moonshot-ai/pi-tui';

import { currentTheme } from '#/tui/theme';
import type { ColorPalette } from '#/tui/theme/colors';

import type { ResultRenderer } from './types';
import { PREVIEW_LINES } from './types';

const DEFAULT_INDENT = 2;

export function trimTrailingEmptyLines(lines: string[]): string[] {
  let end = lines.length;
  while (end > 0) {
    const line = lines[end - 1];
    if (line === undefined || line.length > 0) break;
    end--;
  }
  return lines.slice(0, end);
}

// ---------------------------------------------------------------------------
// Character budget for tool-output previews.
//
// Text.render wraps the *entire* string handed to it (splitIntoTokensWithAnsi +
// visibleWidth run per grapheme cluster). On multi-megabyte single-line output
// (JSON blobs) that is superlinear and lands synchronously inside the
// input->render window. maxLines only caps the *rendered rows* after wrapping -
// it cannot bound the wrap cost of one enormous line. We therefore cut the
// string to MAX_PREVIEW_CHARS code units *before* colorizing/wrapping, at a
// boundary that never splits a grapheme cluster or an ANSI escape sequence.
// Chars bound the wrap cost; maxLines continues to bound the rows shown.
// ---------------------------------------------------------------------------

/**
 * Maximum code units of tool output handed to the Text component for wrapping.
 * Tune this to trade preview fidelity against synchronous render cost.
 */
export const MAX_PREVIEW_CHARS = 100_000;

// ANSI escapes are invisible to the char budget but occupy bytes; cap the total
// result length so pathological ANSI-only inputs cannot defeat the bound.
const MAX_PREVIEW_TOTAL = MAX_PREVIEW_CHARS * 4;

// Extra code units examined around a cut so clusters/escapes that straddle it
// are kept whole (or dropped whole).
const CUT_SLACK = 32;

const graphemeSegmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' });

const TRUNCATION_MARKER = '… (output truncated)';

/**
 * Extract a complete ANSI escape sequence (CSI/OSC/APC) at `pos`, mirroring
 * pi-tui's extractAnsiCode so a cut can never land inside one. Returns null
 * when the byte is not an ESC introducer or the sequence is unterminated.
 */
function extractAnsiCode(text: string, pos: number): { code: string; length: number } | null {
  if (pos >= text.length || text[pos] !== '\x1b') return null;
  const next = text[pos + 1];

  // CSI sequence: ESC [ ... m/G/K/H/J
  if (next === '[') {
    let j = pos + 2;
    while (j < text.length && !/[mGKHJ]/.test(text[j]!)) j++;
    if (j < text.length) return { code: text.substring(pos, j + 1), length: j + 1 - pos };
    return null;
  }

  // OSC (hyperlinks/titles) and APC (cursor markers): ESC ]/_ ... BEL or ST
  if (next === ']' || next === '_') {
    let j = pos + 2;
    while (j < text.length) {
      if (text[j] === '\x07') return { code: text.substring(pos, j + 1), length: j + 1 - pos };
      if (text[j] === '\x1b' && text[j + 1] === '\\') return { code: text.substring(pos, j + 2), length: j + 2 - pos };
      j++;
    }
    return null;
  }

  return null;
}

/**
 * First index >= `index` that is a grapheme boundary (nudges forward past any
 * cluster straddling `index`). The window is extended a few units on both sides
 * so the boundary decision sees whole clusters.
 */
function nextGraphemeBoundary(text: string, index: number): number {
  if (index >= text.length) return index;
  const winStart = Math.max(0, index - 4);
  const window = text.slice(winStart, Math.min(text.length, index + 8));
  let pos = winStart;
  for (const { segment } of graphemeSegmenter.segment(window)) {
    pos += segment.length;
    if (pos >= index) break;
  }
  return Math.min(text.length, pos);
}

/**
 * First safe cut index so `text.slice(idx)` keeps the last MAX_PREVIEW_CHARS
 * code units (the newest rows of live command output). A forward scan in
 * O(target) cheap char ops skips whole ANSI escapes and records the last plain
 * position at/before the budget line; the exact boundary is resolved locally so
 * the tail never starts mid-cluster. Falls back to 0 (keep everything) when the
 * budget region is swallowed by escapes - safer to keep whole than break one.
 */
function tailStart(text: string): number {
  const target = text.length - MAX_PREVIEW_CHARS;
  let lastSafe = 0;
  let i = 0;
  while (i <= target) {
    if (text[i] === '\x1b') {
      const ansi = extractAnsiCode(text, i);
      if (ansi) {
        i += ansi.length;
        continue;
      }
      break; // dangling escape: no safe cut beyond here
    }
    lastSafe = i;
    i++;
  }
  return nextGraphemeBoundary(text, lastSafe);
}

/**
 * Build a prefix of up to MAX_PREVIEW_CHARS code units, keeping whole grapheme
 * clusters and whole ANSI escapes. Plain-text runs are capped at the remaining
 * budget plus CUT_SLACK, so the segmentation cost stays O(budget).
 */
function truncatePrefix(text: string): string {
  let result = '';
  let visibleKept = 0;
  let i = 0;

  while (i < text.length && visibleKept < MAX_PREVIEW_CHARS) {
    if (text[i] === '\x1b') {
      const ansi = extractAnsiCode(text, i);
      if (ansi) {
        result += ansi.code;
        i += ansi.length;
        if (result.length > MAX_PREVIEW_TOTAL) break;
        continue;
      }
      break; // dangling escape: cut before it
    }

    const remaining = MAX_PREVIEW_CHARS - visibleKept;
    const scanEnd = Math.min(text.length, i + remaining);
    let end = i;
    while (end < scanEnd && text[end] !== '\x1b') end++;
    const runEnd = end < scanEnd ? end : Math.min(text.length, scanEnd + CUT_SLACK);
    const run = text.slice(i, runEnd);

    let partial = '';
    for (const { segment } of graphemeSegmenter.segment(run)) {
      if (partial.length + segment.length > remaining) break;
      partial += segment;
    }
    result += partial;
    visibleKept += partial.length;
    i += partial.length;
    if (partial.length === 0) break; // last cluster straddled the budget
  }

  return result;
}

/**
 * Truncate `text` to the preview budget, or return it unchanged when it already
 * fits. `keepTail` keeps the *last* budget units (live output), otherwise the
 * first. The caller appends the truncation marker.
 */
function truncateToPreviewChars(text: string, keepTail: boolean): { text: string; truncated: boolean } {
  if (text.length <= MAX_PREVIEW_CHARS) return { text, truncated: false };
  return keepTail
    ? { text: text.slice(tailStart(text)), truncated: true }
    : { text: truncatePrefix(text), truncated: true };
}

/**
 * Component that renders tool output with wrap-aware line truncation.
 * Uses pi-tui's Text component to compute actual visual wrapped lines,
 * then caps at PREVIEW_LINES. This handles long single-line output (e.g.
 * JSON blobs) that would otherwise wrap to dozens of visual rows.
 */
export class TruncatedOutputComponent implements Component {
  // Versioned from construction so the owning container's fast path can skip
  // unchanged output. invalidate() bumps (the hint reads currentTheme live) so
  // a theme switch repaints.
  version = 0;
  private textComponent: Text;
  private readonly expanded: boolean;
  private readonly maxLines: number;
  private readonly indent: number;
  private readonly expandHint: boolean;
  private readonly tail: boolean;

  constructor(
    output: string,
    options: {
      expanded: boolean;
      isError: boolean | undefined;
      maxLines?: number;
      indent?: number;
      // When false, the truncation footer omits the "ctrl+o to expand" promise
      // (for contexts whose output is fixed-truncated and never expands).
      expandHint?: boolean;
      // When true, collapsed rendering keeps the latest visual rows instead of
      // the first rows. This is useful for live output from a running command.
      tail?: boolean;
      // Foreground colour for successful (non-error) output. Defaults to
      // `textDim`; Bash passes `textMuted` so its result sits one shade below
      // the `textDim` command. Error output always uses `error`.
      color?: keyof ColorPalette;
    },
  ) {
    this.expanded = options.expanded;
    this.maxLines = options.maxLines ?? PREVIEW_LINES;
    this.indent = options.indent ?? DEFAULT_INDENT;
    this.expandHint = options.expandHint ?? true;
    this.tail = options.tail ?? false;
    const cleaned = trimTrailingEmptyLines(output.split('\n')).join('\n');
    // Cap the input handed to Text *before* colorizing/wrapping so the render
    // cost stays O(MAX_PREVIEW_CHARS) even for multi-megabyte single-line
    // output. Applied to expanded cards too - a huge line is just as
    // synchronous in the expanded view.
    const preview = truncateToPreviewChars(cleaned, this.tail);
    const successColor = options.color ?? 'textDim';
    let colored = options.isError
      ? currentTheme.fg('error', preview.text)
      : currentTheme.fg(successColor, preview.text);
    if (preview.truncated) {
      // Mark the dropped portion, dim like the line-count hint. Tail keeps the
      // newest rows at the end, so the marker leads; otherwise it trails.
      colored = this.tail
        ? currentTheme.dim(TRUNCATION_MARKER + '\n') + colored
        : colored + currentTheme.dim((preview.text.endsWith('\n') ? '' : '\n') + TRUNCATION_MARKER);
    }
    this.textComponent = new Text(colored, this.indent, 0);
  }

  invalidate(): void {
    // Text component caches wrapped lines; invalidate on terminal resize.
    this.textComponent.invalidate();
    bumpVersion(this);
  }

  private renderHint(width: number, hint: string): string {
    const indentWidth = Math.min(this.indent, Math.max(0, width));
    const hintWidth = Math.max(0, width - indentWidth);
    return ' '.repeat(indentWidth) + currentTheme.dim(truncateToWidth(hint, hintWidth, '…'));
  }

  render(width: number): string[] {
    const contentLines = this.textComponent.render(width);

    if (this.expanded || contentLines.length <= this.maxLines) {
      return contentLines;
    }

    const remaining = contentLines.length - this.maxLines;
    if (this.tail) {
      const shown = contentLines.slice(contentLines.length - this.maxLines);
      return [
        this.renderHint(width, `... (${String(remaining)} earlier lines)`),
        ...shown,
      ];
    }

    const shown = contentLines.slice(0, this.maxLines);
    const hint = this.expandHint
      ? `... (${String(remaining)} more lines, ctrl+o to expand)`
      : `... (${String(remaining)} more lines)`;
    return [...shown, this.renderHint(width, hint)];
  }
}

export const renderTruncated: ResultRenderer = (_toolCall, result, ctx) => {
  if (!result.output) return [];
  return [
    new TruncatedOutputComponent(result.output, {
      expanded: ctx.expanded,
      isError: result.is_error ?? false,
    }),
  ];
};
