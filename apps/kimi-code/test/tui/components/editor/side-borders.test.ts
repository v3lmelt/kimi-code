import { describe, it, expect } from 'vitest';

import { wrapWithSideBorders } from '#/tui/components/editor/custom-editor';

const id = (s: string): string => s;

describe('wrapWithSideBorders', () => {
  it('keeps the top horizontal border as a plain ─ rule (no corners)', () => {
    const out = wrapWithSideBorders(['──────────', '   hi     ', '──────────'], id);
    expect(out[0]).toBe('──────────');
  });

  it('renders a plain top rule when connected above (no ├/┤ junctions)', () => {
    const out = wrapWithSideBorders(['──────────', '   hi     ', '──────────'], id, {
      connectedAbove: true,
    });
    expect(out[0]).toBe('──────────');
    expect(out[2]).toBe('──────────');
  });

  it('keeps the bottom horizontal border as a plain ─ rule', () => {
    const out = wrapWithSideBorders(['──────────', '   hi     ', '──────────'], id);
    expect(out[2]).toBe('──────────');
  });

  it('leaves content lines untouched (no │ side bars)', () => {
    const out = wrapWithSideBorders(['──────────', '   hi     ', '──────────'], id);
    expect(out[1]).toBe('   hi     ');
  });

  it('treats scroll-indicator lines (── ↑ N more ──) as plain rules', () => {
    const top = '─── ↑ 5 more ────';
    const bot = '─── ↓ 3 more ────';
    const out = wrapWithSideBorders([top, '   x             ', bot], id);
    expect(out[0]).toBe(top);
    expect(out[2]).toBe(bot);
  });

  it('leaves autocomplete rows after the bottom border untouched', () => {
    const lines = ['──────────', '   q      ', '──────────', '   item1  ', '   item2  '];
    const out = wrapWithSideBorders(lines, id);
    expect(out[0]).toBe('──────────');
    expect(out[2]).toBe('──────────');
    expect(out[3]).toBe('   item1  ');
    expect(out[4]).toBe('   item2  ');
  });

  it('repaints each rule as a single span through the provided borderColor', () => {
    const paint = (s: string): string => `<${s}>`;
    const out = wrapWithSideBorders(['─────', '  x  ', '─────'], paint);
    expect(out[0]).toBe('<─────>');
    expect(out[2]).toBe('<─────>');
    // content lines are not painted
    expect(out[1]).toBe('  x  ');
  });

  it('strips existing SGR from rules before repainting', () => {
    const out = wrapWithSideBorders(['\u001B[31m─────\u001B[0m', '  x  ', '─────'], id);
    expect(out[0]).toBe('─────');
  });

  it('does not clobber non-space content sitting in the outer column (e.g. cursor overflow)', () => {
    // last column holds a non-space character — content rows always pass through
    const out = wrapWithSideBorders(['─────', '  abc', '─────'], id);
    expect(out[1]).toBe('  abc');
  });
});
