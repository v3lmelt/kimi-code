// Use U+25CF instead of U+23FA to avoid emoji/fallback rendering in terminals.
export const STATUS_BULLET = '● ';

// Shared transcript markers. Keep widths stable because message wrapping
// assumes the marker occupies the leading cells.
export const SUCCESS_MARK = '✓ ';
export const FAILURE_MARK = '✗ ';

// Shared selector markers — keep every list picker visually consistent.
// SELECT_POINTER marks the highlighted row; CURRENT_MARK is appended to the
// row that is the currently-active value. See .agents/skills/write-tui/DESIGN.md.
export const SELECT_POINTER = '❯';
export const CURRENT_MARK = '← current';

// Claude Code-style transcript glyphs, shared by message and dialog slices.
// RESPONSE_GUTTER is the dim 5-column prefix on tool-result/response sub-lines;
// TEARDROP marks system notices (e.g. compaction); THINKING_MARK heads the
// collapsed thinking indicator.
export const RESPONSE_GUTTER = '  ⎿  ';
export const TEARDROP = '✻';
export const THINKING_MARK = '∴';
