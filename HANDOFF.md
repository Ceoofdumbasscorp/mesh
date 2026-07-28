# mesh — current state and how to resume

Read this first after a `/clear`. Everything below is verified, not aspirational.

**Repo:** `~/Projects/mesh` · **Branch:** `phase-0-1-daemon` · **293 tests passing**, typecheck clean,
hook 64ms p95 compiled.

## What mesh is

Multiple **full peer** agent sessions (Claude Code, Codex) working in one project can see each
other, talk to each other, and are hard-blocked from editing each other's claimed files. Peers,
not sub-agents. Works in any terminal host.

## What works today (all live-demonstrated, not just unit-tested)

| Capability | Proof |
|---|---|
| Agents see each other | `mesh who` lists live activity across sessions |
| One-way messages | Injected into the peer's context on its next tool call |
| Blocking ask/reply | Full round-trip over a real socket, ~2.5ms |
| **Hard file blocking** | `permissionDecision: deny` with an actionable reason |
| Deadlock refusal | A→B→C→A caught at creation, not hung |

Demonstrated denial text:

```
BLOCKED by mesh: server/api/leads.ts is claimed exclusively by codex-1
(matched "server/**", active 0s ago). Do not edit it. Either mesh_ask codex-1
to make the change, or run `mesh release --force "server/**"` if codex-1 has
been abandoned.
```

## Phases

- **0 — Codex capability spike** ✅ `spikes/codex-hook-capability/FINDINGS.md`
- **1 — Daemon, registry, `mesh who`/`doctor`/`log`** ✅
- **2 — Mailbox, blocking ask, MCP server, hook shim** ✅
- **3 — Claims, glob matching, hard enforcement** ✅
- **4 — Task delegation** (`mesh_assign`, `mesh board`) — spec'd, **not built**
- **5 — `mesh init`, `mesh watch`, README** ✅ `docs/superpowers/plans/2026-07-27-mesh-phase-5-product-surface.md`

## Documents, in reading order

1. `docs/superpowers/specs/2026-07-25-mesh-design.md` — the design, with measured facts and a live risk table
2. `spikes/codex-hook-capability/FINDINGS.md` — Codex hook contract + four traps that cost real time
3. `spikes/codex-nonshell-enforcement/FINDINGS.md` — `apply_patch` coverage
4. `docs/superpowers/plans/` — three executed plans, one per phase

## Hard-won facts — do not re-derive these

**Codex hook contract (measured on codex-cli 0.145.0):**
- A deny **must** carry `permissionDecisionReason`. Without it Codex reports the hook `Failed`
  and **runs the tool anyway** — a silent fail-open. Never emit `systemMessage` alongside a deny.
- Claude and Codex share one output shape. No per-host compat layer needed.
- `PreToolUse` fires for `apply_patch` as well as shell commands. Codex reaches for `apply_patch`
  **first** and falls back to a shell when blocked, so both paths must be enforced.

**Hook performance:**
- Node startup floor ~50ms. TypeScript type-stripping adds ~40ms. Builtins cost ~0.
- Compiled `dist/` = **64ms p95**; from `src/` = ~105ms. **Ship compiled.**
- Importing the MCP SDK costs +50ms, so the hook imports neither it nor zod. A test enforces this.
- `npm run bench:hook` fails above 90ms.

**Traps (all cost real debugging time):**
- `codex exec` waits forever on unclosed stdin — always redirect `</dev/null`.
- A hook must never read stdin blockingly; Codex holds the pipe open. Use a bounded async read,
  then `pause()` **and** `destroy()`.
- Never bare `process.exit()` after writing stdout — it truncates. Exit from the write callback.
- When testing a deny, the sandbox must be wide open, or a sandbox refusal looks like a hook block.
- A temp `CODEX_HOME` hangs; use the real one and restore via `trap`.

**Architecture invariants:**
- `register` takes `own: true`. Only an owning connection's close unregisters the agent. The MCP
  server sets it; **the hook must not** — it reconnects on every tool call.
