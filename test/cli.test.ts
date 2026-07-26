import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderWho } from '../src/cli/who.ts';
import { renderDoctor } from '../src/cli/doctor.ts';

test('renderWho lists each agent with status and activity', () => {
  const out = renderWho({
    workspaceLabel: 'leadops-v2',
    agents: [
      { name: 'claude-1', provider: 'claude', role: 'frontend', status: 'working', activity: 'Edit app/page.tsx', idleMs: 1200 },
      { name: 'codex-2', provider: 'codex', role: 'backend', status: 'idle', activity: null, idleMs: 132_000 },
    ],
  });

  assert.match(out, /leadops-v2/);
  assert.match(out, /claude-1/);
  assert.match(out, /frontend/);
  assert.match(out, /Edit app\/page\.tsx/);
  assert.match(out, /codex-2/);
  assert.match(out, /2m/, 'idle time is rendered in human units');
});

test('renderWho explains an empty workspace instead of printing a bare header', () => {
  const out = renderWho({ workspaceLabel: 'mesh', agents: [] });
  assert.match(out, /No agents/i);
});

test('renderWho shows a placeholder when an agent has no role', () => {
  const out = renderWho({
    workspaceLabel: 'mesh',
    agents: [{ name: 'claude-1', provider: 'claude', role: null, status: 'working', activity: null, idleMs: 0 }],
  });
  assert.match(out, /claude-1/);
  assert.doesNotMatch(out, /null/, 'null must never reach the user');
});

test('renderDoctor reports a healthy environment', () => {
  const out = renderDoctor({
    nodeVersion: 'v25.8.1',
    nodeOk: true,
    daemonReachable: true,
    socketPath: '/Users/x/.mesh/mesh.sock',
    claudeHooksInstalled: true,
    codexHooksInstalled: true,
    codexSpikeRecorded: true,
  });

  assert.match(out, /v25\.8\.1/);
  assert.match(out, /ok/i);
  assert.doesNotMatch(out, /not installed/i);
});

test('renderDoctor flags each problem it finds', () => {
  const out = renderDoctor({
    nodeVersion: 'v20.0.0',
    nodeOk: false,
    daemonReachable: false,
    socketPath: '/Users/x/.mesh/mesh.sock',
    claudeHooksInstalled: false,
    codexHooksInstalled: false,
    codexSpikeRecorded: false,
  });

  assert.match(out, /22\.6/, 'states the required version');
  assert.match(out, /not running/i);
  assert.match(out, /not installed/i);
  assert.match(out, /mesh init/, 'names the command that fixes it');
});

import { renderClaims } from '../src/cli/claims.ts';

test('renderClaims explains an empty table rather than printing a bare header', () => {
  const out = renderClaims([]);
  assert.match(out, /No claims/i);
});

test('renderClaims lists holder, patterns, mode, and remaining time', () => {
  const out = renderClaims([
    { id: 1, holder: 'codex-1', patterns: ['server/**'], mode: 'exclusive', expiresInMs: 540_000 },
  ]);
  assert.match(out, /codex-1/);
  assert.match(out, /server\/\*\*/);
  assert.match(out, /exclusive/);
  assert.match(out, /9m/, 'remaining time is rendered in human units');
});

test('renderClaims joins multiple patterns on one row', () => {
  const out = renderClaims([
    { id: 1, holder: 'codex-1', patterns: ['server/**', 'db/**'], mode: 'exclusive', expiresInMs: 60_000 },
  ]);
  assert.match(out, /server\/\*\*/);
  assert.match(out, /db\/\*\*/);
});

test('renderClaims flags a claim that is nearly expired', () => {
  const out = renderClaims([
    { id: 1, holder: 'codex-1', patterns: ['server/**'], mode: 'exclusive', expiresInMs: 5_000 },
  ]);
  assert.match(out, /expiring/i);
});
