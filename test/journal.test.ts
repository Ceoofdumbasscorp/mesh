import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, realpathSync, rmSync, statSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { testClock } from '../src/clock.ts';
import { meshPaths, ensureMeshHome } from '../src/paths.ts';
import { Journal } from '../src/journal.ts';

function scratch(): string {
  return mkdtempSync(join(tmpdir(), 'mesh-journal-'));
}

test('meshPaths derives every path from one home directory', () => {
  const paths = meshPaths('/somewhere/.mesh');
  assert.equal(paths.home, '/somewhere/.mesh');
  assert.equal(paths.socket, '/somewhere/.mesh/mesh.sock');
  assert.equal(paths.journal, '/somewhere/.mesh/journal.jsonl');
  assert.equal(paths.workspaceDir('abc123'), '/somewhere/.mesh/ws-abc123');
});

test('ensureMeshHome creates the directory with 0700', () => {
  const base = scratch();
  try {
    const paths = meshPaths(join(base, '.mesh'));
    ensureMeshHome(paths);
    const mode = statSync(paths.home).mode & 0o777;
    assert.equal(mode, 0o700);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test('ensureMeshHome is idempotent', () => {
  const base = scratch();
  try {
    const paths = meshPaths(join(base, '.mesh'));
    ensureMeshHome(paths);
    ensureMeshHome(paths);
    assert.ok(statSync(paths.home).isDirectory());
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test('append stamps entries with the injected clock and reads them back', () => {
  const base = scratch();
  try {
    const clock = testClock(1000);
    const file = join(base, 'journal.jsonl');
    const journal = new Journal(file, clock.now);

    journal.append('register', { name: 'claude-1' });
    clock.advance(250);
    journal.append('unregister', { name: 'claude-1' });
    journal.close();

    const entries = new Journal(file, clock.now).read();
    assert.equal(entries.length, 2);
    assert.deepEqual(entries[0], { at: 1000, kind: 'register', name: 'claude-1' });
    assert.deepEqual(entries[1], { at: 1250, kind: 'unregister', name: 'claude-1' });
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test('read returns an empty array when the journal does not exist yet', () => {
  const base = scratch();
  try {
    const journal = new Journal(join(base, 'missing.jsonl'), testClock().now);
    assert.deepEqual(journal.read(), []);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test('read skips a torn final line instead of throwing', () => {
  const base = scratch();
  try {
    const file = join(base, 'journal.jsonl');
    writeFileSync(file, '{"at":1,"kind":"a"}\n{"at":2,"kind":"trunc"');
    const entries = new Journal(file, testClock().now).read();
    assert.equal(entries.length, 1);
    assert.equal(entries[0]?.kind, 'a');
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test('append writes one line per entry', () => {
  const base = scratch();
  try {
    const file = join(base, 'journal.jsonl');
    const journal = new Journal(file, testClock().now);
    journal.append('a', {});
    journal.append('b', {});
    journal.close();

    const lines = readFileSync(file, 'utf8').trim().split('\n');
    assert.equal(lines.length, 2);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test('the journal rotates instead of growing without limit', () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'mesh-journal-rot-')));
  const file = join(dir, 'journal.jsonl');
  try {
    const clock = testClock(1000);
    // A tiny cap makes the boundary observable without writing megabytes.
    const journal = new Journal(file, clock.now, 400);
    for (let i = 0; i < 20; i += 1) journal.append('noise', { i, pad: 'x'.repeat(40) });

    assert.ok(existsSync(`${file}.1`), 'one previous generation is kept');
    assert.ok(statSync(file).size <= 400, 'the live file stays under the cap');

    const live = journal.read();
    assert.ok(live.length > 0, 'the live file still holds the most recent entries');
    assert.equal(live.at(-1)?.i, 19, 'the newest entry survives rotation');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a journal picks up the size of a file it did not create', () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'mesh-journal-rot-')));
  const file = join(dir, 'journal.jsonl');
  try {
    writeFileSync(file, 'x'.repeat(500));
    const clock = testClock(1000);
    new Journal(file, clock.now, 400).append('first', {});

    assert.ok(existsSync(`${file}.1`), 'an oversized pre-existing file is rotated on first write');
    assert.equal(new Journal(file, clock.now).read().length, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
