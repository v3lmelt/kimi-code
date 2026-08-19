/**
 * Background quota snapshot runner for the footer's compact quota slot.
 *
 * The runner polls a `QuotaLoader` on a fixed interval and exposes the last
 * good snapshot through `current()`. Loads that throw are swallowed so a
 * transient network failure never blanks the last good data; `onUpdate` fires
 * only when a fresh snapshot (or a cleared snapshot) lands, so the footer
 * repaints on data arrival instead of on every failed attempt.
 */

export interface QuotaRow {
  readonly used: number;
  readonly limit: number;
  readonly resetAt?: string;
  readonly duration?: number;
  readonly unit?: 'hour' | 'week';
}

export interface QuotaSnapshot {
  readonly rows: readonly QuotaRow[];
}

export type QuotaLoader = () => Promise<QuotaSnapshot | null>;

export class QuotaRunner {
  private snapshot: QuotaSnapshot | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private disposed = false;

  constructor(
    private readonly loader: QuotaLoader,
    private readonly onUpdate: () => void,
    private readonly intervalMs = 60_000,
  ) {
    // Kick off the first refresh immediately; it is fire-and-forget.
    void this.refresh();
    this.timer = setInterval(() => {
      void this.refresh();
    }, intervalMs);
    this.timer.unref?.();
  }

  current(): QuotaSnapshot | null {
    return this.snapshot;
  }

  dispose(): void {
    this.disposed = true;
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  private async refresh(): Promise<void> {
    let snapshot: QuotaSnapshot | null;
    try {
      snapshot = await this.loader();
    } catch {
      // Failed loads silently keep the last good snapshot.
      return;
    }
    if (this.disposed) return;
    this.snapshot = snapshot;
    this.onUpdate();
  }
}
