import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));

test('the published binary is the compiled entry point', () => {
  // Measured: 64ms p95 from dist, ~105ms from TypeScript source, on a path
  // that runs before every tool call.
  assert.equal(pkg.bin.mesh, './dist/cli/index.js');
});

test('the package ships dist and the README, not the TypeScript sources', () => {
  assert.ok(pkg.files.includes('dist'));
  assert.ok(pkg.files.includes('README.md'));
  assert.equal(pkg.files.includes('src'), false);
});

test('installing the package builds it', () => {
  assert.equal(pkg.scripts.prepare, 'npm run build');
});

test('the hook never imports the MCP SDK or zod', () => {
  // The same guard the Phase 2 test enforces, restated here because Phase 5
  // moved the CLI's imports around.
  const hook = readFileSync(join(root, 'src', 'hook.ts'), 'utf8');
  assert.doesNotMatch(hook, /modelcontextprotocol/);
  assert.doesNotMatch(hook, /from 'zod'/);
});

test('the compiled daemon entry point exists and is what the client will spawn', async () => {
  // Regression: client.ts hardcoded 'main.ts', so from dist/ it spawned
  // dist/daemon/main.ts — a file that does not exist. The spawn is detached
  // with stdio ignored, so the failure was silent and surfaced only as
  // "mesh: could not reach or start the daemon". The shipped package could
  // not start its own daemon; every test running from src/ hid it.
  if (!existsSync(join(root, 'dist'))) return; // not built; npm run build covers it
  assert.ok(existsSync(join(root, 'dist', 'daemon', 'main.js')));

  // Ask the COMPILED client what it would spawn, rather than grepping it: the
  // artifact's real behavior is the thing that was broken.
  const compiled = await import(pathToFileURL(join(root, 'dist', 'client.js')).href);
  const entry = compiled.daemonEntryPoint();
  assert.ok(entry.endsWith('dist/daemon/main.js'), `compiled client would spawn ${entry}`);
  assert.ok(existsSync(entry), 'the file the compiled client spawns must exist');
});
