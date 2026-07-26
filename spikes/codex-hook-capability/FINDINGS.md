# Codex hook capability — Phase 0 findings

**Status: INCOMPLETE.** The deny/inject questions are still unanswered. Two real
findings landed along the way and are recorded below. Do not build Phase 3
enforcement on assumptions until this is finished.

**Date:** 2026-07-25
**Codex version:** codex-cli 0.145.0
**Host:** macOS 24.6.0, Node v25.8.1

## What is settled

### 1. Codex hooks fire in `codex exec`

Confirmed. A plain headless run prints hook lifecycle to stdout:

```
hook: SessionStart
hook: SessionStart Completed
```

That is the user's existing `~/.codex/hooks.json` (`herdr-agent-state.sh`) firing
during `codex exec`. So hooks are live in non-interactive mode, and **Codex
announces each hook event on stdout** — a convenient observation channel we did
not expect to get for free.

Note: the `--dangerously-bypass-hook-trust` warning appeared even on an
invocation that did not pass the flag, so something in the ambient environment
or config already enables it. Worth pinning down before `mesh init` reasons
about hook trust.

### 2. A hook must never read stdin blockingly — deadlock

**This is a production constraint, not a spike artifact.**

The first probe used `readFileSync(0, 'utf8')`. Codex holds the hook's stdin pipe
open without closing it, so the synchronous read never returns; Codex then waits
on the hook, and the run hangs forever. Two 4–5 minute timeouts before the cause
was clear.

Fix applied in `probe.mjs`: read stdin asynchronously with a deadline
(`MESH_PROBE_STDIN_MS`, default 400ms) and proceed regardless of whether EOF
arrives.

**Consequence for mesh:** the `mesh hook` shim must use a bounded async stdin
read. A blocking read would hang the user's agent — the exact failure mode the
fail-open rule exists to prevent. Add a regression test for this in the Phase 2
hook contract tests.

## What is unresolved

Passing `PreToolUse` config inline via
`-c "hooks.PreToolUse=[{hooks=[{type=\"command\",command=\"...\"}]}]"`
produced a run that hung with **zero** hook invocations logged, even after the
stdin fix. The probe log stayed empty, so the hook likely never executed at all.

Leading hypotheses, in order of suspicion:

1. **TOML parsing of the inline value.** `-c` parses the value as TOML; the
   nested array-of-tables with an embedded quoted command may not survive shell
   plus TOML quoting. The SessionStart entry in `~/.codex/hooks.json` uses the
   same schema, so writing the config to a **file** instead of passing it inline
   sidesteps this entirely and is the next thing to try.
2. **`PreToolUse` may not be a valid Codex event name.** cmux ships a script
   named `cmux-codex-hook-pre-tool-use.sh`, but its registration is via
   `cmux hooks codex pre-tool-use`, which does not prove the config key is
   `PreToolUse`. Enumerate the accepted event names first.
3. Combining `-c hooks.*` with an existing `~/.codex/hooks.json` may replace
   rather than merge, in a way that breaks the config.

## Next steps

1. Write the hook config to a temp `hooks.json` and point Codex at it with
   `CODEX_HOME`, instead of the inline `-c` form. Verify `PreToolUse` fires at
   all before testing any output shape.
2. If `PreToolUse` is not a recognized event, find the real name — check
   `codex debug`, the Codex docs, or the strings in the installed binary.
3. Only once the hook demonstrably fires on a tool call, run the four deny modes
   and two inject modes in `run.sh`.

## Consequence for mesh so far

- Claim enforcement on Codex: **still unknown.** Phase 3 must not assume hard
  blocking on the Codex side until this is answered.
- Claude side: unaffected, and already verified from shipped plugin code.
- Hook shim design: **changed.** Bounded async stdin read is now mandatory.
