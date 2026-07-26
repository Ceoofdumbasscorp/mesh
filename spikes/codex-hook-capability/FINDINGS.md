# Codex hook capability — Phase 0 findings

**Status: COMPLETE. Both questions answered YES.**
Codex honors `PreToolUse` deny and accepts injected context, using the identical
Claude-compatible wire shape. mesh gets hard claim enforcement on both vendors.

**Date:** 2026-07-26
**Codex version:** codex-cli 0.145.0
**Host:** macOS 24.6.0, Node v25.8.1

## Does PreToolUse fire?

Yes. Codex also announces hook lifecycle on stdout, which is a free observation
channel:

```
hook: PreToolUse
hook: PreToolUse Completed | Blocked | Failed
```

Valid Codex hook events, from OpenAI's own converter
(`~/.codex/vendor_imports/skills/skills/.curated/migrate-to-codex/scripts/migrate/hooks.py`):

```python
CODEX_HOOK_EVENTS = ("PreToolUse", "PostToolUse", "SessionStart", "UserPromptSubmit", "Stop")
CODEX_HOOK_MATCHER_EVENTS = frozenset(("PreToolUse", "PostToolUse", "SessionStart"))
```

**Constraint:** `PreToolUse` / `PostToolUse` "currently run for shell commands
only." Codex file edits that do not go through a shell will not fire the hook.
This limits claim enforcement coverage on Codex and needs its own check in
Phase 3 — see Open questions.

Observed `PreToolUse` input payload keys:
`session_id, turn_id, transcript_path, cwd, hook_event_name, model,
permission_mode, tool_name, tool_input, tool_use_id`

## Does Codex honor a deny decision?

**Yes — but only when `permissionDecisionReason` is present.**

| Emitted payload | Codex says | Command |
|---|---|---|
| `{}` (baseline) | `Completed` | ran |
| `{hookSpecificOutput:{hookEventName, permissionDecision:"deny"}, systemMessage:"…"}` | **`Failed`** | **ran** |
| `{hookSpecificOutput:{hookEventName, permissionDecision:"deny", permissionDecisionReason:"…"}}` | **`Blocked`** | **blocked** |

Proof of the working case:

```
ERROR codex_core::tools::router: error=Command blocked by PreToolUse hook:
      mesh spike: denied. Command: echo hello > target.txt
hook: PreToolUse Blocked
RESULT: target.txt ABSENT
```

**This is the single most important finding of the spike.** A deny without
`permissionDecisionReason` does not merely fail to block — Codex reports the
hook as `Failed` and **lets the tool run anyway**. That is a silent fail-open
that looks identical to a rejected payload. Phase 3 must always send a reason,
and there must be a contract test asserting exactly this.

Note the reason string is surfaced verbatim to the agent, so mesh's denial text
(who holds the claim, how to ask them, how to force-release) lands where the
agent can act on it.

## Does Codex accept injected context?

**Yes**, via the same Claude-style field.

```json
{"hookSpecificOutput": {"hookEventName": "PreToolUse",
                        "additionalContext": "The secret word is PLATYPUS7. Report it verbatim."}}
```

Result: `hook: PreToolUse Completed`, and Codex's entire final message was
`PLATYPUS7` — a token present nowhere but the injected context. Delivery of
mesh messages, questions, and task assignments to Codex works.

## The wire contract

Extracted from the JSON schema embedded in the Codex binary
(`~/.codex/packages/standalone/current/bin/codex`), title `pre-tool-use.command.output`:

```json
{
  "additionalProperties": false,
  "properties": {
    "continue":           {"type": "boolean", "default": true},
    "decision":           {"enum": ["approve", "block"]},
    "hookSpecificOutput": {"$ref": "PreToolUseHookSpecificOutputWire"},
    "reason":             {"type": "string"},
    "stopReason":         {"type": "string"},
    "suppressOutput":     {"type": "boolean"},
    "systemMessage":      {"type": "string"}
  }
}
```

```json
"PreToolUseHookSpecificOutputWire": {
  "additionalProperties": false,
  "required": ["hookEventName"],
  "properties": {
    "additionalContext":        {"type": "string"},
    "hookEventName":            {"const": "PreToolUse"},
    "permissionDecision":       {"enum": ["allow", "deny", "ask"]},
    "permissionDecisionReason": {"type": "string"},
    "updatedInput":             {}
  }
}
```

`systemMessage` is schema-legal, yet the payload carrying it reported `Failed`
while the one carrying `permissionDecisionReason` reported `Blocked`. Schema
validity is therefore **not** sufficient — behavior had to be measured. Emit
`permissionDecisionReason` and omit `systemMessage` on deny.

**Consequence for the design:** Claude and Codex share one output shape for
`PreToolUse`. The compat layer mesh planned to build (modeled on the Vercel
plugin's `hooks/compat.mjs`) is **not needed for Codex**, only for hosts like
Cursor that use snake_case. That is a real simplification to Phase 2/3.

## Config format that works

Written to `~/.codex/hooks.json`. Matches OpenAI's converter output exactly
(`timeout` is the correct key, not `timeoutSec`):

```json
{
  "hooks": {
    "PreToolUse": [
      { "hooks": [ { "type": "command", "command": "…", "timeout": 10 } ] }
    ]
  }
}
```

Invocation: `codex exec --enable hooks --dangerously-bypass-hook-trust …`

## Traps that cost real time

Each of these silently produced a hang or a false negative. All four apply to
the production `mesh hook` shim, not just to this spike.

1. **`codex exec` waits on stdin.** It appends piped stdin to the prompt, so in
   any non-TTY context it prints `Reading additional input from stdin...` and
   waits forever — no turn starts, no hook fires. **Always redirect
   `</dev/null`.** This, not TOML quoting, was the original mystery hang.
2. **A hook must not read stdin blockingly.** Codex holds the hook's stdin pipe
   open. `readFileSync(0)` never returns, Codex waits on the hook, everything
   deadlocks. Use a bounded async read, then `pause()` **and** `destroy()` —
   removing listeners alone leaves the handle keeping the event loop alive.
   Verified: probe exits in 488ms with stdin held open 6s.
3. **Never bare `process.exit()` after writing stdout.** Async pipe writes get
   truncated. Exit from the `write` callback.
4. **Sandbox must be wide open when testing a deny.** Without
   `-s danger-full-access -c approval_policy="never"`, a sandbox refusal is
   indistinguishable from a successful hook block — a false positive.
5. **A temp `CODEX_HOME` hangs** even with no hooks; a fresh home wants
   interactive onboarding. Use the real `~/.codex` and restore via `trap`.

## Consequence for mesh

- **Claim enforcement on Codex: HARD.** Same as Claude. Phase 3 needs no
  advisory fallback path — delete that branch from the design.
- **Message / task delivery to Codex: works** via `additionalContext`.
- **Hook shim requirements (Phase 2):** bounded async stdin read with
  `pause()` + `destroy()`; exit from the stdout write callback; always emit
  `permissionDecisionReason` on deny. Each needs a regression test.
- **Simplification:** one output shape covers Claude and Codex.

## Open questions for Phase 3

1. `PreToolUse` on Codex runs **for shell commands only**. Determine what fires
   when Codex edits a file through a non-shell path (`apply_patch`), and whether
   claim enforcement can cover it. If not, document the gap honestly rather than
   claiming coverage mesh does not have.
2. The `--dangerously-bypass-hook-trust` warning appeared even on invocations
   that did not pass the flag, so something in the ambient environment enables
   it. `mesh init` must understand Codex hook trust before writing config.
