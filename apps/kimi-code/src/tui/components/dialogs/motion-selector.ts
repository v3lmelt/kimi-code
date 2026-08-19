import { ChoicePickerComponent, type ChoiceOption } from './choice-picker';

const MOTION_OPTIONS: readonly ChoiceOption[] = [
  {
    value: 'full',
    label: 'Full motion',
    description: 'Animate the activity indicator, shimmer, and status transitions.',
  },
  {
    value: 'reduced',
    label: 'Reduced motion',
    description: 'Use a static activity indicator and disable shimmer effects.',
  },
];

export interface MotionSelectorOptions {
  readonly currentValue: boolean;
  readonly onSelect: (reducedMotion: boolean) => void;
  readonly onCancel: () => void;
}

export class MotionSelectorComponent extends ChoicePickerComponent {
  constructor(opts: MotionSelectorOptions) {
    super({
      title: 'Motion',
      options: [...MOTION_OPTIONS],
      currentValue: opts.currentValue ? 'reduced' : 'full',
      onSelect: (value) => {
        opts.onSelect(value === 'reduced');
      },
      onCancel: opts.onCancel,
    });
  }
}
