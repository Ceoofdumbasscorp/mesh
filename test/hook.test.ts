import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { readFileSync } from 'node:fs';
import {
  readStdinWithDeadline,
  parseHookInput,
  summarizeTool,
  formatInjection,
  buildHookOutput,
} from '../src/hook.ts';

function fakeStdin(text: string, keepOpen = false): NodeJS.ReadStream {
  const stream = new Readable({ read() {} });
  stream.push(text);
  if (!keepOpen) stream.push(null);
  return stream as unknown as NodeJS.ReadStream;
}

test('reads stdin that closes normally', async () => {
  const raw = await readStdinWithDeadline(fakeStdin('{"a":1}'), 500);
  assert.equal(raw, '{"a":1}');
});

test('returns what it has when the deadline fires on an open pipe', async () => {
  // Phase 0: Codex holds the hook's stdin open. A blocking read deadlocks
  // the host, so the deadline must win.
  const started = Date.now();
  const raw = await readStdinWithDeadline(fakeStdin('{"partial":', true), 60);
  const elapsed = Date.now() - started;
  assert.equal(raw, '{"partial":');
  assert.ok(elapsed < 500, `deadline should fire promptly, took ${elapsed}ms`);
});

test('parseHookInput tolerates junk instead of throwing', () => {
  assert.equal(parseHookInput('not json'), null);
  assert.equal(parseHookInput(''), null);
  assert.deepEqual(parseHookInput('{"hook_event_name":"PreToolUse"}'), {
    hook_event_name: 'PreToolUse',
  });
});

test('summarizeTool describes a file edit', () => {
  assert.equal(
    summarizeTool({ tool_name: 'Edit', tool_input: { file_path: '/repo/app/page.tsx' } }),
    'Edit page.tsx',
  );
});

test('summarizeTool describes a bash command without its arguments', () => {
  assert.equal(
    summarizeTool({ tool_name: 'Bash', tool_input: { command: 'npm test --silent' } }),
    'Bash npm test',
  );
});

test('summarizeTool falls back to the bare tool name', () => {
  assert.equal(summarizeTool({ tool_name: 'WebSearch' }), 'WebSearch');
  assert.equal(summarizeTool({}), null);
});

test('formatInjection renders nothing for an empty inbox', () => {
  assert.equal(formatInjection([]), '');
});

test('formatInjection attributes each message to its sender', () => {
  const out = formatInjection([
    { kind: 'message', from: 'codex-2', body: 'backend is deployed', askId: null },
  ]);
  assert.match(out, /MESH/);
  assert.match(out, /codex-2/);
  assert.match(out, /backend is deployed/);
});

test('formatInjection tells the agent how to answer a question', () => {
  const out = formatInjection([
    { kind: 'ask', from: 'codex-2', body: 'does the form send phone?', askId: 42 },
  ]);
  assert.match(out, /codex-2/);
  assert.match(out, /mesh_reply/, 'the agent must be told the tool to use');
  assert.match(out, /42/, 'and the askId to pass');
});

test('formatInjection marks a reply as an answer to your question', () => {
  const out = formatInjection([
    { kind: 'reply', from: 'codex-2', body: 'no, email only', askId: 42 },
  ]);
  assert.match(out, /answered/i);
  assert.match(out, /no, email only/);
});

test('buildHookOutput emits the shape Claude and Codex both accept', () => {
  // Verified in Phase 0: both hosts take this exact shape.
  const out = buildHookOutput('PreToolUse', 'hello');
  assert.deepEqual(out, {
    hookSpecificOutput: { hookEventName: 'PreToolUse', additionalContext: 'hello' },
  });
});

test('buildHookOutput emits a bare object when there is nothing to inject', () => {
  assert.deepEqual(buildHookOutput('PreToolUse', null), {});
  assert.deepEqual(buildHookOutput('PreToolUse', ''), {});
});

