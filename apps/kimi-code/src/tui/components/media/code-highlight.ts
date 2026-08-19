/**
 * Shared syntax-highlighting helpers for code previews
 * (tool-call Write/Edit, approval-panel Write content, etc.).
 */

import { extname } from 'node:path';

import chalk from 'chalk';
import { highlight, supportsLanguage } from 'cli-highlight';

import { codeHighlightTheme } from '#/tui/theme/highlight-theme';

const EXT_LANG_MAP: Record<string, string> = {
  ts: 'typescript',
  tsx: 'typescript',
  js: 'javascript',
  jsx: 'javascript',
  py: 'python',
  rb: 'ruby',
  rs: 'rust',
  go: 'go',
  java: 'java',
  sh: 'bash',
  bash: 'bash',
  zsh: 'bash',
  json: 'json',
  yaml: 'yaml',
  yml: 'yaml',
  toml: 'toml',
  md: 'markdown',
  css: 'css',
  html: 'html',
  sql: 'sql',
  c: 'c',
  cpp: 'cpp',
  h: 'c',
  hpp: 'cpp',
};

export function langFromPath(filePath: string): string | undefined {
  const ext = extname(filePath).slice(1).toLowerCase();
  if (ext.length === 0) return undefined;
  const lang = EXT_LANG_MAP[ext] ?? ext;
  return supportsLanguage(lang) ? lang : undefined;
}

/**
 * Normalise a fenced-code language string to the base language cli-highlight
 * understands: "python3" -> "python", "bash-shell" -> "bash" (first segment
 * before a dash, trailing digits stripped). Returns undefined for empty input.
 */
export function baseLanguage(lang: string | undefined): string | undefined {
  const trimmed = lang?.trim().toLowerCase();
  if (!trimmed) return undefined;
  const base = trimmed.split('-')[0]!.replace(/\d+$/, '');
  return base || undefined;
}

/**
 * cli-highlight is a synchronous, per-call tokenizer: the same file content is
 * re-highlighted on every render tick (commit, expand, resize, theme redraw,
 * history echo, streaming re-render). The LRU below turns repeated hits into a
 * Map lookup. ANSI output depends only on the *constant* `codeHighlightTheme`
 * (never the mutable `currentTheme`), so the (lang + code) key is theme-stable
 * and no invalidation is required on theme switch.
 */
const HIGHLIGHT_CACHE_LIMIT = 512;
// Blocks at/above this length are too big to cache (the key alone would carry
// the whole payload) and are instead rendered through a bounded head/tail
// window; see highlightLargeWindowed.
const HIGHLIGHT_CACHE_MAX_CODE_LEN = 50_000;

// Large-block highlight budget (tunable). cli-highlight is a synchronous,
// per-call tokenizer with superlinear worst cases (measured ~6.7s for a 305KB
// block, ~50s for 800KB, ~7s for a single 100KB line) and large blocks skip the
// LRU, so without a budget every render tick re-tokenizes the whole payload —
// that is the source of the multi-second input-to-render spikes.
const LARGE_HEAD_LINES = 200;
const LARGE_TAIL_LINES = 200;
// Hard char cap per highlighted window slice: a window must not accumulate a
// pathological amount of long-line content (measured ~71s for a 200-line window
// of long lines). Whole lines are taken while under the cap; a single over-long
// line is truncated to it.
const WINDOW_SLICE_MAX_CHARS = 20_000;

class HighlightLru {
  private readonly map = new Map<string, string>();
  private readonly limit: number;

  constructor(limit: number) {
    this.limit = limit;
  }

  get(key: string): string | undefined {
    const hit = this.map.get(key);
    if (hit !== undefined) {
      // Refresh recency by re-inserting (Map preserves insertion order).
      this.map.delete(key);
      this.map.set(key, hit);
    }
    return hit;
  }

  set(key: string, value: string): void {
    if (this.map.has(key)) this.map.delete(key);
    this.map.set(key, value);
    if (this.map.size > this.limit) {
      // Evict the least-recently-used entry (first in insertion order).
      const oldest = this.map.keys().next().value;
      if (oldest !== undefined) this.map.delete(oldest);
    }
  }
}

