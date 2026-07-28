import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

/**
 * The entry point hooks and MCP configs must point at: the COMPILED one.
 *
 * Measured in Phase 2 and unchanged since: the hook costs 64ms p95 from dist/
 * and ~105ms from src/, because TypeScript type-stripping is ~40ms per run and
 * the hook runs before EVERY tool call. Writing the source path into a user's
 * config would tax every session for the life of the install.
 *
 * Two levels up from this module is the package root whether this file is
 * running as src/install/entry.ts or as dist/install/entry.js.
 */
export function distEntryPoint(moduleUrl: string = import.meta.url): string {
  const packageRoot = resolve(dirname(fileURLToPath(moduleUrl)), '..', '..');
  return join(packageRoot, 'dist', 'cli', 'index.js');
}

export function requireBuiltEntryPoint(entry: string = distEntryPoint()): string {
  if (!existsSync(entry)) {
    throw new Error(
      `mesh init: ${entry} does not exist. Run \`npm run build\` first — ` +
        'hooks must run compiled JavaScript (64ms per tool call, against 105ms ' +
        'from TypeScript source).',
    );
  }
  return entry;
}
