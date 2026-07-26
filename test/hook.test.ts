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
