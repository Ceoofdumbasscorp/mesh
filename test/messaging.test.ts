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
import { handleRequest } from '../src/daemon/handlers.ts';
import type { ConnectionContext, DaemonState } from '../src/daemon/handlers.ts';

function setup() {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'mesh-msg-')));
  const clock = testClock(1000);
  const state: DaemonState = {
    clock: clock.now,
    registry: new Registry({ clock: clock.now }),
    journal: new Journal(join(base, 'journal.jsonl'), clock.now),
    mailbox: new Mailbox({ clock: clock.now }),
    asks: new AskRegistry({ clock: clock.now }),
    claims: new ClaimTable({ clock: clock.now }),
    waiters: new Waiters(),
    // Tests are hermetic: every agent is alive unless a test says otherwise.
    isAlive: () => true,
  };
  return { base, clock, state, cleanup: () => rmSync(base, { recursive: true, force: true }) };
}

const ctx = (): ConnectionContext => ({ sessionId: null, owns: false });

function register(
  state: DaemonState,
  c: ConnectionContext,
  sessionId: string,
  provider: string,
  cwd: string,
  role?: string,
) {
  return handleRequest(state, c, {
    id: 1, op: 'register', sessionId, provider, cwd, ...(role ? { role } : {}),
  });
}

test('send delivers to a named peer in the same workspace', async () => {
  const { base, state, cleanup } = setup();
  try {
    const a = ctx();
    const b = ctx();
    await register(state, a, 'sa', 'claude', base);
    await register(state, b, 'sb', 'codex', base);

    const sent = await handleRequest(state, a, { id: 2, op: 'send', to: 'codex-1', body: 'hello' });
    assert.equal(sent.ok, true);
    assert.equal(sent.delivered, 1);

    const inbox = await handleRequest(state, b, { id: 3, op: 'inbox' });
    const messages = inbox.messages as Array<Record<string, unknown>>;
    assert.equal(messages.length, 1);
    assert.equal(messages[0]?.body, 'hello');
    assert.equal(messages[0]?.from, 'claude-1');
  } finally {
    cleanup();
  }
});

test('inbox drains by default so a message is delivered once', async () => {
  const { base, state, cleanup } = setup();
  try {
    const a = ctx();
    const b = ctx();
    await register(state, a, 'sa', 'claude', base);
    await register(state, b, 'sb', 'codex', base);
    await handleRequest(state, a, { id: 2, op: 'send', to: 'codex-1', body: 'once' });

    const first = await handleRequest(state, b, { id: 3, op: 'inbox' });
    assert.equal((first.messages as unknown[]).length, 1);
    const second = await handleRequest(state, b, { id: 4, op: 'inbox' });
    assert.equal((second.messages as unknown[]).length, 0);
  } finally {
    cleanup();
  }
});

test('inbox with drain false leaves messages queued', async () => {
  const { base, state, cleanup } = setup();
  try {
    const a = ctx();
    const b = ctx();
    await register(state, a, 'sa', 'claude', base);
    await register(state, b, 'sb', 'codex', base);
    await handleRequest(state, a, { id: 2, op: 'send', to: 'codex-1', body: 'peek me' });

    const peeked = await handleRequest(state, b, { id: 3, op: 'inbox', drain: false });
    assert.equal((peeked.messages as unknown[]).length, 1);
    const again = await handleRequest(state, b, { id: 4, op: 'inbox', drain: false });
    assert.equal((again.messages as unknown[]).length, 1, 'peek did not consume');
  } finally {
    cleanup();
  }
});

test('send to "*" broadcasts to every peer but not the sender', async () => {
  const { base, state, cleanup } = setup();
  try {
    const a = ctx();
    const b = ctx();
    const c = ctx();
    await register(state, a, 'sa', 'claude', base);
    await register(state, b, 'sb', 'codex', base);
    await register(state, c, 'sc', 'fable', base);

    const sent = await handleRequest(state, a, { id: 2, op: 'send', to: '*', body: 'all hands' });
    assert.equal(sent.delivered, 2);

    const bInbox = await handleRequest(state, b, { id: 3, op: 'inbox' });
    const cInbox = await handleRequest(state, c, { id: 4, op: 'inbox' });
    const aInbox = await handleRequest(state, a, { id: 5, op: 'inbox' });
    assert.equal((bInbox.messages as unknown[]).length, 1);
    assert.equal((cInbox.messages as unknown[]).length, 1);
    assert.equal((aInbox.messages as unknown[]).length, 0, 'the sender is not a recipient');
  } finally {
    cleanup();
  }
});

test('send to an unknown peer reports undeliverable', async () => {
  const { base, state, cleanup } = setup();
  try {
    const a = ctx();
    await register(state, a, 'sa', 'claude', base);
    const sent = await handleRequest(state, a, { id: 2, op: 'send', to: 'nobody-9', body: 'x' });
    assert.equal(sent.ok, false);
    assert.match(String(sent.error), /nobody-9/);
  } finally {
    cleanup();
  }
});

test('broadcast to an empty room succeeds as a no-op', async () => {
  // An agent working alone must still be able to leave word for whoever shows
  // up. Failing the call made it read as its own mistake and retry.
  const { base, state, cleanup } = setup();
  try {
    const a = ctx();
    await register(state, a, 'sa', 'claude', base);
    const sent = await handleRequest(state, a, { id: 2, op: 'send', to: '*', body: 'all hands' });
    assert.equal(sent.ok, true);
    assert.equal(sent.delivered, 0);
  } finally {
    cleanup();
  }
});

test('send resolves a target by role as well as by name', async () => {
  const { base, state, cleanup } = setup();
  try {
    const a = ctx();
    const b = ctx();
    await register(state, a, 'sa', 'claude', base);
    await register(state, b, 'sb', 'codex', base, 'backend');

    const sent = await handleRequest(state, a, { id: 2, op: 'send', to: 'backend', body: 'via role' });
    assert.equal(sent.ok, true);
    assert.equal(sent.delivered, 1);
  } finally {
    cleanup();
  }
});

test('send rejects an oversized body', async () => {
  const { base, state, cleanup } = setup();
  try {
    const a = ctx();
    const b = ctx();
    await register(state, a, 'sa', 'claude', base);
    await register(state, b, 'sb', 'codex', base);

    const sent = await handleRequest(state, a, {
      id: 2, op: 'send', to: 'codex-1', body: 'x'.repeat(5000),
    });
    assert.equal(sent.ok, false);
    assert.match(String(sent.error), /exceeds/);
  } finally {
    cleanup();
  }
});

test('send requires a registered sender', async () => {
  const { state, cleanup } = setup();
  try {
    const stranger = ctx();
    const sent = await handleRequest(state, stranger, { id: 2, op: 'send', to: 'anyone', body: 'x' });
    assert.equal(sent.ok, false);
    assert.match(String(sent.error), /register/i);
  } finally {
    cleanup();
  }
});

test('messages do not cross workspaces', async () => {
  const { base, state, cleanup } = setup();
  const other = realpathSync(mkdtempSync(join(tmpdir(), 'mesh-msg-other-')));
  try {
    const a = ctx();
    const b = ctx();
    await register(state, a, 'sa', 'claude', base);
    await register(state, b, 'sb', 'claude', other);

    // Both are claude-1, but in different workspaces.
    const sent = await handleRequest(state, a, { id: 2, op: 'send', to: 'claude-1', body: 'x' });
    assert.equal(sent.ok, false, 'the only claude-1 in this workspace is the sender');
  } finally {
    rmSync(other, { recursive: true, force: true });
    cleanup();
  }
});
