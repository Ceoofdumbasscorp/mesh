import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveMcpIdentity, toolText, describeWho } from '../src/mcp/server.ts';
import { isProvisionalSessionId } from '../src/registry.ts';

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

test('identity reads the session id Claude Code exports', () => {
  // Measured 2026-07-27: this variable is present in the MCP server's
  // environment and equals the session_id the hook receives.
  const id = resolveMcpIdentity(
    { CLAUDE_CODE_SESSION_ID: 'c7cbb924-dffb-4045-b06f-e6099345f69e' },
    ['node', 'mesh', 'mcp'],
    4242,
  );
  assert.equal(id.sessionId, 'c7cbb924-dffb-4045-b06f-e6099345f69e');
  assert.equal(id.provider, 'claude');
});

test('identity ignores an inherited Claude id under Codex', () => {
  // The trap: a Codex session launched from a Claude session inherits
  // CLAUDE_CODE_SESSION_ID. Trusting it would fuse two different agents.
  const id = resolveMcpIdentity(
    { MESH_PROVIDER: 'codex', CLAUDE_CODE_SESSION_ID: 'the-outer-claude-session' },
    ['node', 'mesh', 'mcp'],
    26968,
  );
  assert.equal(id.sessionId, 'pid-26968');
  assert.equal(id.provider, 'codex');
});

test('identity falls back to the host pid, which the daemon reconciles', () => {
  const id = resolveMcpIdentity({}, ['node', 'mesh', 'mcp'], 26968);
  assert.equal(id.sessionId, 'pid-26968');
  assert.equal(isProvisionalSessionId(id.sessionId), true);
});

test('MESH_SESSION_ID overrides the host, as the operator escape hatch', () => {
  const id = resolveMcpIdentity(
    { MESH_SESSION_ID: 'chosen', CLAUDE_CODE_SESSION_ID: 'from-host' },
    ['node', 'mesh', 'mcp'],
    1,
  );
  assert.equal(id.sessionId, 'chosen');
});

test('identity prefers the flag over every environment source', () => {
  const id = resolveMcpIdentity(
    { MESH_SESSION_ID: 'from-env', CLAUDE_CODE_SESSION_ID: 'from-host' },
    ['node', 'mesh', 'mcp', '--session', 'from-flag'],
    4242,
  );
  assert.equal(id.sessionId, 'from-flag');
});
