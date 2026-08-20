import {
  Container,
  Key,
  matchesKey,
  truncateToWidth,
  visibleWidth,
  type Terminal,
  type Focusable,
} from '@moonshot-ai/pi-tui';

import { CURRENT_MARK, SELECT_POINTER } from '@/tui/constant/symbols';
import { currentTheme } from '#/tui/theme';
import { printableChar } from '#/tui/utils/printable-key';
import {
  runtimeCenterActionLabel,
  type RuntimeCenterAction,
  type RuntimeCenterAgent,
  type RuntimeCenterProjection,
  type RuntimeCenterTask,
  type RuntimeCenterView,
  type RuntimeCenterWorkflow,
} from '#/tui/utils/runtime-center-model';
import { SearchableList } from '#/tui/utils/searchable-list';

export interface RuntimeCenterProps {
  readonly view: RuntimeCenterView;
  readonly projection: RuntimeCenterProjection;
  readonly selectedKey: string | undefined;
  readonly flashMessage: string | undefined;
  readonly onSelect: (key: string) => void;
  readonly onViewChange: (view: RuntimeCenterView) => void;
  readonly onRefresh: () => void;
  readonly onCancel: () => void;
  readonly onAction: (action: RuntimeCenterAction, key: string) => void;
  readonly onActionUnavailable: (action: RuntimeCenterAction, key: string, reason: string) => void;
}

type RuntimeCenterItem = RuntimeCenterTask | RuntimeCenterAgent | RuntimeCenterWorkflow;

const VIEWS: readonly RuntimeCenterView[] = ['tasks', 'agents', 'workflows'];
const VIEW_LABELS: Readonly<Record<RuntimeCenterView, string>> = {
  tasks: 'Tasks',
  agents: 'Agents',
  workflows: 'Workflows',
};
const ACTION_KEYS: Readonly<Record<string, RuntimeCenterAction>> = {
  s: 'stop',
  o: 'output',
  r: 'resume',
  y: 'retry',
  m: 'message',
  f: 'followup',
  i: 'interrupt',
  t: 'transcript',
};
const MIN_WIDTH = 56;
const MIN_HEIGHT = 10;
const ELLIPSIS = '…';
const STOP_CONFIRM_TIMEOUT_MS = 5_000;

function itemId(item: RuntimeCenterItem): string {
  return item.key;
}

function itemSearchText(item: RuntimeCenterItem): string {
  return [item.key, itemLabel(item), itemDescription(item), item.status, item.agentId, item.runId]
    .filter((value): value is string => typeof value === 'string')
    .join(' ');
}

function itemLabel(item: RuntimeCenterItem): string {
  if ('treePath' in item) return item.treePath;
  if ('name' in item) return item.name;
  return item.label;
}

function itemDescription(item: RuntimeCenterItem): string {
  if ('treePath' in item) return `${item.status} · ${item.currentActivity}`;
  if ('name' in item) return `${item.status}${item.phase === undefined ? '' : ` · ${item.phase}`}`;
  return `${item.status} · ${item.description}`;
}

function statusColor(status: string): 'success' | 'error' | 'warning' | 'primary' | 'textMuted' {
  switch (status) {
    case 'running':
    case 'completed':
      return status === 'running' ? 'success' : 'textMuted';
    case 'failed':
    case 'timed_out':
    case 'killed':
    case 'lost':
      return 'error';
    case 'waiting':
    case 'queued':
      return 'warning';
    default:
      return 'primary';
  }
}

function fit(line: string, width: number): string {
  const clipped = truncateToWidth(line, Math.max(0, width), ELLIPSIS);
  const remaining = Math.max(0, width - visibleWidth(clipped));
  return clipped + ' '.repeat(remaining);
}

function isTask(item: RuntimeCenterItem): item is RuntimeCenterTask {
  return 'taskId' in item && 'source' in item && 'kind' in item;
}

function isAgent(item: RuntimeCenterItem): item is RuntimeCenterAgent {
  return 'treePath' in item;
}

function isWorkflow(item: RuntimeCenterItem): item is RuntimeCenterWorkflow {
  return 'phases' in item && 'name' in item;
}

export class RuntimeCenterApp extends Container implements Focusable {
  focused = false;

