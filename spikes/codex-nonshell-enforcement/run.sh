#!/bin/bash
# Phase 3 spike. Answers the open question Phase 0 raised: Codex's PreToolUse
# "currently runs for shell commands only" (per OpenAI's own migrate-to-codex
# converter). So what fires when Codex edits a file WITHOUT a shell?
#
# Same config approach as the Phase 0 spike: install the probe hook into the
# real ~/.codex/hooks.json and restore it via trap. stdin is redirected from
# /dev/null because `codex exec` otherwise waits on it forever.
set -uo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
PROBE="$HERE/../codex-hook-capability/probe.mjs"
HOOKS="$HOME/.codex/hooks.json"
BACKUP="$HOME/.codex/hooks.json.phase3-backup"
WORK="$(mktemp -d /tmp/mesh-p3.XXXXXX)"
LOG="$WORK/probe.log"
: > "$LOG"

[ -f "$BACKUP" ] || cp "$HOOKS" "$BACKUP"
trap 'cp "$BACKUP" "$HOOKS"; echo; echo "restored $HOOKS"' EXIT INT TERM

cat > "$HOOKS" <<EOF
{"hooks":{"PreToolUse":[{"hooks":[{"type":"command","command":"MESH_PROBE_MODE=denyMinimal MESH_PROBE_LOG=$LOG node $PROBE","timeout":10}]}]}}
EOF

echo "workdir: $WORK"
echo "original" > "$WORK/target.txt"
echo "seeded target.txt with: original"

# Deliberately does NOT say "use the shell". If Codex edits via apply_patch,
# PreToolUse may never fire and the deny never lands.
codex exec --enable hooks --dangerously-bypass-hook-trust --skip-git-repo-check \
  --ephemeral -s danger-full-access -c approval_policy="never" \
  -c model_reasoning_effort="low" -C "$WORK" \
  'Change the contents of target.txt from "original" to "modified". Do it now.' \
  </dev/null >"$WORK/out.txt" 2>&1

echo "--- hook fired: $(wc -l < "$LOG" | tr -d ' ') time(s) ---"
[ -s "$LOG" ] && cut -c1-200 "$LOG"
echo "--- how Codex performed the edit ---"
grep -iE "apply_patch|^exec |/bin/zsh|hook: PreToolUse" "$WORK/out.txt" | head -6
echo "--- file now contains ---"
cat "$WORK/target.txt"
echo "--- was the deny honored? ---"
if grep -q "^original$" "$WORK/target.txt"; then
  echo "RESULT: file UNCHANGED -> the deny WAS enforced on this edit path"
else
  echo "RESULT: file MODIFIED  -> this edit path BYPASSES PreToolUse enforcement"
fi
echo "workdir retained: $WORK"
