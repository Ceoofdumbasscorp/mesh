# mesh — current state and how to resume

Read this first after a `/clear`. Everything below is verified, not aspirational.

**Repo:** `~/Projects/mesh` · **Branch:** `phase-0-1-daemon` · **208 tests passing**, typecheck clean.

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
- **5 — `mesh init`, `mesh watch`, README** — **not built. This is what makes it usable daily.**

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

## Phase 5's two known jobs

1. **Point hooks at `dist/`, not `src/`** — worth 40ms on every tool call.
2. **Fix double registration.** The MCP server isn't told the host's session id and falls back to
   `pid-<ppid>`, so one agent can register twice.

   **Measured 2026-07-26:** Claude Code passes **no** session-id environment variable to MCP
   servers — a live server's environment had zero `CLAUDE_*` / `SESSION_*` / `MCP_*` vars. So
   `MESH_SESSION_ID` cannot simply be read from the environment. Remaining options, in order of
   promise: reconcile daemon-side by `(workspaceRoot, pid)` once the ppid relationship between the
   hook and the MCP server is measured; or have the `SessionStart` hook write the session id to a
   per-pid file the MCP server reads. **Measure the ppid relationship first** — that decides it.

## Resuming

```bash
cd ~/Projects/mesh
npm test && npm run typecheck && npm run build && npm run bench:hook
```

Then write the Phase 5 plan (`superpowers:writing-plans`) and execute it. The three existing plans
in `docs/superpowers/plans/` are the format to follow.
