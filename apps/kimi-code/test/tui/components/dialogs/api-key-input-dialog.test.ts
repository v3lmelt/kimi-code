import { Container, visibleWidth } from '@moonshot-ai/pi-tui';
import { describe, expect, it } from 'vitest';

import { ApiKeyInputDialogComponent } from '#/tui/components/dialogs/api-key-input-dialog';

const ANSI = /\[[0-9;]*m/g;
const strip = (s: string): string => s.replaceAll(ANSI, '');

describe('ApiKeyInputDialogComponent', () => {
  it('keeps every line within narrow widths', () => {
    const dialog = new ApiKeyInputDialogComponent(
      'Kimi Code',
      ['Paste your API key below.', 'It will be stored locally.'],
      () => {},
    );
    dialog.focused = true;

    for (const width of [39, 20, 10]) {
      for (const line of dialog.render(width)) {
        expect(visibleWidth(line)).toBeLessThanOrEqual(width);
      }
    }
  });

  it('bumps render version so parent containers do not cache stale output', () => {
    const dialog = new ApiKeyInputDialogComponent('Kimi Code', [], () => {}, { mask: false });
    dialog.focused = true;
    const parent = new Container();
    parent.addChild(dialog);

    const before = strip(parent.render(120).join('\n'));
    expect(before).not.toContain('sk-a');

    dialog.handleInput('s');
    dialog.handleInput('k');
    dialog.handleInput('-');
    dialog.handleInput('a');

    const after = strip(parent.render(120).join('\n'));
    expect(after).toContain('sk-a');
  });
});
