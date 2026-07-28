import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  MESH_HOOK_EVENTS,
  meshHookCommand,
  shellQuote,
  withMeshHooks,
} from '../src/install/hooks.ts';
import { withMeshNote, MESH_NOTE_BEGIN } from '../src/install/note.ts';
import { claudePaths, planClaudeInstall, applyClaudeInstall } from '../src/install/claude.ts';

test('mesh installs SessionStart and PreToolUse only', () => {
  // Every extra event costs 64ms on a path the user feels. PostToolUse adds
  // nothing PreToolUse does not already report; Stop belongs to Phase 4.
  assert.deepEqual([...MESH_HOOK_EVENTS], ['SessionStart', 'PreToolUse']);
});

test('meshHookCommand points at the compiled entry with the event', () => {
  const command = meshHookCommand({
    nodePath: '/usr/bin/node',
    entry: '/pkg/dist/cli/index.js',
    event: 'PreToolUse',
  });
  assert.equal(command, '/usr/bin/node /pkg/dist/cli/index.js hook PreToolUse');
});

test('meshHookCommand carries env as a shell prefix', () => {
  const command = meshHookCommand({
    nodePath: '/usr/bin/node',
    entry: '/pkg/dist/cli/index.js',
    event: 'PreToolUse',
    env: { MESH_PROVIDER: 'codex' },
  });
  assert.equal(command, 'MESH_PROVIDER=codex /usr/bin/node /pkg/dist/cli/index.js hook PreToolUse');
});

test('shellQuote protects paths with spaces', () => {
  assert.equal(shellQuote('/Users/k/My Projects/mesh'), "'/Users/k/My Projects/mesh'");
  assert.equal(shellQuote('/usr/bin/node'), '/usr/bin/node');
  assert.equal(shellQuote("it's"), "'it'\\''s'");
});

test('withMeshHooks leaves other tools hooks untouched', () => {
  const existing = {
    SessionStart: [{ matcher: '', hooks: [{ type: 'command' as const, command: 'cmux hooks x' }] }],
    Stop: [{ matcher: '', hooks: [{ type: 'command' as const, command: 'cmux hooks stop' }] }],
  };

  const merged = withMeshHooks(existing, {
    nodePath: 'node',
    entry: '/pkg/dist/cli/index.js',
    includeMatcher: true,
  });

  assert.equal(merged.SessionStart?.length, 2, 'appended, not replaced');
  assert.match(JSON.stringify(merged.SessionStart), /cmux hooks x/);
  assert.deepEqual(merged.Stop, existing.Stop, 'an event mesh does not use is untouched');
});

test('withMeshHooks is idempotent — running init twice adds one hook, not two', () => {
  const once = withMeshHooks(
    {},
    { nodePath: 'node', entry: '/pkg/dist/cli/index.js', includeMatcher: true },
  );
  const twice = withMeshHooks(once, {
    nodePath: 'node',
    entry: '/pkg/dist/cli/index.js',
    includeMatcher: true,
  });

  assert.deepEqual(twice, once);
  assert.equal(twice.PreToolUse?.length, 1);
});

test('withMeshHooks repoints an older mesh entry rather than duplicating it', () => {
  const old = withMeshHooks(
    {},
    { nodePath: '/old/node', entry: '/pkg/dist/cli/index.js', includeMatcher: true },
  );
  const updated = withMeshHooks(old, {
    nodePath: '/new/node',
    entry: '/pkg/dist/cli/index.js',
    includeMatcher: true,
  });

  assert.equal(updated.PreToolUse?.length, 1);
  assert.match(JSON.stringify(updated.PreToolUse), /\/new\/node/);
  assert.doesNotMatch(JSON.stringify(updated.PreToolUse), /\/old\/node/);
});

test('withMeshHooks omits the matcher key when the host does not use one', () => {
  const merged = withMeshHooks(
    {},
    { nodePath: 'node', entry: '/pkg/dist/cli/index.js', includeMatcher: false },
  );
  assert.equal('matcher' in (merged.PreToolUse?.[0] ?? {}), false);
});

