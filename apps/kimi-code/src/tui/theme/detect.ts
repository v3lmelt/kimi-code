/**
 * Terminal capability detection.
 *
 * Background detection strategy, in priority order:
 *   1. Reject — non-TTY, NO_COLOR, FORCE_COLOR=0, CI → safe `'dark'`.
 *   2. OSC 11 — write `ESC ] 11 ; ? BEL`, parse `ESC ] 11 ; rgb:RR/GG/BB BEL`,
 *      compute relative luminance. Capped at `timeoutMs` so unsupported
 *      terminals don't hang.
 *   3. COLORFGBG — VT100 / xterm fallback exposing `"fg;bg"`.
 *   4. Default — `'dark'`.
 *
 * Truecolor detection (`supportsTruecolor`) is environment-only: an allowlist
 * match on `TERM` / `TERM_PROGRAM` or an explicit `COLORTERM=24bit` flag.
 *
 * Must run before pi-tui enters raw mode; once the framework owns stdin
 * the OSC reply gets eaten by the input loop.
 */

import chalk from "chalk";

import { OSC11_QUERY, TERMINAL_THEME_DETECT_TIMEOUT_MS } from "#/tui/constant/terminal";

import type { ResolvedTheme } from "./colors";
import { parseOsc11BackgroundTheme } from "./terminal-background";

/**
 * Terminals known to speak 24-bit colour, keyed by the terminal name as it
 * appears in `TERM` / `TERM_PROGRAM` (e.g. `WezTerm`, `Ghostty`, `Alacritty`).
 * The `xterm-*` aliases are the `TERM` values some terminals export.
 */
const TRUECOLOR_TERMINALS: ReadonlySet<string> = new Set([
  "alacritty",
  "contour",
  "foot",
  "ghostty",
  "rio",
  "wezterm",
  "xterm-ghostty",
  "xterm-kitty",
]);

export interface DetectOptions {
  readonly timeoutMs?: number;
}

export async function detectTerminalTheme(opts: DetectOptions = {}): Promise<ResolvedTheme> {
  if (!isInteractiveTerminal()) return "dark";
  if (isColorOptOut()) return "dark";

  const fromOsc = await queryOsc11({
    timeoutMs: opts.timeoutMs ?? TERMINAL_THEME_DETECT_TIMEOUT_MS,
  });
  if (fromOsc !== null) return fromOsc;

  const fromColorFgBg = parseColorFgBg(process.env["COLORFGBG"]);
  if (fromColorFgBg !== null) return fromColorFgBg;

  return "dark";
}

function isInteractiveTerminal(): boolean {
  return (process.stdin.isTTY ?? false) && (process.stdout.isTTY ?? false);
}

function isColorOptOut(): boolean {
  const env = process.env;
  if (env["NO_COLOR"] !== undefined && env["NO_COLOR"] !== "") return true;
  if (env["FORCE_COLOR"] === "0") return true;
  if (env["CI"] !== undefined && env["CI"] !== "" && env["CI"] !== "0") return true;
  return false;
}

interface RawModeStdin {
  isRaw?: boolean;
  setRawMode(mode: boolean): NodeJS.ReadStream;
  on(event: "data", listener: (data: Buffer) => void): NodeJS.ReadStream;
  off(event: "data", listener: (data: Buffer) => void): NodeJS.ReadStream;
}

async function queryOsc11(opts: { timeoutMs: number }): Promise<ResolvedTheme | null> {
  const stdin = process.stdin as unknown as RawModeStdin;
  if (typeof stdin.setRawMode !== "function") return null;
  // If something else is already listening on stdin (e.g. another raw-mode
  // consumer), don't fight for it — punt to COLORFGBG instead.
  if (process.stdin.listenerCount("data") > 0) return null;

  const wasRaw = stdin.isRaw === true;
  let buffer = "";
  let listener: ((data: Buffer) => void) | null = null;
  let timer: NodeJS.Timeout | null = null;

  try {
    if (!wasRaw) stdin.setRawMode(true);

    const result = await new Promise<ResolvedTheme | null>((resolve) => {
      listener = (chunk: Buffer): void => {
        buffer += chunk.toString("utf8");
        const theme = parseOsc11BackgroundTheme(buffer);
        if (theme !== null) resolve(theme);
      };
      stdin.on("data", listener);
      timer = setTimeout(() => {
        resolve(null);
      }, opts.timeoutMs);
      try {
        process.stdout.write(OSC11_QUERY);
      } catch {
        resolve(null);
      }
    });

    return result;
  } catch {
    return null;
  } finally {
    if (timer !== null) clearTimeout(timer);
    if (listener !== null) stdin.off("data", listener);
    if (!wasRaw) {
      try {
        stdin.setRawMode(false);
      } catch {
        /* ignore — raw mode restoration best-effort */
      }
    }
  }
}

/**
 * COLORFGBG is `"fg;bg"` (sometimes `"fg;default;bg"`). The last token is
 * the background ANSI 16-color index; 0–6 and 8 are dark, the rest light.
 */
export function parseColorFgBg(value: string | undefined): ResolvedTheme | null {
  if (value === undefined || value === "") return null;
  const parts = value.split(";");
  const bgRaw = parts.at(-1);
  if (bgRaw === undefined) return null;
  const bg = parseInt(bgRaw, 10);
  if (!Number.isInteger(bg)) return null;
  // ANSI 0=black, 1=red, 2=green, 3=yellow, 4=blue, 5=magenta, 6=cyan, 8=bright black.
  const darkBgs = new Set([0, 1, 2, 3, 4, 5, 6, 8]);
  return darkBgs.has(bg) ? "dark" : "light";
}

/**
 * Truecolor (24-bit colour) detection.
 *
 * Terminal capabilities are gathered from the environment rather than probed:
 * `COLORTERM=truecolor|24bit` is the explicit flag, `TERM_PROGRAM` names the
 * running terminal (WezTerm, Ghostty, ...), and `TERM` encodes the terminal
 * family (xterm-kitty, foot-direct, ...). Unknown terminals return `false` so
 * nothing regresses when a terminal is not recognised. `'dark'` fallbacks and
 * non-interactive output (pipes, NO_COLOR, CI) never claim truecolor.
 */
export function supportsTruecolor(): boolean {
  if (!isInteractiveTerminal()) return false;
  if (isColorOptOut()) return false;

  const term = (process.env["TERM"] ?? "").toLowerCase();
  const termProgram = (process.env["TERM_PROGRAM"] ?? "").toLowerCase();
  const colorTerm = (process.env["COLORTERM"] ?? "").toLowerCase();

  // Explicit capability flag.
  if (colorTerm === "truecolor" || colorTerm === "24bit") return true;

  // TERM_PROGRAM names the running terminal.
  if (TRUECOLOR_TERMINALS.has(termProgram)) return true;

  // TERM matches exactly (xterm-kitty) or by dash-separated base (foot-direct).
  if (TRUECOLOR_TERMINALS.has(term)) return true;
  const termBase = term.split("-")[0];
  if (termBase !== undefined && termBase !== "" && TRUECOLOR_TERMINALS.has(termBase)) return true;

  return false;
}

/**
 * Pin chalk to 24-bit colour mode when the terminal advertises truecolor
 * support. Call once at TUI startup, before the first frame renders, so theme
 * hex values render at full fidelity instead of chalk's default 256-colour
 * downgrade. No-op on terminals that do not advertise truecolor.
 */
export function pinTruecolorChalkLevel(): void {
  if (supportsTruecolor()) chalk.level = 3;
}
