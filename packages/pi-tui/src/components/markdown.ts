import { spawn } from "node:child_process";
import { Marked, type Token, Tokenizer, type Tokens } from "marked";
import { getCapabilities, hyperlink, isImageLine } from "../terminal-image.ts";
import { bumpVersion, type Component } from "../tui.ts";
import { applyBackgroundToLine, visibleWidth, wrapTextWithAnsi } from "../utils.ts";

const STRICT_STRIKETHROUGH_REGEX = /^(~~)(?=[^\s~])((?:\\.|[^\\])*?(?:\\.|[^\s~\\]))\1(?=[^~]|$)/;

/**
 * Non-breaking space used to bind a trailing "N." / "N)" to the preceding word
 * so line wrapping cannot orphan the number onto its own line.
 */
const NON_BREAKING_SPACE = "\u00a0";

/**
 * Block-level token types rendered inside list items that should span the full
 * content width instead of being indented under the list marker.
 */
const UNINDENTED_LIST_CHILD_TYPES = new Set(["code", "blockquote", "hr", "table"]);

/**
 * Base-language label for a fenced code block: strips dash-modifiers and
 * trailing digits so "bash-shell" -> "bash" and "python3" -> "python".
 */
function baseLanguageLabel(lang: string): string {
	const base = lang.trim().split("-")[0] ?? "";
	return base.replace(/\d+$/, "");
}

/**
 * Replace the space before a trailing "N." / "N)" at the end of a text segment
 * with a non-breaking space, so the wrap algorithm keeps the number glued to
 * the preceding word instead of splitting it onto the next line.
 */
function bindTrailingNumber(text: string): string {
	return text.replace(/(\s)(\d+[.)])(\s*)$/, (_match, _space: string, number: string, tail: string) => {
		return `${NON_BREAKING_SPACE}${number}${tail}`;
	});
}

let cachedIssueRepo: { origin: string; repoPath: string } | undefined;
/** Guards against starting the async git lookup more than once. */
let issueRepoQueryStarted = false;

/** Fallback forge used while the async lookup is still in flight. */
const DEFAULT_ISSUE_REPO: { origin: string; repoPath: string } = {
	origin: "https://github.com",
	repoPath: "",
};

/** Cap the git subprocess lifetime so a hung git cannot pin the event loop. */
const ISSUE_REPO_TIMEOUT_MS = 1500;

/**
 * Normalise a `git remote get-url` output into an origin host + repo path.
 * Rewrites git@host:owner/repo.git, ssh://git@host/… and git:// URLs to
 * https://host/owner/repo so the host + path can be read. Falls back to
 * github.com when the remote is empty.
 */
