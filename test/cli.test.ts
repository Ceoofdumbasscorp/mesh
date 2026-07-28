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
    distBuilt: true,
    distPath: '/pkg/dist/cli/index.js',
    claudeMcpRegistered: true,
    codexMcpRegistered: true,
    codexHooksTrusted: true,
    codexVersion: 'codex-cli 0.145.0',
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
    distBuilt: false,
    distPath: '/pkg/dist/cli/index.js',
    claudeMcpRegistered: false,
    codexMcpRegistered: false,
    codexHooksTrusted: false,
    codexVersion: null,
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

const healthyReport = {
  nodeVersion: 'v25.8.1',
  nodeOk: true,
  daemonReachable: true,
  socketPath: '/s',
  claudeHooksInstalled: true,
  codexHooksInstalled: true,
  codexSpikeRecorded: true,
  distBuilt: true,
  distPath: '/pkg/dist/cli/index.js',
  claudeMcpRegistered: true,
  codexMcpRegistered: true,
  codexHooksTrusted: true,
  codexVersion: 'codex-cli 0.145.0',
};

test('renderDoctor flags an unbuilt dist, which makes every tool call slower', () => {
  const out = renderDoctor({ ...healthyReport, distBuilt: false });
  assert.match(out, /npm run build/);
});

test('renderDoctor flags a Codex hook the user has not trusted yet', () => {
  const out = renderDoctor({ ...healthyReport, codexHooksTrusted: false });
  assert.match(out, /trust/i);
  assert.match(out, /enforce/i, 'says what is lost until it is trusted');
});

test('renderDoctor reports the Codex version, since hook behavior is version-measured', () => {
  assert.match(renderDoctor(healthyReport), /0\.145\.0/);
});

test('renderDoctor names mesh init when the MCP server is not registered', () => {
  const out = renderDoctor({
    ...healthyReport,
    claudeMcpRegistered: false,
    codexMcpRegistered: false,
    codexVersion: null,
  });
  assert.match(out, /mcp/i);
  assert.match(out, /mesh init/);
});