const highlightCache = new HighlightLru(HIGHLIGHT_CACHE_LIMIT);

function highlightCacheKey(lang: string, code: string): string {
  // \u0000 is a safe separator: code from a terminal can contain any other byte.
  return `${lang}\u0000${code}`;
}

/** Highlight and cache a slice that is guaranteed small enough to cache safely. */
function highlightCachedSlice(code: string, language: string): string {
  const key = highlightCacheKey(language, code);
  const cached = highlightCache.get(key);
  if (cached !== undefined) return cached;
  const result = highlight(code, { language, ignoreIllegals: true, theme: codeHighlightTheme });
  highlightCache.set(key, result);
  return result;
}

/**
 * cli-highlight wrapper backed by the LRU cache. Shared with pi-tui-theme's
 * markdown codeBlock path so all highlight routes hit the same cache. Blocks
 * at/above HIGHLIGHT_CACHE_MAX_CODE_LEN bypass the cache AND are windowed to a
 * bounded head/tail slice (highlightLargeWindowed): re-tokenizing a huge block
 * on every render tick is the source of multi-second input-to-render spikes.
 */
export function highlightCached(code: string, language: string): string {
  if (code.length >= HIGHLIGHT_CACHE_MAX_CODE_LEN) {
    return highlightLargeWindowed(code, language);
  }
  return highlightCachedSlice(code, language);
}

interface LargeWindow {
  head: string[];
  tail: string[];
  skipped: number;
}

/**
 * Take up to `maxLines` whole lines from `lines` while the slice stays under
 * `maxChars` characters (separator counted as one). If the first line alone
 * exceeds the budget it is truncated to it (trailing "…" flags the cut), so the
 * tokenizer is never handed an unbounded input and a slice is never empty when
 * `lines` is non-empty.
 */
function takeLinesBounded(
  lines: readonly string[],
  maxLines: number,
  maxChars: number,
): string[] {
  const out: string[] = [];
  let chars = 0;
  for (const line of lines) {
    if (out.length >= maxLines) break;
    const next = chars + line.length + 1;
    if (next > maxChars) {
      if (out.length === 0) {
        out.push(`${line.slice(0, maxChars - 1)}…`);
      }
      break;
    }
    out.push(line);
    chars = next;
  }
  return out;
}

/**
 * Split a large block into a head slice and a tail slice, each bounded in both
 * line count and characters, plus the number of lines the window omits. Head
 * and tail never overlap: when the line budget covers the whole block they tile
 * it exactly (a short-but-wide block keeps its tail); otherwise a middle gap is
 * left, reported through `skipped`.
 */
function windowLargeLines(
  allLines: readonly string[],
  headLines: number,
  tailLines: number,
  sliceMaxChars: number,
): LargeWindow {
  const total = allLines.length;
  const headCount = Math.min(headLines, total);
  const tailCount = Math.min(tailLines, Math.max(0, total - headCount));
  const head = takeLinesBounded(allLines.slice(0, headCount), headCount, sliceMaxChars);
  // Walk the tail newest-first so the char budget preserves the *end* of the
  // file, then reverse back into file order.
  const tailSource = allLines.slice(total - tailCount);
  const tail = takeLinesBounded([...tailSource].reverse(), tailCount, sliceMaxChars).reverse();
  return { head, tail, skipped: total - head.length - tail.length };
}

function skippedMarker(skipped: number): string {
  return chalk.dim(`… ${skipped} more line${skipped === 1 ? '' : 's'} not highlighted …`);
}

/**
 * Highlight a block at/above HIGHLIGHT_CACHE_MAX_CODE_LEN as a bounded head/tail
 * window with a dim marker for the skipped middle, instead of the whole payload.
 * The window slices are small enough for the LRU, so the first render pays a
 * bounded worst-case cost and every re-render is a cache hit. The marker is
 * emitted as plain dim text between the slices (never fed to cli-highlight), so
 * it cannot be mis-tokenized as code.
 */
