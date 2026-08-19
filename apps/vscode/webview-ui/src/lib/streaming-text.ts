// Lightweight, dependency-free splitter used while a message is streaming.
// Re-parsing the full message with ReactMarkdown on every delta is O(n²) for
// long messages, so the UI degrades to this single regex pass: fenced code
// blocks stay readable as <pre>, everything else (headings, lists, links,
// images, inline code, katex) is emitted as raw text with pre-wrap. The final,
// non-streaming render still goes through ReactMarkdown, so nothing is lost.

export interface StreamingBlock {
  type: "code" | "text";
  value: string;
}

// Matches a fenced code block (``` or ~~~, optional language tag on the
// opener line). An unclosed fence (still mid-stream) does not match and falls
// through as plain text.
const FENCE_RE = /```[^\n]*\r?\n([\s\S]*?)```|~~~[^\n]*\r?\n([\s\S]*?)~~~/g;

export function splitStreamingBlocks(content: string): StreamingBlock[] {
  const blocks: StreamingBlock[] = [];
  let last = 0;
  for (const m of content.matchAll(FENCE_RE)) {
    if (m.index > last) {
      blocks.push({ type: "text", value: content.slice(last, m.index) });
    }
    const code = (m[1] ?? m[2] ?? "").replace(/\r?\n$/, "");
    blocks.push({ type: "code", value: code });
    last = m.index + m[0].length;
  }
  if (last < content.length) {
    blocks.push({ type: "text", value: content.slice(last) });
  }
  return blocks;
}
