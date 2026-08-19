/**
 * Color palette definitions for dark and light themes.
 *
 * `darkColors` / `lightColors` are the semantic `ColorPalette` consumed by
 * every UI component via the global Theme singleton. Each token holds its hex
 * value directly — see the per-token docs on `ColorPalette` for what each one
 * controls.
 *
 * Light palette values are tuned for ≥ 4.5:1 contrast against #FFFFFF
 * for text tokens and ≥ 3:1 for chrome (border / large text), matching
 * WCAG AA.
 */

// Each token below documents where it is actually consumed, so theme authors
// know what changing it affects. "Widely" means the token is read across most
// dialogs/messages rather than in one specific place.
export interface ColorPalette {
  // ── Brand ──
  /** Dominant interactive/brand colour: links & inline code, the selected item
   *  in nearly every dialog, the focused editor border, plan/"running" badges,
   *  spinners. The most widely used token. */
  primary: string;
  /** Secondary highlight: approval "▶" prefix, device-code box, image
   *  placeholder, BTW / queue panes, custom-registry import. */
  accent: string;

  // ── Text ──
  /** Default body text: dialog bodies, todo titles, footer model label,
   *  markdown headings, tool/read output, and assistant-side message bullets
   *  (assistant / tool / agent / read) plus markdown list bullets. */
  text: string;
  /** Emphasised / bold text: input dialogs, status messages. */
  textStrong: string;
  /** Secondary, dimmed text (the most widely used dim shade): thinking blocks,
   *  hints, descriptions, completed todos, markdown quotes, and the footer
   *  status bar (cwd path, git badge). */
  textDim: string;
  /** Faintest text: counters, scroll info, descriptions, markdown link URLs,
   *  code-block borders. */
  textMuted: string;

  // ── Surface ──
  /** Borders: pane & editor borders, markdown horizontal rule. */
  border: string;
  /** Focus / attention border — currently only the approval panel. */
  borderFocus: string;

  // ── State ──
  /** Success: ✓ marks, "enabled", completed states. */
  success: string;
  /** Warning: auto/yolo badges, stale markers, plan-mode hint. */
  warning: string;
  /** Error: error messages, failed tool output. */
  error: string;

  // ── Diff (all consumed by components/media/diff-preview.ts) ──
  /** Added lines. */
  diffAdded: string;
  /** Removed lines. */
  diffRemoved: string;
  /** Added lines — intra-line changed words (bold). */
  diffAddedStrong: string;
  /** Removed lines — intra-line changed words (bold). */
  diffRemovedStrong: string;
  /** Line-number gutter (also approval panel/preview). */
  diffGutter: string;
  /** Meta / hunk headers. */
  diffMeta: string;

  // ── Roles ──
  /** User-accent hue. Now only the plugin-command name — user messages render
   *  plain text on the USER_MESSAGE_BG bar (no bullet), and skill activation
   *  uses a text-coloured bullet with a bold default-text name. */
  roleUser: string;

  // ── Shell mode ──
  /** Shell mode (`!`): the `!` prompt symbol, bash-mode editor border, and the
   *  echoed `$ command` line. Its own hue (violet), distinct from
   *  plan-mode (primary) and the user role (roleUser). */
  shellMode: string;

  // ── Ultracode ──
  /** Ultracode mode hue (yellow): the ultracode pill in
   *  the footer, the ultracode effort segment, and animated ultracode labels. */
  effortUltra: string;
}

export const darkColors: ColorPalette = {
  primary: '#4FA8FF',
  accent: '#5BC0BE',

  text: '#E0E0E0',
  textStrong: '#F5F5F5',
  textDim: '#888888',
  textMuted: '#6B6B6B',

  border: '#5A5A5A',
  borderFocus: '#E8A838',

  success: '#4EC87E',
  warning: '#E8A838',
  error: '#E85454',

  diffAdded: '#4EC87E',
  diffRemoved: '#E85454',
  diffAddedStrong: '#7AD99B',
  diffRemovedStrong: '#F08585',
  diffGutter: '#6B6B6B',
  diffMeta: '#888888',

  roleUser: '#FFCB6B',
  shellMode: '#BD93F9',
  effortUltra: '#FFC53D',
};

