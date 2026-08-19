/**
 * TabbedModelSelectorComponent — a thin wrapper around ModelSelectorComponent
 * that splits the model list into per-provider tabs.
 *
 * Tabs are derived from the `models` passed at construction time:
 *   ['all', ...uniqueProviderIds]   (insertion order, deduplicated)
 *
 * Each tab owns its own inner ModelSelectorComponent built from the filtered
 * subset of models. ↑/↓/Enter/Esc/←/→ (thinking) and typing (filter) are
 * forwarded to the active inner selector; Tab / Shift-Tab cycle between tabs.
 *
 * The active tab is highlighted with a filled background (matching the
 * AskUserQuestion dialog's tab strip) — see .agents/skills/write-tui/DESIGN.md.
 */

import type { ModelAlias } from '@moonshot-ai/kimi-code-sdk';
import {
  Container,
  Key,
  matchesKey,
  truncateToWidth,
  type Focusable,
} from '@moonshot-ai/pi-tui';

import { currentTheme } from '#/tui/theme';
import { renderTabStrip } from '#/tui/utils/tab-strip';

import {
  ModelSelectorComponent,
  providerDisplayName,
  type ModelSelection,
  type ModelSelectorOptions,
} from './model-selector';

const ALL_TAB_ID = 'all';
const ALL_TAB_LABEL = 'All';

export interface TabbedModelSelectorOptions {
  readonly models: Record<string, ModelAlias>;
  readonly currentValue: string;
  readonly selectedValue?: string;
  readonly currentThinkingEffort: string;
  /** Forwarded to each inner selector; overrides the default ' Select a model'
   * title line (e.g. the secondary-model picker). */
  readonly title?: string;
  /** When set, the tab for this provider id is initially active instead of the
   * tab derived from `currentValue`. */
  readonly initialTabId?: string;
  /** Forwarded to each inner selector; when set, warning-colored lines are
   * rendered directly below the key-hint line, wrapping as needed (e.g. the
   * mid-conversation switch cost notice). */
  readonly warning?: string;
  readonly onSelect: (selection: ModelSelection) => void;
  /** Forwarded to each inner selector; when set, Alt+S applies the choice to
   * the current session only without persisting it as the default. */
  readonly onSessionOnlySelect?: (selection: ModelSelection) => void;
  readonly onCancel: () => void;
}

interface ModelTab {
  readonly id: string;
  readonly label: string;
  /** Models offered under this tab (identity shared with the All tab, never
   * copied per tab so tab switches cannot duplicate rows). */
  readonly models: Record<string, ModelAlias>;
}

export class TabbedModelSelectorComponent extends Container implements Focusable {
  focused = false;
  private readonly opts: TabbedModelSelectorOptions;
  private readonly tabs: readonly ModelTab[];
  /** Selector for the active tab, rebuilt on each tab switch. The previous
   *  selector is dropped — its per-alias effective-model memoization cannot
   *  be shared across tabs — which keeps construction cost proportional to
   *  the models a user actually sees instead of 1 + providers × the list. */
  private activeSelector: ModelSelectorComponent;
  private activeIndex: number;

  constructor(opts: TabbedModelSelectorOptions) {
    super();
    this.opts = opts;
    this.tabs = buildTabs(opts);

    // Default to the "All" tab. Only an explicit initialTabId (e.g. the
    // provider just added via /provider) opens on a specific provider tab —
    // the current model is still highlighted inside whichever tab is active.
    const initialTabIdx = opts.initialTabId
      ? this.tabs.findIndex((tab) => tab.id === opts.initialTabId)
      : -1;
    this.activeIndex = Math.max(initialTabIdx, 0);
    this.activeSelector = makeSelector(opts, this.tabs[this.activeIndex]!.models);
    this.syncFocusToActive();
  }

  handleInput(data: string): void {
    if (this.tabs.length > 1) {
      if (matchesKey(data, Key.tab)) {
        this.switchToTab((this.activeIndex + 1) % this.tabs.length);
        return;
      }
      if (matchesKey(data, Key.shift('tab'))) {
        this.switchToTab((this.activeIndex - 1 + this.tabs.length) % this.tabs.length);
        return;
      }
    }
    this.activeSelector.handleInput(data);
    // The active selector is not registered as a child (render() composes it
    // manually), so its bump() never reaches this component — bump here or a
    // parent container would keep serving its cached lines.
    this.bump();
  }

  override render(width: number): string[] {
    const active = this.tabs[this.activeIndex];
    if (active === undefined) return [];
    const inner = this.activeSelector.render(width);
    if (this.tabs.length <= 1) {
      return inner.map((line) => truncateToWidth(line, width));
    }
    // Layout: divider, title, hint, optional warning, blank, tab strip, blank,
    // then the model list. The header ends at its first blank line — keep that
    // blank above the strip, and separate the tabs from the list with another
    // blank.
    const stripLine = renderTabStrip({
      labels: this.tabs.map((tab) => tab.label),
      activeIndex: this.activeIndex,
      width,
      colors: currentTheme.palette,
    });
    const headerEnd = inner.findIndex((line) => line === '');
    const splitAt = headerEnd === -1 ? 3 : headerEnd;
    const out: string[] = [...inner.slice(0, splitAt + 1), stripLine, ''];
    for (let i = splitAt + 1; i < inner.length; i++) out.push(inner[i]!);
    return out.map((line) => truncateToWidth(line, width));
  }

  override invalidate(): void {
    super.invalidate();
    this.activeSelector.invalidate();
  }

  private switchToTab(index: number): void {
    if (index === this.activeIndex) return;
    this.activeIndex = index;
    this.activeSelector = makeSelector(this.opts, this.tabs[index]!.models);
    this.syncFocusToActive();
    this.bump();
  }

  private syncFocusToActive(): void {
    this.activeSelector.focused = this.focused;
  }
}

function buildTabs(opts: TabbedModelSelectorOptions): readonly ModelTab[] {
  const entries = Object.entries(opts.models);
  const providerIds: string[] = [];
  const seen = new Set<string>();
  for (const [, model] of entries) {
    const provider = model.provider;
    if (!seen.has(provider)) {
      seen.add(provider);
      providerIds.push(provider);
    }
  }

  const tabs: ModelTab[] = [{ id: ALL_TAB_ID, label: ALL_TAB_LABEL, models: opts.models }];
  for (const providerId of providerIds) {
    const subset: Record<string, ModelAlias> = {};
    for (const [alias, model] of entries) {
      if (model.provider === providerId) subset[alias] = model;
    }
    tabs.push({
      id: providerId,
      label: providerDisplayName(providerId),
      models: subset,
    });
  }
  return tabs;
}

function makeSelector(
  opts: TabbedModelSelectorOptions,
  subset: Record<string, ModelAlias>,
): ModelSelectorComponent {
  const candidate = opts.selectedValue ?? opts.currentValue;
  const selectedValue = subset[candidate] !== undefined ? candidate : undefined;
  const inner: ModelSelectorOptions = {
    models: subset,
    currentValue: opts.currentValue,
    ...(selectedValue !== undefined ? { selectedValue } : {}),
    currentThinkingEffort: opts.currentThinkingEffort,
    title: opts.title,
    searchable: true,
    providerSwitchHint: true,
    warning: opts.warning,
    onSelect: opts.onSelect,
    onSessionOnlySelect: opts.onSessionOnlySelect,
    onCancel: opts.onCancel,
  };
  return new ModelSelectorComponent(inner);
}
