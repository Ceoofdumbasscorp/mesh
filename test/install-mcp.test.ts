import { test } from 'node:test';
import assert from 'node:assert/strict';
import { claudeMcpArgs, codexMcpArgs, ensureMcpServer } from '../src/install/mcp.ts';
import type { CommandRunner, RunResult } from '../src/install/mcp.ts';

const ok: RunResult = { status: 0, stdout: '', stderr: '' };

function recordingRunner(responses: Record<string, RunResult> = {}) {
  const calls: Array<{ command: string; args: string[] }> = [];
  const runner: CommandRunner = (command, args) => {
    calls.push({ command, args });
    return responses[args[1] ?? ''] ?? ok;
  };
  return { runner, calls };
}

test('claudeMcpArgs registers at user scope so every project sees mesh', () => {
  assert.deepEqual(claudeMcpArgs('/usr/bin/node', '/pkg/dist/cli/index.js'), [
    'mcp',
    'add',
    '--scope',
    'user',
    'mesh',
    '--',
    '/usr/bin/node',
    '/pkg/dist/cli/index.js',
    'mcp',
  ]);
});

test('codexMcpArgs declares the provider, because Codex scrubs the environment', () => {
  assert.deepEqual(codexMcpArgs('/usr/bin/node', '/pkg/dist/cli/index.js'), [
    'mcp',
    'add',
    'mesh',
    '--env',
    'MESH_PROVIDER=codex',
    '--',
    '/usr/bin/node',
    '/pkg/dist/cli/index.js',
    'mcp',
  ]);
});

test('ensureMcpServer adds the server and reports success', () => {
  const { runner, calls } = recordingRunner({
    list: { status: 0, stdout: 'other-server\n', stderr: '' },
  });

  const result = ensureMcpServer({ host: 'claude', nodePath: 'node', entry: '/e.js', runner });

  assert.equal(result.ok, true);
  assert.equal(
    calls.some((call) => call.args[1] === 'remove'),
    false,
    'nothing to remove',
  );
  assert.ok(calls.some((call) => call.command === 'claude' && call.args[1] === 'add'));
});

test('ensureMcpServer repoints an existing mesh entry instead of failing', () => {
  const { runner, calls } = recordingRunner({
    list: { status: 0, stdout: 'mesh: node /old\n', stderr: '' },
  });

  const result = ensureMcpServer({ host: 'codex', nodePath: 'node', entry: '/e.js', runner });

  assert.equal(result.ok, true);
  assert.deepEqual(
    calls.map((call) => call.args[1]),
    ['list', 'remove', 'add'],
    'remove then add, so a re-run repoints',
  );
});

test('ensureMcpServer reports the manual command when the host CLI is missing', () => {
  const runner: CommandRunner = () => ({ status: null, stdout: '', stderr: 'ENOENT' });

  const result = ensureMcpServer({ host: 'claude', nodePath: 'node', entry: '/e.js', runner });

  assert.equal(result.ok, false);
  assert.match(result.detail, /claude/);
  assert.match(result.manualCommand, /claude mcp add --scope user mesh -- node \/e\.js mcp/);
});

test('ensureMcpServer reports a failing add with the host stderr', () => {
  const runner: CommandRunner = (_command, args) =>
    args[1] === 'add'
      ? { status: 1, stdout: '', stderr: 'server already exists' }
      : { status: 0, stdout: '', stderr: '' };

  const result = ensureMcpServer({ host: 'codex', nodePath: 'node', entry: '/e.js', runner });

  assert.equal(result.ok, false);
  assert.match(result.detail, /already exists/);
});