  private props: RuntimeCenterProps;
  private readonly terminal: Terminal;
  private list: SearchableList<RuntimeCenterItem>;
  private pendingStopKey: string | undefined;
  private pendingStopTimer: NodeJS.Timeout | undefined;

  constructor(props: RuntimeCenterProps, terminal: Terminal) {
    super();
    this.props = props;
    this.terminal = terminal;
    this.list = this.createList(props);
  }

  setProps(next: RuntimeCenterProps): void {
    this.props = next;
    const selectedIndex = this.currentItems(next).findIndex((item) => item.key === next.selectedKey);
    this.list = this.createList(next, Math.max(0, selectedIndex));
    if (
      this.pendingStopKey !== undefined &&
      !this.currentItems(next).some((item) => item.key === this.pendingStopKey)
    ) {
      this.clearPendingStop();
    }
    this.invalidate();
  }

  handleInput(data: string): void {
    const character = printableChar(data);
    if (this.pendingStopKey !== undefined) {
      if (character === 'y' || character === 'Y') {
        const key = this.pendingStopKey;
        this.clearPendingStop();
        this.props.onAction('stop', key);
        this.invalidate();
        return;
      }
      // Confirmation consumes every non-Y key, including Esc, so an
      // accidental key cannot both cancel the confirm and close the center.
      this.clearPendingStop();
      this.invalidate();
      return;
    }
    if (matchesKey(data, Key.escape)) {
      this.props.onCancel();
      return;
    }
    if (matchesKey(data, Key.tab) || character === '\t') {
      const index = VIEWS.indexOf(this.props.view);
      this.props.onViewChange(VIEWS[(index + 1) % VIEWS.length] ?? 'tasks');
      return;
    }
    if (character === 'R' || character === 'r') {
      this.props.onRefresh();
      return;
    }
    if (this.list.handleKey(data)) {
      const selected = this.list.selected();
      if (selected !== undefined) this.props.onSelect(itemId(selected));
      this.invalidate();
      return;
    }
    const key = character.toLowerCase();
    if (matchesKey(data, Key.enter)) {
      const selected = this.list.selected();
      if (selected !== undefined) this.openPrimaryAction(selected);
      return;
    }
    const action = ACTION_KEYS[key];
    if (action === undefined) return;
    const selected = this.list.selected();
    if (selected === undefined) return;
    const availability = selected.actions[action];
    if (!availability.enabled) {
      this.props.onActionUnavailable(action, selected.key, availability.reason ?? 'This action is unavailable.');
      return;
    }
    if (action === 'stop') {
      this.beginStopConfirmation(selected.key);
      return;
    }
    this.props.onAction(action, selected.key);
  }

  override render(width: number): string[] {
    const rows = Math.max(1, this.terminal.rows);
    if (width < MIN_WIDTH || rows < MIN_HEIGHT) return this.renderTooSmall(width, rows);
    const header = this.renderHeader(width);
    const footer = this.renderFooter(width);
    const bodyHeight = Math.max(1, rows - 2);
    const listWidth = Math.max(30, Math.min(48, Math.floor(width * 0.42)));
    const detailWidth = Math.max(1, width - listWidth);
    const listLines = this.renderList(listWidth, bodyHeight);
    const detailLines = this.renderDetail(detailWidth, bodyHeight);
    const lines = [header];
    for (let i = 0; i < bodyHeight; i += 1) {
      lines.push(fit(listLines[i] ?? '', listWidth) + fit(detailLines[i] ?? '', detailWidth));
    }
    lines.push(footer);
    return lines.map((line) => fit(line, width));
  }

  private createList(props: RuntimeCenterProps, initialIndex = 0): SearchableList<RuntimeCenterItem> {
    return new SearchableList({
      items: this.currentItems(props),
      toSearchText: itemSearchText,
      initialIndex,
      searchable: false,
      onChange: () => this.bump(),
    });
  }

  private currentItems(props: RuntimeCenterProps): readonly RuntimeCenterItem[] {
    switch (props.view) {
      case 'tasks': return props.projection.tasks;
      case 'agents': return props.projection.agents;
      case 'workflows': return props.projection.workflows;
    }
  }

  private selectedItem(): RuntimeCenterItem | undefined {
    return this.list.selected();
  }

