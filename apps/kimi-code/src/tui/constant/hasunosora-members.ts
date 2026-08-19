/**
 * Hasunosora member icon roster — each member's personal icon rendered as a
 * multi-row terminal pixel silhouette, painted in the member's image color.
 * Silhouettes are derived from the official icons' pixel grids (two pixel
 * rows per terminal row via half-block chars), so facial / interior details
 * appear as holes (spaces), exactly like the monochrome source icons.
 *
 * Colors are fixed real-world member colors, not theme semantics, so they
 * live here instead of `ColorPalette` (mirroring the `AUTO_ACCEPT_*`
 * precedent in `theme/colors.ts`): each entry carries a dark-background and
 * a light-background variant, and consumers pick by palette-text brightness.
 */
export interface HasunosoraMember {
  /** Member display name, as in the source material. */
  name: string;
  /** Pixel silhouette of the member's icon, one string per row. */
  icon: readonly string[];
  /** Image color for dark terminal backgrounds. */
  colorDark: string;
  /** Darkened variant keeping ≥3:1 on white for light backgrounds. */
  colorLight: string;
}

export const HASUNOSORA_MEMBERS: readonly HasunosoraMember[] = [
  // 日野下花帆 — rabbit, yellow.
  {
    name: '日野下花帆',
    icon: [
      '  ▄███      ██▄',
      ' ▄████     █████',
      ' █████     █████',
      '  █████    █████',
      '   ████   ▄███▀',
      '    ████▄▄███▀',
      '  ▄███████████▄',
      ' ▄██████████████',
      '▀█████▄████▄████▀',
      '▀▀██████████████▀',
      '   ▀▀▀██████▀▀▀',
    ],
    colorDark: '#F5A300',
    colorLight: '#B87A00',
  },
  // 村野さやか — alarm clock, blue.
  {
    name: '村野さやか',
    icon: [
      '      ██',
      '▄███ ▄██▄ ████',
      '██▀▄███████▄▀█',
      '  ██▄▀██▀███▄',
      ' █████▄▄█████',
      '  ██████████▀',
      ' ▄▄▀██████▀▀▄',
      ' ▀    ▀▀    ▀▀',
    ],
    colorDark: '#5B9BDF',
    colorLight: '#2E6FB0',
  },
  // 乙宗梢 — gramophone (唱片机), green.
  {
    name: '乙宗梢',
    icon: [
      '    ▄█',
      '   ▄███',
      '  ██████',
      ' ████████▄',
      '▀▀ ▄▄▄▄▄▄▀██',
      '  ████████ █',
      ' ▄█████████',
    ],
    colorDark: '#5BBF8A',
    colorLight: '#2E7D52',
  },
  // 夕霧綴理 — penguin, bordeaux.
  {
    name: '夕霧綴理',
    icon: [
      '     ▄███▄▄',
      '   ▄█▀▀█▀▀█▄',
      '   ██ ▄▀▄▀██',
      '   ██ ▄▄▄ ██',
      '  ██       ██',
      ' ██▀       ▀██▄',
      '▀███       ██▀█',
      '   █████████',
    ],
    colorDark: '#C8283C',
    colorLight: '#A02030',
  },
  // 大沢瑠璃乃 — battery with lightning bolts, pink.
  {
    name: '大沢瑠璃乃',
    icon: [
      '   ▀█▄    ▄█▀',
      '    ██    ██',
      '     █    ▄',
      ' ▄▄▄▄▄▄▄▄▄▄▄▄▄',
      '█▀▄▄▄ ▄▄▄    ▀█',
      '█ ███ █ █     ▀█',
      '█ ███ █▄█     █▀',
      '▀█▄▄▄▄▄▄▄▄▄▄▄█▀',
    ],
    colorDark: '#F0679E',
    colorLight: '#C43A73',
  },
  // 藤島慈 — microphone with pop filter, gray-lavender.
  {
    name: '藤島慈',
    icon: [
      '    ▄     ▄████',
      '▄█▀███▀▄  ██████',
      '█▄█████ █ ██████',
      '█▀█████ █ ▄▄▄▄▄▄',
      '▀██▀▀▀██▀  █▀▀█',
      '  ▀███     ███▀',
      '    ▀▄▄▄▄▄▄▄█',
      '           ▄█▄▄',
    ],
    colorDark: '#B0A8C8',
    colorLight: '#6E6890',
  },
];

/**
 * Pick the color variant readable against the active palette. Light
 * palettes use near-black text tokens, so a quick brightness probe on
 * `text` selects the variant — same approach as `autoAcceptColor()` in
 * `chrome/footer.ts`.
 */
export function hasunosoraMemberColor(member: HasunosoraMember, textHex: string): string {
  const r = Number.parseInt(textHex.slice(1, 3), 16);
  const g = Number.parseInt(textHex.slice(3, 5), 16);
  const b = Number.parseInt(textHex.slice(5, 7), 16);
  return r + g + b < 3 * 128 ? member.colorLight : member.colorDark;
}

/** Random member index for one TUI launch. */
export function randomHasunosoraMemberIndex(): number {
  return Math.floor(Math.random() * HASUNOSORA_MEMBERS.length);
}
