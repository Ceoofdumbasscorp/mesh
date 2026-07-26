# mesh — cross-agent collaboration for terminal coding agents

**Status:** design approved 2026-07-25
**Supersedes:** the Constellation Links feature in `~/Projects/jarvis-os` (`desktop/constellation.js`)

## Problem

Two coding agents running in two terminal windows on the same project cannot see or talk to
each other. Concretely, today:

- **Blindness.** A Claude Code session has no idea a Codex session exists, what it is working
  on, or which files it has open.
- **Collision.** Both agents edit the same file. The second write silently destroys the first.
  Neither agent knows it happened.
- **Manual relay.** When the frontend agent needs to know whether the backend accepts a partial
  payload, the only channel is the human copy-pasting between windows.

Sub-agents solve this *within* one session. Nothing solves it *between* sessions, and nothing
solves it across vendors — Claude Code on the frontend, Codex on the backend.

## Goals

1. An agent can enumerate the other agents on the project and see what each is doing.
2. An agent can ask another agent a question and block on the answer, in-turn, without human
   involvement.
3. An agent is prevented — not merely advised — from editing a file another agent has claimed.
4. Works with unmodified Claude Code and Codex, in any terminal host (plain Terminal, cmux,
   NEXORA, iTerm, VS Code). No PTY ownership, no screen scraping.
5. Never breaks the user's agents. Every failure mode degrades to "agents behave as they do
   today."

## Non-goals (v1)

- No cross-machine mesh. Single host only.
- No shared context or transcript sync. Agents exchange messages, not memory.
- No task assignment, planning, or orchestration. mesh is a communication substrate; deciding
  who does what stays with the human or a higher layer.
- No GUI. `mesh watch` is a terminal UI. NEXORA may later render the mesh, but consumes it as a
  client like anything else.

## Why not extend the NEXORA broker

`desktop/constellation.js` works by scraping PTY stdout for an `@@nexora{...}@@` sentinel. It is
proven (102 tests, verified Claude↔Codex round-trip) but structurally limited:

- It only sees agents whose PTY NEXORA itself spawned. A Claude session in cmux can never join.
- Roughly half its code is ANSI/TUI hardening — treating `\r` as a line boundary, expanding
  `ESC[nG`/`ESC[nC` cursor jumps to spaces, 30s payload dedupe against TUI repaints. All of that
  exists solely because the transport is a rendered screen.

Using MCP and hooks gives us a structured transport, which deletes that entire class of problem.

**What ports over:** the agent naming scheme (`claude-1`, `codex-2`), link decay, and the
injected-clock (`now`) testing pattern.
**What is deleted:** every line of ANSI parsing.

## Verified platform facts

These were confirmed against the local install, not assumed.

| Capability | Claude Code | Codex 0.145 |
|---|---|---|
| MCP stdio servers | yes (`.claude.json` `mcpServers`) | yes (`config.toml` `[mcp_servers.*]`) |
| Hooks enabled | yes (`settings.json` `hooks`) | yes (`[features] hooks = true`, `~/.codex/hooks.json`) |
| Hook config schema | `{event: [{matcher, hooks:[...]}]}` | same shape |
| `PreToolUse` fires | yes | yes (cmux ships `cmux-codex-hook-pre-tool-use.sh`) |
| Inject via `additionalContext` | **yes, verified** | **unverified — spike required** |
| Deny via `permissionDecision` | **yes, verified** | **unverified — spike required** |

Evidence for the Claude column:

- `plugins/cache/claude-plugins-official/vercel/0.44.0/hooks/pretooluse-skill-inject.mjs` emits
  `{hookSpecificOutput: {hookEventName: "PreToolUse", additionalContext}}` in shipped production
  code. `PreToolUse` injection is real.
- `plugins/marketplaces/claude-plugins-official/plugins/plugin-dev/skills/hook-development/SKILL.md`
  documents the `PreToolUse` output as
  `{hookSpecificOutput: {permissionDecision: "allow|deny|ask", updatedInput}, systemMessage}`.
- The user's own `settings.json` `SessionStart` hook already injects `additionalContext` today.

The Vercel plugin's `hooks/compat.mjs` (`detectPlatform` / `formatOutput`) demonstrates the
pattern for emitting per-host output shapes — Claude's camelCase `hookSpecificOutput` vs Cursor's
snake_case `additional_context` / `permission`. mesh adopts the same layered approach and adds a
Codex adapter.

