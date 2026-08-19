import { createHash } from 'node:crypto';
import { dirname, join } from 'pathe';

import type { Kaos, StatResult } from '@moonshot-ai/kaos';

import { normalizeAdditionalDirs } from '../config';
import { listDirectory } from '../tools/support/list-directory';
import type { SystemPromptContext } from './types';

// Soft budget for the combined AGENTS.md content injected into the system
// prompt. ~32 KB is roughly 8K–20K tokens (≈1.5–3% of a 262144-token context),
// large enough to leave the bulk of the context window to the conversation
// while still catching accidental oversized instruction files. Exceeding it no
// longer truncates content; it only surfaces a user-visible warning so the user
// can trim oversized instruction files.
const AGENTS_MD_RECOMMENDED_MAX_BYTES = 32 * 1024;
const S_IFMT = 0o170000;
const S_IFREG = 0o100000;

export interface PreparedSystemPromptContext
  extends Pick<SystemPromptContext, 'cwdListing' | 'agentsMd' | 'additionalDirsInfo'> {
  /** Present when the combined AGENTS.md content exceeds the recommended size. */
  readonly agentsMdWarning?: string;
}

export interface PrepareSystemPromptContextOptions {
  readonly additionalDirs?: readonly string[];
}

export async function prepareSystemPromptContext(
  kaos: Kaos,
  brandHome?: string,
  options?: PrepareSystemPromptContextOptions,
): Promise<PreparedSystemPromptContext> {
  const additionalDirs = normalizeAdditionalDirs(options?.additionalDirs ?? []);
  const [cwdListing, agentsMdResult, additionalDirsInfo] = await Promise.all([
    listDirectory(kaos, undefined, { collapseHiddenDirs: true }),
    loadAgentsMdForRoots(kaos, brandHome, [kaos.getcwd()]),
    loadAdditionalDirsInfo(kaos, additionalDirs),
  ]);
  return {
    cwdListing,
    agentsMd: agentsMdResult.content,
    additionalDirsInfo,
    agentsMdWarning: agentsMdResult.warning,
  };
}

export async function loadAgentsMd(kaos: Kaos, brandHome?: string): Promise<string> {
  const result = await loadAgentsMdForRoots(kaos, brandHome, [kaos.getcwd()]);
  return result.content;
}

interface LoadedAgentsMd {
  readonly content: string;
  readonly warning: string | undefined;
}

async function loadAgentsMdForRoots(
  kaos: Kaos,
  brandHome: string | undefined,
  workDirs: readonly string[],
): Promise<LoadedAgentsMd> {
  const discovered: AgentFile[] = [];
  const seen = new Set<string>();

  const collect = async (path: string): Promise<boolean> => {
    const file = await readAgentFile(kaos, path);
    if (file === undefined) return false;
    const key = kaos.normpath(file.path);
    if (seen.has(key)) return false;
    seen.add(key);
    discovered.push(file);
    return true;
  };

  // User-level files come first so any project-level AGENTS.md overrides them.
  // The brand dir follows KIMI_CODE_HOME (default ~/.kimi-code); the generic
  // .agents dir stays under the real OS home so it can be shared across tools.
  const realHome = kaos.gethome();
  const brandDir = brandHome ?? join(realHome, '.kimi-code');
  await collect(join(brandDir, 'AGENTS.md'));

  // Generic user-level dir (.agents) matches skill discovery.
  const genericDirs = [join(realHome, '.agents')];
  const genericFiles = genericDirs.flatMap((dir) =>
    ['AGENTS.md', 'agents.md'].map((name) => join(dir, name)),
  );
  for (const file of genericFiles) {
    if (await collect(file)) break;
  }

  for (const workDir of workDirs) {
    const rootKaos = kaos.withCwd(workDir);
    const rootWorkDir = rootKaos.getcwd();
    const projectRoot = await findProjectRoot(rootKaos, rootWorkDir);
    const dirs = dirsRootToLeaf(rootKaos, rootWorkDir, projectRoot);

    for (const dir of dirs) {
      await collect(join(dir, '.kimi-code', 'AGENTS.md'));
      for (const fileName of ['AGENTS.md', 'agents.md']) {
        if (await collect(join(dir, fileName))) break;
      }
    }
  }

  const content = renderAgentFiles(discovered);
  const totalBytes = byteLength(content);
  const warning =
    totalBytes > AGENTS_MD_RECOMMENDED_MAX_BYTES
      ? `AGENTS.md total ${formatKB(totalBytes)} KB exceeds the recommended ` +
        `${formatKB(AGENTS_MD_RECOMMENDED_MAX_BYTES)} KB. Large instruction files ` +
        `increase cost and may impact performance; consider trimming.`
      : undefined;
  return { content, warning };
}

