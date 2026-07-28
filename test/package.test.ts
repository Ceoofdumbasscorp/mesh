import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
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
