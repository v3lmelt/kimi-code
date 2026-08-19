/**
 * Diff preview rendering as plain ANSI strings.
 *
 * Reuses the diff algorithm from approval/DiffPreview.tsx, but outputs
 * formatted text lines instead of React elements.
 */

import chalk from 'chalk';

import { currentTheme } from '#/tui/theme';

export type DiffLineKind = 'context' | 'add' | 'delete';

interface DiffStyles {
  add: (s: string) => string;
  del: (s: string) => string;
  addBold: (s: string) => string;
  delBold: (s: string) => string;
  gutter: (s: string) => string;
  meta: (s: string) => string;
}

function makeDiffStyles(): DiffStyles {
  const palette = currentTheme.palette;
  return {
    add: (s) => chalk.hex(palette.diffAdded)(s),
    del: (s) => chalk.hex(palette.diffRemoved)(s),
    addBold: (s) => chalk.bold.hex(palette.diffAddedStrong)(s),
    delBold: (s) => chalk.bold.hex(palette.diffRemovedStrong)(s),
    gutter: (s) => chalk.hex(palette.diffGutter)(s),
    meta: (s) => chalk.hex(palette.diffMeta)(s),
  };
}

export interface DiffLine {
  kind: DiffLineKind;
  lineNum: number;
  code: string;
  /**
   * Present on the synthetic trailing marker line when the diff was
   * approximated because the full O(m*n) DP table would have exceeded
   * MAX_DP_CELLS. Renderers surface it as a footer instead of rendering
   * it as a body row.
   */
  comment?: string;
}

/** Marker comment on the trailing line of an approximated diff. */
const TRUNCATED_COMMENT = 'diff truncated';

/**
 * Cap for the O(m*n) LCS DP table in computeDiffFull. At ~1M cells
 * (1000x1000) the table is a few MB and the fill is a few ms; beyond that
 * we switch to the linear degraded path so a single huge Edit never blocks
 * the input->render window with seconds of synchronous work.
 */
const MAX_DP_CELLS = 1_000_000;

/**
 * Exact LCS diff over the full (m+1)*(n+1) DP table. Only used when the
 * cell count is within MAX_DP_CELLS.
 */
function computeDiffFull(
  oldLines: string[],
  newLines: string[],
  oldStart: number,
  newStart: number,
): DiffLine[] {
  const m = oldLines.length;
  const n = newLines.length;

  const dp: number[][] = Array.from({ length: m + 1 }, () =>
    Array.from({ length: n + 1 }, () => 0),
  );
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      if (oldLines[i - 1] === newLines[j - 1]) {
        dp[i]![j] = dp[i - 1]![j - 1]! + 1;
      } else {
        dp[i]![j] = Math.max(dp[i - 1]![j]!, dp[i]![j - 1]!);
      }
    }
  }

  const reversed: DiffLine[] = [];
  let i = m;
  let j = n;
  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && oldLines[i - 1] === newLines[j - 1]) {
      reversed.push({ kind: 'context', lineNum: newStart + j - 1, code: newLines[j - 1]! });
      i--;
      j--;
    } else if (j > 0 && (i === 0 || dp[i]![j - 1]! >= dp[i - 1]![j]!)) {
      reversed.push({ kind: 'add', lineNum: newStart + j - 1, code: newLines[j - 1]! });
      j--;
    } else {
      reversed.push({ kind: 'delete', lineNum: oldStart + i - 1, code: oldLines[i - 1]! });
      i--;
    }
  }

  const result: DiffLine[] = [];
  for (let k = reversed.length - 1; k >= 0; k--) {
    result.push(reversed[k]!);
  }

  return result;
}

/**
 * Linear-time approximate diff used when m*n would exceed MAX_DP_CELLS.
 *
 * Strategy: strip the common prefix/suffix, then anchor on unique lines
 * that appear exactly once in both files (patience-diff style) and sweep
 * the gaps between anchors with a parallel delete/add pass. Anchoring keeps
 * shifted blocks aligned (e.g. "insert one line at the top of a huge file"
 * stays +1 instead of a per-line cascade), which a naive line-by-line sweep
 * would miss; a full rewrite with no unique matches degenerates to one
 * all-delete + all-add block, which is the correct answer there. The result
 * is exact for common "append / prepend / replace a block" cases and
 * approximate elsewhere — the trailing marker line tags it as such.
 */
