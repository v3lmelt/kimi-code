import type { BackgroundTaskInfo, Session } from '@moonshot-ai/kimi-code-sdk';
import type { Component, ProcessTerminal, TUI } from '@moonshot-ai/pi-tui';

import { TaskOutputViewer } from '../components/dialogs/task-output-viewer';
import {
  RuntimeCenterApp,
  type RuntimeCenterProps,
} from '../components/dialogs/runtime-center';
import { TasksBrowserApp, type TasksFilter } from '../components/dialogs/tasks-browser';
import {
  projectRuntimeCenter,
  type RuntimeCenterAction,
  type RuntimeCenterProjection,
  type RuntimeCenterTaskInfo,
  type RuntimeCenterView,
} from '../utils/runtime-center-model';
import type { WorkflowRunView } from '../utils/workflow-model';
import type { Theme } from '#/tui/theme';
import type { CustomEditor } from '../components/editor/custom-editor';

export interface TasksBrowserHost {
  readonly state: {
    readonly tasksBrowser: TasksBrowserState | undefined;
    readonly theme: Theme;
    readonly terminal: ProcessTerminal;
    readonly ui: TUI;
    readonly editor: CustomEditor;
    readonly runtimeCenter: RuntimeCenterState | undefined;
  };
  readonly backgroundTasks: ReadonlyMap<string, BackgroundTaskInfo>;
  readonly workflowBackgroundTasks?: ReadonlyMap<string, RuntimeCenterTaskInfo>;
  readonly session: Session | undefined;
  readonly workflowRuns?: readonly WorkflowRunView[];
  showError(msg: string): void;
  setTasksBrowser(value: TasksBrowserState | undefined): void;
  setRuntimeCenter(value: RuntimeCenterState | undefined): void;
}

export function getTaskInfoForOutput(
  taskId: string,
  backgroundTasks: ReadonlyMap<string, BackgroundTaskInfo>,
  workflowBackgroundTasks: ReadonlyMap<string, RuntimeCenterTaskInfo> | undefined,
): BackgroundTaskInfo | RuntimeCenterTaskInfo | undefined {
  return backgroundTasks.get(taskId) ?? workflowBackgroundTasks?.get(taskId);
}

export type TasksBrowserState = {
  component: TasksBrowserApp;
  savedChildren: readonly Component[];
  filter: TasksFilter;
  selectedTaskId: string | undefined;
  tailOutput: string | undefined;
  tailLoading: boolean;
  tailRequestId: number;
  flashMessage: string | undefined;
  flashTimer: NodeJS.Timeout | undefined;
  pollTimer: NodeJS.Timeout | undefined;
  viewer:
    | {
        component: TaskOutputViewer;
        savedChildren: readonly Component[];
        taskId: string;
        output: string;
        refreshId: number;
        pollTimer: NodeJS.Timeout;
      }
    | undefined;
};

export type RuntimeCenterState = {
  component: RuntimeCenterApp;
  savedChildren: readonly Component[];
  view: RuntimeCenterView;
  selectedKey: string | undefined;
  projection: RuntimeCenterProjection;
  flashMessage: string | undefined;
  flashTimer: NodeJS.Timeout | undefined;
  pollTimer: NodeJS.Timeout | undefined;
  viewer:
    | {
        component: TaskOutputViewer;
        savedChildren: readonly Component[];
        taskId: string;
        output: string;
        refreshId: number;
        pollTimer: NodeJS.Timeout;
      }
    | undefined;
};

export class TasksBrowserController {
  constructor(private readonly host: TasksBrowserHost) {}

