/**
 * Cached git branch + working-tree status for the footer/statusline.
 *
 * All git reads run asynchronously off the render path (execFile) so a slow
 * `git status` or `gh pr view` can never block footer rendering. `getStatus()`
 * stays synchronous: it returns the last cached snapshot and, when a TTL has
 * expired, schedules a background refresh that invalidates the footer via
 * `onChange`. Branch refreshes every 5s, porcelain status every 15s.
 */

import { execFile } from 'node:child_process';

const BRANCH_TTL_MS = 5_000;
const STATUS_TTL_MS = 15_000;
const PULL_REQUEST_TTL_MS = 60_000;
const SPAWN_TIMEOUT_MS = 500;
const PR_SPAWN_TIMEOUT_MS = 5_000;

export interface GitStatus {
  readonly branch: string;
  readonly dirty: boolean;
  readonly ahead: number;
  readonly behind: number;
  readonly diffAdded: number;
  readonly diffDeleted: number;
  readonly pullRequest: PullRequestInfo | null;
}

export interface PullRequestInfo {
  readonly number: number;
  readonly url: string;
}

export interface GitStatusCache {
  /** Returns current status, or `null` when workDir is not a git repo. */
  getStatus(): GitStatus | null;
}

export interface GitStatusCacheOptions {
  readonly onChange?: () => void;
}

interface BranchState {
  value: string | null;
  fetchedAt: number;
  /** True while a background branch read is in flight. */
  pending: boolean;
}

interface StatusState {
  dirty: boolean;
  ahead: number;
  behind: number;
  diffAdded: number;
  diffDeleted: number;
  fetchedAt: number;
  /** True while a background status read is in flight. */
  pending: boolean;
}

interface PullRequestState {
  value: PullRequestInfo | null;
  branch: string | null;
  fetchedAt: number;
  pendingBranch: string | null;
  requestId: number;
}

const AHEAD_BEHIND_RE = /\[(?:ahead (\d+))?(?:, )?(?:behind (\d+))?\]/;

export function createGitStatusCache(
  workDir: string,
  options: GitStatusCacheOptions = {},
): GitStatusCache {
  // `null` while repo detection is still in flight.
  let isRepo: boolean | null = null;
  let repoDetectPending = false;
  let branch: BranchState = { value: null, fetchedAt: 0, pending: false };
  let status: StatusState = {
    dirty: false,
    ahead: 0,
    behind: 0,
    diffAdded: 0,
    diffDeleted: 0,
    fetchedAt: 0,
    pending: false,
  };
  let pullRequest: PullRequestState = {
    value: null,
    branch: null,
    fetchedAt: 0,
    pendingBranch: null,
    requestId: 0,
  };

  return {
    // Synchronous snapshot read: never spawns git on the caller's stack.
    // Expired entries return the last cached values and schedule a background
    // refresh; `onChange` invalidates the footer once fresh data lands, so the
    // caller (footer render) re-renders without ever blocking.
    getStatus: () => {
      if (isRepo === false) return null;
      if (isRepo === null) {
        void refreshRepoDetection();
        return null;
      }

      const now = Date.now();
      if (now - branch.fetchedAt >= BRANCH_TTL_MS) {
        void refreshBranch();
      }
      if (branch.value === null) return null;

      if (now - status.fetchedAt >= STATUS_TTL_MS) {
        void refreshStatus();
      }
      refreshPullRequestIfNeeded(branch.value, now);

      return {
        branch: branch.value,
        dirty: status.dirty,
        ahead: status.ahead,
        behind: status.behind,
        diffAdded: status.diffAdded,
        diffDeleted: status.diffDeleted,
        pullRequest: pullRequest.branch === branch.value ? pullRequest.value : null,
      };
    },
  };

  function refreshRepoDetection(): void {
    if (repoDetectPending) return;
    repoDetectPending = true;
    void readIsRepo(workDir).then((detected) => {
      repoDetectPending = false;
      if (isRepo === detected) return;
      isRepo = detected;
      if (!isRepo) return;
      // Repo confirmed: warm branch/status snapshots off the render path.
      refreshBranch();
      refreshStatus();
      options.onChange?.();
    });
  }

  function refreshBranch(): void {
    if (branch.pending) return;
    branch = { ...branch, pending: true };
    void readBranch(workDir).then((value) => {
      if (!branch.pending) return;
      const previous = branch.value;
      branch = { value, fetchedAt: Date.now(), pending: false };
      if (previous !== value) options.onChange?.();
    });
  }

  function refreshStatus(): void {
    if (status.pending) return;
    status = { ...status, pending: true };
    void readStatus(workDir).then((next) => {
      if (!status.pending) return;
      const previous = status;
      status = { ...next, fetchedAt: Date.now(), pending: false };
      if (statusChanged(previous, status)) options.onChange?.();
    });
  }

  function refreshPullRequestIfNeeded(branchName: string, now: number): void {
    if (pullRequest.pendingBranch === branchName) return;
    const fetchedAt = pullRequest.branch === branchName ? pullRequest.fetchedAt : 0;
    if (now - fetchedAt < PULL_REQUEST_TTL_MS) return;

    const requestId = pullRequest.requestId + 1;
    pullRequest = {
      value: pullRequest.branch === branchName ? pullRequest.value : null,
      branch: branchName,
      fetchedAt,
      pendingBranch: branchName,
      requestId,
    };

    void readPullRequest(workDir).then((value) => {
      if (pullRequest.requestId !== requestId) return;

      const previous = pullRequest.branch === branchName ? pullRequest.value : null;
      const changed = !samePullRequest(previous, value);
      pullRequest = {
        value,
        branch: branchName,
        fetchedAt: Date.now(),
        pendingBranch: null,
        requestId,
      };
      if (changed) options.onChange?.();
    });
  }
}

