import { test } from 'node:test';
import assert from 'node:assert/strict';
import { testClock } from '../src/clock.ts';
import { Registry } from '../src/registry.ts';
import type { Workspace } from '../src/workspace.ts';

const wsA: Workspace = { root: '/repo/a', label: 'a', key: 'aaaaaaaaaaaa' };
const wsB: Workspace = { root: '/repo/b', label: 'b', key: 'bbbbbbbbbbbb' };

function setup(idleAfterMs = 60_000) {
  const clock = testClock(1000);
  const registry = new Registry({ clock: clock.now, idleAfterMs });
  return { clock, registry };
}

test('assigns provider-numbered names per workspace', () => {
  const { registry } = setup();
  const first = registry.register({ sessionId: 's1', provider: 'claude', workspace: wsA });
  const second = registry.register({ sessionId: 's2', provider: 'codex', workspace: wsA });
  const other = registry.register({ sessionId: 's3', provider: 'claude', workspace: wsB });

  assert.equal(first.name, 'claude-1');
  assert.equal(second.name, 'codex-1');
  assert.equal(other.name, 'claude-1', 'numbering restarts in a separate workspace');
});

test('agents only see peers in the same workspace', () => {
  const { registry } = setup();
  registry.register({ sessionId: 's1', provider: 'claude', workspace: wsA });
  registry.register({ sessionId: 's2', provider: 'codex', workspace: wsA });
  registry.register({ sessionId: 's3', provider: 'claude', workspace: wsB });

  assert.deepEqual(registry.list(wsA.root).map((a) => a.name), ['claude-1', 'codex-1']);
  assert.deepEqual(registry.list(wsB.root).map((a) => a.name), ['claude-1']);
});

test('re-registering the same session keeps its name and does not duplicate', () => {
  const { registry } = setup();
  const first = registry.register({ sessionId: 's1', provider: 'claude', workspace: wsA });
  const again = registry.register({ sessionId: 's1', provider: 'claude', workspace: wsA });

  assert.equal(again.name, first.name);
  assert.equal(registry.list(wsA.root).length, 1);
});

test('status is working inside the idle window and idle beyond it', () => {
  const { clock, registry } = setup(60_000);
  registry.register({ sessionId: 's1', provider: 'claude', workspace: wsA });

  assert.equal(registry.list(wsA.root)[0]?.status, 'working');
  clock.advance(59_999);
  assert.equal(registry.list(wsA.root)[0]?.status, 'working');
  clock.advance(2);
  assert.equal(registry.list(wsA.root)[0]?.status, 'idle');
});

test('touch refreshes liveness and records current activity', () => {
  const { clock, registry } = setup(60_000);
  registry.register({ sessionId: 's1', provider: 'claude', workspace: wsA });

  clock.advance(90_000);
  assert.equal(registry.list(wsA.root)[0]?.status, 'idle');

  assert.equal(registry.touch('s1', 'Edit app/page.tsx'), true);
  const view = registry.list(wsA.root)[0];
  assert.equal(view?.status, 'working');
  assert.equal(view?.activity, 'Edit app/page.tsx');
  assert.equal(view?.idleMs, 0);
});

test('touch on an unknown session reports false', () => {
  const { registry } = setup();
  assert.equal(registry.touch('nope'), false);
});

test('idleMs reports elapsed time since the last sighting', () => {
  const { clock, registry } = setup();
  registry.register({ sessionId: 's1', provider: 'claude', workspace: wsA });
  clock.advance(4500);
  assert.equal(registry.list(wsA.root)[0]?.idleMs, 4500);
});

test('unregister removes the agent and returns it', () => {
  const { registry } = setup();
  registry.register({ sessionId: 's1', provider: 'claude', workspace: wsA });

  const removed = registry.unregister('s1');
  assert.equal(removed?.name, 'claude-1');
  assert.deepEqual(registry.list(wsA.root), []);
  assert.equal(registry.unregister('s1'), null, 'second removal is a no-op');
});

test('a name is not reissued after the holder leaves', () => {
  const { registry } = setup();
  registry.register({ sessionId: 's1', provider: 'claude', workspace: wsA });
  registry.unregister('s1');
  const next = registry.register({ sessionId: 's2', provider: 'claude', workspace: wsA });
  assert.equal(next.name, 'claude-2');
});

test('byName resolves within a workspace only', () => {
  const { registry } = setup();
  registry.register({ sessionId: 's1', provider: 'claude', workspace: wsA });

  assert.equal(registry.byName(wsA.root, 'claude-1')?.sessionId, 's1');
  assert.equal(registry.byName(wsB.root, 'claude-1'), undefined);
});

test('role and pid are retained and default to null', () => {
  const { registry } = setup();
  const withRole = registry.register({
    sessionId: 's1', provider: 'claude', workspace: wsA, role: 'frontend', pid: 4242,
  });
  const without = registry.register({ sessionId: 's2', provider: 'codex', workspace: wsA });

  assert.equal(withRole.role, 'frontend');
  assert.equal(withRole.pid, 4242);
  assert.equal(without.role, null);
  assert.equal(without.pid, null);
});

test('list is sorted by registration order for stable output', () => {
  const { clock, registry } = setup();
  registry.register({ sessionId: 's1', provider: 'zeta', workspace: wsA });
  clock.advance(10);
  registry.register({ sessionId: 's2', provider: 'alpha', workspace: wsA });

  assert.deepEqual(registry.list(wsA.root).map((a) => a.name), ['zeta-1', 'alpha-1']);
});
