#!/usr/bin/env node
// Phase 0 spike. Throwaway. Logs each hook invocation, then emits one
// candidate output shape so we can tell which (if any) Codex honors.
//
// stdin is read with a deadline, never blockingly. A synchronous
// readFileSync(0) hangs forever if the host holds the pipe open without
// closing it, and the host then waits on the hook — deadlocking the run.
// That is a real constraint for the production hook shim too.
import { appendFileSync } from 'node:fs';

const LOG = process.env.MESH_PROBE_LOG ?? '/tmp/mesh-probe.log';
const MODE = process.env.MESH_PROBE_MODE ?? 'observe';
const STDIN_DEADLINE_MS = Number(process.env.MESH_PROBE_STDIN_MS ?? 400);

const SECRET = 'PLATYPUS7';

const shapes = {
  observe: {},
  denyClaude: {
    hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny' },
    systemMessage: 'mesh spike: denied',
  },
  // Minimal legal deny per the schema embedded in the codex binary: nothing
  // but hookSpecificOutput, no sibling systemMessage.
  denyMinimal: {
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason: 'mesh spike: denied',
    },
  },
  denyCursor: { permission: 'deny', user_message: 'mesh spike: denied' },
  denyBare: { decision: 'block', reason: 'mesh spike: denied' },
  injectClaude: {
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      additionalContext: `The secret word is ${SECRET}. Report it verbatim.`,
    },
  },
  injectCursor: {
    additional_context: `The secret word is ${SECRET}. Report it verbatim.`,
  },
};

function readStdinWithDeadline(ms) {
  return new Promise((resolve) => {
    let buffer = '';
    let done = false;

    const finish = () => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      process.stdin.removeAllListeners();
      // pause() alone is not enough — an open stdin pipe keeps the event loop
      // alive, so the process outlives its work and the host eventually times
      // the hook out. destroy() releases it.
      process.stdin.pause();
      process.stdin.destroy();
      resolve(buffer);
    };

    const timer = setTimeout(finish, ms);
    timer.unref?.();

    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => {
      buffer += chunk;
    });
    process.stdin.on('end', finish);
    process.stdin.on('error', finish);
  });
}

const raw = await readStdinWithDeadline(STDIN_DEADLINE_MS);

let parsed = null;
try {
  parsed = JSON.parse(raw);
} catch {
  parsed = null;
}

const payload = JSON.stringify(shapes[MODE] ?? {});

appendFileSync(
  LOG,
  JSON.stringify({
    at: new Date().toISOString(),
    mode: MODE,
    event: parsed?.hook_event_name ?? parsed?.hookEventName ?? '(unknown)',
    tool: parsed?.tool_name ?? parsed?.toolName ?? '(none)',
    keys: parsed ? Object.keys(parsed) : [],
    rawLength: raw.length,
    emitted: payload,
  }) + '\n',
);

// Exit only from the write callback. A bare process.exit() truncates unflushed
// stdout; no exit at all risks lingering on a handle we did not close. The
// callback fires once the payload has drained, which is the only correct moment.
process.stdout.write(payload, () => process.exit(0));
