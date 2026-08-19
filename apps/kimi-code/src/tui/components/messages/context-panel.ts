/**
 * Local-estimate /context panel.
 *
 * Display-only: token counts are `ceil(chars / 4)` when a source string is
 * available, otherwise the live footer window (messages + free). This is not
 * a billing meter and does not call a remote count API.
 */

import {
  formatTokenCount,
  ratioSeverity,
  renderProgressBar,
  safeUsageRatio,
  usagePercent,
} from '#/utils/usage/usage-format';
import { currentTheme } from '#/tui/theme';
import type { ColorToken } from '#/tui/theme';

import { UsagePanelComponent } from './usage-panel';

/** Display estimate, not billing. */
export const CONTEXT_ESTIMATE_CHARS_PER_TOKEN = 4;

export interface ContextCategory {
  readonly name: string;
  readonly tokens: number | undefined;
}

export interface ContextBreakdown {
  readonly usedTokens: number;
  readonly maxTokens: number;
  readonly categories: readonly ContextCategory[];
}

export function estimateTokensFromText(text: string | undefined): number | undefined {
  if (text === undefined) return undefined;
  if (text.length === 0) return 0;
  return Math.ceil(text.length / CONTEXT_ESTIMATE_CHARS_PER_TOKEN);
}

export function buildContextBreakdown(input: {
  readonly usedTokens: number;
  readonly maxTokens: number;
  readonly systemPrompt?: string;
  readonly toolsSchema?: string;
  readonly skills?: string;
  readonly reservedTokens?: number;
}): ContextBreakdown {
  const used = Number.isFinite(input.usedTokens) ? Math.max(0, Math.round(input.usedTokens)) : 0;
  const max = Number.isFinite(input.maxTokens) ? Math.max(0, Math.round(input.maxTokens)) : 0;
  const system = estimateTokensFromText(input.systemPrompt);
  const tools = estimateTokensFromText(input.toolsSchema);
  const skills = estimateTokensFromText(input.skills);
  const reserved =
    input.reservedTokens !== undefined && Number.isFinite(input.reservedTokens)
      ? Math.max(0, Math.round(input.reservedTokens))
      : undefined;

  const known =
    (system ?? 0) + (tools ?? 0) + (skills ?? 0) + (reserved ?? 0);
  const messages = Math.max(0, used - known);
  const free = max > 0 ? Math.max(0, max - used) : undefined;

  return {
    usedTokens: used,
    maxTokens: max,
    categories: [
      { name: 'System prompt', tokens: system },
      { name: 'Tools', tokens: tools },
      { name: 'Messages', tokens: messages },
      { name: 'Skills', tokens: skills },
      { name: 'Autocompact buffer', tokens: reserved },
      { name: 'Free', tokens: free },
    ],
  };
}

function severityColor(sev: 'ok' | 'warn' | 'danger'): 'success' | 'warning' | 'error' {
  return sev === 'danger' ? 'error' : sev === 'warn' ? 'warning' : 'success';
}

export function buildContextReportLines(breakdown: ContextBreakdown): string[] {
  const accent = (text: string) => currentTheme.boldFg('primary', text);
  const value = (text: string) => currentTheme.fg('text', text);
  const muted = (text: string) => currentTheme.fg('textDim', text);

  const lines: string[] = [accent('Context')];
  const max = breakdown.maxTokens;
  const used = breakdown.usedTokens;
  if (max > 0) {
    const ratio = safeUsageRatio(used / max);
    const bar = renderProgressBar(ratio, 20);
    const pct = `${String(usagePercent(used, max))}%`;
    lines.push(
      `  ${currentTheme.fg(severityColor(ratioSeverity(ratio)), bar)}  ${value(pct.padStart(6, ' '))}  ` +
        muted(`(${formatTokenCount(used)} / ${formatTokenCount(max)})`),
    );
  } else {
    lines.push(muted('  Window size unavailable.'));
  }

  lines.push('');
  const labelWidth = Math.max(...breakdown.categories.map((row) => row.name.length), 8);
  for (const row of breakdown.categories) {
    const tokens = row.tokens === undefined ? 'n/a' : formatTokenCount(row.tokens);
    lines.push(`  ${muted(row.name.padEnd(labelWidth, ' '))}  ${value(tokens)}`);
  }

  lines.push('');
  lines.push(muted('Estimates only · not a billing meter.'));
  lines.push(muted('Run /compact to free space.'));
  return lines;
}

export function createContextPanel(
  breakdown: ContextBreakdown,
  borderToken: ColorToken = 'primary',
): UsagePanelComponent {
  return new UsagePanelComponent(() => buildContextReportLines(breakdown), borderToken, ' Context ');
}
