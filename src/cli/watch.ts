import type { MeshClient } from '../client.ts';
import { formatDuration } from './who.ts';
import type { WhoAgent } from './who.ts';
import { renderClaims } from './claims.ts';
import type { ClaimRow } from './claims.ts';
import { terminalSafe } from '../terminal.ts';

export interface WatchPayload {
  workspaceLabel: string;
  agents: WhoAgent[];
  claims: ClaimRow[];
  now: number;
  daemonReachable: boolean;
}

export interface WatchDeps {
  connect: () => Promise<MeshClient | null>;
  write: (frame: string) => void;
  now: () => number;
  cwd: string;
  intervalMs: number;
  once: boolean;
  sleep?: (ms: number) => Promise<void>;
}

/** Home, clear, and drop scrollback: a repaint, not an append. */
export const CLEAR_SCREEN = '\x1b[H\x1b[2J\x1b[3J';

export const DEFAULT_INTERVAL_MS = 1000;

function clockLabel(now: number): string {
  return new Date(now).toTimeString().slice(0, 8);
}

export function renderWatch(payload: WatchPayload): string {
  if (!payload.daemonReachable) {
    return [
      'mesh watch',
      '',
      '  daemon not running — nothing to watch yet.',
      '  It starts by itself when the first agent does. If no agent ever joins,',
      '  run `mesh init` to wire up your hosts, then restart them.',
    ].join('\n');
  }

  const agents = payload.agents.map((agent) => ({
    ...agent,
    name: terminalSafe(agent.name),
    role: agent.role === null ? null : terminalSafe(agent.role),
    status: terminalSafe(agent.status),
    activity: agent.activity === null ? null : terminalSafe(agent.activity),
    waitingOn: agent.waitingOn?.map(terminalSafe),
  }));
  const lines: string[] = [
    `mesh watch — ${terminalSafe(payload.workspaceLabel)}   ${clockLabel(payload.now)}`,
    '',
  ];

  if (agents.length === 0) {
    lines.push('  no agents here yet');
  } else {
    const nameWidth = Math.max(...agents.map((a) => a.name.length), 6);
    const roleWidth = Math.max(...agents.map((a) => (a.role ?? '—').length), 4);
    for (const agent of agents) {
      const mark = agent.status === 'working' ? '●' : '○';
      const activity = agent.activity ?? (agent.status === 'idle' ? 'idle' : 'starting up');
      const blocked =
        agent.waitingOn && agent.waitingOn.length > 0
          ? `  (waiting on ${agent.waitingOn.join(', ')})`
          : '';
      lines.push(
        `  ${mark} ${agent.name.padEnd(nameWidth)}  ${(agent.role ?? '—').padEnd(roleWidth)}  ` +
          `${formatDuration(agent.idleMs).padEnd(5)}  ${activity}${blocked}`,
      );
    }
  }

  lines.push('', 'questions in flight:');
  const stuck = agents.filter((agent) => (agent.unanswered ?? 0) > 0);
  if (stuck.length === 0) {
    lines.push('  none');
  } else {
    for (const agent of stuck) {
      lines.push(
        `  ${agent.name} has ${agent.unanswered} unanswered — if that window is sitting ` +
          'at a prompt, nudge it: an idle agent receives nothing until it acts',
      );
    }
  }

  lines.push('', renderClaims(payload.claims), '', 'ctrl-c to stop');
  return lines.join('\n');
}

/**
 * One frame. A fresh connection per tick, like `mesh who` — a watcher is not
 * an agent, and must not look like one to the daemon or outlive its usefulness
 * by holding a socket open.
 */
export async function watchTick(deps: WatchDeps): Promise<string> {
  const client = await deps.connect();
  if (!client) {
    return renderWatch({
      workspaceLabel: '',
      agents: [],
      claims: [],
      now: deps.now(),
      daemonReachable: false,
    });
  }

  try {
    const who = await client.request('who', { cwd: deps.cwd });
    const claims = await client.request('claims', { cwd: deps.cwd });
    return renderWatch({
      workspaceLabel: String(who.workspaceLabel ?? 'unknown'),
      agents: (who.agents ?? []) as WhoAgent[],
      claims: (claims.claims ?? []) as ClaimRow[],
      now: deps.now(),
      daemonReachable: true,
    });
  } finally {
    client.close();
  }
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function runWatch(deps: WatchDeps): Promise<number> {
  const sleep = deps.sleep ?? defaultSleep;
  for (;;) {
    deps.write(`${CLEAR_SCREEN}${await watchTick(deps)}\n`);
    if (deps.once) return 0;
    await sleep(deps.intervalMs);
  }
}