async function loadAdditionalDirsInfo(
  kaos: Kaos,
  additionalDirs: readonly string[],
): Promise<string> {
  const sections = await Promise.all(
    additionalDirs.map(async (dir) => {
      const listing = await listDirectory(kaos.withCwd(dir));
      return `### ${dir}\n${listing}`;
    }),
  );

  return sections.join('\n\n');
}

async function findProjectRoot(kaos: Kaos, workDir: string): Promise<string> {
  const initial = kaos.normpath(workDir);
  let current = initial;

  while (true) {
    if (await pathExists(kaos, join(current, '.git'))) return current;
    const parent = dirname(current);
    if (parent === current) return initial;
    current = parent;
  }
}

function dirsRootToLeaf(kaos: Kaos, workDir: string, projectRoot: string): string[] {
  const dirs: string[] = [];
  let current = kaos.normpath(workDir);

  while (true) {
    dirs.push(current);
    if (current === projectRoot) break;
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }

  return dirs.toReversed();
}

interface AgentFile {
  readonly path: string;
  readonly content: string;
}

/**
 * Fingerprint of an AGENTS.md file captured from a single stat. LocalKaos
 * exposes `stMtime` with sub-second precision, so alongside `stSize` it
 * catches essentially every real modification at stat cost alone.
 */
interface FsVersion {
  readonly stMtime: number;
  readonly stSize: number;
}

interface CachedAgentFile {
  readonly version: FsVersion;
  /** SHA-1 of the trimmed content — confirms whether a version change really changed bytes. */
  readonly digest: string;
  readonly content: string;
}

/**
 * Process-scoped cache keyed by normalized path (no cross-process
 * persistence). A file is only re-read when the FsVersion fingerprint
 * changed; a fingerprint change whose SHA-1 digest still matches (e.g.
 * `touch`) reuses the previous text.
 */
const agentsMdFileCache = new Map<string, CachedAgentFile>();

function fsVersionMatches(a: FsVersion, b: FsVersion): boolean {
  return a.stMtime === b.stMtime && a.stSize === b.stSize;
}

async function readAgentFile(kaos: Kaos, path: string): Promise<AgentFile | undefined> {
  const key = kaos.normpath(path);

  let stat: StatResult;
  try {
    stat = await kaos.stat(path);
  } catch {
    agentsMdFileCache.delete(key);
    return undefined;
  }
  if ((stat.stMode & S_IFMT) !== S_IFREG) {
    agentsMdFileCache.delete(key);
    return undefined;
  }

  const version: FsVersion = { stMtime: stat.stMtime, stSize: stat.stSize };
  const cached = agentsMdFileCache.get(key);
  if (cached !== undefined && fsVersionMatches(cached.version, version)) {
    return { path, content: cached.content };
  }

  const content = (await kaos.readText(path, { errors: 'ignore' })).trim();
  if (content.length === 0) {
    agentsMdFileCache.delete(key);
    return undefined;
  }

  const digest = sha1(content);
  if (cached !== undefined && cached.digest === digest) {
    // Fingerprint changed but the bytes did not: reuse the cached text and
    // refresh the fingerprint so the next call skips the read entirely.
    agentsMdFileCache.set(key, { version, digest, content: cached.content });
    return { path, content: cached.content };
  }

  agentsMdFileCache.set(key, { version, digest, content });
  return { path, content };
}

function sha1(text: string): string {
  return createHash('sha1').update(text, 'utf8').digest('hex');
}

async function pathExists(kaos: Kaos, path: string): Promise<boolean> {
  try {
    await kaos.stat(path);
    return true;
  } catch {
    return false;
  }
}

function renderAgentFiles(files: readonly AgentFile[]): string {
  if (files.length === 0) return '';
  return files.map((file) => `${annotationFor(file.path)}${file.content}`).join('\n\n');
}

function byteLength(text: string): number {
  return Buffer.byteLength(text, 'utf8');
}

function formatKB(bytes: number): string {
  const kb = bytes / 1024;
  return Number.isInteger(kb) ? String(kb) : kb.toFixed(1);
}

function annotationFor(path: string): string {
  return `<!-- From: ${path} -->\n`;
}
