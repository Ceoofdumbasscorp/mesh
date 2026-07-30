import { test } from 'node:test';
import assert from 'node:assert/strict';
import { shellWriteTargets } from '../src/shell.ts';

test('finds a plain redirect', () => {
  assert.deepEqual(shellWriteTargets('echo hi > server/api.ts'), ['server/api.ts']);
  assert.deepEqual(shellWriteTargets('echo hi >> server/api.ts'), ['server/api.ts']);
  assert.deepEqual(shellWriteTargets('echo hi>server/api.ts'), ['server/api.ts']);
});

test('finds the redirect in a heredoc, the usual way to write a whole file', () => {
  const command = "cat > server/api.ts <<'EOF'\n// changed by B\nEOF";
  assert.deepEqual(shellWriteTargets(command), ['server/api.ts']);
});

test('handles quoted and dot-relative paths', () => {
  assert.deepEqual(shellWriteTargets('echo hi > "server/my api.ts"'), ['server/my api.ts']);
  assert.deepEqual(shellWriteTargets("echo hi > './server/api.ts'"), ['server/api.ts']);
});

test('a stderr redirect is still a write, but >& is not a file', () => {
  assert.deepEqual(shellWriteTargets('run 2> logs/err.txt'), ['logs/err.txt']);
  assert.deepEqual(shellWriteTargets('run >&2'), []);
  assert.deepEqual(shellWriteTargets('run 2>&1'), []);
});

test('finds tee targets, including through a pipe', () => {
  assert.deepEqual(shellWriteTargets('echo hi | tee server/api.ts'), ['server/api.ts']);
  assert.deepEqual(shellWriteTargets('echo hi | tee -a server/api.ts'), ['server/api.ts']);
});

test('finds in-place sed', () => {
  assert.deepEqual(shellWriteTargets("sed -i '' s/a/b/ server/api.ts"), ['server/api.ts']);
  assert.deepEqual(shellWriteTargets('sed -i.bak s/a/b/ server/api.ts'), ['server/api.ts']);
});

test('finds destructive and moving commands', () => {
  assert.deepEqual(shellWriteTargets('rm -f server/api.ts'), ['server/api.ts']);
  assert.deepEqual(shellWriteTargets('mv /tmp/new.ts server/api.ts'), ['server/api.ts']);
  assert.deepEqual(shellWriteTargets('cp /tmp/new.ts server/api.ts'), ['server/api.ts']);
  assert.deepEqual(shellWriteTargets('dd if=/tmp/x of=server/api.ts'), ['server/api.ts']);
  assert.deepEqual(shellWriteTargets('touch server/api.ts'), ['server/api.ts']);
});

test('sees through a sudo or env prefix', () => {
  assert.deepEqual(shellWriteTargets('sudo rm server/api.ts'), ['server/api.ts']);
  assert.deepEqual(shellWriteTargets('LC_ALL=C sed -i s/a/b/ server/api.ts'), ['server/api.ts']);
});

test('finds every target across a chained command line', () => {
  assert.deepEqual(shellWriteTargets('npm test && echo ok > a.txt; rm b.txt'), [
    'a.txt',
    'b.txt',
  ]);
});

test('reads nothing into ordinary read-only commands', () => {
  for (const command of [
    'npm test',
    'git status',
    'ls -la server/',
    'grep -r foo server/',
    'cat server/api.ts',
    'node --test',
    'git diff HEAD~1',
  ]) {
    assert.deepEqual(shellWriteTargets(command), [], command);
  }
});

test('does not report the same file twice', () => {
  assert.deepEqual(shellWriteTargets('echo a > x.ts; echo b >> x.ts'), ['x.ts']);
});