**Codex enforcement is the single largest open risk and is resolved by a Phase 0 spike, before
any other code is written.** If Codex ignores deny decisions, Codex degrades to advisory
(warning injected, edit proceeds) while Claude retains hard blocking. The design remains valid
either way; only the guarantee weakens on one side.

## Architecture

Four components, one process boundary.

```
  Claude Code window            Codex window
  ┌──────────────────┐          ┌──────────────────┐
  │  mesh mcp (stdio)│          │  mesh mcp (stdio)│   ← agent acts
  │  mesh hook       │          │  mesh hook       │   ← agent sees + is policed
  └────────┬─────────┘          └────────┬─────────┘
           │      unix socket, JSONL     │
           └────────────┬────────────────┘
                        ▼
                 ┌─────────────┐
                 │    meshd    │  registry · claims · mailboxes · asks · feed
                 └──────┬──────┘
                        │
                 ┌──────▼──────┐
                 │ mesh watch  │  human TUI
                 └─────────────┘
```

### 1. `meshd` — daemon

One per machine. Unix domain socket `~/.mesh/mesh.sock` (mode 0600). Auto-spawns on first
client connect and exits after 30 minutes with no connected agents, so the user never manages a
lifecycle.

Authoritative state, all in memory:

| Store | Contents |
|---|---|
| registry | agent id, name, role, provider, workspace, pid, status, last-seen |
| claims | glob pattern → holder, mode, granted-at, expires-at |
| mailboxes | per-agent queue of undelivered messages |
| asks | pending question → asker, target, deadline, resolution |
| feed | ring buffer, last 500 activity events per workspace |

Durability is a single append-only `~/.mesh/journal.jsonl` used for crash recovery and `mesh log`.
State is small and cheap to rebuild; the journal is a debugging asset first and a recovery
mechanism second.

*Why a daemon rather than shared files:* claim arbitration must be atomic. Two agents claiming
`server/**` in the same millisecond is exactly the race mesh exists to prevent, and a
single-writer process makes it a non-issue. Blocking asks additionally need sub-second wakeups.

### 2. `mesh mcp` — the agent's hands

A stdio MCP server, one process per agent session, spawned by the host from its existing MCP
config. This is the only channel through which an agent *acts*.

| Tool | Behavior |
|---|---|
| `mesh_who` | List agents on this workspace: name, role, status, current file, idle time |
| `mesh_ask` | Send a question to a name or role; **block** until answered or timeout |
| `mesh_reply` | Answer a pending question addressed to this agent |
| `mesh_send` | Fire-and-forget message to one agent or broadcast; returns immediately |
| `mesh_inbox` | Drain queued messages and unanswered questions addressed to this agent |
| `mesh_claim` | Claim glob patterns, `shared` or `exclusive`, with a TTL |
| `mesh_release` | Release claims held by this agent |
| `mesh_feed` | Recent cross-agent activity, on demand |

Identity is established at MCP startup: the server registers with the daemon using host-provided
session id and cwd, and receives its assigned name.

### 3. `mesh hook` — the agent's eyes, and the enforcement point

A single small command wired into `settings.json` and `~/.codex/hooks.json`. Two jobs:

- **Report.** `SessionStart` registers the agent. `PostToolUse` and `Stop` report what it touched
  and whether it went idle. This is what makes `mesh_who` answers real rather than self-declared.
- **Inject and enforce.** `PreToolUse` returns `additionalContext` carrying items addressed to
  this agent, and returns `permissionDecision: "deny"` when the tool targets a path claimed
  exclusively by another live agent.

Per the approved awareness model, injection is **high-signal only**: pending questions, direct
messages, and claim conflicts on paths this agent is touching. The full activity feed is pulled
via `mesh_feed`, never pushed.

#### Latency budget — the fast path

`PreToolUse` runs before *every* tool call. A naive socket round-trip per call would tax the
entire session. Design:

1. The daemon maintains `~/.mesh/<workspace>/<agent>.flag` — a tiny file whose mtime/size changes
   only when that agent has something pending.
2. The hook `stat`s that file first (~1ms). **If nothing is pending and the tool is not a write,
   the hook exits 0 immediately with no IPC at all.**
