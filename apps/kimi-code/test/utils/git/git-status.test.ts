/* eslint-disable import/first -- vi.mock setup must run before the imports it stubs out. */
import { afterEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  execFile: vi.fn(),
}));

vi.mock('node:child_process', () => ({
  execFile: mocks.execFile,
}));

import { createGitStatusCache, formatGitBadge } from '#/utils/git/git-status';

afterEach(() => {
  vi.useRealTimers();
  vi.clearAllMocks();
});

/**
 * Drive the async git/gh reads with per-arg responses. `execFile` is callback
 * based; `gh` errors by default (no PR on a fresh repo).
 */
function mockGitReads(overrides: Record<string, string> = {}): void {
  mocks.execFile.mockImplementation(
    (
      cmd: string,
      args: string[],
      _options: unknown,
      callback: (error: Error | null, stdout: string) => void,
    ) => {
      if (cmd === 'git') {
        if (args.includes('rev-parse')) callback(null, overrides['rev-parse'] ?? 'true\n');
        else if (args.includes('branch')) callback(null, overrides['branch'] ?? 'main\n');
        else if (args.includes('status')) callback(null, overrides['status'] ?? '## main...origin/main\n M src/app.ts\n');
        else if (args.includes('diff')) callback(null, overrides['diff'] ?? '4\t1\tsrc/app.ts\n');
        else callback(null, '');
        return;
      }
      if (cmd === 'gh') {
        callback(new Error('no pull request'), '');
        return;
      }
      callback(new Error(`unexpected cmd: ${cmd}`), '');
    },
  );
}

describe('git status cache', () => {
  it('resolves branch and status asynchronously and serves cached snapshots', async () => {
    mockGitReads({
      branch: 'main\n',
      status: '## main...origin/main [ahead 2, behind 1]\n M src/app.ts\n',
      diff: '4\t1\tsrc/app.ts\n',
    });

    const cache = createGitStatusCache('/tmp/repo');
    // Repo detection is async: the first read is null, then the background
    // refresh lands and later reads return the cached snapshot.
    expect(cache.getStatus()).toBeNull();
    await vi.waitFor(() => {
      expect(cache.getStatus()).not.toBeNull();
    });
    expect(cache.getStatus()).toEqual({
      branch: 'main',
      dirty: true,
      ahead: 2,
      behind: 1,
      diffAdded: 4,
      diffDeleted: 1,
      pullRequest: null,
    });
    expect(mocks.execFile).toHaveBeenCalledTimes(5); // rev-parse + branch + status + diff + gh
  });

  it('reads uncommitted diff line counts and current pull request metadata', async () => {
    const onChange = vi.fn();
    mockGitReads({
      branch: 'feature/footer\n',
      status: '## feature/footer...origin/feature/footer\n M src/app.ts\n',
      diff: '10\t3\tsrc/app.ts\n-\t-\timage.png\n0\t5\tdeleted.ts\n',
    });
    const cache = createGitStatusCache('/tmp/repo', { onChange });
    await vi.waitFor(() => {
      expect(cache.getStatus()).not.toBeNull();
    });
    // gh mock error path leaves pullRequest null; branch/status still resolve.
    expect(cache.getStatus()).toEqual({
      branch: 'feature/footer',
      dirty: true,
      ahead: 0,
      behind: 0,
      diffAdded: 10,
      diffDeleted: 8,
      pullRequest: null,
    });
  });

  it('keeps footer git status working when gh pull-request lookup throws synchronously', async () => {
    const onChange = vi.fn();
    mocks.execFile.mockImplementation(
      (
        cmd: string,
        args: string[],
        _options: unknown,
        callback: (error: Error | null, stdout: string) => void,
      ) => {
        if (cmd === 'git') {
          if (args.includes('rev-parse')) callback(null, 'true\n');
          else if (args.includes('branch')) callback(null, 'main\n');
          else if (args.includes('status')) callback(null, '## main...origin/main\n M src/app.ts\n');
          else if (args.includes('diff')) callback(null, '2\t1\tsrc/app.ts\n');
          else callback(null, '');
          return;
        }
        if (cmd === 'gh') {
          throw Object.assign(new Error('spawn ENOTDIR'), { code: 'ENOTDIR' });
        }
        callback(new Error(`unexpected cmd: ${cmd}`), '');
      },
    );

    const cache = createGitStatusCache('/tmp/repo', { onChange });
    await vi.waitFor(() => {
      expect(cache.getStatus()).not.toBeNull();
    });
    // The gh throw is swallowed by readPullRequest's try/catch; git status still resolves.
    expect(cache.getStatus()).toMatchObject({
      branch: 'main',
      dirty: true,
      ahead: 0,
      behind: 0,
      diffAdded: 2,
      diffDeleted: 1,
    });
    expect(onChange).toHaveBeenCalled();
  });

  it('returns null when the working directory is not a git repo and formats badges', async () => {
    mocks.execFile.mockImplementation(
      (
        cmd: string,
        args: string[],
        _options: unknown,
        callback: (error: Error | null, stdout: string) => void,
      ) => {
        if (cmd === 'git' && args.includes('rev-parse')) {
          callback(new Error('not a git repository'), '');
          return;
        }
        callback(null, '');
      },
    );
    const cache = createGitStatusCache('/tmp/not-a-repo');
    await vi.waitFor(() => {
      expect(cache.getStatus()).toBeNull();
    });
    expect(
      formatGitBadge({
        branch: 'main',
        dirty: true,
        ahead: 2,
        behind: 1,
        diffAdded: 12,
        diffDeleted: 3,
        pullRequest: null,
      }),
    ).toBe('main [+12 -3 ↑2↓1]');
    expect(
      formatGitBadge({
        branch: 'main',
        dirty: true,
        ahead: 0,
        behind: 0,
        diffAdded: 0,
        diffDeleted: 0,
        pullRequest: null,
      }),
    ).toBe('main [±]');
  });

  it('formats pull request badges as terminal hyperlinks when requested', () => {
    const linked = formatGitBadge(
      {
        branch: 'feature/footer',
        dirty: false,
        ahead: 0,
        behind: 0,
        diffAdded: 0,
        diffDeleted: 0,
        pullRequest: {
          number: 12,
          url: 'https://github.com/acme/repo/pull/12',
        },
      },
      { linkPullRequest: true },
    );

    expect(linked).toContain('[PR#12]');
    expect(linked).toContain(']8;;https://github.com/acme/repo/pull/12');
    expect(linked).toContain(']8;;');
  });
});
