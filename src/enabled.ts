import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { canonicalize } from './workspace.ts';
import { meshPaths } from './paths.ts';

/**
 * Which workspaces the operator has switched mesh ON in.
 *
 * mesh is installed once, globally, into Claude Code and Codex — so without
 * this gate every session in every project would load the hooks, spawn the
 * daemon, and carry the mesh_* tools, whether or not two agents were actually
 * collaborating there. That is not what an operator asks for when they install
 * a collaboration tool; they want it where the collaboration is.
 *
 * So the contract is: OFF everywhere, ON only where `mesh on` was run.
 *
 * Every read fails CLOSED. A missing file, unreadable file, corrupt JSON, or a
 * value of the wrong shape all mean off. This is the opposite of the rest of
 * mesh, which fails open so a broken mesh never blocks an agent — here the
 * safe direction is "mesh is not running", which is also the state the agent
 * behaves correctly in.
 */
const FILE = 'enabled.json';

function enabledFile(home: string): string {
  return join(home, FILE);
}

export function meshHome(): string {
  return meshPaths().home;
}

/**
 * The enabled roots, canonicalized. Returns [] for every failure mode —
 * callers cannot distinguish "no file" from "bad file", and must not: both
 * mean mesh is off.
 */
export function listEnabledWorkspaces(home: string = meshHome()): string[] {
  let raw: string;
  try {
    raw = readFileSync(enabledFile(home), 'utf8');
  } catch {
    return [];
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }

  if (!Array.isArray(parsed)) return [];
  return parsed.filter((entry): entry is string => typeof entry === 'string');
}

/**
 * Exact match on the canonical root, never a prefix. A prefix test would
 * enable every repo nested inside an enabled one, which is how an opt-in
 * quietly becomes an opt-out.
 */
export function isWorkspaceEnabled(root: string, home: string = meshHome()): boolean {
  const target = canonicalize(root);
  return listEnabledWorkspaces(home).includes(target);
}

function write(home: string, roots: string[]): void {
  mkdirSync(home, { recursive: true, mode: 0o700 });
  writeFileSync(enabledFile(home), `${JSON.stringify(roots, null, 1)}\n`, { mode: 0o600 });
}

export function enableWorkspace(root: string, home: string = meshHome()): void {
  const target = canonicalize(root);
  const roots = listEnabledWorkspaces(home);
  if (roots.includes(target)) return;
  write(home, [...roots, target]);
}

export function disableWorkspace(root: string, home: string = meshHome()): void {
  const target = canonicalize(root);
  const roots = listEnabledWorkspaces(home);
  if (!roots.includes(target)) return;
  write(
    home,
    roots.filter((entry) => entry !== target),
  );
}
