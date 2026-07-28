import { execFileSync } from 'node:child_process';
import { appendFileSync } from 'node:fs';

const OUT = process.env.PROBE_OUT;

/** pid/ppid/comm up the process tree, so "who spawned this" is not a guess. */
export function ancestry() {
  const chain = [];
  let pid = process.pid;
  for (let i = 0; i < 6 && pid > 1; i++) {
    let line;
    try {
      line = execFileSync('ps', ['-o', 'pid=,ppid=,comm=', '-p', String(pid)], {
        encoding: 'utf8',
      }).trim();
    } catch {
      break;
    }
    if (!line) break;
    const match = /^(\d+)\s+(\d+)\s+(.*)$/.exec(line);
    if (!match) break;
    chain.push({ pid: Number(match[1]), ppid: Number(match[2]), comm: match[3] });
    pid = Number(match[2]);
  }
  return chain;
}

export function interestingEnv() {
  const keys = Object.keys(process.env).filter((k) => /CLAUDE|SESSION|MCP|CODEX/i.test(k));
  return Object.fromEntries(keys.map((k) => [k, process.env[k]]));
}

export function record(role, extra = {}) {
  appendFileSync(
    OUT,
    `${JSON.stringify({
      role,
      pid: process.pid,
      ppid: process.ppid,
      chain: ancestry(),
      env: interestingEnv(),
      ...extra,
    })}\n`,
  );
}
