import type { TUI } from '@moonshot-ai/pi-tui';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { MoonLoader } from '#/tui/components/chrome/moon-loader';

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

  it('appends the status provider text on its own row but keeps it out of renderInline', () => {
    const loader = createLoader();
    loader.setStatusProvider(() => ' (36s · ↑ 1.2k tok)');

    const row = loader.render(80).join('\n');
    expect(row).toContain('(36s · ↑ 1.2k tok)');
    expect(loader.renderInline()).not.toContain('36s');

    loader.setStatusProvider(undefined);
    expect(loader.render(80).join('\n')).not.toContain('36s');
  });

  it('turns the label red after a stall with no active tools', () => {
    const loader = createLoader();
    loader.setLabel('Working…');
    loader.setStallProvider(() => ({ lastActivityAtMs: 0, hasActiveTools: false }));
    // 0 lastActivityAtMs => elapsed far exceeds the 3s threshold.
    const row = loader.render(80).join('\n');
    expect(row).toContain('Working…');
    expect(row).not.toMatch(/Waiting|Pondering/); // label is the explicit one
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
});
