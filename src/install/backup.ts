import { copyFileSync, existsSync, mkdirSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

/** Filename-safe and sortable. */
export function backupStamp(now: number): string {
  return new Date(now).toISOString().replace(/[:.]/g, '-');
}

/**
 * A timestamped sibling copy, taken before every edit. These files belong to
 * the user's agents; a bad write must always be one `mv` away from undone.
 */
export function backupFile(path: string, stamp: string): string | null {
  if (!existsSync(path)) return null;
  const backup = `${path}.mesh-backup-${stamp}`;
  copyFileSync(path, backup);
  return backup;
}

/**
 * Write via a temp file and rename, so a crash mid-write cannot leave a host
 * with a half-written settings file it refuses to start with. The existing
 * mode is preserved: mesh must not silently tighten or loosen a user's config.
 */
export function writeFileAtomic(path: string, contents: string): void {
  mkdirSync(dirname(path), { recursive: true });
  const mode = existsSync(path) ? statSync(path).mode & 0o777 : 0o600;
  const temp = `${path}.mesh-tmp`;
  writeFileSync(temp, contents, { mode });
  renameSync(temp, path);
}
