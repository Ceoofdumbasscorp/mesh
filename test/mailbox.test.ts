import { test } from 'node:test';
import assert from 'node:assert/strict';
import { testClock } from '../src/clock.ts';
import { Mailbox, validateBody } from '../src/mailbox.ts';
import { MAX_BODY_BYTES } from '../src/protocol.ts';

test('validateBody trims and accepts ordinary text', () => {
  assert.equal(validateBody('  hello  '), 'hello');
});

test('validateBody rejects empty, non-string, and oversized bodies', () => {
  assert.throws(() => validateBody(''), RangeError);
  assert.throws(() => validateBody('   '), RangeError);
  assert.throws(() => validateBody(42), RangeError);
  assert.throws(() => validateBody('x'.repeat(MAX_BODY_BYTES + 1)), RangeError);
});

test('validateBody measures bytes, not characters', () => {
  // Each emoji is 4 bytes, so this is over the cap despite being far
  // fewer than MAX_BODY_BYTES characters.
  const emoji = '🙂'.repeat(MAX_BODY_BYTES / 2);
  assert.throws(() => validateBody(emoji), RangeError);
});

test('delivers a message and stamps it with id and clock time', () => {
  const clock = testClock(1000);
  const box = new Mailbox({ clock: clock.now });

  const env = box.deliver({ kind: 'message', from: 'claude-1', to: 'codex-2', body: 'hi' });
  assert.equal(env.id, 1);
  assert.equal(env.at, 1000);
  assert.equal(env.kind, 'message');
  assert.equal(env.askId, null);
});

test('ids increment across all recipients', () => {
  const box = new Mailbox({ clock: testClock().now });
  const a = box.deliver({ kind: 'message', from: 'x', to: 'a', body: '1' });
  const b = box.deliver({ kind: 'message', from: 'x', to: 'b', body: '2' });
  assert.equal(b.id, a.id + 1);
});

test('peek is non-destructive, drain removes', () => {
  const box = new Mailbox({ clock: testClock().now });
  box.deliver({ kind: 'message', from: 'claude-1', to: 'codex-2', body: 'one' });
  box.deliver({ kind: 'message', from: 'claude-1', to: 'codex-2', body: 'two' });

  assert.equal(box.peek('codex-2').length, 2);
  assert.equal(box.peek('codex-2').length, 2, 'peek must not consume');

  const drained = box.drain('codex-2');
  assert.deepEqual(drained.map((e) => e.body), ['one', 'two']);
  assert.deepEqual(box.drain('codex-2'), [], 'second drain is empty');
});

test('mail is kept per recipient', () => {
  const box = new Mailbox({ clock: testClock().now });
  box.deliver({ kind: 'message', from: 'a', to: 'codex-2', body: 'for codex' });
  box.deliver({ kind: 'message', from: 'a', to: 'fable-3', body: 'for fable' });

  assert.deepEqual(box.drain('codex-2').map((e) => e.body), ['for codex']);
  assert.deepEqual(box.drain('fable-3').map((e) => e.body), ['for fable']);
});

test('pendingCount reports without consuming', () => {
  const box = new Mailbox({ clock: testClock().now });
  assert.equal(box.pendingCount('codex-2'), 0);
  box.deliver({ kind: 'message', from: 'a', to: 'codex-2', body: 'x' });
  assert.equal(box.pendingCount('codex-2'), 1);
  assert.equal(box.pendingCount('codex-2'), 1);
});

test('ask envelopes carry their askId, plain messages do not', () => {
  const box = new Mailbox({ clock: testClock().now });
  const ask = box.deliver({ kind: 'ask', from: 'a', to: 'b', body: 'q?', askId: 7 });
  assert.equal(ask.askId, 7);
  assert.equal(ask.kind, 'ask');
});

test('deliver rejects an invalid body before queueing anything', () => {
  const box = new Mailbox({ clock: testClock().now });
  assert.throws(() => box.deliver({ kind: 'message', from: 'a', to: 'b', body: '' }), RangeError);
  assert.equal(box.pendingCount('b'), 0, 'nothing was queued');
});

test('clear empties one recipient only', () => {
  const box = new Mailbox({ clock: testClock().now });
  box.deliver({ kind: 'message', from: 'a', to: 'b', body: 'x' });
  box.deliver({ kind: 'message', from: 'a', to: 'c', body: 'y' });
  box.clear('b');
  assert.equal(box.pendingCount('b'), 0);
  assert.equal(box.pendingCount('c'), 1);
});
