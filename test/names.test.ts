import { test } from 'node:test';
import assert from 'node:assert/strict';
import { NameAllocator } from '../src/names.ts';

test('numbers each provider independently starting at 1', () => {
  const names = new NameAllocator();
  assert.equal(names.allocate('claude'), 'claude-1');
  assert.equal(names.allocate('codex'), 'codex-1');
  assert.equal(names.allocate('claude'), 'claude-2');
  assert.equal(names.allocate('codex'), 'codex-2');
});

test('normalizes provider case and surrounding whitespace', () => {
  const names = new NameAllocator();
  assert.equal(names.allocate('Claude'), 'claude-1');
  assert.equal(names.allocate('  CLAUDE  '), 'claude-2');
});

test('falls back to "agent" for an empty or missing provider', () => {
  const names = new NameAllocator();
  assert.equal(names.allocate(''), 'agent-1');
  assert.equal(names.allocate('   '), 'agent-2');
});

test('does not reuse a number after a release', () => {
  const names = new NameAllocator();
  assert.equal(names.allocate('claude'), 'claude-1');
  assert.equal(names.allocate('claude'), 'claude-2');
  names.release('claude-1');
  assert.equal(names.allocate('claude'), 'claude-3');
});

test('reset clears all counters', () => {
  const names = new NameAllocator();
  names.allocate('claude');
  names.reset();
  assert.equal(names.allocate('claude'), 'claude-1');
});

test('sanitizes providers containing separator characters', () => {
  const names = new NameAllocator();
  assert.equal(names.allocate('my agent/v2'), 'my-agent-v2-1');
});
