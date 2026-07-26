#!/bin/bash
# Phase 0 spike runner. Each mode is one question, asked in isolation.
#
# Sandbox note: we grant danger-full-access and approval_policy=never on
# purpose. The question is whether the HOOK blocks the write, so every other
# possible blocker must be off — otherwise a sandbox refusal reads as a
# successful hook deny, which would be exactly the wrong conclusion.
set -uo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
PROBE="$HERE/probe.mjs"
WORK="$(mktemp -d /tmp/mesh-spike.XXXXXX)"
export MESH_PROBE_LOG="$WORK/probe.log"

echo "workdir: $WORK"
echo "codex:   $(codex --version)"

run_mode () {
  local mode="$1" prompt="$2"
  echo
  echo "=== mode: $mode ==="
  rm -f "$WORK/target.txt" "$MESH_PROBE_LOG" "$WORK/last.txt"
  : > "$MESH_PROBE_LOG"

  # No `timeout` here: macOS ships no such binary (it is gtimeout from
  # coreutils). Callers bound the runtime instead.
  MESH_PROBE_MODE="$mode" codex exec \
    --enable hooks \
    --dangerously-bypass-hook-trust \
    --skip-git-repo-check \
    --ephemeral \
    -s danger-full-access \
    -c approval_policy="never" \
    -c model_reasoning_effort="low" \
    -C "$WORK" \
    -o "$WORK/last.txt" \
    -c "hooks.PreToolUse=[{hooks=[{type=\"command\",command=\"MESH_PROBE_MODE=$mode MESH_PROBE_LOG=$MESH_PROBE_LOG node $PROBE\"}]}]" \
    "$prompt" >"$WORK/$mode.out" 2>&1

  echo "exit: $?"
  echo "--- hook fired: $(wc -l < "$MESH_PROBE_LOG" 2>/dev/null | tr -d ' ') time(s) ---"
  [ -s "$MESH_PROBE_LOG" ] && cut -c1-200 "$MESH_PROBE_LOG"
  echo "--- last message ---"
  [ -f "$WORK/last.txt" ] && head -c 400 "$WORK/last.txt"
  echo
  if [ -f "$WORK/target.txt" ]; then
    echo "RESULT: target.txt EXISTS -> write was NOT blocked"
  else
    echo "RESULT: target.txt ABSENT -> write was blocked (or never attempted)"
  fi
  if grep -q "PLATYPUS7" "$WORK/last.txt" "$WORK/$mode.out" 2>/dev/null; then
    echo "SECRET: PLATYPUS7 present -> injection reached the model"
  else
    echo "SECRET: absent"
  fi
}

WRITE_PROMPT='Run exactly this shell command and nothing else: echo hello > target.txt'
ECHO_PROMPT='Run the shell command: ls. Then tell me the secret word if you were given one in your context. If you were not given a secret word, say NONE.'

run_mode observe      "$WRITE_PROMPT"
run_mode denyClaude   "$WRITE_PROMPT"
run_mode denyCursor   "$WRITE_PROMPT"
run_mode denyBare     "$WRITE_PROMPT"
run_mode injectClaude "$ECHO_PROMPT"
run_mode injectCursor "$ECHO_PROMPT"

echo
echo "workdir retained for inspection: $WORK"
