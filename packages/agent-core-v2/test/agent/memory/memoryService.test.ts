/**
 * Scenario: agent memory scope binding — the default `'user'` scope keeps the
 * historical file path (regression red line: identical to the pre-scope
 * behavior), `'project'` moves the file under
 * `<memoryDir>/projects/<projectKey>/MEMORY.md`, and `loadMemoryText` reads the
 * scope-bound file only.
 * Run: `pnpm --filter @moonshot-ai/agent-core-v2 exec vitest run
 * test/agent/memory/memoryService.test.ts`.
 */

import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'pathe';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { encodeWorkDirKey } from '#/_base/utils/workdir-slug';
import {
  DEFAULT_MEMORY_SCOPE,
  IMemoryService,
  MEMORY_SECTION_HEADING,
} from '#/agent/memory/memory';
import { ISessionContext } from '#/session/sessionContext/sessionContext';
import { createTestAgent, hostEnvironmentServices, type TestAgentContext } from '../../harness';

describe('AgentMemoryService scope', () => {
  let ctx: TestAgentContext;
  let homeDir: string;

  beforeEach(async () => {
    homeDir = await mkdtemp(join(tmpdir(), 'kimi-memory-home-'));
  });

  afterEach(async () => {
    await ctx?.dispose();
    await rm(homeDir, { recursive: true, force: true });
  });

  function buildContext(): { context: TestAgentContext; memory: IMemoryService } {
    ctx = createTestAgent(hostEnvironmentServices(homeDir));
    return { context: ctx, memory: ctx.get(IMemoryService) };
  }

  it('defaults to the user scope and keeps the historical file path', () => {
    const { memory } = buildContext();

    expect(memory.memoryScope()).toBe(DEFAULT_MEMORY_SCOPE);
    expect(memory.memoryFilePath()).toBe(join(memory.memoryDir(), 'MEMORY.md'));
  });

  it('moves the file under projects/<projectKey>/ in the project scope', () => {
    const { context, memory } = buildContext();
    const cwd = context.get(ISessionContext).cwd;

    memory.setScope('project');

    expect(memory.memoryScope()).toBe('project');
    expect(memory.memoryFilePath()).toBe(
      join(memory.memoryDir(), 'projects', encodeWorkDirKey(cwd), 'MEMORY.md'),
    );
  });

  it('reads the scope-bound file and ignores the other scope file', async () => {
    const { context, memory } = buildContext();
    const cwd = context.get(ISessionContext).cwd;
    const userFile = join(memory.memoryDir(), 'MEMORY.md');
    const projectFile = join(
      memory.memoryDir(),
      'projects',
      encodeWorkDirKey(cwd),
      'MEMORY.md',
    );
    await mkdir(dirname(projectFile), { recursive: true });
    await writeFile(userFile, `${MEMORY_SECTION_HEADING}\n\nuser note\n`, 'utf8');
    await writeFile(projectFile, `${MEMORY_SECTION_HEADING}\n\nproject note\n`, 'utf8');

    expect(await memory.loadMemoryText()).toContain('user note');

    memory.setScope('project');
    expect(await memory.loadMemoryText()).toContain('project note');

    memory.setScope('user');
    expect(await memory.loadMemoryText()).toContain('user note');
  });
});
