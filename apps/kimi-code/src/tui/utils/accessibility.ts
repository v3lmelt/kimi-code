/**
 * Accessibility helpers. Currently a single switch that disables all
 * non-essential motion (spinner frames, glimmer, thinking glow, stall fade,
 * tool flash) so users who prefer reduced motion get a static, calm UI.
 *
 * `tui.toml` supplies the persisted preference. `KIMI_REDUCED_MOTION` remains
 * an explicit process-level override for scripts and temporary sessions.
 */
let reducedMotionPreference = false;

export function setReducedMotionPreference(enabled: boolean): void {
  reducedMotionPreference = enabled;
}

export function isReducedMotion(): boolean {
  const v = process.env['KIMI_REDUCED_MOTION'];
  if (v === undefined || v === '') return reducedMotionPreference;
  return v === '1' || v.toLowerCase() === 'true';
}
