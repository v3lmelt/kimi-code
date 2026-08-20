import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { LifecycleScope } from '#/app/scopes';
import {
  ScopeActivation,
  _clearScopedRegistryForTests,
  registerScopedService,
} from '#/_base/di/scope';
import { createScopedTestHost, stubPair } from '#/_base/di/test';
import { IHostProcessService } from '#/os/interface/hostProcess';
import { HostProcessService } from '#/os/backends/node-local/hostProcessService';
import { ISessionProcessRunner } from '#/session/process/processRunner';
import { AgentProcessRunner, SessionProcessRunner } from '#/session/process/processRunnerService';
import { ISessionContext, makeSessionContext } from '#/session/sessionContext/sessionContext';
import { ISessionWorkspaceContext, makeAgentWorkspaceContext } from '#/session/workspaceContext/workspaceContext';
import { stubWorkspaceContext } from '../workspaceContext/stub-workspace-context';

async function collect(stream: Readable): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks).toString('utf8');
}

describe('SessionProcessRunner', () => {
  let dir: string;

  beforeEach(async () => {
    _clearScopedRegistryForTests();
    registerScopedService(
      LifecycleScope.App,
      IHostProcessService,
      HostProcessService,
      ScopeActivation.OnDemand,
      'hostProcess',
    );
    registerScopedService(
      LifecycleScope.Session,
      ISessionProcessRunner,
      SessionProcessRunner,
      ScopeActivation.OnDemand,
      'process',
    );
    registerScopedService(
      LifecycleScope.Agent,
      ISessionProcessRunner,
      AgentProcessRunner,
      ScopeActivation.OnDemand,
      'process',
    );
    dir = await mkdtemp(join(tmpdir(), 'procrunner-'));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  async function makeRunner(): Promise<ISessionProcessRunner> {
    const host = createScopedTestHost();
    const session = host.child(
      LifecycleScope.Session,
      's',
      [
        stubPair(
          ISessionContext,
          makeSessionContext({
            sessionId: 's',
            workspaceId: 'w',
            sessionDir: dir,
            sessionScope: 'sessions/w/s',
            cwd: dir,
          }),
        ),
      ],
    );
    return session.accessor.get(ISessionProcessRunner);
  }

  it('exec runs a command and captures stdout + exit code', async () => {
    const runner = await makeRunner();
    const proc = await runner.exec(['node', '-e', 'process.stdout.write("ok")']);
    const out = await collect(proc.stdout);
    expect(out).toBe('ok');
    expect(await proc.wait()).toBe(0);
    expect(proc.exitCode).toBe(0);
  });

  it('exec overlays per-call env', async () => {
    const runner = await makeRunner();
    const proc = await runner.exec(
      ['node', '-e', 'process.stdout.write(process.env.FOO ?? "")'],
      { env: { FOO: 'bar' } },
    );
    const out = await collect(proc.stdout);
    expect(out).toBe('bar');
    expect(await proc.wait()).toBe(0);
  });

  it('Agent runner defaults process cwd to the seeded workspace lease', async () => {
    const host = createScopedTestHost();
    const base = stubWorkspaceContext(dir);
    const isolated = await mkdtemp(join(tmpdir(), 'agent-procrunner-'));
    const session = host.child(
      LifecycleScope.Session,
      's',
      [
        stubPair(
          ISessionContext,
          makeSessionContext({
            sessionId: 's',
            workspaceId: 'w',
            sessionDir: dir,
            sessionScope: 'sessions/w/s',
            cwd: dir,
          }),
        ),
      ],
    );
    const agent = session.createChild(LifecycleScope.Agent, 'a', {
      seeds: [
        stubPair(
          ISessionWorkspaceContext,
          makeAgentWorkspaceContext(base, {
            leaseId: 'lease-a',
            mode: 'dedicated-worktree',
            state: 'active',
            path: isolated,
            workspaceRoot: dir,
            writable: true,
          }),
        ),
      ],
    });
    try {
      const proc = await agent.accessor
        .get(ISessionProcessRunner)
        .exec(['node', '-e', 'process.stdout.write(process.cwd())']);
      expect(await collect(proc.stdout)).toBe(isolated);
      expect(await proc.wait()).toBe(0);
    } finally {
      agent.dispose();
      host.dispose();
      await rm(isolated, { recursive: true, force: true });
    }
  });

  it('Agent workspace context rejects read-only writes and dedicated escapes', async () => {
    const base = stubWorkspaceContext(dir);
    const isolated = await mkdtemp(join(tmpdir(), 'agent-context-'));
    const readOnly = makeAgentWorkspaceContext(base, {
      leaseId: 'lease-readonly',
      mode: 'shared-readonly',
      state: 'active',
      path: isolated,
      workspaceRoot: dir,
      writable: false,
    });
    expect(() => readOnly.assertAllowed(join(isolated, 'file.txt'), 'write')).toThrow(
      /read-only/i,
    );
    const dedicated = makeAgentWorkspaceContext(base, {
      leaseId: 'lease-dedicated',
      mode: 'dedicated-worktree',
      state: 'active',
      path: isolated,
      workspaceRoot: dir,
      writable: true,
    });
    expect(() => dedicated.assertAllowed(join(dir, 'outside.txt'), 'write')).toThrow(
      /worktree/i,
    );
    expect(() => dedicated.assertAllowed(join(dir, 'outside.txt'), 'read')).toThrow(/worktree/i);
    expect(dedicated.isWithin(join(dir, 'outside.txt'))).toBe(false);
    expect(readOnly.assertAllowed(join(dir, 'source.txt'), 'read')).toBe(join(dir, 'source.txt'));
    await rm(isolated, { recursive: true, force: true });
  });
});
