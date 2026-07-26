import { test } from 'node:test';
import assert from 'node:assert/strict';
import { systemClock, testClock } from '../src/clock.ts';

test('systemClock returns a plausible epoch milliseconds value', () => {
  const value = systemClock();
  assert.ok(Number.isInteger(value), 'should be an integer');
  assert.ok(value > 1_700_000_000_000, 'should be after Nov 2023');
});

test('testClock starts at zero by default and does not drift', () => {
  const clock = testClock();
  assert.equal(clock.now(), 0);
  assert.equal(clock.now(), 0);
});

test('testClock advances only when told to', () => {
  const clock = testClock(1000);
  assert.equal(clock.now(), 1000);
  clock.advance(500);
  assert.equal(clock.now(), 1500);
  clock.advance(0);
  assert.equal(clock.now(), 1500);
});

test('testClock can be set to an absolute value', () => {
  const clock = testClock(1000);
  clock.set(42);
  assert.equal(clock.now(), 42);
});
