/**
 * Renders a user message in the transcript.
 *
 * Claude Code style: no bullet glyph — the message sits on a full-width
 * background bar (#373737 dark / #F0F0F0 light) in plain default text.
 */

import chalk from 'chalk';
import { bumpVersion, Spacer, Text, truncateToWidth, visibleWidth, type Component } from '@moonshot-ai/pi-tui';

import { ImageThumbnail } from '#/tui/components/media/image-thumbnail';
import { currentTheme } from '#/tui/theme';
import { USER_MESSAGE_BG_DARK, USER_MESSAGE_BG_LIGHT } from '#/tui/theme/colors';
import type { ImageAttachment } from '#/tui/utils/image-attachment-store';
import { isRenderCacheEnabled } from '#/tui/utils/render-cache';

export class UserMessageComponent implements Component {
  private text: string;
  private readonly bullet?: string;
  private spacerComponent: Spacer;
  private imageThumbnails: ImageThumbnail[];

  private renderCache: { width: number; lines: string[] } | undefined;

  constructor(text: string, images?: ImageAttachment[], bullet?: string) {
    this.text = text;
    this.bullet = bullet;
    this.spacerComponent = new Spacer(1);
    this.imageThumbnails = images?.map((img) => new ImageThumbnail(img)) ?? [];
  }

  private markRenderDirty(): void {
    this.renderCache = undefined;
    bumpVersion(this);
  }

  invalidate(): void {
    this.markRenderDirty();
    for (const img of this.imageThumbnails) {
      img.invalidate?.();
    }
  }

  render(width: number): string[] {
    const safeWidth = Math.max(0, width);
    if (safeWidth <= 0) return [''];

    if (
      isRenderCacheEnabled() &&
      this.renderCache !== undefined &&
      this.renderCache.width === safeWidth
    ) {
      return this.renderCache.lines;
    }

    const lines: string[] = [];

    // Spacer
    for (const line of this.spacerComponent.render(safeWidth)) {
      lines.push(line);
    }

    // Text is re-dyed from the current theme; invalidate() (theme change) clears
    // the render cache so the new colours are picked up on the next render.
    // Shell echoes (`$ cmd`) pass a custom bullet and arrive pre-coloured;
    // plain user text takes the default text colour on the bar.
    const bg = userMessageBackground();
    const coloredText =
      this.bullet === undefined ? currentTheme.fg('text', this.text) : this.text;
    const textLines = new Text(coloredText, 0, 0).render(safeWidth);
    for (const line of textLines) {
      lines.push(paintBackgroundBar(line, safeWidth, bg));
    }

    // Images sit at the leading column without the background bar — the
    // escape sequences carry their own placement.
    for (const thumbnail of this.imageThumbnails) {
      const imageLines = thumbnail.render(safeWidth);
      for (const line of imageLines) {
        lines.push(line);
      }
    }

    const rendered = lines.map((line) => {
      // Inline image sequences (Kitty / iTerm2) carry their own placement
      // information and have zero visible width, but pi-tui's truncateToWidth
      // treats the embedded base64 payload as visible text and would chop the
      // escape sequence in half, leaving garbage like "0m...". Skip truncation
      // for those lines; the image itself already respects maxWidthCells.
      if (isImageLine(line)) return line;
      return truncateToWidth(line, safeWidth, '…');
    });
    if (isRenderCacheEnabled()) {
      this.renderCache = { width: safeWidth, lines: rendered };
    }
    return rendered;
  }
}

function isImageLine(line: string): boolean {
  return line.includes('\u001B_G') || line.includes('\u001B]1337;File=');
}

/**
 * Picks the bar colour from the active palette: bright `text` ⇒ dark theme ⇒
 * dark bar, dark `text` ⇒ light theme ⇒ light bar. The `ColorPalette`
 * interface is frozen, so this lives outside the token set.
 */
function userMessageBackground(): string {
  const hex = currentTheme.color('text');
  const r = parseInt(hex.slice(1, 3), 16) / 255;
  const g = parseInt(hex.slice(3, 5), 16) / 255;
  const b = parseInt(hex.slice(5, 7), 16) / 255;
  const luma = 0.2126 * r + 0.7152 * g + 0.0722 * b;
  return luma > 0.5 ? USER_MESSAGE_BG_DARK : USER_MESSAGE_BG_LIGHT;
}

/** Pads a rendered line to full width and paints the background bar. */
function paintBackgroundBar(line: string, width: number, bg: string): string {
  const padding = ' '.repeat(Math.max(0, width - visibleWidth(line)));
  return chalk.bgHex(bg)(line + padding);
}

/**
 * Invisible turn-boundary marker for replay. Some replayed records start a
 * new turn without anything to show — the goal driver's synthetic
 * continuation prompt is model-facing and never rendered live — but the
 * transcript still needs a mounted boundary component so step/assistant
 * folding (and window trimming) can find the turn edges. Renders zero lines.
 */
export class ReplayTurnBoundaryComponent implements Component {
  invalidate(): void {}
  render(_width: number): string[] {
    return [];
  }
}