3. The daemon mirrors the claim table to `~/.mesh/<workspace>/claims.json`. Claims change rarely,
   so write-tool enforcement is a small local file read, not a round-trip.
4. The socket is used only for actual delivery, claim mutations, and blocking asks.

Acceptance criterion: **p95 added latency < 30ms on the no-traffic path, < 80ms overall.** Measured
by a benchmark in CI, not by assertion. If Node process startup proves too costly, an optional
prebuilt native shim is a later optimization, not a v1 requirement.

**Fail-open is absolute.** Socket missing, daemon down, connect exceeding 100ms, malformed
response, unexpected exception — the hook exits 0 and the agent proceeds exactly as it would
without mesh installed. mesh must never be capable of bricking a working agent.

### 4. `mesh` — the human surface

| Command | Purpose |
|---|---|
| `mesh init` | Write hook + MCP config into Claude and Codex; idempotent; backs up first |
| `mesh watch` | Live TUI: agents present, current activity, claims held, messages in flight |
| `mesh who` | One-shot snapshot |
| `mesh log` | Tail the journal |
| `mesh release --force <pattern>` | Break a stuck claim |
| `mesh doctor` | Verify hooks installed, daemon reachable, per-host capability matrix |

## Identity and scoping

- **Names:** `claude-1`, `codex-2`, `fable-3` — provider plus a per-provider counter, ported from
  `constellation.js`.
- **Roles:** optional free-text (`frontend`, `backend`, `tests`), set by the user or self-declared.
  `mesh_ask` accepts a name or a role; a role resolves to its single holder, or errors if ambiguous.
- **Workspace:** git root, else cwd. Agents in different workspaces are mutually invisible. One
  daemon serves many workspaces.

## Wire protocol

Newline-delimited JSON over the Unix socket. Request/response with an `id` for correlation, plus
server-pushed frames on subscriptions (`mesh watch`).

```
→ {"id":1,"op":"register","provider":"claude","session":"c7cb…","cwd":"/Users/k/Projects/leadops-v2","role":"frontend"}
← {"id":1,"ok":true,"name":"claude-1","workspace":"leadops-v2"}

→ {"id":2,"op":"claim","patterns":["app/**"],"mode":"exclusive","ttl":900}
← {"id":2,"ok":true,"granted":["app/**"],"conflicts":[]}

→ {"id":3,"op":"ask","to":"backend","body":"does POST /leads accept a partial payload?","timeout":90}
← {"id":3,"ok":true,"state":"answered","from":"codex-2","body":"no — email required. adding optional now","elapsed_ms":12400}
```

Every op is small, synchronous, and independently testable.

## Claim semantics

- **Modes:** `shared` (many holders, informational) and `exclusive` (one holder, enforced).
- **Granularity:** glob patterns matched against workspace-relative paths.
- **Overlap:** an exclusive claim conflicts with any existing exclusive claim whose pattern
  intersects it. Intersection is computed conservatively — if mesh cannot prove two globs are
  disjoint, it treats them as overlapping and refuses.
- **TTL:** default 15 minutes, refreshed by any hook report from the holder. An actively working
  agent never loses its claims; a stalled one lets them lapse.
- **Liveness:** the MCP stdio connection is the heartbeat. When it drops, the agent is dead and its
  claims are released after a 30-second grace period.
- **Auto-downgrade:** if a holder is alive but idle beyond the TTL, enforcement degrades from
  `deny` to a warning rather than wedging the other agent.
- **Escape hatch:** `mesh release --force`. The denial message always names the holder, the
  holder's idle time, and this exact command.

Denial text is written for the agent to act on, not just to fail:

```
BLOCKED by mesh: server/api/leads.ts is claimed exclusively by codex-2 (active, 4m).
Do not edit it. Either mesh_ask codex-2 to make the change, or run
`mesh release --force "server/api/**"` if codex-2 is abandoned.
```

## Ask protocol and failure modes

