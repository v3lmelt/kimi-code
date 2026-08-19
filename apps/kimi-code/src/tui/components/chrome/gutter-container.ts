/**
 * Container that reserves left/right gutter columns around its children,
 * so the chrome (statusline, transcript, panels) lines up with the input
 * box's inner content area instead of butting up against the terminal edge.
 *
 * Children are rendered at `width - left - right` and each emitted line is
 * prefixed with `left` plain spaces. Right padding is logical only — we
 * never emit trailing spaces, since terminals already paint background to
 * the edge and adding them would just churn the diff renderer.
 *
 * The render cache below validates per child (component identity + the
 * identity of its rendered line array), so structural child-list changes —
 * append, splice-removal, in-place replacement — are picked up correctly
 * without a tree-wide `invalidate()`. Reserve `invalidate()` for global
 * style changes that genuinely dirty every child (e.g. theme switches).
 */

import { Container, isVersionCacheEnabled } from '@moonshot-ai/pi-tui';
import type { Component } from '@moonshot-ai/pi-tui';

import { isRenderCacheEnabled } from '#/tui/utils/render-cache';

interface TranscriptRenderCache {
  width: number;
  childRefs: Component[];
  childVersions: (number | undefined)[];
  childRenderRefs: string[][];
  prefixed: string[][];
  out: string[];
}

export class GutterContainer extends Container {
  private renderCache: TranscriptRenderCache | undefined;
  constructor(
    private readonly leftPad: number,
    private readonly rightPad: number,
  ) {
    super();
  }

  override invalidate(): void {
    this.renderCache = undefined;
    super.invalidate();
  }

  override render(width: number): string[] {
    const inner = Math.max(1, width - this.leftPad - this.rightPad);
    const lead = ' '.repeat(this.leftPad);

    if (!isVersionCacheEnabled()) {
      return this.renderWithReferenceReuse(inner, lead, width);
    }

    const cache = this.renderCache;
    const structOk =
      cache !== undefined &&
      cache.width === width &&
      cache.childRefs.length === this.children.length;

    // Fast path: every child's version AND identity matches the snapshot →
    // reuse cached output. Identity matters: an in-place replacement can reuse
    // the same version number, and only a ref check catches it.
    if (structOk) {
      let allMatch = true;
      for (let i = 0; i < this.children.length; i++) {
        const child = this.children[i]!;
        const v = child.version;
        if (v === undefined || cache.childRefs[i] !== child || v !== cache.childVersions[i]) {
          allMatch = false;
          break;
        }
      }
      if (allMatch) return cache!.out;
    }

    const childRefs: Component[] = [];
    const childVersions: (number | undefined)[] = [];
    const childRenderRefs: string[][] = [];
    const prefixed: string[][] = [];

    let i = 0;
    for (const child of this.children) {
      const v = child.version;
      childRefs.push(child);
      childVersions.push(v);
      let lines: string[];
      if (
        structOk &&
        cache.childRefs[i] === child &&
        v !== undefined &&
        v === cache.childVersions[i]
      ) {
        // Unchanged versioned child: reuse cached lines + prefix, skip render.
        lines = cache.childRenderRefs[i]!;
        childRenderRefs.push(lines);
        prefixed.push(cache.prefixed[i]!);
      } else {
        lines = child.render(inner);
        childRenderRefs.push(lines);
        prefixed.push(lines.map((line) => lead + line));
      }
      i++;
    }

    const out: string[] = [];
    for (const lines of prefixed) {
      for (const line of lines) out.push(line);
    }

    this.renderCache = { width, childRefs, childVersions, childRenderRefs, prefixed, out };
    return out;
  }

  /** Original reference-reuse path, used when version caching is disabled. */
  private renderWithReferenceReuse(inner: number, lead: string, width: number): string[] {
    const cache = this.renderCache;
    const cacheValid =
      isRenderCacheEnabled() &&
      cache !== undefined &&
      cache.width === width &&
      cache.childRefs.length === this.children.length;

    const childRefs: Component[] = [];
    const childVersions: (number | undefined)[] = [];
    const childRenderRefs: string[][] = [];
    const prefixed: string[][] = [];
    let allReused = cacheValid;

    let i = 0;
    for (const child of this.children) {
      const lines = child.render(inner);
      childRefs.push(child);
      childVersions.push(child.version);
      childRenderRefs.push(lines);
      const reused = cacheValid && cache.childRefs[i] === child && cache.childRenderRefs[i] === lines;
      if (reused) {
        prefixed.push(cache.prefixed[i]!);
      } else {
        allReused = false;
        prefixed.push(lines.map((line) => lead + line));
      }
      i++;
    }

    let out: string[];
    if (allReused) {
      out = cache!.out;
    } else {
      out = [];
      for (const lines of prefixed) {
        for (const line of lines) out.push(line);
      }
    }

    if (isRenderCacheEnabled()) {
      this.renderCache = { width, childRefs, childVersions, childRenderRefs, prefixed, out };
    }

    return out;
  }
}
