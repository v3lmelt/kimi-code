import { describe, expect, it } from 'vitest';

import {
  buildContextBreakdown,
  buildContextReportLines,
  estimateTokensFromText,
} from '#/tui/components/messages/context-panel';

function strip(text: string): string {
  return text.replaceAll(/\[[0-9;]*m/g, '');
}

describe('context panel estimate', () => {
  it('estimates tokens as ceil(chars / 4)', () => {
    expect(estimateTokensFromText(undefined)).toBeUndefined();
    expect(estimateTokensFromText('')).toBe(0);
    expect(estimateTokensFromText('abcd')).toBe(1);
    expect(estimateTokensFromText('abcde')).toBe(2);
  });

  it('puts leftover used tokens into Messages and leftover window into Free', () => {
    const breakdown = buildContextBreakdown({
      usedTokens: 1000,
      maxTokens: 4000,
      systemPrompt: 'a'.repeat(400),
      toolsSchema: 'b'.repeat(200),
      reservedTokens: 50,
    });
    const byName = Object.fromEntries(breakdown.categories.map((row) => [row.name, row.tokens]));
    expect(byName['System prompt']).toBe(100);
    expect(byName['Tools']).toBe(50);
    expect(byName['Skills']).toBeUndefined();
    expect(byName['Autocompact buffer']).toBe(50);
    expect(byName['Messages']).toBe(800);
    expect(byName['Free']).toBe(3000);
  });

  it('renders n/a for missing categories and a compact hint', () => {
    const lines = buildContextReportLines(
      buildContextBreakdown({ usedTokens: 2500, maxTokens: 10_000 }),
    ).map(strip);
    const text = lines.join('\n');
    expect(text).toContain('Context');
    expect(text).toContain('25%');
    expect(text).toContain('System prompt');
    expect(text).toContain('n/a');
    expect(text).toContain('Messages');
    expect(text).toContain('Free');
    expect(text).toContain('Estimates only');
    expect(text).toContain('Run /compact to free space.');
  });
});
