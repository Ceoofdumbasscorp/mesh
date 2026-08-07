import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  rmSync,
  realpathSync,
  chmodSync,
  statSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  isWorkspaceEnabled,
  enableWorkspace,
  disableWorkspace,
  listEnabledWorkspaces,
} from '../src/enabled.ts';

function scratch(): string {
  return realpathSync(mkdtempSync(join(tmpdir(), 'mesh-en-')));
}

/**
 * The whole point of this module is that mesh is OFF unless the operator said
 * otherwise. Every ambiguous case must resolve to off, never to on.
 */
test('a workspace is off when no enabled file exists', () => {
  const home = scratch();
  try {
    assert.equal(isWorkspaceEnabled('/anywhere', home), false);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('enable then disable round-trips', () => {
  const home = scratch();
  const ws = scratch();
  try {
    assert.equal(isWorkspaceEnabled(ws, home), false);

    enableWorkspace(ws, home);
    assert.equal(isWorkspaceEnabled(ws, home), true);

    disableWorkspace(ws, home);
    assert.equal(isWorkspaceEnabled(ws, home), false);
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(ws, { recursive: true, force: true });
  }
});

test('enabling one workspace does not enable another', () => {
  const home = scratch();
  const on = scratch();
  const off = scratch();
  try {
    enableWorkspace(on, home);
    assert.equal(isWorkspaceEnabled(on, home), true);
    assert.equal(isWorkspaceEnabled(off, home), false);
  } finally {
    for (const d of [home, on, off]) rmSync(d, { recursive: true, force: true });
  }
});

test('enabling twice does not duplicate the entry', () => {
  const home = scratch();
  const ws = scratch();
  try {
    enableWorkspace(ws, home);
    enableWorkspace(ws, home);
    assert.deepEqual(listEnabledWorkspaces(home), [ws]);
  } finally {
    for (const d of [home, ws]) rmSync(d, { recursive: true, force: true });
  }
});

test('disabling a workspace that was never enabled is a no-op, not an error', () => {
  const home = scratch();
  try {
    disableWorkspace('/never/enabled', home);
    assert.deepEqual(listEnabledWorkspaces(home), []);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('a corrupt enabled file reads as off, not as on', () => {
  const home = scratch();
  try {
    mkdirSync(home, { recursive: true });
    writeFileSync(join(home, 'enabled.json'), '{ this is not json');
    assert.equal(isWorkspaceEnabled('/anywhere', home), false);
    assert.deepEqual(listEnabledWorkspaces(home), []);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('an enabled file of the wrong shape reads as off', () => {
  const home = scratch();
  try {
    mkdirSync(home, { recursive: true });
    // A JSON object, not the array of roots the format calls for.
    writeFileSync(join(home, 'enabled.json'), '{"/some/root":true}');
    assert.equal(isWorkspaceEnabled('/some/root', home), false);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('non-string entries are ignored rather than matched loosely', () => {
  const home = scratch();
  try {
    mkdirSync(home, { recursive: true });
    writeFileSync(join(home, 'enabled.json'), '[1, null, true, {"root":"/x"}]');
    assert.deepEqual(listEnabledWorkspaces(home), []);
    assert.equal(isWorkspaceEnabled('/x', home), false);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('an unreadable enabled file reads as off', () => {
  const home = scratch();
  try {
    mkdirSync(home, { recursive: true });
    const file = join(home, 'enabled.json');
    writeFileSync(file, '["/some/root"]');
    chmodSync(file, 0o000);
    assert.equal(isWorkspaceEnabled('/some/root', home), false);
  } finally {
    try {
      chmodSync(join(home, 'enabled.json'), 0o600);
    } catch {}
    rmSync(home, { recursive: true, force: true });
  }
});

test('roots are canonicalized on both write and read', () => {
  const home = scratch();
  const ws = scratch();
  try {
    // A path with a redundant segment names the same directory.
    enableWorkspace(join(ws, 'sub', '..'), home);
    mkdirSync(join(ws, 'sub'), { recursive: true });
    assert.equal(isWorkspaceEnabled(ws, home), true);
  } finally {
    for (const d of [home, ws]) rmSync(d, { recursive: true, force: true });
  }
});

test('a subdirectory of an enabled workspace is not itself enabled', () => {
  const home = scratch();
  const ws = scratch();
  try {
    // Callers pass an already-resolved workspace ROOT. Prefix matching here
    // would silently enable sibling repos nested under an enabled one.
    enableWorkspace(ws, home);
    assert.equal(isWorkspaceEnabled(join(ws, 'nested'), home), false);
  } finally {
    for (const d of [home, ws]) rmSync(d, { recursive: true, force: true });
  }
});

test('the enabled file is owner-only', () => {
  const home = scratch();
  const ws = scratch();
  try {
    enableWorkspace(ws, home);
    assert.equal(statSync(join(home, 'enabled.json')).mode & 0o777, 0o600);
  } finally {
    for (const d of [home, ws]) rmSync(d, { recursive: true, force: true });
  }
});
