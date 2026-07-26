import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveWorkspace } from '../src/workspace.ts';

/**
 * Returns a canonical (symlink-resolved) temp dir. resolveWorkspace
 * deliberately canonicalizes, and on macOS the temp dir lives under /var,
 * which is a symlink to /private/var — so a raw mkdtemp path would never
 * compare equal to a resolved root even though both name the same directory.
 */
function scratch(): string {
  return realpathSync(mkdtempSync(join(tmpdir(), 'mesh-ws-')));
}

test('finds the git root from a nested directory', () => {
  const base = scratch();
  try {
    mkdirSync(join(base, '.git'));
    const nested = join(base, 'src', 'deep');
    mkdirSync(nested, { recursive: true });

    const ws = resolveWorkspace(nested);
    assert.equal(ws.root, base);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test('treats a .git FILE as a root so linked worktrees resolve', () => {
  const base = scratch();
  try {
    writeFileSync(join(base, '.git'), 'gitdir: /elsewhere/.git/worktrees/wt\n');
    const nested = join(base, 'app');
    mkdirSync(nested);

    const ws = resolveWorkspace(nested);
    assert.equal(ws.root, base);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test('falls back to cwd when there is no git root', () => {
  const base = scratch();
  try {
    const ws = resolveWorkspace(base);
    assert.equal(ws.root, base);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test('label is the basename of the root', () => {
  const base = scratch();
  try {
    mkdirSync(join(base, '.git'));
    const ws = resolveWorkspace(base);
    assert.equal(ws.label, base.split('/').pop());
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test('key is a stable 12-char hex digest, distinct per root', () => {
  const a = scratch();
  const b = scratch();
  try {
    const first = resolveWorkspace(a);
    const second = resolveWorkspace(a);
    const other = resolveWorkspace(b);

    assert.match(first.key, /^[0-9a-f]{12}$/);
    assert.equal(first.key, second.key, 'same root must yield the same key');
    assert.notEqual(first.key, other.key, 'different roots must differ');
  } finally {
    rmSync(a, { recursive: true, force: true });
    rmSync(b, { recursive: true, force: true });
  }
});

test('two directories inside one repo share a workspace', () => {
  const base = scratch();
  try {
    mkdirSync(join(base, '.git'));
    mkdirSync(join(base, 'app'));
    mkdirSync(join(base, 'server'));

    const front = resolveWorkspace(join(base, 'app'));
    const back = resolveWorkspace(join(base, 'server'));
    assert.equal(front.key, back.key);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});
