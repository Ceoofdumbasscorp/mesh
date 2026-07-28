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
