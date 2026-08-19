/**
 * Regression test: closing a mounted dialog must re-render even when the
 * editor buffer did not change. `restoreEditor()` re-adds the SAME editor
 * component (same version), so a naive version-only cache in Container would
 * serve the stale dialog lines and the screen would look frozen.
 */

import { Container, Editor } from '@moonshot-ai/pi-tui';
import { describe, expect, it } from 'vitest';

import { TabbedModelSelectorComponent } from '#/tui/components/dialogs/tabbed-model-selector';
import type { ModelAlias } from '@moonshot-ai/kimi-code-sdk';

const ESC = String.fromCodePoint(27);
const SGR = new RegExp(`${ESC}\\[[0-9;]*m`, 'g');
const strip = (s: string): string => s.replaceAll(SGR, '');

function model(displayName: string, provider: string): ModelAlias {
  return {
    provider,
    model: displayName.toLowerCase().replaceAll(' ', '-'),
    maxContextSize: 200_000,
    displayName,
    capabilities: ['thinking'],
  } as unknown as ModelAlias;
}

describe('editor replacement caching', () => {
  it('re-renders the editor after restoreEditor swaps the selector out', () => {
    // Mirrors KimiTUI: an editorContainer that hosts either the editor or a
    // mounted dialog (mountEditorReplacement / restoreEditor).
    const editorContainer = new Container();
    const editor = new Editor(
      { terminal: { rows: 24, columns: 100 } } as never,
      {
        borderColor: (s: string) => s,
        selectList: {
          selectedBg: (s: string) => s,
          matchHighlight: (s: string) => s,
        },
      } as never,
    );
    editor.setText('hello world');
    editorContainer.addChild(editor);

    const before = strip(editorContainer.render(100).join('\n'));
    expect(before).toContain('hello world');

    const selector = new TabbedModelSelectorComponent({
      models: {
        k2: model('Kimi K2', 'managed:kimi-code'),
        gpt: model('GPT-5', 'openai'),
      },
      currentValue: 'k2',
      currentThinkingEffort: 'off',
      onSelect: () => {},
      onCancel: () => {},
    });

    // mountEditorReplacement
    editorContainer.clear();
    editorContainer.addChild(selector);
    const withDialog = strip(editorContainer.render(100).join('\n'));
    expect(withDialog).toContain('Select a model');
    expect(withDialog).not.toContain('hello world');

    // restoreEditor: same editor object, unchanged text, same version.
    editorContainer.clear();
    editorContainer.addChild(editor);
    const restored = strip(editorContainer.render(100).join('\n'));
    expect(restored).toContain('hello world');
    expect(restored).not.toContain('Select a model');
  });
});