function computeDiffDegraded(
  oldLines: string[],
  newLines: string[],
  oldStart: number,
  newStart: number,
): DiffLine[] {
  const result: DiffLine[] = [];
  const m = oldLines.length;
  const n = newLines.length;

  // Longest common prefix.
  let p = 0;
  while (p < m && p < n && oldLines[p] === newLines[p]) {
    result.push({ kind: 'context', lineNum: newStart + p, code: newLines[p]! });
    p++;
  }

  // Longest common suffix (must not overlap the prefix).
  let sOld = m;
  let sNew = n;
  while (sOld > p && sNew > p && oldLines[sOld - 1] === newLines[sNew - 1]) {
    sOld--;
    sNew--;
  }

  // Frequency maps over the remaining middle, used to find unique lines.
  const oldCount = new Map<string, number>();
  const newCount = new Map<string, number>();
  for (let i = p; i < sOld; i++) {
    oldCount.set(oldLines[i]!, (oldCount.get(oldLines[i]!) ?? 0) + 1);
  }
  for (let j = p; j < sNew; j++) {
    newCount.set(newLines[j]!, (newCount.get(newLines[j]!) ?? 0) + 1);
  }

  // Anchor pairs: unique lines present in both middles, matched in
  // increasing old order. Repeated lines (braces, blank lines) are ignored
  // so anchors land on genuinely informative lines.
  const oldUnique = new Map<string, number>();
  for (let i = p; i < sOld; i++) {
    if ((oldCount.get(oldLines[i]!) ?? 0) === 1) oldUnique.set(oldLines[i]!, i);
  }
  const anchors: Array<[number, number]> = [];
  let oldScan = p;
  for (let j = p; j < sNew; j++) {
    const line = newLines[j]!;
    if ((newCount.get(line) ?? 0) === 1 && (oldCount.get(line) ?? 0) === 1) {
      const oi = oldUnique.get(line);
      if (oi !== undefined && oi >= oldScan) {
        anchors.push([oi, j]);
        oldScan = oi + 1;
      }
    }
  }

  // Sweep old[oa..ob) vs new[na..nb): matching lines become context,
  // mismatches become a delete+add pair.
  const emitGap = (oa: number, ob: number, na: number, nb: number): void => {
    let i = oa;
    let j = na;
    while (i < ob && j < nb) {
      if (oldLines[i] === newLines[j]) {
        result.push({ kind: 'context', lineNum: newStart + j, code: newLines[j]! });
        i++;
        j++;
      } else {
        result.push({ kind: 'delete', lineNum: oldStart + i, code: oldLines[i]! });
        result.push({ kind: 'add', lineNum: newStart + j, code: newLines[j]! });
        i++;
        j++;
      }
    }
    while (i < ob) {
      result.push({ kind: 'delete', lineNum: oldStart + i, code: oldLines[i]! });
      i++;
    }
    while (j < nb) {
      result.push({ kind: 'add', lineNum: newStart + j, code: newLines[j]! });
      j++;
    }
  };

  let prevOld = p;
  let prevNew = p;
  for (const [oi, nj] of anchors) {
    emitGap(prevOld, oi, prevNew, nj);
    result.push({ kind: 'context', lineNum: newStart + nj, code: newLines[nj]! });
    prevOld = oi + 1;
    prevNew = nj + 1;
  }
  emitGap(prevOld, sOld, prevNew, sNew);

  // Common suffix contexts (line for line identical on both sides).
  for (let k = 0; k < m - sOld; k++) {
    result.push({
      kind: 'context',
      lineNum: newStart + sNew + k,
      code: newLines[sNew + k]!,
    });
  }

  return result;
}

