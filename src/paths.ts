import { mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export interface MeshPaths {
  home: string;
  socket: string;
  journal: string;
  workspaceDir(key: string): string;
}

export function meshPaths(home: string = join(homedir(), '.mesh')): MeshPaths {
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
}
