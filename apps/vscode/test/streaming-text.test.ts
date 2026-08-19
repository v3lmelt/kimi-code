import { describe, expect, it } from "vitest";
import { splitStreamingBlocks } from "../webview-ui/src/lib/streaming-text";

describe("splitStreamingBlocks", () => {
  it("returns plain text when there are no fences", () => {
    expect(splitStreamingBlocks("hello\nworld")).toEqual([{ type: "text", value: "hello\nworld" }]);
  });

  it("splits a fenced code block with a language tag", () => {
    expect(splitStreamingBlocks("intro\n\n```ts\nconst x = 1;\n```\n\noutro")).toEqual([
      { type: "text", value: "intro\n\n" },
      { type: "code", value: "const x = 1;" },
      { type: "text", value: "\n\noutro" },
    ]);
  });

  it("supports tilde fences and bare fences", () => {
    expect(splitStreamingBlocks("~~~bash\necho hi\n~~~")).toEqual([{ type: "code", value: "echo hi" }]);
    expect(splitStreamingBlocks("```\nplain\n```")).toEqual([{ type: "code", value: "plain" }]);
  });

  it("keeps an unclosed fence as raw text (mid-stream state)", () => {
    expect(splitStreamingBlocks("```ts\nconst x =")).toEqual([{ type: "text", value: "```ts\nconst x =" }]);
  });

  it("keeps katex, links and images as raw text", () => {
    expect(splitStreamingBlocks("$E=mc^2$ [link](https://example.com) ![img](a.png)")).toEqual([
      { type: "text", value: "$E=mc^2$ [link](https://example.com) ![img](a.png)" },
    ]);
  });

  it("handles multiple code blocks", () => {
    expect(splitStreamingBlocks("a\n```\n1\n```\nb\n```\n2\n```\nc")).toEqual([
      { type: "text", value: "a\n" },
      { type: "code", value: "1" },
      { type: "text", value: "\nb\n" },
      { type: "code", value: "2" },
      { type: "text", value: "\nc" },
    ]);
  });

  it("strips only the trailing newline of a code block", () => {
    expect(splitStreamingBlocks("```js\nline1\nline2\n\n```")).toEqual([{ type: "code", value: "line1\nline2\n" }]);
  });

  it("preserves every segment across mixed fence styles", () => {
    // Fence markers, the language tag line, and one trailing newline per code
    // block are stripped by design; every other character is kept in order.
    expect(splitStreamingBlocks("head\n```python\nprint(1)\n```\nmid\n~~~\nx\n~~~\ntail")).toEqual([
      { type: "text", value: "head\n" },
      { type: "code", value: "print(1)" },
      { type: "text", value: "\nmid\n" },
      { type: "code", value: "x" },
      { type: "text", value: "\ntail" },
    ]);
  });
});
