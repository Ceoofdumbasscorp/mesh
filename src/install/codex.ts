import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { backupFile, backupStamp, writeFileAtomic } from './backup.ts';
import { withMeshHooks } from './hooks.ts';
import type { HookConfig } from './hooks.ts';
import { withMeshNote } from './note.ts';

export interface CodexInstallInput {
  home: string;
  nodePath: string;
  entry: string;
  now: number;
}

export interface CodexInstallPlan {
  present: boolean;
  hooksPath: string;
  configPath: string;
  instructionsPath: string;
  stamp: string;
  nodePath: string;
  entry: string;
}

export function codexPaths(home: string): {
  hooks: string;
  config: string;
  instructions: string;
} {
  return {
    hooks: join(home, '.codex', 'hooks.json'),
    config: join(home, '.codex', 'config.toml'),
    instructions: join(home, '.codex', 'AGENTS.md'),
  };
}

const FEATURES_HEADER = /^\[features\]\s*$/m;
const HOOKS_TRUE = /^\s*hooks\s*=\s*true\s*$/m;
const HOOKS_ANY = /^\s*hooks\s*=.*$/m;

/**
 * Codex runs no hooks at all without `[features] hooks = true`.
 *
 * Edited as text rather than parsed and re-serialized: Node has no TOML
 * writer, and a round-trip through one would reformat a file full of the
 * user's own settings. This touches one line and leaves everything else byte
 * for byte as it was.
 */
export function ensureCodexHooksFeature(toml: string): { text: string; changed: boolean } {
  const header = FEATURES_HEADER.exec(toml);

  if (!header) {
    const separator = toml.length === 0 || toml.endsWith('\n') ? '' : '\n';
    return { text: `${toml}${separator}\n[features]\nhooks = true\n`, changed: true };
  }

  const bodyStart = header.index + header[0].length;
  const rest = toml.slice(bodyStart);
  const nextHeader = /^\[/m.exec(rest);
  const bodyEnd = nextHeader ? bodyStart + nextHeader.index : toml.length;
  const body = toml.slice(bodyStart, bodyEnd);

  if (HOOKS_TRUE.test(body)) return { text: toml, changed: false };

  if (HOOKS_ANY.test(body)) {
    const fixed = body.replace(HOOKS_ANY, 'hooks = true');
    return { text: `${toml.slice(0, bodyStart)}${fixed}${toml.slice(bodyEnd)}`, changed: true };
  }

  return {
    text: `${toml.slice(0, bodyStart)}\nhooks = true${body}${toml.slice(bodyEnd)}`,
    changed: true,
  };
}

/**
 * Whether Codex has recorded the user's approval of this hooks file.
 *
 * Codex stores it as `[hooks.state."<path>:<event>:<i>:<j>"] trusted_hash`.
 * mesh only ever READS this: approving a hook is the user's decision, and
 * forging the entry would be mesh silently granting itself execution rights.
 */
export function codexHookTrustRecorded(toml: string, hooksPath: string): boolean {
  return toml.includes(`[hooks.state."${hooksPath}:`);
}

export function planCodexInstall(input: CodexInstallInput): CodexInstallPlan {
  const paths = codexPaths(input.home);
  return {
    present: existsSync(join(input.home, '.codex')),
    hooksPath: paths.hooks,
    configPath: paths.config,
    instructionsPath: paths.instructions,
    stamp: backupStamp(input.now),
    nodePath: input.nodePath,
    entry: input.entry,
  };
}

function readHookFile(path: string): Record<string, unknown> {
  if (!existsSync(path)) return {};
  const raw = readFileSync(path, 'utf8').trim();
  if (raw.length === 0) return {};
  try {
    const parsed = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      throw new Error('not an object');
    }
    return parsed as Record<string, unknown>;
  } catch (error) {
    throw new Error(
      `mesh init: could not parse ${path} (${(error as Error).message}). Fix or move it, then re-run.`,
    );
  }
}

/** Returns every path written, backups included. */
export function applyCodexInstall(plan: CodexInstallPlan): string[] {
  const written: string[] = [];

  const file = readHookFile(plan.hooksPath);
  file.hooks = withMeshHooks((file.hooks ?? {}) as HookConfig, {
    nodePath: plan.nodePath,
    entry: plan.entry,
    // Measured 2026-07-27: Codex scrubs the environment it gives an MCP
    // server, and the hook otherwise defaults to provider "claude" — which is
    // how the Phase 3 demo journal ended up with a codex agent labelled claude.
    env: { MESH_PROVIDER: 'codex' },
    includeMatcher: false,
  });

  const nextText = `${JSON.stringify(file, null, 2)}\n`;
  const currentText = existsSync(plan.hooksPath) ? readFileSync(plan.hooksPath, 'utf8') : '';
  if (nextText !== currentText) {
    const backup = backupFile(plan.hooksPath, plan.stamp);
    if (backup) written.push(backup);
    writeFileAtomic(plan.hooksPath, nextText);
    written.push(plan.hooksPath);
  }

  const config = existsSync(plan.configPath) ? readFileSync(plan.configPath, 'utf8') : '';
  const feature = ensureCodexHooksFeature(config);
  if (feature.changed) {
    const backup = backupFile(plan.configPath, plan.stamp);
    if (backup) written.push(backup);
    writeFileAtomic(plan.configPath, feature.text);
    written.push(plan.configPath);
  }

  const instructions = existsSync(plan.instructionsPath)
    ? readFileSync(plan.instructionsPath, 'utf8')
    : '';
  const nextInstructions = withMeshNote(instructions);
  if (nextInstructions !== instructions) {
    const backup = backupFile(plan.instructionsPath, plan.stamp);
    if (backup) written.push(backup);
    writeFileAtomic(plan.instructionsPath, nextInstructions);
    written.push(plan.instructionsPath);
  }

  return written;
}
