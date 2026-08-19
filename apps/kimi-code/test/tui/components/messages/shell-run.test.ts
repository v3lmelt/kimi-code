import { afterEach, describe, expect, it } from 'vitest';

import { ShellRunComponent } from '#/tui/components/messages/shell-run';

const ESC = '\u001B';

function stripTheme(text: string): string {
  return text.replaceAll(/\u001B\[[0-9;]*m/g, '');
}

describe('ShellRunComponent hardening', () => {
  let component: ShellRunComponent | undefined;

  afterEach(() => {
    // Always clear the 1s timer so it can't keep the test process alive or
    // fire requestRender after the test ends.
    component?.dispose();
    component = undefined;
  });

  function create(): ShellRunComponent {
    component = new ShellRunComponent(() => {});
    return component;
  }

  it('caps the running buffer and never throws on huge streaming output', () => {
    const c = create();
    const chunk = 'x'.repeat(50_000);
    expect(() => {
      for (let i = 0; i < 20; i++) c.append(chunk);
      c.render(100);
    }).not.toThrow();
  });

  it('finish switches to the final view and ignores later appends', () => {
    const c = create();
    c.finish('final output', '', false);
    c.append('should be ignored');
    const rendered = stripTheme(c.render(100).join('\n'));
    expect(rendered).toContain('final output');
    expect(rendered).not.toContain('should be ignored');
  });

  it('finishBackgrounded renders the background hint', () => {
    const c = create();
    c.finishBackgrounded();
    const rendered = stripTheme(c.render(100).join('\n'));
    expect(rendered).toContain('Moved to background.');
  });

  it('append / finish are no-ops after dispose', () => {
    const c = create();
    c.dispose();
    expect(() => {
      c.append('late');
      c.finish('late', '', false);
      c.finishBackgrounded();
      c.render(100);
    }).not.toThrow();
  });

  it('does not throw when the render callback throws', () => {
    const c = new ShellRunComponent(() => {
      throw new Error('render failed');
    });
    component = c;
    expect(() => {
      c.append('output');
      c.render(100);
    }).not.toThrow();
  });

  it('strips escape sequences split across append chunks while running', () => {
    const c = create();
    c.append('line one\nline two\n');
    c.append(`${ESC}[3`);
    c.append(`1mline three${ESC}[0m\n`);
    const rendered = stripTheme(c.render(100).join('\n'));
    expect(rendered).toContain('line three');
    expect(rendered).not.toContain(ESC);
  });

  it('shows only the last 5 sanitized lines while running', () => {
    const c = create();
    for (let i = 1; i <= 10; i++) c.append(`line ${i}\n`);
    const rendered = stripTheme(c.render(100).join('\n'));

    const lines = rendered.split('\n').map((l) => l.trimEnd());
    expect(lines.filter((l) => l.startsWith('  line '))).toEqual([
      '  line 6',
      '  line 7',
      '  line 8',
      '  line 9',
      '  line 10',
    ]);
    expect(lines).toContain('  +5 lines (0s)');
  });
});
