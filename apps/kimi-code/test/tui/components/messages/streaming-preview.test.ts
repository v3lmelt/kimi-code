import { describe, expect, it } from 'vitest';

import { StreamingPreviewComponent } from '#/tui/components/messages/streaming-preview';

describe('StreamingPreviewComponent', () => {
  it('reveals complete lines only, hiding the in-progress last line', () => {
    const comp = new StreamingPreviewComponent();
    comp.updateContent('first line\nsecond line\nparti');
    const out = comp.render(80).join('\n');
    expect(out).toContain('first line');
    expect(out).toContain('second line');
    expect(out).not.toContain('parti');
  });

  it('shows nothing until the first line break arrives', () => {
    const comp = new StreamingPreviewComponent();
    comp.updateContent('still on the first line');
    expect(comp.render(80)).toEqual([]);
  });

  it('updates as more complete lines arrive', () => {
    const comp = new StreamingPreviewComponent();
    comp.updateContent('one\n');
    expect(comp.render(80).join('\n')).toContain('one');

    comp.updateContent('one\ntwo\nthree');
    const out = comp.render(80).join('\n');
    expect(out).toContain('one');
    expect(out).toContain('two');
    expect(out).not.toContain('three');
  });
});
