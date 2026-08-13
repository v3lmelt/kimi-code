import type { Component } from '@moonshot-ai/pi-tui';
import { Container, Text, visibleWidth } from '@moonshot-ai/pi-tui';

import { RESPONSE_GUTTER } from '#/tui/constant/symbols';
import { currentTheme } from '#/tui/theme';
import type { ToolCallBlockData, ToolResultBlockData } from '#/tui/types';

import type { ResultRenderer } from './tool-renderers/types';
import { PREVIEW_LINES } from './tool-renderers/types';
import { TruncatedOutputComponent } from './tool-renderers/truncated';

export interface ShellExecutionOptions {
  readonly command?: string;
  readonly result?: ToolResultBlockData;
  readonly expanded?: boolean;
  readonly showCommand?: boolean;
  /**
   * Max command lines to render. `undefined` means no cap — used by the
   * ctrl+o expanded view so the user can see the full multi-line command
   * even when the header preview was truncated.
   */
  readonly commandPreviewLines?: number;
  readonly resultPreviewLines?: number;
  readonly tailOutput?: boolean;
  readonly expandHint?: boolean;
}

/**
 * Claude Code-style response gutter: the first output line gets the dim
 * '  ⎿  ' marker, continuation lines align under it in a 5-column gutter.
 */
class GutteredOutputComponent implements Component {
  private readonly gutterWidth = visibleWidth(RESPONSE_GUTTER);

  constructor(private readonly inner: TruncatedOutputComponent) {}

  invalidate(): void {
    this.inner.invalidate();
  }

  render(width: number): string[] {
    const lines = this.inner.render(Math.max(1, width - this.gutterWidth));
    return lines.map((line, i) =>
      i === 0
        ? currentTheme.dim(RESPONSE_GUTTER) + line
        : ' '.repeat(this.gutterWidth) + line,
    );
  }
}

export class ShellExecutionComponent extends Container {
  constructor(options: ShellExecutionOptions) {
    super();

    if (options.showCommand === true) {
      this.addCommandPreview(options.command ?? '', options.commandPreviewLines);
    }

    if (options.result !== undefined) {
      this.addResultPreview(
        options.result,
        options.expanded ?? false,
        options.resultPreviewLines ?? PREVIEW_LINES,
        options.tailOutput ?? false,
        options.expandHint ?? true,
      );
    }
  }

  private addCommandPreview(command: string, previewLines: number | undefined): void {
    if (command.length === 0) return;
    const allLines = command.split('\n');
    const lines = previewLines === undefined ? allLines : allLines.slice(0, previewLines);
    for (const [i, line] of lines.entries()) {
      // Distinguish the command (input) from the result (output): the `$`
      // prompt uses the dedicated shell-mode hue, the command body uses
      // `textDim`, and the result below is rendered one step dimmer in
      // `textMuted` under the ⎿ gutter so the two stay separable.
      const text =
        i === 0
          ? currentTheme.fg('shellMode', '$ ') + currentTheme.dim(line)
          : `  ${currentTheme.dim(line)}`;
      this.addChild(new Text(text, 2, 0));
    }
  }

  private addResultPreview(
    result: ToolResultBlockData,
    expanded: boolean,
    previewLines: number,
    tailOutput: boolean,
    expandHint: boolean,
  ): void {
    if (!result.output) return;
    this.addChild(
      new GutteredOutputComponent(
        new TruncatedOutputComponent(result.output, {
          expanded,
          isError: result.is_error ?? false,
          maxLines: previewLines,
          tail: tailOutput,
          expandHint,
          color: 'textMuted',
          indent: 0,
        }),
      ),
    );
  }
}

export const shellExecutionResultRenderer: ResultRenderer = (
  _toolCall: ToolCallBlockData,
  result: ToolResultBlockData,
  ctx,
): Component[] => [
  // Result only. The command preview is owned by ToolCallComponent's
  // buildCallPreview across the whole lifecycle (streaming, running, and
  // done); rendering it here too would duplicate the command once the result
  // lands.
  new ShellExecutionComponent({
    result,
    expanded: ctx.expanded,
  }),
];
