import {
  closeSync,
  constants,
  fchmodSync,
  lstatSync,
  openSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { ensureMeshHome, meshPaths } from './paths.ts';

function capabilityPath(pid: number): string {
  return join(meshPaths().home, `session-${pid}.cap`);
}

export function writeSessionCapability(pid: number, capability: string): void {
  const paths = meshPaths();
  ensureMeshHome(paths);
  const path = capabilityPath(pid);
  try {
    const existing = lstatSync(path);
    if (!existing.isFile() || existing.isSymbolicLink()) {
      throw new Error(`unsafe session capability path: ${path}`);
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  const fd = openSync(
    path,
    constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC | constants.O_NOFOLLOW,
    0o600,
  );
  try {
    fchmodSync(fd, 0o600);
    writeFileSync(fd, `${capability}\n`, 'utf8');
  } finally {
    closeSync(fd);
  }
}

export function readSessionCapability(pid: number): string | undefined {
  try {
    const path = capabilityPath(pid);
    const stat = lstatSync(path);
    if (!stat.isFile() || stat.isSymbolicLink()) return undefined;
    if (typeof process.getuid === 'function' && stat.uid !== process.getuid()) return undefined;
    const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    let value: string;
    try {
      value = readFileSync(fd, 'utf8').trim();
    } finally {
      closeSync(fd);
    }
    return value.length > 0 ? value : undefined;
  } catch {
    return undefined;
  }
}

export function removeSessionCapability(pid: number): void {
  try {
    rmSync(capabilityPath(pid));
  } catch {
    // Already gone is the desired state.
  }
}
