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

```
mcp   env.CLAUDE_CODE_SESSION_ID = 697d0b40-2c88-46cf-b80c-8f9c766ebcb4
hook  payload.session_id         = 697d0b40-2c88-46cf-b80c-8f9c766ebcb4
```

> This corrects the note in HANDOFF.md dated 2026-07-26, which reported that a
> live MCP server's environment held zero `CLAUDE_*` variables. It does not.

**2. Codex exports nothing, and scrubs the environment.**

The Codex MCP server's environment contained **none** of the `CLAUDE_*` /
`CODEX_*` variables — while the hook, spawned by the same process moments
later, inherited all of them:

```
mcp   env = {}
hook  env = { CLAUDE_CODE_SESSION_ID: …, CMUX_CODEX_PID: …, … }
```

Codex gives an MCP server only what its config declares. Consequence: anything
mesh's server needs under Codex must be written into the `env` table by
`mesh init`, and a session id cannot come from there at all.

**3. The hook and the MCP server are children of the same process, on both hosts.**

| Host | MCP server pid → ppid | Hook pid → ppid |
|---|---|---|
| Claude Code | 45658 → **45605** | 45665 → **45605** |
| Codex | 45940 → **45866** | 46288 → **45866** |

No shell sits between the host and the hook — even for a command carrying an
env prefix (`PROBE_OUT=… node …`), which the shell exec's away. So
`process.ppid` is the host process on both sides, and `(workspaceRoot, pid)` is
a sound reconciliation key on both hosts.

**The per-pid file option is unnecessary.** Do not build it.

## The trap

A Codex session launched from inside a Claude session **inherits**
`CLAUDE_CODE_SESSION_ID` from the ambient environment. In the run above, the
Codex hook carried the *outer Claude session's* id while its payload
`session_id` was a Codex UUIDv7:

```
hook  env.CLAUDE_CODE_SESSION_ID = 0bfc5e4b-7478-4588-b886-6a164c75f728  ← the outer Claude session
hook  payload.session_id         = 019fa641-d988-73c3-93d6-cd14292e37c1  ← the actual Codex session
```

Reading that variable unconditionally would fuse two different agents into one.
**Only trust it when the provider is Claude.**

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
- Codex resolves `command = "node"` itself, but a hook's PATH is not the
  shell's — `mesh init` writes an absolute node path for hooks.
