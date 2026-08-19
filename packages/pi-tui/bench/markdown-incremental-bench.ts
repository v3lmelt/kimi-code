/**
 * Benchmark: streaming markdown render in pi-tui.
 *
 * Compares the append-only incremental fast path (one Markdown instance,
 * setText() per frame) against a full re-render of the whole text every frame
 * (a fresh Markdown instance per frame), over a ~100KB streamed document
 * delivered in ~1-2KB chunks.
 *
 * Run with: pnpm --filter @moonshot-ai/pi-tui bench:markdown
 */
import assert from "node:assert";
import { performance } from "node:perf_hooks";
import { Markdown } from "../src/components/markdown.ts";
import { defaultMarkdownTheme } from "../test/test-themes.ts";

const WIDTH = 100;
const TARGET_BYTES = 100 * 1024;

// Deterministic PRNG so the streamed document is reproducible.
let seed = 42;
function rng(): number {
	seed = (seed * 1103515245 + 12345) % 2 ** 31;
	return seed / 2 ** 31;
}

const WORDS = [
	"function", "render", "stream", "buffer", "token", "cache", "incremental", "width",
	"terminal", "ansi", "wrap", "markdown", "parser", "syntax", "block", "inline",
	"compute", "layout", "pixel", "frame", "scroll", "cursor", "color", "style",
];

function words(n: number): string {
	const parts: string[] = [];
	for (let i = 0; i < n; i++) {
		parts.push(WORDS[Math.floor(rng() * WORDS.length)]!);
	}
	return parts.join(" ");
}

/** One 1-2KB chunk of realistic LLM-style markdown output. */
function makeChunk(i: number): string {
	const parts: string[] = [];
	const blocks = 1 + Math.floor(rng() * 4);
	for (let j = 0; j < blocks; j++) {
		const kind = rng();
		if (kind < 0.3) {
			// paragraph with inline markup, sometimes CJK
			const inline = words(8 + Math.floor(rng() * 20));
			const style = rng();
			if (style < 0.3) {
				parts.push(`段${i}.${j} 中文内容 ${inline} 包含**加粗**与\`inline code\``);
			} else if (style < 0.6) {
				parts.push(`**bold** ${inline} and \`code\` ${words(6)}`);
			} else {
				parts.push(inline);
			}
		} else if (kind < 0.5) {
			// code block
			const codeLines: string[] = [];
			for (let k = 0; k < 3 + Math.floor(rng() * 6); k++) {
				codeLines.push(`  const ${WORDS[k % WORDS.length]!}${k} = "${words(4)}";`);
			}
			parts.push("```ts\n" + codeLines.join("\n") + "\n```");
		} else if (kind < 0.7) {
			// list
			const items: string[] = [];
			for (let k = 0; k < 2 + Math.floor(rng() * 4); k++) {
				items.push(`- ${words(6 + Math.floor(rng() * 8))}`);
			}
			parts.push(items.join("\n"));
		} else if (kind < 0.85) {
			parts.push(`## Section ${i}.${j}: ${words(5)}`);
		} else {
			parts.push(`> ${words(10)}`);
		}
	}
	return parts.join("\n\n") + "\n";
}

// Build the streamed document as cumulative appends.
const frames: string[] = [];
{
	let text = "";
	let guard = 0;
	while (text.length < TARGET_BYTES && guard < 200) {
		text += makeChunk(guard);
		frames.push(text);
		guard++;
	}
}

function renderFull(text: string): string[] {
	return new Markdown(text, 0, 0, defaultMarkdownTheme).render(WIDTH);
}

// Warm-up.
{
	const warm = new Markdown(frames[Math.floor(frames.length / 2)]!, 0, 0, defaultMarkdownTheme);
	warm.render(WIDTH);
	warm.render(WIDTH);
}

// Incremental path: single instance, setText + render per frame.
{
	const md = new Markdown(frames[0]!, 0, 0, defaultMarkdownTheme);
	md.render(WIDTH);
	const start = performance.now();
	for (let i = 1; i < frames.length; i++) {
		md.setText(frames[i]!);
		md.render(WIDTH);
	}
	const totalMs = performance.now() - start;
	const avgMs = totalMs / frames.length;
	console.log(`incremental:  ${totalMs.toFixed(1)}ms total, ${avgMs.toFixed(3)}ms/frame (${frames.length} frames, ${frames.at(-1)!.length} chars)`);
}

// Full re-render path: fresh instance per frame.
{
	const start = performance.now();
	for (let i = 0; i < frames.length; i++) {
		renderFull(frames[i]!);
	}
	const totalMs = performance.now() - start;
	const avgMs = totalMs / frames.length;
	console.log(`full:         ${totalMs.toFixed(1)}ms total, ${avgMs.toFixed(3)}ms/frame`);
}

// Measure both in one pass for a stable ratio.
function bench(fn: (i: number) => void): number {
	const start = performance.now();
	for (let i = 1; i < frames.length; i++) {
		fn(i);
	}
	return performance.now() - start;
}

const md = new Markdown(frames[0]!, 0, 0, defaultMarkdownTheme);
md.render(WIDTH);
// Warm both sides once more.
for (let i = 1; i < frames.length; i++) {
	md.setText(frames[i]!);
	md.render(WIDTH);
}
for (let i = 0; i < frames.length; i++) {
	renderFull(frames[i]!);
}

const incMs = bench((i) => {
	md.setText(frames[i]!);
	md.render(WIDTH);
});
const fullMs = bench((i) => renderFull(frames[i]!));

console.log(`\nmeasured pass (${frames.length - 1} frames):`);
console.log(`  incremental total: ${incMs.toFixed(1)}ms`);
console.log(`  full total:        ${fullMs.toFixed(1)}ms`);
console.log(`  speedup:           ${(fullMs / incMs).toFixed(2)}x`);

// Equivalence: every incremental frame must equal the full render byte-for-byte.
for (let i = 1; i < frames.length; i++) {
	md.setText(frames[i]!);
	const inc = md.render(WIDTH);
	const full = renderFull(frames[i]!);
	assert.strictEqual(inc.length, full.length, `frame ${i}: line count mismatch`);
	assert.strictEqual(inc.join("\n"), full.join("\n"), `frame ${i}: output mismatch`);
}
console.log(`equivalence: ${frames.length - 1}/${frames.length - 1} frames identical to full render`);
