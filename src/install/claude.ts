import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { backupFile, backupStamp, writeFileAtomic } from './backup.ts';
import { withMeshHooks } from './hooks.ts';
import type { HookConfig } from './hooks.ts';
import { withMeshNote } from './note.ts';

export interface ClaudeInstallInput {
  home: string;
  nodePath: string;
  entry: string;
  now: number;
}

export interface ClaudeInstallPlan {
  present: boolean;
  settingsPath: string;
  instructionsPath: string;
  stamp: string;
  nodePath: string;
  entry: string;
}

export function claudePaths(home: string): { settings: string; instructions: string } {
  return {
    settings: join(home, '.claude', 'settings.json'),
    instructions: join(home, '.claude', 'CLAUDE.md'),
  };
}

export function planClaudeInstall(input: ClaudeInstallInput): ClaudeInstallPlan {
  const paths = claudePaths(input.home);
  return {
    // A host that was never installed is skipped, not created: writing a
    // config directory for a tool the user does not have is not mesh's call.
    present: existsSync(join(input.home, '.claude')),
    settingsPath: paths.settings,
    instructionsPath: paths.instructions,
    stamp: backupStamp(input.now),
    nodePath: input.nodePath,
    entry: input.entry,
  };
}

function readJsonObject(path: string): Record<string, unknown> {
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
    // Never rewrite a file we do not understand: a settings file mesh cannot
    // parse is one the user may still be able to.
    throw new Error(
      `mesh init: could not parse ${path} (${(error as Error).message}). Fix or move it, then re-run.`,
    );
  }
}

/** Returns every path written, backups included. */
export function applyClaudeInstall(plan: ClaudeInstallPlan): string[] {
  const written: string[] = [];

  const settings = readJsonObject(plan.settingsPath);
  const hooks = (settings.hooks ?? {}) as HookConfig;
  settings.hooks = withMeshHooks(hooks, {
    nodePath: plan.nodePath,
    entry: plan.entry,
    includeMatcher: true,
  });

  const nextText = `${JSON.stringify(settings, null, 2)}\n`;
  const currentText = existsSync(plan.settingsPath)
    ? readFileSync(plan.settingsPath, 'utf8')
    : '';
  if (nextText !== currentText) {
    const backup = backupFile(plan.settingsPath, plan.stamp);
    if (backup) written.push(backup);
    writeFileAtomic(plan.settingsPath, nextText);
    written.push(plan.settingsPath);
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