  private openPrimaryAction(item: RuntimeCenterItem): void {
    // Enter on a task or agent opens the owning background task output. An
    // agent without that mapping remains disabled instead of pretending that
    // a transcript lookup exists.
    const action: RuntimeCenterAction = isTask(item) || isAgent(item) ? 'output' : 'transcript';
    const availability = item.actions[action];
    if (availability.enabled) this.props.onAction(action, item.key);
    else this.props.onActionUnavailable(action, item.key, availability.reason ?? 'This action is unavailable.');
  }

  private beginStopConfirmation(key: string): void {
    this.clearPendingStop();
    this.pendingStopKey = key;
    this.pendingStopTimer = setTimeout(() => {
      this.clearPendingStop();
      this.invalidate();
    }, STOP_CONFIRM_TIMEOUT_MS);
    this.invalidate();
  }

  private clearPendingStop(): void {
    this.pendingStopKey = undefined;
    if (this.pendingStopTimer !== undefined) {
      clearTimeout(this.pendingStopTimer);
      this.pendingStopTimer = undefined;
    }
  }

  private renderHeader(width: number): string {
    const tabs = VIEWS.map((view) => {
      const selected = view === this.props.view;
      const marker = selected ? CURRENT_MARK : ' ';
      const label = `${marker} ${VIEW_LABELS[view]}`;
      return selected ? currentTheme.boldFg('primary', label) : currentTheme.fg('textMuted', label);
    }).join('  ');
    const counts = ` ${this.props.projection.tasks.length} tasks · ${this.props.projection.agents.length} agents · ${this.props.projection.workflows.length} workflows`;
    return fit(currentTheme.boldFg('primary', ' RUNTIME CENTER ') + tabs + currentTheme.fg('textDim', counts), width);
  }

  private renderFooter(width: number): string {
    const hint = currentTheme.fg(
      'textMuted',
      this.pendingStopKey === undefined
        ? ' ↑↓ select · Tab view · S stop · O/Enter output · R refresh · Esc cancel'
        : ` Stop ${this.pendingStopKey}? Y confirm · N/Esc cancel`,
    );
    if (this.props.flashMessage !== undefined && this.props.flashMessage.length > 0) {
      const flash = currentTheme.fg('warning', ` ${this.props.flashMessage} `);
      if (visibleWidth(hint) + visibleWidth(flash) <= width) return hint + ' '.repeat(width - visibleWidth(hint) - visibleWidth(flash)) + flash;
    }
    return fit(hint, width);
  }

  private renderList(width: number, height: number): string[] {
    const view = this.list.view();
    const lines = [currentTheme.fg('primary', `┌─ ${VIEW_LABELS[this.props.view]} ─` + '─'.repeat(Math.max(0, width - VIEW_LABELS[this.props.view].length - 5)) + '┐')];
    const contentHeight = Math.max(0, height - 2);
    if (view.items.length === 0) lines.push(currentTheme.fg('textMuted', `  No ${this.props.view} recorded.`));
    for (let i = view.page.start; i < view.page.end; i += 1) {
      const item = view.items[i];
      if (item === undefined) continue;
      const selected = i === view.selectedIndex;
      const pointer = selected ? SELECT_POINTER : ' ';
      const status = currentTheme.fg(statusColor(item.status), item.status);
      lines.push(fit(` ${currentTheme.fg(selected ? 'primary' : 'textDim', pointer)} ${selected ? currentTheme.boldFg('textStrong', itemLabel(item)) : currentTheme.fg('text', itemLabel(item))}  ${status}`, width - 2));
    }
    const more = view.items.length - view.page.end;
    if (more > 0) {
      lines.push(currentTheme.fg('textMuted', `  ▼ ${String(more)} more`));
    } else if (view.page.start > 0) {
      lines.push(currentTheme.fg('textMuted', `  ▲ ${String(view.page.start)} above`));
    }
    while (lines.length < contentHeight + 1) lines.push('');
    lines.push(currentTheme.fg('primary', '└' + '─'.repeat(Math.max(0, width - 2)) + '┘'));
    return lines.slice(0, height).map((line) => currentTheme.fg('primary', '│') + fit(line, width - 2) + currentTheme.fg('primary', '│'));
  }

