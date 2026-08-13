import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ToastContainerComponent } from '#/tui/components/chrome/toast';
import { currentTheme } from '#/tui/theme';

const ANSI_SGR = /\[[0-9;]*m/g;
function strip(text: string): string {
  return text.replaceAll(ANSI_SGR, '');
}

describe('ToastContainerComponent', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  function make(): { toasts: ToastContainerComponent; refresh: ReturnType<typeof vi.fn> } {
    const refresh = vi.fn();
    const toasts = new ToastContainerComponent(refresh);
    return { toasts, refresh };
  }

  it('renders nothing when no toasts are queued', () => {
    const { toasts } = make();
    expect(toasts.render(80)).toEqual([]);
  });

  it('renders queued toasts', () => {
    const { toasts } = make();
    toasts.push('task finished');
    expect(strip(toasts.render(80)[0]!)).toBe('task finished');
  });

  it('notifies the host when a toast is queued', () => {
    const { toasts, refresh } = make();
    toasts.push('hi');
    expect(refresh).toHaveBeenCalled();
  });

  it('auto-dismisses after the default timeout', () => {
    const { toasts, refresh } = make();
    toasts.push('transient');
    expect(toasts.render(80)).toHaveLength(1);
    vi.advanceTimersByTime(2_500);
    expect(toasts.render(80)).toEqual([]);
    expect(refresh).toHaveBeenCalled();
  });

  it('honors a custom timeout', () => {
    const { toasts } = make();
    toasts.push('quick', { timeoutMs: 100 });
    expect(toasts.render(80)).toHaveLength(1);
    vi.advanceTimersByTime(100);
    expect(toasts.render(80)).toEqual([]);
  });

  it('renders only the newest toasts when more than the cap are queued', () => {
    const { toasts } = make();
    toasts.push('one');
    toasts.push('two');
    toasts.push('three');
    toasts.push('four');
    const lines = toasts.render(120).map(strip);
    expect(lines).toEqual(['two', 'three', 'four']);
  });

  it('truncates long toasts to the terminal width', () => {
    const { toasts } = make();
    toasts.push('a'.repeat(200));
    expect(strip(toasts.render(40)[0]!).length).toBeLessThanOrEqual(40);
  });

  it('colors by type', () => {
    const { toasts } = make();
    const fgSpy = vi.spyOn(currentTheme, 'fg');
    toasts.push('plain'); // info default
    toasts.push('ok', { type: 'success' });
    toasts.push('err', { type: 'error' });
    toasts.push('warn', { type: 'warning' });
    toasts.render(120);
    const calledTokens = fgSpy.mock.calls.map((args) => args[0]);
    expect(calledTokens).toContain('success');
    expect(calledTokens).toContain('error');
    expect(calledTokens).toContain('warning');
  });

  it('dispose clears pending dismiss timers', () => {
    const { toasts } = make();
    toasts.push('pending');
    const clearSpy = vi.spyOn(globalThis, 'clearTimeout');
    toasts.dispose();
    expect(clearSpy).toHaveBeenCalled();
  });
});
