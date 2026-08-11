import { formatDuration } from './who.ts';
import { terminalSafe } from '../terminal.ts';

export interface ClaimRow {
  id: number;
  holder: string;
  patterns: string[];
  mode: string;
  expiresInMs: number;
}

const EXPIRING_SOON_MS = 30_000;

export function renderClaims(rows: ClaimRow[]): string {
  if (rows.length === 0) {
    return 'No claims held in this workspace.\nAgents claim paths with mesh_claim before editing.';
  }

  const safeRows = rows.map((row) => ({
    ...row,
    holder: terminalSafe(row.holder),
    mode: terminalSafe(row.mode),
    patterns: row.patterns.map(terminalSafe),
  }));
  const holderWidth = Math.max(...safeRows.map((r) => r.holder.length), 6);
  const lines: string[] = ['claims:', ''];
  for (const row of safeRows) {
    const soon = row.expiresInMs < EXPIRING_SOON_MS ? '  (expiring)' : '';
    lines.push(
      `  ${row.holder.padEnd(holderWidth)}  ${row.mode.padEnd(9)}  ` +
        `${formatDuration(row.expiresInMs).padEnd(5)} left  ${row.patterns.join(', ')}${soon}`,
    );
  }
  return lines.join('\n');
}
