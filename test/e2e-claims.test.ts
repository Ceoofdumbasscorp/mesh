import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MeshServer, createDaemonState } from '../src/daemon/server.ts';
import { MeshClient } from '../src/client.ts';

async function withDaemon<T>(fn: (socketPath: string, base: string) => Promise<T>): Promise<T> {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'mesh-e2e-claims-')));
  const socketPath = join(base, 'mesh.sock');
  const server = new MeshServer({
    socketPath,
    state: createDaemonState({ journalPath: join(base, 'journal.jsonl') }),
  });
  await server.start();
  try {
    return await fn(socketPath, base);
  } finally {
    await server.close();
    rmSync(base, { recursive: true, force: true });
  }
}

test('a claimed path is blocked for another agent and allowed for the holder', async () => {
  await withDaemon(async (socketPath, base) => {
    const claude = await MeshClient.open({ socketPath, autostart: false });
    const codex = await MeshClient.open({ socketPath, autostart: false });
    assert.ok(claude && codex);

    await claude.request('register', {
      sessionId: 'sa', provider: 'claude', cwd: base, role: 'frontend', own: true,
    });
    await codex.request('register', {
      sessionId: 'sb', provider: 'codex', cwd: base, role: 'backend', own: true,
    });

    const claimed = await codex.request('claim', { patterns: ['server/**'] });
    assert.equal(claimed.ok, true);

    const denied = await claude.request('check', { path: 'server/api/leads.ts' });
    assert.equal(denied.allowed, false);
    assert.match(String(denied.reason), /codex-1/);
    assert.match(String(denied.reason), /mesh release --force/);

    const allowedForHolder = await codex.request('check', { path: 'server/api/leads.ts' });
    assert.equal(allowedForHolder.allowed, true);

    const elsewhere = await claude.request('check', { path: 'app/page.tsx' });
    assert.equal(elsewhere.allowed, true);

    claude.close();
    codex.close();
  });
});

test('the blocked agent can ask the holder and then proceed after release', async () => {
  await withDaemon(async (socketPath, base) => {
    const claude = await MeshClient.open({ socketPath, autostart: false });
    const codex = await MeshClient.open({ socketPath, autostart: false });
    assert.ok(claude && codex);

    await claude.request('register', { sessionId: 'sa', provider: 'claude', cwd: base, own: true });
    await codex.request('register', { sessionId: 'sb', provider: 'codex', cwd: base, own: true });
    await codex.request('touch', { activity: 'Edit server/api/leads.ts' });
    await codex.request('claim', { patterns: ['server/**'] });

    assert.equal((await claude.request('check', { path: 'server/api/leads.ts' })).allowed, false);

    // The denial told claude-1 to ask, so it asks.
    const asking = claude.request('ask', {
      to: 'codex-1', body: 'can I edit server/api/leads.ts?', timeoutMs: 5000,
    });
    const inbox = await codex.request('inbox');
    const askId = (inbox.messages as Array<Record<string, unknown>>)[0]?.askId;
    await codex.request('reply', { askId, body: 'yes, releasing it now' });
    assert.equal((await asking).state, 'answered');

    await codex.request('release', { patterns: ['server/**'] });
    assert.equal((await claude.request('check', { path: 'server/api/leads.ts' })).allowed, true);

    claude.close();
    codex.close();
  });
});

test('a departing agent releases its claims', async () => {
  await withDaemon(async (socketPath, base) => {
    const claude = await MeshClient.open({ socketPath, autostart: false });
    const codex = await MeshClient.open({ socketPath, autostart: false });
    assert.ok(claude && codex);

    await claude.request('register', { sessionId: 'sa', provider: 'claude', cwd: base, own: true });
    await codex.request('register', { sessionId: 'sb', provider: 'codex', cwd: base, own: true });
    await codex.request('claim', { patterns: ['server/**'] });
    assert.equal((await claude.request('check', { path: 'server/x.ts' })).allowed, false);

    codex.close();
    await new Promise((resolve) => setTimeout(resolve, 50));

    assert.equal(
      (await claude.request('check', { path: 'server/x.ts' })).allowed,
      true,
      'a dead agent must not hold paths hostage',
    );
    claude.close();
  });
});