function parseIssueRepo(remote: string): { origin: string; repoPath: string } {
	const trimmed = remote.trim();
	if (!trimmed) return DEFAULT_ISSUE_REPO;
	const url = trimmed
		.replace(/^git@([^:]+):/, "https://$1/")
		.replace(/^ssh:\/\/git@([^/]+)\//, "https://$1/")
		.replace(/^git:\/\/([^/]+)\//, "https://$1/")
		.replace(/\.git$/, "");
	const httpsUrl = /^https?:\/\//.test(url) ? url : `https://${url}`;
	const match = /^https?:\/\/([^/]+)\/(.+)$/.exec(httpsUrl);
	if (!match) return { origin: httpsUrl, repoPath: "" };
	return { origin: `https://${match[1]}`, repoPath: match[2]!.replace(/\/+$/, "") };
}

/**
 * Kick off an asynchronous `git config --get remote.origin.url` lookup so the
 * first render never blocks the event loop on a subprocess. The result is
 * cached; bare `#NN` references stay plain text until it settles (see
 * {@link buildLinkifyTarget}).
 */
function resolveIssueRepo(): void {
	const child = spawn("git", ["config", "--get", "remote.origin.url"], {
		stdio: ["ignore", "pipe", "ignore"],
	});
	let stdout = "";
	child.stdout?.setEncoding("utf8");
	child.stdout?.on("data", (chunk: string) => {
		stdout += chunk;
	});
	const settle = (remote: string): void => {
		if (cachedIssueRepo !== undefined) return;
		cachedIssueRepo = parseIssueRepo(remote);
	};
	child.on("error", () => settle(""));
	child.on("close", () => settle(stdout));
	// Bound the subprocess so a hung git cannot keep the app alive.
	const timer = setTimeout(() => child.kill(), ISSUE_REPO_TIMEOUT_MS);
	timer.unref?.();
}

/**
 * Resolve the current repository's origin host + owner/repo path from the cwd's
 * git remote so issue references can be linked to the right forge. The lookup
 * is async (spawn) and cached, so renders never block on subprocess output;
 * before it settles the default forge is returned.
 */
function getIssueRepo(): { origin: string; repoPath: string } {
	if (!issueRepoQueryStarted) {
		issueRepoQueryStarted = true;
		resolveIssueRepo();
	}
	return cachedIssueRepo ?? DEFAULT_ISSUE_REPO;
}

/** True once the async git remote lookup has settled (successfully or not). */
function isIssueRepoResolved(): boolean {
	return cachedIssueRepo !== undefined;
}

/**
 * Patterns for linkifying text tokens: bare URLs (marked already lexes the
 * common ones into link tokens; this is a fallback for URLs it leaves inside
 * text) plus GitHub-style issue references (owner/repo#NN and #NN) which marked
 * does not autolink.
 */
const LINKIFY_PATTERN =
	/https?:\/\/[^\s<>]+|www\.[^\s<>]+|[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+#\d+|#\d+/g;

class StrictStrikethroughTokenizer extends Tokenizer {
	override del(src: string): Tokens.Del | undefined {
		const match = STRICT_STRIKETHROUGH_REGEX.exec(src);
		if (!match) {
			return undefined;
		}

		const text = match[2]!;
		return {
			type: "del",
			raw: match[0],
			text,
			tokens: this.lexer.inlineTokens(text),
		};
	}
}

function trimPartialClosingFences(tokens: readonly Token[]): void {
	const token = tokens[tokens.length - 1];
	if (token?.type === "list") {
		trimPartialClosingFences(token.items[token.items.length - 1]?.tokens ?? []);
		return;
	}
	if (token?.type === "blockquote") {
		trimPartialClosingFences(token.tokens ?? []);
		return;
	}
	if (token?.type !== "code") {
		return;
	}

	// Trim streamed partial closing fences so code blocks do not shrink/flicker
	// when the final fence character arrives. See https://github.com/earendil-works/pi/issues/5825.
	const marker = /^(`{3,}|~{3,})/.exec(token.raw)?.[1];
	const lastLine = token.raw.split("\n").pop();
	if (!marker || !lastLine || lastLine.length >= marker.length || lastLine !== marker[0]?.repeat(lastLine.length)) {
		return;
	}

	token.text = token.text.slice(0, -lastLine.length).replace(/\n$/, "");
}

const markdownParser = new Marked();
markdownParser.setOptions({
	tokenizer: new StrictStrikethroughTokenizer(),
});

/**
 * Default text styling for markdown content.
 * Applied to all text unless overridden by markdown formatting.
 */
export interface DefaultTextStyle {
	/** Foreground color function */
	color?: (text: string) => string;
	/** Background color function */
	bgColor?: (text: string) => string;
	/** Bold text */
	bold?: boolean;
	/** Italic text */
	italic?: boolean;
	/** Strikethrough text */
	strikethrough?: boolean;
	/** Underline text */
	underline?: boolean;
}

/**
 * Theme functions for markdown elements.
 * Each function takes text and returns styled text with ANSI codes.
 */
export interface MarkdownTheme {
	heading: (text: string) => string;
	link: (text: string) => string;
	linkUrl: (text: string) => string;
	code: (text: string) => string;
	codeBlock: (text: string) => string;
	codeBlockBorder: (text: string) => string;
	quote: (text: string) => string;
	quoteBorder: (text: string) => string;
	hr: (text: string) => string;
	listBullet: (text: string) => string;
	bold: (text: string) => string;
	italic: (text: string) => string;
	strikethrough: (text: string) => string;
	underline: (text: string) => string;
	highlightCode?: (code: string, lang?: string) => string[];
	/** Prefix applied to each rendered code block line (default: "  ") */
	codeBlockIndent?: string;
	/** Language-name label rendered above a fenced code block (dim/muted). */
	codeLanguageLabel?: (text: string) => string;
	/** Background applied to blockquote content to render a bordered box. */
	quoteBg?: (text: string) => string;
}

export interface MarkdownOptions {
	/** Preserve source list markers instead of normalizing them. */
	preserveOrderedListMarkers?: boolean;
	/** Preserve source backslash escapes instead of normalizing escaped punctuation. */
	preserveBackslashEscapes?: boolean;
}

interface InlineStyleContext {
	applyText: (text: string) => string;
	stylePrefix: string;
}

export class Markdown implements Component {
	private text: string;
	private paddingX: number; // Left/right padding
	private paddingY: number; // Top/bottom padding
	private defaultTextStyle?: DefaultTextStyle;
	private theme: MarkdownTheme;
	private options: MarkdownOptions;
	private defaultStylePrefix?: string;

	// Cache for rendered output
	private cachedText?: string;
	private cachedWidth?: number;
	private cachedLines?: string[];

	// Incremental (append-only streaming) render state: everything before
	// cachedTailStart in cachedNormalizedText is fully closed block structure,
	// so its rendered lines (cachedPrefixLines) are byte-identical for any
	// suffix extension. Survives setText() but is cleared by invalidate() and
	// rebuilt by the full render path.
	private cachedNormalizedText?: string;
	private cachedTailStart?: number;
	private cachedLastTokenType?: string;
	private cachedPrefixLines?: string[];

	constructor(
		text: string,
		paddingX: number,
		paddingY: number,
		theme: MarkdownTheme,
		defaultTextStyle?: DefaultTextStyle,
		options?: MarkdownOptions,
	) {
		this.text = text;
		this.paddingX = paddingX;
		this.paddingY = paddingY;
		this.theme = theme;
		this.defaultTextStyle = defaultTextStyle;
		this.options = options ? { ...options } : {};
	}

	setText(text: string): void {
		this.text = text;
		// Clear only the render cache. The incremental state is kept: when the
		// new text extends the previously rendered text, render() reuses the
		// fully closed prefix instead of re-rendering the whole document.
		// cachedWidth intentionally survives as "width of the last render",
		// which the incremental fast path needs to validate its prefix lines.
		this.cachedText = undefined;
		this.cachedLines = undefined;
		bumpVersion(this);
	}

	invalidate(): void {
		this.cachedText = undefined;
		this.cachedWidth = undefined;
		this.cachedLines = undefined;
		this.cachedNormalizedText = undefined;
		this.cachedTailStart = undefined;
		this.cachedLastTokenType = undefined;
		this.cachedPrefixLines = undefined;
		bumpVersion(this);
	}

	render(width: number): string[] {
		// Check cache
		if (this.cachedLines && this.cachedText === this.text && this.cachedWidth === width) {
			return this.cachedLines;
		}

		// Calculate available width for content (subtract horizontal padding)
		const contentWidth = Math.max(1, width - this.paddingX * 2);

		// Don't render anything if there's no actual text
		if (!this.text || this.text.trim() === "") {
			const result: string[] = [];
			// Update cache
			this.cachedText = this.text;
			this.cachedWidth = width;
			this.cachedLines = result;
			this.cachedNormalizedText = this.text.replace(/\t/g, "   ");
			this.cachedTailStart = 0;
			this.cachedLastTokenType = undefined;
			this.cachedPrefixLines = [];
			return result;
		}

		// Replace tabs with 3 spaces for consistent rendering
		const normalizedText = this.text.replace(/\t/g, "   ");

		// Streaming fast path: when the new text extends the previously rendered
		// text as a pure suffix, fully closed blocks cannot change, so their
		// rendered lines are reused and only the tail (from the previous last
		// token onward) is re-lexed / re-rendered / re-wrapped. Only valid at
		// the width the prefix lines were built for (cachedWidth survives
		// setText as "width of the last render").
		if (
			this.cachedWidth === width &&
			this.cachedNormalizedText !== undefined &&
			this.cachedPrefixLines !== undefined &&
			this.cachedTailStart !== undefined &&
			this.cachedLastTokenType !== undefined
		) {
			const incremental = this.renderIncrementalTail(normalizedText, width, contentWidth);
			if (incremental !== undefined) {
				return incremental;
			}
		}

		// Parse markdown to HTML-like tokens
		const tokens = markdownParser.lexer(normalizedText);
		trimPartialClosingFences(tokens);

		// Convert tokens to styled terminal output
		const { renderedLines, tailLineStart, lastTokenStart, lastTokenType } = this.renderTokenStream(
			tokens,
			0,
			contentWidth,
		);

		const prefixContentLines = this.wrapAndPadLines(renderedLines.slice(0, tailLineStart), contentWidth, width);
		const tailContentLines = this.wrapAndPadLines(renderedLines.slice(tailLineStart), contentWidth, width);

		const emptyLines = this.buildEmptyLines(width);

		// Combine top padding, content, and bottom padding
		const result = emptyLines.concat(prefixContentLines, tailContentLines, emptyLines);

		// Update cache. The incremental state is only trustworthy when the token
		// stream partitions the normalized text exactly; otherwise the computed
		// boundary could land inside a token and poison the next append-only
		// render, so it is simply not cached.
		let consumed = 0;
		for (const token of tokens) {
			consumed += token.raw.length;
		}
		if (consumed === normalizedText.length || normalizedText.slice(consumed).trim() === "") {
			this.cachedNormalizedText = normalizedText;
			this.cachedTailStart = lastTokenStart;
			this.cachedLastTokenType = lastTokenType;
			this.cachedPrefixLines = prefixContentLines;
		} else {
			this.cachedNormalizedText = undefined;
			this.cachedTailStart = undefined;
			this.cachedLastTokenType = undefined;
			this.cachedPrefixLines = undefined;
		}
		this.cachedText = this.text;
		this.cachedWidth = width;
		this.cachedLines = result;

		return result.length > 0 ? result : [""];
	}

	/**
	 * Render a token stream into raw (unwrapped) lines, recording where the LAST
	 * token's rendered lines begin (tailLineStart), where the last token starts
	 * in the source text (lastTokenStart, offset by textStart), and its type.
	 * The boundary is used by renderIncrementalTail() to reuse everything before
	 * the last token on the next append-only render.
	 */
	private renderTokenStream(
		tokens: readonly Token[],
		textStart: number,
		width: number,
	): {
		renderedLines: string[];
		tailLineStart: number;
		lastTokenStart: number;
		lastTokenType: string | undefined;
	} {
		const renderedLines: string[] = [];
		let offset = textStart;
		let tailLineStart = 0;
		let lastTokenStart = textStart;
		let lastTokenType: string | undefined;
		for (let i = 0; i < tokens.length; i++) {
			const token = tokens[i]!;
			const isLast = i === tokens.length - 1;
			lastTokenStart = offset;
			lastTokenType = token.type;
			offset += token.raw.length;
			const nextToken = tokens[i + 1];
			const tokenLines = this.renderToken(token, width, nextToken?.type);
			if (isLast) {
				tailLineStart = renderedLines.length;
			}
			for (const tokenLine of tokenLines) {
				renderedLines.push(tokenLine);
			}
		}
		return { renderedLines, tailLineStart, lastTokenStart, lastTokenType };
	}

	/**
	 * Streaming fast path: when the newly set text extends the previously
	 * rendered text, re-lex / re-render / re-wrap only the tail starting at the
	 * previous last token, and splice it onto the cached prefix lines. Returns
	 * undefined so the caller falls back to the full render when the text is not
	 * a pure append or the tail re-lex fails validation.
	 */
	private renderIncrementalTail(normalizedText: string, width: number, contentWidth: number): string[] | undefined {
		const cachedNormalized = this.cachedNormalizedText;
		if (
			cachedNormalized === undefined ||
			this.cachedPrefixLines === undefined ||
			this.cachedLastTokenType === undefined ||
			this.cachedTailStart === undefined ||
			this.cachedTailStart > cachedNormalized.length ||
			!normalizedText.startsWith(cachedNormalized)
		) {
			return undefined;
		}

		const tailText = normalizedText.slice(this.cachedTailStart);
		if (tailText.length === 0) {
			return undefined;
		}

		// Lexing starts at a block boundary (the previous last token), so the
		// first tail token must be the same type as the previous last token. If
		// the appended text restructured it (e.g. a paragraph growing into a
		// setext heading), the prefix spacing could change — fall back to full.
		const tailTokens = markdownParser.lexer(tailText);
		if (tailTokens.length === 0 || tailTokens[0]!.type !== this.cachedLastTokenType) {
			return undefined;
		}

		// Verify the re-lexed tokens partition the tail exactly; an unconsumed
		// non-whitespace remainder means the cached boundary was not a real
		// token boundary, and reusing the prefix would corrupt the output.
		let consumed = 0;
		for (const token of tailTokens) {
			consumed += token.raw.length;
		}
		if (consumed !== tailText.length && tailText.slice(consumed).trim() !== "") {
			return undefined;
		}

		trimPartialClosingFences(tailTokens);

		const { renderedLines, tailLineStart, lastTokenStart, lastTokenType } = this.renderTokenStream(
			tailTokens,
			this.cachedTailStart,
			contentWidth,
		);

		const prefixContentLines = this.cachedPrefixLines;
		const tailContentLines = this.wrapAndPadLines(renderedLines, contentWidth, width);
		const emptyLines = this.buildEmptyLines(width);

		// Combine top padding, cached prefix, new tail, bottom padding
		const result = emptyLines.concat(prefixContentLines, tailContentLines, emptyLines);

		// Update cache: the prefix grows by every new tail token except the last.
		this.cachedText = this.text;
		this.cachedWidth = width;
		this.cachedLines = result;
		this.cachedNormalizedText = normalizedText;
		this.cachedTailStart = lastTokenStart;
		this.cachedLastTokenType = lastTokenType;
		this.cachedPrefixLines = prefixContentLines.concat(
			this.wrapAndPadLines(renderedLines.slice(0, tailLineStart), contentWidth, width),
		);

		return result.length > 0 ? result : [""];
	}

	/**
	 * Wrap raw rendered lines to the content width, then add margins and
	 * background (or right-pad to the full width). Deterministic per line,
	 * which is what makes the incremental prefix reuse byte-identical.
	 */
	private wrapAndPadLines(renderedLines: string[], contentWidth: number, width: number): string[] {
		// Wrap lines (NO padding, NO background yet)
		const wrappedLines: string[] = [];
		for (const line of renderedLines) {
			if (isImageLine(line)) {
				wrappedLines.push(line);
			} else {
				for (const wrappedLine of wrapTextWithAnsi(line, contentWidth)) {
					wrappedLines.push(wrappedLine);
				}
			}
		}

		// Add margins and background to each wrapped line
		const leftMargin = " ".repeat(this.paddingX);
		const rightMargin = " ".repeat(this.paddingX);
		const bgFn = this.defaultTextStyle?.bgColor;
		const contentLines: string[] = [];

		for (const line of wrappedLines) {
			if (isImageLine(line)) {
				contentLines.push(line);
				continue;
			}

			const lineWithMargins = leftMargin + line + rightMargin;

			if (bgFn) {
				contentLines.push(applyBackgroundToLine(lineWithMargins, width, bgFn));
			} else {
				// No background - just pad to width
				const visibleLen = visibleWidth(lineWithMargins);
				const paddingNeeded = Math.max(0, width - visibleLen);
				contentLines.push(lineWithMargins + " ".repeat(paddingNeeded));
			}
		}

		return contentLines;
	}

	/** Top/bottom padding (empty lines) for the given width. */
	private buildEmptyLines(width: number): string[] {
		const bgFn = this.defaultTextStyle?.bgColor;
		const emptyLine = " ".repeat(Math.max(0, width));
		const emptyLines: string[] = [];
		for (let i = 0; i < this.paddingY; i++) {
			const line = bgFn ? applyBackgroundToLine(emptyLine, width, bgFn) : emptyLine;
			emptyLines.push(line);
		}
		return emptyLines;
	}

	/**
	 * Apply default text style to a string.
	 * This is the base styling applied to all text content.
	 * NOTE: Background color is NOT applied here - it's applied at the padding stage
	 * to ensure it extends to the full line width.
	 */
	private applyDefaultStyle(text: string): string {
		if (!this.defaultTextStyle) {
			return text;
		}

		let styled = text;

		// Apply foreground color (NOT background - that's applied at padding stage)
		if (this.defaultTextStyle.color) {
			styled = this.defaultTextStyle.color(styled);
		}

		// Apply text decorations using this.theme
		if (this.defaultTextStyle.bold) {
			styled = this.theme.bold(styled);
		}
		if (this.defaultTextStyle.italic) {
			styled = this.theme.italic(styled);
		}
		if (this.defaultTextStyle.strikethrough) {
			styled = this.theme.strikethrough(styled);
		}
		if (this.defaultTextStyle.underline) {
			styled = this.theme.underline(styled);
		}

		return styled;
	}

	private getDefaultStylePrefix(): string {
		if (!this.defaultTextStyle) {
			return "";
		}

		if (this.defaultStylePrefix !== undefined) {
			return this.defaultStylePrefix;
		}

		const sentinel = "\u0000";
		let styled = sentinel;

		if (this.defaultTextStyle.color) {
			styled = this.defaultTextStyle.color(styled);
		}

		if (this.defaultTextStyle.bold) {
			styled = this.theme.bold(styled);
		}
		if (this.defaultTextStyle.italic) {
			styled = this.theme.italic(styled);
		}
		if (this.defaultTextStyle.strikethrough) {
			styled = this.theme.strikethrough(styled);
		}
		if (this.defaultTextStyle.underline) {
			styled = this.theme.underline(styled);
		}

		const sentinelIndex = styled.indexOf(sentinel);
		this.defaultStylePrefix = sentinelIndex >= 0 ? styled.slice(0, sentinelIndex) : "";
		return this.defaultStylePrefix;
	}

	private getStylePrefix(styleFn: (text: string) => string): string {
		const sentinel = "\u0000";
		const styled = styleFn(sentinel);
		const sentinelIndex = styled.indexOf(sentinel);
		return sentinelIndex >= 0 ? styled.slice(0, sentinelIndex) : "";
	}

	private getDefaultInlineStyleContext(): InlineStyleContext {
		return {
			applyText: (text: string) => this.applyDefaultStyle(text),
			stylePrefix: this.getDefaultStylePrefix(),
		};
	}

	private renderToken(
		token: Token,
		width: number,
		nextTokenType?: string,
		styleContext?: InlineStyleContext,
	): string[] {
		const lines: string[] = [];

		switch (token.type) {
			case "heading": {
				const headingLevel = token.depth;
				const headingPrefix = `${"#".repeat(headingLevel)} `;

				// Build a heading-specific style context so inline tokens (codespan, bold, etc.)
				// restore heading styling after their own ANSI resets instead of falling back to
				// the default text style.
				let headingStyleFn: (text: string) => string;
				if (headingLevel === 1) {
					headingStyleFn = (text: string) => this.theme.heading(this.theme.bold(this.theme.underline(text)));
				} else {
					headingStyleFn = (text: string) => this.theme.heading(this.theme.bold(text));
				}

				const headingStyleContext: InlineStyleContext = {
					applyText: headingStyleFn,
					stylePrefix: this.getStylePrefix(headingStyleFn),
				};

				const headingText = this.renderInlineTokens(token.tokens || [], headingStyleContext);
				const styledHeading = headingLevel >= 3 ? headingStyleFn(headingPrefix) + headingText : headingText;
				lines.push(styledHeading);
				if (nextTokenType && nextTokenType !== "space") {
					lines.push(""); // Add spacing after headings (unless space token follows)
				}
				break;
			}

			case "paragraph": {
				const paragraphText = this.renderInlineTokens(token.tokens || [], styleContext);
				lines.push(paragraphText);
				// Don't add spacing if next token is space or list
				if (nextTokenType && nextTokenType !== "list" && nextTokenType !== "space") {
					lines.push("");
				}
				break;
			}

			case "text":
				lines.push(this.renderInlineTokens([token], styleContext));
				break;

			case "code": {
				const indent = this.theme.codeBlockIndent ?? "  ";
				if (token.lang && this.theme.codeLanguageLabel) {
					lines.push(this.theme.codeLanguageLabel(baseLanguageLabel(token.lang)));
				}
				lines.push(this.theme.codeBlockBorder(`\`\`\`${token.lang || ""}`));
				if (this.theme.highlightCode) {
					const highlightedLines = this.theme.highlightCode(token.text, token.lang);
					for (const hlLine of highlightedLines) {
						lines.push(`${indent}${hlLine}`);
					}
				} else {
					// Split code by newlines and style each line
					const codeLines = token.text.split("\n");
					for (const codeLine of codeLines) {
						lines.push(`${indent}${this.theme.codeBlock(codeLine)}`);
					}
				}
				lines.push(this.theme.codeBlockBorder("```"));
				if (nextTokenType && nextTokenType !== "space") {
					lines.push(""); // Add spacing after code blocks (unless space token follows)
				}
				break;
			}

			case "list": {
				const listLines = this.renderList(token as Tokens.List, 0, width, styleContext);
				lines.push(...listLines);
				// Don't add spacing after lists if a space token follows
				// (the space token will handle it)
				break;
			}

			case "table": {
				const tableLines = this.renderTable(token as Tokens.Table, width, nextTokenType, styleContext);
				lines.push(...tableLines);
				break;
			}

			case "blockquote": {
				const quoteStyle = (text: string) => this.theme.quote(this.theme.italic(text));
				const quoteStylePrefix = this.getStylePrefix(quoteStyle);
				const applyQuoteStyle = (line: string): string => {
					if (!quoteStylePrefix) {
						return quoteStyle(line);
					}
					const lineWithReappliedStyle = line.replace(/\x1b\[0m/g, `\x1b[0m${quoteStylePrefix}`);
					return quoteStyle(lineWithReappliedStyle);
				};

				// Calculate available width for quote content (subtract border "│ " = 2 chars)
				const quoteContentWidth = Math.max(1, width - 2);

				// Blockquotes contain block-level tokens (paragraph, list, code, etc.), so render
				// children with renderToken() instead of renderInlineTokens().
				// Default message style should not apply inside blockquotes.
				const quoteInlineStyleContext: InlineStyleContext = {
					applyText: (text: string) => text,
					stylePrefix: quoteStylePrefix,
				};
				const quoteTokens = token.tokens || [];
				const renderedQuoteLines: string[] = [];
				for (let i = 0; i < quoteTokens.length; i++) {
					const quoteToken = quoteTokens[i]!;
					const nextQuoteToken = quoteTokens[i + 1];
					renderedQuoteLines.push(
						...this.renderToken(quoteToken, quoteContentWidth, nextQuoteToken?.type, quoteInlineStyleContext),
					);
				}

				// Avoid rendering an extra empty quote line before the outer blockquote spacing.
				while (renderedQuoteLines.length > 0 && renderedQuoteLines[renderedQuoteLines.length - 1] === "") {
					renderedQuoteLines.pop();
				}

				for (const quoteLine of renderedQuoteLines) {
					const styledLine = applyQuoteStyle(quoteLine);
					const wrappedLines = wrapTextWithAnsi(styledLine, quoteContentWidth);
					for (const wrappedLine of wrappedLines) {
						lines.push(this.theme.quoteBorder("│ ") + this.applyQuoteBackground(wrappedLine, quoteContentWidth));
					}
				}
				if (nextTokenType && nextTokenType !== "space") {
					lines.push(""); // Add spacing after blockquotes (unless space token follows)
				}
				break;
			}

			case "hr":
				lines.push(this.theme.hr("─".repeat(Math.max(0, Math.min(width, 80)))));
				if (nextTokenType && nextTokenType !== "space") {
					lines.push(""); // Add spacing after horizontal rules (unless space token follows)
				}
				break;

			case "html":
				// Render HTML as literal text (escaped for the terminal) so tags are
				// visible instead of being dropped.
				if ("raw" in token && typeof token.raw === "string") {
					lines.push(this.applyDefaultStyle(token.raw.trim()));
				} else if ("text" in token && typeof token.text === "string") {
					lines.push(this.applyDefaultStyle(token.text.trim()));
				}
				break;

			case "space":
				// Space tokens represent blank lines in markdown
				lines.push("");
				break;

			default:
				// Handle any other token types as plain text
				if ("text" in token && typeof token.text === "string") {
					lines.push(token.text);
				}
		}

		return lines;
	}

	private renderInlineTokens(tokens: Token[], styleContext?: InlineStyleContext, skipLinkify = false): string {
		let result = "";
		const resolvedStyleContext = styleContext ?? this.getDefaultInlineStyleContext();
		const { applyText, stylePrefix } = resolvedStyleContext;
		const applyTextWithNewlines = (text: string): string => {
			const segments: string[] = text.split("\n");
			return segments.map((segment: string) => applyText(segment)).join("\n");
		};

		for (const token of tokens) {
			switch (token.type) {
				case "escape":
					result += applyTextWithNewlines(this.options.preserveBackslashEscapes ? token.raw : token.text);
					break;

				case "text":
					// Text tokens in list items can have nested tokens for inline formatting
					if (token.tokens && token.tokens.length > 0) {
						result += this.renderInlineTokens(token.tokens, resolvedStyleContext, skipLinkify);
					} else if (skipLinkify) {
						result += applyTextWithNewlines(token.text);
					} else {
						result += this.linkifyAndStyleText(token.text, resolvedStyleContext);
					}
					break;

				case "paragraph":
					// Paragraph tokens contain nested inline tokens
					result += this.renderInlineTokens(token.tokens || [], resolvedStyleContext, skipLinkify);
					break;

				case "strong": {
					const boldContent = this.renderInlineTokens(token.tokens || [], resolvedStyleContext, skipLinkify);
					result += this.theme.bold(boldContent) + stylePrefix;
					break;
				}

				case "em": {
					const italicContent = this.renderInlineTokens(token.tokens || [], resolvedStyleContext, skipLinkify);
					result += this.theme.italic(italicContent) + stylePrefix;
					break;
				}

				case "codespan":
					result += this.theme.code(token.text) + stylePrefix;
					break;

				case "link": {
					// Do not linkify the inner text: it is already a link, so any bare
					// URL inside must not get a second OSC 8 wrapper.
					const linkText = this.renderInlineTokens(token.tokens || [], resolvedStyleContext, true);
					const styledLink = this.theme.link(this.theme.underline(linkText));
					if (getCapabilities().hyperlinks) {
						// OSC 8: render as a clickable hyperlink. The URL is not printed inline,
						// so we always show only the link text regardless of whether it matches href.
						result += hyperlink(styledLink, token.href) + stylePrefix;
					} else {
						// Fallback: print URL in parentheses when text differs from href.
						// Compare raw token.text (not styled) against href for the equality check.
						// For mailto: links strip the prefix (autolinked emails use text="foo@bar.com"
						// but href="mailto:foo@bar.com").
						const hrefForComparison = token.href.startsWith("mailto:") ? token.href.slice(7) : token.href;
						if (token.text === token.href || token.text === hrefForComparison) {
							result += styledLink + stylePrefix;
						} else {
							result += styledLink + this.theme.linkUrl(` (${token.href})`) + stylePrefix;
						}
					}
					break;
				}

				case "br":
					result += "\n";
					break;

				case "del": {
					const delContent = this.renderInlineTokens(token.tokens || [], resolvedStyleContext, skipLinkify);
					result += this.theme.strikethrough(delContent) + stylePrefix;
					break;
				}

				case "html":
					// Render inline HTML as literal text (escaped for the terminal)
					if ("raw" in token && typeof token.raw === "string") {
						result += applyTextWithNewlines(token.raw);
					} else if ("text" in token && typeof token.text === "string") {
						result += applyTextWithNewlines(token.text);
					}
					break;

				case "image": {
					// Markdown images cannot be shown inline here, so render the alt
					// text when present, otherwise fall back to "(href title)".
					const imageToken = token as Tokens.Image;
					const href = imageToken.href ?? "";
					const alt = imageToken.text ?? "";
					const hasAlt = alt.length > 0;
					const title = imageToken.title ?? "";
					const label = hasAlt ? alt : `(${[href, title].filter(Boolean).join(" ")})`;
					const styled = hasAlt ? applyTextWithNewlines(alt) : this.theme.linkUrl(label);
					if (getCapabilities().hyperlinks && href) {
						result += hyperlink(styled, href) + stylePrefix;
					} else {
						result += styled + stylePrefix;
					}
					break;
				}

				default:
					// Handle any other inline token types as plain text
					if ("text" in token && typeof token.text === "string") {
						result += applyTextWithNewlines(token.text);
					}
			}
		}

		while (stylePrefix && result.endsWith(stylePrefix)) {
			result = result.slice(0, -stylePrefix.length);
		}

		return result;
	}

	/**
	 * Apply a dim background behind blockquote content so it renders as a
	 * bordered box (left border + background). Falls back to plain text when the
	 * theme does not provide a quote background.
	 */
	private applyQuoteBackground(line: string, width: number): string {
		const bgFn = this.theme.quoteBg;
		if (!bgFn) {
			return line;
		}
		const visibleLen = visibleWidth(line);
		const paddingNeeded = Math.max(0, width - visibleLen);
		const padded = line + " ".repeat(paddingNeeded);

		// Sample the theme's background codes so full SGR resets inside styled
		// content (bold/code/links) re-apply the background instead of leaving a
		// gap. Chalk normally closes attributes with targeted resets, but the
		// quote renderer already anticipates \x1b[0m, so match that robustness.
		const sample = bgFn("x");
		const markerIndex = sample.indexOf("x");
		const bgPrefix = markerIndex > 0 ? sample.slice(0, markerIndex) : "";
		const bgSuffix = markerIndex >= 0 ? sample.slice(markerIndex + 1) : "";
		if (!bgPrefix) {
			return padded;
		}
		return `${bgPrefix}${padded.replace(/\x1b\[0m/g, `\x1b[0m${bgPrefix}`)}${bgSuffix}`;
	}

	/**
	 * Style a plain inline text token, linkifying bare URLs and GitHub issue
	 * references while binding trailing "N." / "N)" to the preceding word so the
	 * wrap cannot split the number onto its own line.
	 */
	private linkifyAndStyleText(text: string, styleContext: InlineStyleContext): string {
		const { applyText, stylePrefix } = styleContext;
		return text
			.split("\n")
			.map((segment) => this.linkifySegment(bindTrailingNumber(segment), applyText, stylePrefix))
			.join("\n");
	}

	/**
	 * Scan a single text line for bare URLs and issue references, rendering each
	 * match as a styled OSC 8 hyperlink when the terminal supports it.
	 */
	private linkifySegment(segment: string, applyText: (text: string) => string, stylePrefix: string): string {
		if (!segment.includes("#") && !/https?:\/\/|www\./.test(segment)) {
			return applyText(segment);
		}

		LINKIFY_PATTERN.lastIndex = 0;
		let result = "";
		let lastIndex = 0;
		let match: RegExpExecArray | null;
		while ((match = LINKIFY_PATTERN.exec(segment)) !== null) {
			const raw = match[0]!;
			const target = this.buildLinkifyTarget(raw, match.index > 0 ? segment[match.index - 1]! : "");
			if (target === undefined) {
				// False positive (e.g. "x#12" or a fragment of a longer path) - keep as text.
				result += applyText(segment.slice(lastIndex, LINKIFY_PATTERN.lastIndex));
				lastIndex = LINKIFY_PATTERN.lastIndex;
				continue;
			}
			if (match.index > lastIndex) {
				result += applyText(segment.slice(lastIndex, match.index));
			}
			const styled = this.theme.link(this.theme.underline(target.text));
			if (getCapabilities().hyperlinks) {
				result += hyperlink(styled, target.href) + stylePrefix;
			} else {
				result += styled + stylePrefix;
			}
			lastIndex = LINKIFY_PATTERN.lastIndex;
		}
		if (lastIndex < segment.length) {
			result += applyText(segment.slice(lastIndex));
		}
		return result;
	}

	/**
	 * Turn a bare-URL / issue-reference match into a styled text + link href
	 * pair, or return undefined for false positives that should stay plain text.
	 */
	private buildLinkifyTarget(raw: string, prevChar: string): { text: string; href: string } | undefined {
		if (raw.startsWith("http://") || raw.startsWith("https://") || raw.startsWith("www.")) {
			const text = raw.replace(/[.,;:!?)]+$/, "");
			const href = text.startsWith("www.") ? `http://${text}` : text;
			return { text, href };
		}

		const hashIndex = raw.indexOf("#");
		if (hashIndex < 0) {
			return undefined;
		}
		const repoPart = raw.slice(0, hashIndex);
		const number = raw.slice(hashIndex + 1);
		const { origin, repoPath } = getIssueRepo();
		if (repoPart.includes("/")) {
			// owner/repo#NN - must not sit inside a longer path (prevChar "/" or alnum).
			if (prevChar !== "" && /[A-Za-z0-9_.\-/]/.test(prevChar)) {
				return undefined;
			}
			return { text: raw, href: `${origin}/${repoPart}/issues/${number}` };
		}
		// Bare #NN - must not follow an identifier character (avoid "x#12", "C#12").
		if (prevChar !== "" && /[A-Za-z0-9_.-]/.test(prevChar)) {
			return undefined;
		}
		// Bare #NN depends on the resolved repo path; render as plain text until
		// the async git lookup settles so the first render never blocks on git.
		if (!isIssueRepoResolved()) {
			return undefined;
		}
		const base = repoPath ? `${origin}/${repoPath}/issues/${number}` : `${origin}/issues/${number}`;
		return { text: raw, href: base };
	}

	private getOrderedListMarker(item: Tokens.ListItem): string | undefined {
		const match = /^(?: {0,3})(\d{1,9}[.)])[ \t]+/.exec(item.raw);
		return match ? `${match[1]} ` : undefined;
	}

	private getUnorderedListMarker(item: Tokens.ListItem): string | undefined {
		const match = /^(?: {0,3})([-+*])(?:[ \t]+|(?=\r?\n|$))/.exec(item.raw);
		return match ? `${match[1]} ` : undefined;
	}

	/**
	 * Render a list with proper nesting support
	 */
	private renderList(token: Tokens.List, depth: number, width: number, styleContext?: InlineStyleContext): string[] {
		const lines: string[] = [];
		const indent = "    ".repeat(depth);
		// Use the list's start property (defaults to 1 for ordered lists)
		const startNumber = typeof token.start === "number" ? token.start : 1;

		for (let i = 0; i < token.items.length; i++) {
			const item = token.items[i]!;
			const isLastItem = i === token.items.length - 1;
			const bullet = token.ordered
				? this.options.preserveOrderedListMarkers
					? (this.getOrderedListMarker(item) ?? `${startNumber + i}. `)
					: `${startNumber + i}. `
				: this.options.preserveOrderedListMarkers
					? (this.getUnorderedListMarker(item) ?? "- ")
					: "- ";
			const taskMarker = item.task ? `${item.checked ? "☑" : "☐"} ` : "";
			const marker = bullet + taskMarker;
			const firstPrefix = indent + this.theme.listBullet(marker);
			const continuationPrefix = indent + " ".repeat(visibleWidth(marker));
			const itemWidth = Math.max(1, width - visibleWidth(firstPrefix));
			let renderedAnyLine = false;

			for (const itemToken of item.tokens) {
				if (itemToken.type === "list") {
					lines.push(...this.renderList(itemToken as Tokens.List, depth + 1, width, styleContext));
					renderedAnyLine = true;
					continue;
				}

				// Block-level children (code/blockquote/hr/table) are not indented -
				// they span the full content width like top-level blocks.
				if (UNINDENTED_LIST_CHILD_TYPES.has(itemToken.type)) {
					const itemLines = this.renderToken(itemToken, width, undefined, styleContext);
					for (const line of itemLines) {
						for (const wrappedLine of wrapTextWithAnsi(line, width)) {
							lines.push(wrappedLine);
							renderedAnyLine = true;
						}
					}
					continue;
				}

				const itemLines = this.renderToken(itemToken, itemWidth, undefined, styleContext);
				for (const line of itemLines) {
					for (const wrappedLine of wrapTextWithAnsi(line, itemWidth)) {
						const linePrefix = renderedAnyLine ? continuationPrefix : firstPrefix;
						lines.push(linePrefix + wrappedLine);
						renderedAnyLine = true;
					}
				}
			}

			if (!renderedAnyLine) {
				lines.push(firstPrefix);
			}

			if (token.loose && !isLastItem) {
				lines.push("");
			}
		}

		return lines;
	}

	/**
	 * Get the visible width of the longest word in a string.
	 */
	private getLongestWordWidth(text: string, maxWidth?: number): number {
		const words = text.split(/\s+/).filter((word) => word.length > 0);
		let longest = 0;
		for (const word of words) {
			longest = Math.max(longest, visibleWidth(word));
		}
		if (maxWidth === undefined) {
			return longest;
		}
		return Math.min(longest, maxWidth);
	}

	/**
	 * Wrap a table cell to fit into a column.
	 *
	 * Delegates to wrapTextWithAnsi() so ANSI codes + long tokens are handled
	 * consistently with the rest of the renderer.
	 */
	private wrapCellText(text: string, maxWidth: number): string[] {
		return wrapTextWithAnsi(text, Math.max(1, maxWidth));
	}

	/**
	 * Render a table with width-aware cell wrapping.
	 * Cells that don't fit are wrapped to multiple lines.
	 */
	private renderTable(
		token: Tokens.Table,
		availableWidth: number,
		nextTokenType?: string,
		styleContext?: InlineStyleContext,
	): string[] {
		const lines: string[] = [];
		const numCols = token.header.length;

		if (numCols === 0) {
			return lines;
		}

		// Calculate border overhead: "│ " + (n-1) * " │ " + " │"
		// = 2 + (n-1) * 3 + 2 = 3n + 1
		const borderOverhead = 3 * numCols + 1;
		const availableForCells = availableWidth - borderOverhead;
		if (availableForCells < numCols) {
			// Too narrow to render a stable table. Fall back to raw markdown.
			const fallbackLines = token.raw ? wrapTextWithAnsi(token.raw, availableWidth) : [];
			if (nextTokenType && nextTokenType !== "space") {
				fallbackLines.push("");
			}
			return fallbackLines;
		}

		const maxUnbrokenWordWidth = 30;

		// Calculate natural column widths (what each column needs without constraints)
		const naturalWidths: number[] = [];
		const minWordWidths: number[] = [];
		for (let i = 0; i < numCols; i++) {
			const headerText = this.renderInlineTokens(token.header[i]!.tokens || [], styleContext);
			naturalWidths[i] = visibleWidth(headerText);
			minWordWidths[i] = Math.max(1, this.getLongestWordWidth(headerText, maxUnbrokenWordWidth));
		}
		for (const row of token.rows) {
			for (let i = 0; i < row.length; i++) {
				const cellText = this.renderInlineTokens(row[i]!.tokens || [], styleContext);
				naturalWidths[i] = Math.max(naturalWidths[i] || 0, visibleWidth(cellText));
				minWordWidths[i] = Math.max(
					minWordWidths[i] || 1,
					this.getLongestWordWidth(cellText, maxUnbrokenWordWidth),
				);
			}
		}

		let minColumnWidths = minWordWidths;
		let minCellsWidth = minColumnWidths.reduce((a, b) => a + b, 0);

		if (minCellsWidth > availableForCells) {
			minColumnWidths = new Array(numCols).fill(1);
			const remaining = availableForCells - numCols;

			if (remaining > 0) {
				const totalWeight = minWordWidths.reduce((total, width) => total + Math.max(0, width - 1), 0);
				const growth = minWordWidths.map((width) => {
					const weight = Math.max(0, width - 1);
					return totalWeight > 0 ? Math.floor((weight / totalWeight) * remaining) : 0;
				});

				for (let i = 0; i < numCols; i++) {
					minColumnWidths[i]! += growth[i] ?? 0;
				}

				const allocated = growth.reduce((total, width) => total + width, 0);
				let leftover = remaining - allocated;
				for (let i = 0; leftover > 0 && i < numCols; i++) {
					minColumnWidths[i]!++;
					leftover--;
				}
			}

			minCellsWidth = minColumnWidths.reduce((a, b) => a + b, 0);
		}

		// Calculate column widths that fit within available width
		const totalNaturalWidth = naturalWidths.reduce((a, b) => a + b, 0) + borderOverhead;
		let columnWidths: number[];

		if (totalNaturalWidth <= availableWidth) {
			// Everything fits naturally
			columnWidths = naturalWidths.map((width, index) => Math.max(width, minColumnWidths[index]!));
		} else {
			// Need to shrink columns to fit
			const totalGrowPotential = naturalWidths.reduce((total, width, index) => {
				return total + Math.max(0, width - minColumnWidths[index]!);
			}, 0);
			const extraWidth = Math.max(0, availableForCells - minCellsWidth);
			columnWidths = minColumnWidths.map((minWidth, index) => {
				const naturalWidth = naturalWidths[index]!;
				const minWidthDelta = Math.max(0, naturalWidth - minWidth);
				let grow = 0;
				if (totalGrowPotential > 0) {
					grow = Math.floor((minWidthDelta / totalGrowPotential) * extraWidth);
				}
				return minWidth + grow;
			});

			// Adjust for rounding errors - distribute remaining space
			const allocated = columnWidths.reduce((a, b) => a + b, 0);
			let remaining = availableForCells - allocated;
			while (remaining > 0) {
				let grew = false;
				for (let i = 0; i < numCols && remaining > 0; i++) {
					if (columnWidths[i]! < naturalWidths[i]!) {
						columnWidths[i]!++;
						remaining--;
						grew = true;
					}
				}
				if (!grew) {
					break;
				}
			}
		}

		// Render top border
		const topBorderCells = columnWidths.map((w) => "─".repeat(w));
		lines.push(`┌─${topBorderCells.join("─┬─")}─┐`);

		// Render header with wrapping
		const headerCellLines: string[][] = token.header.map((cell, i) => {
			const text = this.renderInlineTokens(cell.tokens || [], styleContext);
			return this.wrapCellText(text, columnWidths[i]!);
		});
		const headerLineCount = Math.max(...headerCellLines.map((c) => c.length));

		for (let lineIdx = 0; lineIdx < headerLineCount; lineIdx++) {
			const rowParts = headerCellLines.map((cellLines, colIdx) => {
				const text = cellLines[lineIdx] || "";
				const padded = text + " ".repeat(Math.max(0, columnWidths[colIdx]! - visibleWidth(text)));
				return this.theme.bold(padded);
			});
			lines.push(`│ ${rowParts.join(" │ ")} │`);
		}

		// Render separator
		const separatorCells = columnWidths.map((w) => "─".repeat(w));
		const separatorLine = `├─${separatorCells.join("─┼─")}─┤`;
		lines.push(separatorLine);

		// Render rows with wrapping
		for (let rowIndex = 0; rowIndex < token.rows.length; rowIndex++) {
			const row = token.rows[rowIndex]!;
			const rowCellLines: string[][] = row.map((cell, i) => {
				const text = this.renderInlineTokens(cell.tokens || [], styleContext);
				return this.wrapCellText(text, columnWidths[i]!);
			});
			const rowLineCount = Math.max(...rowCellLines.map((c) => c.length));

			for (let lineIdx = 0; lineIdx < rowLineCount; lineIdx++) {
				const rowParts = rowCellLines.map((cellLines, colIdx) => {
					const text = cellLines[lineIdx] || "";
					return text + " ".repeat(Math.max(0, columnWidths[colIdx]! - visibleWidth(text)));
				});
				lines.push(`│ ${rowParts.join(" │ ")} │`);
			}

			if (rowIndex < token.rows.length - 1) {
				lines.push(separatorLine);
			}
		}

		// Render bottom border
		const bottomBorderCells = columnWidths.map((w) => "─".repeat(w));
		lines.push(`└─${bottomBorderCells.join("─┴─")}─┘`);

		if (nextTokenType && nextTokenType !== "space") {
			lines.push(""); // Add spacing after table
		}
		return lines;
	}
}
