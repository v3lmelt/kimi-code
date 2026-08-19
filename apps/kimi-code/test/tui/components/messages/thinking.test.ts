import { visibleWidth } from '@moonshot-ai/pi-tui';
import { describe, expect, it } from 'vitest';

import { ThinkingComponent } from '#/tui/components/messages/thinking';
import { THINKING_LIVE_WINDOW_CHARS } from '#/tui/constant/rendering';
import { STATUS_BULLET } from '#/tui/constant/symbols';
import { windowTail } from '#/tui/utils/tail-window';

function strip(text: string): string {
  return text.replaceAll(/\u001B\[[0-9;]*m/g, '');
}

const longThinking = ['line1', 'line2', 'line3', 'line4', 'line5', 'line6', 'line7'].join('\n');

/** Thinking draft longer than the 8KB live tail window, with distinct
 *  head/tail markers. */
const liveHead = 'HEAD-MARKER';
const liveTail = 'TAIL-MARKER';
const liveFiller = Array.from({ length: 90 }, (_, i) => `filler-${i}-${'x'.repeat(90)}`).join('\n');
const longLiveDraft = `${liveHead}\n${liveFiller}\n${liveTail}`;

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

describe('ThinkingComponent live tail window', () => {
  /** The styled text currently held by the inner Text component. */
  function innerText(component: ThinkingComponent): string {
    return (component as unknown as { textComponent: { text: string } }).textComponent.text;
  }

  it('styles and wraps only the tail window while live, keeping the draft head out', () => {
    const component = new ThinkingComponent('', true, 'live');
    component.setText(longLiveDraft);

    expect(strip(innerText(component))).toBe(windowTail(longLiveDraft, THINKING_LIVE_WINDOW_CHARS));
    expect(innerText(component)).toContain(liveTail);
    expect(innerText(component)).not.toContain(liveHead);
  });

  it('does not window short drafts', () => {
    const component = new ThinkingComponent('', true, 'live');
    component.setText('short draft');

    expect(strip(innerText(component))).toBe('short draft');
  });

  it('keeps the full draft for the finalized view', () => {
    const component = new ThinkingComponent('', true, 'live');
    component.setText(longLiveDraft);
    component.finalize();

    // The finalized preview shows the head of the full text — only reachable
    // if the windowed live updates never dropped it.
    const preview = strip(component.render(80).join('\n'));
    expect(preview).toContain(liveHead);
    expect(preview).toContain('ctrl+o to expand');

    // Expanding renders the complete draft including its tail.
    component.setExpanded(true);
    const expanded = strip(component.render(80).join('\n'));
    expect(expanded).toContain(liveHead);
    expect(expanded).toContain(liveTail);
  });
});

describe('windowTail', () => {
  it('returns text within the limit unchanged', () => {
    expect(windowTail('abc\ndef', 10)).toBe('abc\ndef');
  });

  it('aligns long text to a complete line start', () => {
    const text = 'head\nmid\ntail';
    expect(windowTail(text, 4)).toBe('tail');
    expect(windowTail(text, 8)).toBe('mid\ntail');
  });

  it('cuts mid-line when no newline precedes the window', () => {
    const text = 'x'.repeat(100);
    expect(windowTail(text, 10)).toBe('x'.repeat(10));
  });
});
