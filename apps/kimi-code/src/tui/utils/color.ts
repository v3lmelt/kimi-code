/**
 * Color interpolation helpers for animated UI (stall fade, tool flash,
 * thinking glow, ultracode ripple). Palette tokens are `#rrggbb` hex strings.
 */

import chalk from 'chalk';

interface RGB {
  r: number;
  g: number;
  b: number;
}

function parseHex(hex: string): RGB {
  const m = /^#([0-9a-fA-F]{6})$/.exec(hex.trim());
  if (m === null) return { r: 0, g: 0, b: 0 };
  const v = m[1]!;
  return {
    r: Number.parseInt(v.slice(0, 2), 16),
    g: Number.parseInt(v.slice(2, 4), 16),
    b: Number.parseInt(v.slice(4, 6), 16),
  };
}

/** Linear interpolate between two `#rrggbb` colors. `t` is clamped to [0,1]. */
export function interpolateHexColor(hexA: string, hexB: string, t: number): string {
  const a = parseHex(hexA);
  const b = parseHex(hexB);
  const k = Math.min(1, Math.max(0, t));
  const r = Math.round(a.r + (b.r - a.r) * k);
  const g = Math.round(a.g + (b.g - a.g) * k);
  const bl = Math.round(a.b + (b.b - a.b) * k);
  const toHex = (n: number): string => n.toString(16).padStart(2, '0');
  return `#${toHex(r)}${toHex(g)}${toHex(bl)}`;
}

/**
 * Yellow ripple for the animated ultracode label. Each character of
 * `text` is swept by a traveling cosine wave on a wall-clock loop (default 2s
 * period), so a highlight band glides along the label as its color blends
 * between `from` and `to` (the palette's `effortUltra` and a lighter yellow).
 * Spaces are left untouched. Cheap by design — the label is ~9 characters.
 */
export function rippleText(
  text: string,
  from: string,
  to: string,
  wallClockMs: number,
  bold = false,
  periodMs = 2_000,
): string {
  const chars = Array.from(text);
  const count = chars.length;
  if (count === 0) return '';
  const phase = (wallClockMs % periodMs) / periodMs; // 0..1 over the period
  return chars
    .map((char, position) => {
      if (char === ' ') return char;
      const at = count <= 1 ? 0 : position / (count - 1);
      // Traveling cosine: 1 where the ripple currently sits, 0 half a period away.
      const blend = 0.5 + 0.5 * Math.cos(2 * Math.PI * (at - phase));
      const color = interpolateHexColor(from, to, blend);
      return bold ? chalk.hex(color).bold(char) : chalk.hex(color)(char);
    })
    .join('');
}
