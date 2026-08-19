/**
 * Tail-window `text` to at most `max` chars, aligned to complete line starts so
 * the window never shows a torn line across flush boundaries. Only used for
 * transient streaming previews (assistant text, thinking drafts) where a
 * bounded suffix is styled/wrapped per flush; commits always render the full
 * text.
 */
export function windowTail(text: string, max: number): string {
  if (text.length <= max) return text;
  let start = text.length - max;
  const newline = text.lastIndexOf('\n', start - 1);
  if (newline >= 0) start = newline + 1;
  return text.slice(start);
}