  async show(): Promise<void> {
    const { state } = this.host;
    if (state.tasksBrowser !== undefined) return;

    const session = this.host.session;
    if (session === undefined) {
      this.host.showError('No active session.');
      return;
    }

    let tasks: readonly BackgroundTaskInfo[] = [];
    try {
      tasks = await session.listBackgroundTasks({ activeOnly: false });
    } catch (error) {
      this.host.showError(
        `Failed to load tasks: ${error instanceof Error ? error.message : String(error)}`,
      );
      return;
    }
    if (state.tasksBrowser !== undefined) return;

    const filter: TasksFilter = 'all';
    const selectedTaskId = this.pickInitialSelection(tasks, filter);
    const component = new TasksBrowserApp(
      {
        tasks,
        filter,
        selectedTaskId,
        tailOutput: undefined,
        tailLoading: false,
        flashMessage: undefined,
        ...this.buildCallbacks(),
      },
      state.terminal,
    );

    const savedChildren = [...state.ui.children];
    state.ui.clear();
    state.ui.addChild(component);
    state.ui.setFocus(component);
    state.ui.requestRender(true);

    const pollTimer = setInterval(() => {
      void this.refresh({ silent: true });
    }, 1000);

    this.host.setTasksBrowser({
      component,
      savedChildren,
      filter,
      selectedTaskId,
      tailOutput: undefined,
      tailLoading: false,
      tailRequestId: 0,
      flashMessage: undefined,
      flashTimer: undefined,
      pollTimer,
      viewer: undefined,
    });

    if (selectedTaskId !== undefined) {
      this.loadTail(selectedTaskId);
    }
  }

  /** Open the unified Runtime Center while retaining the legacy task browser. */
  async showRuntimeCenter(view: RuntimeCenterView = 'tasks', focusKey?: string): Promise<void> {
    const { state } = this.host;
    if (state.runtimeCenter !== undefined) {
      state.runtimeCenter.view = view;
      if (focusKey !== undefined) state.runtimeCenter.selectedKey = focusKey;
      this.pushRuntimeProps();
      return;
    }
    if (state.tasksBrowser !== undefined) this.close();

    const session = this.host.session;
    if (session === undefined) {
      this.host.showError('No active session.');
      return;
    }
    let tasks: readonly BackgroundTaskInfo[] = [];
    try {
      tasks = await session.listBackgroundTasks({ activeOnly: false });
    } catch (error) {
      this.host.showError(
        `Failed to load tasks: ${error instanceof Error ? error.message : String(error)}`,
      );
      return;
    }
    if (state.runtimeCenter !== undefined) return;
    const projection = this.runtimeProjection(tasks);
    const selectedKey = focusKey !== undefined && projection[view].some((row) => row.key === focusKey)
      ? focusKey
      : this.pickRuntimeSelection(projection, view);
    const component = new RuntimeCenterApp(
      {
        view,
        projection,
        selectedKey,
        flashMessage: undefined,
        ...this.runtimeCallbacks(),
      },
      state.terminal,
    );
    const savedChildren = [...state.ui.children];
    state.ui.clear();
    state.ui.addChild(component);
    state.ui.setFocus(component);
    state.ui.requestRender(true);
    const pollTimer = setInterval(() => {
      void this.refreshRuntimeCenter({ silent: true });
    }, 1000);
    this.host.setRuntimeCenter({
      component,
      savedChildren,
      view,
      selectedKey,
      projection,
      flashMessage: undefined,
      flashTimer: undefined,
      pollTimer,
      viewer: undefined,
    });
  }

  close(): void {
    const { state } = this.host;
    const runtime = state.runtimeCenter;
    if (runtime !== undefined) {
      if (runtime.viewer !== undefined) this.closeRuntimeOutputViewer();
      if (runtime.pollTimer !== undefined) clearInterval(runtime.pollTimer);
      if (runtime.flashTimer !== undefined) clearTimeout(runtime.flashTimer);
      state.ui.clear();
      for (const child of runtime.savedChildren) state.ui.addChild(child);
      this.host.setRuntimeCenter(undefined);
      state.ui.setFocus(state.editor);
      state.ui.requestRender(true);
    }
    const browser = state.tasksBrowser;
    if (browser === undefined) return;
    if (browser.viewer !== undefined) this.closeOutputViewer();
    if (browser.pollTimer !== undefined) clearInterval(browser.pollTimer);
    if (browser.flashTimer !== undefined) clearTimeout(browser.flashTimer);

    state.ui.clear();
    for (const child of browser.savedChildren) {
      state.ui.addChild(child);
    }
    this.host.setTasksBrowser(undefined);
    state.ui.setFocus(state.editor);
    state.ui.requestRender(true);
  }

