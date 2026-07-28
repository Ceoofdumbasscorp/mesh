#!/usr/bin/env node
import { MeshClient } from '../client.ts';
import { renderWho } from './who.ts';
import type { WhoAgent } from './who.ts';
import { collectDoctorReport, renderDoctor } from './doctor.ts';
import { runHook } from '../hook.ts';
import { renderClaims } from './claims.ts';
import type { ClaimRow } from './claims.ts';
import { runWatch, DEFAULT_INTERVAL_MS } from './watch.ts';

const USAGE = `mesh — cross-agent collaboration for terminal coding agents

Usage:
  mesh init       Wire mesh into Claude Code and Codex (--dry-run to preview)
  mesh who        List the agents working in this workspace
  mesh claims     Show which agent has claimed which paths
  mesh watch      Live view of agents, questions, and claims
                  (--once, --interval <ms>)
  mesh release [--force] <pattern>
                  Release a claim; --force breaks another agent's
  mesh doctor     Report daemon, runtime, and hook installation status
  mesh log        Print the daemon journal
  mesh hook <ev>  Internal: called by Claude/Codex hooks, not by hand
  mesh mcp        Internal: MCP server exposing mesh_* tools to an agent
  mesh daemon     Run the daemon in the foreground (normally automatic)
`;

async function cmdWho(): Promise<number> {
  const client = await MeshClient.open();
  if (!client) {
    process.stdout.write('mesh: daemon unreachable — no agents visible\n');
    return 0;
  }
  try {
    const res = await client.request('who', { cwd: process.cwd() });
    if (!res.ok) {
      process.stderr.write(`mesh: ${res.error ?? 'who failed'}\n`);
      return 1;
    }
    process.stdout.write(
      `${renderWho({
        workspaceLabel: String(res.workspaceLabel ?? 'unknown'),
        agents: (res.agents ?? []) as WhoAgent[],
      })}\n`,
    );
    return 0;
  } finally {
    client.close();
  }
}

async function cmdDoctor(): Promise<number> {
  process.stdout.write(`${renderDoctor(await collectDoctorReport())}\n`);
  return 0;
}

async function cmdInit(args: string[]): Promise<number> {
  const { runInit, renderInitSummary } = await import('./init.ts');
  const { requireBuiltEntryPoint } = await import('../install/entry.ts');
  const { defaultRunner } = await import('../install/mcp.ts');
  const { homedir } = await import('node:os');

  try {
    const entry = requireBuiltEntryPoint();
    const result = runInit({
      home: homedir(),
      // The node that ran init, by absolute path: a hook's PATH is not the
      // shell's, and a bare `node` there is a coin flip.
      nodePath: process.execPath,
      entry,
      now: Date.now(),
      dryRun: args.includes('--dry-run'),
      runner: defaultRunner,
    });
    process.stdout.write(`${renderInitSummary(result)}\n`);
    return 0;
  } catch (error) {
    process.stderr.write(`${(error as Error).message}\n`);
    return 1;
  }
}

async function cmdLog(): Promise<number> {
  const { Journal } = await import('../journal.ts');
  const { meshPaths } = await import('../paths.ts');
  const { systemClock } = await import('../clock.ts');
  for (const entry of new Journal(meshPaths().journal, systemClock).read()) {
    process.stdout.write(`${JSON.stringify(entry)}\n`);
  }
  return 0;
}

async function cmdClaims(): Promise<number> {
  const client = await MeshClient.open();
  if (!client) {
    process.stdout.write('mesh: daemon unreachable — no claims visible\n');
    return 0;
  }
  try {
    const res = await client.request('claims', { cwd: process.cwd() });
    if (!res.ok) {
      process.stderr.write(`mesh: ${res.error ?? 'claims failed'}\n`);
      return 1;
    }
    process.stdout.write(`${renderClaims((res.claims ?? []) as ClaimRow[])}\n`);
    return 0;
  } finally {
    client.close();
  }
}

async function cmdWatch(args: string[]): Promise<number> {
  const intervalIndex = args.indexOf('--interval');
  const interval = intervalIndex === -1 ? NaN : Number(args[intervalIndex + 1]);

  // SIGINT arrives mid-frame; write the reset, then exit from the callback.
  // A bare process.exit() here truncates and leaves the terminal repainted
  // over its own scrollback.
  process.on('SIGINT', () => {
    process.stdout.write('\n', () => process.exit(0));
  });

  return runWatch({
    // Never autostart: looking at the mesh should not create one.
    connect: () => MeshClient.open({ autostart: false, connectTimeoutMs: 500 }),
    write: (frame) => process.stdout.write(frame),
    now: () => Date.now(),
    cwd: process.cwd(),
    intervalMs: Number.isFinite(interval) && interval >= 100 ? interval : DEFAULT_INTERVAL_MS,
    once: args.includes('--once'),
  });
}

async function cmdRelease(args: string[]): Promise<number> {
  const force = args.includes('--force');
  const patterns = args.filter((a) => !a.startsWith('--'));
  if (patterns.length === 0) {
    process.stderr.write('mesh: release needs a pattern, e.g. mesh release --force "server/**"\n');
    return 1;
  }

  const client = await MeshClient.open();
  if (!client) {
    process.stdout.write('mesh: daemon unreachable — nothing to release\n');
    return 0;
  }
  try {
    const res = await client.request('release', { patterns, force, cwd: process.cwd() });
    if (!res.ok) {
      process.stderr.write(`mesh: ${res.error ?? 'release failed'}\n`);
      return 1;
    }
    process.stdout.write(`Released ${res.released} claim(s).\n`);
    return 0;
  } finally {
    client.close();
  }
}

async function cmdHook(event: string | undefined): Promise<number> {
  const output = await runHook(event ?? 'PreToolUse');
  // Exit only from the write callback: a bare process.exit() truncates
  // unflushed stdout, which the host then reports as a failed hook.
  await new Promise<void>((resolve) => {
    process.stdout.write(JSON.stringify(output), () => resolve());
  });
  return 0;
}

export async function main(argv: string[]): Promise<number> {
  const command = argv[2];
  switch (command) {
    case 'who':
      return cmdWho();
    case 'init':
      return cmdInit(argv.slice(3));
    case 'doctor':
      return cmdDoctor();
    case 'log':
      return cmdLog();
    case 'claims':
      return cmdClaims();
    case 'watch':
      return cmdWatch(argv.slice(3));
    case 'release':
      return cmdRelease(argv.slice(3));
    case 'hook':
      return cmdHook(argv[3]);
    case 'mcp': {
      // Dynamic import on purpose: it keeps the MCP SDK out of the module
      // graph for every other subcommand, above all `mesh hook`.
      const { resolveMcpIdentity, startMcpServer } = await import('../mcp/server.ts');
      await startMcpServer(resolveMcpIdentity(process.env, argv));
      return 0;
    }
    case 'daemon':
      await import('../daemon/main.ts');
      return 0;
    case undefined:
    case '-h':
    case '--help':
      process.stdout.write(USAGE);
      return 0;
    default:
      process.stderr.write(`mesh: unknown command "${command}"\n\n${USAGE}`);
      return 1;
  }
}

process.exitCode = await main(process.argv);
