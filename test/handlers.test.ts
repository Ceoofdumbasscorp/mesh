import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { testClock } from '../src/clock.ts';
import { Registry } from '../src/registry.ts';
import { Journal } from '../src/journal.ts';
import { handleRequest } from '../src/daemon/handlers.ts';
import type { ConnectionContext, DaemonState } from '../src/daemon/handlers.ts';

function setup() {
  const base = mkdtempSync(join(tmpdir(), 'mesh-handlers-'));
  const clock = testClock(1000);
  const state: DaemonState = {
    clock: clock.now,
    registry: new Registry({ clock: clock.now }),
    journal: new Journal(join(base, 'journal.jsonl'), clock.now),
  };
  const ctx: ConnectionContext = { sessionId: null, owns: false };
  return { base, clock, state, ctx, cleanup: () => rmSync(base, { recursive: true, force: true }) };
}

test('ping answers with ok and the daemon time', () => {
  const { state, ctx, cleanup } = setup();
  try {
    const res = handleRequest(state, ctx, { id: 1, op: 'ping' });
    assert.equal(res.ok, true);
    assert.equal(res.id, 1);
    assert.equal(res.at, 1000);
  } finally {
    cleanup();
  }
});

test('unknown op is rejected without throwing', () => {
  const { state, ctx, cleanup } = setup();
  try {
    const res = handleRequest(state, ctx, { id: 2, op: 'nonsense' });
    assert.equal(res.ok, false);
    assert.match(String(res.error), /Unknown op/);
  } finally {
    cleanup();
  }
});

test('a request missing op is rejected', () => {
  const { state, ctx, cleanup } = setup();
  try {
    const res = handleRequest(state, ctx, { id: 3 });
    assert.equal(res.ok, false);
    assert.match(String(res.error), /op/);
  } finally {
    cleanup();
  }
});

test('register assigns a name and binds the session to the connection', () => {
  const { state, ctx, cleanup } = setup();
  try {
    const res = handleRequest(state, ctx, {
      id: 4, op: 'register', sessionId: 's1', provider: 'claude', cwd: process.cwd(),
    });
    assert.equal(res.ok, true);
    assert.equal(res.name, 'claude-1');
    assert.equal(ctx.sessionId, 's1', 'connection remembers its agent for disconnect cleanup');
  } finally {
    cleanup();
  }
});

test('register requires sessionId and provider', () => {
  const { state, ctx, cleanup } = setup();
  try {
    const missingSession = handleRequest(state, ctx, { id: 5, op: 'register', provider: 'claude' });
    assert.equal(missingSession.ok, false);
    assert.match(String(missingSession.error), /sessionId/);

    const missingProvider = handleRequest(state, ctx, { id: 6, op: 'register', sessionId: 's1' });
    assert.equal(missingProvider.ok, false);
    assert.match(String(missingProvider.error), /provider/);
  } finally {
    cleanup();
  }
});

test('who lists peers in the caller workspace with status', () => {
  const { state, ctx, cleanup } = setup();
  try {
    const cwd = process.cwd();
    handleRequest(state, ctx, { id: 7, op: 'register', sessionId: 's1', provider: 'claude', cwd });
    handleRequest(state, { sessionId: null, owns: false }, {
      id: 8, op: 'register', sessionId: 's2', provider: 'codex', cwd, role: 'backend',
    });

    const res = handleRequest(state, ctx, { id: 9, op: 'who', cwd });
    assert.equal(res.ok, true);
    const agents = res.agents as Array<Record<string, unknown>>;
    assert.equal(agents.length, 2);
    assert.deepEqual(agents.map((a) => a.name), ['claude-1', 'codex-1']);
    assert.equal(agents[1]?.role, 'backend');
    assert.equal(agents[0]?.status, 'working');
  } finally {
    cleanup();
  }
});

test('touch updates activity and is reflected by who', () => {
  const { state, ctx, cleanup } = setup();
  try {
    const cwd = process.cwd();
    handleRequest(state, ctx, { id: 10, op: 'register', sessionId: 's1', provider: 'claude', cwd });
    const touched = handleRequest(state, ctx, {
      id: 11, op: 'touch', sessionId: 's1', activity: 'Edit app/page.tsx',
    });
    assert.equal(touched.ok, true);

    const res = handleRequest(state, ctx, { id: 12, op: 'who', cwd });
    const agents = res.agents as Array<Record<string, unknown>>;
    assert.equal(agents[0]?.activity, 'Edit app/page.tsx');
  } finally {
    cleanup();
  }
});

test('unregister removes the agent and clears the connection binding', () => {
  const { state, ctx, cleanup } = setup();
  try {
    const cwd = process.cwd();
    handleRequest(state, ctx, { id: 13, op: 'register', sessionId: 's1', provider: 'claude', cwd });
    const res = handleRequest(state, ctx, { id: 14, op: 'unregister', sessionId: 's1' });

    assert.equal(res.ok, true);
    assert.equal(ctx.sessionId, null);
    const who = handleRequest(state, ctx, { id: 15, op: 'who', cwd });
    assert.deepEqual(who.agents, []);
  } finally {
    cleanup();
  }
});

test('every handled op is journaled except the noisy read-only ones', () => {
  const { state, ctx, cleanup } = setup();
  try {
    const cwd = process.cwd();
    handleRequest(state, ctx, { id: 16, op: 'register', sessionId: 's1', provider: 'claude', cwd });
    handleRequest(state, ctx, { id: 17, op: 'who', cwd });
    handleRequest(state, ctx, { id: 18, op: 'ping' });
    handleRequest(state, ctx, { id: 19, op: 'unregister', sessionId: 's1' });

    const kinds = state.journal.read().map((e) => e.kind);
    assert.deepEqual(kinds, ['register', 'unregister'], 'who and ping must not flood the journal');
  } finally {
    cleanup();
  }
});

test('a non-object request is rejected', () => {
  const { state, ctx, cleanup } = setup();
  try {
    const res = handleRequest(state, ctx, 'hello');
    assert.equal(res.ok, false);
    assert.equal(res.id, 0);
  } finally {
    cleanup();
  }
});
