import { currentTheme } from '#/tui/theme';

// Captured command output can contain terminal control sequences — colours,
// cursor moves, alternate-screen switches, hyperlinks, `\r` spinners, bells, …
// We render through pi-tui, which passes strings straight to the terminal, so
// any sequence left intact is executed by the terminal and fights with pi-tui's
// own cursor control (the "blank screen + leftover characters" symptom). Strip
// everything a terminal would interpret as a command rather than printable text,
// keeping only `\n` and `\t` (which the renderer understands).

// ESC [ <params> <intermediates> <final> — colours, cursor moves, clear, and
// private modes such as ESC[?1049h (alt screen) / ESC[?25l (hide cursor).
const CSI_PATTERN = /\u001B\[[0-9:;<=>?]*[ -/]*[@-~]/g;
// ESC ] … <BEL>  or  ESC ] … ESC \ — window titles and OSC 8 hyperlinks.
const OSC_PATTERN = /\u001B\][\s\S]*?(?:\u0007|\u001B\\)/g;
// ESC <char> (and ESC <intermediate> <char>) — charset/keypad selection,
// save/restore cursor (ESC 7 / ESC 8), full reset (ESC c), etc. Runs after the
// CSI/OSC patterns, so it only catches sequences they didn't already consume.
const ESC_SINGLE_PATTERN = /\u001B(?:[ -/][0-~]|[0-~])/g;
// C0 control characters except \n (0x0A) and \t (0x09): NUL, BEL, \b, \r, …
// plus a lone ESC (0x1B) that wasn't part of a sequence recognised above.
const C0_CONTROL_PATTERN = /[\u0000-\u0008\u000B-\u001B\u001C-\u001F]/g;

/**
 * Strip every terminal control sequence from captured command output so it is
 * safe to render via pi-tui (which does not sanitize on its own).
 *
 * Never throws: a bad or pathological input falls back to stripping only the
 * C0 control characters, so rendering can never crash the TUI.
 */
export function sanitizeShellOutput(text: string): string {
  if (typeof text !== 'string') return '';
  if (text.length === 0) return text;
  try {
    return text
      .replace(OSC_PATTERN, '')
      .replace(CSI_PATTERN, '')
      .replace(ESC_SINGLE_PATTERN, '')
      .replace(C0_CONTROL_PATTERN, '');
  } catch {
    return text.replace(C0_CONTROL_PATTERN, '');
  }
}

// Live-buffer budget for the running shell view (moved here with the
// sanitizer so the raw/clean buffers share one cap policy).
const MAX_COMBINED_CHARS = 256 * 1024;
const KEEP_COMBINED_CHARS = 64 * 1024;
// Re-sanitize window: every append re-strips only this much of the previous
// buffer plus the new chunk, instead of the whole accumulated buffer. Generous
// enough to cover any realistic CSI/OSC sequence that straddles a chunk
// boundary (colours, OSC titles, hyperlinks are all far shorter).
const SANITIZE_OVERLAP_CHARS = 8 * 1024;

export interface ShellOutputSanitizerOptions {
  maxChars?: number;
  keepChars?: number;
  overlapChars?: number;
}

/**
 * Incremental shell-output sanitizer. Feeds raw chunks in; `value()` always
 * returns what `sanitizeShellOutput` of everything appended so far would
 * return, except for escape sequences longer than the overlap window (which
 * degrade to partial strips in the already-cleaned prefix — the running view
 * only ever shows the sanitized tail, and `finish()` re-sanitizes the final
 * streams fully).
 */
export interface ShellOutputSanitizer {
  append(text: string): void;
  value(): string;
}

export function createShellOutputSanitizer(
  options: ShellOutputSanitizerOptions = {},
): ShellOutputSanitizer {
  const maxChars = options.maxChars ?? MAX_COMBINED_CHARS;
  const keepChars = options.keepChars ?? KEEP_COMBINED_CHARS;
  const overlapChars = options.overlapChars ?? SANITIZE_OVERLAP_CHARS;

  let raw = '';
  let clean = '';

  return {
    append(text: string): void {
      if (typeof text !== 'string' || text.length === 0) return;
      const prevEnd = raw.length;
      raw += text;
      if (raw.length > maxChars) {
        // Cap hit — the raw head is dropped, so rebuild the sanitized buffer
        // from the kept tail (rare: once per ~192KB of output).
        raw = raw.slice(-keepChars);
        clean = sanitizeShellOutput(raw);
        return;
      }
      // Re-sanitize only the tail window: the new chunk plus an overlap of the
      // previous buffer, aligned to a line boundary so the cleaned prefix can
      // be spliced with the re-stripped tail. A sequence that starts inside
      // the overlap and ends in the new chunk is stripped exactly as a
      // full-buffer pass would.
      let winStart = Math.max(0, prevEnd - overlapChars);
      const newline = raw.lastIndexOf('\n', winStart - 1);
      if (newline >= 0) {
        winStart = newline + 1;
      } else if (winStart > 0) {
        // The whole overlap is one unbroken line (spinner redraws, huge JSON
        // lines): a mid-line window would split it, so fall back to a full
        // re-strip to keep the output identical to the full-buffer pass.
        clean = sanitizeShellOutput(raw);
        return;
      }
      if (winStart === 0) {
        clean = sanitizeShellOutput(raw);
        return;
      }
      // `clean` is sanitizeShellOutput(raw[0..prevEnd]) by invariant; drop the
      // sanitized length of the re-windowed region, then splice the fresh tail.
      const removed = sanitizeShellOutput(raw.slice(winStart, prevEnd));
      clean = clean.slice(0, clean.length - removed.length) + sanitizeShellOutput(raw.slice(winStart));
    },

    value(): string {
      return clean;
    },
  };
}

/**
 * Format captured stdout/stderr for the transcript. Sanitizes both streams and
 * dims them; stderr is red only on actual failure.
 *
 * Never throws: if anything goes wrong (theme lookup, huge input, …) it falls
 * back to a best-effort plain view so a render error can never crash the TUI.
 */
export function formatBashOutputForDisplay(stdout: string, stderr: string, isError?: boolean): string {
  try {
    const dim = (s: string): string => currentTheme.fg('textDim', s);
    const parts: string[] = [];
    const cleanStdout = sanitizeShellOutput(stdout).trimEnd();
    if (cleanStdout.length > 0) parts.push(dim(cleanStdout));
    const cleanStderr = sanitizeShellOutput(stderr).trimEnd();
    if (cleanStderr.length > 0) {
      // Dim grey normally; red only on actual failure (so warnings on a
      // successful command are not mistaken for errors).
      parts.push(isError ? currentTheme.fg('error', cleanStderr) : dim(cleanStderr));
    }
    return parts.length > 0 ? parts.join('\n') : dim('(no output)');
  } catch {
    const plain = [sanitizeShellOutput(String(stdout ?? '')), sanitizeShellOutput(String(stderr ?? ''))]
      .filter((s) => s.length > 0)
      .join('\n');
    return plain.length > 0 ? plain : '(no output)';
  }
}
