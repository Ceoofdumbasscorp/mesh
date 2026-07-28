import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { distEntryPoint, requireBuiltEntryPoint } from '../src/install/entry.ts';
import { backupFile, backupStamp, writeFileAtomic } from '../src/install/backup.ts';

test('distEntryPoint resolves the compiled CLI, never the TypeScript source', () => {
  const entry = distEntryPoint(pathToFileURL('/pkg/src/install/entry.ts').href);
  assert.equal(entry, '/pkg/dist/cli/index.js');
});

test('distEntryPoint resolves the same target when it is itself running compiled', () => {
  const entry = distEntryPoint(pathToFileURL('/pkg/dist/install/entry.js').href);
  assert.equal(entry, '/pkg/dist/cli/index.js');
});

test('requireBuiltEntryPoint tells the user to build rather than writing a dead path', () => {
  assert.throws(
    () => requireBuiltEntryPoint('/nope/dist/cli/index.js'),
    /npm run build/,
    'the error names the fix',
  );
});

test('requireBuiltEntryPoint returns the path when it exists', () => {
  const dir = mkdtempSync(join(tmpdir(), 'mesh-entry-'));
  const entry = join(dir, 'index.js');
  writeFileSync(entry, '// built');
  assert.equal(requireBuiltEntryPoint(entry), entry);
  rmSync(dir, { recursive: true, force: true });
});

test('backupStamp is filename-safe', () => {
  const stamp = backupStamp(Date.parse('2026-07-27T09:30:15.123Z'));
  assert.doesNotMatch(stamp, /[:.]/);
  assert.match(stamp, /2026-07-27/);
});

test('backupFile copies an existing file and reports where', () => {
  const dir = mkdtempSync(join(tmpdir(), 'mesh-backup-'));
  const path = join(dir, 'settings.json');
  writeFileSync(path, '{"a":1}');

  const backup = backupFile(path, 'stamp');
  assert.equal(backup, `${path}.mesh-backup-stamp`);
  assert.equal(readFileSync(backup as string, 'utf8'), '{"a":1}');
  rmSync(dir, { recursive: true, force: true });
});

test('backupFile returns null for a file that does not exist yet', () => {
  const dir = mkdtempSync(join(tmpdir(), 'mesh-backup-'));
  assert.equal(backupFile(join(dir, 'absent.json'), 'stamp'), null);
  rmSync(dir, { recursive: true, force: true });
});

test('writeFileAtomic creates missing directories and leaves no temp file', () => {
  const dir = mkdtempSync(join(tmpdir(), 'mesh-write-'));
  const path = join(dir, 'nested', 'deeper', 'file.json');

  writeFileAtomic(path, '{"ok":true}');

  assert.equal(readFileSync(path, 'utf8'), '{"ok":true}');
  assert.equal(existsSync(`${path}.mesh-tmp`), false);
  rmSync(dir, { recursive: true, force: true });
});

test('writeFileAtomic preserves the mode of a file it replaces', () => {
  const dir = mkdtempSync(join(tmpdir(), 'mesh-write-'));
  const path = join(dir, 'file.json');
  writeFileSync(path, 'old', { mode: 0o644 });

  writeFileAtomic(path, 'new');

  assert.equal(readFileSync(path, 'utf8'), 'new');
  assert.equal(statSync(path).mode & 0o777, 0o644, 'a user config keeps its permissions');
  rmSync(dir, { recursive: true, force: true });
});
