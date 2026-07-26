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
import { handleRequest, denialReason } from '../src/daemon/handlers.ts';
import type { ConnectionContext, DaemonState } from '../src/daemon/handlers.ts';

function setup() {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'mesh-enf-')));
  const clock = testClock(1000);
  const state: DaemonState = {
    clock: clock.now,
    registry: new Registry({ clock: clock.now }),
    journal: new Journal(join(base, 'journal.jsonl'), clock.now),
    mailbox: new Mailbox({ clock: clock.now }),
    asks: new AskRegistry({ clock: clock.now }),
    claims: new ClaimTable({ clock: clock.now }),
    waiters: new Waiters(),
  };
  return { base, clock, state, cleanup: () => rmSync(base, { recursive: true, force: true }) };
}

const ctx = (): ConnectionContext => ({ sessionId: null, owns: false });

async function join2(state: DaemonState, base: string) {
  const a = ctx();
  const b = ctx();
  await handleRequest(state, a, { id: 1, op: 'register', sessionId: 'sa', provider: 'claude', cwd: base });
  await handleRequest(state, b, { id: 1, op: 'register', sessionId: 'sb', provider: 'codex', cwd: base });
  return { a, b };
}

test('denialReason names the holder, the pattern, and the escape hatch', () => {
  const text = denialReason({
    path: 'server/api/leads.ts', holder: 'codex-1', pattern: 'server/**', holderIdleMs: 4000,
  });
  assert.match(text, /server\/api\/leads\.ts/);
  assert.match(text, /codex-1/);
  assert.match(text, /mesh_ask/, 'tells the agent how to unblock itself');
  assert.match(text, /mesh release --force/, 'names the escape hatch');
});

test('claim grants and is visible to claims', async () => {
  const { base, state, cleanup } = setup();
  try {
    const { b } = await join2(state, base);
    const res = await handleRequest(state, b, { id: 2, op: 'claim', patterns: ['server/**'] });
    assert.equal(res.ok, true);

    const list = await handleRequest(state, b, { id: 3, op: 'claims', cwd: base });
    const held = list.claims as Array<Record<string, unknown>>;
    assert.equal(held.length, 1);
    assert.equal(held[0]?.holder, 'codex-1');
  } finally {
    cleanup();
  }
});

test('check denies a non-holder and supplies a reason', async () => {
  const { base, state, cleanup } = setup();
  try {
    const { a, b } = await join2(state, base);
    await handleRequest(state, b, { id: 2, op: 'claim', patterns: ['server/**'] });

    const res = await handleRequest(state, a, { id: 3, op: 'check', path: 'server/api/leads.ts' });
    assert.equal(res.allowed, false);
    assert.equal(res.holder, 'codex-1');
    assert.match(String(res.reason), /codex-1/);
    assert.ok(String(res.reason).length > 0, 'a deny must always carry a reason');
  } finally {
    cleanup();
  }
});

test('check allows the holder and unclaimed paths', async () => {
  const { base, state, cleanup } = setup();
  try {
    const { a, b } = await join2(state, base);
    await handleRequest(state, b, { id: 2, op: 'claim', patterns: ['server/**'] });

    assert.equal((await handleRequest(state, b, { id: 3, op: 'check', path: 'server/x.ts' })).allowed, true);
    assert.equal((await handleRequest(state, a, { id: 4, op: 'check', path: 'app/page.tsx' })).allowed, true);
  } finally {
    cleanup();
  }
});

test('check accepts an absolute path and resolves it against the workspace', async () => {
  const { base, state, cleanup } = setup();
  try {
    const { a, b } = await join2(state, base);
    await handleRequest(state, b, { id: 2, op: 'claim', patterns: ['server/**'] });

    const res = await handleRequest(state, a, {
      id: 3, op: 'check', path: join(base, 'server/api/leads.ts'),
    });
    assert.equal(res.allowed, false, 'an absolute path must resolve to the same claim');
  } finally {
    cleanup();
  }
});

