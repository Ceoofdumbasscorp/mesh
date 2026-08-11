import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  readSessionCapability,
  removeSessionCapability,
  writeSessionCapability,
} from '../src/session-capability.ts';

test('session capabilities are owner-only and removed with the owning session', () => {
  const base = mkdtempSync(join(tmpdir(), 'mesh-capability-'));
  const previous = process.env.MESH_HOME;
  process.env.MESH_HOME = join(base, '.mesh');
  try {
    writeSessionCapability(4242, 'secret-capability');
    const path = join(process.env.MESH_HOME, 'session-4242.cap');
    assert.equal(statSync(path).mode & 0o777, 0o600);
    assert.equal(readSessionCapability(4242), 'secret-capability');
    removeSessionCapability(4242);
    assert.equal(readSessionCapability(4242), undefined);
  } finally {
    if (previous === undefined) delete process.env.MESH_HOME;
    else process.env.MESH_HOME = previous;
    rmSync(base, { recursive: true, force: true });
  }
});

test('session capability writes refuse pre-existing symlinks', () => {
  const base = mkdtempSync(join(tmpdir(), 'mesh-capability-'));
  const previous = process.env.MESH_HOME;
  process.env.MESH_HOME = join(base, '.mesh');
  try {
    writeSessionCapability(1, 'bootstrap');
    removeSessionCapability(1);
    const victim = join(base, 'victim.txt');
    writeFileSync(victim, 'unchanged');
    symlinkSync(victim, join(process.env.MESH_HOME, 'session-4242.cap'));
    assert.throws(() => writeSessionCapability(4242, 'overwrite'), /unsafe/i);
    assert.equal(readFileSync(victim, 'utf8'), 'unchanged');
  } finally {
    if (previous === undefined) delete process.env.MESH_HOME;
    else process.env.MESH_HOME = previous;
    rmSync(base, { recursive: true, force: true });
  }
});
