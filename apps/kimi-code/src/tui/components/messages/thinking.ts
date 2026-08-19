/**
 * Renders thinking content in the transcript.
 * Supports live in-place updates while thinking streams, then finalizes
 * without replacing the component.
 * Supports expand/collapse via Ctrl+O (shared with tool output).
 *
 * Claude Code style: the collapsed block is a single dim-italic
 * `∴ Thinking… (ctrl+o to expand)` line; the live block shows the same
 * marker above the streamed content (the activity pane owns the working
 * spinner, so this component no longer animates one itself).
 */

import { bumpVersion, Text, truncateToWidth, type Component, type TUI } from '@moonshot-ai/pi-tui';

import { MESSAGE_INDENT, THINKING_LIVE_WINDOW_CHARS, THINKING_PREVIEW_LINES } from '#/tui/constant/rendering';
import { STATUS_BULLET, THINKING_MARK } from '#/tui/constant/symbols';
import { currentTheme } from '#/tui/theme';
import { isRenderCacheEnabled } from '#/tui/utils/render-cache';
import { windowTail } from '#/tui/utils/tail-window';

export type ThinkingRenderMode = 'live' | 'finalized';

export class ThinkingComponent implements Component {
  // Versioned from construction. Every mutation (setText / setExpanded /
  // setCollapse / finalize / theme invalidate) goes through markRenderDirty()
  // -> bumpVersion(), so the transcript container can short-circuit idle blocks.
  version = 0;
  private text: string;
  private showMarker: boolean;
  private mode: ThinkingRenderMode;
  // When true, the block collapses to a single "∴ Thinking…" indicator
  // (Ctrl+O expand still reveals the full text).
  private collapse: boolean;
  private expanded = false;
  // Hold a single Text instance so pi-tui's (text, width) → lines cache
  // actually survives across renders. Re-constructing per render destroys
  // the cache and forces full re-wrap on every frame, which dominates CPU
  // once the transcript accumulates many finalized thinking blocks.
  private readonly textComponent: Text;

  private renderCache: { width: number; lines: string[] } | undefined;

  constructor(
    text: string,
    showMarker: boolean = true,
    mode: ThinkingRenderMode = 'finalized',
    // Unused — kept for call-site compatibility. The activity pane owns the
    // spinner now, so the component no longer needs a TUI handle to drive
    // an animation timer.
    _ui?: TUI,
    collapse: boolean = false,
  ) {
    this.text = text;
    this.showMarker = showMarker;
    this.mode = mode;
    this.collapse = collapse;
    this.textComponent = new Text(this.styled(this.displayText()), 0, 0);
  }

  /**
   * Text fed to the underlying Text component. While live, only a bounded tail
   * window is styled and wrapped so each flush costs O(window) instead of
   * re-styling/re-wrapping the whole growing draft; the full text stays on the
   * component and is restored by {@link finalize}. Finalized mode always wraps
   * the full text.
   */
  private displayText(): string {
    if (this.mode === 'finalized') return this.text;
    return windowTail(this.text, THINKING_LIVE_WINDOW_CHARS);
  }

  private markRenderDirty(): void {
    this.renderCache = undefined;
    bumpVersion(this);
  }

  invalidate(): void {
    this.markRenderDirty();
    this.textComponent.setText(this.styled(this.displayText()));
  }

  setText(text: string): void {
    if (this.text === text) return;
    this.text = text;
    this.markRenderDirty();
    this.textComponent.setText(this.styled(this.displayText()));
  }

  private styled(text: string): string {
    return currentTheme.italicFg('textDim', text);
  }

  finalize(): void {
    this.mode = 'finalized';
    // Live mode only styled/wrapped the tail window; restore the full text so
    // the finalized preview and the expanded view wrap the complete content.
    this.textComponent.setText(this.styled(this.displayText()));
    this.markRenderDirty();
  }

  /** No timers to release — kept for the transcript cleanup contract. */
  dispose(): void {}

  setExpanded(expanded: boolean): void {
    if (this.expanded === expanded) return;
    this.expanded = expanded;
    this.markRenderDirty();
  }

  setCollapse(collapse: boolean): void {
    if (this.collapse === collapse) return;
    this.collapse = collapse;
    this.markRenderDirty();
  }

  render(width: number): string[] {
    if (
      isRenderCacheEnabled() &&
      this.renderCache !== undefined &&
      this.renderCache.width === width
    ) {
      return this.renderCache.lines;
    }

    const contentWidth = Math.max(1, width - MESSAGE_INDENT.length);
    const contentLines = this.text.length > 0 ? this.textComponent.render(contentWidth) : [];

    let rendered: string[];
    const thinkingMark = currentTheme.italicFg('textDim', `${THINKING_MARK} Thinking…`);
    if (this.mode === 'live') {
      if (this.collapse) {
        rendered = ['', thinkingMark];
      } else {
        const visibleLines =
          contentLines.length > THINKING_PREVIEW_LINES
            ? contentLines.slice(contentLines.length - THINKING_PREVIEW_LINES)
            : contentLines;
        rendered = ['', thinkingMark, ...visibleLines.map((line) => MESSAGE_INDENT + line)];
      }
    } else if (this.collapse && !this.expanded) {
      rendered = ['', thinkingMark + currentTheme.dim(' (ctrl+o to expand)')];
    } else {
      const lines: string[] = [''];
      for (let i = 0; i < contentLines.length; i++) {
        const p = i === 0 && this.showMarker ? currentTheme.fg('textDim', STATUS_BULLET) : MESSAGE_INDENT;
        lines.push(p + contentLines[i]);
      }

      if (this.expanded || contentLines.length <= THINKING_PREVIEW_LINES) {
        rendered = lines;
      } else {
        // Leading blank + first PREVIEW_LINES content lines + hint line.
        const truncated = lines.slice(0, 1 + THINKING_PREVIEW_LINES);
        const remaining = contentLines.length - THINKING_PREVIEW_LINES;
        const hint = `… (${String(remaining)} more lines, ctrl+o to expand)`;
        const indentWidth = Math.min(MESSAGE_INDENT.length, Math.max(0, width));
        const hintWidth = Math.max(0, width - indentWidth);
        truncated.push(
          ' '.repeat(indentWidth) + currentTheme.dim(truncateToWidth(hint, hintWidth, '…')),
        );
        rendered = truncated;
      }
    }

    if (isRenderCacheEnabled()) {
      this.renderCache = { width, lines: rendered };
    }
    return rendered;
  }
}
