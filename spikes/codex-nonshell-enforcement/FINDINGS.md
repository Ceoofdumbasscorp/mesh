# Codex non-shell edit enforcement — Phase 3 findings

**Status: RESOLVED. No gap. Enforcement covers Codex's non-shell edit path.**

**Date:** 2026-07-26
**Codex version:** codex-cli 0.145.0

## Question

Phase 0 established, from OpenAI's own `migrate-to-codex` converter, that Codex
`PreToolUse` / `PostToolUse` "currently run for shell commands only". That
raised a real worry for Phase 3: if Codex edits a file through `apply_patch`
rather than a shell, does the hook fire at all, and is a deny honored? If not,
mesh's claim enforcement would be silently partial on Codex.

## Observed

A claim-holding deny was installed, then Codex was asked to change a file
**without** being told to use the shell.

```
hook fired 3 times:
  {"event":"PreToolUse","tool":"apply_patch", ...}
  {"event":"PreToolUse","tool":"apply_patch", ...}
  {"event":"PreToolUse","tool":"Bash",        ...}

hook: PreToolUse Blocked   (x3)
target.txt still contains: original
```

- **`PreToolUse` fires for `apply_patch`**, not only for shell commands.
- The deny was **honored on every path**.
- Codex tried `apply_patch` twice, was blocked, **fell back to a shell command**,
  was blocked again, and then stopped rather than finding a way around.
- The file was never modified.

## Conclusion

**Enforcement covers this path.** The converter's "shell commands only" note is
narrower than the behavior of Codex 0.145 — `apply_patch` is surfaced to
`PreToolUse` as a tool in its own right, with `tool_name: "apply_patch"`.

The fallback behavior is worth noting on its own: a blocked agent does not
simply fail, it looks for another route. Both routes being covered is what makes
the block actually hold.

## Consequence for mesh

- Claim enforcement on Codex is **hard and complete** for both `apply_patch` and
  shell-mediated writes. The Phase 3 risk is retired.
- The Claude side was already verified in Phase 0 from shipped plugin code.
- Caveat worth keeping: this was measured on 0.145. `PreToolUse` coverage is a
  Codex implementation detail, not a documented guarantee, so `mesh doctor`
  should surface the Codex version and this file should be re-run after a major
  Codex upgrade.
- **A gap in mesh's own code, found by this spike and fixed the same day.**
  `WRITE_TOOLS` listed only `Write`, `Edit`, `MultiEdit`, and `NotebookEdit`,
  so the hook would have skipped the check entirely on `apply_patch` — Codex's
  *first* choice of edit tool. mesh would have looked like it was enforcing
  while quietly ignoring the most common Codex write path.

  Fixed: `apply_patch` is in `WRITE_TOOLS`, and path extraction now parses the
  `*** Update File:` / `*** Add File:` / `*** Delete File:` envelope. A single
  patch can touch several files, so every path is checked and one claimed file
  blocks the whole call. The envelope is scanned across *all* string fields of
  `tool_input` rather than one key name, because the key is an undocumented
  Codex implementation detail that could change between releases.
