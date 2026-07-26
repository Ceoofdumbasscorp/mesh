#!/usr/bin/env node
import { MeshClient } from '../client.ts';
import { renderWho } from './who.ts';
import type { WhoAgent } from './who.ts';
import { collectDoctorReport, renderDoctor } from './doctor.ts';

const USAGE = `mesh — cross-agent collaboration for terminal coding agents

Usage:
  mesh who        List the agents working in this workspace
  mesh doctor     Report daemon, runtime, and hook installation status
  mesh log        Print the daemon journal
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

async function cmdLog(): Promise<number> {
  const { Journal } = await import('../journal.ts');
  const { meshPaths } = await import('../paths.ts');
  const { systemClock } = await import('../clock.ts');
  for (const entry of new Journal(meshPaths().journal, systemClock).read()) {
    process.stdout.write(`${JSON.stringify(entry)}\n`);
  }
  return 0;
}

export async function main(argv: string[]): Promise<number> {
  const command = argv[2];
  switch (command) {
    case 'who':
      return cmdWho();
    case 'doctor':
      return cmdDoctor();
    case 'log':
      return cmdLog();
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
