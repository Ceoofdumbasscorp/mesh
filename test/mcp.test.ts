import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveMcpIdentity, toolText, describeWho } from '../src/mcp/server.ts';

test('identity prefers an explicit --session flag', () => {
  const id = resolveMcpIdentity({}, ['node', 'mesh', 'mcp', '--session', 'abc123']);
  assert.equal(id.sessionId, 'abc123');
});

test('identity falls back to MESH_SESSION_ID', () => {
  const id = resolveMcpIdentity({ MESH_SESSION_ID: 'from-env' }, ['node', 'mesh', 'mcp']);
  assert.equal(id.sessionId, 'from-env');
});

test('identity falls back to the parent pid when nothing is set', () => {
  const id = resolveMcpIdentity({}, ['node', 'mesh', 'mcp']);
  assert.match(id.sessionId, /^pid-\d+$/);
});

test('identity reads provider and role from the environment', () => {
  const id = resolveMcpIdentity(
    { MESH_SESSION_ID: 's', MESH_PROVIDER: 'codex', MESH_ROLE: 'backend' },
    ['node', 'mesh', 'mcp'],
  );
  assert.equal(id.provider, 'codex');
  assert.equal(id.role, 'backend');
});

test('identity defaults the provider to claude', () => {
  const id = resolveMcpIdentity({ MESH_SESSION_ID: 's' }, ['node', 'mesh', 'mcp']);
  assert.equal(id.provider, 'claude');
});

test('toolText wraps a string as MCP text content', () => {
  assert.deepEqual(toolText('hello'), { content: [{ type: 'text', text: 'hello' }] });
});

test('toolText serializes non-strings as JSON', () => {
  const out = toolText({ a: 1 });
  assert.equal(out.content[0]?.text, '{\n "a": 1\n}');
});

test('describeWho renders an empty roster plainly', () => {
  assert.match(describeWho([]), /No other agents/i);
});

test('describeWho lists each agent with role and activity', () => {
  const out = describeWho([
    {
      name: 'codex-2',
      provider: 'codex',
      role: 'backend',
      status: 'working',
      activity: 'Edit api.ts',
      idleMs: 500,
    },
  ]);
  assert.match(out, /codex-2/);
  assert.match(out, /backend/);
  assert.match(out, /Edit api\.ts/);
});
