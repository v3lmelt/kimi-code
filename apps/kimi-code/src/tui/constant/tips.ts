export interface ToolbarTip {
  readonly text: string;
  /**
   * Long/important tips render on their own. They never pair with a
   * neighbour and never appear as the second half of someone else's pair.
   */
  readonly solo?: boolean;
  /**
   * Rotation weight: a higher value makes the tip recur more often. Defaults
   * to 1. Used to give newer/important features more airtime.
   */
  readonly priority?: number;
}

/**
 * Subset of toolbar tips shown behind the composing spinner.
 */
export const WORKING_TIPS: readonly ToolbarTip[] = [
  { text: 'esc to interrupt', priority: 2 },
  { text: 'ctrl+s to add guidance without waiting for the turn to finish', priority: 2, solo: true },
  { text: 'ctrl+o for verbose output', priority: 2 },
  { text: 'ctrl+t to toggle todos', priority: 2 },
  { text: '@ for file paths', priority: 2 },
  { text: '! for bash mode', priority: 2 },
  { text: '/ for commands', priority: 2 },
  { text: '/tasks to check progress and status for background tasks', priority: 2 },
  { text: '/init to generate an AGENTS.md', priority: 2 },
  {
    text: '/plugins to manage plugins — try the "Kimi Datasource" for reliable financial, economic, and academic data',
    solo: true,
    priority: 3,
  },
  { text: 'ask Kimi to schedule tasks, e.g. "remind me at 5pm"', solo: true, priority: 3 },
  { text: '/sessions to browse and resume earlier sessions', solo: true },
  { text: '/goal for multi-step work with a clear finish line', priority: 2, solo: true },
  { text: '/goal next to queue follow-up work while the current goal keeps running', solo: true },
  { text: '/web to use the Web UI for a better experience', solo: true },
];

export const ALL_TIPS: readonly ToolbarTip[] = [
  ...WORKING_TIPS,
  { text: '/help for shortcuts' },
  { text: 'double tap esc to undo' },
  { text: 'shift+tab to toggle plan mode', priority: 2 },
  { text: 'shift+enter for newline' },
  { text: '/theme to switch themes' },
  { text: '/auto when you want Kimi to handle approvals and keep going unattended', solo: true },
  { text: '/yolo to skip most approvals for trusted batch work, only use it in repos you trust', solo: true },
  { text: '/compact to compress context when it gets long', priority: 2 },
  { text: '/model to switch model', priority: 2 },
];
