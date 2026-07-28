# mesh Phase 5 — Product Surface Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make mesh installable and observable — `mesh init` wires both hosts to the compiled entry point, `mesh watch` shows a human what the agents are doing, and one agent session registers exactly once.

**Architecture:** Three independent pieces. (1) Session identity: the MCP server reads the host's real session id where one exists, and the daemon reconciles a provisional id with the hook's real id by `(workspaceRoot, hostPid)` — measured identical on both hosts. (2) Installation: pure planner functions produce config, thin IO functions back up and write it, and MCP registration shells out to each host's own `mcp add` so mesh never hand-writes TOML. (3) `mesh watch`: a poll-and-repaint TUI built from a pure render function over the existing `who` and `claims` ops — no daemon subscription, no new transport.

**Tech Stack:** Node ≥22.6, TypeScript (type-stripped in dev, compiled for shipping), `node:test`, zero runtime dependencies outside the MCP server.

## Global Constraints

Every task's requirements implicitly include this section.

- **Node ≥ 22.6.** `package.json` `engines.node` is `>=22.6`; type stripping requires it.
- **The hook must never import `@modelcontextprotocol/sdk` or `zod`.** A test reads `src/hook.ts` and fails if either appears. Measured cost: +50ms on a path that runs before every tool call.
- **`npm run bench:hook` fails above 90ms** for the compiled entry point. Do not regress it.
- **Fail-open is absolute.** Socket missing, daemon down, malformed response, unexpected exception — the hook exits 0 and the agent proceeds exactly as it would without mesh installed.
- **`own: true` is set by the MCP server only.** The hook must never set it; its connection is transient and closes after every tool call.
- **Pure state modules (`registry`, `mailbox`, `asks`, `claims`) take an injected `Clock` and create no timers.** All real timers live in `daemon/waiters.ts`.
- **The hook never autostarts the daemon.** The MCP server owns daemon startup.
- **TypeScript config is strict**: `strict`, `noUncheckedIndexedAccess`, `erasableSyntaxOnly` (no enums, no parameter properties), `verbatimModuleSyntax` (type-only imports must use `import type`), `allowImportingTsExtensions` (import siblings as `./foo.ts`).
- **Tests are `node:test` + `node:assert/strict`**, one file per subject in `test/`, run with `npm test`.
- **Commit after every task.** Conventional-commit subject, imperative mood, no trailing period.
- **Never write outside `~/.mesh`, `~/.claude`, `~/.codex`, and the repo.** Every file mesh modifies in a host's config directory is backed up first.

---

## Measured facts this plan depends on

Measured 2026-07-27 on codex-cli 0.145.0 and Claude Code 2.1.220, macOS 24.6.0. **Do not re-derive these; Task 1 writes them into the repo.**

| Fact | Value |
|---|---|
| Claude → MCP server session id | **`CLAUDE_CODE_SESSION_ID` is present** and equals the hook payload's `session_id` |
| Codex → MCP server session id | **none**, and Codex hands the MCP server a *scrubbed* environment |
| Hook ppid vs MCP-server ppid, Claude | **identical** (both 25477 — the host process) |
| Hook ppid vs MCP-server ppid, Codex | **identical** (both 26968 — the host process) |
| Env-prefixed hook command (`VAR=x node …`) | still a **direct child** of the host; the ppid relationship survives |
| Codex hook trust | recorded in `~/.codex/config.toml` under `[hooks.state."<hooks.json path>:<event>:<i>:<j>"]` as `trusted_hash = "sha256:…"` |
| Both host CLIs | expose `mcp add` / `mcp remove` / `mcp list`, so mesh never writes TOML by hand |

**The handoff's claim that Claude Code passes no session-id variable to MCP servers is wrong** and is corrected by Task 1.

**The trap:** a Codex session launched from a Claude session **inherits** `CLAUDE_CODE_SESSION_ID` from the ambient environment. Reading it unconditionally would fuse two different agents into one. It is only trusted when the provider is Claude.

---

## File structure

**Created**

| File | Responsibility |
|---|---|
| `spikes/session-identity/FINDINGS.md` | The measurement above, written down |
| `spikes/session-identity/probe-common.mjs` | Ancestry + env recorder shared by both probes |
| `spikes/session-identity/probe-hook.mjs` | Records what a hook process sees |
| `spikes/session-identity/probe-mcp.mjs` | Minimal MCP stdio server that records what it sees |
| `spikes/session-identity/run.sh` | Re-runs the measurement against both hosts |
| `src/install/entry.ts` | Resolves the compiled entry point hooks must point at |
| `src/install/backup.ts` | Timestamped backup + mode-preserving atomic write |
| `src/install/hooks.ts` | Pure hook-config merge, shared by both hosts |
| `src/install/claude.ts` | Claude paths + settings.json / CLAUDE.md installation |
| `src/install/codex.ts` | Codex paths + hooks.json, `[features] hooks`, trust detection |
| `src/install/mcp.ts` | MCP registration through each host's own CLI |
| `src/install/note.ts` | The usage note appended to a host's instruction file |
| `src/cli/init.ts` | `mesh init` orchestration + summary rendering |
| `src/cli/watch.ts` | `mesh watch` render + poll loop |
| `README.md` | The product surface for a human |

**Modified**

| File | Change |
|---|---|
| `src/registry.ts` | Alias map + `(workspaceRoot, pid)` reconciliation |
| `src/mcp/server.ts` | `resolveMcpIdentity` reads the host's session id |
| `src/daemon/handlers.ts` | `who` reports `unanswered` / `waitingOn` |
| `src/cli/who.ts` | `WhoAgent` gains two optional fields |
| `src/cli/doctor.ts` | Reports dist, MCP registration, Codex trust and version; checks the real entry path |
| `src/cli/index.ts` | `init` and `watch` commands, usage text |
| `package.json` | Ship compiled: `bin` → `dist`, `files`, `prepare` |
| `HANDOFF.md` | Phase 5 marked done; new open items |

---

### Task 1: Record the session-identity measurement

The handoff says "measure the ppid relationship first — that decides it." It has been measured. This task puts the evidence in the repo before any code depends on it, in the same shape as the two existing spikes.

**Files:**
- Create: `spikes/session-identity/FINDINGS.md`
- Create: `spikes/session-identity/probe-common.mjs`
- Create: `spikes/session-identity/probe-hook.mjs`
- Create: `spikes/session-identity/probe-mcp.mjs`
- Create: `spikes/session-identity/run.sh`

**Interfaces:**
- Consumes: nothing.
- Produces: the facts Tasks 2, 3, 7, 8 and 9 encode in comments. No exported code.

- [ ] **Step 1: Write the shared probe recorder**

Create `spikes/session-identity/probe-common.mjs`:

```javascript
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
```

- [ ] **Step 2: Write the hook probe**

Create `spikes/session-identity/probe-hook.mjs`. The stdin read is the production pattern — a blocking read deadlocks Codex:

```javascript
import { record } from './probe-common.mjs';

const raw = await new Promise((resolve) => {
  let buffer = '';
  let done = false;
  const finish = () => {
    if (done) return;
    done = true;
    clearTimeout(timer);
    process.stdin.removeAllListeners();
    process.stdin.pause();
    process.stdin.destroy?.();
    resolve(buffer);
  };
  const timer = setTimeout(finish, 400);
  timer.unref?.();
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (chunk) => {
    buffer += chunk;
  });
  process.stdin.on('end', finish);
  process.stdin.on('error', finish);
});

let payloadSessionId = null;
let event = null;
try {
  const parsed = JSON.parse(raw);
  payloadSessionId = parsed.session_id ?? null;
  event = parsed.hook_event_name ?? null;
} catch {}

record('hook', { payloadSessionId, event });

// Exit from the write callback: a bare process.exit() truncates stdout.
await new Promise((resolve) => process.stdout.write('{}', () => resolve()));
```

- [ ] **Step 3: Write the MCP probe**

Create `spikes/session-identity/probe-mcp.mjs`:

```javascript
import { record } from './probe-common.mjs';

// Records what the host gave it, then speaks just enough JSON-RPC to look like
// a healthy MCP stdio server so the host does not tear it down.
record('mcp');

let buffer = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  buffer += chunk;
  let index;
  while ((index = buffer.indexOf('\n')) !== -1) {
    const line = buffer.slice(0, index).trim();
    buffer = buffer.slice(index + 1);
    if (!line) continue;
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      continue;
    }
    if (message.id === undefined) continue; // a notification needs no reply
    const result =
      message.method === 'initialize'
        ? {
            protocolVersion: '2024-11-05',
            capabilities: { tools: {} },
            serverInfo: { name: 'probe', version: '0.0.1' },
          }
        : message.method === 'tools/list'
          ? { tools: [] }
          : {};
    process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: message.id, result })}\n`);
  }
});
```

- [ ] **Step 4: Write the runner**

Create `spikes/session-identity/run.sh`:

```bash
#!/usr/bin/env bash
# Measures what each host gives an MCP server and a hook: session-id env vars,
# and the ppid relationship between the two processes. Read-only: writes only
# into this directory, and touches neither ~/.claude nor ~/.codex.
set -uo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
OUT="$HERE/probe-out.jsonl"
rm -f "$OUT"

echo "=== claude ==="
cat > "$HERE/settings.probe.json" <<JSON
{"hooks":{"SessionStart":[{"matcher":"","hooks":[{"type":"command",
 "command":"PROBE_OUT=$OUT node $HERE/probe-hook.mjs","timeout":10}]}]}}
JSON
cat > "$HERE/mcp.probe.json" <<JSON
{"mcpServers":{"probe":{"command":"node","args":["$HERE/probe-mcp.mjs"],
 "env":{"PROBE_OUT":"$OUT"}}}}
JSON

# </dev/null matters: a headless agent left holding stdin waits forever.
claude -p "reply with the single word ok" \
  --settings "$HERE/settings.probe.json" \
  --mcp-config "$HERE/mcp.probe.json" \
  --strict-mcp-config </dev/null 2>&1 | tail -2

echo "=== codex ==="
HOOK_CMD="PROBE_OUT=$OUT node $HERE/probe-hook.mjs"
codex exec --enable hooks \
  -c "hooks.SessionStart=[{hooks=[{type=\"command\",command='''$HOOK_CMD''',timeout=10000}]}]" \
  -c "mcp_servers.probe.command=\"node\"" \
  -c "mcp_servers.probe.args=[\"$HERE/probe-mcp.mjs\"]" \
  -c "mcp_servers.probe.env={PROBE_OUT=\"$OUT\"}" \
  "reply with the single word ok" </dev/null 2>&1 | tail -3

echo "=== records ==="
cat "$OUT"
rm -f "$HERE/settings.probe.json" "$HERE/mcp.probe.json"
```

Then make it executable:

```bash
chmod +x spikes/session-identity/run.sh
```

- [ ] **Step 5: Run it and confirm the four facts**

Run: `./spikes/session-identity/run.sh`

Expected: four records. In the `claude` pair, both `ppid` values are the same number and the `mcp` record's env contains `CLAUDE_CODE_SESSION_ID` equal to the `hook` record's `payloadSessionId`. In the `codex` pair, both `ppid` values are the same number and the `mcp` record's `env` is `{}`.

If a run produces no records, check the traps first: `</dev/null` present, `--enable hooks` present, and the probe path absolute.

- [ ] **Step 6: Write FINDINGS.md**

Create `spikes/session-identity/FINDINGS.md`:

```markdown
# Session identity — how each host names a session

**Status: COMPLETE. The double-registration question is answered.**

**Date:** 2026-07-27 · **Codex:** codex-cli 0.145.0 · **Claude Code:** 2.1.220
**Host:** macOS 24.6.0. Reproduce with `./run.sh`.

## The question

The MCP server is not told the host's session id, so it falls back to
`pid-<ppid>` while the hook reports the host's real `session_id`. One agent
therefore registers twice. Which of these is the fix: read a session id from
the environment, reconcile daemon-side by `(workspaceRoot, pid)`, or have the
SessionStart hook write the id to a per-pid file?

## Answers

**1. Claude Code DOES export the session id to MCP servers.**

`CLAUDE_CODE_SESSION_ID` is present in the MCP server's environment and is
**identical** to the `session_id` in the hook's payload. Measured on both the
`sdk-cli` entrypoint (`claude -p`) and the interactive `cli` entrypoint.

> This corrects the note in HANDOFF.md dated 2026-07-26, which reported that a
> live MCP server's environment held zero `CLAUDE_*` variables. It does not.

**2. Codex exports nothing, and scrubs the environment.**

The Codex MCP server's environment contained **none** of the `CLAUDE_*` /
`CODEX_*` variables — while the hook, spawned by the same process moments
later, inherited all of them. Codex gives an MCP server only what its config
declares. Consequence: anything mesh's server needs under Codex must be written
into the `env` table by `mesh init`, and a session id cannot come from there at
all.

**3. The hook and the MCP server are children of the same process, on both hosts.**

| Host | MCP server pid → ppid | Hook pid → ppid |
|---|---|---|
| Claude Code | 25523 → **25477** | 25529 → **25477** |
| Codex | 27043 → **26968** | 27390 → **26968** |

No shell sits between the host and the hook — even for a command carrying an
env prefix (`PROBE_OUT=… node …`), which the shell exec's away. So
`process.ppid` is the host process on both sides, and `(workspaceRoot, pid)` is
a sound reconciliation key on both hosts.

**The per-pid file option is unnecessary.** Do not build it.

## The trap

A Codex session launched from inside a Claude session **inherits**
`CLAUDE_CODE_SESSION_ID` from the ambient environment — the Codex hook record
here carries the *outer Claude session's* id while its payload `session_id` is
a Codex UUIDv7. Reading that variable unconditionally would fuse two different
agents into one agent. **Only trust it when the provider is Claude.**

## Consequence for mesh

Identity resolution in the MCP server, in order:

1. `--session <id>` — explicit, wins over everything
2. `MESH_SESSION_ID` — the operator's escape hatch
3. `CLAUDE_CODE_SESSION_ID` — **only when the provider is Claude**
4. `pid-<ppid>` — provisional; the normal Codex path

