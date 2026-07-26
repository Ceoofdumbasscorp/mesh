import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { testClock } from '../src/clock.ts';
import { Registry } from '../src/registry.ts';
import { Journal } from '../src/journal.ts';
import { Mailbox } from '../src/mailbox.ts';
import { AskRegistry } from '../src/asks.ts';
import { ClaimTable } from '../src/claims.ts';
import { Waiters } from '../src/daemon/waiters.ts';
import { MeshServer } from '../src/daemon/server.ts';
import { MeshClient } from '../src/client.ts';
import type { DaemonState } from '../src/daemon/handlers.ts';

function scratch(): string {
  return realpathSync(mkdtempSync(join(tmpdir(), 'mesh-client-')));
}

function makeState(base: string): DaemonState {
  const clock = testClock(1000);
  return {
    clock: clock.now,
    registry: new Registry({ clock: clock.now }),
    journal: new Journal(join(base, 'journal.jsonl'), clock.now),
    mailbox: new Mailbox({ clock: clock.now }),
    asks: new AskRegistry({ clock: clock.now }),
    claims: new ClaimTable({ clock: clock.now }),
    waiters: new Waiters(),
  };
}

test('open returns null when no daemon is listening and autostart is off', async () => {
  const base = scratch();
  try {
    const client = await MeshClient.open({
      socketPath: join(base, 'nothing.sock'),
      autostart: false,
      connectTimeoutMs: 100,
    });
    assert.equal(client, null, 'absence is a normal outcome, not an exception');
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test('request round-trips against a live daemon', async () => {
  const base = scratch();
  const socketPath = join(base, 'mesh.sock');
  const server = new MeshServer({ socketPath, state: makeState(base) });
  await server.start();

  const client = await MeshClient.open({ socketPath, autostart: false });
  assert.ok(client, 'client should connect');
  try {
    const res = await client.request('ping');
    assert.equal(res.ok, true);
    assert.equal(res.at, 1000);
  } finally {
    client.close();
    await server.close();
    rmSync(base, { recursive: true, force: true });
  }
});

test('correlates concurrent requests by id', async () => {
  const base = scratch();
  const socketPath = join(base, 'mesh.sock');
  const server = new MeshServer({ socketPath, state: makeState(base) });
  await server.start();

  const client = await MeshClient.open({ socketPath, autostart: false });
  assert.ok(client);
  try {
    const [ping, who, bad] = await Promise.all([
      client.request('ping'),
      client.request('who', { cwd: base }),
      client.request('nonsense'),
    ]);
    assert.equal(ping.ok, true);
    assert.equal(who.ok, true);
    assert.equal(bad.ok, false);
    assert.notEqual(ping.id, who.id, 'ids must be distinct');
  } finally {
    client.close();
    await server.close();
    rmSync(base, { recursive: true, force: true });
  }
});

test('registering through the client makes the agent visible to who', async () => {
  const base = scratch();
  const socketPath = join(base, 'mesh.sock');
  const server = new MeshServer({ socketPath, state: makeState(base) });
  await server.start();

  const client = await MeshClient.open({ socketPath, autostart: false });
  assert.ok(client);
  try {
    const reg = await client.request('register', {
      sessionId: 's1', provider: 'claude', cwd: base, role: 'frontend',
    });
    assert.equal(reg.name, 'claude-1');

    const who = await client.request('who', { cwd: base });
    const agents = who.agents as Array<Record<string, unknown>>;
    assert.equal(agents.length, 1);
    assert.equal(agents[0]?.role, 'frontend');
  } finally {
    client.close();
    await server.close();
    rmSync(base, { recursive: true, force: true });
  }
});

test('autostart launches a daemon when none is running', async () => {
  const base = scratch();
  const socketPath = join(base, 'mesh.sock');
  try {
    const client = await MeshClient.open({
      socketPath,
      autostart: true,
      journalPath: join(base, 'journal.jsonl'),
      connectTimeoutMs: 5000,
    });
    assert.ok(client, 'autostart should produce a usable client');

    const res = await client.request('ping');
    assert.equal(res.ok, true);

    // Shut the spawned daemon down so it does not outlive the test run.
    await client.request('shutdown');
    client.close();
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test('requests after close are rejected rather than hanging', async () => {
  const base = scratch();
  const socketPath = join(base, 'mesh.sock');
  const server = new MeshServer({ socketPath, state: makeState(base) });
  await server.start();

  const client = await MeshClient.open({ socketPath, autostart: false });
  assert.ok(client);
  client.close();
  try {
    await assert.rejects(() => client.request('ping'), /closed/);
  } finally {
    await server.close();
    rmSync(base, { recursive: true, force: true });
  }
});
