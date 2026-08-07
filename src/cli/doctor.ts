import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { meshPaths } from '../paths.ts';
import { MeshClient } from '../client.ts';
import { distEntryPoint } from '../install/entry.ts';
import { codexHookTrustRecorded, codexPaths } from '../install/codex.ts';
import { defaultRunner } from '../install/mcp.ts';
import type { CommandRunner } from '../install/mcp.ts';
import { listEnabledWorkspaces } from '../enabled.ts';
import { resolveWorkspace } from '../workspace.ts';

export interface DoctorReport {
  nodeVersion: string;
  nodeOk: boolean;
  daemonReachable: boolean;
  socketPath: string;
  claudeHooksInstalled: boolean;
  codexHooksInstalled: boolean;
  codexSpikeRecorded: boolean;
  distBuilt: boolean;
  distPath: string;
  claudeMcpRegistered: boolean;
  codexMcpRegistered: boolean;
  codexHooksTrusted: boolean;
  codexVersion: string | null;
  enabledHere: boolean;
  workspaceRoot: string;
  enabledCount: number;
}

function nodeMeetsFloor(version: string): boolean {
  const match = /^v(\d+)\.(\d+)/.exec(version);
  if (!match) return false;
  const major = Number(match[1]);
  const minor = Number(match[2]);
  return major > 22 || (major === 22 && minor >= 6);
}

/**
 * Whether a config file points at THIS entry point.
 *
 * The old check looked for the literal string "mesh hook", which a real
 * install never writes — `mesh init` writes an absolute path to
 * dist/cli/index.js — so it reported a correct install as missing.
 */
function fileMentions(path: string, needle: string): boolean {
  if (!existsSync(path)) return false;
  try {
    return readFileSync(path, 'utf8').includes(needle);
  } catch {
    return false;
  }
}

function mcpRegistered(host: string, runner: CommandRunner): boolean {
  const listed = runner(host, ['mcp', 'list']);
  return listed.status === 0 && /(^|\W)mesh(\W|$)/m.test(listed.stdout);
}

function hostVersion(host: string, runner: CommandRunner): string | null {
  const result = runner(host, ['--version']);
  if (result.status !== 0) return null;
  const line = result.stdout.trim().split('\n')[0];
  return line && line.length > 0 ? line : null;
}

export async function collectDoctorReport(
  runner: CommandRunner = defaultRunner,
): Promise<DoctorReport> {
  const paths = meshPaths();
  const client = await MeshClient.open({ autostart: false, connectTimeoutMs: 500 });
  const daemonReachable = client !== null;
  client?.close();

  const entry = distEntryPoint();
  const home = homedir();
  const workspace = resolveWorkspace(process.cwd());
  const enabledRoots = listEnabledWorkspaces();
  const codex = codexPaths(home);
  const codexConfig = existsSync(codex.config) ? readFileSync(codex.config, 'utf8') : '';

  return {
    enabledHere: enabledRoots.includes(workspace.root),
    workspaceRoot: workspace.root,
    enabledCount: enabledRoots.length,
    nodeVersion: process.version,
    nodeOk: nodeMeetsFloor(process.version),
    daemonReachable,
    socketPath: paths.socket,
    claudeHooksInstalled: fileMentions(join(home, '.claude', 'settings.json'), entry),
    codexHooksInstalled: fileMentions(codex.hooks, entry),
    codexSpikeRecorded: existsSync(
      join(home, 'Projects', 'mesh', 'spikes', 'codex-hook-capability', 'FINDINGS.md'),
    ),
    distBuilt: existsSync(entry),
    distPath: entry,
    claudeMcpRegistered: mcpRegistered('claude', runner),
    codexMcpRegistered: mcpRegistered('codex', runner),
    codexHooksTrusted: codexHookTrustRecorded(codexConfig, codex.hooks),
    // Codex hook behavior is measured, not promised: a version bump is a
    // reason to re-run the spikes.
    codexVersion: hostVersion('codex', runner),
  };
}

export function renderDoctor(report: DoctorReport): string {
  const lines: string[] = ['mesh doctor', ''];

  // First line, because it decides whether any of the rest is even running.
  // Everything below reports what is INSTALLED; this reports what is ACTIVE.
  lines.push(
    report.enabledHere
      ? `  mesh here        ON        ${report.workspaceRoot}`
      : `  mesh here        off       ${report.workspaceRoot} — \`mesh on\` to enable; hooks and tools are inert until then`,
  );
  lines.push(
    `  enabled in       ${report.enabledCount} workspace${report.enabledCount === 1 ? '' : 's'}`,
    '',
  );

  lines.push(
    report.nodeOk
      ? `  node             ok        ${report.nodeVersion}`
      : `  node             PROBLEM   ${report.nodeVersion} — mesh requires >= 22.6 for type stripping`,
  );

  lines.push(
    report.distBuilt
      ? `  build            ok        ${report.distPath}`
      : `  build            PROBLEM   ${report.distPath} missing — run \`npm run build\`, or hooks cost ~40ms more per tool call`,
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
    report.claudeMcpRegistered
      ? '  claude mcp       ok        mesh is registered'
      : '  claude mcp       not registered — run `mesh init`',
  );

  lines.push(
    report.codexHooksInstalled
      ? '  codex hooks      ok        installed in ~/.codex/hooks.json'
      : '  codex hooks      not installed — run `mesh init` to wire them up',
  );

  lines.push(
    report.codexMcpRegistered
      ? '  codex mcp        ok        mesh is registered'
      : '  codex mcp        not registered — run `mesh init`',
  );

  // Approval records are evidence, not a runtime probe. Codex may execute hooks
  // under a host policy that bypasses per-hook approval; that is exactly what
  // the 2026-08-02 live shakedown observed while config.toml held no records for
  // mesh's entries. Never turn "not recorded" into the false claim "not
  // running". mesh also never writes approval state: that grant belongs to the
  // user.
  if (report.codexHooksTrusted) {
    lines.push('  codex trust      ok        approval is recorded for every mesh hook');
  } else {
    lines.push(
      '  codex trust      UNCONFIRMED  approval is not recorded for every mesh hook',
      '                               Hooks may still run under the current host policy.',
      '                               If Codex shows mesh hook activity, no action is needed;',
      '                               otherwise restart it and approve the hook prompt.',
      '                               mesh never grants itself execution rights.',
    );
  }

  lines.push(
    report.codexVersion
      ? `  codex version    ${report.codexVersion} — hook behavior is measured per version, see spikes/`
      : '  codex version    unknown — codex is not on PATH',
  );

  lines.push(
    report.codexSpikeRecorded
      ? '  codex capability recorded  see spikes/codex-hook-capability/FINDINGS.md'
      : '  codex capability unknown   Phase 0 spike has not been run',
  );

  return lines.join('\n');
}