  repaint(): void {
    const browser = this.host.state.tasksBrowser;
    const tasks = [...this.host.backgroundTasks.values()];
    if (browser !== undefined) this.pushProps(tasks);
    if (this.host.state.runtimeCenter !== undefined) this.pushRuntimeProps();
  }

  async refreshOutputViewer(opts: { silent?: boolean } = {}): Promise<void> {
    const { state } = this.host;
    const browser = state.tasksBrowser;
    const viewer = browser?.viewer;
    if (browser === undefined || viewer === undefined) return;

    const session = this.host.session;
    if (session === undefined) return;

    const myRefreshId = ++viewer.refreshId;
    let output: string;
    try {
      output = await session.getBackgroundTaskOutput(viewer.taskId);
    } catch (error) {
      if (!opts.silent) {
        const message = error instanceof Error ? error.message : String(error);
        this.flash(`Output refresh failed: ${message}`);
      }
      return;
    }
    const current = state.tasksBrowser?.viewer;
    if (current === undefined || current !== viewer || current.refreshId !== myRefreshId) {
      return;
    }
    if (output === viewer.output) return;
    viewer.output = output;
    const info = getTaskInfoForOutput(
      viewer.taskId,
      this.host.backgroundTasks,
      this.host.workflowBackgroundTasks,
    );
    viewer.component.setProps({
      taskId: viewer.taskId,
      info,
      output,
      onClose: () => {
        this.closeOutputViewer();
      },
    });
    this.host.state.ui.requestRender();
  }

  // ---------------------------------------------------------------------------

  private pickInitialSelection(
    tasks: readonly BackgroundTaskInfo[],
    filter: TasksFilter,
  ): string | undefined {
    const candidates =
      filter === 'all'
        ? tasks
        : tasks.filter(
            (t) =>
              t.status !== 'completed' &&
              t.status !== 'failed' &&
              t.status !== 'timed_out' &&
              t.status !== 'killed' &&
              t.status !== 'lost',
          );
    if (candidates.length === 0) return undefined;
    return candidates.find((t) => t.status === 'running')?.taskId ?? candidates[0]!.taskId;
  }

