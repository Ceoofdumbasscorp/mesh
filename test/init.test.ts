import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runInit, renderInitSummary } from '../src/cli/init.ts';
import type { CommandRunner } from '../src/install/mcp.ts';

const okRunner: CommandRunner = () => ({ status: 0, stdout: '', stderr: '' });
const missingRunner: CommandRunner = () => ({ status: null, stdout: '', stderr: 'ENOENT' });

function homeWith(hosts: string[]): string {
  const dir = mkdtempSync(join(tmpdir(), 'mesh-init-'));
  for (const host of hosts) mkdirSync(join(dir, host));
  return dir;
}

test('runInit installs into every host that is present', () => {
  const home = homeWith(['.claude', '.codex']);

  const result = runInit({
    home,
    nodePath: 'node',
    entry: '/pkg/dist/cli/index.js',
    now: 0,
    dryRun: false,
    runner: okRunner,
  });

  assert.equal(result.hosts.length, 2);
  assert.ok(result.hosts.every((host) => host.present));
  assert.ok(existsSync(join(home, '.claude', 'settings.json')));
  assert.ok(existsSync(join(home, '.codex', 'hooks.json')));
  rmSync(home, { recursive: true, force: true });
});

test('runInit skips a host that is not installed', () => {
  const home = homeWith(['.claude']);

  const result = runInit({
    home,
    nodePath: 'node',
    entry: '/e.js',
    now: 0,
    dryRun: false,
    runner: okRunner,
  });

  const codex = result.hosts.find((host) => host.host === 'codex');
  assert.equal(codex?.present, false);
  assert.equal(codex?.written.length, 0);
  assert.equal(existsSync(join(home, '.codex')), false, 'mesh does not install Codex for you');
  rmSync(home, { recursive: true, force: true });
});

test('runInit writes nothing on a dry run', () => {
  const home = homeWith(['.claude', '.codex']);

  const result = runInit({
    home,
    nodePath: 'node',
    entry: '/e.js',
    now: 0,
    dryRun: true,
    runner: okRunner,
  });

  assert.equal(result.dryRun, true);
  assert.equal(existsSync(join(home, '.claude', 'settings.json')), false);
  assert.equal(existsSync(join(home, '.codex', 'hooks.json')), false);
  assert.ok(
    result.hosts.every((host) => host.mcp === null),
    'a dry run runs no host commands',
  );
  rmSync(home, { recursive: true, force: true });
});

test('runInit reports that Codex approval is not yet recorded', () => {
  const home = homeWith(['.codex']);

  const result = runInit({
    home,
    nodePath: 'node',
    entry: '/e.js',
    now: 0,
    dryRun: false,
    runner: okRunner,
  });

  const codex = result.hosts.find((host) => host.host === 'codex');
  assert.equal(codex?.trustPending, true, 'a fresh hooks.json has no recorded trust');
  rmSync(home, { recursive: true, force: true });
});

test('renderInitSummary names every file written and the next step', () => {
  const home = homeWith(['.claude', '.codex']);
  const result = runInit({
    home,
    nodePath: 'node',
    entry: '/e.js',
    now: 0,
    dryRun: false,
    runner: okRunner,
  });

  const out = renderInitSummary(result);
  assert.match(out, /settings\.json/);
  assert.match(out, /hooks\.json/);
  assert.match(out, /restart/i, 'a running agent does not pick up new hooks');
  assert.match(out, /trust/i, 'the Codex trust prompt is not a surprise');
  assert.match(out, /may ask/i, 'runtime policy is not inferred from a missing trust record');
  assert.doesNotMatch(out, /runs no hooks/i);
  assert.doesNotMatch(out, /undefined/);
  rmSync(home, { recursive: true, force: true });
});

test('renderInitSummary prints the manual command when a host CLI is missing', () => {
  const home = homeWith(['.claude']);
  const result = runInit({
    home,
    nodePath: 'node',
    entry: '/e.js',
    now: 0,
    dryRun: false,
    runner: missingRunner,
  });

  const out = renderInitSummary(result);
  assert.match(out, /claude mcp add --scope user mesh/);
  rmSync(home, { recursive: true, force: true });
});

test('renderInitSummary labels a dry run as a dry run', () => {
  const home = homeWith(['.claude']);
  const result = runInit({
    home,
    nodePath: 'node',
    entry: '/e.js',
    now: 0,
    dryRun: true,
    runner: okRunner,
  });

  const out = renderInitSummary(result);
  assert.match(out, /dry run/i);
  assert.match(out, /would/i);
  rmSync(home, { recursive: true, force: true });
});

test('runInit is idempotent across repeated runs', () => {
  const home = homeWith(['.claude', '.codex']);
  const options = {
    home,
    nodePath: 'node',
    entry: '/e.js',
    now: 0,
    dryRun: false,
    runner: okRunner,
  };

  runInit(options);
  const first = readFileSync(join(home, '.claude', 'settings.json'), 'utf8');
  runInit({ ...options, now: 1 });
  const second = readFileSync(join(home, '.claude', 'settings.json'), 'utf8');

  assert.equal(second, first);
  rmSync(home, { recursive: true, force: true });
});
