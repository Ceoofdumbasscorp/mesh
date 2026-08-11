import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MeshServer, createDaemonState } from '../src/daemon/server.ts';
import { MeshClient } from '../src/client.ts';

async function withDaemon<T>(fn: (socketPath: string, base: string) => Promise<T>): Promise<T> {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'mesh-identity-')));
  const socketPath = join(base, 'mesh.sock');
  const server = new MeshServer({
    socketPath,
    state: {
      ...createDaemonState({ journalPath: join(base, 'journal.jsonl') }),
      // These tests register invented pids. Without this the reaper correctly
      // evicts them as dead processes, which is a different test's subject.
      isAlive: () => true,
    },
  });
  await server.start();
  try {
    return await fn(socketPath, base);
  } finally {
    await server.close();
    rmSync(base, { recursive: true, force: true });
  }
}

test('an MCP server and a hook for one session produce one agent', async () => {
  await withDaemon(async (socketPath, base) => {
    // The MCP server connects first with no id from its host, and owns the
    // session's lifetime.
    const mcp = await MeshClient.open({ socketPath, autostart: false });
    assert.ok(mcp);
    const owner = await mcp.request('register', {
      sessionId: 'pid-4242',
      provider: 'codex',
      cwd: base,
      pid: 4242,
      own: true,
    });

    // Then a tool call fires the hook, which knows the host's real id.
    const hook = await MeshClient.open({ socketPath, autostart: false });
    assert.ok(hook);
    await hook.request('register', {
      sessionId: '019fa0a8-8039-70c3',
      provider: 'codex',
      cwd: base,
      pid: 4242,
      capability: owner.capability,
    });
    await hook.request('touch', { activity: 'Edit server.ts' });
    hook.close();

    const who = await mcp.request('who', { cwd: base });
    const agents = (who.agents ?? []) as Array<Record<string, unknown>>;
    assert.equal(agents.length, 1, 'one session is one row in mesh who');
    assert.equal(agents[0]?.activity, 'Edit server.ts', 'the hook reports for the merged agent');

    // The owning connection closing is the liveness signal, even though that
    // connection only ever knew the provisional id.
    mcp.close();
    await new Promise((resolve) => setTimeout(resolve, 100));

    const observer = await MeshClient.open({ socketPath, autostart: false });
    assert.ok(observer);
    const after = await observer.request('who', { cwd: base });
    assert.equal(((after.agents ?? []) as unknown[]).length, 0, 'the agent is gone when it dies');
    observer.close();
  });
});

test('a claim survives the merge, because the agent keeps its name', async () => {
  await withDaemon(async (socketPath, base) => {
    const mcp = await MeshClient.open({ socketPath, autostart: false });
    assert.ok(mcp);
    const owner = await mcp.request('register', {
      sessionId: 'pid-4242', provider: 'codex', cwd: base, pid: 4242, own: true,
    });
    const claimed = await mcp.request('claim', {
      sessionId: 'pid-4242', patterns: ['server/**'], mode: 'exclusive',
    });
    assert.equal(claimed.ok, true);

    // The hook arrives with the real id and adopts the same agent.
    const hook = await MeshClient.open({ socketPath, autostart: false });
    assert.ok(hook);
    await hook.request('register', {
      sessionId: 'real-1', provider: 'codex', cwd: base, pid: 4242, capability: owner.capability,
    });

    const claims = await mcp.request('claims', { cwd: base });
    const rows = (claims.claims ?? []) as Array<Record<string, unknown>>;
    assert.equal(rows.length, 1, 'the claim is not stranded by the id change');
    assert.equal(rows[0]?.holder, 'codex-1');

    hook.close();
    mcp.close();
  });
});

test('a rotated real session id stays one agent over the daemon protocol', async () => {
  await withDaemon(async (socketPath, base) => {
    const mcp = await MeshClient.open({ socketPath, autostart: false });
    const hook = await MeshClient.open({ socketPath, autostart: false });
    assert.ok(mcp && hook);

    const owner = await mcp.request('register', {
      sessionId: 'launch-id',
      provider: 'claude',
      cwd: base,
      pid: 98940,
      own: true,
    });
    const claimed = await mcp.request('claim', {
      sessionId: 'launch-id',
      patterns: ['engine/**'],
      mode: 'exclusive',
    });
    assert.equal(claimed.ok, true);

    // /clear, /resume and compaction rotate Claude's real session id without
    // restarting its host or the MCP server. The next transient hook therefore
    // reports a second real id for the same pid.
    await hook.request('register', {
      sessionId: 'rotated-id',
      provider: 'claude',
      cwd: base,
      pid: 98940,
      capability: owner.capability,
    });
    await hook.request('touch', {
      activity: 'Edit engine.ts',
    });

    const who = await mcp.request('who', { cwd: base });
    const agents = (who.agents ?? []) as Array<Record<string, unknown>>;
    assert.equal(agents.length, 1, 'the protocol must not expose a split identity');
    assert.equal(agents[0]?.activity, 'Edit engine.ts', 'the rotated id resolves to the owner');

    const claims = await hook.request('claims', { cwd: base });
    const rows = (claims.claims ?? []) as Array<Record<string, unknown>>;
    assert.equal(rows.length, 1, 'the original id claim survives the rotation');
    assert.equal(rows[0]?.holder, agents[0]?.name);

    // Closing the transient hook must not evict the merged agent. Closing the
    // lifetime-owning MCP connection still must.
    hook.close();
    await new Promise((resolve) => setTimeout(resolve, 25));
    const beforeOwnerClose = await mcp.request('who', { cwd: base });
    assert.equal(((beforeOwnerClose.agents ?? []) as unknown[]).length, 1);

    mcp.close();
    await new Promise((resolve) => setTimeout(resolve, 100));
    const observer = await MeshClient.open({ socketPath, autostart: false });
    assert.ok(observer);
    const afterOwnerClose = await observer.request('who', { cwd: base });
    assert.equal(((afterOwnerClose.agents ?? []) as unknown[]).length, 0);
    observer.close();
  });
});

test('two genuinely different sessions on one workspace stay two agents', async () => {
  await withDaemon(async (socketPath, base) => {
    const a = await MeshClient.open({ socketPath, autostart: false });
    const b = await MeshClient.open({ socketPath, autostart: false });
    assert.ok(a && b);

    await a.request('register', {
      sessionId: 'session-a', provider: 'claude', cwd: base, pid: 100, own: true,
    });
    await b.request('register', {
      sessionId: 'session-b', provider: 'codex', cwd: base, pid: 200, own: true,
    });

    const who = await a.request('who', { cwd: base });
    assert.equal(((who.agents ?? []) as unknown[]).length, 2);
    a.close();
    b.close();
  });
});
