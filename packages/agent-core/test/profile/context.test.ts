import { mkdir, mkdtemp, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'pathe';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { loadAgentsMd, prepareSystemPromptContext } from '../../src/profile/context';
import { testKaos } from '../fixtures/test-kaos';

let homeDir: string;
let workDir: string;
let extraDirs: string[];

beforeEach(async () => {
  homeDir = await mkdtemp(join(tmpdir(), 'kimi-agents-home-'));
  workDir = await mkdtemp(join(tmpdir(), 'kimi-agents-work-'));
  extraDirs = [];
  vi.spyOn(testKaos, 'gethome').mockReturnValue(homeDir);
  vi.spyOn(testKaos, 'getcwd').mockReturnValue(workDir);
});

afterEach(async () => {
  vi.restoreAllMocks();
  await rm(homeDir, { recursive: true, force: true });
  await rm(workDir, { recursive: true, force: true });
  await Promise.all(extraDirs.map((dir) => rm(dir, { recursive: true, force: true })));
});

describe('loadAgentsMd user-level discovery', () => {
  it('loads user-level branded and generic files before project-level', async () => {
    await mkdir(join(homeDir, '.kimi-code'), { recursive: true });
    await writeFile(join(homeDir, '.kimi-code', 'AGENTS.md'), 'user branded', 'utf-8');
    await mkdir(join(homeDir, '.agents'), { recursive: true });
    await writeFile(join(homeDir, '.agents', 'AGENTS.md'), 'user generic', 'utf-8');
    await writeFile(join(workDir, 'AGENTS.md'), 'project instructions', 'utf-8');

    const result = await loadAgentsMd(testKaos);

    expect(result).toContain('user branded');
    expect(result).toContain('user generic');
    expect(result).toContain('project instructions');
    expect(result.indexOf('user branded')).toBeLessThan(result.indexOf('user generic'));
    expect(result.indexOf('user generic')).toBeLessThan(result.indexOf('project instructions'));
  });

  it('loads generic user-level .agents/AGENTS.md', async () => {
    await mkdir(join(homeDir, '.agents'), { recursive: true });
    await writeFile(join(homeDir, '.agents', 'AGENTS.md'), 'dot-agents generic', 'utf-8');

    const result = await loadAgentsMd(testKaos);

    expect(result).toContain('dot-agents generic');
  });

  it('falls back to project-level only when no user-level files exist', async () => {
    await writeFile(join(workDir, 'AGENTS.md'), 'project only', 'utf-8');

    const result = await loadAgentsMd(testKaos);

    expect(result).toContain('project only');
    expect(result).not.toContain(homeDir);
  });

  it('does not load the same file twice when the work dir is the home dir', async () => {
    vi.spyOn(testKaos, 'getcwd').mockReturnValue(homeDir);
    await mkdir(join(homeDir, '.kimi-code'), { recursive: true });
    await writeFile(join(homeDir, '.kimi-code', 'AGENTS.md'), 'home branded', 'utf-8');

    const result = await loadAgentsMd(testKaos);

    expect(result.split('home branded').length - 1).toBe(1);
  });
});

describe('loadAgentsMd brand home (KIMI_CODE_HOME)', () => {
  let brandHome: string;

  beforeEach(async () => {
    brandHome = await mkdtemp(join(tmpdir(), 'kimi-agents-brand-'));
  });

  afterEach(async () => {
    await rm(brandHome, { recursive: true, force: true });
  });

  it('loads the branded AGENTS.md from the brand home and generic from the real home', async () => {
    await writeFile(join(brandHome, 'AGENTS.md'), 'brand home instructions', 'utf-8');
    await mkdir(join(homeDir, '.agents'), { recursive: true });
    await writeFile(join(homeDir, '.agents', 'AGENTS.md'), 'real home generic', 'utf-8');

    const result = await loadAgentsMd(testKaos, brandHome);

    expect(result).toContain('brand home instructions');
    expect(result).toContain('real home generic');
  });

  it('ignores the real-home .kimi-code/AGENTS.md when the brand home is elsewhere', async () => {
    await writeFile(join(brandHome, 'AGENTS.md'), 'brand wins', 'utf-8');
    await mkdir(join(homeDir, '.kimi-code'), { recursive: true });
    await writeFile(join(homeDir, '.kimi-code', 'AGENTS.md'), 'stale real-home brand', 'utf-8');

    const result = await loadAgentsMd(testKaos, brandHome);

    expect(result).toContain('brand wins');
    expect(result).not.toContain('stale real-home brand');
  });

  it('falls back to the real-home .kimi-code/AGENTS.md when no brand home is given', async () => {
    await mkdir(join(homeDir, '.kimi-code'), { recursive: true });
    await writeFile(join(homeDir, '.kimi-code', 'AGENTS.md'), 'fallback branded', 'utf-8');

    const result = await loadAgentsMd(testKaos);

    expect(result).toContain('fallback branded');
  });
});

describe('loadAgentsMd oversized content', () => {
  it('keeps the full content when AGENTS.md exceeds the recommended size', async () => {
    const largeContent = 'x'.repeat(40 * 1024);
    await writeFile(join(workDir, 'AGENTS.md'), largeContent, 'utf-8');

    const result = await loadAgentsMd(testKaos);

    expect(result).toContain(largeContent);
    expect(result).not.toContain('truncated or omitted');
  });
});

describe('prepareSystemPromptContext AGENTS.md size warning', () => {
  it('returns agentsMdWarning and keeps full content when oversized', async () => {
    const brandHome = await mkdtemp(join(tmpdir(), 'kimi-agents-brand-'));
    extraDirs.push(brandHome);
    const largeContent = 'x'.repeat(40 * 1024);
    await writeFile(join(workDir, 'AGENTS.md'), largeContent, 'utf-8');

    const result = await prepareSystemPromptContext(testKaos, brandHome);

    expect(result.agentsMd).toContain(largeContent);
    expect(result.agentsMdWarning).toBeDefined();
    expect(result.agentsMdWarning).toContain('exceeds the recommended');
  });

  it('does not return agentsMdWarning when within the recommended size', async () => {
    const brandHome = await mkdtemp(join(tmpdir(), 'kimi-agents-brand-'));
    extraDirs.push(brandHome);
    await writeFile(join(workDir, 'AGENTS.md'), 'small instructions', 'utf-8');

    const result = await prepareSystemPromptContext(testKaos, brandHome);

    expect(result.agentsMdWarning).toBeUndefined();
  });
});

describe('prepareSystemPromptContext additional directories', () => {
  it('includes additional directory listings without loading their AGENTS.md', async () => {
    const brandHome = await mkdtemp(join(tmpdir(), 'kimi-agents-empty-brand-'));
    extraDirs.push(brandHome);
    const extraDir = await mkdtemp(join(tmpdir(), 'kimi-agents-extra-'));
    extraDirs.push(extraDir);

    await writeFile(join(workDir, 'AGENTS.md'), 'repo project instructions', 'utf-8');
    await writeFile(join(extraDir, 'AGENTS.md'), 'extra project instructions', 'utf-8');
    await writeFile(join(extraDir, 'extra-file.txt'), 'extra listing entry', 'utf-8');

    const result = await prepareSystemPromptContext(testKaos, brandHome, {
      additionalDirs: [extraDir],
    });

    const agentsMd = result.agentsMd ?? '';

    expect(result.cwdListing).toBeTypeOf('string');
    expect(result.additionalDirsInfo).toContain(`### ${extraDir}`);
    expect(result.additionalDirsInfo).toContain('extra-file.txt');
    expect(agentsMd).toContain('repo project instructions');
    expect(agentsMd).not.toContain('extra project instructions');
    expect(agentsMd.split('<!-- From:').length - 1).toBe(1);
  });

  it('loads user-level AGENTS.md once and skips additional directory AGENTS.md', async () => {
    const brandHome = await mkdtemp(join(tmpdir(), 'kimi-agents-empty-brand-'));
    extraDirs.push(brandHome);
    const extraDirA = await mkdtemp(join(tmpdir(), 'kimi-agents-extra-a-'));
    const extraDirB = await mkdtemp(join(tmpdir(), 'kimi-agents-extra-b-'));
    extraDirs.push(extraDirA, extraDirB);

    await mkdir(join(homeDir, '.agents'), { recursive: true });
    await writeFile(join(homeDir, '.agents', 'AGENTS.md'), 'shared user instructions', 'utf-8');
    await writeFile(join(extraDirA, 'AGENTS.md'), 'extra A instructions', 'utf-8');
    await writeFile(join(extraDirB, 'AGENTS.md'), 'extra B instructions', 'utf-8');

    const result = await prepareSystemPromptContext(testKaos, brandHome, {
      additionalDirs: [extraDirA, extraDirB],
    });

    const agentsMd = result.agentsMd ?? '';

    expect(result.additionalDirsInfo).toContain(`### ${extraDirA}`);
    expect(result.additionalDirsInfo).toContain(`### ${extraDirB}`);
    expect(agentsMd.split('shared user instructions').length - 1).toBe(1);
    expect(agentsMd).not.toContain('extra A instructions');
    expect(agentsMd).not.toContain('extra B instructions');
  });
});

describe('loadAgentsMd fingerprint cache', () => {
  it('does not re-read an unchanged AGENTS.md file', async () => {
    await writeFile(join(workDir, 'AGENTS.md'), 'project instructions', 'utf-8');
    const readSpy = vi.spyOn(testKaos, 'readText');

    const first = await loadAgentsMd(testKaos);
    expect(first).toContain('project instructions');
    expect(readSpy).toHaveBeenCalledTimes(1);

    // Nothing changed — the second call must reuse the cached text.
    const second = await loadAgentsMd(testKaos);
    expect(second).toBe(first);
    expect(readSpy).toHaveBeenCalledTimes(1);
  });

  it('re-reads a modified AGENTS.md file', async () => {
    await writeFile(join(workDir, 'AGENTS.md'), 'v1', 'utf-8');
    const readSpy = vi.spyOn(testKaos, 'readText');

    await loadAgentsMd(testKaos);
    await writeFile(join(workDir, 'AGENTS.md'), 'v2 much longer', 'utf-8');
    const second = await loadAgentsMd(testKaos);

    expect(second).toContain('v2 much longer');
    expect(second).not.toContain('v1');
    expect(readSpy).toHaveBeenCalledTimes(2);
  });

  it('reuses the cached text when only the mtime changes (touch)', async () => {
    await writeFile(join(workDir, 'AGENTS.md'), 'same content', 'utf-8');
    const first = await loadAgentsMd(testKaos);
    const readSpy = vi.spyOn(testKaos, 'readText');

    // `touch`: bump mtime without changing content.
    const now = new Date();
    await utimes(join(workDir, 'AGENTS.md'), now, new Date(now.getTime() + 2000));
    const second = await loadAgentsMd(testKaos);

    expect(second).toBe(first);
    // Fingerprint changed but the digest still matches: only the
    // confirmation read ran, and the previous text was reused.
    expect(readSpy).toHaveBeenCalledTimes(1);
  });
});