function statusChanged(a: StatusState, b: StatusState): boolean {
  return (
    a.dirty !== b.dirty ||
    a.ahead !== b.ahead ||
    a.behind !== b.behind ||
    a.diffAdded !== b.diffAdded ||
    a.diffDeleted !== b.diffDeleted
  );
}

/**
 * Runs `git` via execFile so reads never block the caller's stack. Resolves
 * `null` on spawn failure, timeout, or non-zero exit so callers can fall back
 * to their default state.
 */
function execGit(workDir: string, args: readonly string[]): Promise<string | null> {
  return new Promise((resolve) => {
    try {
      execFile(
        'git',
        ['-C', workDir, ...args],
        {
          encoding: 'utf8',
          timeout: SPAWN_TIMEOUT_MS,
          maxBuffer: 4 * 1024 * 1024,
        },
        (error, stdout) => {
          if (error !== null) {
            resolve(null);
            return;
          }
          resolve(stdout);
        },
      );
    } catch {
      resolve(null);
    }
  });
}

async function readIsRepo(workDir: string): Promise<boolean> {
  const stdout = await execGit(workDir, ['rev-parse', '--is-inside-work-tree']);
  return stdout !== null && stdout.trim() === 'true';
}

async function readBranch(workDir: string): Promise<string | null> {
  const stdout = await execGit(workDir, ['branch', '--show-current']);
  if (stdout === null) return null;
  const name = stdout.trim();
  return name.length > 0 ? name : null;
}

async function readStatus(workDir: string): Promise<{
  dirty: boolean;
  ahead: number;
  behind: number;
  diffAdded: number;
  diffDeleted: number;
}> {
  const stdout = await execGit(workDir, ['status', '--porcelain', '-b']);
  if (stdout === null) {
    return { dirty: false, ahead: 0, behind: 0, diffAdded: 0, diffDeleted: 0 };
  }

  let dirty = false;
  let ahead = 0;
  let behind = 0;
  for (const line of stdout.split('\n')) {
    if (line.startsWith('## ')) {
      const m = AHEAD_BEHIND_RE.exec(line);
      if (m) {
        ahead = Number.parseInt(m[1] ?? '0', 10) || 0;
        behind = Number.parseInt(m[2] ?? '0', 10) || 0;
      }
    } else if (line.trim().length > 0) {
      dirty = true;
    }
  }
  const diff = dirty ? await readDiffStats(workDir) : { added: 0, deleted: 0 };
  return {
    dirty,
    ahead,
    behind,
    diffAdded: diff.added,
    diffDeleted: diff.deleted,
  };
}

