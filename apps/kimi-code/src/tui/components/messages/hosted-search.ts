import { getCapabilities, truncateToWidth, visibleWidth, type Component } from '@moonshot-ai/pi-tui';
import type { HostedSearchSource } from '@moonshot-ai/kimi-code-sdk';

import { STATUS_BULLET } from '#/tui/constant/symbols';
import { currentTheme } from '#/tui/theme';
import type { HostedSearchTranscriptData } from '#/tui/types';
import { canonicalHostedSearchUrl } from '#/tui/utils/hosted-search';
import { toTerminalHyperlink } from '#/utils/terminal-hyperlink';

function fit(text: string, width: number): string {
  return truncateToWidth(text, Math.max(0, width), '…');
}

function wrapText(text: string, width: number): string[] {
  const normalized = text.replaceAll('\r', '').trim();
  if (normalized.length === 0) return [];
  if (width <= 0) return [''];
  const words = normalized.split(/\s+/u);
  const lines: string[] = [];
  let line = '';
  for (const word of words) {
    if (line.length === 0) {
      if (word.length <= width) {
        line = word;
        continue;
      }
      for (let offset = 0; offset < word.length; offset += width) {
        lines.push(word.slice(offset, offset + width));
      }
      continue;
    }
    if (line.length + 1 + word.length <= width) {
      line += ` ${word}`;
    } else {
      lines.push(line);
      line = word;
    }
  }
  if (line.length > 0) lines.push(line);
  return lines;
}

function sourceHost(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return url;
  }
}

function sourceLink(text: string, url: string): string {
  return getCapabilities().hyperlinks ? toTerminalHyperlink(text, url) : text;
}

function statusText(data: HostedSearchTranscriptData): string {
  if (data.status === 'failed') return 'failed';
  if (data.status === 'completed' || data.phase === 'completed') return 'complete';
  if (data.status === 'searching') return 'searching';
  return 'starting';
}

function actionText(data: HostedSearchTranscriptData): string[] {
  return data.actions.map((action) => {
    switch (action.type) {
      case 'search': {
        const query = action.query ?? action.queries?.join(', ');
        return query === undefined ? 'search' : `search: ${query}`;
      }
      case 'open_page': {
        const url = action.url === undefined ? undefined : canonicalHostedSearchUrl(action.url);
        return url === undefined ? 'open page' : `open: ${url}`;
      }
      case 'find_in_page': {
        const url = action.url === undefined ? undefined : canonicalHostedSearchUrl(action.url);
        return action.pattern === undefined ? `find: ${url ?? ''}`.trim() : `find: ${action.pattern}`;
      }
      default:
        return 'search';
    }
  });
}

function snippetLabel(source: HostedSearchSource): string {
  switch (source.snippetKind) {
    case 'citation':
      return source.cited === true ? 'quoted · cited' : 'quoted';
    case 'page_extract':
      return source.cited === true ? 'page extract · cited' : 'page extract';
    case 'unavailable':
      return 'summary unavailable';
    case undefined:
      return source.cited === true ? 'source · cited' : 'source';
  }
}

/** A dedicated card for the provider-owned hosted search lifecycle. */
export class HostedSearchComponent implements Component {
  private invalidationVersion = 0;

  constructor(private readonly data: HostedSearchTranscriptData) {}

  get version(): number {
    return this.data.version + this.invalidationVersion;
  }

  invalidate(): void {
    this.invalidationVersion += 1;
  }

  render(width: number): string[] {
    const safeWidth = Math.max(1, width);
    const lines: string[] = [''];
    const header =
      currentTheme.fg('text', STATUS_BULLET) +
      currentTheme.fg('textDim', 'Hosted search · ') +
      currentTheme.bold(statusText(this.data));
    lines.push(fit(header, safeWidth));

    if (this.data.query !== undefined && this.data.query.trim().length > 0) {
      lines.push(fit(`  Query: ${this.data.query.trim()}`, safeWidth));
    }
    for (const action of actionText(this.data)) {
      lines.push(fit(`  Action: ${action}`, safeWidth));
    }

    if (this.data.sources.length === 0) {
      if (this.data.phase === 'completed' || this.data.status === 'failed') {
        lines.push(currentTheme.fg('textDim', '  No usable sources returned.'));
      }
      return lines.map((line) => fit(line, safeWidth));
    }

    lines.push(
      fit(
        currentTheme.fg('textDim', `  Sources (${String(this.data.sources.length)}):`),
        safeWidth,
      ),
    );
    const sourceIndent = '      ';
    const snippetWidth = Math.max(1, safeWidth - visibleWidth(sourceIndent));
    this.data.sources.forEach((source, index) => {
      const title = source.title?.trim() ?? source.siteName?.trim() ?? sourceHost(source.url);
      lines.push(
        fit(
          `  ${String(index + 1)}. ${title}${source.date === undefined ? '' : ` · ${source.date}`}`,
          safeWidth,
        ),
      );
      const visibleUrl = fit(source.url, Math.max(1, safeWidth - visibleWidth(sourceIndent)));
      lines.push(fit(`${sourceIndent}${sourceLink(visibleUrl, source.url)}`, safeWidth));

      const snippet = source.snippet?.trim() ?? '';
      if (snippet.length === 0 || source.snippetKind === 'unavailable') {
        lines.push(
          fit(
            `${sourceIndent}${currentTheme.fg('textMuted', snippetLabel(source))}`,
            safeWidth,
          ),
        );
        return;
      }
      const label = `${snippetLabel(source)}: `;
      const wrapped = wrapText(snippet, Math.max(1, snippetWidth - label.length));
      wrapped.forEach((part, wrappedIndex) => {
        const prefix = wrappedIndex === 0 ? label : ' '.repeat(label.length);
        lines.push(
          fit(`${sourceIndent}${currentTheme.fg('textDim', `${prefix}${part}`)}`, safeWidth),
        );
      });
    });
    return lines.map((line) => fit(line, safeWidth));
  }
}
