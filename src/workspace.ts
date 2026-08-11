import { existsSync, realpathSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';

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

/**
 * Resolve a tool target exactly once before claim comparison. Existing path
 * components are realpath-resolved so symlink aliases cannot create a second
 * spelling for the same file. Targets outside the workspace are not governed
 * by that workspace's claims and return null.
 */
export function workspaceRelativeTarget(
  workspaceRoot: string,
  cwd: string,
  target: string,
): string | null {
  const canonicalRoot = canonicalize(workspaceRoot);
  const absolute = isAbsolute(target) ? resolve(target) : resolve(cwd, target);

  let existing = absolute;
  const suffix: string[] = [];
  while (!existsSync(existing)) {
    const parent = dirname(existing);
    if (parent === existing) break;
    suffix.unshift(basename(existing));
    existing = parent;
  }
  const canonicalExisting = canonicalize(existing);
  const canonicalTarget = resolve(canonicalExisting, ...suffix);
  const rel = relative(canonicalRoot, canonicalTarget);
  if (rel === '') return '.';
  if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) return null;
  return rel.split(sep).join('/');
}

/** Normalize claim globs without allowing an alternate absolute/traversal form. */
export function normalizeClaimPattern(pattern: string): string | null {
  const trimmed = pattern.trim().replace(/\\/g, '/').replace(/^\.\//, '');
  if (trimmed.length === 0 || trimmed.startsWith('/') || /^[A-Za-z]:\//.test(trimmed)) return null;
  const parts = trimmed.split('/');
  if (parts.some((part) => part.length === 0 || part === '.' || part === '..')) return null;
  return parts.join('/');
}
