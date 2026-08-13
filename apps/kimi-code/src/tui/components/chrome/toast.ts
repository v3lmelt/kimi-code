/**
 * Toast notifications — short-lived status lines rendered above the footer
 * that auto-dismiss after a timeout. Complement to the persistent inline
 * `StatusMessageComponent` / `NoticeMessageComponent` rows: those belong to
 * the transcript, while toasts are one-shot feedback (e.g. a background task
 * finishing) that should not clutter the conversation history.
 *
 * Each toast owns its own `setTimeout` (no background polling), so an idle
 * container schedules nothing and fake-timer tests never loop.
 */

import { truncateToWidth, type Component } from '@moonshot-ai/pi-tui';

import { currentTheme } from '#/tui/theme';

export type ToastType = 'info' | 'success' | 'error' | 'warning';

export interface ToastOptions {
  type?: ToastType;
  /** Override the default dismiss timeout. */
  timeoutMs?: number;
}

interface ToastEntry {
  id: number;
  text: string;
  type: ToastType;
}

const DEFAULT_TOAST_TIMEOUT_MS = 2_500;
const MAX_VISIBLE_TOASTS = 3;

export class ToastContainerComponent implements Component {
  private toasts: ToastEntry[] = [];
  private nextId = 1;
  private readonly onRefresh: () => void;
  private readonly timers = new Map<number, ReturnType<typeof setTimeout>>();

  constructor(onRefresh: () => void) {
    this.onRefresh = onRefresh;
  }

  /** Queue a toast. The newest `MAX_VISIBLE_TOASTS` are rendered. */
  push(text: string, opts: ToastOptions = {}): void {
    const id = this.nextId++;
    const timeoutMs = opts.timeoutMs ?? DEFAULT_TOAST_TIMEOUT_MS;
    this.toasts.push({ id, text, type: opts.type ?? 'info' });
    this.onRefresh();
    const timer = setTimeout(() => this.dismiss(id), timeoutMs);
    timer.unref?.();
    this.timers.set(id, timer);
  }

  invalidate(): void {}

  render(width: number): string[] {
    const visible = this.toasts.slice(-MAX_VISIBLE_TOASTS);
    if (visible.length === 0) return [];
    return visible.map((t) => truncateToWidth(this.colorFor(t.type, t.text), Math.max(1, width)));
  }

  dispose(): void {
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
  }

  private dismiss(id: number): void {
    this.timers.delete(id);
    const i = this.toasts.findIndex((t) => t.id === id);
    if (i >= 0) {
      this.toasts.splice(i, 1);
      this.onRefresh();
    }
  }

  private colorFor(type: ToastType, text: string): string {
    switch (type) {
      case 'success':
        return currentTheme.fg('success', text);
      case 'error':
        return currentTheme.fg('error', text);
      case 'warning':
        return currentTheme.fg('warning', text);
      case 'info':
        return currentTheme.fg('textDim', text);
    }
  }
}
