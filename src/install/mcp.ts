import { spawnSync } from 'node:child_process';

export interface RunResult {
  status: number | null;
  stdout: string;
  stderr: string;
}

export type CommandRunner = (command: string, args: string[]) => RunResult;

export interface McpRegistration {
  host: 'claude' | 'codex';
  ok: boolean;
  detail: string;
  /** What the user can run by hand if mesh could not do it. */
  manualCommand: string;
}

export const defaultRunner: CommandRunner = (command, args) => {
  const result = spawnSync(command, args, { encoding: 'utf8' });
  return {
    status: result.error ? null : result.status,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? result.error?.message ?? '',
  };
};

/** User scope, so mesh is available in every project rather than one. */
export function claudeMcpArgs(nodePath: string, entry: string): string[] {
  return ['mcp', 'add', '--scope', 'user', 'mesh', '--', nodePath, entry, 'mcp'];
}

/**
 * Codex hands an MCP server a scrubbed environment — measured 2026-07-27: the
 * hook inherited the ambient variables, the MCP server received none of them.
 * Anything mesh needs there has to be declared at registration time.
 */
export function codexMcpArgs(nodePath: string, entry: string): string[] {
  return ['mcp', 'add', 'mesh', '--env', 'MESH_PROVIDER=codex', '--', nodePath, entry, 'mcp'];
}

/**
 * Registers mesh's MCP server with a host, idempotently.
 *
 * Through the host's own CLI on purpose: it owns the config format (TOML for
 * Codex, a large JSON file for Claude), and a tool that edits another tool's
 * config by hand breaks the first time that format changes.
 */
export function ensureMcpServer(input: {
  host: 'claude' | 'codex';
  nodePath: string;
  entry: string;
  runner: CommandRunner;
}): McpRegistration {
  const addArgs =
    input.host === 'claude'
      ? claudeMcpArgs(input.nodePath, input.entry)
      : codexMcpArgs(input.nodePath, input.entry);
  const manualCommand = `${input.host} ${addArgs.join(' ')}`;

  const listed = input.runner(input.host, ['mcp', 'list']);
  if (listed.status === null) {
    return {
      host: input.host,
      ok: false,
      detail: `${input.host} is not on PATH, so mesh could not register its MCP server`,
      manualCommand,
    };
  }

  if (/(^|\W)mesh(\W|$)/m.test(listed.stdout)) {
    // Remove then add: `mcp add` refuses a duplicate name, and a re-run after
    // an upgrade must repoint the entry at the new path.
    const removeArgs =
      input.host === 'claude'
        ? ['mcp', 'remove', '--scope', 'user', 'mesh']
        : ['mcp', 'remove', 'mesh'];
    input.runner(input.host, removeArgs);
  }

  const added = input.runner(input.host, addArgs);
  if (added.status !== 0) {
    return {
      host: input.host,
      ok: false,
      detail: (added.stderr || added.stdout || `${input.host} mcp add failed`).trim(),
      manualCommand,
    };
  }

  return { host: input.host, ok: true, detail: 'registered', manualCommand };
}
