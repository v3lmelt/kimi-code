import { ChoicePickerComponent, type ChoiceOption } from './choice-picker';

const THINKING_DISPLAY_OPTIONS: readonly ChoiceOption[] = [
  {
    value: 'show',
    label: 'Show',
    description: 'Render the model reasoning inline in the transcript.',
  },
  {
    value: 'hide',
    label: 'Hide',
    description: 'Collapse thinking blocks to a single "∴ Thinking…" indicator (ctrl+o to expand).',
  },
];

export interface ThinkingDisplaySelectorOptions {
  readonly currentValue: boolean;
  readonly onSelect: (hideThinking: boolean) => void;
  readonly onCancel: () => void;
}

export class ThinkingDisplaySelectorComponent extends ChoicePickerComponent {
  constructor(opts: ThinkingDisplaySelectorOptions) {
    super({
      title: 'Thinking display',
      options: [...THINKING_DISPLAY_OPTIONS],
      currentValue: opts.currentValue ? 'hide' : 'show',
      onSelect: (value) => {
        opts.onSelect(value === 'hide');
      },
      onCancel: opts.onCancel,
    });
  }
}
