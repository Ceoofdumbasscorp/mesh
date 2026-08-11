import { chmodSync, lstatSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export interface MeshPaths {
  home: string;
  socket: string;
  journal: string;
  workspaceDir(key: string): string;
}

/**
 * MESH_HOME relocates every piece of mesh state — socket, journal, and the
 * enabled-workspace list — as one unit. Tests rely on that: a gate that could
 * be checked against a different home than the daemon it guards would prove
 * nothing.
 */
export function meshPaths(
  home: string = process.env.MESH_HOME ?? join(homedir(), '.mesh'),
): MeshPaths {
  return {
    home,
    socket: join(home, 'mesh.sock'),
    journal: join(home, 'journal.jsonl'),
    workspaceDir: (key: string) => join(home, `ws-${key}`),
  };
}

/** Owner-only. mesh state names what an agent is doing and belongs to one user. */
export function ensureMeshHome(paths: MeshPaths): void {
  mkdirSync(paths.home, { recursive: true, mode: 0o700 });
  const stat = lstatSync(paths.home);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error(`mesh home is not a real directory: ${paths.home}`);
  }
  if (typeof process.getuid === 'function' && stat.uid !== process.getuid()) {
    throw new Error(`mesh home is not owned by the current user: ${paths.home}`);
  }
  chmodSync(paths.home, 0o700);
}
