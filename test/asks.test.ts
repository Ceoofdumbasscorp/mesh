import { test } from 'node:test';
import assert from 'node:assert/strict';
import { testClock } from '../src/clock.ts';
import { AskRegistry } from '../src/asks.ts';
import type { AskRegistryOptions } from '../src/asks.ts';

function setup(overrides: Omit<AskRegistryOptions, 'clock'> = {}) {
  const clock = testClock(1000);
  return { clock, asks: new AskRegistry({ clock: clock.now, ...overrides }) };
}

test('creates a pending ask with a deadline derived from the clock', () => {
  const { asks } = setup();
  const result = asks.create({ from: 'claude-1', to: 'codex-2', body: 'ready?', timeoutMs: 90_000 });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.ask.state, 'pending');
  assert.equal(result.ask.createdAt, 1000);
  assert.equal(result.ask.deadline, 91_000);
});

test('refuses an ask addressed to yourself', () => {
  const { asks } = setup();
  const result = asks.create({ from: 'claude-1', to: 'claude-1', body: 'hi', timeoutMs: 1000 });
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.code, 'self');
});

test('rejects an invalid body without creating an ask', () => {
  const { asks } = setup();
  const result = asks.create({ from: 'a', to: 'b', body: '   ', timeoutMs: 1000 });
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.code, 'bad-body');
  assert.deepEqual(asks.pendingFor('b'), []);
});

test('answering resolves the ask and records the answer', () => {
  const { asks } = setup();
  const created = asks.create({ from: 'claude-1', to: 'codex-2', body: 'q?', timeoutMs: 1000 });
  assert.equal(created.ok, true);
  if (!created.ok) return;

  const res = asks.answer(created.ask.id, 'codex-2', 'yes');
  assert.equal(res.ok, true);
  assert.equal(asks.get(created.ask.id)?.state, 'answered');
  assert.equal(asks.get(created.ask.id)?.answer, 'yes');
});

test('only the addressee may answer', () => {
  const { asks } = setup();
  const created = asks.create({ from: 'claude-1', to: 'codex-2', body: 'q?', timeoutMs: 1000 });
  if (!created.ok) return;

  const res = asks.answer(created.ask.id, 'fable-3', 'butting in');
  assert.equal(res.ok, false);
  assert.match(String(res.error), /addressed/);
  assert.equal(asks.get(created.ask.id)?.state, 'pending');
});

test('an ask cannot be answered twice', () => {
  const { asks } = setup();
  const created = asks.create({ from: 'a', to: 'b', body: 'q?', timeoutMs: 1000 });
  if (!created.ok) return;

  assert.equal(asks.answer(created.ask.id, 'b', 'first').ok, true);
  const second = asks.answer(created.ask.id, 'b', 'second');
  assert.equal(second.ok, false);
  assert.equal(asks.get(created.ask.id)?.answer, 'first');
});

test('answering an unknown ask fails cleanly', () => {
  const { asks } = setup();
  assert.equal(asks.answer(999, 'b', 'x').ok, false);
});

test('expire moves only past-deadline pending asks to timeout', () => {
  const { clock, asks } = setup();
  const soon = asks.create({ from: 'a', to: 'b', body: 'soon', timeoutMs: 1000 });
  const later = asks.create({ from: 'a', to: 'c', body: 'later', timeoutMs: 10_000 });
  if (!soon.ok || !later.ok) return;

  clock.advance(1001);
  const expired = asks.expire();
  assert.deepEqual(expired.map((a) => a.id), [soon.ask.id]);
  assert.equal(asks.get(soon.ask.id)?.state, 'timeout');
  assert.equal(asks.get(later.ask.id)?.state, 'pending');
});

test('expire does not re-expire an already answered ask', () => {
  const { clock, asks } = setup();
  const created = asks.create({ from: 'a', to: 'b', body: 'q', timeoutMs: 1000 });
  if (!created.ok) return;
  asks.answer(created.ask.id, 'b', 'done');

  clock.advance(5000);
  assert.deepEqual(asks.expire(), []);
  assert.equal(asks.get(created.ask.id)?.state, 'answered');
});