test('an overlapping claim is refused and names the holder', async () => {
  const { base, state, cleanup } = setup();
  try {
    const { a, b } = await join2(state, base);
    await handleRequest(state, b, { id: 2, op: 'claim', patterns: ['server/**'] });

    const res = await handleRequest(state, a, { id: 3, op: 'claim', patterns: ['server/api/**'] });
    assert.equal(res.ok, false);
    assert.match(String(res.error), /codex-1/);
  } finally {
    cleanup();
  }
});

test('an idle holder auto-downgrades from deny to a warning', async () => {
  const { base, clock, state, cleanup } = setup();
  try {
    const { a, b } = await join2(state, base);
    await handleRequest(state, b, { id: 2, op: 'claim', patterns: ['server/**'], ttlMs: 3_600_000 });

    // codex-1 goes quiet for longer than the idle threshold.
    clock.advance(16 * 60_000);
    const res = await handleRequest(state, a, { id: 3, op: 'check', path: 'server/x.ts' });
    assert.equal(res.allowed, true, 'a stalled agent must not wedge a working one');
    assert.match(String(res.warning), /idle/i);
  } finally {
    cleanup();
  }
});

test('release frees the path', async () => {
  const { base, state, cleanup } = setup();
  try {
    const { a, b } = await join2(state, base);
    await handleRequest(state, b, { id: 2, op: 'claim', patterns: ['server/**'] });
    const released = await handleRequest(state, b, { id: 3, op: 'release' });
    assert.equal(released.released, 1);

    assert.equal((await handleRequest(state, a, { id: 4, op: 'check', path: 'server/x.ts' })).allowed, true);
  } finally {
    cleanup();
  }
});

test('force release breaks another agent claim', async () => {
  const { base, state, cleanup } = setup();
  try {
    const { a, b } = await join2(state, base);
    await handleRequest(state, b, { id: 2, op: 'claim', patterns: ['server/**'] });

    const forced = await handleRequest(state, a, {
      id: 3, op: 'release', patterns: ['server/**'], force: true, cwd: base,
    });
    assert.equal(forced.released, 1);
    assert.equal((await handleRequest(state, a, { id: 4, op: 'check', path: 'server/x.ts' })).allowed, true);
  } finally {
    cleanup();
  }
});

test('a non-forced release cannot touch another agent claim', async () => {
  const { base, state, cleanup } = setup();
  try {
    const { a, b } = await join2(state, base);
    await handleRequest(state, b, { id: 2, op: 'claim', patterns: ['server/**'] });

    const attempt = await handleRequest(state, a, { id: 3, op: 'release', patterns: ['server/**'] });
    assert.equal(attempt.released, 0);
    assert.equal((await handleRequest(state, a, { id: 4, op: 'check', path: 'server/x.ts' })).allowed, false);
  } finally {
    cleanup();
  }
});

test('touch refreshes the claims of an active holder', async () => {
  const { base, clock, state, cleanup } = setup();
  try {
    const { a, b } = await join2(state, base);
    await handleRequest(state, b, { id: 2, op: 'claim', patterns: ['server/**'], ttlMs: 60_000 });

    clock.advance(50_000);
    await handleRequest(state, b, { id: 3, op: 'touch', activity: 'Edit server/api.ts' });
    clock.advance(50_000);

    const res = await handleRequest(state, a, { id: 4, op: 'check', path: 'server/x.ts' });
    assert.equal(res.allowed, false, 'an active holder keeps its claim');
  } finally {
    cleanup();
  }
});

test('claim requires a registered agent', async () => {
  const { state, cleanup } = setup();
  try {
    const res = await handleRequest(state, ctx(), { id: 1, op: 'claim', patterns: ['x/**'] });
    assert.equal(res.ok, false);
    assert.match(String(res.error), /register/i);
  } finally {
    cleanup();
  }
});
