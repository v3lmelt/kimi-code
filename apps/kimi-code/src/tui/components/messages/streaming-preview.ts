/**
 * Streaming answer preview — a floating, non-committed assistant text block
 * rendered below the transcript while the model streams. Mirrors Claude Code's
 * `streamingText` overlay: the canonical assistant message is only committed to
 * the transcript once the stream ends, while this layer shows the in-progress
 * text live.
 *
 * It wraps `AssistantMessageComponent` (transient markdown, no bullet) and
 * reveals complete lines only — the in-progress final line is hidden, matching
 * Claude's `substring(0, lastIndexOf('\n') + 1)`.
 */

import { bumpVersion, type Component } from '@moonshot-ai/pi-tui';

import { windowTail } from '#/tui/utils/tail-window';

import { AssistantMessageComponent } from './assistant-message';

/**
 * Upper bound on the transient markdown window rendered per flush. Truncating
 * the streaming preview to this tail keeps re-lex/render cost O(window) as the
 * reply grows instead of O(total^2) over the whole draft. The full text is
 * still committed verbatim when the stream ends (transient:false).
 */
const PREVIEW_WINDOW_MAX_CHARS = 8 * 1024;

export class StreamingPreviewComponent implements Component {
  version = 0;
  private readonly inner: AssistantMessageComponent;

  constructor() {
    this.inner = new AssistantMessageComponent(false); // no bullet → indent prefix
  }

  /** Update the preview to reveal complete lines of `text` (hides the partial last line). */
  updateContent(text: string, opts?: { transient?: boolean }): void {
    const transient = opts?.transient ?? true;
    const complete = text.slice(0, text.lastIndexOf('\n') + 1);
    const display = transient ? windowTail(complete, PREVIEW_WINDOW_MAX_CHARS) : complete;
    this.inner.updateContent(display, { transient });
    bumpVersion(this);
  }

  invalidate(): void {
    this.inner.invalidate();
    bumpVersion(this);
  }

  render(width: number): string[] {
    return this.inner.render(width);
  }
}