test('the hook module imports no heavy dependencies', () => {
  // The hook runs before every tool call. Importing the MCP SDK measured at
  // 100ms of startup versus 50ms without it, which would double the cost of
  // every tool call in the session.
  const source = readFileSync(new URL('../src/hook.ts', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /@modelcontextprotocol/, 'hook must not import the MCP SDK');
  assert.doesNotMatch(source, /from 'zod'/, 'hook must not import zod');
});

import { WRITE_TOOLS, targetPathOf, buildDenyOutput } from '../src/hook.ts';

test('write-capable tools are recognised, read-only ones are not', () => {
  for (const tool of ['Write', 'Edit', 'MultiEdit', 'NotebookEdit']) {
    assert.ok(WRITE_TOOLS.has(tool), `${tool} should be enforced`);
  }
  for (const tool of ['Read', 'Grep', 'Glob', 'WebSearch']) {
    assert.equal(WRITE_TOOLS.has(tool), false, `${tool} must not be enforced`);
  }
});

test('targetPathOf reads file_path from an edit', () => {
  assert.equal(
    targetPathOf({ tool_name: 'Edit', tool_input: { file_path: '/repo/server/api.ts' } }),
    '/repo/server/api.ts',
  );
});

test('targetPathOf reads notebook_path as well', () => {
  assert.equal(
    targetPathOf({ tool_name: 'NotebookEdit', tool_input: { notebook_path: '/repo/a.ipynb' } }),
    '/repo/a.ipynb',
  );
});

test('targetPathOf returns null when there is no path to check', () => {
  assert.equal(targetPathOf({ tool_name: 'Edit', tool_input: {} }), null);
  assert.equal(targetPathOf({ tool_name: 'Read' }), null);
});

test('buildDenyOutput ALWAYS carries permissionDecisionReason', () => {
  // Phase 0: a deny without a reason makes Codex report the hook Failed and
  // run the tool anyway — a silent fail-open. This test is the guard.
  const out = buildDenyOutput('PreToolUse', 'BLOCKED by mesh: held by codex-1');
  const specific = (out.hookSpecificOutput ?? {}) as Record<string, unknown>;
  assert.equal(specific.hookEventName, 'PreToolUse');
  assert.equal(specific.permissionDecision, 'deny');
  assert.ok(
    typeof specific.permissionDecisionReason === 'string' &&
      specific.permissionDecisionReason.length > 0,
    'a deny without a reason silently fails open on Codex',
  );
});

test('buildDenyOutput does not emit systemMessage alongside the decision', () => {
  // Phase 0 measured this exact combination reporting Failed.
  const out = buildDenyOutput('PreToolUse', 'blocked');
  assert.equal('systemMessage' in out, false);
});

import { targetPathsOf } from '../src/hook.ts';

test('apply_patch is enforced — the Phase 3 spike proved Codex uses it', () => {
  assert.ok(WRITE_TOOLS.has('apply_patch'));
});

test('targetPathsOf extracts every path from an apply_patch envelope', () => {
  const patch = [
    '*** Begin Patch',
    '*** Update File: server/api/leads.ts',
    '-old',
    '+new',
    '*** Add File: server/api/new.ts',
    '*** Delete File: server/api/old.ts',
    '*** End Patch',
  ].join('\n');

  const paths = targetPathsOf({ tool_name: 'apply_patch', tool_input: { input: patch } });
  assert.deepEqual(paths, [
    'server/api/leads.ts',
    'server/api/new.ts',
    'server/api/old.ts',
  ]);
});

test('targetPathsOf finds the patch text under any field name', () => {
  // The exact key Codex uses is an implementation detail, so every string
  // field is scanned for the envelope rather than trusting one name.
  const patch = '*** Begin Patch\n*** Update File: db/schema.sql\n*** End Patch';
  assert.deepEqual(
    targetPathsOf({ tool_name: 'apply_patch', tool_input: { patch } }),
    ['db/schema.sql'],
  );
});

test('targetPathsOf still handles ordinary single-path tools', () => {
  assert.deepEqual(
    targetPathsOf({ tool_name: 'Edit', tool_input: { file_path: '/repo/app/page.tsx' } }),
    ['/repo/app/page.tsx'],
  );
  assert.deepEqual(targetPathsOf({ tool_name: 'Edit', tool_input: {} }), []);
});
