import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { systemClock } from '../src/clock.ts';
import { Registry } from '../src/registry.ts';
import { Journal } from '../src/journal.ts';
import { Mailbox } from '../src/mailbox.ts';
import { AskRegistry } from '../src/asks.ts';
import { ClaimTable } from '../src/claims.ts';
import { Waiters } from '../src/daemon/waiters.ts';
import { handleRequest } from '../src/daemon/handlers.ts';
import type { ConnectionContext, DaemonState } from '../src/daemon/handlers.ts';

// These tests exercise real timing, so they use the system clock rather than
// a fake one — the point is that a blocking ask actually resolves.
function setup() {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'mesh-ask-')));
  const clock = systemClock;
  const state: DaemonState = {
    clock,
    registry: new Registry({ clock }),
    journal: new Journal(join(base, 'journal.jsonl'), clock),
    mailbox: new Mailbox({ clock }),
    asks: new AskRegistry({ clock }),
    claims: new ClaimTable({ clock }),
    waiters: new Waiters(),
  };
  return { base, state, cleanup: () => rmSync(base, { recursive: true, force: true }) };
}

const ctx = (): ConnectionContext => ({ sessionId: null, owns: false });

test('Waiters resolves a pending wait', async () => {
  const waiters = new Waiters();
  const pending = waiters.wait(1, 5000);
  assert.equal(waiters.size, 1);
  assert.equal(waiters.resolve(1, 'answered'), true);
  assert.equal(await pending, 'answered');
  assert.equal(waiters.size, 0);
});

test('Waiters times out on its own', async () => {
  const waiters = new Waiters();
  assert.equal(await waiters.wait(2, 30), 'timeout');
  assert.equal(waiters.size, 0);
});

test('Waiters.resolve on an unknown id is a no-op', () => {
  const waiters = new Waiters();
  assert.equal(waiters.resolve(999, 'answered'), false);
});

test('ask blocks until the target replies, and returns the answer', async () => {
  const { base, state, cleanup } = setup();
  try {
    const a = ctx();
    const b = ctx();
    await handleRequest(state, a, { id: 1, op: 'register', sessionId: 'sa', provider: 'claude', cwd: base });
    await handleRequest(state, b, { id: 1, op: 'register', sessionId: 'sb', provider: 'codex', cwd: base });

    // Keep codex-1 "working" so the ask blocks rather than queueing.
    await handleRequest(state, b, { id: 2, op: 'touch', activity: 'Edit api.ts' });

    const asking = handleRequest(state, a, {
      id: 3, op: 'ask', to: 'codex-1', body: 'does POST /leads accept a partial payload?', timeoutMs: 5000,
    });

    // The question is waiting in codex-1's inbox.
    const inbox = await handleRequest(state, b, { id: 4, op: 'inbox' });
    const messages = inbox.messages as Array<Record<string, unknown>>;
    assert.equal(messages.length, 1);
    assert.equal(messages[0]?.kind, 'ask');
    const askId = messages[0]?.askId as number;

    const replied = await handleRequest(state, b, { id: 5, op: 'reply', askId, body: 'no — email is required' });
    assert.equal(replied.ok, true);

    const answer = await asking;
    assert.equal(answer.ok, true);
    assert.equal(answer.state, 'answered');
    assert.equal(answer.body, 'no — email is required');
    assert.equal(answer.from, 'codex-1');
  } finally {
    cleanup();
  }
});

test('ask times out when nobody answers', async () => {
  const { base, state, cleanup } = setup();
  try {
    const a = ctx();
    const b = ctx();
    await handleRequest(state, a, { id: 1, op: 'register', sessionId: 'sa', provider: 'claude', cwd: base });
    await handleRequest(state, b, { id: 1, op: 'register', sessionId: 'sb', provider: 'codex', cwd: base });
    await handleRequest(state, b, { id: 2, op: 'touch', activity: 'busy' });

    const res = await handleRequest(state, a, { id: 3, op: 'ask', to: 'codex-1', body: 'hello?', timeoutMs: 60 });
    assert.equal(res.ok, true);
    assert.equal(res.state, 'timeout');
    assert.match(String(res.note), /still queued/i);
  } finally {
    cleanup();
  }
});

