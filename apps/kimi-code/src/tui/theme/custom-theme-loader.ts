/**
 * Custom theme loader — reads JSON files from `~/.kimi-code/themes/`.
 */

import { readdirSync, statSync, unwatchFile, watchFile } from 'node:fs';
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';

import { z } from 'zod';

import { getDataDir } from '#/utils/paths';
import type { ColorPalette, ResolvedTheme } from './colors';
import { getBuiltInPalette } from './colors';
import { currentTheme } from './theme';

export const CustomThemeSchema = z.object({
  name: z.string().min(1),
  displayName: z.string().optional(),
  /** Built-in palette that unspecified tokens fall back to. Defaults to `dark`. */
  base: z.enum(['dark', 'light']).optional(),
  colors: z.record(z.string(), z.string()).optional(),
});

export type CustomThemeDefinition = z.infer<typeof CustomThemeSchema>;

const HEX_COLOR_REGEX = /^#[0-9a-fA-F]{6}$/;

/**
 * Names reserved for built-in themes. A `dark.json` / `light.json` /
 * `auto.json` file would collide with the built-in value, so it can never be
 * selected as a custom theme — hide it from listings.
 */
const RESERVED_THEME_NAMES: ReadonlySet<string> = new Set(['dark', 'light', 'auto']);

export function getCustomThemesDir(): string {
  return join(getDataDir(), 'themes');
}

interface ParsedCustomTheme {
  readonly base: ResolvedTheme;
  readonly colors: Partial<ColorPalette>;
}

async function readCustomTheme(name: string): Promise<ParsedCustomTheme | null> {
  try {
    const content = await readFile(join(getCustomThemesDir(), `${name}.json`), 'utf-8');
    const parsed = CustomThemeSchema.parse(JSON.parse(content));

    // Invalid hex values are dropped (the token falls back to the base
    // palette). We intentionally do not print here: this loader can run while
    // pi-tui owns the terminal, where raw stdout/stderr writes corrupt the
    // rendered screen. Authoring-time validation lives in the JSON schema.
    const colors = Object.fromEntries(
      Object.entries(parsed.colors ?? {}).filter(([, v]) => HEX_COLOR_REGEX.test(v)),
    ) as Partial<ColorPalette>;

    return { base: parsed.base ?? 'dark', colors };
  } catch {
    return null;
  }
}

export async function loadCustomTheme(name: string): Promise<Partial<ColorPalette> | null> {
  return (await readCustomTheme(name))?.colors ?? null;
}

/** Load a custom theme and merge it onto its base palette (dark unless `base` says otherwise). */
export async function loadCustomThemeMerged(name: string): Promise<ColorPalette | null> {
  const parsed = await readCustomTheme(name);
  if (parsed === null) return null;
  return { ...getBuiltInPalette(parsed.base), ...parsed.colors };
}

function toThemeNames(files: readonly string[]): string[] {
  return files
    .filter((f) => f.endsWith('.json'))
    .map((f) => f.replace(/\.json$/, ''))
    .filter((name) => !RESERVED_THEME_NAMES.has(name));
}

export async function listCustomThemes(): Promise<string[]> {
  try {
    const entries = await readdir(getCustomThemesDir(), { withFileTypes: true });
    return toThemeNames(entries.filter((e) => e.isFile()).map((e) => e.name));
  } catch {
    return [];
  }
}

/** Synchronous variant for UI paths (e.g. the `/theme` picker) that cannot await. */
export function listCustomThemesSync(): string[] {
  try {
    const entries = readdirSync(getCustomThemesDir(), { withFileTypes: true });
    return toThemeNames(entries.filter((e) => e.isFile()).map((e) => e.name));
  } catch {
    return [];
  }
}

/* ── Hot reload ──
 *
 * A single active watcher, keyed by the custom theme name. `startThemeWatch`
 * polls the theme's JSON file with `fs.watchFile` (robust to atomic-save
 * editors and to a themes directory that does not exist yet). On a real
 * modification it re-runs `loadCustomThemeMerged` and applies the result to
 * the global `currentTheme` singleton so the next render frame picks up the
 * new colours; `onChange` lets the caller force that repaint.
 */

const THEME_WATCH_POLL_INTERVAL_MS = 500;
const THEME_WATCH_RELOAD_DEBOUNCE_MS = 150;

interface ActiveThemeWatch {
  readonly theme: string;
  readonly filePath: string;
  readonly onChange?: (palette: ColorPalette) => void;
}

let activeThemeWatch: ActiveThemeWatch | undefined;
let reloadDebounceTimer: NodeJS.Timeout | undefined;

/**
 * Watch a custom theme file and re-apply it whenever it changes on disk.
 *
 * Only the file named `<theme>.json` under the custom-themes directory is
 * watched; switching to a different theme (or a built-in one) should call
 * `stopThemeWatch()` first. On a successful reload the new palette is applied
 * to `currentTheme` and `onChange` is invoked with it so the caller can
 * invalidate rendered content and request a repaint.
 */
export function startThemeWatch(
  theme: string,
  onChange?: (palette: ColorPalette) => void,
): void {
  stopThemeWatch();

  const filePath = join(getCustomThemesDir(), `${theme}.json`);
  const active: ActiveThemeWatch = { theme, filePath, onChange };
  activeThemeWatch = active;

  // Baseline mtime at watch start. Some Node versions deliver an initial
  // watchFile callback whose `prev` stat is zeroed; only reload when the file
  // is actually newer than this baseline so that spurious callback (and
  // atime-only touches from our own reads) never reload.
  let lastMtimeMs = 0;
  try {
    lastMtimeMs = statSync(filePath).mtimeMs;
  } catch {
    // File does not exist yet — its first appearance will reload.
    lastMtimeMs = 0;
  }

  watchFile(filePath, { interval: THEME_WATCH_POLL_INTERVAL_MS }, (curr, _prev) => {
    if (activeThemeWatch !== active) return;
    // Only an mtime change means the file was actually saved. A deleted file
    // (zeroed mtime) keeps the last good palette.
    if (curr.mtimeMs <= 0 || curr.mtimeMs <= lastMtimeMs) return;
    lastMtimeMs = curr.mtimeMs;
    scheduleThemeReload(active);
  });
}

/** Stop watching the current custom theme file (no-op if none is active). */
export function stopThemeWatch(): void {
  if (reloadDebounceTimer !== undefined) {
    clearTimeout(reloadDebounceTimer);
    reloadDebounceTimer = undefined;
  }
  if (activeThemeWatch === undefined) return;
  unwatchFile(activeThemeWatch.filePath);
  activeThemeWatch = undefined;
}

function scheduleThemeReload(active: ActiveThemeWatch): void {
  if (reloadDebounceTimer !== undefined) clearTimeout(reloadDebounceTimer);
  reloadDebounceTimer = setTimeout(() => {
    reloadDebounceTimer = undefined;
    void reloadWatchedTheme(active);
  }, THEME_WATCH_RELOAD_DEBOUNCE_MS);
}

async function reloadWatchedTheme(active: ActiveThemeWatch): Promise<void> {
  // Ignore reloads for a theme that is no longer being watched.
  if (activeThemeWatch !== active) return;
  const palette = await loadCustomThemeMerged(active.theme);
  if (palette === null) return; // missing/malformed mid-save — keep the last good palette.
  currentTheme.setPalette(palette);
  active.onChange?.(palette);
}