async function readDiffStats(workDir: string): Promise<{ added: number; deleted: number }> {
  const stdout = await execGit(workDir, ['diff', '--numstat', 'HEAD', '--']);
  if (stdout === null) return { added: 0, deleted: 0 };

  let added = 0;
  let deleted = 0;
  for (const line of stdout.split('\n')) {
    if (!line) continue;
    const [addedText, deletedText] = line.split('\t');
    added += parseDiffNumstatCount(addedText);
    deleted += parseDiffNumstatCount(deletedText);
  }
  return { added, deleted };
}

function parseDiffNumstatCount(value: string | undefined): number {
  if (value === undefined || value === '-') return 0;
  const n = Number.parseInt(value, 10);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

function readPullRequest(workDir: string): Promise<PullRequestInfo | null> {
  return new Promise((resolve) => {
    try {
      execFile(
        'gh',
        ['pr', 'view', '--json', 'number,url'],
        {
          cwd: workDir,
          encoding: 'utf8',
          env: {
            ...process.env,
            GH_NO_UPDATE_NOTIFIER: '1',
            GH_PROMPT_DISABLED: '1',
          },
          timeout: PR_SPAWN_TIMEOUT_MS,
          maxBuffer: 256 * 1024,
        },
        (error, stdout) => {
          if (error !== null) {
            resolve(null);
            return;
          }
          resolve(parsePullRequest(stdout));
        },
      );
    } catch {
      resolve(null);
    }
  });
}

function samePullRequest(a: PullRequestInfo | null, b: PullRequestInfo | null): boolean {
  if (a === null || b === null) return a === b;
  return a.number === b.number && a.url === b.url;
}

function parsePullRequest(stdout: string): PullRequestInfo | null {
  try {
    const raw = JSON.parse(stdout) as unknown;
    if (typeof raw !== 'object' || raw === null) return null;
    const record = raw as Record<string, unknown>;
    const number = record['number'];
    const url = record['url'];
    if (typeof number !== 'number' || !Number.isInteger(number) || number <= 0) return null;
    if (typeof url !== 'string' || !isSafeHttpUrl(url)) return null;
    return { number, url };
  } catch {
    return null;
  }
}

function isSafeHttpUrl(value: string): boolean {
  if (hasControlChars(value)) return false;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' || url.protocol === 'http:';
  } catch {
    return false;
  }
}

function hasControlChars(value: string): boolean {
  for (const char of value) {
    const code = char.codePointAt(0) ?? 0;
    if (code <= 0x1f || code === 0x7f) return true;
  }
  return false;
}

export interface FormatGitBadgeOptions {
  readonly linkPullRequest?: boolean;
}

export function formatGitBadgeBase(status: GitStatus): string {
  const parts: string[] = [];
  const diff = formatDiffStats(status);
  if (diff) parts.push(diff);
  let sync = '';
  if (status.ahead > 0) sync += `↑${status.ahead}`;
  if (status.behind > 0) sync += `↓${status.behind}`;
  if (sync) parts.push(sync);
  return parts.length === 0 ? status.branch : `${status.branch} [${parts.join(' ')}]`;
}

export function formatPullRequestBadge(
  pullRequest: PullRequestInfo,
  options: FormatGitBadgeOptions = {},
): string {
  const prText = `[PR#${String(pullRequest.number)}]`;
  return options.linkPullRequest ? toTerminalHyperlink(prText, pullRequest.url) : prText;
}

export function formatGitBadge(status: GitStatus, options: FormatGitBadgeOptions = {}): string {
  const base = formatGitBadgeBase(status);
  if (status.pullRequest === null) return base;

  return `${base} ${formatPullRequestBadge(status.pullRequest, options)}`;
}

function formatDiffStats(status: GitStatus): string | null {
  const parts: string[] = [];
  if (status.diffAdded > 0) parts.push(`+${String(status.diffAdded)}`);
  if (status.diffDeleted > 0) parts.push(`-${String(status.diffDeleted)}`);
  if (parts.length > 0) return parts.join(' ');
  return status.dirty ? '±' : null;
}

function toTerminalHyperlink(text: string, url: string): string {
  if (!isSafeHttpUrl(url)) return text;
  return `\u001B]8;;${url}\u0007${text}\u001B]8;;\u0007`;
}