And the daemon reconciles a provisional id with a real one when they share
`(workspaceRoot, pid)`, which covers Codex and any future host that names
sessions privately.

## Also measured, for `mesh init`

- Codex records hook trust in `~/.codex/config.toml` under
  `[hooks.state."<hooks.json path>:<event>:<i>:<j>"]` as
  `trusted_hash = "sha256:…"`. mesh must **not** write that entry — approving a
  hook is the user's decision. `mesh init` tells the user Codex will ask once.
- `[features] hooks = true` is required in `config.toml` for Codex hooks to run.
- Both hosts ship `mcp add` / `mcp remove` / `mcp list` subcommands, so mesh
  registers its MCP server through them and never hand-writes TOML.
```

- [ ] **Step 7: Commit**

```bash
git add spikes/session-identity
git commit -m "Measure how each host names a session, and correct the handoff"
```

---

### Task 2: Reconcile a provisional session id with the real one

Two registrations for one session must produce one agent. The registry is a pure module with an injected clock — this is a unit-testable change with no IO.

**Files:**
- Modify: `src/registry.ts`
- Test: `test/registry.test.ts` (append)

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces:
  - `isProvisionalSessionId(sessionId: string): boolean` — exported from `src/registry.ts`
  - `Registry.register`, `Registry.get`, `Registry.touch`, `Registry.unregister` resolve aliases; signatures unchanged.

- [ ] **Step 1: Write the failing tests**

Append to `test/registry.test.ts`:

```typescript
import { isProvisionalSessionId } from '../src/registry.ts';

test('isProvisionalSessionId recognizes only the pid fallback', () => {
  assert.equal(isProvisionalSessionId('pid-4821'), true);
  assert.equal(isProvisionalSessionId('c7cbb924-dffb-4045-b06f-e6099345f69e'), false);
  assert.equal(isProvisionalSessionId('pid-'), false);
  assert.equal(isProvisionalSessionId('pid-abc'), false);
});

test('a real session id adopts the agent an MCP server registered provisionally', () => {
  const clock = fakeClock(1000);
  const registry = new Registry({ clock });
  const workspace = { root: '/w', label: 'w', key: 'k' };

  // The MCP server starts first and has no id from its host.
  const provisional = registry.register({
    sessionId: 'pid-500',
    provider: 'codex',
    workspace,
    pid: 500,
  });
  // Then the hook fires, carrying the host's real session id.
  const real = registry.register({
    sessionId: '019fa0a8-8039-70c3',
    provider: 'codex',
    workspace,
    pid: 500,
  });

  assert.equal(real.name, provisional.name, 'the same agent, so claims and mail survive');
  assert.equal(registry.list('/w').length, 1, 'one session is one agent');
  assert.equal(real.sessionId, '019fa0a8-8039-70c3', 'the real id wins');
});

test('the provisional id keeps working after the real id takes over', () => {
  const clock = fakeClock(1000);
  const registry = new Registry({ clock });
  const workspace = { root: '/w', label: 'w', key: 'k' };

  registry.register({ sessionId: 'pid-500', provider: 'codex', workspace, pid: 500 });
  registry.register({ sessionId: 'real-1', provider: 'codex', workspace, pid: 500 });

  // The MCP server's connection still knows itself only as pid-500. Its close
  // is our liveness signal, so it MUST still be able to unregister the agent.
  assert.equal(registry.get('pid-500')?.sessionId, 'real-1');
  assert.equal(registry.touch('pid-500', 'Edit app.ts'), true);
  assert.equal(registry.get('real-1')?.activity, 'Edit app.ts');
  assert.equal(registry.unregister('pid-500')?.sessionId, 'real-1');
  assert.equal(registry.list('/w').length, 0);
});

test('a provisional register after a real one adopts the live agent', () => {
  const clock = fakeClock(1000);
  const registry = new Registry({ clock });
  const workspace = { root: '/w', label: 'w', key: 'k' };

  const real = registry.register({ sessionId: 'real-1', provider: 'claude', workspace, pid: 700 });
  const later = registry.register({ sessionId: 'pid-700', provider: 'claude', workspace, pid: 700 });

  assert.equal(later.name, real.name);
  assert.equal(registry.list('/w').length, 1);
  assert.equal(registry.get('pid-700')?.sessionId, 'real-1');
});

test('two real sessions sharing a pid stay separate agents', () => {
  const clock = fakeClock(1000);
  const registry = new Registry({ clock });
  const workspace = { root: '/w', label: 'w', key: 'k' };

  registry.register({ sessionId: 'real-1', provider: 'claude', workspace, pid: 900 });
  registry.register({ sessionId: 'real-2', provider: 'claude', workspace, pid: 900 });

  assert.equal(registry.list('/w').length, 2, 'merging is only ever a provisional-to-real move');
});

test('agents in different workspaces never merge, whatever their pids', () => {
  const clock = fakeClock(1000);
  const registry = new Registry({ clock });

  registry.register({
    sessionId: 'pid-500',
    provider: 'claude',
    workspace: { root: '/a', label: 'a', key: 'ka' },
    pid: 500,
  });
  registry.register({
    sessionId: 'real-1',
    provider: 'claude',
    workspace: { root: '/b', label: 'b', key: 'kb' },
    pid: 500,
  });

  assert.equal(registry.list('/a').length, 1);
  assert.equal(registry.list('/b').length, 1);
});

test('a merge does not free the agent name for reuse', () => {
  const clock = fakeClock(1000);
  const registry = new Registry({ clock });
  const workspace = { root: '/w', label: 'w', key: 'k' };

  const first = registry.register({ sessionId: 'pid-500', provider: 'claude', workspace, pid: 500 });
  registry.register({ sessionId: 'real-1', provider: 'claude', workspace, pid: 500 });
  const second = registry.register({ sessionId: 'other', provider: 'claude', workspace, pid: 600 });

  assert.equal(first.name, 'claude-1');
  assert.equal(second.name, 'claude-2', 'the merged agent still holds claude-1');
});
```

If `test/registry.test.ts` has no `fakeClock` helper, use the one it already
uses for its existing tests; if it constructs clocks inline as
`() => now`, follow that local convention instead and drop the helper name.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test test/registry.test.ts`

Expected: FAIL — `isProvisionalSessionId is not a function`, and the merge tests report 2 agents where 1 is expected.

- [ ] **Step 3: Implement reconciliation**

In `src/registry.ts`, add after the imports:

```typescript
/**
 * The id the MCP server invents when its host does not give it one.
 * Measured 2026-07-27: Codex passes no session id and scrubs the environment
 * it hands an MCP server, so this is the normal Codex path, not an edge case.
 * See spikes/session-identity/FINDINGS.md.
 */
const PROVISIONAL_ID = /^pid-\d+$/;

export function isProvisionalSessionId(sessionId: string): boolean {
  return PROVISIONAL_ID.test(sessionId);
}
```

Add the alias map alongside the other private fields:

```typescript
  /** provisional id → the real id that superseded it. */
  #aliases = new Map<string, string>();

  #resolve(sessionId: string): string {
    return this.#aliases.get(sessionId) ?? sessionId;
  }
```

Replace `register` with:

```typescript
  register(input: RegisterInput): Agent {
    const now = this.#clock();
    const sessionId = this.#resolve(input.sessionId);

    // Idempotent per session: a hook can fire before the MCP server connects,
    // and both paths register. Neither should mint a second agent.
    const existing = this.#agents.get(sessionId);
    if (existing) {
      existing.lastSeen = now;
      if (input.role !== undefined) existing.role = input.role;
      if (input.pid !== undefined) existing.pid = input.pid;
      return existing;
    }

    // One host process, two ids: the hook knows the host's real session id and
    // the MCP server had to invent one. Measured 2026-07-27: on Claude and on
    // Codex both processes are direct children of the host, so process.ppid is
    // the same number on both sides and identifies the session.
    const twin =
      input.pid === undefined
        ? undefined
        : this.#twinFor(input.workspace.root, input.pid, input.sessionId);
    if (twin) return this.#adopt(twin, input, now);

    const agent: Agent = {
      name: this.#allocatorFor(input.workspace.root).allocate(input.provider),
      sessionId: input.sessionId,
      provider: input.provider,
      role: input.role ?? null,
      pid: input.pid ?? null,
      workspaceRoot: input.workspace.root,
      workspaceLabel: input.workspace.label,
      registeredAt: now,
      lastSeen: now,
      activity: null,
    };

    this.#agents.set(agent.sessionId, agent);
    this.#order.push(agent.sessionId);
    return agent;
  }

  /**
   * An agent that is the same session as `incomingId` under another name.
   * Exactly one of the two ids must be provisional: two *real* ids sharing a
   * pid are genuinely different sessions and merging them would silently fuse
   * two agents — far worse than the duplicate row this fixes.
   */
  #twinFor(workspaceRoot: string, pid: number, incomingId: string): Agent | undefined {
    const incomingProvisional = isProvisionalSessionId(incomingId);
    for (const agent of this.#agents.values()) {
      if (agent.workspaceRoot !== workspaceRoot || agent.pid !== pid) continue;
      if (isProvisionalSessionId(agent.sessionId) !== incomingProvisional) return agent;
    }
    return undefined;
  }

  /**
   * Folds a second registration into the agent that already exists. The name
   * never changes: claims and mailboxes are keyed by name, so renaming here
   * would strand both.
   */
  #adopt(twin: Agent, input: RegisterInput, now: number): Agent {
    twin.lastSeen = now;
    if (input.role !== undefined) twin.role = input.role;

    if (isProvisionalSessionId(twin.sessionId)) {
      // The real id wins. The provisional one becomes an alias, because the
      // connection that registered it still refers to itself that way — and
      // for the MCP server that connection closing is our liveness signal.
      const provisional = twin.sessionId;
      this.#agents.delete(provisional);
      twin.sessionId = input.sessionId;
      this.#agents.set(input.sessionId, twin);
      this.#order = this.#order.map((id) => (id === provisional ? input.sessionId : id));
      this.#aliases.set(provisional, input.sessionId);
    } else {
      this.#aliases.set(input.sessionId, twin.sessionId);
    }
    return twin;
  }
```

Then make the other three entry points alias-aware. Replace `unregister`, `touch`, and `get`:

```typescript
  unregister(sessionId: string): Agent | null {
    const resolved = this.#resolve(sessionId);
    const agent = this.#agents.get(resolved);
    if (!agent) return null;
    this.#agents.delete(resolved);
    this.#order = this.#order.filter((id) => id !== resolved);
    for (const [alias, target] of this.#aliases) {
      if (alias === resolved || target === resolved) this.#aliases.delete(alias);
    }
    this.#allocatorFor(agent.workspaceRoot).release(agent.name);
    return agent;
  }

  touch(sessionId: string, activity?: string): boolean {
    const agent = this.#agents.get(this.#resolve(sessionId));
    if (!agent) return false;
    agent.lastSeen = this.#clock();
    if (activity !== undefined) agent.activity = activity;
    return true;
  }

  get(sessionId: string): Agent | undefined {
    return this.#agents.get(this.#resolve(sessionId));
  }
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --test test/registry.test.ts`

Expected: PASS, including every pre-existing registry test.

- [ ] **Step 5: Run the whole suite and the typechecker**

Run: `npm test && npm run typecheck`

Expected: all tests pass, `tsc` prints nothing.

- [ ] **Step 6: Commit**

```bash
git add src/registry.ts test/registry.test.ts
git commit -m "Reconcile a provisional session id with the host's real one"
```

---

### Task 3: Take the session id from the host when it offers one

**Files:**
- Modify: `src/mcp/server.ts:15-31`
- Test: `test/mcp.test.ts` (append)

**Interfaces:**
- Consumes: `isProvisionalSessionId` from Task 2 (in tests only).
- Produces: `resolveMcpIdentity(env: NodeJS.ProcessEnv, argv: string[], ppid?: number): McpOptions` — third parameter is new and defaults to `process.ppid`.

- [ ] **Step 1: Write the failing tests**

Append to `test/mcp.test.ts`:

```typescript
test('resolveMcpIdentity prefers an explicit --session flag', () => {
  const identity = resolveMcpIdentity(
    { MESH_SESSION_ID: 'from-env', CLAUDE_CODE_SESSION_ID: 'from-host' },
    ['node', 'mesh', 'mcp', '--session', 'from-flag'],
    4242,
  );
  assert.equal(identity.sessionId, 'from-flag');
});

test('resolveMcpIdentity reads the session id Claude Code exports', () => {
  // Measured 2026-07-27: this variable is present in the MCP server's
  // environment and equals the session_id the hook receives.
  const identity = resolveMcpIdentity(
    { CLAUDE_CODE_SESSION_ID: 'c7cbb924-dffb-4045-b06f-e6099345f69e' },
    ['node', 'mesh', 'mcp'],
    4242,
  );
  assert.equal(identity.sessionId, 'c7cbb924-dffb-4045-b06f-e6099345f69e');
  assert.equal(identity.provider, 'claude');
});

test('resolveMcpIdentity ignores an inherited Claude id under Codex', () => {
  // The trap: a Codex session launched from a Claude session inherits
  // CLAUDE_CODE_SESSION_ID. Trusting it would fuse two different agents.
  const identity = resolveMcpIdentity(
    { MESH_PROVIDER: 'codex', CLAUDE_CODE_SESSION_ID: 'the-outer-claude-session' },
    ['node', 'mesh', 'mcp'],
    26968,
  );
  assert.equal(identity.sessionId, 'pid-26968');
  assert.equal(identity.provider, 'codex');
});

test('resolveMcpIdentity falls back to the host pid, which the daemon reconciles', () => {
  const identity = resolveMcpIdentity({}, ['node', 'mesh', 'mcp'], 26968);
  assert.equal(identity.sessionId, 'pid-26968');
  assert.equal(isProvisionalSessionId(identity.sessionId), true);
});

test('MESH_SESSION_ID overrides the host, as the operator escape hatch', () => {
  const identity = resolveMcpIdentity(
    { MESH_SESSION_ID: 'chosen', CLAUDE_CODE_SESSION_ID: 'from-host' },
    ['node', 'mesh', 'mcp'],
    1,
  );
  assert.equal(identity.sessionId, 'chosen');
});

test('resolveMcpIdentity carries role and cwd through', () => {
  const identity = resolveMcpIdentity(
    { MESH_ROLE: 'backend', MESH_CWD: '/w' },
    ['node', 'mesh', 'mcp'],
    1,
  );
  assert.equal(identity.role, 'backend');
  assert.equal(identity.cwd, '/w');
});
```

