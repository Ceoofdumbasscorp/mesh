#!/usr/bin/env node
// Measures what the hook costs, because it runs before EVERY tool call.
//
// Measured on the development machine (Node 25.8.1, M-series macOS):
//   node startup floor .............. ~50ms   (irreducible without a native shim)
//   + TypeScript type-stripping ..... ~40ms   (only when running from src/)
//   + MCP SDK import ................ ~50ms   (never imported by the hook)
//
// So the shipped package must run compiled JS: from dist/ the hook sits at the
// Node floor, while running from src/ costs ~40ms more. Run `npm run build`
// first to measure the number users will actually experience.
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const RUNS = 7;
const BUDGET_MS = 90;

const targets = [
  { label: 'src (type-stripped)', entry: join(root, 'src/cli/index.ts') },
  { label: 'dist (compiled)', entry: join(root, 'dist/cli/index.js') },
];

const payload = JSON.stringify({ session_id: 'bench', cwd: root });

function timeOnce(entry) {
  const started = process.hrtime.bigint();
  spawnSync(process.execPath, [entry, 'hook', 'PreToolUse'], {
    input: payload,
    stdio: ['pipe', 'ignore', 'ignore'],
  });
  return Number(process.hrtime.bigint() - started) / 1e6;
}

let worstMeasured = 0;
for (const { label, entry } of targets) {
  if (!existsSync(entry)) {
    console.log(`  ${label.padEnd(22)} not built — run \`npm run build\``);
    continue;
  }
  const samples = [];
  timeOnce(entry); // discard a warm-up run
  for (let i = 0; i < RUNS; i += 1) samples.push(timeOnce(entry));
  samples.sort((a, b) => a - b);
  const p50 = samples[Math.floor(samples.length / 2)];
  const p95 = samples[Math.min(samples.length - 1, Math.floor(samples.length * 0.95))];
  console.log(`  ${label.padEnd(22)} p50 ${p50.toFixed(0)}ms   p95 ${p95.toFixed(0)}ms`);
  if (label.startsWith('dist')) worstMeasured = p95;
}

if (worstMeasured > BUDGET_MS) {
  console.error(`\nFAIL: compiled hook p95 ${worstMeasured.toFixed(0)}ms exceeds ${BUDGET_MS}ms`);
  process.exit(1);
}
console.log(`\nOK: within the ${BUDGET_MS}ms budget.`);