function highlightLargeWindowed(code: string, language: string): string {
  const w = windowLargeLines(
    code.split('\n'),
    LARGE_HEAD_LINES,
    LARGE_TAIL_LINES,
    WINDOW_SLICE_MAX_CHARS,
  );
  const parts: string[] = [];
  if (w.head.length > 0) parts.push(highlightCachedSlice(w.head.join('\n'), language));
  if (w.skipped > 0) parts.push(skippedMarker(w.skipped));
  if (w.tail.length > 0) parts.push(highlightCachedSlice(w.tail.join('\n'), language));
  return parts.join('\n');
}

export function highlightLines(code: string, lang: string | undefined): string[] {
  const normalizedLang = baseLanguage(lang);
  if (!normalizedLang || !supportsLanguage(normalizedLang)) return code.split('\n');
  try {
    return highlightCached(code, normalizedLang).split('\n');
  } catch {
    return code.split('\n');
  }
}

export interface HighlightPreview {
  /** Lines actually rendered (highlighted when a language was available). */
  lines: string[];
  /** Total line count of the original code (drives the "N more lines" footer). */
  total: number;
}

/**
 * Highlight only the first `n` lines of `code`. Collapsed Write tool cards
 * render at most COMMAND_PREVIEW_LINES lines, so slicing the raw text *before*
 * cli-highlight keeps cost proportional to what is shown (~1ms for 10 lines vs
 * 50-190ms for a whole file). The slice is taken on '\n'-separated raw lines,
 * so a wide character or line start can never be split. `total` lets the caller
 * render the "N more lines, M total" footer without highlighting the rest.
 */
export function highlightLinesFirstN(
  code: string,
  lang: string | undefined,
  n: number,
): HighlightPreview {
  const allLines = code.split('\n');
  if (n <= 0) return { lines: [], total: allLines.length };
  const previewLines = allLines.slice(0, n);
  const normalizedLang = baseLanguage(lang);
  if (!normalizedLang || !supportsLanguage(normalizedLang)) {
    return { lines: previewLines, total: allLines.length };
  }
  try {
    return {
      lines: highlightCached(previewLines.join('\n'), normalizedLang).split('\n'),
      total: allLines.length,
    };
  } catch {
    return { lines: previewLines, total: allLines.length };
  }
}

/**
 * Highlight the head/tail windows of a block and mark the skipped middle with a
 * dim line, for callers that render a *full-size* block but want the highlight
 * cost bounded (expanded Write cards, markdown code blocks). This differs from
 * `highlightLinesFirstN`, which truncates the display to the first `n` lines for
 * collapsed cards; here the whole block stays on screen. Uses the same windowing
 * as `highlightCached`'s large-block path, so output matches what a block routed
 * through `highlightCached` (then split on '\n') would produce.
 */
export function highlightLinesWindowed(
  code: string,
  lang: string | undefined,
  headLines: number = LARGE_HEAD_LINES,
  tailLines: number = LARGE_TAIL_LINES,
): HighlightPreview {
  const allLines = code.split('\n');
  const w = windowLargeLines(allLines, headLines, tailLines, WINDOW_SLICE_MAX_CHARS);
  const marker = w.skipped > 0 ? skippedMarker(w.skipped) : undefined;
  const normalizedLang = baseLanguage(lang);
  if (normalizedLang !== undefined && supportsLanguage(normalizedLang)) {
    try {
      return {
        lines: [
          ...(w.head.length > 0
            ? highlightCachedSlice(w.head.join('\n'), normalizedLang).split('\n')
            : []),
          ...(marker !== undefined ? [marker] : []),
          ...(w.tail.length > 0
            ? highlightCachedSlice(w.tail.join('\n'), normalizedLang).split('\n')
            : []),
        ],
        total: allLines.length,
      };
    } catch {
      // Fall through to the raw-lines path below (same shape, no styling).
    }
  }
  return {
    lines: [...w.head, ...(marker !== undefined ? [marker] : []), ...w.tail],
    total: allLines.length,
  };
}
