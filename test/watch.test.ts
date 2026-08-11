import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderWatch, watchTick, runWatch, CLEAR_SCREEN } from '../src/cli/watch.ts';
import type { WhoAgent } from '../src/cli/who.ts';

const agent = (over: Partial<WhoAgent> = {}): WhoAgent => ({
  name: 'claude-1',
  provider: 'claude',
  role: 'frontend',
  status: 'working',
  activity: 'Edit app/page.tsx',
  idleMs: 2_000,
  ...over,
});

test('renderWatch shows each agent with what it is doing', () => {
  const out = renderWatch({
    workspaceLabel: 'leadops-v2',
    agents: [agent(), agent({ name: 'codex-2', role: 'backend', activity: 'Bash npm test' })],
    claims: [],
    now: Date.parse('2026-07-27T09:30:00Z'),
    daemonReachable: true,
  });

  assert.match(out, /leadops-v2/);
  assert.match(out, /claude-1/);
  assert.match(out, /Edit app\/page\.tsx/);
  assert.match(out, /codex-2/);
  assert.match(out, /ctrl-c/i, 'a TUI says how to leave it');
});

test('renderWatch escapes terminal control characters from daemon fields', () => {
  const out = renderWatch({
    workspaceLabel: 'repo\u001b]52;c;owned\u0007',
    agents: [agent({ role: 'front\nend', activity: '\u001b[2Jspoofed' })],
    claims: [],
    now: 0,
    daemonReachable: true,
  });
  assert.doesNotMatch(out, /[\u0007\u001b]/);
  assert.match(out, /\\u001b/);
  assert.match(out, /\\n/);
});

test('renderWatch surfaces unanswered questions so the human can nudge', () => {
  const out = renderWatch({
    workspaceLabel: 'w',
    agents: [agent({ name: 'codex-2', status: 'idle', activity: null, unanswered: 2 })],
    claims: [],
    now: 0,
    daemonReachable: true,
  });
  assert.match(out, /2 unanswered/);
  assert.match(out, /nudge/i);
});

test('renderWatch says questions are clear when nothing is pending', () => {
  const out = renderWatch({
    workspaceLabel: 'w',
    agents: [agent()],
    claims: [],
    now: 0,
    daemonReachable: true,
  });
  assert.match(out, /questions in flight:\n\s+none/);
});

test('renderWatch names who an agent is blocked on', () => {
  const out = renderWatch({
    workspaceLabel: 'w',
    agents: [agent({ waitingOn: ['codex-2'] })],
    claims: [],
    now: 0,
    daemonReachable: true,
  });
  assert.match(out, /waiting on codex-2/);
});

test('renderWatch includes the claim table', () => {
  const out = renderWatch({
    workspaceLabel: 'w',
    agents: [agent()],
    claims: [
      { id: 1, holder: 'codex-2', patterns: ['server/**'], mode: 'exclusive', expiresInMs: 540_000 },
    ],
    now: 0,
    daemonReachable: true,
  });
  assert.match(out, /server\/\*\*/);
  assert.match(out, /exclusive/);
});

test('renderWatch explains a missing daemon instead of showing an empty table', () => {
  const out = renderWatch({
    workspaceLabel: '',
    agents: [],
    claims: [],
    now: 0,
    daemonReachable: false,
  });
  assert.match(out, /not running/i);
  assert.match(out, /mesh init/, 'names the command that fixes it');
  assert.doesNotMatch(out, /undefined/);
});

test('renderWatch handles a workspace with no agents yet', () => {
  const out = renderWatch({
    workspaceLabel: 'w',
    agents: [],
    claims: [],
    now: 0,
    daemonReachable: true,
  });
  assert.match(out, /no agents/i);
});

test('watchTick reports an unreachable daemon rather than throwing', async () => {
  const frame = await watchTick({
    connect: async () => null,
    write: () => {},
    now: () => 0,
    cwd: '/w',
    intervalMs: 1000,
    once: true,
  });
  assert.match(frame, /not running/i);
});

test('watchTick closes the connection it opened, every tick', async () => {
  let closed = 0;
  const fakeClient = {
    request: async (op: string) =>
      op === 'who'
        ? { id: 1, ok: true, workspaceLabel: 'w', agents: [agent()] }
        : { id: 2, ok: true, claims: [] },
    close: () => {
      closed += 1;
    },
  };

  const frame = await watchTick({
    connect: async () => fakeClient as never,
    write: () => {},
    now: () => 0,
    cwd: '/w',
    intervalMs: 1000,
    once: true,
  });

  assert.match(frame, /claude-1/);
  assert.equal(closed, 1, 'a watcher must not leak connections once per second');
});

test('runWatch repaints and stops after one frame when once is set', async () => {
  const frames: string[] = [];
  const code = await runWatch({
    connect: async () => null,
    write: (frame) => frames.push(frame),
    now: () => 0,
    cwd: '/w',
    intervalMs: 1000,
    once: true,
  });

  assert.equal(code, 0);
  assert.equal(frames.length, 1);
  assert.ok(frames[0]?.startsWith(CLEAR_SCREEN), 'each frame repaints the screen');
});

test('runWatch keeps polling on the interval until stopped', async () => {
  const frames: string[] = [];
  let sleeps = 0;
  const deps = {
    connect: async () => null,
    write: (frame: string) => frames.push(frame),
    now: () => 0,
    cwd: '/w',
    intervalMs: 25,
    once: false,
    sleep: async (ms: number) => {
      sleeps += 1;
      assert.equal(ms, 25);
      if (sleeps === 3) throw new Error('stop');
    },
  };

  await assert.rejects(() => runWatch(deps), /stop/);
  assert.equal(frames.length, 3);
});