export function computeDiffLines(
  oldText: string,
  newText: string,
  oldStart: number = 1,
  newStart: number = 1,
  isIncomplete: boolean = false,
): DiffLine[] {
  const oldLines = oldText ? oldText.split('\n') : [];
  const newLines = newText ? newText.split('\n') : [];
  const m = oldLines.length;
  const n = newLines.length;

  // Size budget: keep the quadratic DP off the hot path for huge Edit
  // inputs (thousands x thousands lines -> tens of millions of cells,
  // seconds of synchronous work). The degraded path is O(m+n).
  const truncated = m * n > MAX_DP_CELLS;
  const result = truncated
    ? computeDiffDegraded(oldLines, newLines, oldStart, newStart)
    : computeDiffFull(oldLines, newLines, oldStart, newStart);

  // While the text is still streaming, suppress trailing delete lines.
  // They are likely artefacts of newText not having arrived yet rather
  // than genuine deletions.
  if (isIncomplete && result.length > 0) {
    let lastNonDelete = result.length - 1;
    while (lastNonDelete >= 0 && result[lastNonDelete]!.kind === 'delete') {
      lastNonDelete--;
    }
    if (lastNonDelete >= 0) {
      result.length = lastNonDelete + 1;
    } else {
      // Every line would be shown as deleted; suppress them all so the
      // UI doesn't flash a wall of red before newText starts arriving.
      result.length = 0;
    }
  }

  if (truncated) {
    // Tag the result so renderers can annotate the approximation instead of
    // silently showing a possibly inexact body. Renderers skip this line.
    result.push({
      kind: 'context',
      lineNum: newStart + Math.max(0, n - 1),
      code: '… diff truncated (large input), approximate …',
      comment: TRUNCATED_COMMENT,
    });
  }

  return result;
}

export function renderDiffLines(
  oldText: string,
  newText: string,
  path: string,
  isIncomplete: boolean = false,
  oldStart?: number,
  newStart?: number,
  maxLines?: number,
): string[] {
  const s = makeDiffStyles();
  const diffLines = computeDiffLines(oldText, newText, oldStart ?? 1, newStart ?? 1, isIncomplete);
  const diffTruncated = diffLines.some((l) => l.comment !== undefined);
  const bodyLines = diffTruncated ? diffLines.filter((l) => l.comment === undefined) : diffLines;
  const changedLines = bodyLines.filter((l) => l.kind !== 'context');
  const added = changedLines.filter((l) => l.kind === 'add').length;
  const removed = changedLines.filter((l) => l.kind === 'delete').length;

  const output: string[] = [];

  let header = '';
  if (added > 0) header += s.addBold(`+${String(added)} `);
  if (removed > 0) header += s.delBold(`-${String(removed)} `);
  header += path;
  output.push(header);

  const shown =
    maxLines !== undefined && maxLines >= 0 && changedLines.length > maxLines
      ? changedLines.slice(0, maxLines)
      : changedLines;

  for (const line of shown) {
    const marker = line.kind === 'add' ? '+' : '-';
    const color = line.kind === 'add' ? s.add : s.del;
    output.push(s.gutter(String(line.lineNum).padStart(4) + ' ') + color(marker + ' ' + line.code));
  }

  const hidden = changedLines.length - shown.length;
  if (hidden > 0) {
    output.push(
      s.meta(
        `     … ${String(hidden)} more change${hidden > 1 ? 's' : ''} hidden (ctrl+o to expand)`,
      ),
    );
  }

  if (diffTruncated) {
    output.push(s.meta('     … diff truncated (large input), approximate …'));
  }

  return output;
}

export interface ClusteredDiffOptions {
  readonly contextLines?: number;
  readonly maxLines?: number;
  readonly isIncomplete?: boolean;
  readonly expandKeyHint?: string;
  readonly oldStart?: number;
  readonly newStart?: number;
}

interface Cluster {
  readonly start: number;
  readonly end: number;
}

function buildClusters(
  diffLines: DiffLine[],
  contextLines: number,
): { clusters: Cluster[]; changedCount: number; addedCount: number; removedCount: number } {
  const changeIndices: number[] = [];
  let added = 0;
  let removed = 0;
  for (const [i, line] of diffLines.entries()) {
    if (line.kind === 'add') {
      added++;
      changeIndices.push(i);
    } else if (line.kind === 'delete') {
      removed++;
      changeIndices.push(i);
    }
  }

  const clusters: Cluster[] = [];
  if (changeIndices.length === 0) {
    return { clusters, changedCount: 0, addedCount: added, removedCount: removed };
  }

  const mergeGap = 2 * contextLines;
  let groupStart = changeIndices[0]!;
  let groupEnd = changeIndices[0]!;
  for (let i = 1; i < changeIndices.length; i++) {
    const idx = changeIndices[i]!;
    if (idx - groupEnd <= mergeGap) {
      groupEnd = idx;
    } else {
      clusters.push({
        start: Math.max(0, groupStart - contextLines),
        end: Math.min(diffLines.length - 1, groupEnd + contextLines),
      });
      groupStart = idx;
      groupEnd = idx;
    }
  }
  clusters.push({
    start: Math.max(0, groupStart - contextLines),
    end: Math.min(diffLines.length - 1, groupEnd + contextLines),
  });

  return {
    clusters,
    changedCount: changeIndices.length,
    addedCount: added,
    removedCount: removed,
  };
}

