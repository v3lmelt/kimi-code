/**
 * Accessibility helpers. Currently a single switch that disables all
 * non-essential motion (spinner frames, glimmer, thinking glow, stall fade,
 * tool flash) so users who prefer reduced motion get a static, calm UI.
 *
 * The switch is read once at construction; set `KIMI_REDUCED_MOTION=1` (or
 * `true`) to enable. Extend with a settings.json key if a user-facing toggle
 * is added later.
 */
export function isReducedMotion(): boolean {
  const v = process.env['KIMI_REDUCED_MOTION'];
  if (v === undefined || v === '') return false;
  return v === '1' || v.toLowerCase() === 'true';
}