/**
 * Claude Code palette, dark variant: exact Claude Code values — the Claude
 * orange as brand/primary, lavender for focused borders, magenta for shell
 * mode. Token set is identical to dark/light. User messages render as plain
 * text on a #373737 background bar, so roleUser is plain white.
 */
export const claudeColors: ColorPalette = {
  primary: '#D77757',
  accent: '#EB9F7F',

  text: '#FFFFFF',
  textStrong: '#FFFFFF',
  textDim: '#999999',
  textMuted: '#505050',

  border: '#888888',
  borderFocus: '#B1B9F9',

  success: '#4EBA65',
  warning: '#FFC107',
  error: '#FF6B80',

  diffAdded: '#4EBA65',
  diffRemoved: '#FF6B80',
  diffAddedStrong: '#38A260',
  diffRemovedStrong: '#B3596B',
  diffGutter: '#505050',
  diffMeta: '#999999',

  roleUser: '#FFFFFF',
  shellMode: '#FD5DB1',
  effortUltra: '#FFC53D',
};

/**
 * Claude Code palette, light variant: exact Claude Code light values.
 * Accent/diff-strong/shell hues are darkened from the dark variants to keep
 * ≥ 3:1 contrast on white (user messages sit on a #F0F0F0 background bar).
 */
export const claudeLightColors: ColorPalette = {
  primary: '#D77757',
  accent: '#B85C3E',

  text: '#000000',
  textStrong: '#000000',
  textDim: '#666666',
  textMuted: '#AFAFAF',

  border: '#999999',
  borderFocus: '#5769F7',

  success: '#2C7A39',
  warning: '#966C1E',
  error: '#AB2B3F',

  diffAdded: '#2C7A39',
  diffRemoved: '#AB2B3F',
  diffAddedStrong: '#1E6E2F',
  diffRemovedStrong: '#8E2233',
  diffGutter: '#AFAFAF',
  diffMeta: '#666666',

  roleUser: '#000000',
  shellMode: '#D6336C',
  effortUltra: '#8A6A00',
};

export const lightColors: ColorPalette = {
  primary: '#1565C0',
  accent: '#00838F',

  text: '#1A1A1A',
  textStrong: '#1A1A1A',
  textDim: '#454545',
  textMuted: '#5F5F5F',

  border: '#737373',
  borderFocus: '#92660A',

  success: '#0E7A38',
  warning: '#92660A',
  error: '#B91C1C',

  diffAdded: '#0E7A38',
  diffRemoved: '#B91C1C',
  diffAddedStrong: '#0E7A38',
  diffRemovedStrong: '#B91C1C',
  diffGutter: '#737373',
  diffMeta: '#5F5F5F',

  roleUser: '#9A4A00',
  shellMode: '#7C3AED',
  effortUltra: '#8A6A00',
};

export type ResolvedTheme = 'dark' | 'light';

/**
 * Claude's auto-accept pill violet — a one-off hue with no palette token.
 * Not part of `ColorPalette`; components import these constants directly
 * and pick by resolved dark/light.
 */
export const AUTO_ACCEPT_DARK = '#AF87FF';
export const AUTO_ACCEPT_LIGHT = '#8700FF';

/**
 * Claude Code-style user-message background bar — the full-width bar behind
 * user messages replaces any bullet glyph. Not part of `ColorPalette`;
 * components import these constants directly and pick by the active
 * palette's text brightness (bright text ⇒ dark bar, dark text ⇒ light bar).
 */
export const USER_MESSAGE_BG_DARK = '#373737';
export const USER_MESSAGE_BG_LIGHT = '#F0F0F0';

/** Synchronous palette lookup for built-in themes only. */
export function getBuiltInPalette(resolved: ResolvedTheme): ColorPalette {
  return resolved === 'dark' ? darkColors : lightColors;
}