test('pendingFor lists asks awaiting an agent, waitingOn lists what blocks it', () => {
  const { asks } = setup();
  asks.create({ from: 'claude-1', to: 'codex-2', body: 'q1', timeoutMs: 1000 });

  assert.deepEqual(asks.pendingFor('codex-2').map((a) => a.body), ['q1']);
  assert.deepEqual(asks.waitingOn('claude-1').map((a) => a.body), ['q1']);
  assert.deepEqual(asks.pendingFor('claude-1'), []);
});

test('detects a direct two-agent deadlock', () => {
  const { asks } = setup();
  asks.create({ from: 'claude-1', to: 'codex-2', body: 'q1', timeoutMs: 60_000 });

  assert.equal(asks.wouldDeadlock('codex-2', 'claude-1'), true);
  const blocked = asks.create({ from: 'codex-2', to: 'claude-1', body: 'q2', timeoutMs: 60_000 });
  assert.equal(blocked.ok, false);
  if (blocked.ok) return;
  assert.equal(blocked.code, 'deadlock');
  assert.match(blocked.error, /already waiting on you/);
});

test('detects a three-agent cycle', () => {
  const { asks } = setup();
  asks.create({ from: 'a', to: 'b', body: 'q', timeoutMs: 60_000 });
  asks.create({ from: 'b', to: 'c', body: 'q', timeoutMs: 60_000 });

  assert.equal(asks.wouldDeadlock('c', 'a'), true, 'c→a closes the a→b→c chain');
  assert.equal(asks.wouldDeadlock('c', 'b'), true, 'c→b closes b→c');
  assert.equal(asks.wouldDeadlock('a', 'c'), false, 'a→c adds no cycle');
});

test('an answered ask no longer contributes to a deadlock', () => {
  const { asks } = setup();
  const first = asks.create({ from: 'a', to: 'b', body: 'q', timeoutMs: 60_000 });
  if (!first.ok) return;
  assert.equal(asks.wouldDeadlock('b', 'a'), true);

  asks.answer(first.ask.id, 'b', 'done');
  assert.equal(asks.wouldDeadlock('b', 'a'), false);
});

test('enforces a per-minute ask rate limit', () => {
  const { clock, asks } = setup({ maxPerMinute: 2 });
  assert.equal(asks.create({ from: 'a', to: 'b', body: '1', timeoutMs: 100 }).ok, true);
  assert.equal(asks.create({ from: 'a', to: 'c', body: '2', timeoutMs: 100 }).ok, true);

  const third = asks.create({ from: 'a', to: 'd', body: '3', timeoutMs: 100 });
  assert.equal(third.ok, false);
  if (third.ok) return;
  assert.equal(third.code, 'rate-limit');

  clock.advance(60_001);
  assert.equal(asks.create({ from: 'a', to: 'd', body: '4', timeoutMs: 100 }).ok, true);
});

test('the rate limit is per asker', () => {
  const { asks } = setup({ maxPerMinute: 1 });
  assert.equal(asks.create({ from: 'a', to: 'x', body: '1', timeoutMs: 100 }).ok, true);
  assert.equal(asks.create({ from: 'b', to: 'x', body: '1', timeoutMs: 100 }).ok, true);
  assert.equal(asks.create({ from: 'a', to: 'x', body: '2', timeoutMs: 100 }).ok, false);
});

test('caps how many open asks one agent may be holding', () => {
  const { asks } = setup({ maxOpenPerAgent: 2, maxPerMinute: 100 });
  asks.create({ from: 'a', to: 'target', body: '1', timeoutMs: 60_000 });
  asks.create({ from: 'b', to: 'target', body: '2', timeoutMs: 60_000 });

  const third = asks.create({ from: 'c', to: 'target', body: '3', timeoutMs: 60_000 });
  assert.equal(third.ok, false);
  if (third.ok) return;
  assert.equal(third.code, 'too-many-open');
});

test('ask storage has a global ceiling independent of sender identity', () => {
  const { asks } = setup({ maxTotal: 1, maxOpenPerAgent: 10, maxPerMinute: 10 });
  assert.equal(asks.create({ from: 'a', to: 'b', body: 'one?', timeoutMs: 1000 }).ok, true);
  const second = asks.create({ from: 'c', to: 'd', body: 'two?', timeoutMs: 1000 });
  assert.equal(second.ok, false);
  if (!second.ok) assert.match(second.error, /global ask quota/i);
});