test('force release breaks a claim held by an unresponsive agent', async () => {
  await withDaemon(async (socketPath, base) => {
    const claude = await MeshClient.open({ socketPath, autostart: false });
    const codex = await MeshClient.open({ socketPath, autostart: false });
    assert.ok(claude && codex);

    await claude.request('register', { sessionId: 'sa', provider: 'claude', cwd: base, own: true });
    await codex.request('register', { sessionId: 'sb', provider: 'codex', cwd: base, own: true });
    await codex.request('claim', { patterns: ['server/**'] });

    const forced = await claude.request('release', {
      patterns: ['server/**'], force: true, cwd: base,
    });
    assert.equal(forced.released, 1);
    assert.equal((await claude.request('check', { path: 'server/x.ts' })).allowed, true);

    claude.close();
    codex.close();
  });
});

test('mesh release --force works from a plain shell, which is not a registered agent', async () => {
  // The denial message tells the user to run `mesh release --force "<pattern>"`.
  // That command runs in their terminal, where nothing has registered — and
  // requiring a registered caller made the one documented escape hatch from a
  // stuck claim fail every single time.
  await withDaemon(async (socketPath, base) => {
    const agent = await MeshClient.open({ socketPath, autostart: false });
    assert.ok(agent);
    await agent.request('register', {
      sessionId: 'stuck', provider: 'codex', cwd: base, own: true,
    });
    await agent.request('claim', { patterns: ['server/**'], mode: 'exclusive' });

    // A human in a shell: connected, never registered.
    const shell = await MeshClient.open({ socketPath, autostart: false });
    assert.ok(shell);
    const forced = await shell.request('release', {
      patterns: ['server/**'], force: true, cwd: base,
    });

    assert.equal(forced.ok, true, forced.error ?? '');
    assert.equal(forced.released, 1, 'the claim is actually gone');

    const after = await shell.request('claims', { cwd: base });
    assert.equal(((after.claims ?? []) as unknown[]).length, 0);
    shell.close();
    agent.close();
  });
});

test('a non-forced release still requires a registered agent', async () => {
  await withDaemon(async (socketPath) => {
    const shell = await MeshClient.open({ socketPath, autostart: false });
    assert.ok(shell);
    const result = await shell.request('release', { patterns: ['x/**'] });
    assert.equal(result.ok, false, 'releasing your own claims needs an identity');
    shell.close();
  });
});

test('a claim held by a dead session stops blocking, and the ghost leaves mesh who', async () => {
  // An agent whose MCP server never started is registered by its hook alone,
  // so no connection close ever removes it. It used to sit in the registry
  // forever holding its claims — wedging every live agent out of those paths
  // with no way back except killing the daemon.
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'mesh-reap-')));
  const socketPath = join(base, 'mesh.sock');
  const dead = new Set<number>();
  const server = new MeshServer({
    socketPath,
    state: {
      ...createDaemonState({ journalPath: join(base, 'journal.jsonl') }),
      isAlive: (pid: number) => !dead.has(pid),
    },
  });
  await server.start();

  try {
    const ghost = await MeshClient.open({ socketPath, autostart: false });
    const live = await MeshClient.open({ socketPath, autostart: false });
    assert.ok(ghost && live);

    await ghost.request('register', {
      sessionId: 'ghost', provider: 'codex', cwd: base, pid: 4242,
    });
    await ghost.request('claim', {
      sessionId: 'ghost', patterns: ['server/**'], mode: 'exclusive',
    });
    await live.request('register', {
      sessionId: 'live', provider: 'claude', cwd: base, pid: 4243, own: true,
    });

    const blocked = await live.request('check', { sessionId: 'live', path: 'server/api.ts' });
    assert.equal(blocked.allowed, false, 'a live holder blocks, as it should');

    // The ghost's host process exits. Nothing closes its connection.
    dead.add(4242);

    const afterDeath = await live.request('check', { sessionId: 'live', path: 'server/api.ts' });
    assert.equal(afterDeath.allowed, true, 'a dead holder must not block a live agent');

    const who = await live.request('who', { cwd: base });
    const names = ((who.agents ?? []) as Array<{ name: string }>).map((a) => a.name);
    assert.deepEqual(names, ['claude-1'], 'the ghost is gone from mesh who');

    ghost.close();
    live.close();
  } finally {
    await server.close();
    rmSync(base, { recursive: true, force: true });
  }
});