test('withMeshNote adds a fenced, attributed block once', () => {
  const first = withMeshNote('# My instructions\n');
  assert.match(first, /My instructions/);
  assert.match(first, /mesh_who/);
  assert.ok(first.includes(MESH_NOTE_BEGIN));

  const second = withMeshNote(first);
  assert.equal(second, first, 'idempotent');
  assert.equal(second.split(MESH_NOTE_BEGIN).length - 1, 1, 'exactly one block');
});

test('withMeshNote replaces an outdated block instead of stacking a new one', () => {
  const stale = `# Notes\n\n${MESH_NOTE_BEGIN}\nold text\n<!-- mesh:end -->\n`;
  const fresh = withMeshNote(stale);
  assert.doesNotMatch(fresh, /old text/);
  assert.equal(fresh.split(MESH_NOTE_BEGIN).length - 1, 1);
});

test('claudePaths names the two files mesh touches', () => {
  const paths = claudePaths('/home/k');
  assert.equal(paths.settings, '/home/k/.claude/settings.json');
  assert.equal(paths.instructions, '/home/k/.claude/CLAUDE.md');
});

test('planClaudeInstall reports absent when Claude is not installed', () => {
  const dir = mkdtempSync(join(tmpdir(), 'mesh-claude-'));
  const plan = planClaudeInstall({
    home: dir,
    nodePath: 'node',
    entry: '/pkg/dist/cli/index.js',
    now: 0,
  });
  assert.equal(plan.present, false);
  rmSync(dir, { recursive: true, force: true });
});

test('applyClaudeInstall merges hooks, backs up, and keeps other settings', () => {
  const dir = mkdtempSync(join(tmpdir(), 'mesh-claude-'));
  mkdirSync(join(dir, '.claude'));
  const settings = join(dir, '.claude', 'settings.json');
  writeFileSync(settings, JSON.stringify({ model: 'opus', hooks: { Stop: [] } }, null, 2));

  const plan = planClaudeInstall({
    home: dir,
    nodePath: 'node',
    entry: '/pkg/dist/cli/index.js',
    now: Date.parse('2026-07-27T09:00:00Z'),
  });
  const written = applyClaudeInstall(plan);

  const after = JSON.parse(readFileSync(settings, 'utf8'));
  assert.equal(after.model, 'opus', 'unrelated settings survive');
  assert.equal(after.hooks.PreToolUse.length, 1);
  assert.match(after.hooks.PreToolUse[0].hooks[0].command, /dist\/cli\/index\.js hook PreToolUse/);
  assert.ok(
    written.some((path) => path.includes('mesh-backup')),
    'a backup was taken',
  );
  rmSync(dir, { recursive: true, force: true });
});

test('applyClaudeInstall creates settings.json when only the directory exists', () => {
  const dir = mkdtempSync(join(tmpdir(), 'mesh-claude-'));
  mkdirSync(join(dir, '.claude'));

  const plan = planClaudeInstall({ home: dir, nodePath: 'node', entry: '/e.js', now: 0 });
  applyClaudeInstall(plan);

  const after = JSON.parse(readFileSync(join(dir, '.claude', 'settings.json'), 'utf8'));
  assert.equal(after.hooks.SessionStart.length, 1);
  rmSync(dir, { recursive: true, force: true });
});

test('applyClaudeInstall refuses to touch settings it cannot parse', () => {
  const dir = mkdtempSync(join(tmpdir(), 'mesh-claude-'));
  mkdirSync(join(dir, '.claude'));
  const settings = join(dir, '.claude', 'settings.json');
  writeFileSync(settings, '{ not json');

  const plan = planClaudeInstall({ home: dir, nodePath: 'node', entry: '/e.js', now: 0 });
  assert.throws(() => applyClaudeInstall(plan), /could not parse/i);
  assert.equal(readFileSync(settings, 'utf8'), '{ not json', 'the file is left exactly as it was');
  rmSync(dir, { recursive: true, force: true });
});