test('ask to an idle agent returns queued immediately rather than blocking', async () => {
  const { base, state, cleanup } = setup();
  try {
    const a = ctx();
    const b = ctx();
    await handleRequest(state, a, { id: 1, op: 'register', sessionId: 'sa', provider: 'claude', cwd: base });
    await handleRequest(state, b, { id: 1, op: 'register', sessionId: 'sb', provider: 'codex', cwd: base });

    // Force codex-1 idle by aging its lastSeen past the idle window.
    const agent = state.registry.get('sb');
    if (agent) agent.lastSeen = Date.now() - 120_000;

    const started = Date.now();
    const res = await handleRequest(state, a, { id: 3, op: 'ask', to: 'codex-1', body: 'you there?', timeoutMs: 10_000 });
    const elapsed = Date.now() - started;

    assert.equal(res.state, 'queued');
    assert.ok(elapsed < 1000, `should return immediately, took ${elapsed}ms`);
    assert.match(String(res.note), /idle/i);
  } finally {
    cleanup();
  }
});

test('ask to an unknown target is undeliverable and does not block', async () => {
  const { base, state, cleanup } = setup();
  try {
    const a = ctx();
    await handleRequest(state, a, { id: 1, op: 'register', sessionId: 'sa', provider: 'claude', cwd: base });

    const started = Date.now();
    const res = await handleRequest(state, a, { id: 2, op: 'ask', to: 'ghost-9', body: 'hi', timeoutMs: 10_000 });
    assert.equal(res.state, 'undeliverable');
    assert.ok(Date.now() - started < 1000);
  } finally {
    cleanup();
  }
});

test('a mutual ask is refused as a deadlock instead of hanging', async () => {
  const { base, state, cleanup } = setup();
  try {
    const a = ctx();
    const b = ctx();
    await handleRequest(state, a, { id: 1, op: 'register', sessionId: 'sa', provider: 'claude', cwd: base });
    await handleRequest(state, b, { id: 1, op: 'register', sessionId: 'sb', provider: 'codex', cwd: base });
    await handleRequest(state, a, { id: 2, op: 'touch', activity: 'x' });
    await handleRequest(state, b, { id: 2, op: 'touch', activity: 'y' });

    const first = handleRequest(state, a, { id: 3, op: 'ask', to: 'codex-1', body: 'q1', timeoutMs: 3000 });

    const second = await handleRequest(state, b, { id: 4, op: 'ask', to: 'claude-1', body: 'q2', timeoutMs: 3000 });
    assert.equal(second.ok, false);
    assert.match(String(second.error), /Deadlock/);

    // Unblock the first ask so the test does not wait out its timeout.
    const inbox = await handleRequest(state, b, { id: 5, op: 'inbox' });
    const askId = (inbox.messages as Array<Record<string, unknown>>)[0]?.askId as number;
    await handleRequest(state, b, { id: 6, op: 'reply', askId, body: 'ok' });
    await first;
  } finally {
    cleanup();
  }
});

test('reply to an ask you were not asked is refused', async () => {
  const { base, state, cleanup } = setup();
  try {
    const a = ctx();
    const b = ctx();
    const c = ctx();
    await handleRequest(state, a, { id: 1, op: 'register', sessionId: 'sa', provider: 'claude', cwd: base });
    await handleRequest(state, b, { id: 1, op: 'register', sessionId: 'sb', provider: 'codex', cwd: base });
    await handleRequest(state, c, { id: 1, op: 'register', sessionId: 'sc', provider: 'fable', cwd: base });
    await handleRequest(state, b, { id: 2, op: 'touch', activity: 'x' });

    const asking = handleRequest(state, a, { id: 3, op: 'ask', to: 'codex-1', body: 'q', timeoutMs: 3000 });
    const inbox = await handleRequest(state, b, { id: 4, op: 'inbox' });
    const askId = (inbox.messages as Array<Record<string, unknown>>)[0]?.askId as number;

    const intruder = await handleRequest(state, c, { id: 5, op: 'reply', askId, body: 'me!' });
    assert.equal(intruder.ok, false);

    await handleRequest(state, b, { id: 6, op: 'reply', askId, body: 'real answer' });
    assert.equal((await asking).body, 'real answer');
  } finally {
    cleanup();
  }
});
