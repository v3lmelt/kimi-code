import { describe, expect, it } from 'vitest';

import { ReadGroupComponent } from '#/tui/components/messages/read-group';
import type { ToolCallComponent, ToolCallReadSnapshot } from '#/tui/components/messages/tool-call';
import type { ToolCallBlockData } from '#/tui/types';

function strip(text: string): string {
  return text.replaceAll(/\[[0-9;]*m/g, '');
}

function stubTool(
  name: string,
  snapshot: Omit<ToolCallReadSnapshot, 'toolCallId' | 'toolName'>,
): ToolCallComponent {
  const id = `call_${name}_${snapshot.filePath ?? snapshot.pattern ?? 'x'}`;
  const call: ToolCallBlockData = { id, name, args: {}, step: 1, turnId: 't1' };
  return {
    toolCallView: call,
    getReadSnapshot: () => ({ toolCallId: id, toolName: name, ...snapshot }),
    setSnapshotListener: () => {},
  } as unknown as ToolCallComponent;
}

describe('ReadGroupComponent', () => {
  it('summarizes mixed Read + Grep + Glob in one header', () => {
    const group = new ReadGroupComponent(undefined);
    try {
      group.attach(
        'r',
        stubTool('Read', { filePath: 'src/a.ts', pattern: undefined, phase: 'done', lines: 3 }),
      );
      group.attach(
        'g',
        stubTool('Grep', { filePath: undefined, pattern: 'foo', phase: 'done', lines: 2 }),
      );
      group.attach(
        'l',
        stubTool('Glob', { filePath: undefined, pattern: '**/*.ts', phase: 'done', lines: 2 }),
      );
      const text = strip(group.render(120).join('\n'));
      expect(text).toContain('Read 1 file · 3 lines');
      expect(text).toContain('Grepped 1 · Found 2');
      expect(text).toContain('Found 2');
      expect(text).toContain('src/a.ts');
      expect(text).toContain('foo');
      expect(text).toContain('**/*.ts');
    } finally {
      group.dispose();
    }
  });

  it('uses live verbs while any member is still pending', () => {
    const group = new ReadGroupComponent(undefined);
    try {
      group.attach(
        'r',
        stubTool('Read', { filePath: 'src/a.ts', pattern: undefined, phase: 'pending', lines: 0 }),
      );
      group.attach(
        'g',
        stubTool('Grep', { filePath: undefined, pattern: 'bar', phase: 'pending', lines: 0 }),
      );
      const text = strip(group.render(120).join('\n'));
      expect(text).toContain('Reading 1 file…');
      expect(text).toContain('Grepping…');
      expect(text).toContain('src/a.ts');
      expect(text).toContain('bar');
    } finally {
      group.dispose();
    }
  });
});