function formatDiffRow(line: DiffLine, s: DiffStyles): string {
  const gutter = s.gutter(String(line.lineNum).padStart(4) + ' ');
  if (line.kind === 'add') return gutter + s.add('+ ' + line.code);
  if (line.kind === 'delete') return gutter + s.del('- ' + line.code);
  return gutter + '  ' + line.code;
}

/**
 * Render a diff with surrounding context, eliding unchanged middle
 * regions between change clusters with a `… N unchanged lines …`
 * separator. When `maxLines` is set, the body is capped at a cluster
 * boundary and a `ctrl+o to expand` footer is appended.
 *
 * Used by Edit's call preview where we want to show *what changed*
 * with enough context to read the change, but not the whole file.
 */
export function renderDiffLinesClustered(
  oldText: string,
  newText: string,
  path: string,
  opts: ClusteredDiffOptions = {},
): string[] {
  const s = makeDiffStyles();
  const contextLines = opts.contextLines ?? 3;
  const maxLines = opts.maxLines;
  const diffLines = computeDiffLines(
    oldText,
    newText,
    opts.oldStart ?? 1,
    opts.newStart ?? 1,
    opts.isIncomplete ?? false,
  );
  const diffTruncated = diffLines.some((l) => l.comment !== undefined);
  const bodyLines = diffTruncated ? diffLines.filter((l) => l.comment === undefined) : diffLines;
  const { clusters, changedCount, addedCount, removedCount } = buildClusters(
    bodyLines,
    contextLines,
  );

  const output: string[] = [];
  let header = '';
  if (addedCount > 0) header += s.addBold(`+${String(addedCount)} `);
  if (removedCount > 0) header += s.delBold(`-${String(removedCount)} `);
  header += path;
  output.push(header);

  if (clusters.length === 0) return output;

  const cap = maxLines !== undefined && maxLines >= 0 ? maxLines : Number.POSITIVE_INFINITY;
  let body = 0;
  let prevEnd = -1;
  let truncated = false;
  let shownChanges = 0;

  outer: for (const cluster of clusters) {
    if (body >= cap) {
      truncated = true;
      break;
    }
    if (prevEnd >= 0) {
      const gap = cluster.start - prevEnd - 1;
      if (gap > 0) {
        if (body + 1 > cap) {
          truncated = true;
          break;
        }
        output.push(s.meta(`     … ${String(gap)} unchanged line${gap > 1 ? 's' : ''} …`));
        body++;
      }
    }
    // Emit cluster rows one at a time; allow mid-cluster truncation so
    // a single huge cluster (e.g. the whole file replaced inline) still
    // shows the leading lines instead of degenerating to "N changes
    // hidden" with no body at all.
    for (let i = cluster.start; i <= cluster.end; i++) {
      if (body >= cap) {
        truncated = true;
        break outer;
      }
      const line = bodyLines[i]!;
      output.push(formatDiffRow(line, s));
      body++;
      if (line.kind !== 'context') shownChanges++;
      prevEnd = i;
    }
  }

  if (truncated) {
    const hidden = changedCount - shownChanges;
    if (hidden > 0) {
      const hint = opts.expandKeyHint ?? 'ctrl+o';
      output.push(
        s.meta(
          `     … ${String(hidden)} more change${hidden > 1 ? 's' : ''} hidden (${hint} to expand)`,
        ),
      );
    }
  }

  if (diffTruncated) {
    output.push(s.meta('     … diff truncated (large input) — counts approximate …'));
  }

  return output;
}
