/**
 * Color interpolation helpers for animated UI (stall fade, tool flash,
 * thinking glow). Palette tokens are `#rrggbb` hex strings.
 */

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
