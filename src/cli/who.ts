export interface WhoAgent {
  name: string;
  provider: string;
  role: string | null;
  status: string;
  activity: string | null;
  idleMs: number;
  /** Questions addressed to this agent that it has not answered. */
  unanswered?: number;
  /** Agents this one is blocked waiting on. */
  waitingOn?: string[];
}

export interface WhoPayload {
  workspaceLabel: string;
  agents: WhoAgent[];
}

export function formatDuration(ms: number): string {
  if (ms < 1000) return 'now';
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  return `${Math.floor(minutes / 60)}h`;
}

function pad(value: string, width: number): string {
  return value.length >= width ? value : value + ' '.repeat(width - value.length);
}

export function renderWho(payload: WhoPayload): string {
  const lines: string[] = [`workspace: ${payload.workspaceLabel}`];

  if (payload.agents.length === 0) {
    lines.push('');
    lines.push('No agents registered here yet.');
    lines.push('Agents join automatically once mesh hooks are installed (`mesh init`).');
    return lines.join('\n');
  }

  const nameWidth = Math.max(...payload.agents.map((a) => a.name.length), 6);
  const roleWidth = Math.max(...payload.agents.map((a) => (a.role ?? '—').length), 4);

  lines.push('');
  for (const agent of payload.agents) {
    const activity = agent.activity ?? (agent.status === 'idle' ? 'idle' : 'starting up');
    lines.push(
      `  ${pad(agent.name, nameWidth)}  ${pad(agent.role ?? '—', roleWidth)}  ` +
        `${pad(agent.status, 8)}  ${pad(formatDuration(agent.idleMs), 5)}  ${activity}`,
    );
  }
  return lines.join('\n');
}
