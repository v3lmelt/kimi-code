/**
 * Welcome panel shown at the top of the TUI.
 * Renders a round-bordered box in the Claude Code LogoV2 style: the product
 * name + version embedded in the top border rule, a centered bold greeting,
 * a lotus pixel mascot above a random Hasunosora member icon, and dim
 * model / directory lines.
 */

import type { Component } from '@moonshot-ai/pi-tui';
import { truncateToWidth, visibleWidth } from '@moonshot-ai/pi-tui';
import chalk from 'chalk';

import { effectiveModelAlias } from '@moonshot-ai/kimi-code-sdk';

import { providerDisplayName } from '#/tui/components/dialogs/model-selector';
import { HASUNOSORA_MEMBERS, hasunosoraMemberColor, randomHasunosoraMemberIndex } from '#/tui/constant/hasunosora-members';
import { isRainbowDancing, renderDanceWelcomeHeader } from '#/tui/easter-eggs/dance';
import type { AppState } from '#/tui/types';
import { currentTheme } from '#/tui/theme';

/** Lotus pixel mascot (2 rows), painted in the brand primary. */
const MASCOT = [' ▗▄▖▗▄▖', '▝▜▟██▙▛▘'] as const;

export class WelcomeComponent implements Component {
  private state: AppState;
  private memberIndex: number;

  constructor(state: AppState, memberIndex?: number) {
    this.state = state;
    this.memberIndex = memberIndex ?? randomHasunosoraMemberIndex();
  }

  invalidate(): void {}

  render(width: number): string[] {
    const safeWidth = Math.max(0, width);
    const primary = (s: string): string => chalk.hex(currentTheme.palette.primary)(s);
    const isLoggedOut = !this.state.model;
    const activeModel = this.state.availableModels[this.state.model];
    const effectiveActiveModel = activeModel === undefined ? undefined : effectiveModelAlias(activeModel);

    if (safeWidth < 24) {
      const title = chalk.bold.hex(currentTheme.palette.primary)('Welcome to Hasu!');
      const prompt = isLoggedOut
        ? chalk.hex(currentTheme.palette.warning)('Run /login or /provider to get started.')
        : chalk.hex(currentTheme.palette.textDim)('Send /help for help information.');
      const model = isLoggedOut
        ? chalk.hex(currentTheme.palette.warning)('not set, run /login or /provider')
        : (effectiveActiveModel?.displayName ?? effectiveActiveModel?.model ?? this.state.model);
      return ['', title, prompt, `Model: ${model}`].map((line) =>
        truncateToWidth(line, safeWidth, '…'),
      );
    }

    const innerWidth = Math.max(1, safeWidth - 4);
    const pad = '  ';

    const dim = chalk.hex(currentTheme.palette.textDim);
    const center = (line: string): string => {
      const left = Math.max(0, Math.floor((innerWidth - visibleWidth(line)) / 2));
      return ' '.repeat(left) + line;
    };

    // textWidth/rightRow1 only feed the dance easter-egg header, which draws
    // the mascot and the rainbow title side by side.
    const mascotWidth = Math.max(...MASCOT.map((row) => visibleWidth(row)));
    const gap = '  ';
    const textWidth = Math.max(4, innerWidth - mascotWidth - gap.length);
    const rightRow1 = truncateToWidth(
      dim(isLoggedOut ? 'Run /login or /provider to get started.' : 'Send /help for help information.'),
      textWidth,
      '…',
    );

    // Claude Code style header: centered greeting above the pixel mascot —
    // the Hasunosora lotus over this launch's random member icon.
    const member = HASUNOSORA_MEMBERS[this.memberIndex]!;
    const memberStyle = chalk.hex(hasunosoraMemberColor(member, currentTheme.palette.text));
    let contentLines = [
      center(currentTheme.bold('Welcome back!')),
      '',
      center(primary(MASCOT[0])),
      center(primary(MASCOT[1])),
      '',
      ...member.icon.map((row) => center(memberStyle(row))),
      center(memberStyle(member.name)),
    ];
    if (isRainbowDancing()) {
      contentLines = renderDanceWelcomeHeader(MASCOT, textWidth, rightRow1);
    }

    const modelValue = isLoggedOut
      ? chalk.hex(currentTheme.palette.warning)('not set, run /login or /provider')
      : (effectiveActiveModel?.displayName ?? effectiveActiveModel?.model ?? this.state.model);
    const providerName =
      effectiveActiveModel?.provider === undefined
        ? ''
        : providerDisplayName(effectiveActiveModel.provider);
    const modelLine = isLoggedOut
      ? modelValue
      : dim(providerName ? `${modelValue} · ${providerName}` : modelValue);

    contentLines.push('', center(modelLine), center(dim(this.state.workDir)));

    // Top rule carries the border title: ' Hasu ' in the brand primary
    // followed by the dim version, mirroring Claude Code's LogoV2 box.
    let borderTitle = primary(' Hasu ') + dim(` v${this.state.version} `);
    if (visibleWidth(borderTitle) > safeWidth - 5) {
      borderTitle = primary(' Hasu ');
    }
    const titleDashCount = Math.max(0, safeWidth - 3 - visibleWidth(borderTitle));

    const lines: string[] = [
      '',
      primary('╭─') + borderTitle + primary('─'.repeat(titleDashCount)) + primary('╮'),
      primary('│') + ' '.repeat(safeWidth - 2) + primary('│'),
    ];

    for (const content of contentLines) {
      const truncated = truncateToWidth(content, innerWidth, '…');
      const vis = visibleWidth(truncated);
      const rightPad = Math.max(0, innerWidth - vis);
      lines.push(primary('│') + pad + truncated + ' '.repeat(rightPad) + primary('│'));
    }

    lines.push(primary('│') + ' '.repeat(safeWidth - 2) + primary('│'));
    lines.push(primary('╰' + '─'.repeat(safeWidth - 2) + '╯'));
    lines.push('');

    return lines.map((line) => truncateToWidth(line, safeWidth, '…'));
  }
}