- Pure state modules (`registry`, `mailbox`, `asks`, `claims`) take an injected `Clock` and create
  no timers. All real timers live in `daemon/waiters.ts`.
- Glob intersection is conservative: overlapping unless *provably* disjoint.
- The hook never autostarts the daemon. The MCP server owns daemon startup.

## Resolved in Phase 5

1. **Hooks point at `dist/`.** `mesh init` writes the compiled entry point and refuses to run if
   `dist/` is missing. `package.json` `bin` and `files` ship compiled, and `prepare` builds on
   install.
2. **Double registration is fixed, and this file's previous premise was wrong.**
   **Measured 2026-07-27** (`spikes/session-identity/FINDINGS.md`, reproduce with its `run.sh`):
   Claude Code **does** export `CLAUDE_CODE_SESSION_ID` to its MCP servers, equal to the hook's
   `session_id`. Codex exports nothing and scrubs the MCP server's environment entirely. On both
   hosts the hook and the MCP server share a ppid — the host process — so the daemon reconciles a
   provisional `pid-<n>` id with the real one by `(workspaceRoot, pid)`. The per-pid-file option
   was dropped; it is unnecessary.

   **Trap:** a Codex session launched from a Claude session inherits `CLAUDE_CODE_SESSION_ID`. It
   is only trusted when the provider is Claude.

   Verified live on both hosts: Claude registers once under its real id; Codex registers twice
   (`pid-55468` from the MCP server, a UUIDv7 from the hook) and the daemon merges them into one
   `codex-1`.

## More hard-won facts

- **The compiled package could not start its own daemon.** `client.ts` hardcoded `daemon/main.ts`,
  which from `dist/` resolves to a file that does not exist. The spawn is detached with stdio
  ignored, so it failed silently and surfaced only as `mesh: could not reach or start the daemon`.
  Every test ran from `src/`, where the `.ts` file exists, so the suite stayed green while the
  shipped artifact was dead. `daemonEntryPoint()` now matches its own extension, and
  `test/package.test.ts` asks the **compiled** client what it would spawn.
- **`mesh doctor` must look for the entry point it actually writes.** It used to grep for the
  literal string `mesh hook`, which a real install never writes, so a correct install reported as
  missing.
- **Codex hook trust is per event.** `[hooks.state."<hooks.json>:<event>:<i>:<j>"]` carries a
  `trusted_hash` mesh cannot compute, so mesh only reads it — and must scope the check to the
  events it installs. Matching the file alone reported another tool's trusted `SessionStart` hook
  as mesh's approval.
- **Codex session ids are opaque.** Usually a UUIDv7, but one run reported a slug
  (`codex-mesh-who-once`). mesh treats the id as an opaque string and must keep doing so.

## Open for Phase 6

- **Codex hook trust is a manual step.** `mesh init` cannot approve its own hook; Codex prompts
  once on next launch and `mesh doctor` reports the state. Anyone testing enforcement on Codex must
  approve it first, or hooks silently do not run.
- **MCP tools for claims are still not exposed.** `mesh_claim` / `mesh_release` have daemon ops and
  CLI commands but no tool surface, so an agent cannot yet claim a path itself. Phase 6 needs this
  before a real cross-vendor run.
- **Phase 4 (task delegation) remains unbuilt** — spec'd in
  `docs/superpowers/specs/2026-07-25-mesh-design.md`, no plan written. `mesh board` / `mesh assign`
  belong to it, not to Phase 5.

## Resuming

```bash
cd ~/Projects/mesh
npm test && npm run typecheck && npm run build && npm run bench:hook
```

`mesh init` has **not** been run against this machine's real `~/.claude` / `~/.codex` yet — Phase 5
was verified with per-invocation config instead (`--settings` / `--mcp-config` for Claude, `-c` for
Codex), so nothing global was modified. Run `node dist/cli/index.js init --dry-run` first.