  private async refresh(opts: { silent?: boolean } = {}): Promise<void> {
    const { state } = this.host;
    const browser = state.tasksBrowser;
    if (browser === undefined) return;

    const session = this.host.session;
    if (session === undefined) return;

    let tasks: readonly BackgroundTaskInfo[];
    try {
      tasks = await session.listBackgroundTasks({ activeOnly: false });
    } catch (error) {
      if (!opts.silent) {
        this.flash(
          `Refresh failed: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
      return;
    }
    if (state.tasksBrowser !== browser) return;
    this.pushProps(tasks);
  }

  private pushProps(tasks: readonly BackgroundTaskInfo[]): void {
    const browser = this.host.state.tasksBrowser;
    if (browser === undefined) return;
    browser.component.setProps({
      tasks,
      filter: browser.filter,
      selectedTaskId: browser.selectedTaskId,
      tailOutput: browser.tailOutput,
      tailLoading: browser.tailLoading,
      flashMessage: browser.flashMessage,
      ...this.buildCallbacks(),
    });
    this.host.state.ui.requestRender();
  }

  private buildCallbacks(): {
    onSelect: (taskId: string) => void;
    onToggleFilter: () => void;
    onRefresh: () => void;
    onCancel: () => void;
    onStopConfirmed: (taskId: string) => void;
    onOpenOutput: (taskId: string) => void;
    onStopIgnored: (taskId: string, reason: 'terminal') => void;
  } {
    return {
      onSelect: (taskId) => {
        this.handleSelect(taskId);
      },
      onToggleFilter: () => {
        this.handleToggleFilter();
      },
      onRefresh: () => {
        this.handleRefresh();
      },
      onCancel: () => {
        this.close();
      },
      onStopConfirmed: (taskId) => {
        void this.handleStop(taskId);
      },
      onOpenOutput: (taskId) => {
        void this.handleOpenOutput(taskId);
      },
      onStopIgnored: (taskId, reason) => {
        if (reason === 'terminal') {
          this.flash(`${taskId} is already terminal — nothing to stop.`);
        }
      },
    };
  }

  private runtimeProjection(tasks: readonly RuntimeCenterTaskInfo[]): RuntimeCenterProjection {
    const metadata = this.host.session?.getResumeState()?.sessionMetadata.agents;
    const workflowTasks = this.host.workflowBackgroundTasks === undefined
      ? []
      : [...this.host.workflowBackgroundTasks.values()];
    const byTaskId = new Map<string, RuntimeCenterTaskInfo>();
    for (const task of [...tasks, ...workflowTasks]) byTaskId.set(task.taskId, task);
    return projectRuntimeCenter({
      tasks: [...byTaskId.values()],
      workflows: this.host.workflowRuns ?? [],
      agentMetadata: metadata as Readonly<Record<string, unknown>> | undefined,
    });
  }

  private pickRuntimeSelection(
    projection: RuntimeCenterProjection,
    view: RuntimeCenterView,
  ): string | undefined {
    const rows = projection[view];
    return rows[0]?.key;
  }

  private runtimeCallbacks(): Pick<RuntimeCenterProps, 'onSelect' | 'onViewChange' | 'onRefresh' | 'onCancel' | 'onAction' | 'onActionUnavailable'> {
    return {
      onSelect: (key) => {
        const runtime = this.host.state.runtimeCenter;
        if (runtime !== undefined) runtime.selectedKey = key;
      },
      onViewChange: (view) => {
        const runtime = this.host.state.runtimeCenter;
        if (runtime === undefined) return;
        runtime.view = view;
        runtime.selectedKey = this.pickRuntimeSelection(runtime.projection, view);
        this.pushRuntimeProps();
      },
      onRefresh: () => {
        this.flashRuntime('Refreshing…', 600);
        void this.refreshRuntimeCenter();
      },
      onCancel: () => this.close(),
      onAction: (action, key) => {
        if (action === 'stop') {
          const taskId = this.runtimeTaskId(key);
          if (taskId !== undefined) void this.handleStop(taskId);
          return;
        }
        if (action === 'output') {
          const taskId = this.runtimeTaskId(key);
          if (taskId !== undefined) void this.handleOpenOutput(taskId);
        }
      },
      onActionUnavailable: (_action, _key, reason) => {
        this.flashRuntime(reason);
      },
    };
  }

  private runtimeTaskId(key: string): string | undefined {
    const runtime = this.host.state.runtimeCenter;
    const item = runtime === undefined
      ? undefined
      : [
          ...runtime.projection.tasks,
          ...runtime.projection.agents,
          ...runtime.projection.workflows,
        ].find((row) => row.key === key);
    return item?.taskId;
  }

  private pushRuntimeProps(): void {
    const runtime = this.host.state.runtimeCenter;
    if (runtime === undefined) return;
    runtime.component.setProps({
      view: runtime.view,
      projection: runtime.projection,
      selectedKey: runtime.selectedKey,
      flashMessage: runtime.flashMessage,
      ...this.runtimeCallbacks(),
    });
    this.host.state.ui.requestRender();
  }

  private async refreshRuntimeCenter(opts: { silent?: boolean } = {}): Promise<void> {
    const runtime = this.host.state.runtimeCenter;
    const session = this.host.session;
    if (runtime === undefined || session === undefined) return;
    let tasks: readonly BackgroundTaskInfo[];
    try {
      tasks = await session.listBackgroundTasks({ activeOnly: false });
    } catch (error) {
      if (!opts.silent) this.flashRuntime(`Refresh failed: ${error instanceof Error ? error.message : String(error)}`);
      return;
    }
    if (this.host.state.runtimeCenter !== runtime) return;
    runtime.projection = this.runtimeProjection(tasks);
    const rows = runtime.projection[runtime.view];
    if (runtime.selectedKey === undefined || !rows.some((row) => row.key === runtime.selectedKey)) {
      runtime.selectedKey = rows[0]?.key;
    }
    this.pushRuntimeProps();
  }

  private flashRuntime(message: string, durationMs = 2500): void {
    const runtime = this.host.state.runtimeCenter;
    if (runtime === undefined) return;
    if (runtime.flashTimer !== undefined) clearTimeout(runtime.flashTimer);
    runtime.flashMessage = message;
    runtime.flashTimer = setTimeout(() => {
      const current = this.host.state.runtimeCenter;
      if (current !== runtime) return;
      current.flashMessage = undefined;
      current.flashTimer = undefined;
      this.pushRuntimeProps();
    }, durationMs);
    this.pushRuntimeProps();
  }

  private handleSelect(taskId: string): void {
    const browser = this.host.state.tasksBrowser;
    if (browser === undefined) return;
    if (browser.selectedTaskId === taskId) return;
    browser.selectedTaskId = taskId;
    browser.tailOutput = undefined;
    browser.tailLoading = true;
    this.repaint();
    this.loadTail(taskId);
  }

  private handleToggleFilter(): void {
    const browser = this.host.state.tasksBrowser;
    if (browser === undefined) return;
    browser.filter = browser.filter === 'all' ? 'active' : 'all';
    this.repaint();
  }

  private handleRefresh(): void {
    this.flash('Refreshing…', 600);
    void this.refresh();
  }

  private async handleStop(taskId: string): Promise<void> {
    const browser = this.host.state.tasksBrowser;
    const runtime = this.host.state.runtimeCenter;
    if (browser === undefined && runtime === undefined) return;

    if (runtime !== undefined) {
      const task = runtime.projection.tasks.find((row) => row.taskId === taskId);
      if (task?.source.detached === false) {
        this.flashRuntime('Foreground tasks cannot be stopped from Runtime Center.');
        return;
      }
    }

    const session = this.host.session;
    if (session === undefined) {
      this.flash('No active session.');
      return;
    }

    this.flash(`Stopping ${taskId}…`, 1500);
    try {
      await session.stopBackgroundTask(taskId, { reason: 'User initiated stop' });
      if (runtime !== undefined) await this.refreshRuntimeCenter({ silent: true });
      else await this.refresh({ silent: true });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.flash(`Stop failed: ${message}`);
    }
  }

  private async handleOpenOutput(taskId: string): Promise<void> {
    const { state } = this.host;
    const browser = state.tasksBrowser;
    const runtime = state.runtimeCenter;
    if (browser === undefined && runtime === undefined) return;
    if (browser?.viewer !== undefined || runtime?.viewer !== undefined) return;

    const session = this.host.session;
    if (session === undefined) {
      this.flash('No active session.');
      return;
    }

    let output: string;
    try {
      output = await session.getBackgroundTaskOutput(taskId);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.flash(`Cannot open output: ${message}`);
      return;
    }
    const current = state.tasksBrowser;
    if (current === undefined || current !== browser) {
      if (runtime !== undefined && state.runtimeCenter === runtime) {
        this.openRuntimeOutput(taskId, output);
      }
      return;
    }

    const info = getTaskInfoForOutput(
      taskId,
      this.host.backgroundTasks,
      this.host.workflowBackgroundTasks,
    );
    const viewer = new TaskOutputViewer(
      {
        taskId,
        info,
        output,
        onClose: () => {
          this.closeOutputViewer();
        },
      },
      state.terminal,
    );

    const savedBrowserChildren = [...state.ui.children];
    state.ui.clear();
    state.ui.addChild(viewer);
    state.ui.setFocus(viewer);
    state.ui.requestRender(true);

    const pollTimer = setInterval(() => {
      void this.refreshOutputViewer({ silent: true });
    }, 1000);

    browser.viewer = {
      component: viewer,
      savedChildren: savedBrowserChildren,
      taskId,
      output,
      refreshId: 0,
      pollTimer,
    };
  }

  private loadTail(taskId: string): void {
    const { state } = this.host;
    const browser = state.tasksBrowser;
    if (browser === undefined) return;

    const session = this.host.session;
    if (session === undefined) {
      browser.tailLoading = false;
      this.repaint();
      return;
    }

    const requestId = ++browser.tailRequestId;
    void session
      .getBackgroundTaskOutput(taskId, { tail: 4000 })
      .then((output) => {
        const current = state.tasksBrowser;
        if (current === undefined) return;
        if (current !== browser || current.tailRequestId !== requestId) return;
        if (current.selectedTaskId !== taskId) return;
        current.tailOutput = output;
        current.tailLoading = false;
        this.repaint();
      })
      .catch(() => {
        const current = state.tasksBrowser;
        if (current === undefined) return;
        if (current !== browser || current.tailRequestId !== requestId) return;
        if (current.selectedTaskId !== taskId) return;
        current.tailOutput = '';
        current.tailLoading = false;
        this.repaint();
      });
  }

  private flash(message: string, durationMs = 2500): void {
    const browser = this.host.state.tasksBrowser;
    if (browser === undefined) {
      this.flashRuntime(message, durationMs);
      return;
    }
    if (browser.flashTimer !== undefined) clearTimeout(browser.flashTimer);
    browser.flashMessage = message;
    browser.flashTimer = setTimeout(() => {
      const current = this.host.state.tasksBrowser;
      if (current !== browser) return;
      current.flashMessage = undefined;
      current.flashTimer = undefined;
      this.repaint();
    }, durationMs);
    this.repaint();
  }

  private closeOutputViewer(): void {
    const browser = this.host.state.tasksBrowser;
    if (browser === undefined || browser.viewer === undefined) return;
    const viewer = browser.viewer;
    clearInterval(viewer.pollTimer);
    browser.viewer = undefined;
    this.host.state.ui.clear();
    for (const child of viewer.savedChildren) {
      this.host.state.ui.addChild(child);
    }
    this.host.state.ui.setFocus(browser.component);
    this.host.state.ui.requestRender(true);
  }

  private openRuntimeOutput(taskId: string, output: string): void {
    const { state } = this.host;
    const runtime = state.runtimeCenter;
    if (runtime === undefined || runtime.viewer !== undefined) return;
    const info = getTaskInfoForOutput(
      taskId,
      this.host.backgroundTasks,
      this.host.workflowBackgroundTasks,
    );
    const viewer = new TaskOutputViewer(
      {
        taskId,
        info,
        output,
        onClose: () => this.closeRuntimeOutputViewer(),
      },
      state.terminal,
    );
    const savedChildren = [...state.ui.children];
    state.ui.clear();
    state.ui.addChild(viewer);
    state.ui.setFocus(viewer);
    state.ui.requestRender(true);
    const pollTimer = setInterval(() => {
      void this.refreshRuntimeOutputViewer({ silent: true });
    }, 1000);
    runtime.viewer = { component: viewer, savedChildren, taskId, output, refreshId: 0, pollTimer };
  }

  private async refreshRuntimeOutputViewer(opts: { silent?: boolean } = {}): Promise<void> {
    const runtime = this.host.state.runtimeCenter;
    const viewer = runtime?.viewer;
    const session = this.host.session;
    if (runtime === undefined || viewer === undefined || session === undefined) return;
    const refreshId = ++viewer.refreshId;
    let output: string;
    try {
      output = await session.getBackgroundTaskOutput(viewer.taskId);
    } catch (error) {
      if (!opts.silent) this.flashRuntime(`Output refresh failed: ${error instanceof Error ? error.message : String(error)}`);
      return;
    }
    if (this.host.state.runtimeCenter !== runtime || runtime.viewer !== viewer || viewer.refreshId !== refreshId) return;
    if (output === viewer.output) return;
    viewer.output = output;
    viewer.component.setProps({
      taskId: viewer.taskId,
      info: getTaskInfoForOutput(
        viewer.taskId,
        this.host.backgroundTasks,
        this.host.workflowBackgroundTasks,
      ),
      output,
      onClose: () => this.closeRuntimeOutputViewer(),
    });
    this.host.state.ui.requestRender();
  }

  private closeRuntimeOutputViewer(): void {
    const runtime = this.host.state.runtimeCenter;
    const viewer = runtime?.viewer;
    if (runtime === undefined || viewer === undefined) return;
    clearInterval(viewer.pollTimer);
    runtime.viewer = undefined;
    this.host.state.ui.clear();
    for (const child of viewer.savedChildren) this.host.state.ui.addChild(child);
    this.host.state.ui.setFocus(runtime.component);
    this.host.state.ui.requestRender(true);
  }
}
