import { existsSync, readFileSync } from 'node:fs';
import { applyClaudeInstall, planClaudeInstall } from '../install/claude.ts';
import { applyCodexInstall, codexHookTrustRecorded, planCodexInstall } from '../install/codex.ts';
import { ensureMcpServer } from '../install/mcp.ts';
import type { CommandRunner, McpRegistration } from '../install/mcp.ts';

export interface InitOptions {
  home: string;
  nodePath: string;
  entry: string;
  now: number;
  dryRun: boolean;
  runner: CommandRunner;
}

export interface HostResult {
  host: 'claude' | 'codex';
  present: boolean;
  written: string[];
  mcp: McpRegistration | null;
  /** Codex only: the hook is installed but the user has not approved it yet. */
  trustPending: boolean;
}

export interface InitResult {
  entry: string;
  dryRun: boolean;
  hosts: HostResult[];
}

export function runInit(options: InitOptions): InitResult {
  const hosts: HostResult[] = [];

  const claude = planClaudeInstall({
    home: options.home,
    nodePath: options.nodePath,
    entry: options.entry,
    now: options.now,
  });
  hosts.push({
    host: 'claude',
    present: claude.present,
    written: claude.present && !options.dryRun ? applyClaudeInstall(claude) : [],
    mcp:
      claude.present && !options.dryRun
        ? ensureMcpServer({
            host: 'claude',
            nodePath: options.nodePath,
            entry: options.entry,
            runner: options.runner,
          })
        : null,
    trustPending: false,
  });

  const codex = planCodexInstall({
    home: options.home,
    nodePath: options.nodePath,
    entry: options.entry,
    now: options.now,
  });
  const codexWritten = codex.present && !options.dryRun ? applyCodexInstall(codex) : [];
  const codexConfig = existsSync(codex.configPath) ? readFileSync(codex.configPath, 'utf8') : '';
  hosts.push({
    host: 'codex',
    present: codex.present,
    written: codexWritten,
    mcp:
      codex.present && !options.dryRun
        ? ensureMcpServer({
            host: 'codex',
            nodePath: options.nodePath,
            entry: options.entry,
            runner: options.runner,
          })
        : null,
    // This reports only whether approval is recorded. Some host policies run
    // hooks without per-entry records; mesh cannot infer runtime behavior here.
    // Recording approval remains the user's decision, never mesh's.
    trustPending: codex.present && !codexHookTrustRecorded(codexConfig, codex.hooksPath),
  });

  return { entry: options.entry, dryRun: options.dryRun, hosts };
}

export function renderInitSummary(result: InitResult): string {
  const verb = result.dryRun ? 'would write' : 'wrote';
  const lines: string[] = [
    result.dryRun ? 'mesh init — dry run, nothing was changed' : 'mesh init',
    '',
    `  entry point   ${result.entry}`,
    '',
  ];

  for (const host of result.hosts) {
    if (!host.present) {
      lines.push(`  ${host.host.padEnd(7)} not installed — skipped`);
      continue;
    }

    lines.push(`  ${host.host}`);
    if (result.dryRun) {
      lines.push(`    ${verb} hooks and register the mesh MCP server`);
    } else {
      for (const path of host.written) {
        lines.push(`    ${path.includes('.mesh-backup-') ? 'backed up' : verb.padEnd(9)}  ${path}`);
      }
      if (host.mcp?.ok) lines.push('    mcp        registered');
      if (host.mcp && !host.mcp.ok) {
        lines.push(`    mcp        FAILED — ${host.mcp.detail}`);
        lines.push(`               run this yourself: ${host.mcp.manualCommand}`);
      }
    }
    if (host.trustPending) {
      lines.push(
        '    trust      Approval is not recorded for every Codex hook.',
        '               Codex may ask on restart if its policy requires explicit approval.',
      );
    }
  }

  lines.push(
    '',
    result.dryRun
      ? 'Re-run without --dry-run to apply.'
      : 'Restart any running agents — a live session keeps the hooks it started with.',
    'Then run `mesh doctor` to confirm, and `mesh watch` to see the mesh.',
  );

  return lines.join('\n');
}
