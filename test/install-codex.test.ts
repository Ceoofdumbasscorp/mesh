import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  codexHookTrustRecorded,
  codexPaths,
  ensureCodexHooksFeature,
  planCodexInstall,
  applyCodexInstall,
} from '../src/install/codex.ts';

test('codexPaths names the three files mesh reads or writes', () => {
  const paths = codexPaths('/home/k');
  assert.equal(paths.hooks, '/home/k/.codex/hooks.json');
  assert.equal(paths.config, '/home/k/.codex/config.toml');
  assert.equal(paths.instructions, '/home/k/.codex/AGENTS.md');
});

test('ensureCodexHooksFeature appends the section when it is missing', () => {
  const { text, changed } = ensureCodexHooksFeature('model = "gpt-5"\n');
  assert.equal(changed, true);
  assert.match(text, /\[features\]\nhooks = true/);
  assert.match(text, /model = "gpt-5"/, 'existing config survives');
});

test('ensureCodexHooksFeature adds the key to an existing features section', () => {
  const { text, changed } = ensureCodexHooksFeature(
    '[features]\nsomething = true\n\n[tui]\nx = 1\n',
  );
  assert.equal(changed, true);
  assert.match(text, /\[features\]\nhooks = true\nsomething = true/);
  assert.match(text, /\[tui\]\nx = 1/, 'the next section is untouched');
});

test('ensureCodexHooksFeature flips an explicit false', () => {
  const { text, changed } = ensureCodexHooksFeature('[features]\nhooks = false\n');
  assert.equal(changed, true);
  assert.match(text, /hooks = true/);
  assert.doesNotMatch(text, /hooks = false/);
});

test('ensureCodexHooksFeature is a no-op when hooks are already enabled', () => {
  const input = '[features]\nhooks = true\n\n[tui]\n';
  const { text, changed } = ensureCodexHooksFeature(input);
  assert.equal(changed, false);
  assert.equal(text, input, 'an unchanged file is not rewritten');
});

test('ensureCodexHooksFeature handles an empty config', () => {
  const { text } = ensureCodexHooksFeature('');
  assert.match(text, /\[features\]\nhooks = true/);
});

test('codexHookTrustRecorded requires approval for every event mesh installs', () => {
  const path = '/home/k/.codex/hooks.json';
  const trust = (event: string) =>
    `[hooks.state."${path}:${event}:0:0"]\ntrusted_hash = "sha256:abc"\n`;

  assert.equal(
    codexHookTrustRecorded(`${trust('session_start')}${trust('pre_tool_use')}`, path),
    true,
  );
  // A machine whose hooks.json holds only another tool's SessionStart hook
  // must not report mesh's PreToolUse enforcement hook as approved.
  assert.equal(codexHookTrustRecorded(trust('session_start'), path), false);
  assert.equal(codexHookTrustRecorded(trust('pre_tool_use'), '/other/hooks.json'), false);
  assert.equal(codexHookTrustRecorded('', path), false);
});

test('planCodexInstall reports absent when Codex is not installed', () => {
  const dir = mkdtempSync(join(tmpdir(), 'mesh-codex-'));
  const plan = planCodexInstall({ home: dir, nodePath: 'node', entry: '/e.js', now: 0 });
  assert.equal(plan.present, false);
  rmSync(dir, { recursive: true, force: true });
});

test('applyCodexInstall writes hooks that declare the provider', () => {
  const dir = mkdtempSync(join(tmpdir(), 'mesh-codex-'));
  mkdirSync(join(dir, '.codex'));

  const plan = planCodexInstall({
    home: dir,
    nodePath: '/usr/bin/node',
    entry: '/pkg/dist/cli/index.js',
    now: 0,
  });
  applyCodexInstall(plan);

  const hooks = JSON.parse(readFileSync(join(dir, '.codex', 'hooks.json'), 'utf8'));
  const command = hooks.hooks.PreToolUse[0].hooks[0].command;
  // Without this the hook registers the Codex agent as a Claude one: the
  // journal from the Phase 3 demo shows exactly that mislabelling.
  assert.match(command, /MESH_PROVIDER=codex/);
  assert.match(command, /dist\/cli\/index\.js hook PreToolUse/);
  assert.equal('matcher' in hooks.hooks.PreToolUse[0], false, 'Codex config carries no matcher');
  rmSync(dir, { recursive: true, force: true });
});

test('applyCodexInstall preserves another tool hooks and enables the feature', () => {
  const dir = mkdtempSync(join(tmpdir(), 'mesh-codex-'));
  mkdirSync(join(dir, '.codex'));
  writeFileSync(
    join(dir, '.codex', 'hooks.json'),
    JSON.stringify({
      hooks: { SessionStart: [{ hooks: [{ type: 'command', command: 'bash other.sh' }] }] },
    }),
  );
  writeFileSync(join(dir, '.codex', 'config.toml'), 'model = "gpt-5"\n');

  const plan = planCodexInstall({ home: dir, nodePath: 'node', entry: '/e.js', now: 0 });
  applyCodexInstall(plan);

  const hooks = JSON.parse(readFileSync(join(dir, '.codex', 'hooks.json'), 'utf8'));
  assert.equal(hooks.hooks.SessionStart.length, 2);
  assert.match(JSON.stringify(hooks), /bash other\.sh/);

  const config = readFileSync(join(dir, '.codex', 'config.toml'), 'utf8');
  assert.match(config, /\[features\]\nhooks = true/);
  assert.match(config, /model = "gpt-5"/);
  rmSync(dir, { recursive: true, force: true });
});

test('applyCodexInstall is idempotent', () => {
  const dir = mkdtempSync(join(tmpdir(), 'mesh-codex-'));
  mkdirSync(join(dir, '.codex'));

  const plan = planCodexInstall({ home: dir, nodePath: 'node', entry: '/e.js', now: 0 });
  applyCodexInstall(plan);
  const first = readFileSync(join(dir, '.codex', 'hooks.json'), 'utf8');
  const firstConfig = readFileSync(join(dir, '.codex', 'config.toml'), 'utf8');

  applyCodexInstall(planCodexInstall({ home: dir, nodePath: 'node', entry: '/e.js', now: 1 }));

  assert.equal(readFileSync(join(dir, '.codex', 'hooks.json'), 'utf8'), first);
  assert.equal(readFileSync(join(dir, '.codex', 'config.toml'), 'utf8'), firstConfig);
  rmSync(dir, { recursive: true, force: true });
});
