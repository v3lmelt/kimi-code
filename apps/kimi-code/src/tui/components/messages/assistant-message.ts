/**
 * Renders an assistant message using pi-tui Markdown.
 *
 * Displays a white bullet prefix with markdown content indented
 * to align after the bullet.
 */

import { bumpVersion, Container, Markdown, truncateToWidth, visibleWidth, type Component } from '@moonshot-ai/pi-tui';
import type { HostedSearchCitation, HostedSearchSource } from '@moonshot-ai/kimi-code-sdk';

import { MESSAGE_INDENT } from '#/tui/constant/rendering';
import { STATUS_BULLET } from '#/tui/constant/symbols';
import { currentTheme } from '#/tui/theme';
import { createMarkdownTheme } from '#/tui/theme/pi-tui-theme';
import { isRenderCacheEnabled } from '#/tui/utils/render-cache';
import {
  decorateAssistantTextWithCitations,
  hostedSearchCitationSignature,
} from '#/tui/utils/hosted-search';

type AssistantMarkdownOptions = {
  transient?: boolean;
  citations?: readonly HostedSearchCitation[];
  sources?: readonly HostedSearchSource[];
};

export class AssistantMessageComponent implements Component {
  // Versioned from construction (see UserMessageComponent). All mutations
  // (updateContent / setShowBullet / theme invalidate) go through
  // markRenderDirty() -> bumpVersion().
  version = 0;
  private contentContainer: Container;
  private markdown: Markdown | undefined;
  private markdownTransient = false;
  private lastText = '';
  private lastTransient = false;
  private citationSource: readonly HostedSearchCitation[] = [];
  private citationSources: readonly HostedSearchSource[] = [];
  private citationOffset = 0;
  private renderedCitationSignature = '';
  private showBullet: boolean;

  private renderCache: { width: number; lines: string[] } | undefined;

  constructor(showBullet: boolean = true) {
    this.showBullet = showBullet;
    this.contentContainer = new Container();
  }

  private markRenderDirty(): void {
    this.renderCache = undefined;
    bumpVersion(this);
  }

  setShowBullet(show: boolean): void {
    if (this.showBullet === show) return;
    this.showBullet = show;
    this.markRenderDirty();
  }

  private rebuildMarkdown(): void {
    this.contentContainer.clear();
    this.markdown = undefined;
    const displayText = decorateAssistantTextWithCitations(
      this.lastText,
      this.citationSource,
      this.citationSources,
      this.citationOffset,
    );
    this.renderedCitationSignature = hostedSearchCitationSignature(
      this.citationSource,
      this.citationSources,
    );
    if (displayText.length === 0) {
      this.markdownTransient = false;
      return;
    }
    this.markdown = new Markdown(
      displayText,
      0,
      0,
      createMarkdownTheme({ transient: this.lastTransient }),
    );
    this.markdownTransient = this.lastTransient;
    this.contentContainer.addChild(this.markdown);
  }

  updateContent(text: string, opts?: AssistantMarkdownOptions): void {
    const displayText = text.trim();
    const transient = opts?.transient === true;
    const citations = opts?.citations ?? [];
    const sources = opts?.sources ?? [];
    const citationSignature = hostedSearchCitationSignature(citations, sources);

    if (
      displayText === this.lastText &&
      transient === this.lastTransient &&
      citationSignature === this.renderedCitationSignature
    ) {
      return;
    }

    this.lastText = displayText;
    this.lastTransient = transient;
    this.citationSource = citations;
    this.citationSources = sources;
    this.citationOffset = text.length - text.trimStart().length;
    this.markRenderDirty();

    if (displayText.length === 0) {
      this.contentContainer.clear();
      this.markdown = undefined;
      this.markdownTransient = false;
      this.renderedCitationSignature = citationSignature;
      return;
    }

    const decoratedText = decorateAssistantTextWithCitations(
      displayText,
      citations,
      sources,
      this.citationOffset,
    );
    this.renderedCitationSignature = citationSignature;
    if (this.markdown === undefined || this.markdownTransient !== transient) {
      this.rebuildMarkdown();
      return;
    }
    this.markdown.setText(decoratedText);
  }

  invalidate(): void {
    // Markdown caches ANSI colour codes keyed on (text, width).  When the
    // theme changes the cached strings contain stale colours, so we rebuild
    // the Markdown child with the new theme while preserving transient mode.
    this.markRenderDirty();
    this.rebuildMarkdown();
  }

  render(width: number): string[] {
    if (this.lastText.trim().length === 0) return [];

    const safeWidth = Math.max(0, width);
    if (safeWidth <= 0) return [''];

    const citationSignature = hostedSearchCitationSignature(
      this.citationSource,
      this.citationSources,
    );
    if (citationSignature !== this.renderedCitationSignature) {
      this.markRenderDirty();
      this.rebuildMarkdown();
    }

    if (
      isRenderCacheEnabled() &&
      this.renderCache !== undefined &&
      this.renderCache.width === safeWidth
    ) {
      return this.renderCache.lines;
    }

    const prefix = this.showBullet ? STATUS_BULLET : MESSAGE_INDENT;
    const contentWidth = Math.max(1, safeWidth - visibleWidth(prefix));
    const contentLines = this.contentContainer.render(contentWidth);

    const lines: string[] = [''];
    for (let i = 0; i < contentLines.length; i++) {
      const p =
        i === 0 && this.showBullet ? currentTheme.fg('text', STATUS_BULLET) : MESSAGE_INDENT;
      lines.push(p + contentLines[i]);
    }
    const rendered = lines.map((line) => truncateToWidth(line, safeWidth, '…'));
    if (isRenderCacheEnabled()) {
      this.renderCache = { width: safeWidth, lines: rendered };
    }
    return rendered;
  }
}
