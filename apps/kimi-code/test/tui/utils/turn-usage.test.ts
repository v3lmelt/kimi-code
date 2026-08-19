import { describe, expect, it } from 'vitest';

import {
  estimateStreamedTokens,
  formatTokenCount,
  formatTurnUsage,
  turnOutputTokens,
} from '#/tui/utils/turn-usage';

describe('formatTurnUsage', () => {
  it('returns an empty string when there is no active turn', () => {
    expect(formatTurnUsage('waiting', undefined)).toBe('');
    expect(formatTurnUsage('waiting', { input: 0, output: 0, turnStartedAt: 0 })).toBe('');
  });

  it('shows elapsed seconds before any usage arrives', () => {
    const now = Date.now();
    expect(formatTurnUsage('waiting', { input: 0, output: 0, turnStartedAt: now - 36_000 }, now)).toBe(
      ' (36s)',
    );
  });

  it('shows a single down-arrow output counter while streaming', () => {
    const now = Date.now();
    expect(
      formatTurnUsage('composing', { input: 1234, output: 340, turnStartedAt: now - 5000 }, now),
    ).toBe(' (5s · ↓ 340 tokens)');
  });

  it('shows an up arrow while waiting when output has already been generated', () => {
    const now = Date.now();
    expect(formatTurnUsage('waiting', { input: 0, output: 500, turnStartedAt: now - 1000 }, now)).toBe(
      ' (1s · ↑ 500 tokens)',
    );
  });

  it('switches to minutes after 60 seconds', () => {
    const now = Date.now();
    expect(formatTurnUsage('thinking', { input: 1, output: 0, turnStartedAt: now - 83_000 }, now)).toBe(
      ' (1m23s)',
    );
  });

  it('omits zero counters', () => {
    const now = Date.now();
    expect(formatTurnUsage('composing', { input: 0, output: 42, turnStartedAt: now - 1000 }, now)).toBe(
      ' (1s · ↓ 42 tokens)',
    );
  });

  it('folds live in-flight step usage into the settled totals', () => {
    const now = Date.now();
    expect(
      formatTurnUsage(
        'composing',
        {
          input: 1000,
          output: 100,
          turnStartedAt: now - 2000,
          live: { input: 234, output: 40 },
        },
        now,
      ),
    ).toBe(' (2s · ↓ 140 tokens)');
  });

  it('ticks the output counter from the local estimate while streaming', () => {
    const now = Date.now();
    expect(
      formatTurnUsage('composing', { input: 500, output: 0, turnStartedAt: now - 3000 }, now, 42),
    ).toBe(' (3s · ↓ 42 tokens)');
  });

  it('never lets the estimate pull the output counter below exact live usage', () => {
    const now = Date.now();
    const usage = {
      input: 0,
      output: 0,
      turnStartedAt: now - 1000,
      live: { input: 0, output: 100 },
    };
    expect(formatTurnUsage('composing', usage, now, 40)).toBe(' (1s · ↓ 100 tokens)');
    expect(formatTurnUsage('composing', usage, now, 140)).toBe(' (1s · ↓ 140 tokens)');
  });

  it('prefixes "thinking" while reasoning is in progress', () => {
    const now = Date.now();
    expect(
      formatTurnUsage('thinking', { input: 0, output: 0, turnStartedAt: now - 12_000 }, now, 0, 'thinking'),
    ).toBe(' (thinking · 12s)');
  });

  it('shows "thought for Ns" after reasoning completes', () => {
    const now = Date.now();
    expect(
      formatTurnUsage('thinking', { input: 0, output: 0, turnStartedAt: now - 5_000 }, now, 0, 3_400),
    ).toBe(' (thought for 3s · 5s)');
  });

  it('omits the thinking prefix when thinking status is null', () => {
    const now = Date.now();
    expect(
      formatTurnUsage('composing', { input: 0, output: 100, turnStartedAt: now - 2_000 }, now, 0, null),
    ).toBe(' (2s · ↓ 100 tokens)');
  });

  it('overrides the output counter with a shared displayed value', () => {
    const now = Date.now();
    const usage = {
      input: 500,
      output: 40,
      turnStartedAt: now - 2_000,
      live: { input: 0, output: 60 },
    };
    // displayedOutput wins over both the settled output and the estimate.
    expect(formatTurnUsage('composing', usage, now, 300, null, 150)).toBe(' (2s · ↓ 150 tokens)');
  });

  it('hides the output counter when the shared displayed value is zero', () => {
    const now = Date.now();
    expect(
      formatTurnUsage(
        'composing',
        { input: 0, output: 0, turnStartedAt: now - 2_000 },
        now,
        300,
        null,
        0,
      ),
    ).toBe(' (2s)');
  });
});

describe('estimateStreamedTokens', () => {
  it('approximates latin/code text at ~4 chars per token', () => {
    expect(estimateStreamedTokens('abcd')).toBe(1);
    expect(estimateStreamedTokens('hello world')).toBe(3);
  });

  it('counts CJK glyphs at a higher per-char rate', () => {
    expect(estimateStreamedTokens('你好世界')).toBe(3);
    expect(estimateStreamedTokens('関数')).toBe(2);
  });

  it('returns zero for empty text', () => {
    expect(estimateStreamedTokens('')).toBe(0);
  });
});

describe('formatTokenCount', () => {
  it('keeps small counts verbatim and abbreviates thousands', () => {
    expect(formatTokenCount(999)).toBe('999');
    expect(formatTokenCount(1000)).toBe('1k');
    expect(formatTokenCount(12_345)).toBe('12.3k');
  });
});

describe('turnOutputTokens', () => {
  it('returns zero when there is no turn usage', () => {
    expect(turnOutputTokens(undefined)).toBe(0);
  });

  it('sums settled output and the current step live output', () => {
    expect(turnOutputTokens({ input: 0, output: 100, turnStartedAt: 0, live: { input: 0, output: 40 } })).toBe(
      140,
    );
  });

  it('takes the larger of the estimate and the live output', () => {
    const usage = { input: 0, output: 100, turnStartedAt: 0, live: { input: 0, output: 40 } };
    expect(turnOutputTokens(usage, 42)).toBe(142);
    expect(turnOutputTokens(usage, 30)).toBe(140);
  });

  it('returns zero when there is no output at all', () => {
    expect(turnOutputTokens({ input: 15_000, output: 0, turnStartedAt: 0, live: { input: 15_000, output: 0 } })).toBe(
      0,
    );
  });

  it('ignores input entirely, even when it is huge', () => {
    // A large input (the step's full context) must never inflate the counter.
    const usage = { input: 15_000, output: 0, turnStartedAt: 0, live: { input: 15_000, output: 0 } };
    expect(turnOutputTokens(usage, 0)).toBe(0);
  });
});