  private renderDetail(width: number, height: number): string[] {
    const selected = this.selectedItem();
    const lines = [currentTheme.fg('primary', `┌─ Detail ` + '─'.repeat(Math.max(0, width - 11)) + '┐')];
    if (selected === undefined) {
      lines.push(currentTheme.fg('textMuted', '  Select an item to inspect its runtime identity.'));
    } else {
      lines.push(...this.detailLines(selected));
    }
    while (lines.length < height - 1) lines.push('');
    lines.push(currentTheme.fg('primary', '└' + '─'.repeat(Math.max(0, width - 2)) + '┘'));
    return lines.slice(0, height).map((line) => currentTheme.fg('primary', '│') + fit(line, width - 2) + currentTheme.fg('primary', '│'));
  }

  private detailLines(item: RuntimeCenterItem): string[] {
    const label = (name: string): string => currentTheme.fg('textMuted', `${name.padEnd(15)} `);
    const value = (text: string | undefined): string => currentTheme.fg('text', text ?? 'unavailable');
    const lines = [
      `${label('Task ID:')}${value(item.taskId)}`,
      `${label('Run ID:')}${value(item.runId)}`,
      `${label('Agent ID:')}${value(item.agentId)}`,
      `${label('Task path:')}${value(item.taskPath)}`,
      `${label('DAG node:')}${value(item.nodeId)}`,
      `${label('Status:')}${currentTheme.fg(statusColor(item.status), item.status)}`,
      `${label('Activity:')}${value(itemDescription(item))}`,
    ];
    if (isTask(item)) {
      lines.push(`${label('Model:')}${value(item.model)}`);
      lines.push(`${label('Usage:')}${value(item.usageTokens === undefined ? undefined : `${String(item.usageTokens)} tokens`)}`);
      lines.push(`${label('Duration:')}${value(item.durationMs === undefined ? undefined : `${String(item.durationMs)} ms`)}`);
      lines.push(`${label('Cache:')}${value(item.cache ?? (item.replayed === true ? 'replayed' : undefined))}`);
      lines.push(`${label('Isolation:')}${value(item.isolationLease ?? item.worktreePath)}`);
    } else if (isAgent(item)) {
      lines.push(`${label('Parent:')}${value(item.parentAgentId)}`);
      lines.push(`${label('Workspace:')}${value(item.workspaceMode)}`);
    } else if (isWorkflow(item)) {
      lines.push(`${label('Phases:')}${value(item.phases.length === 0 ? undefined : item.phases.join(' → '))}`);
      lines.push(`${label('Nodes:')}${value(item.nodes.length === 0 ? undefined : item.nodes.map((node) => `${node.nodeId}:${node.status}`).join(', '))}`);
      lines.push(`${label('Depends on:')}${value(item.dependencies.length === 0 ? undefined : item.dependencies.join(', '))}`);
      lines.push(`${label('Model:')}${value(item.model)}`);
      lines.push(`${label('Usage:')}${value(item.usageTokens === undefined ? undefined : `${String(item.usageTokens)} tokens`)}`);
      lines.push(`${label('Duration:')}${value(item.durationMs === undefined ? undefined : `${String(item.durationMs)} ms`)}`);
      lines.push(`${label('Cache:')}${value(item.cache ?? (item.replayed === true ? 'replayed' : undefined))}`);
      lines.push(`${label('Isolation:')}${value(item.isolationLease ?? item.worktreePath)}`);
    }
    const actions = (Object.keys(item.actions) as RuntimeCenterAction[]).filter((actionName) => item.actions[actionName].enabled);
    lines.push(`${label('Actions:')}${value(actions.length === 0 ? 'none' : actions.map(runtimeCenterActionLabel).join(', '))}`);
    const disabled = (Object.keys(item.actions) as RuntimeCenterAction[]).find((actionName) => !item.actions[actionName].enabled && item.actions[actionName].reason !== undefined);
    if (disabled !== undefined) lines.push(`${label('Unavailable:')}${value(item.actions[disabled].reason)}`);
    return lines;
  }

  private renderTooSmall(width: number, rows: number): string[] {
    const message = currentTheme.fg('warning', `Runtime Center needs at least ${String(MIN_WIDTH)} × ${String(MIN_HEIGHT)}.`);
    return [fit(message, width), ...Array.from({ length: Math.max(0, rows - 1) }, () => ' '.repeat(Math.max(0, width)))];
  }
}