Add the imports this file needs at its top, next to the existing ones:

```typescript
import { isProvisionalSessionId } from '../src/registry.ts';
```

(`resolveMcpIdentity` is already imported by `test/mcp.test.ts`; if it is not, add it to that file's existing import from `../src/mcp/server.ts`.)

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test test/mcp.test.ts`

Expected: FAIL — the Claude-id test reports `pid-4242`, because nothing reads `CLAUDE_CODE_SESSION_ID` yet.

- [ ] **Step 3: Implement the resolution order**

Replace `src/mcp/server.ts:15-31` with:

```typescript
/**
 * Where a session id comes from, in order of trust:
 *
 *   1. `--session <id>`        explicit; wins over everything
 *   2. MESH_SESSION_ID         the operator's escape hatch
 *   3. CLAUDE_CODE_SESSION_ID  measured 2026-07-27: Claude Code exports this to
 *                              its MCP servers, interactive and `-p` alike, and
 *                              it equals the session_id the hook receives.
 *   4. `pid-<ppid>`            provisional. Codex passes no session id at all —
 *                              it scrubs the environment it gives an MCP server
 *                              — so this is the normal Codex path. The daemon
 *                              reconciles it with the hook's real id by
 *                              (workspace, host pid), which is the same number
 *                              on both sides. See
 *                              spikes/session-identity/FINDINGS.md.
 *
 * The host variable is read ONLY under Claude: a Codex session launched from a
 * Claude session inherits CLAUDE_CODE_SESSION_ID, and trusting it there would
 * merge two different agents into one.
 */
export function resolveMcpIdentity(
  env: NodeJS.ProcessEnv,
  argv: string[],
  ppid: number = process.ppid,
): McpOptions {
  const flagIndex = argv.indexOf('--session');
  const fromFlag = flagIndex === -1 ? undefined : argv[flagIndex + 1];
  const provider = env.MESH_PROVIDER ?? 'claude';
  const isClaude = provider === 'claude';
  const role = env.MESH_ROLE;

  return {
    sessionId:
      fromFlag ??
      env.MESH_SESSION_ID ??
      (isClaude ? env.CLAUDE_CODE_SESSION_ID : undefined) ??
      `pid-${ppid}`,
    provider,
    cwd: env.MESH_CWD ?? (isClaude ? env.CLAUDE_PROJECT_DIR : undefined) ?? process.cwd(),
    ...(role ? { role } : {}),
  };
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --test test/mcp.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/mcp/server.ts test/mcp.test.ts
git commit -m "Take the session id from the host when it exports one"
```

---

### Task 4: Prove one session registers once, over a real socket

Unit tests cover the registry; this covers the wiring — the daemon, the socket, ownership, and the disconnect path together.

**Files:**
- Create: `test/e2e-identity.test.ts`

**Interfaces:**
- Consumes: `Registry` reconciliation (Task 2), `resolveMcpIdentity` (Task 3), the existing daemon server and `MeshClient`.
- Produces: no exports.

- [ ] **Step 1: Write the failing test**

Read `test/e2e-messaging.test.ts` first and copy its harness verbatim — how it starts a daemon on a temp socket, how it builds clients, and how it tears down. Then create `test/e2e-identity.test.ts` using that same harness:

```typescript
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MeshClient } from '../src/client.ts';
import { startDaemon } from '../src/daemon/server.ts';

// Use the same start/stop helpers as test/e2e-messaging.test.ts. If that file
// names them differently, follow it — one harness, not two.

test('an MCP server and a hook for one session produce one agent', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mesh-identity-'));
  const socket = join(dir, 'mesh.sock');
  const daemon = await startDaemon({ socketPath: socket, journalPath: join(dir, 'j.jsonl') });

  try {
    // The MCP server connects first with no id from its host, and owns the
    // session's lifetime.
    const mcp = await MeshClient.open({ socketPath: socket, autostart: false });
    assert.ok(mcp);
    await mcp.request('register', {
      sessionId: 'pid-4242',
      provider: 'codex',
      cwd: dir,
      pid: 4242,
      own: true,
    });

    // Then a tool call fires the hook, which knows the host's real id.
    const hook = await MeshClient.open({ socketPath: socket, autostart: false });
    assert.ok(hook);
    await hook.request('register', {
      sessionId: '019fa0a8-8039-70c3',
      provider: 'codex',
      cwd: dir,
      pid: 4242,
    });
    await hook.request('touch', { sessionId: '019fa0a8-8039-70c3', activity: 'Edit server.ts' });
    hook.close();

    const who = await mcp.request('who', { cwd: dir });
    const agents = (who.agents ?? []) as Array<{ name: string; activity: string | null }>;
    assert.equal(agents.length, 1, 'one session is one row in mesh who');
    assert.equal(agents[0]?.activity, 'Edit server.ts', 'the hook reports for the merged agent');

    mcp.close();
    // The owning connection closing is the liveness signal, even though that
    // connection only ever knew the provisional id.
    await new Promise((resolve) => setTimeout(resolve, 100));

    const observer = await MeshClient.open({ socketPath: socket, autostart: false });
    assert.ok(observer);
    const after = await observer.request('who', { cwd: dir });
    assert.equal(((after.agents ?? []) as unknown[]).length, 0, 'the agent is gone when it dies');
    observer.close();
  } finally {
    await daemon.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('two genuinely different sessions on one workspace stay two agents', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mesh-identity-'));
  const socket = join(dir, 'mesh.sock');
  const daemon = await startDaemon({ socketPath: socket, journalPath: join(dir, 'j.jsonl') });

  try {
    const a = await MeshClient.open({ socketPath: socket, autostart: false });
    const b = await MeshClient.open({ socketPath: socket, autostart: false });
    assert.ok(a);
    assert.ok(b);
    await a.request('register', {
      sessionId: 'session-a',
      provider: 'claude',
      cwd: dir,
      pid: 100,
      own: true,
    });
    await b.request('register', {
      sessionId: 'session-b',
      provider: 'codex',
      cwd: dir,
      pid: 200,
      own: true,
    });

    const who = await a.request('who', { cwd: dir });
    assert.equal(((who.agents ?? []) as unknown[]).length, 2);
    a.close();
    b.close();
  } finally {
    await daemon.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});
```

- [ ] **Step 2: Run it**

Run: `node --test test/e2e-identity.test.ts`

Expected: PASS. If the first test fails at the final assertion with one agent
still present, the alias cleanup in `unregister` (Task 2) is wrong — the owning
connection unregisters by its provisional id and must resolve through the alias.

- [ ] **Step 3: Run the whole suite**

Run: `npm test && npm run typecheck`

Expected: everything passes.

- [ ] **Step 4: Commit**

```bash
git add test/e2e-identity.test.ts
git commit -m "Add an end-to-end test that one session registers once"
```

---

### Task 5: `mesh watch`

A human-facing TUI that repaints on an interval. It opens a fresh connection per
tick, exactly as `mesh who` does, so the watcher never looks like a connected
agent and never holds the daemon open.

**Files:**
- Modify: `src/daemon/handlers.ts:179-197` (the `who` op)
- Modify: `src/cli/who.ts:1-8` (`WhoAgent`)
- Create: `src/cli/watch.ts`
- Modify: `src/cli/index.ts`
- Test: `test/watch.test.ts`

**Interfaces:**
- Consumes: `formatDuration`, `WhoAgent` from `src/cli/who.ts`; `renderClaims`, `ClaimRow` from `src/cli/claims.ts`; `MeshClient`.
- Produces:
  - `renderWatch(payload: WatchPayload): string`
  - `CLEAR_SCREEN: string`
  - `watchTick(deps: WatchDeps): Promise<string>`
  - `runWatch(deps: WatchDeps): Promise<number>`
  - `WatchPayload { workspaceLabel: string; agents: WhoAgent[]; claims: ClaimRow[]; now: number; daemonReachable: boolean }`
  - `WatchDeps { connect: () => Promise<MeshClient | null>; write: (frame: string) => void; now: () => number; cwd: string; intervalMs: number; once: boolean; sleep?: (ms: number) => Promise<void> }`
  - `WhoAgent` gains `unanswered?: number` and `waitingOn?: string[]`

- [ ] **Step 1: Write the failing tests**

Create `test/watch.test.ts`:

```typescript
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderWatch, watchTick, runWatch, CLEAR_SCREEN } from '../src/cli/watch.ts';
import type { WhoAgent } from '../src/cli/who.ts';

const agent = (over: Partial<WhoAgent> = {}): WhoAgent => ({
  name: 'claude-1',
  provider: 'claude',
  role: 'frontend',
  status: 'working',
  activity: 'Edit app/page.tsx',
  idleMs: 2_000,
  ...over,
});

test('renderWatch shows each agent with what it is doing', () => {
  const out = renderWatch({
    workspaceLabel: 'leadops-v2',
    agents: [agent(), agent({ name: 'codex-2', role: 'backend', activity: 'Bash npm test' })],
    claims: [],
    now: Date.parse('2026-07-27T09:30:00Z'),
    daemonReachable: true,
  });

  assert.match(out, /leadops-v2/);
  assert.match(out, /claude-1/);
  assert.match(out, /Edit app\/page\.tsx/);
  assert.match(out, /codex-2/);
  assert.match(out, /ctrl-c/i, 'a TUI says how to leave it');
});

test('renderWatch surfaces unanswered questions so the human can nudge', () => {
  const out = renderWatch({
    workspaceLabel: 'w',
    agents: [agent({ name: 'codex-2', status: 'idle', activity: null, unanswered: 2 })],
    claims: [],
    now: 0,
    daemonReachable: true,
  });
  assert.match(out, /2 unanswered/);
  assert.match(out, /nudge/i);
});

test('renderWatch says questions are clear when nothing is pending', () => {
  const out = renderWatch({
    workspaceLabel: 'w',
    agents: [agent()],
    claims: [],
    now: 0,
    daemonReachable: true,
  });
  assert.match(out, /questions in flight:\n\s+none/);
});

test('renderWatch includes the claim table', () => {
  const out = renderWatch({
    workspaceLabel: 'w',
    agents: [agent()],
    claims: [
      { id: 1, holder: 'codex-2', patterns: ['server/**'], mode: 'exclusive', expiresInMs: 540_000 },
    ],
    now: 0,
    daemonReachable: true,
  });
  assert.match(out, /server\/\*\*/);
  assert.match(out, /exclusive/);
});

test('renderWatch explains a missing daemon instead of showing an empty table', () => {
  const out = renderWatch({
    workspaceLabel: '',
    agents: [],
    claims: [],
    now: 0,
    daemonReachable: false,
  });
  assert.match(out, /not running/i);
  assert.match(out, /mesh init/, 'names the command that fixes it');
  assert.doesNotMatch(out, /undefined/);
});

test('renderWatch handles a workspace with no agents yet', () => {
  const out = renderWatch({
    workspaceLabel: 'w',
    agents: [],
    claims: [],
    now: 0,
    daemonReachable: true,
  });
  assert.match(out, /no agents/i);
});

test('watchTick reports an unreachable daemon rather than throwing', async () => {
  const frame = await watchTick({
    connect: async () => null,
    write: () => {},
    now: () => 0,
    cwd: '/w',
    intervalMs: 1000,
    once: true,
  });
  assert.match(frame, /not running/i);
});

test('watchTick closes the connection it opened, every tick', async () => {
  let closed = 0;
  const fakeClient = {
    request: async (op: string) =>
      op === 'who'
        ? { id: 1, ok: true, workspaceLabel: 'w', agents: [agent()] }
        : { id: 2, ok: true, claims: [] },
    close: () => {
      closed += 1;
    },
  };

  const frame = await watchTick({
    connect: async () => fakeClient as never,
    write: () => {},
    now: () => 0,
    cwd: '/w',
    intervalMs: 1000,
    once: true,
  });

  assert.match(frame, /claude-1/);
  assert.equal(closed, 1, 'a watcher must not leak connections once per second');
});

test('runWatch repaints and stops after one frame when once is set', async () => {
  const frames: string[] = [];
  const code = await runWatch({
    connect: async () => null,
    write: (frame) => frames.push(frame),
    now: () => 0,
    cwd: '/w',
    intervalMs: 1000,
    once: true,
  });

  assert.equal(code, 0);
  assert.equal(frames.length, 1);
  assert.ok(frames[0]?.startsWith(CLEAR_SCREEN), 'each frame repaints the screen');
});

test('runWatch keeps polling on the interval until stopped', async () => {
  const frames: string[] = [];
  let sleeps = 0;
  const deps = {
    connect: async () => null,
    write: (frame: string) => frames.push(frame),
    now: () => 0,
    cwd: '/w',
    intervalMs: 25,
    once: false,
    sleep: async (ms: number) => {
      sleeps += 1;
      assert.equal(ms, 25);
      if (sleeps === 3) throw new Error('stop');
    },
  };

  await assert.rejects(() => runWatch(deps), /stop/);
  assert.equal(frames.length, 3);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test test/watch.test.ts`

Expected: FAIL — `Cannot find module '../src/cli/watch.ts'`.

- [ ] **Step 3: Let `who` report questions in flight**

In `src/cli/who.ts`, extend the interface at lines 1-8:

```typescript
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
```

In `src/daemon/handlers.ts`, in the `who` case, replace the `agents` mapping:

```typescript
      const agents = state.registry.list(workspace.root).map((agent) => ({
        name: agent.name,
        provider: agent.provider,
        role: agent.role,
        status: agent.status,
        activity: agent.activity,
        idleMs: agent.idleMs,
        pid: agent.pid,
        // An idle agent cannot be reached by a hook-based transport, so the
        // human is the fallback: mesh watch shows them what is stuck.
        unanswered: state.asks.pendingFor(agent.name).length,
        waitingOn: state.asks.waitingOn(agent.name).map((ask) => ask.to),
      }));
```

- [ ] **Step 4: Implement `mesh watch`**

Create `src/cli/watch.ts`:

```typescript
import type { MeshClient } from '../client.ts';
import { formatDuration } from './who.ts';
import type { WhoAgent } from './who.ts';
import { renderClaims } from './claims.ts';
import type { ClaimRow } from './claims.ts';

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

  const lines: string[] = [`mesh watch — ${payload.workspaceLabel}   ${clockLabel(payload.now)}`, ''];

  if (payload.agents.length === 0) {
    lines.push('  no agents here yet');
  } else {
    const nameWidth = Math.max(...payload.agents.map((a) => a.name.length), 6);
    const roleWidth = Math.max(...payload.agents.map((a) => (a.role ?? '—').length), 4);
    for (const agent of payload.agents) {
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
  const stuck = payload.agents.filter((agent) => (agent.unanswered ?? 0) > 0);
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
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `node --test test/watch.test.ts`

Expected: PASS, all ten tests.

- [ ] **Step 6: Wire the command in**

In `src/cli/index.ts`, add the import beside the others:

```typescript
import { runWatch, DEFAULT_INTERVAL_MS } from './watch.ts';
```

Add the command function after `cmdClaims`:

```typescript
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
```

Add the case to the `switch` in `main`, after `case 'claims':`:

```typescript
    case 'watch':
      return cmdWatch(argv.slice(3));
```

And add the line to `USAGE`, after the `mesh claims` line:

```
  mesh watch      Live view of agents, questions, and claims (--once, --interval <ms>)
```

- [ ] **Step 7: Verify the command runs**

Run: `node src/cli/index.ts watch --once`

Expected: one frame. With no daemon running it prints the "daemon not running"
block; with one running it prints the workspace, agents, questions, and claims.

- [ ] **Step 8: Commit**

```bash
git add src/cli/watch.ts src/cli/who.ts src/cli/index.ts src/daemon/handlers.ts test/watch.test.ts
git commit -m "Add mesh watch, and report questions in flight from who"
```

---

### Task 6: Installation primitives — the compiled entry point, backups, atomic writes

`mesh init` edits files a user depends on to work. Everything it writes goes
through these two modules.

**Files:**
- Create: `src/install/entry.ts`
- Create: `src/install/backup.ts`
- Test: `test/install-primitives.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `distEntryPoint(moduleUrl?: string): string`
  - `requireBuiltEntryPoint(entry?: string): string` — throws with a build instruction when missing
  - `backupStamp(now: number): string`
  - `backupFile(path: string, stamp: string): string | null`
  - `writeFileAtomic(path: string, contents: string): void`

- [ ] **Step 1: Write the failing tests**

Create `test/install-primitives.test.ts`:

```typescript
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { distEntryPoint, requireBuiltEntryPoint } from '../src/install/entry.ts';
import { backupFile, backupStamp, writeFileAtomic } from '../src/install/backup.ts';

test('distEntryPoint resolves the compiled CLI, never the TypeScript source', () => {
  const entry = distEntryPoint(pathToFileURL('/pkg/src/install/entry.ts').href);
  assert.equal(entry, '/pkg/dist/cli/index.js');
});

test('distEntryPoint resolves the same target when it is itself running compiled', () => {
  const entry = distEntryPoint(pathToFileURL('/pkg/dist/install/entry.js').href);
  assert.equal(entry, '/pkg/dist/cli/index.js');
});

test('requireBuiltEntryPoint tells the user to build rather than writing a dead path', () => {
  assert.throws(
    () => requireBuiltEntryPoint('/nope/dist/cli/index.js'),
    /npm run build/,
    'the error names the fix',
  );
});

test('requireBuiltEntryPoint returns the path when it exists', () => {
  const dir = mkdtempSync(join(tmpdir(), 'mesh-entry-'));
  const entry = join(dir, 'index.js');
  writeFileSync(entry, '// built');
  assert.equal(requireBuiltEntryPoint(entry), entry);
  rmSync(dir, { recursive: true, force: true });
});

test('backupStamp is filename-safe', () => {
  const stamp = backupStamp(Date.parse('2026-07-27T09:30:15.123Z'));
  assert.doesNotMatch(stamp, /[:.]/);
  assert.match(stamp, /2026-07-27/);
});

test('backupFile copies an existing file and reports where', () => {
  const dir = mkdtempSync(join(tmpdir(), 'mesh-backup-'));
  const path = join(dir, 'settings.json');
  writeFileSync(path, '{"a":1}');

  const backup = backupFile(path, 'stamp');
  assert.equal(backup, `${path}.mesh-backup-stamp`);
  assert.equal(readFileSync(backup as string, 'utf8'), '{"a":1}');
  rmSync(dir, { recursive: true, force: true });
});

test('backupFile returns null for a file that does not exist yet', () => {
  const dir = mkdtempSync(join(tmpdir(), 'mesh-backup-'));
  assert.equal(backupFile(join(dir, 'absent.json'), 'stamp'), null);
  rmSync(dir, { recursive: true, force: true });
});

test('writeFileAtomic creates missing directories and leaves no temp file', () => {
  const dir = mkdtempSync(join(tmpdir(), 'mesh-write-'));
  const path = join(dir, 'nested', 'deeper', 'file.json');

  writeFileAtomic(path, '{"ok":true}');

  assert.equal(readFileSync(path, 'utf8'), '{"ok":true}');
  assert.equal(existsSync(`${path}.mesh-tmp`), false);
  rmSync(dir, { recursive: true, force: true });
});

test('writeFileAtomic preserves the mode of a file it replaces', () => {
  const dir = mkdtempSync(join(tmpdir(), 'mesh-write-'));
  const path = join(dir, 'file.json');
  writeFileSync(path, 'old', { mode: 0o644 });

  writeFileAtomic(path, 'new');

  assert.equal(readFileSync(path, 'utf8'), 'new');
  assert.equal(statSync(path).mode & 0o777, 0o644, 'a user config keeps its permissions');
  rmSync(dir, { recursive: true, force: true });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test test/install-primitives.test.ts`

Expected: FAIL — `Cannot find module '../src/install/entry.ts'`.

- [ ] **Step 3: Implement the entry-point resolver**

Create `src/install/entry.ts`:

```typescript
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

/**
 * The entry point hooks and MCP configs must point at: the COMPILED one.
 *
 * Measured in Phase 2 and unchanged since: the hook costs 64ms p95 from dist/
 * and ~105ms from src/, because TypeScript type-stripping is ~40ms per run and
 * the hook runs before EVERY tool call. Writing the source path into a user's
 * config would tax every session for the life of the install.
 *
 * Two levels up from this module is the package root whether this file is
 * running as src/install/entry.ts or as dist/install/entry.js.
 */
export function distEntryPoint(moduleUrl: string = import.meta.url): string {
  const packageRoot = resolve(dirname(fileURLToPath(moduleUrl)), '..', '..');
  return join(packageRoot, 'dist', 'cli', 'index.js');
}

export function requireBuiltEntryPoint(entry: string = distEntryPoint()): string {
  if (!existsSync(entry)) {
    throw new Error(
      `mesh init: ${entry} does not exist. Run \`npm run build\` first — ` +
        'hooks must run compiled JavaScript (64ms per tool call, against 105ms ' +
        'from TypeScript source).',
    );
  }
  return entry;
}
```

- [ ] **Step 4: Implement backup and atomic write**

Create `src/install/backup.ts`:

```typescript
import { copyFileSync, existsSync, mkdirSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

/** Filename-safe and sortable. */
export function backupStamp(now: number): string {
  return new Date(now).toISOString().replace(/[:.]/g, '-');
}

/**
 * A timestamped sibling copy, taken before every edit. These files belong to
 * the user's agents; a bad write must always be one `mv` away from undone.
 */
export function backupFile(path: string, stamp: string): string | null {
  if (!existsSync(path)) return null;
  const backup = `${path}.mesh-backup-${stamp}`;
  copyFileSync(path, backup);
  return backup;
}

/**
 * Write via a temp file and rename, so a crash mid-write cannot leave a host
 * with a half-written settings file it refuses to start with. The existing
 * mode is preserved: mesh must not silently tighten or loosen a user's config.
 */
export function writeFileAtomic(path: string, contents: string): void {
  mkdirSync(dirname(path), { recursive: true });
  const mode = existsSync(path) ? statSync(path).mode & 0o777 : 0o600;
  const temp = `${path}.mesh-tmp`;
  writeFileSync(temp, contents, { mode });
  renameSync(temp, path);
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `node --test test/install-primitives.test.ts`

Expected: PASS, all nine tests.

- [ ] **Step 6: Commit**

```bash
git add src/install/entry.ts src/install/backup.ts test/install-primitives.test.ts
git commit -m "Add install primitives: compiled entry point, backups, atomic writes"
```

---

### Task 7: The hook-config merge, and the Claude installer

Both hosts take the same JSON hook shape, so the merge is written once. The
Claude installer is the first caller.

**Files:**
- Create: `src/install/hooks.ts`
- Create: `src/install/note.ts`
- Create: `src/install/claude.ts`
- Test: `test/install-claude.test.ts`

**Interfaces:**
- Consumes: `backupFile`, `backupStamp`, `writeFileAtomic` (Task 6).
- Produces:
  - `MESH_HOOK_EVENTS: readonly string[]`
  - `shellQuote(value: string): string`
  - `meshHookCommand(input: { nodePath: string; entry: string; event: string; env?: Record<string, string> }): string`
  - `blockMentions(block: HookMatcher, entry: string): boolean`
  - `withMeshHooks(config: HookConfig, options: { nodePath: string; entry: string; env?: Record<string, string>; includeMatcher: boolean }): HookConfig`
  - `HookEntry`, `HookMatcher`, `HookConfig` types
  - `withMeshNote(text: string): string`, `MESH_NOTE_BEGIN`, `MESH_NOTE_END`
  - `claudePaths(home: string): { settings: string; instructions: string }`
  - `planClaudeInstall(input: ClaudeInstallInput): ClaudeInstallPlan`
  - `applyClaudeInstall(plan: ClaudeInstallPlan): string[]`

- [ ] **Step 1: Write the failing tests**

Create `test/install-claude.test.ts`:

```typescript
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  MESH_HOOK_EVENTS,
  meshHookCommand,
  shellQuote,
  withMeshHooks,
} from '../src/install/hooks.ts';
import { withMeshNote, MESH_NOTE_BEGIN } from '../src/install/note.ts';
import { claudePaths, planClaudeInstall, applyClaudeInstall } from '../src/install/claude.ts';

test('mesh installs SessionStart and PreToolUse only', () => {
  // Every extra event costs 64ms on a path the user feels. PostToolUse adds
  // nothing PreToolUse does not already report; Stop belongs to Phase 4.
  assert.deepEqual([...MESH_HOOK_EVENTS], ['SessionStart', 'PreToolUse']);
});

test('meshHookCommand points at the compiled entry with the event', () => {
  const command = meshHookCommand({
    nodePath: '/usr/bin/node',
    entry: '/pkg/dist/cli/index.js',
    event: 'PreToolUse',
  });
  assert.equal(command, '/usr/bin/node /pkg/dist/cli/index.js hook PreToolUse');
});

test('meshHookCommand carries env as a shell prefix', () => {
  const command = meshHookCommand({
    nodePath: '/usr/bin/node',
    entry: '/pkg/dist/cli/index.js',
    event: 'PreToolUse',
    env: { MESH_PROVIDER: 'codex' },
  });
  assert.equal(
    command,
    'MESH_PROVIDER=codex /usr/bin/node /pkg/dist/cli/index.js hook PreToolUse',
  );
});

test('shellQuote protects paths with spaces', () => {
  assert.equal(shellQuote('/Users/k/My Projects/mesh'), "'/Users/k/My Projects/mesh'");
  assert.equal(shellQuote('/usr/bin/node'), '/usr/bin/node');
  assert.equal(shellQuote("it's"), "'it'\\''s'");
});

test('withMeshHooks leaves other tools hooks untouched', () => {
  const existing = {
    SessionStart: [{ matcher: '', hooks: [{ type: 'command' as const, command: 'cmux hooks x' }] }],
    Stop: [{ matcher: '', hooks: [{ type: 'command' as const, command: 'cmux hooks stop' }] }],
  };

  const merged = withMeshHooks(existing, {
    nodePath: 'node',
    entry: '/pkg/dist/cli/index.js',
    includeMatcher: true,
  });

  assert.equal(merged.SessionStart?.length, 2, 'appended, not replaced');
  assert.match(JSON.stringify(merged.SessionStart), /cmux hooks x/);
  assert.deepEqual(merged.Stop, existing.Stop, 'an event mesh does not use is untouched');
});

test('withMeshHooks is idempotent — running init twice adds one hook, not two', () => {
  const once = withMeshHooks(
    {},
    { nodePath: 'node', entry: '/pkg/dist/cli/index.js', includeMatcher: true },
  );
  const twice = withMeshHooks(once, {
    nodePath: 'node',
    entry: '/pkg/dist/cli/index.js',
    includeMatcher: true,
  });

  assert.deepEqual(twice, once);
  assert.equal(twice.PreToolUse?.length, 1);
});

test('withMeshHooks repoints an older mesh entry rather than duplicating it', () => {
  const old = withMeshHooks(
    {},
    { nodePath: '/old/node', entry: '/pkg/dist/cli/index.js', includeMatcher: true },
  );
  const updated = withMeshHooks(old, {
    nodePath: '/new/node',
    entry: '/pkg/dist/cli/index.js',
    includeMatcher: true,
  });

  assert.equal(updated.PreToolUse?.length, 1);
  assert.match(JSON.stringify(updated.PreToolUse), /\/new\/node/);
  assert.doesNotMatch(JSON.stringify(updated.PreToolUse), /\/old\/node/);
});

test('withMeshHooks omits the matcher key when the host does not use one', () => {
  const merged = withMeshHooks(
    {},
    { nodePath: 'node', entry: '/pkg/dist/cli/index.js', includeMatcher: false },
  );
  assert.equal('matcher' in (merged.PreToolUse?.[0] ?? {}), false);
});

test('withMeshNote adds a fenced, attributed block once', () => {
  const first = withMeshNote('# My instructions\n');
  assert.match(first, /My instructions/);
  assert.match(first, /mesh_who/);
  assert.match(first, new RegExp(MESH_NOTE_BEGIN));

  const second = withMeshNote(first);
  assert.equal(second, first, 'idempotent');
  assert.equal(second.split(MESH_NOTE_BEGIN).length - 1, 1, 'exactly one block');
});

test('withMeshNote replaces an outdated block instead of stacking a new one', () => {
  const stale = `# Notes\n\n${MESH_NOTE_BEGIN}\nold text\n<!-- mesh:end -->\n`;
  const fresh = withMeshNote(stale);
  assert.doesNotMatch(fresh, /old text/);
  assert.equal(fresh.split(MESH_NOTE_BEGIN).length - 1, 1);
});

test('claudePaths names the two files mesh touches', () => {
  const paths = claudePaths('/home/k');
  assert.equal(paths.settings, '/home/k/.claude/settings.json');
  assert.equal(paths.instructions, '/home/k/.claude/CLAUDE.md');
});

test('planClaudeInstall reports absent when Claude is not installed', () => {
  const dir = mkdtempSync(join(tmpdir(), 'mesh-claude-'));
  const plan = planClaudeInstall({
    home: dir,
    nodePath: 'node',
    entry: '/pkg/dist/cli/index.js',
    now: 0,
  });
  assert.equal(plan.present, false);
  rmSync(dir, { recursive: true, force: true });
});

test('applyClaudeInstall merges hooks, backs up, and keeps other settings', () => {
  const dir = mkdtempSync(join(tmpdir(), 'mesh-claude-'));
  mkdirSync(join(dir, '.claude'));
  const settings = join(dir, '.claude', 'settings.json');
  writeFileSync(settings, JSON.stringify({ model: 'opus', hooks: { Stop: [] } }, null, 2));

  const plan = planClaudeInstall({
    home: dir,
    nodePath: 'node',
    entry: '/pkg/dist/cli/index.js',
    now: Date.parse('2026-07-27T09:00:00Z'),
  });
  const written = applyClaudeInstall(plan);

  const after = JSON.parse(readFileSync(settings, 'utf8'));
  assert.equal(after.model, 'opus', 'unrelated settings survive');
  assert.equal(after.hooks.PreToolUse.length, 1);
  assert.match(after.hooks.PreToolUse[0].hooks[0].command, /dist\/cli\/index\.js hook PreToolUse/);
  assert.ok(written.some((path) => path.includes('mesh-backup')), 'a backup was taken');
  rmSync(dir, { recursive: true, force: true });
});

test('applyClaudeInstall creates settings.json when only the directory exists', () => {
  const dir = mkdtempSync(join(tmpdir(), 'mesh-claude-'));
  mkdirSync(join(dir, '.claude'));

  const plan = planClaudeInstall({ home: dir, nodePath: 'node', entry: '/e.js', now: 0 });
  applyClaudeInstall(plan);

  const after = JSON.parse(readFileSync(join(dir, '.claude', 'settings.json'), 'utf8'));
  assert.equal(after.hooks.SessionStart.length, 1);
  rmSync(dir, { recursive: true, force: true });
});

test('applyClaudeInstall refuses to touch settings it cannot parse', () => {
  const dir = mkdtempSync(join(tmpdir(), 'mesh-claude-'));
  mkdirSync(join(dir, '.claude'));
  const settings = join(dir, '.claude', 'settings.json');
  writeFileSync(settings, '{ not json');

  const plan = planClaudeInstall({ home: dir, nodePath: 'node', entry: '/e.js', now: 0 });
  assert.throws(() => applyClaudeInstall(plan), /could not parse/i);
  assert.equal(readFileSync(settings, 'utf8'), '{ not json', 'the file is left exactly as it was');
  rmSync(dir, { recursive: true, force: true });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test test/install-claude.test.ts`

Expected: FAIL — `Cannot find module '../src/install/hooks.ts'`.

- [ ] **Step 3: Implement the hook merge**

Create `src/install/hooks.ts`:

```typescript
export interface HookEntry {
  type: 'command';
  command: string;
  timeout?: number;
}

export interface HookMatcher {
  matcher?: string;
  hooks: HookEntry[];
}

export type HookConfig = Record<string, HookMatcher[]>;

/**
 * The events mesh installs, and no others.
 *
 * SessionStart registers the agent. PreToolUse reports activity, injects
 * anything addressed to this agent, and is the enforcement point for claims.
 * PostToolUse would report nothing PreToolUse has not already reported, and
 * every installed event costs another 64ms process on the user's critical
 * path. Phase 4 adds Stop when it has a reminder to deliver there.
 */
export const MESH_HOOK_EVENTS: readonly string[] = ['SessionStart', 'PreToolUse'];

/** Ten seconds is far above the 90ms budget; it exists to bound a wedged host. */
const HOOK_TIMEOUT_SECONDS = 10;

const SAFE_UNQUOTED = /^[A-Za-z0-9_@%+=:,./-]+$/;

export function shellQuote(value: string): string {
  if (SAFE_UNQUOTED.test(value)) return value;
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/**
 * The command a host runs for one event.
 *
 * `nodePath` is absolute — the node that ran `mesh init`, not whatever `node`
 * a hook's minimal PATH might resolve to. Env is a shell prefix rather than a
 * wrapper script: measured 2026-07-27, a prefixed command is still exec'd to a
 * direct child of the host, which is what keeps process.ppid equal to the host
 * pid and lets the daemon reconcile the hook with the MCP server.
 */
export function meshHookCommand(input: {
  nodePath: string;
  entry: string;
  event: string;
  env?: Record<string, string>;
}): string {
  const prefix = Object.entries(input.env ?? {})
    .map(([key, value]) => `${key}=${shellQuote(value)} `)
    .join('');
  return `${prefix}${shellQuote(input.nodePath)} ${shellQuote(input.entry)} hook ${input.event}`;
}

export function blockMentions(block: HookMatcher, entry: string): boolean {
  return (block.hooks ?? []).some(
    (hook) => typeof hook.command === 'string' && hook.command.includes(entry),
  );
}

/**
 * Adds mesh's hooks to a host's hook config.
 *
 * Idempotent by entry point: a block already pointing at this entry is dropped
 * and rewritten, so re-running init repoints instead of duplicating. Every
 * other block is preserved untouched — cmux, the user, and other tools all
 * live in these files, and mesh is a guest in them.
 */
export function withMeshHooks(
  config: HookConfig,
  options: {
    nodePath: string;
    entry: string;
    env?: Record<string, string>;
    includeMatcher: boolean;
  },
): HookConfig {
  const next: HookConfig = { ...config };

  for (const event of MESH_HOOK_EVENTS) {
    const others = (next[event] ?? []).filter((block) => !blockMentions(block, options.entry));
    const block: HookMatcher = {
      ...(options.includeMatcher ? { matcher: '' } : {}),
      hooks: [
        {
          type: 'command',
          command: meshHookCommand({
            nodePath: options.nodePath,
            entry: options.entry,
            event,
            ...(options.env ? { env: options.env } : {}),
          }),
          timeout: HOOK_TIMEOUT_SECONDS,
        },
      ],
    };
    next[event] = [...others, block];
  }

  return next;
}
```

- [ ] **Step 4: Implement the usage note**

Create `src/install/note.ts`:

```typescript
export const MESH_NOTE_BEGIN = '<!-- mesh:begin -->';
export const MESH_NOTE_END = '<!-- mesh:end -->';

/**
 * Written to the agent, not the user. Injected context and denial text already
 * tell an agent what to do in the moment; this exists so it knows the tools are
 * there before anything goes wrong.
 */
const NOTE = `## mesh — you are not alone in this project

Other AI agents may be working in this same project, in other terminal windows.
They are peers, not your sub-agents.

- \`mesh_who\` — see who else is here and what they are doing. Check before
  assuming you are the only one editing.
- \`mesh_ask\` — ask a peer a question and wait for the answer. Use it when you
  are blocked on something they own, instead of guessing.
- \`mesh_send\` — tell a peer something they need to know. No reply expected.
- \`mesh_inbox\` — read what peers have sent you.

If an edit is blocked with "BLOCKED by mesh", another agent has claimed that
path. The message names the holder and how to proceed. Do not work around it by
editing through a shell.`;

export function withMeshNote(text: string): string {
  const block = `${MESH_NOTE_BEGIN}\n${NOTE}\n${MESH_NOTE_END}`;
  const begin = text.indexOf(MESH_NOTE_BEGIN);

  if (begin !== -1) {
    const end = text.indexOf(MESH_NOTE_END, begin);
    if (end !== -1) {
      return `${text.slice(0, begin)}${block}${text.slice(end + MESH_NOTE_END.length)}`;
    }
  }

  const separator = text.length === 0 || text.endsWith('\n\n') ? '' : text.endsWith('\n') ? '\n' : '\n\n';
  return `${text}${separator}${block}\n`;
}
```

- [ ] **Step 5: Implement the Claude installer**

Create `src/install/claude.ts`:

```typescript
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { backupFile, backupStamp, writeFileAtomic } from './backup.ts';
import { withMeshHooks } from './hooks.ts';
import type { HookConfig } from './hooks.ts';
import { withMeshNote } from './note.ts';

export interface ClaudeInstallInput {
  home: string;
  nodePath: string;
  entry: string;
  now: number;
}

export interface ClaudeInstallPlan {
  present: boolean;
  settingsPath: string;
  instructionsPath: string;
  stamp: string;
  nodePath: string;
  entry: string;
}

export function claudePaths(home: string): { settings: string; instructions: string } {
  return {
    settings: join(home, '.claude', 'settings.json'),
    instructions: join(home, '.claude', 'CLAUDE.md'),
  };
}

export function planClaudeInstall(input: ClaudeInstallInput): ClaudeInstallPlan {
  const paths = claudePaths(input.home);
  return {
    // A host that was never installed is skipped, not created: writing a
    // config directory for a tool the user does not have is not mesh's call.
    present: existsSync(join(input.home, '.claude')),
    settingsPath: paths.settings,
    instructionsPath: paths.instructions,
    stamp: backupStamp(input.now),
    nodePath: input.nodePath,
    entry: input.entry,
  };
}

function readJsonObject(path: string): Record<string, unknown> {
  if (!existsSync(path)) return {};
  const raw = readFileSync(path, 'utf8').trim();
  if (raw.length === 0) return {};
  try {
    const parsed = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      throw new Error('not an object');
    }
    return parsed as Record<string, unknown>;
  } catch (error) {
    // Never rewrite a file we do not understand: a settings file mesh cannot
    // parse is one the user may still be able to.
    throw new Error(`mesh init: could not parse ${path} (${(error as Error).message}). Fix or move it, then re-run.`);
  }
}

/** Returns every path written, backups included. */
export function applyClaudeInstall(plan: ClaudeInstallPlan): string[] {
  const written: string[] = [];

  const settings = readJsonObject(plan.settingsPath);
  const hooks = (settings.hooks ?? {}) as HookConfig;
  settings.hooks = withMeshHooks(hooks, {
    nodePath: plan.nodePath,
    entry: plan.entry,
    includeMatcher: true,
  });

  const settingsBackup = backupFile(plan.settingsPath, plan.stamp);
  if (settingsBackup) written.push(settingsBackup);
  writeFileAtomic(plan.settingsPath, `${JSON.stringify(settings, null, 2)}\n`);
  written.push(plan.settingsPath);

  const instructions = existsSync(plan.instructionsPath)
    ? readFileSync(plan.instructionsPath, 'utf8')
    : '';
  const nextInstructions = withMeshNote(instructions);
  if (nextInstructions !== instructions) {
    const noteBackup = backupFile(plan.instructionsPath, plan.stamp);
    if (noteBackup) written.push(noteBackup);
    writeFileAtomic(plan.instructionsPath, nextInstructions);
    written.push(plan.instructionsPath);
  }

  return written;
}
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `node --test test/install-claude.test.ts`

Expected: PASS, all fifteen tests.

- [ ] **Step 7: Commit**

```bash
git add src/install/hooks.ts src/install/note.ts src/install/claude.ts test/install-claude.test.ts
git commit -m "Add the hook-config merge and the Claude installer"
```

---

### Task 8: The Codex installer, including hook trust

Codex needs three things Claude does not: `MESH_PROVIDER=codex` in the hook
command, `[features] hooks = true` in a TOML file, and the user's explicit trust
of the new hook.

**Files:**
- Create: `src/install/codex.ts`
- Test: `test/install-codex.test.ts`

**Interfaces:**
- Consumes: `withMeshHooks` (Task 7), `backupFile`, `backupStamp`, `writeFileAtomic` (Task 6).
- Produces:
  - `codexPaths(home: string): { hooks: string; config: string; instructions: string }`
  - `ensureCodexHooksFeature(toml: string): { text: string; changed: boolean }`
  - `codexHookTrustRecorded(toml: string, hooksPath: string): boolean`
  - `planCodexInstall(input: CodexInstallInput): CodexInstallPlan`
  - `applyCodexInstall(plan: CodexInstallPlan): string[]`

- [ ] **Step 1: Write the failing tests**

Create `test/install-codex.test.ts`:

```typescript
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  codexHookTrustRecorded,
  codexPaths,
  ensureCodexHooksFeature,
  planCodexInstall,
  applyCodexInstall,
} from '../src/install/codex.ts';

test('codexPaths names the three files mesh reads or writes', () => {
  const paths = codexPaths('/home/k');
  assert.equal(paths.hooks, '/home/k/.codex/hooks.json');
  assert.equal(paths.config, '/home/k/.codex/config.toml');
  assert.equal(paths.instructions, '/home/k/.codex/AGENTS.md');
});

test('ensureCodexHooksFeature appends the section when it is missing', () => {
  const { text, changed } = ensureCodexHooksFeature('model = "gpt-5"\n');
  assert.equal(changed, true);
  assert.match(text, /\[features\]\nhooks = true/);
  assert.match(text, /model = "gpt-5"/, 'existing config survives');
});

test('ensureCodexHooksFeature adds the key to an existing features section', () => {
  const { text, changed } = ensureCodexHooksFeature('[features]\nsomething = true\n\n[tui]\nx = 1\n');
  assert.equal(changed, true);
  assert.match(text, /\[features\]\nhooks = true\nsomething = true/);
  assert.match(text, /\[tui\]\nx = 1/, 'the next section is untouched');
});

test('ensureCodexHooksFeature flips an explicit false', () => {
  const { text, changed } = ensureCodexHooksFeature('[features]\nhooks = false\n');
  assert.equal(changed, true);
  assert.match(text, /hooks = true/);
  assert.doesNotMatch(text, /hooks = false/);
});

test('ensureCodexHooksFeature is a no-op when hooks are already enabled', () => {
  const input = '[features]\nhooks = true\n\n[tui]\n';
  const { text, changed } = ensureCodexHooksFeature(input);
  assert.equal(changed, false);
  assert.equal(text, input, 'an unchanged file is not rewritten');
});

test('ensureCodexHooksFeature handles an empty config', () => {
  const { text } = ensureCodexHooksFeature('');
  assert.match(text, /\[features\]\nhooks = true/);
});

test('codexHookTrustRecorded finds an approval for our hooks file', () => {
  const toml = [
    '[hooks.state."/home/k/.codex/hooks.json:session_start:0:0"]',
    'trusted_hash = "sha256:abc"',
    '',
  ].join('\n');
  assert.equal(codexHookTrustRecorded(toml, '/home/k/.codex/hooks.json'), true);
  assert.equal(codexHookTrustRecorded(toml, '/other/hooks.json'), false);
  assert.equal(codexHookTrustRecorded('', '/home/k/.codex/hooks.json'), false);
});

test('planCodexInstall reports absent when Codex is not installed', () => {
  const dir = mkdtempSync(join(tmpdir(), 'mesh-codex-'));
  const plan = planCodexInstall({ home: dir, nodePath: 'node', entry: '/e.js', now: 0 });
  assert.equal(plan.present, false);
  rmSync(dir, { recursive: true, force: true });
});

test('applyCodexInstall writes hooks that declare the provider', () => {
  const dir = mkdtempSync(join(tmpdir(), 'mesh-codex-'));
  mkdirSync(join(dir, '.codex'));

  const plan = planCodexInstall({
    home: dir,
    nodePath: '/usr/bin/node',
    entry: '/pkg/dist/cli/index.js',
    now: 0,
  });
  applyCodexInstall(plan);

  const hooks = JSON.parse(readFileSync(join(dir, '.codex', 'hooks.json'), 'utf8'));
  const command = hooks.hooks.PreToolUse[0].hooks[0].command;
  // Without this the hook registers the Codex agent as a Claude one: the
  // journal from the Phase 3 demo shows exactly that mislabelling.
  assert.match(command, /MESH_PROVIDER=codex/);
  assert.match(command, /dist\/cli\/index\.js hook PreToolUse/);
  assert.equal('matcher' in hooks.hooks.PreToolUse[0], false, 'Codex config carries no matcher');
  rmSync(dir, { recursive: true, force: true });
});

test('applyCodexInstall preserves another tool hooks and enables the feature', () => {
  const dir = mkdtempSync(join(tmpdir(), 'mesh-codex-'));
  mkdirSync(join(dir, '.codex'));
  writeFileSync(
    join(dir, '.codex', 'hooks.json'),
    JSON.stringify({
      hooks: { SessionStart: [{ hooks: [{ type: 'command', command: 'bash other.sh' }] }] },
    }),
  );
  writeFileSync(join(dir, '.codex', 'config.toml'), 'model = "gpt-5"\n');

  const plan = planCodexInstall({ home: dir, nodePath: 'node', entry: '/e.js', now: 0 });
  applyCodexInstall(plan);

  const hooks = JSON.parse(readFileSync(join(dir, '.codex', 'hooks.json'), 'utf8'));
  assert.equal(hooks.hooks.SessionStart.length, 2);
  assert.match(JSON.stringify(hooks), /bash other\.sh/);

  const config = readFileSync(join(dir, '.codex', 'config.toml'), 'utf8');
  assert.match(config, /\[features\]\nhooks = true/);
  assert.match(config, /model = "gpt-5"/);
  rmSync(dir, { recursive: true, force: true });
});

test('applyCodexInstall is idempotent', () => {
  const dir = mkdtempSync(join(tmpdir(), 'mesh-codex-'));
  mkdirSync(join(dir, '.codex'));

  const plan = planCodexInstall({ home: dir, nodePath: 'node', entry: '/e.js', now: 0 });
  applyCodexInstall(plan);
  const first = readFileSync(join(dir, '.codex', 'hooks.json'), 'utf8');
  const firstConfig = readFileSync(join(dir, '.codex', 'config.toml'), 'utf8');

  applyCodexInstall(planCodexInstall({ home: dir, nodePath: 'node', entry: '/e.js', now: 1 }));

  assert.equal(readFileSync(join(dir, '.codex', 'hooks.json'), 'utf8'), first);
  assert.equal(readFileSync(join(dir, '.codex', 'config.toml'), 'utf8'), firstConfig);
  rmSync(dir, { recursive: true, force: true });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test test/install-codex.test.ts`

Expected: FAIL — `Cannot find module '../src/install/codex.ts'`.

- [ ] **Step 3: Implement the Codex installer**

Create `src/install/codex.ts`:

```typescript
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { backupFile, backupStamp, writeFileAtomic } from './backup.ts';
import { withMeshHooks } from './hooks.ts';
import type { HookConfig } from './hooks.ts';
import { withMeshNote } from './note.ts';

export interface CodexInstallInput {
  home: string;
  nodePath: string;
  entry: string;
  now: number;
}

export interface CodexInstallPlan {
  present: boolean;
  hooksPath: string;
  configPath: string;
  instructionsPath: string;
  stamp: string;
  nodePath: string;
  entry: string;
}

export function codexPaths(home: string): {
  hooks: string;
  config: string;
  instructions: string;
} {
  return {
    hooks: join(home, '.codex', 'hooks.json'),
    config: join(home, '.codex', 'config.toml'),
    instructions: join(home, '.codex', 'AGENTS.md'),
  };
}

const FEATURES_HEADER = /^\[features\]\s*$/m;
const HOOKS_TRUE = /^\s*hooks\s*=\s*true\s*$/m;
const HOOKS_ANY = /^\s*hooks\s*=.*$/m;

/**
 * Codex runs no hooks at all without `[features] hooks = true`.
 *
 * Edited as text rather than parsed and re-serialized: Node has no TOML
 * writer, and a round-trip through one would reformat a file full of the
 * user's own settings. This touches one line and leaves everything else byte
 * for byte as it was.
 */
export function ensureCodexHooksFeature(toml: string): { text: string; changed: boolean } {
  const header = FEATURES_HEADER.exec(toml);

  if (!header) {
    const separator = toml.length === 0 || toml.endsWith('\n') ? '' : '\n';
    return { text: `${toml}${separator}\n[features]\nhooks = true\n`, changed: true };
  }

  const bodyStart = header.index + header[0].length;
  const rest = toml.slice(bodyStart);
  const nextHeader = /^\[/m.exec(rest);
  const bodyEnd = nextHeader ? bodyStart + nextHeader.index : toml.length;
  const body = toml.slice(bodyStart, bodyEnd);

  if (HOOKS_TRUE.test(body)) return { text: toml, changed: false };

  if (HOOKS_ANY.test(body)) {
    const fixed = body.replace(HOOKS_ANY, 'hooks = true');
    return { text: `${toml.slice(0, bodyStart)}${fixed}${toml.slice(bodyEnd)}`, changed: true };
  }

  return {
    text: `${toml.slice(0, bodyStart)}\nhooks = true${body}${toml.slice(bodyEnd)}`,
    changed: true,
  };
}

/**
 * Whether Codex has recorded the user's approval of this hooks file.
 *
 * Codex stores it as `[hooks.state."<path>:<event>:<i>:<j>"] trusted_hash`.
 * mesh only ever READS this: approving a hook is the user's decision, and
 * forging the entry would be mesh silently granting itself execution rights.
 */
export function codexHookTrustRecorded(toml: string, hooksPath: string): boolean {
  return toml.includes(`[hooks.state."${hooksPath}:`);
}

export function planCodexInstall(input: CodexInstallInput): CodexInstallPlan {
  const paths = codexPaths(input.home);
  return {
    present: existsSync(join(input.home, '.codex')),
    hooksPath: paths.hooks,
    configPath: paths.config,
    instructionsPath: paths.instructions,
    stamp: backupStamp(input.now),
    nodePath: input.nodePath,
    entry: input.entry,
  };
}

function readHookFile(path: string): Record<string, unknown> {
  if (!existsSync(path)) return {};
  const raw = readFileSync(path, 'utf8').trim();
  if (raw.length === 0) return {};
  try {
    const parsed = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      throw new Error('not an object');
    }
    return parsed as Record<string, unknown>;
  } catch (error) {
    throw new Error(
      `mesh init: could not parse ${path} (${(error as Error).message}). Fix or move it, then re-run.`,
    );
  }
}

/** Returns every path written, backups included. */
export function applyCodexInstall(plan: CodexInstallPlan): string[] {
  const written: string[] = [];

  const file = readHookFile(plan.hooksPath);
  const hooks = (file.hooks ?? {}) as HookConfig;
  const nextHooks = withMeshHooks(hooks, {
    nodePath: plan.nodePath,
    entry: plan.entry,
    // Measured 2026-07-27: Codex scrubs the environment it gives an MCP
    // server, and the hook otherwise defaults to provider "claude" — which is
    // how the Phase 3 demo journal ended up with a codex agent labelled claude.
    env: { MESH_PROVIDER: 'codex' },
    includeMatcher: false,
  });
  file.hooks = nextHooks;

  const nextText = `${JSON.stringify(file, null, 2)}\n`;
  const currentText = existsSync(plan.hooksPath) ? readFileSync(plan.hooksPath, 'utf8') : '';
  if (nextText !== currentText) {
    const backup = backupFile(plan.hooksPath, plan.stamp);
    if (backup) written.push(backup);
    writeFileAtomic(plan.hooksPath, nextText);
    written.push(plan.hooksPath);
  }

  const config = existsSync(plan.configPath) ? readFileSync(plan.configPath, 'utf8') : '';
  const feature = ensureCodexHooksFeature(config);
  if (feature.changed) {
    const backup = backupFile(plan.configPath, plan.stamp);
    if (backup) written.push(backup);
    writeFileAtomic(plan.configPath, feature.text);
    written.push(plan.configPath);
  }

  const instructions = existsSync(plan.instructionsPath)
    ? readFileSync(plan.instructionsPath, 'utf8')
    : '';
  const nextInstructions = withMeshNote(instructions);
  if (nextInstructions !== instructions) {
    const backup = backupFile(plan.instructionsPath, plan.stamp);
    if (backup) written.push(backup);
    writeFileAtomic(plan.instructionsPath, nextInstructions);
    written.push(plan.instructionsPath);
  }

  return written;
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --test test/install-codex.test.ts`

Expected: PASS, all eleven tests.

- [ ] **Step 5: Commit**

```bash
git add src/install/codex.ts test/install-codex.test.ts
git commit -m "Add the Codex installer, with the hooks feature flag and trust detection"
```

---

### Task 9: Register the MCP server through each host's own CLI

Both hosts ship `mcp add`. Using it means mesh never hand-writes TOML and never
has to track where a host keeps its MCP list.

**Files:**
- Create: `src/install/mcp.ts`
- Test: `test/install-mcp.test.ts`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces:
  - `CommandRunner = (command: string, args: string[]) => RunResult`
  - `RunResult { status: number | null; stdout: string; stderr: string }`
  - `defaultRunner: CommandRunner`
  - `claudeMcpArgs(nodePath: string, entry: string): string[]`
  - `codexMcpArgs(nodePath: string, entry: string): string[]`
  - `ensureMcpServer(input: { host: 'claude' | 'codex'; nodePath: string; entry: string; runner: CommandRunner }): McpRegistration`
  - `McpRegistration { host: 'claude' | 'codex'; ok: boolean; detail: string; manualCommand: string }`

- [ ] **Step 1: Write the failing tests**

Create `test/install-mcp.test.ts`:

```typescript
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { claudeMcpArgs, codexMcpArgs, ensureMcpServer } from '../src/install/mcp.ts';
import type { CommandRunner } from '../src/install/mcp.ts';

const ok = { status: 0, stdout: '', stderr: '' };

function recordingRunner(responses: Record<string, { status: number | null; stdout: string; stderr: string }>) {
  const calls: Array<{ command: string; args: string[] }> = [];
  const runner: CommandRunner = (command, args) => {
    calls.push({ command, args });
    return responses[args[1] ?? ''] ?? ok;
  };
  return { runner, calls };
}

test('claudeMcpArgs registers at user scope so every project sees mesh', () => {
  assert.deepEqual(claudeMcpArgs('/usr/bin/node', '/pkg/dist/cli/index.js'), [
    'mcp',
    'add',
    '--scope',
    'user',
    'mesh',
    '--',
    '/usr/bin/node',
    '/pkg/dist/cli/index.js',
    'mcp',
  ]);
});

test('codexMcpArgs declares the provider, because Codex scrubs the environment', () => {
  assert.deepEqual(codexMcpArgs('/usr/bin/node', '/pkg/dist/cli/index.js'), [
    'mcp',
    'add',
    'mesh',
    '--env',
    'MESH_PROVIDER=codex',
    '--',
    '/usr/bin/node',
    '/pkg/dist/cli/index.js',
    'mcp',
  ]);
});

test('ensureMcpServer adds the server and reports success', () => {
  const { runner, calls } = recordingRunner({ list: { status: 0, stdout: 'other-server\n', stderr: '' } });

  const result = ensureMcpServer({
    host: 'claude',
    nodePath: 'node',
    entry: '/e.js',
    runner,
  });

  assert.equal(result.ok, true);
  assert.equal(calls.some((call) => call.args[1] === 'remove'), false, 'nothing to remove');
  assert.ok(calls.some((call) => call.command === 'claude' && call.args[1] === 'add'));
});

test('ensureMcpServer repoints an existing mesh entry instead of failing', () => {
  const { runner, calls } = recordingRunner({ list: { status: 0, stdout: 'mesh: node /old\n', stderr: '' } });

  const result = ensureMcpServer({ host: 'codex', nodePath: 'node', entry: '/e.js', runner });

  assert.equal(result.ok, true);
  const order = calls.map((call) => call.args[1]);
  assert.deepEqual(order, ['list', 'remove', 'add'], 'remove then add, so a re-run repoints');
});

test('ensureMcpServer reports the manual command when the host CLI is missing', () => {
  const runner: CommandRunner = () => ({ status: null, stdout: '', stderr: 'ENOENT' });

  const result = ensureMcpServer({ host: 'claude', nodePath: 'node', entry: '/e.js', runner });

  assert.equal(result.ok, false);
  assert.match(result.detail, /claude/);
  assert.match(result.manualCommand, /claude mcp add --scope user mesh -- node \/e\.js mcp/);
});

test('ensureMcpServer reports a failing add with the host stderr', () => {
  const runner: CommandRunner = (_command, args) =>
    args[1] === 'add'
      ? { status: 1, stdout: '', stderr: 'server already exists' }
      : { status: 0, stdout: '', stderr: '' };

  const result = ensureMcpServer({ host: 'codex', nodePath: 'node', entry: '/e.js', runner });

  assert.equal(result.ok, false);
  assert.match(result.detail, /already exists/);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test test/install-mcp.test.ts`

Expected: FAIL — `Cannot find module '../src/install/mcp.ts'`.

- [ ] **Step 3: Implement MCP registration**

Create `src/install/mcp.ts`:

```typescript
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
      input.host === 'claude' ? ['mcp', 'remove', '--scope', 'user', 'mesh'] : ['mcp', 'remove', 'mesh'];
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
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --test test/install-mcp.test.ts`

Expected: PASS, all six tests.

- [ ] **Step 5: Commit**

```bash
git add src/install/mcp.ts test/install-mcp.test.ts
git commit -m "Register the MCP server through each host's own CLI"
```

---

### Task 10: `mesh init`

**Files:**
- Create: `src/cli/init.ts`
- Modify: `src/cli/index.ts`
- Test: `test/init.test.ts`

**Interfaces:**
- Consumes: `requireBuiltEntryPoint` (Task 6), `planClaudeInstall` / `applyClaudeInstall` (Task 7), `planCodexInstall` / `applyCodexInstall` / `codexHookTrustRecorded` (Task 8), `ensureMcpServer` / `defaultRunner` / `CommandRunner` (Task 9).
- Produces:
  - `runInit(options: InitOptions): InitResult`
  - `renderInitSummary(result: InitResult): string`
  - `InitOptions { home: string; nodePath: string; entry: string; now: number; dryRun: boolean; runner: CommandRunner }`
  - `InitResult { entry: string; dryRun: boolean; hosts: HostResult[] }`
  - `HostResult { host: 'claude' | 'codex'; present: boolean; written: string[]; mcp: McpRegistration | null; trustPending: boolean }`

- [ ] **Step 1: Write the failing tests**

Create `test/init.test.ts`:

```typescript
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runInit, renderInitSummary } from '../src/cli/init.ts';
import type { CommandRunner } from '../src/install/mcp.ts';

const okRunner: CommandRunner = () => ({ status: 0, stdout: '', stderr: '' });
const missingRunner: CommandRunner = () => ({ status: null, stdout: '', stderr: 'ENOENT' });

function homeWith(hosts: string[]): string {
  const dir = mkdtempSync(join(tmpdir(), 'mesh-init-'));
  for (const host of hosts) mkdirSync(join(dir, host));
  return dir;
}

test('runInit installs into every host that is present', () => {
  const home = homeWith(['.claude', '.codex']);

  const result = runInit({
    home,
    nodePath: 'node',
    entry: '/pkg/dist/cli/index.js',
    now: 0,
    dryRun: false,
    runner: okRunner,
  });

  assert.equal(result.hosts.length, 2);
  assert.ok(result.hosts.every((host) => host.present));
  assert.ok(existsSync(join(home, '.claude', 'settings.json')));
  assert.ok(existsSync(join(home, '.codex', 'hooks.json')));
  rmSync(home, { recursive: true, force: true });
});

test('runInit skips a host that is not installed', () => {
  const home = homeWith(['.claude']);

  const result = runInit({
    home,
    nodePath: 'node',
    entry: '/e.js',
    now: 0,
    dryRun: false,
    runner: okRunner,
  });

  const codex = result.hosts.find((host) => host.host === 'codex');
  assert.equal(codex?.present, false);
  assert.equal(codex?.written.length, 0);
  assert.equal(existsSync(join(home, '.codex')), false, 'mesh does not install Codex for you');
  rmSync(home, { recursive: true, force: true });
});

test('runInit writes nothing on a dry run', () => {
  const home = homeWith(['.claude', '.codex']);

  const result = runInit({
    home,
    nodePath: 'node',
    entry: '/e.js',
    now: 0,
    dryRun: true,
    runner: okRunner,
  });

  assert.equal(result.dryRun, true);
  assert.equal(existsSync(join(home, '.claude', 'settings.json')), false);
  assert.equal(existsSync(join(home, '.codex', 'hooks.json')), false);
  assert.ok(result.hosts.every((host) => host.mcp === null), 'a dry run runs no host commands');
  rmSync(home, { recursive: true, force: true });
});

test('runInit reports that Codex will ask the user to trust the hook', () => {
  const home = homeWith(['.codex']);

  const result = runInit({
    home,
    nodePath: 'node',
    entry: '/e.js',
    now: 0,
    dryRun: false,
    runner: okRunner,
  });

  const codex = result.hosts.find((host) => host.host === 'codex');
  assert.equal(codex?.trustPending, true, 'a fresh hooks.json has no recorded trust');
  rmSync(home, { recursive: true, force: true });
});

test('renderInitSummary names every file written and the next step', () => {
  const home = homeWith(['.claude', '.codex']);
  const result = runInit({
    home,
    nodePath: 'node',
    entry: '/e.js',
    now: 0,
    dryRun: false,
    runner: okRunner,
  });

  const out = renderInitSummary(result);
  assert.match(out, /settings\.json/);
  assert.match(out, /hooks\.json/);
  assert.match(out, /restart/i, 'a running agent does not pick up new hooks');
  assert.match(out, /trust/i, 'the Codex trust prompt is not a surprise');
  assert.doesNotMatch(out, /undefined/);
  rmSync(home, { recursive: true, force: true });
});

test('renderInitSummary prints the manual command when a host CLI is missing', () => {
  const home = homeWith(['.claude']);
  const result = runInit({
    home,
    nodePath: 'node',
    entry: '/e.js',
    now: 0,
    dryRun: false,
    runner: missingRunner,
  });

  const out = renderInitSummary(result);
  assert.match(out, /claude mcp add --scope user mesh/);
  rmSync(home, { recursive: true, force: true });
});

test('renderInitSummary labels a dry run as a dry run', () => {
  const home = homeWith(['.claude']);
  const result = runInit({
    home,
    nodePath: 'node',
    entry: '/e.js',
    now: 0,
    dryRun: true,
    runner: okRunner,
  });

  const out = renderInitSummary(result);
  assert.match(out, /dry run/i);
  assert.match(out, /would/i);
  rmSync(home, { recursive: true, force: true });
});

test('runInit is idempotent across repeated runs', () => {
  const home = homeWith(['.claude', '.codex']);
  const options = {
    home,
    nodePath: 'node',
    entry: '/e.js',
    now: 0,
    dryRun: false,
    runner: okRunner,
  };

  runInit(options);
  const first = readFileSync(join(home, '.claude', 'settings.json'), 'utf8');
  runInit({ ...options, now: 1 });
  const second = readFileSync(join(home, '.claude', 'settings.json'), 'utf8');

  assert.equal(second, first);
  rmSync(home, { recursive: true, force: true });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test test/init.test.ts`

Expected: FAIL — `Cannot find module '../src/cli/init.ts'`.

- [ ] **Step 3: Implement `mesh init`**

Create `src/cli/init.ts`:

```typescript
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
    // Codex will not run a hook it has not been told to trust, and recording
    // that approval is the user's decision, never mesh's.
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
      if (host.mcp?.ok) lines.push(`    mcp        registered`);
      if (host.mcp && !host.mcp.ok) {
        lines.push(`    mcp        FAILED — ${host.mcp.detail}`);
        lines.push(`               run this yourself: ${host.mcp.manualCommand}`);
      }
    }
    if (host.trustPending) {
      lines.push(
        '    trust      Codex will ask you to approve this hook the next time it starts.',
        '               Until you do, it runs no hooks and mesh cannot enforce claims.',
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
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --test test/init.test.ts`

Expected: PASS, all eight tests.

- [ ] **Step 5: Wire the command in**

In `src/cli/index.ts`, add the command function after `cmdDoctor`:

```typescript
async function cmdInit(args: string[]): Promise<number> {
  const { runInit, renderInitSummary } = await import('./init.ts');
  const { requireBuiltEntryPoint } = await import('../install/entry.ts');
  const { defaultRunner } = await import('../install/mcp.ts');
  const { homedir } = await import('node:os');

  let entry: string;
  try {
    entry = requireBuiltEntryPoint();
  } catch (error) {
    process.stderr.write(`${(error as Error).message}\n`);
    return 1;
  }

  try {
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
```

Add the case to `main`'s switch, before `case 'doctor':`:

```typescript
    case 'init':
      return cmdInit(argv.slice(3));
```

And put this line at the top of the command list in `USAGE`:

```
  mesh init       Wire mesh into Claude Code and Codex (--dry-run to preview)
```

- [ ] **Step 6: Verify the command end to end, without writing anything**

Run: `npm run build && node src/cli/index.ts init --dry-run`

Expected: a summary naming the `dist/cli/index.js` entry point, both hosts, and
"Re-run without --dry-run to apply." No files change.

- [ ] **Step 7: Commit**

```bash
git add src/cli/init.ts src/cli/index.ts test/init.test.ts
git commit -m "Add mesh init"
```

---

### Task 11: Teach `mesh doctor` what Phase 5 added

`mesh doctor` currently looks for the literal string `mesh hook` in a settings
file. A real install writes an absolute path to `dist/cli/index.js`, so after a
successful `mesh init` doctor would report "not installed" — the check has to
test for the entry point it actually writes.

**Files:**
- Modify: `src/cli/doctor.ts`
- Modify: `test/cli.test.ts:37-68` (both `renderDoctor` tests)
- Test: `test/cli.test.ts` (append)

**Interfaces:**
- Consumes: `distEntryPoint` (Task 6), `codexHookTrustRecorded`, `codexPaths` (Task 8), `CommandRunner`, `defaultRunner` (Task 9).
- Produces: `DoctorReport` gains `distBuilt: boolean`, `distPath: string`, `claudeMcpRegistered: boolean`, `codexMcpRegistered: boolean`, `codexHooksTrusted: boolean`, `codexVersion: string | null`. `collectDoctorReport(runner?: CommandRunner)` takes an optional runner.

- [ ] **Step 1: Write the failing tests**

First update the two existing `renderDoctor` tests in `test/cli.test.ts` — they
construct a `DoctorReport` literal and will not typecheck once the interface
grows. In the healthy-environment test at line 37, add to the object:

```typescript
    distBuilt: true,
    distPath: '/pkg/dist/cli/index.js',
    claudeMcpRegistered: true,
    codexMcpRegistered: true,
    codexHooksTrusted: true,
    codexVersion: 'codex-cli 0.145.0',
```

In the problem-reporting test at line 53, add:

```typescript
    distBuilt: false,
    distPath: '/pkg/dist/cli/index.js',
    claudeMcpRegistered: false,
    codexMcpRegistered: false,
    codexHooksTrusted: false,
    codexVersion: null,
```

Then append these tests:

```typescript
test('renderDoctor flags an unbuilt dist, which makes every tool call slower', () => {
  const out = renderDoctor({
    nodeVersion: 'v25.8.1',
    nodeOk: true,
    daemonReachable: true,
    socketPath: '/s',
    claudeHooksInstalled: true,
    codexHooksInstalled: true,
    codexSpikeRecorded: true,
    distBuilt: false,
    distPath: '/pkg/dist/cli/index.js',
    claudeMcpRegistered: true,
    codexMcpRegistered: true,
    codexHooksTrusted: true,
    codexVersion: 'codex-cli 0.145.0',
  });
  assert.match(out, /npm run build/);
});

test('renderDoctor flags a Codex hook the user has not trusted yet', () => {
  const out = renderDoctor({
    nodeVersion: 'v25.8.1',
    nodeOk: true,
    daemonReachable: true,
    socketPath: '/s',
    claudeHooksInstalled: true,
    codexHooksInstalled: true,
    codexSpikeRecorded: true,
    distBuilt: true,
    distPath: '/pkg/dist/cli/index.js',
    claudeMcpRegistered: true,
    codexMcpRegistered: true,
    codexHooksTrusted: false,
    codexVersion: 'codex-cli 0.145.0',
  });
  assert.match(out, /trust/i);
  assert.match(out, /enforce/i, 'says what is lost until it is trusted');
});

test('renderDoctor reports the Codex version, since hook behavior is version-measured', () => {
  const out = renderDoctor({
    nodeVersion: 'v25.8.1',
    nodeOk: true,
    daemonReachable: true,
    socketPath: '/s',
    claudeHooksInstalled: true,
    codexHooksInstalled: true,
    codexSpikeRecorded: true,
    distBuilt: true,
    distPath: '/pkg/dist/cli/index.js',
    claudeMcpRegistered: true,
    codexMcpRegistered: true,
    codexHooksTrusted: true,
    codexVersion: 'codex-cli 0.145.0',
  });
  assert.match(out, /0\.145\.0/);
});

test('renderDoctor names mesh init when the MCP server is not registered', () => {
  const out = renderDoctor({
    nodeVersion: 'v25.8.1',
    nodeOk: true,
    daemonReachable: true,
    socketPath: '/s',
    claudeHooksInstalled: true,
    codexHooksInstalled: true,
    codexSpikeRecorded: true,
    distBuilt: true,
    distPath: '/pkg/dist/cli/index.js',
    claudeMcpRegistered: false,
    codexMcpRegistered: false,
    codexHooksTrusted: true,
    codexVersion: null,
  });
  assert.match(out, /mcp/i);
  assert.match(out, /mesh init/);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test test/cli.test.ts`

Expected: FAIL — the new tests report missing output lines; `npm run typecheck`
additionally reports the extra properties until `DoctorReport` grows.

- [ ] **Step 3: Extend the report**

Rewrite `src/cli/doctor.ts`:

```typescript
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { meshPaths } from '../paths.ts';
import { MeshClient } from '../client.ts';
import { distEntryPoint } from '../install/entry.ts';
import { codexHookTrustRecorded, codexPaths } from '../install/codex.ts';
import { defaultRunner } from '../install/mcp.ts';
import type { CommandRunner } from '../install/mcp.ts';

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
  const codex = codexPaths(home);
  const codexConfig = existsSync(codex.config) ? readFileSync(codex.config, 'utf8') : '';

  return {
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

  lines.push(
    report.codexHooksTrusted
      ? '  codex trust      ok        the hook is approved'
      : '  codex trust      PENDING   Codex asks once on next launch; until then it runs no hooks and mesh cannot enforce claims',
  );

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
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --test test/cli.test.ts && npm run typecheck`

Expected: PASS, and `tsc` prints nothing.

- [ ] **Step 5: See it against the real machine**

Run: `node src/cli/index.ts doctor`

Expected: a full report. Before `mesh init` has ever run, the hook and MCP lines
read "not installed" / "not registered" — which is the point of Task 13.

- [ ] **Step 6: Commit**

```bash
git add src/cli/doctor.ts test/cli.test.ts
git commit -m "Report build, MCP registration, and Codex trust from mesh doctor"
```

---

### Task 12: Ship compiled, and write the README

**Files:**
- Modify: `package.json`
- Create: `README.md`
- Test: `test/package.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: no exports. `package.json` `bin.mesh` becomes `./dist/cli/index.js`.

- [ ] **Step 1: Write the failing test**

Create `test/package.test.ts`:

```typescript
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));

test('the published binary is the compiled entry point', () => {
  // Measured: 64ms p95 from dist, ~105ms from TypeScript source, on a path
  // that runs before every tool call.
  assert.equal(pkg.bin.mesh, './dist/cli/index.js');
});

test('the package ships dist and the README, not the TypeScript sources', () => {
  assert.ok(pkg.files.includes('dist'));
  assert.ok(pkg.files.includes('README.md'));
  assert.equal(pkg.files.includes('src'), false);
});

test('installing the package builds it', () => {
  assert.equal(pkg.scripts.prepare, 'npm run build');
});

test('the hook never imports the MCP SDK or zod', () => {
  // The same guard the Phase 2 test enforces, restated here because Phase 5
  // moved the CLI's imports around.
  const hook = readFileSync(join(root, 'src', 'hook.ts'), 'utf8');
  assert.doesNotMatch(hook, /modelcontextprotocol/);
  assert.doesNotMatch(hook, /from 'zod'/);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test test/package.test.ts`

Expected: FAIL — `bin.mesh` is `./src/cli/index.ts` and `files` is absent.

- [ ] **Step 3: Update package.json**

In `package.json`, replace the `bin` block and add `files`, and add `prepare` to
`scripts`:

```json
  "bin": {
    "mesh": "./dist/cli/index.js"
  },
  "files": [
    "dist",
    "README.md"
  ],
  "scripts": {
    "test": "node --test 'test/**/*.test.ts'",
    "typecheck": "tsc --noEmit",
    "build": "rm -rf dist && tsc -p tsconfig.build.json",
    "prepare": "npm run build",
    "bench:hook": "node scripts/bench-hook.mjs"
  },
```

- [ ] **Step 4: Verify the built binary runs**

Run: `npm run build && node dist/cli/index.js doctor`

Expected: the doctor report, from compiled JavaScript. If it fails on an import
extension, `rewriteRelativeImportExtensions` in `tsconfig.build.json` is doing
its job for `.ts` imports — check that no new module imports a `.mjs` or a path
without an extension.

- [ ] **Step 5: Write the README**

Create `README.md`:

````markdown
# mesh

Two coding agents in two terminal windows, working on one project, cannot see
each other. They overwrite each other's files and the only channel between them
is you, copy-pasting.

mesh makes them peers. They see each other, talk to each other, and are
**hard-blocked** from editing files another agent has claimed. Claude Code and
Codex, in any terminal — no PTY ownership, no screen scraping.

```
$ mesh who
workspace: leadops-v2

  claude-1  frontend  working  2s    Edit app/page.tsx
  codex-2   backend   working  14s   Bash npm test
```

## What it does

| | |
|---|---|
| **See** | `mesh_who` lists the other agents and what each is doing right now |
| **Talk** | `mesh_send` for one-way, `mesh_ask` to block on an answer from a peer |
| **Not collide** | `mesh_claim` takes a path; another agent's write to it is denied, not warned about |

A blocked edit reads like this, and is written for the agent to act on:

```
BLOCKED by mesh: server/api/leads.ts is claimed exclusively by codex-2
(matched "server/**", active 4s ago). Do not edit it. Either mesh_ask codex-2
to make the change, or run `mesh release --force "server/**"` if codex-2 has
been abandoned.
```

## Install

Requires Node 22.6 or newer.

```bash
npm install
npm run build
node dist/cli/index.js init
mesh doctor
```

`mesh init` writes hooks into `~/.claude/settings.json` and
`~/.codex/hooks.json`, registers the MCP server with each host's own
`mcp add`, and appends a short usage note to each host's instructions file.
It backs up every file before touching it and is safe to re-run — a second run
repoints, it does not duplicate. Preview it first with `mesh init --dry-run`.

Then **restart your agents.** A running session keeps the hooks it started with.

**Codex asks once.** Codex will not run a hook it has not been told to trust,
so the first launch after `mesh init` prompts you to approve it. Until you do,
Codex runs no hooks and mesh cannot enforce claims there. `mesh doctor` shows
the trust state.

## Commands

| Command | Purpose |
|---|---|
| `mesh init` | Wire mesh into Claude Code and Codex. `--dry-run` to preview |
| `mesh watch` | Live view: agents, questions in flight, claims held |
| `mesh who` | One-shot snapshot |
| `mesh claims` | Who has claimed what |
| `mesh release --force <pattern>` | Break a stuck claim |
| `mesh doctor` | Node, build, daemon, hooks, MCP registration, Codex trust |
| `mesh log` | Tail the daemon journal |

## How it works

```
  Claude Code window            Codex window
  ┌──────────────────┐          ┌──────────────────┐
  │  mesh mcp (stdio)│          │  mesh mcp (stdio)│   ← the agent acts
  │  mesh hook       │          │  mesh hook       │   ← the agent sees, and is policed
  └────────┬─────────┘          └────────┬─────────┘
           │      unix socket, JSONL     │
           └────────────┬────────────────┘
                        ▼
                 ┌─────────────┐
                 │    meshd    │  registry · claims · mailboxes · asks
                 └─────────────┘
```

The MCP server is how an agent acts. The hook is how it sees and how it is
policed: `PreToolUse` injects anything addressed to that agent, and returns a
deny decision when the tool would write to a claimed path. One daemon arbitrates,
because two agents claiming the same path in the same millisecond is exactly the
race mesh exists to prevent.

Agents are scoped to a workspace — the git root, else the cwd. Agents in
different workspaces cannot see each other.

## Two honest limitations

**An idle agent cannot be reached.** Injection rides the hook, and hooks only
fire when an agent runs a tool. A question sent to an agent sitting at its prompt
is queued, not delivered, and `mesh_ask` says `queued` rather than pretending
otherwise. `mesh watch` shows the unanswered count so you can nudge that window.

**The hook costs ~64ms per tool call.** About 50ms of that is the Node startup
floor. `npm run bench:hook` fails above 90ms so it cannot silently regress.

## Failure behavior

mesh must never break a working agent. Socket missing, daemon down, malformed
response, unexpected exception — the hook exits 0 and the agent proceeds exactly
as it would without mesh installed.

## Development

```bash
npm test            # unit, integration over a real socket, and hook contract
npm run typecheck
npm run build
npm run bench:hook  # fails above 90ms p95
```

Measured host behavior lives in `spikes/*/FINDINGS.md` — read those before
changing anything about hooks or identity. Design and plans are in `docs/`.
````

- [ ] **Step 6: Run the tests**

Run: `node --test test/package.test.ts && npm test`

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add package.json README.md test/package.test.ts
git commit -m "Ship the compiled entry point, and document mesh"
```

---

### Task 13: Verify Phase 5 against real agents, and update the handoff

Every claim in this task must be backed by output you actually saw. Do not mark
a step complete from expectation.

**Files:**
- Modify: `HANDOFF.md`

**Interfaces:**
- Consumes: everything above.
- Produces: no exports.

- [ ] **Step 1: Run the full gate**

Run: `npm test && npm run typecheck && npm run build && npm run bench:hook`

Expected: all tests pass, `tsc` silent, build succeeds, and the bench prints
`OK: within the 90ms budget.` with a compiled p95 at or below ~64ms. If the p95
has grown, find out what the hook started importing before continuing.

- [ ] **Step 2: Preview the install, then apply it**

```bash
node dist/cli/index.js init --dry-run
node dist/cli/index.js init
node dist/cli/index.js doctor
```

Expected: the dry run changes nothing. The real run lists a backup for every
pre-existing file it edited. `mesh doctor` then reports `claude hooks ok`,
`claude mcp ok`, `codex hooks ok`, `codex mcp ok`, and `build ok`. `codex trust`
reads `PENDING` until Codex is launched and the hook approved — that is correct,
not a failure.

If `claude hooks` still reads "not installed" after a successful init, the
doctor entry-point check (Task 11) and the command `mesh init` wrote disagree —
compare `~/.claude/settings.json` against `node -e "…distEntryPoint()"`.

- [ ] **Step 3: Prove the double registration is fixed, with a real agent**

```bash
node dist/cli/index.js watch --once
claude -p "list the files in the current directory" </dev/null
node dist/cli/index.js who
```

Expected: `mesh who` shows **exactly one** agent for that session, not two. This
is the Phase 5 acceptance criterion. Note the `</dev/null` — a headless agent
left holding stdin waits forever.

Before the fix this printed two rows, one named from the host's session id and
one named `pid-<n>`. If you still see two, the registry reconciliation is not
being reached: check that both registrations carry the same `pid`, by reading
`~/.mesh/journal.jsonl`.

- [ ] **Step 4: Watch it live**

Run: `node dist/cli/index.js watch`

Expected: with an agent running in another window, the agent's row updates as it
works, and the claims table reflects `mesh claims`. Ctrl-C exits cleanly and
leaves the terminal usable.

- [ ] **Step 5: Update HANDOFF.md**

In `HANDOFF.md`, change the Phases list so 5 reads:

```markdown
- **5 — `mesh init`, `mesh watch`, README** ✅
```

Replace the whole "Phase 5's two known jobs" section with:

```markdown
## Resolved in Phase 5

1. **Hooks point at `dist/`.** `mesh init` writes the compiled entry point and
   refuses to run if `dist/` is missing. `package.json` `bin` and `files` ship
   compiled, and `prepare` builds on install.
2. **Double registration is fixed**, and the handoff's premise was wrong.
   **Measured 2026-07-27** (`spikes/session-identity/FINDINGS.md`): Claude Code
   **does** export `CLAUDE_CODE_SESSION_ID` to its MCP servers, equal to the
   hook's `session_id`. Codex exports nothing and scrubs the MCP server's
   environment entirely. On both hosts the hook and the MCP server share a ppid
   — the host process — so the daemon reconciles a provisional `pid-<n>` id
   with the real one by `(workspaceRoot, pid)`. The per-pid-file option was
   dropped; it is unnecessary.

   **Trap:** a Codex session launched from a Claude session inherits
   `CLAUDE_CODE_SESSION_ID`. It is only trusted when the provider is Claude.
```

Then add a new section after it:

```markdown
## Open for Phase 6

- **Codex hook trust is a manual step.** `mesh init` cannot approve its own
  hook; Codex prompts once on next launch and `mesh doctor` reports the state.
  Anyone testing enforcement on Codex must approve it first, or hooks silently
  do not run.
- **MCP tools for claims are still not exposed.** `mesh_claim` / `mesh_release`
  have daemon ops and CLI commands but no tool surface, so an agent cannot yet
  claim a path itself. Phase 6 needs this before a real cross-vendor run.
- **Phase 4 (task delegation) remains unbuilt** — spec'd in
  `docs/superpowers/specs/2026-07-25-mesh-design.md`, no plan written.
```

Finally, update the header line's test count to the number `npm test` actually
printed in Step 1.

- [ ] **Step 6: Commit**

```bash
git add HANDOFF.md
git commit -m "Mark Phase 5 complete and record what Phase 6 inherits"
```

---

## Self-review notes

Checked against `docs/superpowers/specs/2026-07-25-mesh-design.md` and the
Phase 5 section of `HANDOFF.md`.

**Spec coverage.** `mesh init` (Task 10, backed by 6–9), `mesh watch` (Task 5),
README (Task 12), latency benchmark (already exists; re-gated in Task 13). The
two known jobs from the handoff are Tasks 2–4 and 12.

**Deliberately out of scope.** `mesh board` and `mesh assign` appear under
Phase 5 in the spec's build order but belong to Phase 4's task delegation, which
is not built — there is no task store to render. They stay unbuilt, and the
handoff update in Task 13 says so.

**A daemon `subscribe` op is not built.** The spec mentions server-pushed frames
for `mesh watch`; polling `who` and `claims` on an interval gives a human TUI
the same result with no new protocol surface. If a future consumer needs push,
that is the moment to add it.

**One event pair, not four.** `mesh init` installs `SessionStart` and
`PreToolUse` only. `PostToolUse` reports nothing `PreToolUse` has not already
reported, and every installed event costs another ~64ms process on the user's
critical path. Phase 4 adds `Stop` when it has a reminder to deliver there.