| Situation | Behavior |
|---|---|
| Target working | Question injected on target's next `PreToolUse`; typical answer 5–30s |
| Target idle at prompt | **No hook fires, so no injection is possible.** `mesh_ask` returns `queued` immediately with the reason. The message waits in the inbox and is delivered the moment the target acts. `mesh watch` surfaces the unanswered count so the human can nudge. |
| Target absent or dead | Returns `undeliverable` immediately. Never burns the timeout. |
| Timeout elapsed | Returns `timeout` with elapsed time; the question stays queued and may still be answered later via the inbox |
| Mutual ask (A→B while B→A) | Daemon detects the cycle in the pending-ask graph and **fails the second ask instantly**: "deadlock — codex-2 is already waiting on you; answer that first." |
| Reply storm | Per-agent rate limit (default 10 asks/min) and a max chain depth of 5 |

The idle case is the honest limitation of a hooks-based transport and is documented as such.
Blocking asks work well in the actual target scenario — two agents both mid-task — and degrade
cleanly rather than hanging. PTY-level injection for hosts that own the terminal (NEXORA, cmux)
is a possible v2 enhancement, explicitly out of scope here.

## Security

- Socket mode 0600, owner-only. mesh is a local developer tool; any process running as the user is
  trusted.
- Message bodies capped at 4KB, matching `constellation.js`.
- Messages are inert data. Nothing received over the mesh is ever executed, and injected content is
  clearly fenced and attributed so an agent treats it as a report from a peer, not as user
  instruction.
- `mesh init` backs up `settings.json` and `hooks.json` before modifying them, and is idempotent.

## Testing strategy

Mirrors what worked for `constellation.js`, which reached 102 passing tests including real-PTY
e2e.

1. **Unit, injected clock.** Claim overlap and arbitration, TTL expiry, deadlock detection,
   mailbox routing, name assignment, glob intersection. Pure functions over a fake `now` — no
   timers, no sleeps.
2. **Integration, real socket.** Real daemon, scripted fake clients. Concurrent claim races,
   agent death mid-claim, journal crash recovery, ask timeout and deadlock paths.
3. **Hook contract.** Feed recorded Claude and Codex hook payloads to `mesh hook` and assert the
   exact emitted JSON per host. Guards against silent host schema drift.
4. **Latency benchmark.** Asserts the p95 budget above. A test, not a hope.
5. **End-to-end, real agents.** Headless `claude -p` and `codex exec` with mesh wired in:
   a real cross-vendor ask round-trip, and a real blocked write. This is the acceptance bar —
   the same bar the NEXORA verification met on 2026-07-19.

## Stack

Node 20+, TypeScript, `@modelcontextprotocol/sdk`, `node:test`. Node because the MCP SDK is
first-class there, `constellation.js` ports directly, and `npx mesh` is a one-line install for
users. Zero runtime dependencies in the hook fast path — `node:net` and `node:fs` only.

## Build order

**Phase 0 — De-risk (blocking).** Spike Codex hook I/O: does it honor `permissionDecision` deny,
and what output shape does it accept for context injection? Everything downstream assumes an
answer. Nothing else starts until this is settled and written down.

**Phase 1 — Daemon and registry.** Socket, protocol, registry, journal, `mesh who`, `mesh doctor`.
Agents become visible to each other.

**Phase 2 — Messaging.** MCP server, `mesh_send`/`mesh_inbox`, hook injection, then `mesh_ask`/
`mesh_reply` with timeout and deadlock handling. Agents can talk.

**Phase 3 — Claims and enforcement.** Claim table, glob intersection, TTL and liveness,
`PreToolUse` deny, force-release. Agents stop colliding.

**Phase 4 — Product surface.** `mesh init`, `mesh watch` TUI, README, latency benchmark.

**Phase 5 — Acceptance.** Real Claude↔Codex e2e on a real project.

Each phase is independently useful and independently shippable. Phase 1 alone already beats the
status quo.

## Open risks

| Risk | Mitigation |
|---|---|
| Codex ignores deny decisions | Phase 0 spike. Falls back to advisory on Codex; Claude keeps hard blocking. |
| Host hook schemas drift | Contract tests per host; `mesh doctor` reports the live capability matrix. |
| Hook startup cost too high | Fast path avoids IPC entirely; benchmark gates it; native shim available as a later optimization. |
| Agents ignore the tools | Injected context is directive and `mesh init` adds a short usage note to the agent's instructions. |
| Stale claim wedges the user | TTL + connection-liveness + idle auto-downgrade + `--force`, with the command named in every denial. |
