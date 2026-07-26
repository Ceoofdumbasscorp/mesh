import { test } from 'node:test';
import assert from 'node:assert/strict';
import { connect } from 'node:net';
import { mkdtempSync, rmSync, writeFileSync, existsSync, statSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { testClock } from '../src/clock.ts';
import { Registry } from '../src/registry.ts';
import { Journal } from '../src/journal.ts';
import { Mailbox } from '../src/mailbox.ts';
import { AskRegistry } from '../src/asks.ts';
import { Waiters } from '../src/daemon/waiters.ts';
import { MeshServer } from '../src/daemon/server.ts';
import { createFrameDecoder, encodeFrame } from '../src/protocol.ts';
import type { DaemonState } from '../src/daemon/handlers.ts';

function scratch(): string {
  return realpathSync(mkdtempSync(join(tmpdir(), 'mesh-server-')));
}

function makeState(base: string): DaemonState {
  const clock = testClock(1000);
  return {
    clock: clock.now,
    registry: new Registry({ clock: clock.now }),
    journal: new Journal(join(base, 'journal.jsonl'), clock.now),
    mailbox: new Mailbox({ clock: clock.now }),
    asks: new AskRegistry({ clock: clock.now }),
    waiters: new Waiters(),
  };
}

/** Minimal raw client: send requests, resolve each response by id. */
function rawClient(socketPath: string) {
  const socket = connect(socketPath);
  const decode = createFrameDecoder();
  const pending = new Map<number, (value: Record<string, unknown>) => void>();

  socket.on('data', (chunk) => {
    for (const frame of decode(chunk)) {
      const res = frame as Record<string, unknown>;
      const resolve = pending.get(res.id as number);
      if (resolve) {
        pending.delete(res.id as number);
        resolve(res);
      }
    }
  });

  return {
    socket,
    ready: once(socket, 'connect'),
    request(payload: Record<string, unknown>): Promise<Record<string, unknown>> {
      return new Promise((resolve) => {
        pending.set(payload.id as number, resolve);
        socket.write(encodeFrame(payload));
      });
    },
    close(): Promise<unknown> {
      socket.end();
      return once(socket, 'close');
    },
  };
}

test('serves a request over a real socket', async () => {
  const base = scratch();
  const socketPath = join(base, 'mesh.sock');
  const server = new MeshServer({ socketPath, state: makeState(base) });
  await server.start();

  const client = rawClient(socketPath);
  await client.ready;
  try {
    const res = await client.request({ id: 1, op: 'ping' });
    assert.equal(res.ok, true);
    assert.equal(res.at, 1000);
  } finally {
    await client.close();
    await server.close();
    rmSync(base, { recursive: true, force: true });
  }
});

test('creates the socket with 0600 permissions', async () => {
  const base = scratch();
  const socketPath = join(base, 'mesh.sock');
  const server = new MeshServer({ socketPath, state: makeState(base) });
  await server.start();
  try {
    assert.equal(statSync(socketPath).mode & 0o777, 0o600);
  } finally {
    await server.close();
    rmSync(base, { recursive: true, force: true });
  }
});

test('replaces a stale socket file left by a killed daemon', async () => {
  const base = scratch();
  const socketPath = join(base, 'mesh.sock');
  writeFileSync(socketPath, 'stale');

  const server = new MeshServer({ socketPath, state: makeState(base) });
  await server.start();

  const client = rawClient(socketPath);
  await client.ready;
  try {
    const res = await client.request({ id: 1, op: 'ping' });
    assert.equal(res.ok, true);
  } finally {
    await client.close();
    await server.close();
    rmSync(base, { recursive: true, force: true });
  }
});

test('two clients registered on one workspace see each other', async () => {
  const base = scratch();
  const socketPath = join(base, 'mesh.sock');
  const server = new MeshServer({ socketPath, state: makeState(base) });
  await server.start();

  const a = rawClient(socketPath);
  const b = rawClient(socketPath);
  await Promise.all([a.ready, b.ready]);

  try {
    await a.request({ id: 1, op: 'register', sessionId: 'sa', provider: 'claude', cwd: base });
    await b.request({ id: 1, op: 'register', sessionId: 'sb', provider: 'codex', cwd: base });

    const who = await a.request({ id: 2, op: 'who', cwd: base });
    const agents = who.agents as Array<Record<string, unknown>>;
    assert.deepEqual(agents.map((x) => x.name), ['claude-1', 'codex-1']);
  } finally {
    await a.close();
    await b.close();
    await server.close();
    rmSync(base, { recursive: true, force: true });
  }
});

test('a transient connection closing does NOT unregister the agent', async () => {
  const base = scratch();
  const socketPath = join(base, 'mesh.sock');
  const server = new MeshServer({ socketPath, state: makeState(base) });
  await server.start();

  const owner = rawClient(socketPath);
  const hook = rawClient(socketPath);
  await Promise.all([owner.ready, hook.ready]);

  try {
    // The MCP server: one long-lived owning connection per session.
    await owner.request({ id: 1, op: 'register', sessionId: 'sa', provider: 'claude', cwd: base, own: true });
    // A hook firing: connect, report, disconnect — on every single tool call.
    await hook.request({ id: 1, op: 'register', sessionId: 'sa', provider: 'claude', cwd: base });
    await hook.close();
    await new Promise((resolve) => setImmediate(resolve));

    const who = await owner.request({ id: 2, op: 'who', cwd: base });
    const agents = who.agents as Array<Record<string, unknown>>;
    assert.deepEqual(agents.map((x) => x.name), ['claude-1'], 'the agent survives its hook disconnecting');
  } finally {
    await owner.close();
    await server.close();
    rmSync(base, { recursive: true, force: true });
  }
});

test('closing an owning connection unregisters its agent', async () => {
  const base = scratch();
  const socketPath = join(base, 'mesh.sock');
  const server = new MeshServer({ socketPath, state: makeState(base) });
  await server.start();

  const a = rawClient(socketPath);
  const b = rawClient(socketPath);
  await Promise.all([a.ready, b.ready]);

  try {
    await a.request({ id: 1, op: 'register', sessionId: 'sa', provider: 'claude', cwd: base, own: true });
    await b.request({ id: 1, op: 'register', sessionId: 'sb', provider: 'codex', cwd: base, own: true });

    await a.close();
    // Give the server's close handler a turn to run.
    await new Promise((resolve) => setImmediate(resolve));

    const who = await b.request({ id: 2, op: 'who', cwd: base });
    const agents = who.agents as Array<Record<string, unknown>>;
    assert.deepEqual(agents.map((x) => x.name), ['codex-1'], 'the departed agent is gone');
  } finally {
    await b.close();
    await server.close();
    rmSync(base, { recursive: true, force: true });
  }
});

test('a malformed frame closes that connection without killing the server', async () => {
  const base = scratch();
  const socketPath = join(base, 'mesh.sock');
  const server = new MeshServer({ socketPath, state: makeState(base) });
  await server.start();

  const bad = rawClient(socketPath);
  await bad.ready;
  bad.socket.write('this is not json\n');
  await once(bad.socket, 'close');

  const good = rawClient(socketPath);
  await good.ready;
  try {
    const res = await good.request({ id: 1, op: 'ping' });
    assert.equal(res.ok, true, 'server survived the bad client');
  } finally {
    await good.close();
    await server.close();
    rmSync(base, { recursive: true, force: true });
  }
});

test('close removes the socket file', async () => {
  const base = scratch();
  const socketPath = join(base, 'mesh.sock');
  const server = new MeshServer({ socketPath, state: makeState(base) });
  await server.start();
  await server.close();
  try {
    assert.equal(existsSync(socketPath), false);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});
