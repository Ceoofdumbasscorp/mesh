import { existsSync, realpathSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { basename, dirname, join, resolve } from 'node:path';

/**
 * A workspace is the unit of visibility: agents only see peers whose cwd
 * resolves to the same root.
 */
export interface Workspace {
  /** Absolute, symlink-resolved path. The daemon's map key. */
  root: string;
  /** Basename, for display. */
  label: string;
  /** 12-hex-char digest of root. Filename-safe. */
  key: string;
}

function findGitRoot(startDir: string): string | null {
  let current = startDir;
  // Walking up terminates at the filesystem root, where dirname is a fixed point.
  for (;;) {
    // Existence, not directory-ness: a linked worktree's .git is a file.
    if (existsSync(join(current, '.git'))) return current;
    const parent = dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

export function workspaceKey(root: string): string {
  return createHash('sha256').update(root).digest('hex').slice(0, 12);
}

/**
 * Canonicalize a path, resolving symlinks. Exported because callers that need
 * to compare against a resolved root must apply the same normalization —
 * on macOS /var is a symlink to /private/var, so an unresolved path and a
 * resolved one name the same directory but compare unequal.
 */
export function canonicalize(path: string): string {
  const absolute = resolve(path);
  try {
    return realpathSync(absolute);
  } catch {
    return absolute;
  }
}

export function resolveWorkspace(cwd: string): Workspace {
  const canonical = canonicalize(cwd);
  const root = findGitRoot(canonical) ?? canonical;
  return { root, label: basename(root), key: workspaceKey(root) };
}
