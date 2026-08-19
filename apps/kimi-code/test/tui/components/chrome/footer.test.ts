import chalk from 'chalk';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { FooterComponent } from '#/tui/components/chrome/footer';
import { setRainbowDance, type RainbowDanceController } from '#/tui/easter-eggs/dance';
import { currentTheme, darkColors, lightColors } from '#/tui/theme';
import type { ModelAlias } from '@moonshot-ai/kimi-code-sdk';
import type { AppState } from '#/tui/types';
import { QuotaRunner } from '#/tui/utils/quota-runner';

const TRUECOLOR_PATTERN = /\[38;2;(\d+);(\d+);(\d+)m/g;

function truecolorCodes(text: string): Set<string> {
  const codes = new Set<string>();
  for (const match of text.matchAll(TRUECOLOR_PATTERN)) {
    codes.add(`${match[1]},${match[2]},${match[3]}`);
  }
  return codes;
}

// Dark dance colors the footer never uses outside of /dance.
const RAINBOW_CYAN = '91,192,190';
const RAINBOW_GREEN = '78,200,126';

function setDanceView(colored: boolean, phase: number): void {
  const dance: RainbowDanceController = {
    colored,
    phase,
    start: () => {},
    stop: () => {},
    dispose: () => {},
  };
  setRainbowDance(dance);
}

const appState: AppState = {
  version: '1.2.3',
  workDir: '/tmp/project',
  additionalDirs: [],
  sessionId: 'ses-1',
  sessionTitle: null,
  model: 'kimi-k2',
  permissionMode: 'manual',
  thinkingEffort: 'off',
  contextUsage: 0,
  contextTokens: 0,
  maxContextTokens: 0,
  isCompacting: false,
  isReplaying: false,
  streamingPhase: 'idle',
  streamingStartTime: 0,
  planMode: false,
  inputMode: 'prompt',
  swarmMode: false,
  theme: 'dark',
  editorCommand: null,
  notifications: { enabled: true, condition: 'unfocused' },
  upgrade: { autoInstall: true },
  availableModels: {},
  availableProviders: {},
  mcpServersSummary: null,
  workflowRuns: [],
};

describe('FooterComponent', () => {
  const previousChalkLevel = chalk.level;

  beforeEach(() => {
    chalk.level = 3;
  });

  afterEach(() => {
    chalk.level = previousChalkLevel;
    setRainbowDance(undefined);
  });

  it('paints the model name in rainbow while colored', () => {
    setDanceView(true, 0);
    const footer = new FooterComponent(appState);

    const codes = truecolorCodes(footer.render(120).join('\n'));

    // "kimi-k2" spreads across the palette, pulling in colors the footer
    // never renders on its own.
    expect(codes.has(RAINBOW_CYAN)).toBe(true);
    expect(codes.has(RAINBOW_GREEN)).toBe(true);
  });

  it('renders the model name in its normal color when not dancing', () => {
    const footer = new FooterComponent(appState);

    const codes = truecolorCodes(footer.render(120).join('\n'));

    expect(codes.has(RAINBOW_CYAN)).toBe(false);
    expect(codes.has(RAINBOW_GREEN)).toBe(false);
  });

  it('repaints from the active palette on the next render (no setColors needed)', () => {
    const footer = new FooterComponent(appState);
    const before = footer.render(120).join('\n');

    currentTheme.setPalette(lightColors);
    try {
      const after = footer.render(120).join('\n');
      // Reads currentTheme live, so a palette swap changes the emitted colours.
      expect(after).not.toBe(before);
    } finally {
      currentTheme.setPalette(darkColors);
    }
  });

  it('shows the effort for an effort-capable model', () => {
    const effortModel: ModelAlias = {
      provider: 'managed:kimi-code',
      model: 'kimi-k2',
      maxContextSize: 262144,
      supportEfforts: ['low', 'high', 'max'],
      defaultEffort: 'high',
    };
    const state: AppState = {
      ...appState,
      thinkingEffort: 'max',
      availableModels: { 'kimi-k2': effortModel },
    };
    const footer = new FooterComponent(state);

    expect(footer.render(120).join('\n')).toContain('kimi-k2 max');
  });

  it('does not show the effort for a legacy boolean model', () => {
    const plainModel: ModelAlias = {
      provider: 'managed:kimi-code',
      model: 'kimi-k2',
      maxContextSize: 262144,
      capabilities: ['thinking'],
    };
    const state: AppState = {
      ...appState,
      thinkingEffort: 'high',
      availableModels: { 'kimi-k2': plainModel },
    };
    const footer = new FooterComponent(state);
    const rendered = footer.render(120).join('\n');

    expect(rendered).toContain('thinking');
    expect(rendered).not.toContain('thinking:high');
  });

  it('keeps mode/goal/model on line 1, wraps the rest to line 2, and omits cwd/git', () => {
    const state: AppState = {
      ...appState,
      permissionMode: 'yolo',
      sessionCacheUsage: { inputOther: 30, inputCacheRead: 62, inputCacheCreation: 8 },
    };
    const footer = new FooterComponent(state);
    const lines = footer.render(120);

    expect(lines[0]).toContain('bypass permissions on');
    expect(lines[0]).toContain('kimi-k2');
    expect(lines[0]).not.toContain('context');
    expect(lines[1]).toContain('cache 62%');
    expect(lines[1]).not.toContain('/tmp/project');
  });

  it('shows cwd/git again when explicitly configured via status_line items', () => {
    const state: AppState = {
      ...appState,
      sessionCacheUsage: { inputOther: 30, inputCacheRead: 62, inputCacheCreation: 8 },
      statusLine: { items: ['mode', 'goal', 'model', 'cwd', 'git'], command: null },
    };
    const footer = new FooterComponent(state);
    const lines = footer.render(120);

    expect(lines[0]).toContain('kimi-k2');
    expect(lines[1]).toContain('/tmp/project');
  });
});

describe('FooterComponent overrides', () => {
  it('shows the overridden effort list', () => {
    const effortModelWithOverride: ModelAlias = {
      provider: 'managed:kimi-code',
      model: 'kimi-k2',
      maxContextSize: 262144,
      supportEfforts: ['low', 'high', 'max'],
      defaultEffort: 'max',
      overrides: { supportEfforts: ['low', 'high'], defaultEffort: 'high' },
    };
    const state: AppState = {
      ...appState,
      thinkingEffort: 'high',
      availableModels: { 'kimi-k2': effortModelWithOverride },
    };
    const footer = new FooterComponent(state);

    expect(footer.render(120).join('\n')).toContain('kimi-k2 high');
  });
});

describe('FooterComponent displayName override', () => {
  it('renders the overridden display name', () => {
    const state: AppState = {
      ...appState,
      model: 'kimi-k2',
      availableModels: {
        'kimi-k2': {
          provider: 'managed:kimi-code',
          model: 'kimi-k2',
          maxContextSize: 262144,
          displayName: 'Remote Name',
          overrides: { displayName: 'Custom Name' },
        },
      },
    };
    const footer = new FooterComponent(state);

    expect(footer.render(120).join('\n')).toContain('Custom Name');
    expect(footer.render(120).join('\n')).not.toContain('Remote Name');
  });
});

describe('FooterComponent quota slot', () => {
  const GO_MODEL: ModelAlias = {
    provider: 'opencode-go',
    model: 'deepseek-v4-flash',
    maxContextSize: 262144,
  };

  it('renders compact quota rows for an opencode-go provider with a snapshot', async () => {
    const state: AppState = {
      ...appState,
      model: 'go-flash',
      availableModels: { 'go-flash': GO_MODEL },
    };
    const footer = new FooterComponent(state);
    const runner = new QuotaRunner(
      async () => ({
        rows: [
          {
            used: 14,
            limit: 100,
            resetAt: new Date(Date.now() + 4.5 * 3600_000).toISOString(),
            duration: 5,
            unit: 'hour',
          },
          {
            used: 3,
            limit: 100,
            resetAt: new Date(Date.now() + 6 * 86_400_000).toISOString(),
            duration: 1,
            unit: 'week',
          },
        ],
      }),
      () => {},
    );
    footer.setQuotaRunner(runner);
    try {
      await vi.waitFor(() => {
        expect(runner.current()).not.toBeNull();
      });
      const output = footer.render(120).join('\n');
      expect(output).toContain('◱ 14% (');
      expect(output).toContain('◑ 3% (');
    } finally {
      footer.dispose();
    }
  });

  it('renders quota rows for the kimi managed provider', async () => {
    const state: AppState = {
      ...appState,
      model: 'kimi-k2',
      availableModels: {
        'kimi-k2': { provider: 'managed:kimi-code', model: 'kimi-k2', maxContextSize: 262144 },
      },
    };
    const footer = new FooterComponent(state);
    const runner = new QuotaRunner(
      async () => ({
        rows: [
          { used: 0, limit: 100, duration: 5, unit: 'hour' },
          {
            used: 89,
            limit: 100,
            resetAt: new Date(Date.now() + 3 * 86_400_000).toISOString(),
            duration: 1,
            unit: 'week',
          },
        ],
      }),
      () => {},
    );
    footer.setQuotaRunner(runner);
    try {
      await vi.waitFor(() => {
        expect(runner.current()).not.toBeNull();
      });
      const output = footer.render(120).join('\n');
      expect(output).toContain('◱ 0%');
      expect(output).toContain('◑ 89% (');
    } finally {
      footer.dispose();
    }
  });

  it('hides the quota slot for providers without quota data', async () => {
    const footer = new FooterComponent(appState); // no availableModels → provider undefined
    const runner = new QuotaRunner(async () => ({ rows: [{ used: 14, limit: 100 }] }), () => {});
    footer.setQuotaRunner(runner);
    try {
      await vi.waitFor(() => {
        expect(runner.current()).not.toBeNull();
      });
      const output = footer.render(120).join('\n');
      expect(output).not.toContain('◱');
      expect(output).not.toContain('◑');
    } finally {
      footer.dispose();
    }
  });

  it('hides the quota slot until the runner lands a snapshot', () => {
    const state: AppState = {
      ...appState,
      model: 'go-flash',
      availableModels: { 'go-flash': GO_MODEL },
    };
    const footer = new FooterComponent(state);
    const runner = new QuotaRunner(async () => ({ rows: [] }), () => {});
    footer.setQuotaRunner(runner);
    try {
      // Render synchronously before the async loader resolves.
      const output = footer.render(120).join('\n');
      expect(output).not.toContain('◱');
    } finally {
      footer.dispose();
    }
  });

  it('never renders the quota slot when the snapshot has no rows', async () => {
    const state: AppState = {
      ...appState,
      model: 'go-flash',
      availableModels: { 'go-flash': GO_MODEL },
    };
    const footer = new FooterComponent(state);
    const runner = new QuotaRunner(async () => ({ rows: [] }), () => {});
    footer.setQuotaRunner(runner);
    try {
      await vi.waitFor(() => {
        expect(runner.current()).not.toBeNull();
      });
      const output = footer.render(120).join('\n');
      expect(output).not.toContain('◱');
      expect(output).not.toContain('◑');
    } finally {
      footer.dispose();
    }
  });
});

describe('FooterComponent cache slot', () => {
  it('renders the session cache hit rate from accumulated usage', () => {
    const state: AppState = {
      ...appState,
      sessionCacheUsage: { inputOther: 30, inputCacheRead: 62, inputCacheCreation: 8 },
    };
    const footer = new FooterComponent(state);

    const output = footer.render(120).join('\n');
    expect(output).toContain('cache 62%');
  });

  it('hides the cache slot until a step with exact usage completes', () => {
    const footer = new FooterComponent(appState);

    expect(footer.render(120).join('\n')).not.toContain('cache');
  });

  it('hides the cache slot when no input tokens were observed', () => {
    const state: AppState = {
      ...appState,
      sessionCacheUsage: { inputOther: 0, inputCacheRead: 0, inputCacheCreation: 0 },
    };
    const footer = new FooterComponent(state);

    expect(footer.render(120).join('\n')).not.toContain('cache');
  });
});
