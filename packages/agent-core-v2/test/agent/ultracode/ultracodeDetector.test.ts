/**
 * `containsUltracodeToken` keyword detection for the ultracode trigger: the
 * bare `chesto!` token opts a turn into ultracode mode, and nothing inside
 * code, commands, or quoted strings ever triggers it.
 * Run: pnpm exec vitest run test/agent/ultracode/ultracodeDetector.test.ts
 */

import { describe, expect, it } from 'vitest';

import { containsUltracodeToken } from '#/agent/ultracode/ultracodeDetector';

describe('containsUltracodeToken', () => {
  it('fires on a bare chesto! token', () => {
    expect(containsUltracodeToken('chesto!')).toBe(true);
    expect(containsUltracodeToken('please chesto!')).toBe(true);
    expect(containsUltracodeToken('CHESTO!')).toBe(true);
    expect(containsUltracodeToken("chesto! let's orchestrate the fan-out")).toBe(true);
  });

  it('does not fire on a bare chesto without the bang', () => {
    expect(containsUltracodeToken('chesto')).toBe(false);
    expect(containsUltracodeToken('please chesto now')).toBe(false);
  });

  it('does not fire when chesto! is embedded inside a word', () => {
    expect(containsUltracodeToken('xchesto!')).toBe(false);
    expect(containsUltracodeToken('unchesto!')).toBe(false);
  });

  it('ignores fenced code blocks, inline code, and quoted strings', () => {
    expect(containsUltracodeToken('```\nchesto!\n```')).toBe(false);
    expect(containsUltracodeToken('run `chesto!`')).toBe(false);
    expect(containsUltracodeToken('the word "chesto!" is a keyword')).toBe(false);
    expect(containsUltracodeToken("it says 'chesto!' in the doc")).toBe(false);
  });

  it('ignores slash-command lines', () => {
    expect(containsUltracodeToken('/chesto!')).toBe(false);
    expect(containsUltracodeToken('run /ultracode\nchesto!')).toBe(true);
  });

  it('no longer treats the old ultracode keyword as a trigger', () => {
    expect(containsUltracodeToken('ultracode')).toBe(false);
    expect(containsUltracodeToken('please ultracode this turn')).toBe(false);
  });

  it('handles empty input', () => {
    expect(containsUltracodeToken('')).toBe(false);
  });
});
