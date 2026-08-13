import { visibleWidth } from '@moonshot-ai/pi-tui';
import { describe, expect, it } from 'vitest';

import { ThinkingComponent } from '#/tui/components/messages/thinking';
import { STATUS_BULLET } from '#/tui/constant/symbols';

function strip(text: string): string {
  return text.replaceAll(/\u001B\[[0-9;]*m/g, '');
}

const longThinking = ['line1', 'line2', 'line3', 'line4', 'line5', 'line6', 'line7'].join('\n');

describe('ThinkingComponent', () => {
  it('shows the ∴ Thinking… header before live thinking content', () => {
    const component = new ThinkingComponent('working it out', true, 'live');
    const out = strip(component.render(80).join('\n'));

    expect(out).toContain('∴ Thinking…');
    expect(out).not.toContain(`${STATUS_BULLET}∴`);
    expect(out).toContain('  working it out');
  });

  it('keeps live thinking height-limited to the tail', () => {
    const component = new ThinkingComponent(longThinking, true, 'live');
    const out = strip(component.render(80).join('\n'));

    expect(out).not.toContain('line1');
    expect(out).not.toContain('line4');
    expect(out).not.toContain('line5');
    expect(out).toContain('line6');
    expect(out).toContain('line7');
    expect(out).not.toContain('ctrl+o to expand');
  });

  it('finalizes in place into a collapsed preview', () => {
    const component = new ThinkingComponent(longThinking, true, 'live');

    component.finalize();

    const out = strip(component.render(80).join('\n'));
    expect(out).toContain('line1');
    expect(out).toContain('line2');
    expect(out).not.toContain('line3');
    expect(out).not.toContain('line4');
    expect(out).toContain('… (5 more lines, ctrl+o to expand)');
  });

  it('expands and collapses after finalization', () => {
    const component = new ThinkingComponent(longThinking, true, 'live');
    component.finalize();

    component.setExpanded(true);
    const expanded = strip(component.render(80).join('\n'));
    expect(expanded).toContain('line7');
    expect(expanded).not.toContain('ctrl+o to expand');

    component.setExpanded(false);
    const collapsed = strip(component.render(80).join('\n'));
    expect(collapsed).not.toContain('line7');
    expect(collapsed).toContain('ctrl+o to expand');
  });

  it('keeps the finalized truncation footer within the requested render width', () => {
    const component = new ThinkingComponent(longThinking, true, 'live');
    component.finalize();

    for (const line of component.render(37)) {
      expect(visibleWidth(line)).toBeLessThanOrEqual(37);
    }
  });

  it('collapses live thinking to a bare indicator when collapse is on', () => {
    const component = new ThinkingComponent(longThinking, true, 'live', undefined, true);
    const out = strip(component.render(80).join('\n'));

    expect(out).toContain('∴ Thinking…');
    expect(out).not.toContain('line6');
    expect(out).not.toContain('line7');
  });

  it('collapses finalized thinking to a bare indicator when collapse is on', () => {
    const component = new ThinkingComponent(longThinking, true, 'finalized', undefined, true);
    const out = strip(component.render(80).join('\n'));

    expect(out).toContain('∴ Thinking…');
    expect(out).toContain('ctrl+o to expand');
    expect(out).not.toContain('line1');
  });

  it('reveals collapsed thinking when expanded', () => {
    const component = new ThinkingComponent(longThinking, true, 'finalized', undefined, true);
    component.setExpanded(true);
    const out = strip(component.render(80).join('\n'));

    expect(out).toContain('line7');
    expect(out).not.toContain('ctrl+o to expand');
  });
});
