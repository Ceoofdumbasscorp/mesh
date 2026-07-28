#!/usr/bin/env bash
# Measures what each host gives an MCP server and a hook: session-id env vars,
# and the ppid relationship between the two processes. Read-only: writes only
# into this directory, and touches neither ~/.claude nor ~/.codex.
set -uo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
OUT="$HERE/probe-out.jsonl"
rm -f "$OUT"

echo "=== claude ==="
cat > "$HERE/settings.probe.json" <<JSON
{"hooks":{"SessionStart":[{"matcher":"","hooks":[{"type":"command",
 "command":"PROBE_OUT=$OUT node $HERE/probe-hook.mjs","timeout":10}]}]}}
JSON
cat > "$HERE/mcp.probe.json" <<JSON
{"mcpServers":{"probe":{"command":"node","args":["$HERE/probe-mcp.mjs"],
 "env":{"PROBE_OUT":"$OUT"}}}}
JSON

# </dev/null matters: a headless agent left holding stdin waits forever.
claude -p "reply with the single word ok" \
  --settings "$HERE/settings.probe.json" \
  --mcp-config "$HERE/mcp.probe.json" \
  --strict-mcp-config </dev/null 2>&1 | tail -2

echo "=== codex ==="
HOOK_CMD="PROBE_OUT=$OUT node $HERE/probe-hook.mjs"
codex exec --enable hooks \
  -c "hooks.SessionStart=[{hooks=[{type=\"command\",command='''$HOOK_CMD''',timeout=10000}]}]" \
  -c "mcp_servers.probe.command=\"node\"" \
  -c "mcp_servers.probe.args=[\"$HERE/probe-mcp.mjs\"]" \
  -c "mcp_servers.probe.env={PROBE_OUT=\"$OUT\"}" \
  "reply with the single word ok" </dev/null 2>&1 | tail -3

echo "=== records ==="
cat "$OUT"
rm -f "$HERE/settings.probe.json" "$HERE/mcp.probe.json"
