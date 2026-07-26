import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { meshPaths } from '../paths.ts';
import { MeshClient } from '../client.ts';

export interface DoctorReport {
  nodeVersion: string;
  nodeOk: boolean;
  daemonReachable: boolean;
  socketPath: string;
  claudeHooksInstalled: boolean;
  codexHooksInstalled: boolean;
  codexSpikeRecorded: boolean;
}

function nodeMeetsFloor(version: string): boolean {
  const match = /^v(\d+)\.(\d+)/.exec(version);
  if (!match) return false;
  const major = Number(match[1]);
  const minor = Number(match[2]);
  return major > 22 || (major === 22 && minor >= 6);
}

function fileMentionsMesh(path: string): boolean {
  if (!existsSync(path)) return false;
  try {
    return readFileSync(path, 'utf8').includes('mesh hook');
  } catch {
    return false;
  }
}

export async function collectDoctorReport(): Promise<DoctorReport> {
  const paths = meshPaths();
  const client = await MeshClient.open({ autostart: false, connectTimeoutMs: 500 });
  const daemonReachable = client !== null;
  client?.close();

  return {
    nodeVersion: process.version,
    nodeOk: nodeMeetsFloor(process.version),
    daemonReachable,
    socketPath: paths.socket,
    claudeHooksInstalled: fileMentionsMesh(join(homedir(), '.claude', 'settings.json')),
    codexHooksInstalled: fileMentionsMesh(join(homedir(), '.codex', 'hooks.json')),
    codexSpikeRecorded: existsSync(
      join(homedir(), 'Projects', 'mesh', 'spikes', 'codex-hook-capability', 'FINDINGS.md'),
    ),
  };
}

export function renderDoctor(report: DoctorReport): string {
  const lines: string[] = ['mesh doctor', ''];

  lines.push(
    report.nodeOk
      ? `  node             ok        ${report.nodeVersion}`
      : `  node             PROBLEM   ${report.nodeVersion} — mesh requires >= 22.6 for type stripping`,
  );

  lines.push(
    report.daemonReachable
      ? `  daemon           ok        ${report.socketPath}`
      : `  daemon           not running — starts automatically on first use`,
  );

  lines.push(
    report.claudeHooksInstalled
      ? '  claude hooks     ok        installed in ~/.claude/settings.json'
      : '  claude hooks     not installed — run `mesh init` to wire them up',
  );

  lines.push(
    report.codexHooksInstalled
      ? '  codex hooks      ok        installed in ~/.codex/hooks.json'
      : '  codex hooks      not installed — run `mesh init` to wire them up',
  );

  lines.push(
    report.codexSpikeRecorded
      ? '  codex capability recorded  see spikes/codex-hook-capability/FINDINGS.md'
      : '  codex capability unknown   Phase 0 spike has not been run',
  );

  return lines.join('\n');
}
