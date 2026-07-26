#!/bin/bash
# Phase 0 spike runner. Each mode is one question, asked in isolation.
#
# Config path: this installs the probe hook into the REAL ~/.codex/hooks.json
# and restores it on exit via trap. Two alternatives were tried and rejected:
#   - inline `-c hooks.PreToolUse=[...]`: hook never fired (TOML/shell quoting)
#   - a temp CODEX_HOME: hangs even with no hooks at all, since a fresh home
#     wants interactive onboarding
# Using the real file is also the faithful test, because it is the same path
# `mesh init` will write to.
#
# Sandbox note: danger-full-access and approval_policy=never are deliberate.
# The question is whether the HOOK blocks the write, so every other possible
# blocker must be off — otherwise a sandbox refusal reads as a successful hook
# deny, which is exactly the wrong conclusion.
#
# macOS has no `timeout` binary, so each run gets a background watchdog.
#
# stdin MUST be closed (</dev/null). `codex exec` appends piped stdin to the
# prompt, so in any non-TTY context it prints "Reading additional input from
# stdin..." and waits forever — no turn starts and no hook ever fires.
set -uo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
PROBE="$HERE/probe.mjs"
HOOKS="$HOME/.codex/hooks.json"
BACKUP="$HOME/.codex/hooks.json.mesh-spike-backup"
WORK="$(mktemp -d /tmp/mesh-spike.XXXXXX)"
RUN_TIMEOUT="${MESH_SPIKE_TIMEOUT:-150}"

if [ ! -f "$BACKUP" ]; then cp "$HOOKS" "$BACKUP"; fi
restore () { cp "$BACKUP" "$HOOKS"; echo; echo "restored $HOOKS"; }
trap restore EXIT INT TERM

echo "workdir: $WORK"
echo "codex:   $(codex --version)"

install_hook () {
  local mode="$1" log="$2"
  cat > "$HOOKS" <<EOF
{
  "hooks": {
    "PreToolUse": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "MESH_PROBE_MODE=$mode MESH_PROBE_LOG=$log node $PROBE",
            "timeout": 10
          }
        ]
      }
    ]
  }
}
EOF
}

run_mode () {
  local mode="$1" prompt="$2"
  local log="$WORK/$mode.log"
  echo
  echo "=== mode: $mode ==="
  rm -f "$WORK/target.txt" "$WORK/last.txt"
  : > "$log"
  install_hook "$mode" "$log"

  codex exec \
    --enable hooks \
    --dangerously-bypass-hook-trust \
    --skip-git-repo-check \
    --ephemeral \
    -s danger-full-access \
    -c approval_policy="never" \
    -c model_reasoning_effort="low" \
    -C "$WORK" \
    -o "$WORK/last.txt" \
    ${MESH_SPIKE_JSON:+--json} \
    "$prompt" </dev/null >"$WORK/$mode.out" 2>&1 &
  local pid=$!
  ( sleep "$RUN_TIMEOUT"; kill -TERM "$pid" 2>/dev/null ) &
  local watchdog=$!
  wait "$pid" 2>/dev/null
  local code=$?
  kill "$watchdog" 2>/dev/null

  echo "exit: $code"
  echo "--- hook fired: $(wc -l < "$log" 2>/dev/null | tr -d ' ') time(s) ---"
  [ -s "$log" ] && cut -c1-220 "$log"
  echo "--- tail of run ---"
  tail -12 "$WORK/$mode.out" 2>/dev/null
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

for mode in "$@"; do
  case "$mode" in
    inject*) run_mode "$mode" "$ECHO_PROMPT" ;;
    *)       run_mode "$mode" "$WRITE_PROMPT" ;;
  esac
done

echo
echo "workdir retained: $WORK"
