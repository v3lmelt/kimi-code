import type { TUI } from '@moonshot-ai/pi-tui';
import chalk from 'chalk';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  MoonLoader,
  thinkingPhraseForElapsed,
} from '#/tui/components/chrome/moon-loader';
import { currentTheme } from '#/tui/theme';

// MoonLoader starts a real setInterval in its constructor, so every loader
// created in these tests must be stopped to avoid leaving live timers behind.
const loaders: MoonLoader[] = [];

function createLoader(): MoonLoader {
  const ui = { requestRender() {} } as unknown as TUI;
  const loader = new MoonLoader(ui, 'moon');
  loaders.push(loader);
  return loader;
}

afterEach(() => {
  for (const loader of loaders) loader.stop();
  loaders.length = 0;
});

describe('MoonLoader', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('keeps the tip out of renderInline so it does not squeeze against the swarm progress bar', () => {
    const loader = createLoader();
    loader.setTip(' · Tip: ctrl+s: steer mid-turn');
    loader.setAvailableWidth(80);

    const inline = loader.renderInline();
    expect(inline).not.toContain('Tip');
    expect(inline).not.toContain('steer');
    expect(inline.trim().length).toBeGreaterThan(0);
  });

  it('still shows the tip on its own row when width allows', () => {
    const loader = createLoader();
    loader.setTip(' · Tip: ctrl+s: steer mid-turn');
    loader.setAvailableWidth(80);

    const row = loader.render(80).join('\n');
    expect(row).toContain('Tip: ctrl+s: steer mid-turn');
  });

  it('moves the tip to a second row when the primary row is narrow', () => {
    const loader = createLoader();
    loader.setLabel('Working…');
    loader.setTip(' · Tip: ctrl+s: steer mid-turn');

    const rows = loader.render(20);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toContain('Working');
    expect(rows[1]).toContain('Tip:');
  });

  it('appends the status provider text on its own row but keeps it out of renderInline', () => {
    const loader = createLoader();
    loader.setStatusProvider(() => ' (36s · ↑ 1.2k tok)');

    const row = loader.render(80).join('\n');
    expect(row).toContain('(36s · ↑ 1.2k tok)');
    expect(loader.renderInline()).not.toContain('36s');

    loader.setStatusProvider(undefined);
    expect(loader.render(80).join('\n')).not.toContain('36s');
  });

  it('does not treat a missing activity timestamp as an immediate stall', () => {
    const previousChalkLevel = chalk.level;
    chalk.level = 3;
    const loader = createLoader();
    try {
      loader.setLabel('Working…');
      loader.setStallProvider(() => ({ lastActivityAtMs: 0, hasActiveTools: false }));
      const row = loader.render(80).join('\n');
      expect(row).not.toContain(currentTheme.fg('error', 'Working…'));
    } finally {
      chalk.level = previousChalkLevel;
    }
  });

  it('turns the label red after a sustained stall', () => {
    const previousChalkLevel = chalk.level;
    chalk.level = 3;
    const loader = createLoader();
    try {
      loader.setLabel('Working…');
      loader.setStallProvider(() => ({
        lastActivityAtMs: Date.now() - 21_000,
        hasActiveTools: false,
      }));

      expect(loader.render(80).join('\n')).toContain(currentTheme.fg('error', 'Working…'));
    } finally {
      chalk.level = previousChalkLevel;
    }
  });

  it('does not stall while tools are active', () => {
    const loader = createLoader();
    loader.setLabel('Working…');
    const now = Date.now();
    loader.setStallProvider(() => ({ lastActivityAtMs: now, hasActiveTools: true }));
    const row = loader.render(80).join('\n');
    expect(row).toContain('Working…');
  });

  it('accepts mode and thinking status providers without throwing', () => {
    const loader = createLoader();
    loader.setMode('tool');
    loader.setThinkingStatusProvider(() => 'thinking');
    loader.setStatusProvider(() => ' (thinking · 12s)');
    const row = loader.render(120).join('\n');
    expect(row).toContain('(thinking · 12s)');
  });

  it('keeps the working verb on the primary row and advances the thinking phrase in status', () => {
    const loader = createLoader();
    loader.setLabel('Working…');
    loader.setMode('thinking');
    loader.setThinkingStatusProvider(() => 'thinking');
    loader.setThinkingStartProvider(() => Date.now() - 20_000);
    loader.setStatusProvider(() => ' (20s · thinking)');

    const row = loader.render(120)[0]!;
    expect(row).toContain('Working…');
    expect(row).toContain('thinking more');
  });

  it('renders retry details on a dedicated error row', () => {
    const loader = createLoader();
    loader.setLabel('Working…');
    loader.setStatusProvider(() => ' (12s · ↓ 42 tokens)');
    loader.setRetryStatusProvider(() => ' Retrying in 5s · attempt 2/3');

    const rows = loader.render(120);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toContain('12s');
    expect(rows[1]).toContain('Retrying in 5s');
  });

  it('renders compacting as indeterminate progress without a percentage', () => {
    const loader = createLoader();
    loader.setMode('compacting');
    loader.setLabel('Compacting conversation…');

    const rows = loader.render(80);
    expect(rows).toHaveLength(2);
    expect(rows[1]).toMatch(/[─━]/);
    expect(rows.join('\n')).not.toContain('%');
  });
});

describe('thinkingPhraseForElapsed', () => {
  it.each([
    [0, 'thinking'],
    [10_000, 'still thinking'],
    [20_000, 'thinking more'],
    [30_000, 'thinking some more'],
    [45_000, 'almost done thinking'],
  ] as const)('uses the phrase for %i milliseconds', (elapsed, phrase) => {
    expect(thinkingPhraseForElapsed(elapsed)).toBe(phrase);
  });
});
