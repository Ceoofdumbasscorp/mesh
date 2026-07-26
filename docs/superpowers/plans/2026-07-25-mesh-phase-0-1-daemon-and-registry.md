# mesh Phase 0–1: Codex Spike, Daemon, and Registry — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Resolve whether Codex honors hook deny/inject decisions, then build the mesh daemon and agent registry so two agent sessions in one workspace can see each other via `mesh who`.

**Architecture:** A single per-machine daemon (`meshd`) owns all state and listens on a Unix domain socket at `~/.mesh/mesh.sock`, speaking newline-delimited JSON. Clients (CLI now; MCP server and hook shim in later plans) connect, issue one-shot request/response ops, and the daemon treats connection lifetime as agent liveness. Core state modules are pure and clock-injected so they test without timers or sleeps.

**Tech Stack:** Node 25 (>= 22.6 required), TypeScript with native type-stripping (no build step for tests), `node:test` + `node:assert/strict`, `node:net`, `node:fs`. Zero runtime dependencies.

## Global Constraints

- Node >= 22.6 required (native type stripping). Development target is the installed v25.8.1.
- TypeScript must be **erasable-syntax-only**: no `enum`, no parameter properties, no `namespace`. Enforced by `erasableSyntaxOnly: true` in tsconfig.
- ESM only. `"type": "module"` in package.json. All relative imports carry explicit `.ts` extensions.
- **Zero runtime dependencies.** `node:` builtins only. TypeScript is the sole devDependency.
- Socket file mode is `0600`. The mesh directory `~/.mesh` is mode `0700`.
- Message and task bodies are capped at 4096 bytes (`MAX_BODY_BYTES`), matching `constellation.js`.
- **Fail-open is absolute.** Any client that cannot reach the daemon within its timeout exits 0 and reports nothing, never blocking the caller.
- Workspace identity = nearest ancestor directory containing `.git` (file or directory, so worktrees resolve), else `cwd`.
- Agent names are `<provider>-<n>`, counted **per workspace**, ported from `constellation.js` `reserveName`.
- All time-dependent logic takes an injected `Clock`. No `Date.now()` calls outside `clock.ts`. No `setTimeout`-based waits in tests.
- Every commit message ends with the `Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>` trailer.

## File Structure

| Path | Responsibility |
|---|---|
| `package.json` | Scripts, Node engine floor, `type: module` |
| `tsconfig.json` | Type-check config; `erasableSyntaxOnly`, `noEmit` for check |
| `spikes/codex-hook-capability/` | Throwaway Phase 0 probe + `FINDINGS.md` (the durable output) |
| `src/clock.ts` | `Clock` type, system clock, controllable test clock |
| `src/names.ts` | Per-workspace agent name allocation |
| `src/workspace.ts` | Resolve cwd → workspace root, label, and stable key |
| `src/protocol.ts` | Wire types, size caps, frame encode/decode |
| `src/journal.ts` | Append-only JSONL journal |
| `src/paths.ts` | Canonical `~/.mesh` filesystem layout |
| `src/registry.ts` | Agent registry: register, touch, liveness, per-workspace listing |
| `src/daemon/handlers.ts` | Pure op dispatch table over daemon state |
| `src/daemon/server.ts` | Socket server, connection lifecycle, idle shutdown |
| `src/client.ts` | Socket client + daemon autostart |
| `src/cli/index.ts` | Arg parsing and subcommand dispatch |
| `src/cli/who.ts` | `mesh who` rendering |
| `src/cli/doctor.ts` | `mesh doctor` environment report |
| `test/*.test.ts` | One test file per source module, plus daemon integration |

Files are split by responsibility, not layer. `registry.ts` never touches the socket; `server.ts` never computes liveness.

---

### Task 0: Codex hook capability spike

**Files:**
- Create: `spikes/codex-hook-capability/probe.mjs`
- Create: `spikes/codex-hook-capability/run.sh`
- Create: `spikes/codex-hook-capability/FINDINGS.md`

**Interfaces:**
- Consumes: nothing.
- Produces: `FINDINGS.md`, which records for Codex — (a) which `PreToolUse` output shape, if any, blocks a tool call; (b) which output shape, if any, injects context; (c) the exact hook event names observed firing. Later plans read this to decide whether Codex enforcement is hard or advisory.

This is a spike, not a feature. There is no TDD cycle and none of the probe code survives into `src/`. The deliverable is the written finding.

- [ ] **Step 1: Write the probe hook**

The probe logs every invocation, then emits whichever output shape the `MESH_PROBE_MODE` env var selects. Testing shapes one at a time is what makes the result unambiguous.

Create `spikes/codex-hook-capability/probe.mjs`:

```javascript
#!/usr/bin/env node
// Phase 0 spike. Throwaway. Logs each hook invocation, then emits one
// candidate output shape so we can tell which (if any) Codex honors.
import { appendFileSync, readFileSync } from 'node:fs';

const LOG = process.env.MESH_PROBE_LOG ?? '/tmp/mesh-probe.log';
const MODE = process.env.MESH_PROBE_MODE ?? 'observe';

let raw = '';
try {
  raw = readFileSync(0, 'utf8');
} catch {
  raw = '';
}

let parsed = null;
try {
  parsed = JSON.parse(raw);
} catch {
  parsed = null;
}

appendFileSync(
  LOG,
  JSON.stringify({
    at: new Date().toISOString(),
    mode: MODE,
    event: parsed?.hook_event_name ?? parsed?.hookEventName ?? '(unknown)',
    tool: parsed?.tool_name ?? parsed?.toolName ?? '(none)',
    keys: parsed ? Object.keys(parsed) : [],
    rawLength: raw.length,
  }) + '\n',
);

const SECRET = 'PLATYPUS7';

const shapes = {
  observe: {},
  denyClaude: {
    hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny' },
    systemMessage: 'mesh spike: denied',
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

process.stdout.write(JSON.stringify(shapes[MODE] ?? {}));
process.exit(0);
```

- [ ] **Step 2: Write the runner**

Create `spikes/codex-hook-capability/run.sh`:

```bash
#!/bin/bash
# Phase 0 spike runner. Each mode is one question, asked in isolation.
set -uo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
PROBE="$HERE/probe.mjs"
WORK="$(mktemp -d /tmp/mesh-spike.XXXXXX)"
export MESH_PROBE_LOG="$WORK/probe.log"

echo "workdir: $WORK"

run_mode () {
  local mode="$1" prompt="$2"
  echo
  echo "=== mode: $mode ==="
  rm -f "$WORK/target.txt" "$MESH_PROBE_LOG"

  MESH_PROBE_MODE="$mode" timeout 120 codex exec \
    --enable hooks \
    --dangerously-bypass-hook-trust \
    --skip-git-repo-check \
    -C "$WORK" \
    -c "hooks.PreToolUse=[{hooks=[{type=\"command\",command=\"MESH_PROBE_MODE=$mode MESH_PROBE_LOG=$MESH_PROBE_LOG node $PROBE\"}]}]" \
    "$prompt" 2>&1 | tail -25

  echo "--- hook fired: $(wc -l < "$MESH_PROBE_LOG" 2>/dev/null || echo 0) time(s) ---"
  if [ -f "$MESH_PROBE_LOG" ]; then cut -c1-160 "$MESH_PROBE_LOG"; fi
  if [ -f "$WORK/target.txt" ]; then
    echo "RESULT: target.txt EXISTS -> write was NOT blocked"
  else
    echo "RESULT: target.txt ABSENT -> write was blocked (or never attempted)"
  fi
}

WRITE_PROMPT='Create a file named target.txt in the current directory containing the word hello. Do it now, do not ask.'
ECHO_PROMPT='Read the file probe-me.txt in the current directory, then tell me the secret word if you were given one.'

run_mode observe      "$WRITE_PROMPT"
run_mode denyClaude   "$WRITE_PROMPT"
run_mode denyCursor   "$WRITE_PROMPT"
run_mode denyBare     "$WRITE_PROMPT"

echo "seed file for injection tests" > "$WORK/probe-me.txt"
run_mode injectClaude "$ECHO_PROMPT"
run_mode injectCursor "$ECHO_PROMPT"

echo
echo "workdir retained for inspection: $WORK"
```

- [ ] **Step 3: Make the scripts executable and run the spike**

```bash
cd ~/Projects/mesh
chmod +x spikes/codex-hook-capability/probe.mjs spikes/codex-hook-capability/run.sh
./spikes/codex-hook-capability/run.sh 2>&1 | tee /tmp/mesh-spike-output.txt
```

Expected: six labelled sections. Read each `RESULT:` line and each hook-fired count.

Interpretation:
- `observe` — establishes the baseline. `target.txt` should EXIST and the hook should fire at least once. **If the hook never fires here, the spike is inconclusive and everything below is meaningless** — stop, and record that Codex hooks did not fire at all with this invocation.
- `denyClaude` / `denyCursor` / `denyBare` — whichever mode reports `target.txt ABSENT` while its hook fired is the shape Codex honors. If all three report EXISTS, Codex does not enforce deny.
- `injectClaude` / `injectCursor` — if Codex's transcript output contains `PLATYPUS7`, that shape injects context. The word appears nowhere else, so an occurrence can only have come through the hook.

- [ ] **Step 4: Record the findings**

Create `spikes/codex-hook-capability/FINDINGS.md` and fill each field from observed output. Record what actually happened, including "no shape worked" — a negative result is a valid and useful finding, and later plans depend on it being honest.

```markdown
# Codex hook capability — Phase 0 findings

**Date:** <YYYY-MM-DD>
**Codex version:** <output of `codex --version`>
**Command form:** `codex exec --enable hooks --dangerously-bypass-hook-trust -c hooks.PreToolUse=[...]`

## Does PreToolUse fire?
<yes/no> — fired <n> times in the `observe` baseline. Observed `hook_event_name` values: <list>.

## Does Codex honor a deny decision?
| Shape | Emitted JSON | Write blocked? |
|---|---|---|
| Claude-style | `{"hookSpecificOutput":{"permissionDecision":"deny"}}` | <yes/no> |
| Cursor-style | `{"permission":"deny"}` | <yes/no> |
| Bare | `{"decision":"block","reason":"..."}` | <yes/no> |

**Conclusion:** <the shape that works, or "none — Codex does not enforce deny">

## Does Codex accept injected context?
| Shape | Emitted JSON | Secret echoed? |
|---|---|---|
| Claude-style | `{"hookSpecificOutput":{"additionalContext":"..."}}` | <yes/no> |
| Cursor-style | `{"additional_context":"..."}` | <yes/no> |

**Conclusion:** <the shape that works, or "none">

## Consequence for mesh
- Claim enforcement on Codex: <HARD via shape X | ADVISORY only>
- Message/task delivery to Codex: <works via shape X | requires another channel>
- Claude side is unaffected either way; its capability was already verified from shipped code.
```

- [ ] **Step 5: Commit**

```bash
cd ~/Projects/mesh
git add spikes/
git commit -m "$(cat <<'EOF'
Spike: probe Codex hook deny and inject capability

Phase 0 gate. Determines whether Codex honors PreToolUse deny decisions
and which output shape injects context, which decides whether mesh claim
enforcement on Codex is hard or advisory.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 1: Project scaffold and clock

**Files:**
- Create: `package.json`, `tsconfig.json`, `.gitignore` (already exists — verify), `src/clock.ts`
- Test: `test/clock.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `type Clock = () => number`; `const systemClock: Clock`; `function testClock(start?: number): { now: Clock; advance(ms: number): void; set(ms: number): void }`. Every later module takes a `Clock` rather than calling `Date.now()`.

- [ ] **Step 1: Write the failing test**

Create `test/clock.test.ts`:

```typescript
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { systemClock, testClock } from '../src/clock.ts';

test('systemClock returns a plausible epoch milliseconds value', () => {
  const value = systemClock();
  assert.ok(Number.isInteger(value), 'should be an integer');
  assert.ok(value > 1_700_000_000_000, 'should be after Nov 2023');
});

test('testClock starts at zero by default and does not drift', () => {
  const clock = testClock();
  assert.equal(clock.now(), 0);
  assert.equal(clock.now(), 0);
});

test('testClock advances only when told to', () => {
  const clock = testClock(1000);
  assert.equal(clock.now(), 1000);
  clock.advance(500);
  assert.equal(clock.now(), 1500);
  clock.advance(0);
  assert.equal(clock.now(), 1500);
});

test('testClock can be set to an absolute value', () => {
  const clock = testClock(1000);
  clock.set(42);
  assert.equal(clock.now(), 42);
});
```

- [ ] **Step 2: Create the scaffold so the test can run**

Create `package.json`:

```json
{
  "name": "@krish/mesh",
  "version": "0.1.0",
  "description": "Cross-agent collaboration for terminal coding agents",
  "type": "module",
  "license": "MIT",
  "engines": { "node": ">=22.6" },
  "bin": { "mesh": "./src/cli/index.ts" },
  "scripts": {
    "test": "node --test 'test/**/*.test.ts'",
    "typecheck": "tsc --noEmit"
  },
  "devDependencies": {
    "typescript": "^5.7.2"
  }
}
```

Create `tsconfig.json`:

```json
{
  "compilerOptions": {
    "target": "es2023",
    "lib": ["es2023"],
    "module": "nodenext",
    "moduleResolution": "nodenext",
    "types": ["node"],
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "noImplicitOverride": true,
    "erasableSyntaxOnly": true,
    "verbatimModuleSyntax": true,
    "allowImportingTsExtensions": true,
    "noEmit": true,
    "skipLibCheck": true
  },
  "include": ["src/**/*.ts", "test/**/*.ts"]
}
```

Install the single devDependency:

```bash
cd ~/Projects/mesh && npm install --save-dev typescript@^5.7.2 @types/node
```

- [ ] **Step 3: Run test to verify it fails**

```bash
cd ~/Projects/mesh && npm test
```

Expected: FAIL — `Cannot find module '../src/clock.ts'`.

- [ ] **Step 4: Write minimal implementation**

Create `src/clock.ts`:

```typescript
/**
 * Every time-dependent module takes a Clock rather than calling Date.now().
 * That is what lets liveness, TTL, and timeout logic be tested with plain
 * assertions instead of sleeps.
 */
export type Clock = () => number;

export const systemClock: Clock = () => Date.now();

export interface TestClock {
  now: Clock;
  advance(ms: number): void;
  set(ms: number): void;
}

export function testClock(start = 0): TestClock {
  let current = start;
  return {
    now: () => current,
    advance(ms: number) {
      current += ms;
    },
    set(ms: number) {
      current = ms;
    },
  };
}
```

- [ ] **Step 5: Run test to verify it passes**

```bash
cd ~/Projects/mesh && npm test && npm run typecheck
```

Expected: 4 tests pass, typecheck clean.

- [ ] **Step 6: Commit**

```bash
cd ~/Projects/mesh
git add package.json package-lock.json tsconfig.json src/clock.ts test/clock.test.ts
git commit -m "$(cat <<'EOF'
Add project scaffold and injectable clock

Node type-stripping runs tests straight off .ts source, so there is no
build step. The Clock indirection is what keeps liveness and TTL tests
free of sleeps.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 2: Agent name allocation

**Files:**
- Create: `src/names.ts`
- Test: `test/names.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `class NameAllocator { allocate(provider: string): string; release(name: string): void; reset(): void }`. Used by `Registry` with one allocator per workspace.

Ported from `constellation.js` `reserveName`: lowercase the provider, keep a per-provider counter, emit `<provider>-<n>`. Counters never rewind, so a name is never reused within a workspace even after an agent leaves — stale references in a transcript stay unambiguous.

- [ ] **Step 1: Write the failing test**

Create `test/names.test.ts`:

```typescript
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { NameAllocator } from '../src/names.ts';

test('numbers each provider independently starting at 1', () => {
  const names = new NameAllocator();
  assert.equal(names.allocate('claude'), 'claude-1');
  assert.equal(names.allocate('codex'), 'codex-1');
  assert.equal(names.allocate('claude'), 'claude-2');
  assert.equal(names.allocate('codex'), 'codex-2');
});

test('normalizes provider case and surrounding whitespace', () => {
  const names = new NameAllocator();
  assert.equal(names.allocate('Claude'), 'claude-1');
  assert.equal(names.allocate('  CLAUDE  '), 'claude-2');
});

test('falls back to "agent" for an empty or missing provider', () => {
  const names = new NameAllocator();
  assert.equal(names.allocate(''), 'agent-1');
  assert.equal(names.allocate('   '), 'agent-2');
});

test('does not reuse a number after a release', () => {
  const names = new NameAllocator();
  assert.equal(names.allocate('claude'), 'claude-1');
  assert.equal(names.allocate('claude'), 'claude-2');
  names.release('claude-1');
  assert.equal(names.allocate('claude'), 'claude-3');
});

test('reset clears all counters', () => {
  const names = new NameAllocator();
  names.allocate('claude');
  names.reset();
  assert.equal(names.allocate('claude'), 'claude-1');
});

test('sanitizes providers containing separator characters', () => {
  const names = new NameAllocator();
  assert.equal(names.allocate('my agent/v2'), 'my-agent-v2-1');
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd ~/Projects/mesh && node --test 'test/names.test.ts'
```

Expected: FAIL — `Cannot find module '../src/names.ts'`.

- [ ] **Step 3: Write minimal implementation**

Create `src/names.ts`:

```typescript
/**
 * Assigns agent names like "claude-1", "codex-2". Counters are per provider
 * and per workspace, and never rewind — a released name is not handed out
 * again, so a name referenced in an old transcript can never point at a
 * different agent later.
 */
const DEFAULT_PROVIDER = 'agent';

function normalizeProvider(provider: string): string {
  const cleaned = String(provider ?? '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return cleaned.length > 0 ? cleaned : DEFAULT_PROVIDER;
}

export class NameAllocator {
  #counters = new Map<string, number>();

  allocate(provider: string): string {
    const kind = normalizeProvider(provider);
    const next = (this.#counters.get(kind) ?? 0) + 1;
    this.#counters.set(kind, next);
    return `${kind}-${next}`;
  }

  /**
   * Marks a name as no longer in use. Deliberately does not free the number:
   * counters only move forward.
   */
  release(_name: string): void {
    // Intentionally empty. Present so callers have a clear place to signal
    // departure, and so the no-reuse guarantee is explicit rather than implied.
  }

  reset(): void {
    this.#counters.clear();
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

```bash
cd ~/Projects/mesh && node --test 'test/names.test.ts' && npm run typecheck
```

Expected: 6 tests pass, typecheck clean.

- [ ] **Step 5: Commit**

```bash
cd ~/Projects/mesh
git add src/names.ts test/names.test.ts
git commit -m "$(cat <<'EOF'
Add per-workspace agent name allocation

Ported from constellation.js reserveName. Counters never rewind so a name
in an old transcript can never later refer to a different agent.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 3: Workspace resolution

**Files:**
- Create: `src/workspace.ts`
- Test: `test/workspace.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `interface Workspace { root: string; label: string; key: string }` and `function resolveWorkspace(cwd: string): Workspace`. `root` is the absolute path and the daemon's map key; `label` is the basename for display; `key` is a 12-hex-char digest of `root`, safe for use in filenames.

Walks up looking for `.git`, testing **existence rather than directory-ness** so linked worktrees (where `.git` is a file) resolve correctly.

- [ ] **Step 1: Write the failing test**

Create `test/workspace.test.ts`:

```typescript
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveWorkspace } from '../src/workspace.ts';

function scratch(): string {
  return mkdtempSync(join(tmpdir(), 'mesh-ws-'));
}

test('finds the git root from a nested directory', () => {
  const base = scratch();
  try {
    mkdirSync(join(base, '.git'));
    const nested = join(base, 'src', 'deep');
    mkdirSync(nested, { recursive: true });

    const ws = resolveWorkspace(nested);
    assert.equal(ws.root, base);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test('treats a .git FILE as a root so linked worktrees resolve', () => {
  const base = scratch();
  try {
    writeFileSync(join(base, '.git'), 'gitdir: /elsewhere/.git/worktrees/wt\n');
    const nested = join(base, 'app');
    mkdirSync(nested);

    const ws = resolveWorkspace(nested);
    assert.equal(ws.root, base);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test('falls back to cwd when there is no git root', () => {
  const base = scratch();
  try {
    const ws = resolveWorkspace(base);
    assert.equal(ws.root, base);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test('label is the basename of the root', () => {
  const base = scratch();
  try {
    mkdirSync(join(base, '.git'));
    const ws = resolveWorkspace(base);
    assert.equal(ws.label, base.split('/').pop());
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test('key is a stable 12-char hex digest, distinct per root', () => {
  const a = scratch();
  const b = scratch();
  try {
    const first = resolveWorkspace(a);
    const second = resolveWorkspace(a);
    const other = resolveWorkspace(b);

    assert.match(first.key, /^[0-9a-f]{12}$/);
    assert.equal(first.key, second.key, 'same root must yield the same key');
    assert.notEqual(first.key, other.key, 'different roots must differ');
  } finally {
    rmSync(a, { recursive: true, force: true });
    rmSync(b, { recursive: true, force: true });
  }
});

test('two directories inside one repo share a workspace', () => {
  const base = scratch();
  try {
    mkdirSync(join(base, '.git'));
    mkdirSync(join(base, 'app'));
    mkdirSync(join(base, 'server'));

    const front = resolveWorkspace(join(base, 'app'));
    const back = resolveWorkspace(join(base, 'server'));
    assert.equal(front.key, back.key);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd ~/Projects/mesh && node --test 'test/workspace.test.ts'
```

Expected: FAIL — `Cannot find module '../src/workspace.ts'`.

- [ ] **Step 3: Write minimal implementation**

Create `src/workspace.ts`:

```typescript
import { existsSync, realpathSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { basename, dirname, join, resolve } from 'node:path';

/**
 * A workspace is the unit of visibility: agents only see peers whose cwd
 * resolves to the same root.
 */
export interface Workspace {
  /** Absolute path. The daemon's map key. */
  root: string;
  /** Basename, for display. */
  label: string;
  /** 12-hex-char digest of root. Filename-safe. */
  key: string;
}

function findGitRoot(startDir: string): string | null {
  let current = startDir;
  // Walking up terminates at the filesystem root, where dirname is a fixed point.
  for (;;) {
    // Existence, not directory-ness: a linked worktree's .git is a file.
    if (existsSync(join(current, '.git'))) return current;
    const parent = dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

export function workspaceKey(root: string): string {
  return createHash('sha256').update(root).digest('hex').slice(0, 12);
}

export function resolveWorkspace(cwd: string): Workspace {
  const absolute = resolve(cwd);
  // Resolve symlinks so /tmp and /private/tmp on macOS do not produce two
  // different workspaces for one directory.
  let canonical = absolute;
  try {
    canonical = realpathSync(absolute);
  } catch {
    canonical = absolute;
  }

  const root = findGitRoot(canonical) ?? canonical;
  return { root, label: basename(root), key: workspaceKey(root) };
}
```

- [ ] **Step 4: Run test to verify it passes**

```bash
cd ~/Projects/mesh && node --test 'test/workspace.test.ts' && npm run typecheck
```

Expected: 6 tests pass, typecheck clean.

- [ ] **Step 5: Commit**

```bash
cd ~/Projects/mesh
git add src/workspace.ts test/workspace.test.ts
git commit -m "$(cat <<'EOF'
Add workspace resolution

Workspace is the unit of visibility. Detects .git as file or directory so
linked worktrees resolve, and canonicalizes symlinks so /tmp and
/private/tmp do not split one directory into two workspaces.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 4: Wire protocol framing

**Files:**
- Create: `src/protocol.ts`
- Test: `test/protocol.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `MAX_BODY_BYTES`, `MAX_FRAME_BYTES`, `interface Request { id: number; op: string; [k: string]: unknown }`, `interface Response { id: number; ok: boolean; error?: string; [k: string]: unknown }`, `function encodeFrame(value: unknown): string`, `function createFrameDecoder(): (chunk: string | Buffer) => unknown[]`.

The decoder is stateful — TCP and Unix sockets split writes arbitrarily, so a frame can arrive in pieces or several can arrive at once. It must also refuse an unbounded line so a malformed client cannot exhaust daemon memory.

- [ ] **Step 1: Write the failing test**

Create `test/protocol.test.ts`:

```typescript
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  MAX_BODY_BYTES,
  MAX_FRAME_BYTES,
  encodeFrame,
  createFrameDecoder,
} from '../src/protocol.ts';

test('body cap matches the constellation.js precedent of 4 KiB', () => {
  assert.equal(MAX_BODY_BYTES, 4096);
});

test('encodeFrame emits one newline-terminated JSON line', () => {
  const line = encodeFrame({ id: 1, op: 'ping' });
  assert.equal(line, '{"id":1,"op":"ping"}\n');
});

test('decodes a single complete frame', () => {
  const decode = createFrameDecoder();
  const out = decode('{"id":1,"op":"ping"}\n');
  assert.deepEqual(out, [{ id: 1, op: 'ping' }]);
});

test('decodes several frames arriving in one chunk', () => {
  const decode = createFrameDecoder();
  const out = decode('{"id":1}\n{"id":2}\n{"id":3}\n');
  assert.deepEqual(out, [{ id: 1 }, { id: 2 }, { id: 3 }]);
});

test('buffers a frame split across chunks', () => {
  const decode = createFrameDecoder();
  assert.deepEqual(decode('{"id":1,"op":'), []);
  assert.deepEqual(decode('"ping"}'), []);
  assert.deepEqual(decode('\n'), [{ id: 1, op: 'ping' }]);
});

test('accepts Buffer chunks as well as strings', () => {
  const decode = createFrameDecoder();
  const out = decode(Buffer.from('{"id":7}\n', 'utf8'));
  assert.deepEqual(out, [{ id: 7 }]);
});

test('skips blank lines rather than emitting undefined', () => {
  const decode = createFrameDecoder();
  const out = decode('\n\n{"id":1}\n\n');
  assert.deepEqual(out, [{ id: 1 }]);
});

test('throws on malformed JSON so the caller can close the connection', () => {
  const decode = createFrameDecoder();
  assert.throws(() => decode('not json\n'), /Malformed frame/);
});

test('throws when a single line exceeds the frame cap', () => {
  const decode = createFrameDecoder();
  const huge = 'x'.repeat(MAX_FRAME_BYTES + 1);
  assert.throws(() => decode(huge), /Frame exceeds/);
});

test('a decoder that threw stays unusable rather than resuming mid-frame', () => {
  const decode = createFrameDecoder();
  assert.throws(() => decode('bad\n'), /Malformed frame/);
  assert.throws(() => decode('{"id":1}\n'), /decoder is closed/);
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd ~/Projects/mesh && node --test 'test/protocol.test.ts'
```

Expected: FAIL — `Cannot find module '../src/protocol.ts'`.

- [ ] **Step 3: Write minimal implementation**

Create `src/protocol.ts`:

```typescript
/** Message and task bodies. Matches constellation.js MAX_BODY. */
export const MAX_BODY_BYTES = 4096;

/**
 * Whole-frame ceiling. Generous next to the body cap so metadata and a
 * maximum-size body fit, while still bounding what one malformed client
 * can make the daemon buffer.
 */
export const MAX_FRAME_BYTES = 64 * 1024;

export interface Request {
  id: number;
  op: string;
  [key: string]: unknown;
}

export interface Response {
  id: number;
  ok: boolean;
  error?: string;
  [key: string]: unknown;
}

export function encodeFrame(value: unknown): string {
  return `${JSON.stringify(value)}\n`;
}

export type FrameDecoder = (chunk: string | Buffer) => unknown[];

/**
 * Stateful line decoder. A socket splits writes wherever it likes, so frames
 * arrive fragmented or batched. Once a decoder rejects input it stays closed:
 * resuming mid-frame after a parse error would silently reinterpret the
 * remaining bytes.
 */
export function createFrameDecoder(): FrameDecoder {
  let buffer = '';
  let closed = false;

  return function decode(chunk: string | Buffer): unknown[] {
    if (closed) throw new Error('Frame decoder is closed after a protocol error');

    buffer += typeof chunk === 'string' ? chunk : chunk.toString('utf8');

    if (buffer.length > MAX_FRAME_BYTES) {
      closed = true;
      buffer = '';
      throw new Error(`Frame exceeds ${MAX_FRAME_BYTES} bytes`);
    }

    const parts = buffer.split('\n');
    buffer = parts.pop() ?? '';

    const frames: unknown[] = [];
    for (const part of parts) {
      const line = part.trim();
      if (line.length === 0) continue;
      try {
        frames.push(JSON.parse(line));
      } catch {
        closed = true;
        buffer = '';
        throw new Error('Malformed frame: invalid JSON');
      }
    }
    return frames;
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

```bash
cd ~/Projects/mesh && node --test 'test/protocol.test.ts' && npm run typecheck
```

Expected: 10 tests pass, typecheck clean.

- [ ] **Step 5: Commit**

```bash
cd ~/Projects/mesh
git add src/protocol.ts test/protocol.test.ts
git commit -m "$(cat <<'EOF'
Add JSONL wire protocol framing

Stateful decoder handles fragmented and batched socket writes, caps frame
size so one malformed client cannot exhaust daemon memory, and stays
closed after a parse error rather than resuming mid-frame.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 5: Filesystem layout and journal

**Files:**
- Create: `src/paths.ts`, `src/journal.ts`
- Test: `test/journal.test.ts`

**Interfaces:**
- Consumes: `Clock` from `src/clock.ts`.
- Produces:
  - `interface MeshPaths { home: string; socket: string; journal: string; workspaceDir(key: string): string }`, `function meshPaths(home?: string): MeshPaths`, `function ensureMeshHome(paths: MeshPaths): void`.
  - `class Journal { constructor(file: string, clock: Clock); append(kind: string, data: Record<string, unknown>): void; read(): JournalEntry[]; close(): void }` with `interface JournalEntry { at: number; kind: string; [k: string]: unknown }`.

`append` uses `appendFileSync`, which is atomic for the small writes involved, so a crash cannot interleave two entries.

- [ ] **Step 1: Write the failing test**

Create `test/journal.test.ts`:

```typescript
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, statSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { testClock } from '../src/clock.ts';
import { meshPaths, ensureMeshHome } from '../src/paths.ts';
import { Journal } from '../src/journal.ts';

function scratch(): string {
  return mkdtempSync(join(tmpdir(), 'mesh-journal-'));
}

test('meshPaths derives every path from one home directory', () => {
  const paths = meshPaths('/somewhere/.mesh');
  assert.equal(paths.home, '/somewhere/.mesh');
  assert.equal(paths.socket, '/somewhere/.mesh/mesh.sock');
  assert.equal(paths.journal, '/somewhere/.mesh/journal.jsonl');
  assert.equal(paths.workspaceDir('abc123'), '/somewhere/.mesh/ws-abc123');
});

test('ensureMeshHome creates the directory with 0700', () => {
  const base = scratch();
  try {
    const paths = meshPaths(join(base, '.mesh'));
    ensureMeshHome(paths);
    const mode = statSync(paths.home).mode & 0o777;
    assert.equal(mode, 0o700);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test('ensureMeshHome is idempotent', () => {
  const base = scratch();
  try {
    const paths = meshPaths(join(base, '.mesh'));
    ensureMeshHome(paths);
    ensureMeshHome(paths);
    assert.ok(statSync(paths.home).isDirectory());
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test('append stamps entries with the injected clock and reads them back', () => {
  const base = scratch();
  try {
    const clock = testClock(1000);
    const file = join(base, 'journal.jsonl');
    const journal = new Journal(file, clock.now);

    journal.append('register', { name: 'claude-1' });
    clock.advance(250);
    journal.append('unregister', { name: 'claude-1' });
    journal.close();

    const entries = new Journal(file, clock.now).read();
    assert.equal(entries.length, 2);
    assert.deepEqual(entries[0], { at: 1000, kind: 'register', name: 'claude-1' });
    assert.deepEqual(entries[1], { at: 1250, kind: 'unregister', name: 'claude-1' });
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test('read returns an empty array when the journal does not exist yet', () => {
  const base = scratch();
  try {
    const journal = new Journal(join(base, 'missing.jsonl'), testClock().now);
    assert.deepEqual(journal.read(), []);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test('read skips a torn final line instead of throwing', () => {
  const base = scratch();
  try {
    const file = join(base, 'journal.jsonl');
    writeFileSync(file, '{"at":1,"kind":"a"}\n{"at":2,"kind":"trunc"');
    const entries = new Journal(file, testClock().now).read();
    assert.equal(entries.length, 1);
    assert.equal(entries[0]?.kind, 'a');
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test('append writes one line per entry', () => {
  const base = scratch();
  try {
    const file = join(base, 'journal.jsonl');
    const journal = new Journal(file, testClock().now);
    journal.append('a', {});
    journal.append('b', {});
    journal.close();

    const lines = readFileSync(file, 'utf8').trim().split('\n');
    assert.equal(lines.length, 2);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd ~/Projects/mesh && node --test 'test/journal.test.ts'
```

Expected: FAIL — `Cannot find module '../src/paths.ts'`.

- [ ] **Step 3: Write minimal implementation**

Create `src/paths.ts`:

```typescript
import { mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export interface MeshPaths {
  home: string;
  socket: string;
  journal: string;
  workspaceDir(key: string): string;
}

export function meshPaths(home: string = join(homedir(), '.mesh')): MeshPaths {
  return {
    home,
    socket: join(home, 'mesh.sock'),
    journal: join(home, 'journal.jsonl'),
    workspaceDir: (key: string) => join(home, `ws-${key}`),
  };
}

/** Owner-only. mesh state names what an agent is doing and belongs to one user. */
export function ensureMeshHome(paths: MeshPaths): void {
  mkdirSync(paths.home, { recursive: true, mode: 0o700 });
}
```

Create `src/journal.ts`:

```typescript
import { appendFileSync, readFileSync } from 'node:fs';
import type { Clock } from './clock.ts';

export interface JournalEntry {
  at: number;
  kind: string;
  [key: string]: unknown;
}

/**
 * Append-only record of everything the daemon did. Primarily a debugging and
 * forensics asset (`mesh log`); crash recovery is secondary, since live state
 * is small and cheap to rebuild.
 */
export class Journal {
  #file: string;
  #clock: Clock;
  #closed = false;

  constructor(file: string, clock: Clock) {
    this.#file = file;
    this.#clock = clock;
  }

  append(kind: string, data: Record<string, unknown>): void {
    if (this.#closed) return;
    const entry: JournalEntry = { at: this.#clock(), kind, ...data };
    // appendFileSync is atomic for writes this small, so a crash cannot
    // interleave two entries into one corrupt line.
    appendFileSync(this.#file, `${JSON.stringify(entry)}\n`, 'utf8');
  }

  read(): JournalEntry[] {
    let raw: string;
    try {
      raw = readFileSync(this.#file, 'utf8');
    } catch {
      return [];
    }

    const entries: JournalEntry[] = [];
    for (const line of raw.split('\n')) {
      const trimmed = line.trim();
      if (trimmed.length === 0) continue;
      try {
        entries.push(JSON.parse(trimmed) as JournalEntry);
      } catch {
        // A torn final line means we crashed mid-append. Everything before it
        // is still good, so drop the fragment rather than failing the read.
        continue;
      }
    }
    return entries;
  }

  close(): void {
    this.#closed = true;
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

```bash
cd ~/Projects/mesh && node --test 'test/journal.test.ts' && npm run typecheck
```

Expected: 7 tests pass, typecheck clean.

- [ ] **Step 5: Commit**

```bash
cd ~/Projects/mesh
git add src/paths.ts src/journal.ts test/journal.test.ts
git commit -m "$(cat <<'EOF'
Add mesh filesystem layout and append-only journal

Home directory is 0700 since mesh state describes what an agent is doing.
Journal reads tolerate a torn final line so a crash mid-append costs one
entry rather than the whole file.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 6: Agent registry

**Files:**
- Create: `src/registry.ts`
- Test: `test/registry.test.ts`

**Interfaces:**
- Consumes: `Clock` from `src/clock.ts`, `NameAllocator` from `src/names.ts`, `Workspace` from `src/workspace.ts`.
- Produces:
  - `type AgentStatus = 'working' | 'idle'`
  - `interface RegisterInput { sessionId: string; provider: string; workspace: Workspace; role?: string; pid?: number }`
  - `interface Agent { name; sessionId; provider; role: string | null; pid: number | null; workspaceRoot; workspaceLabel; registeredAt; lastSeen; activity: string | null }`
  - `interface AgentView extends Agent { status: AgentStatus; idleMs: number }`
  - `class Registry { constructor(opts: { clock: Clock; idleAfterMs?: number }); register(input): Agent; unregister(sessionId): Agent | null; touch(sessionId, activity?): boolean; get(sessionId): Agent | undefined; byName(workspaceRoot, name): Agent | undefined; list(workspaceRoot): AgentView[]; all(): AgentView[] }`

Registration is idempotent per `sessionId`: re-registering an existing session refreshes it and keeps the same name, so a hook firing before the MCP server has connected cannot mint a duplicate agent.

- [ ] **Step 1: Write the failing test**

Create `test/registry.test.ts`:

```typescript
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { testClock } from '../src/clock.ts';
import { Registry } from '../src/registry.ts';
import type { Workspace } from '../src/workspace.ts';

const wsA: Workspace = { root: '/repo/a', label: 'a', key: 'aaaaaaaaaaaa' };
const wsB: Workspace = { root: '/repo/b', label: 'b', key: 'bbbbbbbbbbbb' };

function setup(idleAfterMs = 60_000) {
  const clock = testClock(1000);
  const registry = new Registry({ clock: clock.now, idleAfterMs });
  return { clock, registry };
}

test('assigns provider-numbered names per workspace', () => {
  const { registry } = setup();
  const first = registry.register({ sessionId: 's1', provider: 'claude', workspace: wsA });
  const second = registry.register({ sessionId: 's2', provider: 'codex', workspace: wsA });
  const other = registry.register({ sessionId: 's3', provider: 'claude', workspace: wsB });

  assert.equal(first.name, 'claude-1');
  assert.equal(second.name, 'codex-1');
  assert.equal(other.name, 'claude-1', 'numbering restarts in a separate workspace');
});

test('agents only see peers in the same workspace', () => {
  const { registry } = setup();
  registry.register({ sessionId: 's1', provider: 'claude', workspace: wsA });
  registry.register({ sessionId: 's2', provider: 'codex', workspace: wsA });
  registry.register({ sessionId: 's3', provider: 'claude', workspace: wsB });

  assert.deepEqual(registry.list(wsA.root).map((a) => a.name), ['claude-1', 'codex-1']);
  assert.deepEqual(registry.list(wsB.root).map((a) => a.name), ['claude-1']);
});

test('re-registering the same session keeps its name and does not duplicate', () => {
  const { registry } = setup();
  const first = registry.register({ sessionId: 's1', provider: 'claude', workspace: wsA });
  const again = registry.register({ sessionId: 's1', provider: 'claude', workspace: wsA });

  assert.equal(again.name, first.name);
  assert.equal(registry.list(wsA.root).length, 1);
});

test('status is working inside the idle window and idle beyond it', () => {
  const { clock, registry } = setup(60_000);
  registry.register({ sessionId: 's1', provider: 'claude', workspace: wsA });

  assert.equal(registry.list(wsA.root)[0]?.status, 'working');
  clock.advance(59_999);
  assert.equal(registry.list(wsA.root)[0]?.status, 'working');
  clock.advance(2);
  assert.equal(registry.list(wsA.root)[0]?.status, 'idle');
});

test('touch refreshes liveness and records current activity', () => {
  const { clock, registry } = setup(60_000);
  registry.register({ sessionId: 's1', provider: 'claude', workspace: wsA });

  clock.advance(90_000);
  assert.equal(registry.list(wsA.root)[0]?.status, 'idle');

  assert.equal(registry.touch('s1', 'Edit app/page.tsx'), true);
  const view = registry.list(wsA.root)[0];
  assert.equal(view?.status, 'working');
  assert.equal(view?.activity, 'Edit app/page.tsx');
  assert.equal(view?.idleMs, 0);
});

test('touch on an unknown session reports false', () => {
  const { registry } = setup();
  assert.equal(registry.touch('nope'), false);
});

test('idleMs reports elapsed time since the last sighting', () => {
  const { clock, registry } = setup();
  registry.register({ sessionId: 's1', provider: 'claude', workspace: wsA });
  clock.advance(4500);
  assert.equal(registry.list(wsA.root)[0]?.idleMs, 4500);
});

test('unregister removes the agent and returns it', () => {
  const { registry } = setup();
  registry.register({ sessionId: 's1', provider: 'claude', workspace: wsA });

  const removed = registry.unregister('s1');
  assert.equal(removed?.name, 'claude-1');
  assert.deepEqual(registry.list(wsA.root), []);
  assert.equal(registry.unregister('s1'), null, 'second removal is a no-op');
});

test('a name is not reissued after the holder leaves', () => {
  const { registry } = setup();
  registry.register({ sessionId: 's1', provider: 'claude', workspace: wsA });
  registry.unregister('s1');
  const next = registry.register({ sessionId: 's2', provider: 'claude', workspace: wsA });
  assert.equal(next.name, 'claude-2');
});

test('byName resolves within a workspace only', () => {
  const { registry } = setup();
  registry.register({ sessionId: 's1', provider: 'claude', workspace: wsA });

  assert.equal(registry.byName(wsA.root, 'claude-1')?.sessionId, 's1');
  assert.equal(registry.byName(wsB.root, 'claude-1'), undefined);
});

test('role and pid are retained and default to null', () => {
  const { registry } = setup();
  const withRole = registry.register({
    sessionId: 's1', provider: 'claude', workspace: wsA, role: 'frontend', pid: 4242,
  });
  const without = registry.register({ sessionId: 's2', provider: 'codex', workspace: wsA });

  assert.equal(withRole.role, 'frontend');
  assert.equal(withRole.pid, 4242);
  assert.equal(without.role, null);
  assert.equal(without.pid, null);
});

test('list is sorted by registration order for stable output', () => {
  const { clock, registry } = setup();
  registry.register({ sessionId: 's1', provider: 'zeta', workspace: wsA });
  clock.advance(10);
  registry.register({ sessionId: 's2', provider: 'alpha', workspace: wsA });

  assert.deepEqual(registry.list(wsA.root).map((a) => a.name), ['zeta-1', 'alpha-1']);
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd ~/Projects/mesh && node --test 'test/registry.test.ts'
```

Expected: FAIL — `Cannot find module '../src/registry.ts'`.

- [ ] **Step 3: Write minimal implementation**

Create `src/registry.ts`:

```typescript
import type { Clock } from './clock.ts';
import { NameAllocator } from './names.ts';
import type { Workspace } from './workspace.ts';

export type AgentStatus = 'working' | 'idle';

export interface RegisterInput {
  sessionId: string;
  provider: string;
  workspace: Workspace;
  role?: string;
  pid?: number;
}

export interface Agent {
  name: string;
  sessionId: string;
  provider: string;
  role: string | null;
  pid: number | null;
  workspaceRoot: string;
  workspaceLabel: string;
  registeredAt: number;
  lastSeen: number;
  activity: string | null;
}

export interface AgentView extends Agent {
  status: AgentStatus;
  idleMs: number;
}

export interface RegistryOptions {
  clock: Clock;
  /** Silence beyond this is reported as idle. */
  idleAfterMs?: number;
}

const DEFAULT_IDLE_AFTER_MS = 60_000;

export class Registry {
  #clock: Clock;
  #idleAfterMs: number;
  #agents = new Map<string, Agent>();
  #order: string[] = [];
  #names = new Map<string, NameAllocator>();

  constructor(options: RegistryOptions) {
    this.#clock = options.clock;
    this.#idleAfterMs = options.idleAfterMs ?? DEFAULT_IDLE_AFTER_MS;
  }

  #allocatorFor(workspaceRoot: string): NameAllocator {
    let allocator = this.#names.get(workspaceRoot);
    if (!allocator) {
      allocator = new NameAllocator();
      this.#names.set(workspaceRoot, allocator);
    }
    return allocator;
  }

  register(input: RegisterInput): Agent {
    const now = this.#clock();

    // Idempotent per session: a hook can fire before the MCP server connects,
    // and both paths register. Neither should mint a second agent.
    const existing = this.#agents.get(input.sessionId);
    if (existing) {
      existing.lastSeen = now;
      if (input.role !== undefined) existing.role = input.role;
      if (input.pid !== undefined) existing.pid = input.pid;
      return existing;
    }

    const agent: Agent = {
      name: this.#allocatorFor(input.workspace.root).allocate(input.provider),
      sessionId: input.sessionId,
      provider: input.provider,
      role: input.role ?? null,
      pid: input.pid ?? null,
      workspaceRoot: input.workspace.root,
      workspaceLabel: input.workspace.label,
      registeredAt: now,
      lastSeen: now,
      activity: null,
    };

    this.#agents.set(agent.sessionId, agent);
    this.#order.push(agent.sessionId);
    return agent;
  }

  unregister(sessionId: string): Agent | null {
    const agent = this.#agents.get(sessionId);
    if (!agent) return null;
    this.#agents.delete(sessionId);
    this.#order = this.#order.filter((id) => id !== sessionId);
    this.#allocatorFor(agent.workspaceRoot).release(agent.name);
    return agent;
  }

  touch(sessionId: string, activity?: string): boolean {
    const agent = this.#agents.get(sessionId);
    if (!agent) return false;
    agent.lastSeen = this.#clock();
    if (activity !== undefined) agent.activity = activity;
    return true;
  }

  get(sessionId: string): Agent | undefined {
    return this.#agents.get(sessionId);
  }

  byName(workspaceRoot: string, name: string): Agent | undefined {
    for (const agent of this.#agents.values()) {
      if (agent.workspaceRoot === workspaceRoot && agent.name === name) return agent;
    }
    return undefined;
  }

  #view(agent: Agent): AgentView {
    const idleMs = this.#clock() - agent.lastSeen;
    return {
      ...agent,
      idleMs,
      status: idleMs > this.#idleAfterMs ? 'idle' : 'working',
    };
  }

  list(workspaceRoot: string): AgentView[] {
    return this.#order
      .map((id) => this.#agents.get(id))
      .filter((agent): agent is Agent => agent !== undefined && agent.workspaceRoot === workspaceRoot)
      .map((agent) => this.#view(agent));
  }

  all(): AgentView[] {
    return this.#order
      .map((id) => this.#agents.get(id))
      .filter((agent): agent is Agent => agent !== undefined)
      .map((agent) => this.#view(agent));
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

```bash
cd ~/Projects/mesh && node --test 'test/registry.test.ts' && npm run typecheck
```

Expected: 12 tests pass, typecheck clean.

- [ ] **Step 5: Commit**

```bash
cd ~/Projects/mesh
git add src/registry.ts test/registry.test.ts
git commit -m "$(cat <<'EOF'
Add agent registry with workspace-scoped visibility

Registration is idempotent per session so a hook firing before the MCP
server connects cannot mint a duplicate agent. Liveness is computed from
the injected clock, so status tests need no sleeps.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 7: Daemon op handlers

**Files:**
- Create: `src/daemon/handlers.ts`
- Test: `test/handlers.test.ts`

**Interfaces:**
- Consumes: `Registry`, `Journal`, `Clock`, `Response` from `src/protocol.ts`, `resolveWorkspace` from `src/workspace.ts`.
- Produces:
  - `interface DaemonState { registry: Registry; journal: Journal; clock: Clock }`
  - `interface ConnectionContext { sessionId: string | null }` — mutable, one per socket connection, so the server knows which agent to unregister on disconnect.
  - `function handleRequest(state: DaemonState, ctx: ConnectionContext, request: unknown): Response`

Pure and synchronous: no sockets here. Phase 1 ops are `ping`, `register`, `unregister`, `touch`, `who`.

- [ ] **Step 1: Write the failing test**

Create `test/handlers.test.ts`:

```typescript
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { testClock } from '../src/clock.ts';
import { Registry } from '../src/registry.ts';
import { Journal } from '../src/journal.ts';
import { handleRequest } from '../src/daemon/handlers.ts';
import type { ConnectionContext, DaemonState } from '../src/daemon/handlers.ts';

function setup() {
  const base = mkdtempSync(join(tmpdir(), 'mesh-handlers-'));
  const clock = testClock(1000);
  const state: DaemonState = {
    clock: clock.now,
    registry: new Registry({ clock: clock.now }),
    journal: new Journal(join(base, 'journal.jsonl'), clock.now),
  };
  const ctx: ConnectionContext = { sessionId: null };
  return { base, clock, state, ctx, cleanup: () => rmSync(base, { recursive: true, force: true }) };
}

test('ping answers with ok and the daemon time', () => {
  const { state, ctx, cleanup } = setup();
  try {
    const res = handleRequest(state, ctx, { id: 1, op: 'ping' });
    assert.equal(res.ok, true);
    assert.equal(res.id, 1);
    assert.equal(res.at, 1000);
  } finally {
    cleanup();
  }
});

test('unknown op is rejected without throwing', () => {
  const { state, ctx, cleanup } = setup();
  try {
    const res = handleRequest(state, ctx, { id: 2, op: 'nonsense' });
    assert.equal(res.ok, false);
    assert.match(String(res.error), /Unknown op/);
  } finally {
    cleanup();
  }
});

test('a request missing op is rejected', () => {
  const { state, ctx, cleanup } = setup();
  try {
    const res = handleRequest(state, ctx, { id: 3 });
    assert.equal(res.ok, false);
    assert.match(String(res.error), /op/);
  } finally {
    cleanup();
  }
});

test('register assigns a name and binds the session to the connection', () => {
  const { state, ctx, cleanup } = setup();
  try {
    const res = handleRequest(state, ctx, {
      id: 4, op: 'register', sessionId: 's1', provider: 'claude', cwd: process.cwd(),
    });
    assert.equal(res.ok, true);
    assert.equal(res.name, 'claude-1');
    assert.equal(ctx.sessionId, 's1', 'connection remembers its agent for disconnect cleanup');
  } finally {
    cleanup();
  }
});

test('register requires sessionId and provider', () => {
  const { state, ctx, cleanup } = setup();
  try {
    const missingSession = handleRequest(state, ctx, { id: 5, op: 'register', provider: 'claude' });
    assert.equal(missingSession.ok, false);
    assert.match(String(missingSession.error), /sessionId/);

    const missingProvider = handleRequest(state, ctx, { id: 6, op: 'register', sessionId: 's1' });
    assert.equal(missingProvider.ok, false);
    assert.match(String(missingProvider.error), /provider/);
  } finally {
    cleanup();
  }
});

test('who lists peers in the caller workspace with status', () => {
  const { state, ctx, cleanup } = setup();
  try {
    const cwd = process.cwd();
    handleRequest(state, ctx, { id: 7, op: 'register', sessionId: 's1', provider: 'claude', cwd });
    handleRequest(state, { sessionId: null }, {
      id: 8, op: 'register', sessionId: 's2', provider: 'codex', cwd, role: 'backend',
    });

    const res = handleRequest(state, ctx, { id: 9, op: 'who', cwd });
    assert.equal(res.ok, true);
    const agents = res.agents as Array<Record<string, unknown>>;
    assert.equal(agents.length, 2);
    assert.deepEqual(agents.map((a) => a.name), ['claude-1', 'codex-1']);
    assert.equal(agents[1]?.role, 'backend');
    assert.equal(agents[0]?.status, 'working');
  } finally {
    cleanup();
  }
});

test('touch updates activity and is reflected by who', () => {
  const { state, ctx, cleanup } = setup();
  try {
    const cwd = process.cwd();
    handleRequest(state, ctx, { id: 10, op: 'register', sessionId: 's1', provider: 'claude', cwd });
    const touched = handleRequest(state, ctx, {
      id: 11, op: 'touch', sessionId: 's1', activity: 'Edit app/page.tsx',
    });
    assert.equal(touched.ok, true);

    const res = handleRequest(state, ctx, { id: 12, op: 'who', cwd });
    const agents = res.agents as Array<Record<string, unknown>>;
    assert.equal(agents[0]?.activity, 'Edit app/page.tsx');
  } finally {
    cleanup();
  }
});

test('unregister removes the agent and clears the connection binding', () => {
  const { state, ctx, cleanup } = setup();
  try {
    const cwd = process.cwd();
    handleRequest(state, ctx, { id: 13, op: 'register', sessionId: 's1', provider: 'claude', cwd });
    const res = handleRequest(state, ctx, { id: 14, op: 'unregister', sessionId: 's1' });

    assert.equal(res.ok, true);
    assert.equal(ctx.sessionId, null);
    const who = handleRequest(state, ctx, { id: 15, op: 'who', cwd });
    assert.deepEqual(who.agents, []);
  } finally {
    cleanup();
  }
});

test('every handled op is journaled except the noisy read-only ones', () => {
  const { state, ctx, cleanup } = setup();
  try {
    const cwd = process.cwd();
    handleRequest(state, ctx, { id: 16, op: 'register', sessionId: 's1', provider: 'claude', cwd });
    handleRequest(state, ctx, { id: 17, op: 'who', cwd });
    handleRequest(state, ctx, { id: 18, op: 'ping' });
    handleRequest(state, ctx, { id: 19, op: 'unregister', sessionId: 's1' });

    const kinds = state.journal.read().map((e) => e.kind);
    assert.deepEqual(kinds, ['register', 'unregister'], 'who and ping must not flood the journal');
  } finally {
    cleanup();
  }
});

test('a non-object request is rejected', () => {
  const { state, ctx, cleanup } = setup();
  try {
    const res = handleRequest(state, ctx, 'hello');
    assert.equal(res.ok, false);
    assert.equal(res.id, 0);
  } finally {
    cleanup();
  }
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd ~/Projects/mesh && node --test 'test/handlers.test.ts'
```

Expected: FAIL — `Cannot find module '../src/daemon/handlers.ts'`.

- [ ] **Step 3: Write minimal implementation**

Create `src/daemon/handlers.ts`:

```typescript
import type { Clock } from '../clock.ts';
import type { Journal } from '../journal.ts';
import type { Registry } from '../registry.ts';
import type { Response } from '../protocol.ts';
import { resolveWorkspace } from '../workspace.ts';

export interface DaemonState {
  registry: Registry;
  journal: Journal;
  clock: Clock;
}

/**
 * Per-connection, mutable. The socket layer uses this to know which agent to
 * unregister when the connection drops — that drop is our liveness signal.
 */
export interface ConnectionContext {
  sessionId: string | null;
}

function fail(id: number, error: string): Response {
  return { id, ok: false, error };
}

function readString(source: Record<string, unknown>, key: string): string | undefined {
  const value = source[key];
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;
}

export function handleRequest(
  state: DaemonState,
  ctx: ConnectionContext,
  request: unknown,
): Response {
  if (typeof request !== 'object' || request === null || Array.isArray(request)) {
    return fail(0, 'Request must be a JSON object');
  }

  const req = request as Record<string, unknown>;
  const id = typeof req.id === 'number' ? req.id : 0;
  const op = readString(req, 'op');
  if (!op) return fail(id, 'Request is missing "op"');

  switch (op) {
    case 'ping':
      return { id, ok: true, at: state.clock() };

    case 'register': {
      const sessionId = readString(req, 'sessionId');
      if (!sessionId) return fail(id, 'register requires "sessionId"');
      const provider = readString(req, 'provider');
      if (!provider) return fail(id, 'register requires "provider"');

      const workspace = resolveWorkspace(readString(req, 'cwd') ?? process.cwd());
      const agent = state.registry.register({
        sessionId,
        provider,
        workspace,
        role: readString(req, 'role'),
        pid: typeof req.pid === 'number' ? req.pid : undefined,
      });

      ctx.sessionId = sessionId;
      state.journal.append('register', {
        name: agent.name,
        sessionId,
        provider,
        workspace: workspace.root,
      });

      return {
        id,
        ok: true,
        name: agent.name,
        workspace: workspace.root,
        workspaceLabel: workspace.label,
      };
    }

    case 'unregister': {
      const sessionId = readString(req, 'sessionId') ?? ctx.sessionId;
      if (!sessionId) return fail(id, 'unregister requires "sessionId"');

      const removed = state.registry.unregister(sessionId);
      if (ctx.sessionId === sessionId) ctx.sessionId = null;
      if (removed) {
        state.journal.append('unregister', { name: removed.name, sessionId });
      }
      return { id, ok: true, removed: removed !== null };
    }

    case 'touch': {
      const sessionId = readString(req, 'sessionId') ?? ctx.sessionId;
      if (!sessionId) return fail(id, 'touch requires "sessionId"');
      const known = state.registry.touch(sessionId, readString(req, 'activity'));
      return { id, ok: true, known };
    }

    case 'who': {
      const workspace = resolveWorkspace(readString(req, 'cwd') ?? process.cwd());
      const agents = state.registry.list(workspace.root).map((agent) => ({
        name: agent.name,
        provider: agent.provider,
        role: agent.role,
        status: agent.status,
        activity: agent.activity,
        idleMs: agent.idleMs,
        pid: agent.pid,
      }));
      return {
        id,
        ok: true,
        workspace: workspace.root,
        workspaceLabel: workspace.label,
        agents,
      };
    }

    default:
      return fail(id, `Unknown op: ${op}`);
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

```bash
cd ~/Projects/mesh && node --test 'test/handlers.test.ts' && npm run typecheck
```

Expected: 10 tests pass, typecheck clean.

- [ ] **Step 5: Commit**

```bash
cd ~/Projects/mesh
git add src/daemon/handlers.ts test/handlers.test.ts
git commit -m "$(cat <<'EOF'
Add daemon op handlers for ping, register, touch, who

Handlers are pure and synchronous so the whole op surface tests without a
socket. The connection context carries the bound session so the server can
treat a dropped connection as the agent leaving.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 8: Daemon socket server

**Files:**
- Create: `src/daemon/server.ts`
- Test: `test/server.test.ts`

**Interfaces:**
- Consumes: `handleRequest`, `DaemonState`, `ConnectionContext`, `createFrameDecoder`, `encodeFrame`, `meshPaths`, `ensureMeshHome`, `Registry`, `Journal`, `systemClock`.
- Produces:
  - `interface ServerOptions { socketPath: string; state: DaemonState; idleShutdownMs?: number; onShutdown?: () => void }`
  - `class MeshServer { start(): Promise<void>; close(): Promise<void>; get connectionCount(): number }`
  - `function createDaemonState(options: { journalPath: string; clock?: Clock; idleAfterMs?: number }): DaemonState`

Two behaviors beyond plumbing: a **stale socket file** (daemon killed without cleanup) must be removed so the next start succeeds, and **connection close** must unregister the bound agent — that is the liveness mechanism the whole design leans on.

- [ ] **Step 1: Write the failing test**

Create `test/server.test.ts`:

```typescript
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { connect } from 'node:net';
import { mkdtempSync, rmSync, writeFileSync, existsSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { testClock } from '../src/clock.ts';
import { Registry } from '../src/registry.ts';
import { Journal } from '../src/journal.ts';
import { MeshServer } from '../src/daemon/server.ts';
import { createFrameDecoder, encodeFrame } from '../src/protocol.ts';
import type { DaemonState } from '../src/daemon/handlers.ts';

function scratch(): string {
  return mkdtempSync(join(tmpdir(), 'mesh-server-'));
}

function makeState(base: string): DaemonState {
  const clock = testClock(1000);
  return {
    clock: clock.now,
    registry: new Registry({ clock: clock.now }),
    journal: new Journal(join(base, 'journal.jsonl'), clock.now),
  };
}

/** Minimal raw client: send requests, resolve each response by id. */
function rawClient(socketPath: string) {
  const socket = connect(socketPath);
  const decode = createFrameDecoder();
  const pending = new Map<number, (value: Record<string, unknown>) => void>();

  socket.on('data', (chunk) => {
    for (const frame of decode(chunk)) {
      const res = frame as Record<string, unknown>;
      const resolve = pending.get(res.id as number);
      if (resolve) {
        pending.delete(res.id as number);
        resolve(res);
      }
    }
  });

  return {
    socket,
    ready: once(socket, 'connect'),
    request(payload: Record<string, unknown>): Promise<Record<string, unknown>> {
      return new Promise((resolve) => {
        pending.set(payload.id as number, resolve);
        socket.write(encodeFrame(payload));
      });
    },
    close(): Promise<unknown> {
      socket.end();
      return once(socket, 'close');
    },
  };
}

test('serves a request over a real socket', async () => {
  const base = scratch();
  const socketPath = join(base, 'mesh.sock');
  const server = new MeshServer({ socketPath, state: makeState(base) });
  await server.start();

  const client = rawClient(socketPath);
  await client.ready;
  try {
    const res = await client.request({ id: 1, op: 'ping' });
    assert.equal(res.ok, true);
    assert.equal(res.at, 1000);
  } finally {
    await client.close();
    await server.close();
    rmSync(base, { recursive: true, force: true });
  }
});

test('creates the socket with 0600 permissions', async () => {
  const base = scratch();
  const socketPath = join(base, 'mesh.sock');
  const server = new MeshServer({ socketPath, state: makeState(base) });
  await server.start();
  try {
    assert.equal(statSync(socketPath).mode & 0o777, 0o600);
  } finally {
    await server.close();
    rmSync(base, { recursive: true, force: true });
  }
});

test('replaces a stale socket file left by a killed daemon', async () => {
  const base = scratch();
  const socketPath = join(base, 'mesh.sock');
  writeFileSync(socketPath, 'stale');

  const server = new MeshServer({ socketPath, state: makeState(base) });
  await server.start();

  const client = rawClient(socketPath);
  await client.ready;
  try {
    const res = await client.request({ id: 1, op: 'ping' });
    assert.equal(res.ok, true);
  } finally {
    await client.close();
    await server.close();
    rmSync(base, { recursive: true, force: true });
  }
});

test('two clients registered on one workspace see each other', async () => {
  const base = scratch();
  const socketPath = join(base, 'mesh.sock');
  const server = new MeshServer({ socketPath, state: makeState(base) });
  await server.start();

  const a = rawClient(socketPath);
  const b = rawClient(socketPath);
  await Promise.all([a.ready, b.ready]);

  try {
    await a.request({ id: 1, op: 'register', sessionId: 'sa', provider: 'claude', cwd: base });
    await b.request({ id: 1, op: 'register', sessionId: 'sb', provider: 'codex', cwd: base });

    const who = await a.request({ id: 2, op: 'who', cwd: base });
    const agents = who.agents as Array<Record<string, unknown>>;
    assert.deepEqual(agents.map((x) => x.name), ['claude-1', 'codex-1']);
  } finally {
    await a.close();
    await b.close();
    await server.close();
    rmSync(base, { recursive: true, force: true });
  }
});

test('closing a connection unregisters its agent', async () => {
  const base = scratch();
  const socketPath = join(base, 'mesh.sock');
  const server = new MeshServer({ socketPath, state: makeState(base) });
  await server.start();

  const a = rawClient(socketPath);
  const b = rawClient(socketPath);
  await Promise.all([a.ready, b.ready]);

  try {
    await a.request({ id: 1, op: 'register', sessionId: 'sa', provider: 'claude', cwd: base });
    await b.request({ id: 1, op: 'register', sessionId: 'sb', provider: 'codex', cwd: base });

    await a.close();
    // Give the server's close handler a turn to run.
    await new Promise((resolve) => setImmediate(resolve));

    const who = await b.request({ id: 2, op: 'who', cwd: base });
    const agents = who.agents as Array<Record<string, unknown>>;
    assert.deepEqual(agents.map((x) => x.name), ['codex-1'], 'the departed agent is gone');
  } finally {
    await b.close();
    await server.close();
    rmSync(base, { recursive: true, force: true });
  }
});

test('a malformed frame closes that connection without killing the server', async () => {
  const base = scratch();
  const socketPath = join(base, 'mesh.sock');
  const server = new MeshServer({ socketPath, state: makeState(base) });
  await server.start();

  const bad = rawClient(socketPath);
  await bad.ready;
  bad.socket.write('this is not json\n');
  await once(bad.socket, 'close');

  const good = rawClient(socketPath);
  await good.ready;
  try {
    const res = await good.request({ id: 1, op: 'ping' });
    assert.equal(res.ok, true, 'server survived the bad client');
  } finally {
    await good.close();
    await server.close();
    rmSync(base, { recursive: true, force: true });
  }
});

test('close removes the socket file', async () => {
  const base = scratch();
  const socketPath = join(base, 'mesh.sock');
  const server = new MeshServer({ socketPath, state: makeState(base) });
  await server.start();
  await server.close();
  try {
    assert.equal(existsSync(socketPath), false);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd ~/Projects/mesh && node --test 'test/server.test.ts'
```

Expected: FAIL — `Cannot find module '../src/daemon/server.ts'`.

- [ ] **Step 3: Write minimal implementation**

Create `src/daemon/server.ts`:

```typescript
import { createServer, connect } from 'node:net';
import type { Server, Socket } from 'node:net';
import { chmodSync, existsSync, unlinkSync } from 'node:fs';
import { systemClock } from '../clock.ts';
import type { Clock } from '../clock.ts';
import { Journal } from '../journal.ts';
import { Registry } from '../registry.ts';
import { createFrameDecoder, encodeFrame } from '../protocol.ts';
import { handleRequest } from './handlers.ts';
import type { ConnectionContext, DaemonState } from './handlers.ts';

export interface ServerOptions {
  socketPath: string;
  state: DaemonState;
  /** Exit after this long with no connections. Zero disables. */
  idleShutdownMs?: number;
  onShutdown?: () => void;
}

const DEFAULT_IDLE_SHUTDOWN_MS = 30 * 60_000;

export function createDaemonState(options: {
  journalPath: string;
  clock?: Clock;
  idleAfterMs?: number;
}): DaemonState {
  const clock = options.clock ?? systemClock;
  return {
    clock,
    registry: new Registry({ clock, idleAfterMs: options.idleAfterMs }),
    journal: new Journal(options.journalPath, clock),
  };
}

/**
 * Determines whether a socket file has a live listener behind it. A daemon
 * killed with SIGKILL leaves the file in place, and binding would fail with
 * EADDRINUSE forever if we did not clear it.
 */
async function isSocketLive(socketPath: string): Promise<boolean> {
  if (!existsSync(socketPath)) return false;
  return await new Promise<boolean>((resolve) => {
    const probe = connect(socketPath);
    const settle = (live: boolean) => {
      probe.removeAllListeners();
      probe.destroy();
      resolve(live);
    };
    probe.once('connect', () => settle(true));
    probe.once('error', () => settle(false));
  });
}

export class MeshServer {
  #options: ServerOptions;
  #server: Server | null = null;
  #connections = new Set<Socket>();
  #idleTimer: NodeJS.Timeout | null = null;

  constructor(options: ServerOptions) {
    this.#options = options;
  }

  get connectionCount(): number {
    return this.#connections.size;
  }

  async start(): Promise<void> {
    const { socketPath } = this.#options;

    if (existsSync(socketPath) && !(await isSocketLive(socketPath))) {
      unlinkSync(socketPath);
    }

    const server = createServer((socket) => this.#onConnection(socket));
    this.#server = server;

    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(socketPath, () => {
        server.removeListener('error', reject);
        resolve();
      });
    });

    // Owner-only: mesh state describes what an agent is doing.
    chmodSync(socketPath, 0o600);
    this.#armIdleTimer();
  }

  #onConnection(socket: Socket): void {
    this.#connections.add(socket);
    this.#clearIdleTimer();

    const ctx: ConnectionContext = { sessionId: null };
    const decode = createFrameDecoder();

    socket.on('data', (chunk) => {
      let frames: unknown[];
      try {
        frames = decode(chunk);
      } catch {
        // Protocol violation is that client's problem alone.
        socket.destroy();
        return;
      }
      for (const frame of frames) {
        const response = handleRequest(this.#options.state, ctx, frame);
        socket.write(encodeFrame(response));
      }
    });

    const cleanup = () => {
      if (!this.#connections.delete(socket)) return;
      // A dropped connection is how we learn an agent is gone. This is the
      // liveness signal the rest of the design depends on.
      if (ctx.sessionId) {
        const removed = this.#options.state.registry.unregister(ctx.sessionId);
        if (removed) {
          this.#options.state.journal.append('disconnect', {
            name: removed.name,
            sessionId: ctx.sessionId,
          });
        }
        ctx.sessionId = null;
      }
      if (this.#connections.size === 0) this.#armIdleTimer();
    };

    socket.on('close', cleanup);
    socket.on('error', cleanup);
  }

  #armIdleTimer(): void {
    const idleShutdownMs = this.#options.idleShutdownMs ?? DEFAULT_IDLE_SHUTDOWN_MS;
    if (idleShutdownMs <= 0) return;
    this.#clearIdleTimer();
    this.#idleTimer = setTimeout(() => {
      void this.close().then(() => this.#options.onShutdown?.());
    }, idleShutdownMs);
    // Never hold the process open purely to wait for its own shutdown.
    this.#idleTimer.unref?.();
  }

  #clearIdleTimer(): void {
    if (this.#idleTimer) clearTimeout(this.#idleTimer);
    this.#idleTimer = null;
  }

  async close(): Promise<void> {
    this.#clearIdleTimer();
    for (const socket of this.#connections) socket.destroy();
    this.#connections.clear();

    const server = this.#server;
    this.#server = null;
    if (server) {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }

    this.#options.state.journal.close();
    if (existsSync(this.#options.socketPath)) {
      try {
        unlinkSync(this.#options.socketPath);
      } catch {
        // Already gone. Nothing to do.
      }
    }
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

```bash
cd ~/Projects/mesh && node --test 'test/server.test.ts' && npm run typecheck
```

Expected: 7 tests pass, typecheck clean.

- [ ] **Step 5: Commit**

```bash
cd ~/Projects/mesh
git add src/daemon/server.ts test/server.test.ts
git commit -m "$(cat <<'EOF'
Add daemon socket server

Connection close is the agent liveness signal, so a dead session drops out
of `who` without any timeout. Probes and clears a stale socket file left by
a SIGKILLed daemon, and isolates protocol violations to the offending
connection.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 9: Client with daemon autostart

**Files:**
- Create: `src/client.ts`, `src/daemon/main.ts`
- Test: `test/client.test.ts`

**Interfaces:**
- Consumes: `meshPaths`, `ensureMeshHome`, `createFrameDecoder`, `encodeFrame`, `createDaemonState`, `MeshServer`.
- Produces:
  - `interface ClientOptions { socketPath?: string; connectTimeoutMs?: number; autostart?: boolean }`
  - `class MeshClient { static open(options?: ClientOptions): Promise<MeshClient | null>; request(op: string, params?: Record<string, unknown>): Promise<Response>; close(): void }`
  - `src/daemon/main.ts` — entry point that boots a daemon in the foreground; spawned detached by autostart and invoked by `mesh daemon`.

`MeshClient.open` returns **null** rather than throwing when the daemon is unreachable. That is the fail-open contract in code: every caller handles absence as a normal outcome.

- [ ] **Step 1: Write the failing test**

Create `test/client.test.ts`:

```typescript
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { testClock } from '../src/clock.ts';
import { Registry } from '../src/registry.ts';
import { Journal } from '../src/journal.ts';
import { MeshServer } from '../src/daemon/server.ts';
import { MeshClient } from '../src/client.ts';
import type { DaemonState } from '../src/daemon/handlers.ts';

function scratch(): string {
  return mkdtempSync(join(tmpdir(), 'mesh-client-'));
}

function makeState(base: string): DaemonState {
  const clock = testClock(1000);
  return {
    clock: clock.now,
    registry: new Registry({ clock: clock.now }),
    journal: new Journal(join(base, 'journal.jsonl'), clock.now),
  };
}

test('open returns null when no daemon is listening and autostart is off', async () => {
  const base = scratch();
  try {
    const client = await MeshClient.open({
      socketPath: join(base, 'nothing.sock'),
      autostart: false,
      connectTimeoutMs: 100,
    });
    assert.equal(client, null, 'absence is a normal outcome, not an exception');
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test('request round-trips against a live daemon', async () => {
  const base = scratch();
  const socketPath = join(base, 'mesh.sock');
  const server = new MeshServer({ socketPath, state: makeState(base) });
  await server.start();

  const client = await MeshClient.open({ socketPath, autostart: false });
  assert.ok(client, 'client should connect');
  try {
    const res = await client.request('ping');
    assert.equal(res.ok, true);
    assert.equal(res.at, 1000);
  } finally {
    client.close();
    await server.close();
    rmSync(base, { recursive: true, force: true });
  }
});

test('correlates concurrent requests by id', async () => {
  const base = scratch();
  const socketPath = join(base, 'mesh.sock');
  const server = new MeshServer({ socketPath, state: makeState(base) });
  await server.start();

  const client = await MeshClient.open({ socketPath, autostart: false });
  assert.ok(client);
  try {
    const [ping, who, bad] = await Promise.all([
      client.request('ping'),
      client.request('who', { cwd: base }),
      client.request('nonsense'),
    ]);
    assert.equal(ping.ok, true);
    assert.equal(who.ok, true);
    assert.equal(bad.ok, false);
    assert.notEqual(ping.id, who.id, 'ids must be distinct');
  } finally {
    client.close();
    await server.close();
    rmSync(base, { recursive: true, force: true });
  }
});

test('registering through the client makes the agent visible to who', async () => {
  const base = scratch();
  const socketPath = join(base, 'mesh.sock');
  const server = new MeshServer({ socketPath, state: makeState(base) });
  await server.start();

  const client = await MeshClient.open({ socketPath, autostart: false });
  assert.ok(client);
  try {
    const reg = await client.request('register', {
      sessionId: 's1', provider: 'claude', cwd: base, role: 'frontend',
    });
    assert.equal(reg.name, 'claude-1');

    const who = await client.request('who', { cwd: base });
    const agents = who.agents as Array<Record<string, unknown>>;
    assert.equal(agents.length, 1);
    assert.equal(agents[0]?.role, 'frontend');
  } finally {
    client.close();
    await server.close();
    rmSync(base, { recursive: true, force: true });
  }
});

test('autostart launches a daemon when none is running', async () => {
  const base = scratch();
  const socketPath = join(base, 'mesh.sock');
  try {
    const client = await MeshClient.open({
      socketPath,
      autostart: true,
      journalPath: join(base, 'journal.jsonl'),
      connectTimeoutMs: 5000,
    });
    assert.ok(client, 'autostart should produce a usable client');

    const res = await client.request('ping');
    assert.equal(res.ok, true);

    client.close();
    // Shut the spawned daemon down so it does not outlive the test run.
    const killer = await MeshClient.open({ socketPath, autostart: false });
    killer?.request('shutdown').catch(() => {});
    killer?.close();
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test('requests after close are rejected rather than hanging', async () => {
  const base = scratch();
  const socketPath = join(base, 'mesh.sock');
  const server = new MeshServer({ socketPath, state: makeState(base) });
  await server.start();

  const client = await MeshClient.open({ socketPath, autostart: false });
  assert.ok(client);
  client.close();
  try {
    await assert.rejects(() => client.request('ping'), /closed/);
  } finally {
    await server.close();
    rmSync(base, { recursive: true, force: true });
  }
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd ~/Projects/mesh && node --test 'test/client.test.ts'
```

Expected: FAIL — `Cannot find module '../src/client.ts'`.

- [ ] **Step 3: Add the `shutdown` op the autostart test uses**

Modify `src/daemon/handlers.ts`. Add a `shutdown` field to `ConnectionContext` and a `shutdown` case. The server sets the callback so a client can stop a daemon it started.

Replace the `ConnectionContext` interface:

```typescript
export interface ConnectionContext {
  sessionId: string | null;
  /** Set by the server so a client can ask the daemon to stop. */
  requestShutdown?: () => void;
}
```

Add this case immediately before `default:` in the `switch`:

```typescript
    case 'shutdown': {
      state.journal.append('shutdown', {});
      // Answer before stopping, so the caller is not left waiting on a socket
      // that is about to disappear.
      queueMicrotask(() => ctx.requestShutdown?.());
      return { id, ok: true };
    }
```

Modify `src/daemon/server.ts` — in `#onConnection`, replace the `ctx` declaration with:

```typescript
    const ctx: ConnectionContext = {
      sessionId: null,
      requestShutdown: () => {
        void this.close().then(() => this.#options.onShutdown?.());
      },
    };
```

- [ ] **Step 4: Write the client and daemon entry point**

Create `src/client.ts`:

```typescript
import { connect } from 'node:net';
import type { Socket } from 'node:net';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { meshPaths, ensureMeshHome } from './paths.ts';
import { createFrameDecoder, encodeFrame } from './protocol.ts';
import type { Response } from './protocol.ts';

export interface ClientOptions {
  socketPath?: string;
  journalPath?: string;
  connectTimeoutMs?: number;
  /** Spawn a daemon if none is listening. Default true. */
  autostart?: boolean;
}

const DEFAULT_CONNECT_TIMEOUT_MS = 1000;
const AUTOSTART_POLL_MS = 50;

function tryConnect(socketPath: string, timeoutMs: number): Promise<Socket | null> {
  return new Promise((resolve) => {
    const socket = connect(socketPath);
    const timer = setTimeout(() => settle(null), timeoutMs);

    const settle = (result: Socket | null) => {
      clearTimeout(timer);
      socket.removeAllListeners('connect');
      socket.removeAllListeners('error');
      if (result === null) socket.destroy();
      resolve(result);
    };

    socket.once('connect', () => settle(socket));
    socket.once('error', () => settle(null));
  });
}

function daemonEntryPoint(): string {
  return join(dirname(fileURLToPath(import.meta.url)), 'daemon', 'main.ts');
}

/**
 * Talks to meshd. Every failure to reach the daemon surfaces as null rather
 * than an exception — that is the fail-open contract, expressed in the type.
 */
export class MeshClient {
  #socket: Socket;
  #decode = createFrameDecoder();
  #pending = new Map<number, (response: Response) => void>();
  #nextId = 1;
  #closed = false;

  private constructor(socket: Socket) {
    this.#socket = socket;

    socket.on('data', (chunk) => {
      let frames: unknown[];
      try {
        frames = this.#decode(chunk);
      } catch {
        this.#failAll('mesh client: protocol error');
        return;
      }
      for (const frame of frames) {
        const response = frame as Response;
        const resolve = this.#pending.get(response.id);
        if (resolve) {
          this.#pending.delete(response.id);
          resolve(response);
        }
      }
    });

    socket.on('close', () => this.#failAll('mesh client: connection closed'));
    socket.on('error', () => this.#failAll('mesh client: connection error'));
  }

  #failAll(reason: string): void {
    this.#closed = true;
    for (const [id, resolve] of this.#pending) {
      resolve({ id, ok: false, error: reason });
    }
    this.#pending.clear();
  }

  static async open(options: ClientOptions = {}): Promise<MeshClient | null> {
    const paths = meshPaths();
    const socketPath = options.socketPath ?? paths.socket;
    const timeoutMs = options.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS;

    const direct = await tryConnect(socketPath, timeoutMs);
    if (direct) return new MeshClient(direct);

    if (options.autostart === false) return null;

    ensureMeshHome(meshPaths(options.socketPath ? dirname(socketPath) : paths.home));

    const child = spawn(
      process.execPath,
      [daemonEntryPoint(), '--socket', socketPath, '--journal', options.journalPath ?? paths.journal],
      { detached: true, stdio: 'ignore' },
    );
    child.unref();

    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, AUTOSTART_POLL_MS));
      const socket = await tryConnect(socketPath, AUTOSTART_POLL_MS * 2);
      if (socket) return new MeshClient(socket);
    }
    return null;
  }

  request(op: string, params: Record<string, unknown> = {}): Promise<Response> {
    if (this.#closed) {
      return Promise.reject(new Error('mesh client is closed'));
    }
    const id = this.#nextId++;
    return new Promise<Response>((resolve) => {
      this.#pending.set(id, resolve);
      this.#socket.write(encodeFrame({ id, op, ...params }));
    });
  }

  close(): void {
    this.#closed = true;
    this.#pending.clear();
    this.#socket.end();
    this.#socket.destroy();
  }
}
```

Create `src/daemon/main.ts`:

```typescript
#!/usr/bin/env node
import { meshPaths, ensureMeshHome } from '../paths.ts';
import { MeshServer, createDaemonState } from './server.ts';

function argValue(flag: string, fallback: string): string {
  const index = process.argv.indexOf(flag);
  if (index === -1) return fallback;
  return process.argv[index + 1] ?? fallback;
}

const paths = meshPaths();
const socketPath = argValue('--socket', paths.socket);
const journalPath = argValue('--journal', paths.journal);

ensureMeshHome(paths);

const server = new MeshServer({
  socketPath,
  state: createDaemonState({ journalPath }),
  onShutdown: () => process.exit(0),
});

await server.start();

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    void server.close().then(() => process.exit(0));
  });
}
```

- [ ] **Step 5: Run tests to verify they pass**

```bash
cd ~/Projects/mesh && node --test 'test/client.test.ts' 'test/handlers.test.ts' 'test/server.test.ts' && npm run typecheck
```

Expected: all pass. The autostart test spawns a real detached daemon and stops it again.

- [ ] **Step 6: Commit**

```bash
cd ~/Projects/mesh
git add src/client.ts src/daemon/main.ts src/daemon/handlers.ts src/daemon/server.ts test/client.test.ts
git commit -m "$(cat <<'EOF'
Add mesh client with daemon autostart

MeshClient.open returns null when the daemon is unreachable rather than
throwing, making the fail-open contract part of the type. Autostart spawns
a detached daemon so the user never manages a lifecycle.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 10: `mesh who` and `mesh doctor`

**Files:**
- Create: `src/cli/index.ts`, `src/cli/who.ts`, `src/cli/doctor.ts`
- Test: `test/cli.test.ts`

**Interfaces:**
- Consumes: `MeshClient`, `resolveWorkspace`, `meshPaths`.
- Produces:
  - `function renderWho(payload: { workspaceLabel: string; agents: WhoAgent[] }): string` where `interface WhoAgent { name: string; provider: string; role: string | null; status: string; activity: string | null; idleMs: number }`
  - `function renderDoctor(report: DoctorReport): string` where `interface DoctorReport { nodeVersion: string; nodeOk: boolean; daemonReachable: boolean; socketPath: string; claudeHooksInstalled: boolean; codexHooksInstalled: boolean; codexSpikeRecorded: boolean }`
  - `function collectDoctorReport(): Promise<DoctorReport>`
  - `main(argv: string[]): Promise<number>` — the CLI entry, returning an exit code.

Rendering is a pure function of data so output is asserted directly, with no subprocess capture.

`mesh doctor` reporting hooks as **not installed** is the correct Phase 1 answer — `mesh init` arrives in Phase 5. The point is that it tells the truth about the current environment.

- [ ] **Step 1: Write the failing test**

Create `test/cli.test.ts`:

```typescript
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderWho } from '../src/cli/who.ts';
import { renderDoctor } from '../src/cli/doctor.ts';

test('renderWho lists each agent with status and activity', () => {
  const out = renderWho({
    workspaceLabel: 'leadops-v2',
    agents: [
      { name: 'claude-1', provider: 'claude', role: 'frontend', status: 'working', activity: 'Edit app/page.tsx', idleMs: 1200 },
      { name: 'codex-2', provider: 'codex', role: 'backend', status: 'idle', activity: null, idleMs: 132_000 },
    ],
  });

  assert.match(out, /leadops-v2/);
  assert.match(out, /claude-1/);
  assert.match(out, /frontend/);
  assert.match(out, /Edit app\/page\.tsx/);
  assert.match(out, /codex-2/);
  assert.match(out, /2m/, 'idle time is rendered in human units');
});

test('renderWho explains an empty workspace instead of printing a bare header', () => {
  const out = renderWho({ workspaceLabel: 'mesh', agents: [] });
  assert.match(out, /No agents/i);
});

test('renderWho shows a placeholder when an agent has no role', () => {
  const out = renderWho({
    workspaceLabel: 'mesh',
    agents: [{ name: 'claude-1', provider: 'claude', role: null, status: 'working', activity: null, idleMs: 0 }],
  });
  assert.match(out, /claude-1/);
  assert.doesNotMatch(out, /null/, 'null must never reach the user');
});

test('renderDoctor reports a healthy environment', () => {
  const out = renderDoctor({
    nodeVersion: 'v25.8.1',
    nodeOk: true,
    daemonReachable: true,
    socketPath: '/Users/x/.mesh/mesh.sock',
    claudeHooksInstalled: true,
    codexHooksInstalled: true,
    codexSpikeRecorded: true,
  });

  assert.match(out, /v25\.8\.1/);
  assert.match(out, /ok/i);
  assert.doesNotMatch(out, /not installed/i);
});

test('renderDoctor flags each problem it finds', () => {
  const out = renderDoctor({
    nodeVersion: 'v20.0.0',
    nodeOk: false,
    daemonReachable: false,
    socketPath: '/Users/x/.mesh/mesh.sock',
    claudeHooksInstalled: false,
    codexHooksInstalled: false,
    codexSpikeRecorded: false,
  });

  assert.match(out, /22\.6/, 'states the required version');
  assert.match(out, /not running/i);
  assert.match(out, /not installed/i);
  assert.match(out, /mesh init/, 'names the command that fixes it');
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd ~/Projects/mesh && node --test 'test/cli.test.ts'
```

Expected: FAIL — `Cannot find module '../src/cli/who.ts'`.

- [ ] **Step 3: Write the renderers and entry point**

Create `src/cli/who.ts`:

```typescript
export interface WhoAgent {
  name: string;
  provider: string;
  role: string | null;
  status: string;
  activity: string | null;
  idleMs: number;
}

export interface WhoPayload {
  workspaceLabel: string;
  agents: WhoAgent[];
}

export function formatDuration(ms: number): string {
  if (ms < 1000) return 'now';
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  return `${Math.floor(minutes / 60)}h`;
}

function pad(value: string, width: number): string {
  return value.length >= width ? value : value + ' '.repeat(width - value.length);
}

export function renderWho(payload: WhoPayload): string {
  const lines: string[] = [`workspace: ${payload.workspaceLabel}`];

  if (payload.agents.length === 0) {
    lines.push('');
    lines.push('No agents registered here yet.');
    lines.push('Agents join automatically once mesh hooks are installed (`mesh init`).');
    return lines.join('\n');
  }

  const nameWidth = Math.max(...payload.agents.map((a) => a.name.length), 6);
  const roleWidth = Math.max(...payload.agents.map((a) => (a.role ?? '—').length), 4);

  lines.push('');
  for (const agent of payload.agents) {
    const activity = agent.activity ?? (agent.status === 'idle' ? 'idle' : 'starting up');
    lines.push(
      `  ${pad(agent.name, nameWidth)}  ${pad(agent.role ?? '—', roleWidth)}  ` +
        `${pad(agent.status, 8)}  ${pad(formatDuration(agent.idleMs), 5)}  ${activity}`,
    );
  }
  return lines.join('\n');
}
```

Create `src/cli/doctor.ts`:

```typescript
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { meshPaths } from '../paths.ts';
import { MeshClient } from '../client.ts';

export interface DoctorReport {
  nodeVersion: string;
  nodeOk: boolean;
  daemonReachable: boolean;
  socketPath: string;
  claudeHooksInstalled: boolean;
  codexHooksInstalled: boolean;
  codexSpikeRecorded: boolean;
}

function nodeMeetsFloor(version: string): boolean {
  const match = /^v(\d+)\.(\d+)/.exec(version);
  if (!match) return false;
  const major = Number(match[1]);
  const minor = Number(match[2]);
  return major > 22 || (major === 22 && minor >= 6);
}

function fileMentionsMesh(path: string): boolean {
  if (!existsSync(path)) return false;
  try {
    return readFileSync(path, 'utf8').includes('mesh hook');
  } catch {
    return false;
  }
}

export async function collectDoctorReport(): Promise<DoctorReport> {
  const paths = meshPaths();
  const client = await MeshClient.open({ autostart: false, connectTimeoutMs: 500 });
  const daemonReachable = client !== null;
  client?.close();

  return {
    nodeVersion: process.version,
    nodeOk: nodeMeetsFloor(process.version),
    daemonReachable,
    socketPath: paths.socket,
    claudeHooksInstalled: fileMentionsMesh(join(homedir(), '.claude', 'settings.json')),
    codexHooksInstalled: fileMentionsMesh(join(homedir(), '.codex', 'hooks.json')),
    codexSpikeRecorded: existsSync(
      join(homedir(), 'Projects', 'mesh', 'spikes', 'codex-hook-capability', 'FINDINGS.md'),
    ),
  };
}

export function renderDoctor(report: DoctorReport): string {
  const lines: string[] = ['mesh doctor', ''];

  lines.push(
    report.nodeOk
      ? `  node             ok        ${report.nodeVersion}`
      : `  node             PROBLEM   ${report.nodeVersion} — mesh requires >= 22.6 for type stripping`,
  );

  lines.push(
    report.daemonReachable
      ? `  daemon           ok        ${report.socketPath}`
      : `  daemon           not running — starts automatically on first use`,
  );

  lines.push(
    report.claudeHooksInstalled
      ? '  claude hooks     ok        installed in ~/.claude/settings.json'
      : '  claude hooks     not installed — run `mesh init` to wire them up',
  );

  lines.push(
    report.codexHooksInstalled
      ? '  codex hooks      ok        installed in ~/.codex/hooks.json'
      : '  codex hooks      not installed — run `mesh init` to wire them up',
  );

  lines.push(
    report.codexSpikeRecorded
      ? '  codex capability recorded  see spikes/codex-hook-capability/FINDINGS.md'
      : '  codex capability unknown   Phase 0 spike has not been run',
  );

  return lines.join('\n');
}
```

Create `src/cli/index.ts`:

```typescript
#!/usr/bin/env node
import { MeshClient } from '../client.ts';
import { renderWho } from './who.ts';
import type { WhoAgent } from './who.ts';
import { collectDoctorReport, renderDoctor } from './doctor.ts';

const USAGE = `mesh — cross-agent collaboration for terminal coding agents

Usage:
  mesh who        List the agents working in this workspace
  mesh doctor     Report daemon, runtime, and hook installation status
  mesh log        Print the daemon journal
  mesh daemon     Run the daemon in the foreground (normally automatic)
`;

async function cmdWho(): Promise<number> {
  const client = await MeshClient.open();
  if (!client) {
    process.stdout.write('mesh: daemon unreachable — no agents visible\n');
    return 0;
  }
  try {
    const res = await client.request('who', { cwd: process.cwd() });
    if (!res.ok) {
      process.stderr.write(`mesh: ${res.error ?? 'who failed'}\n`);
      return 1;
    }
    process.stdout.write(
      `${renderWho({
        workspaceLabel: String(res.workspaceLabel ?? 'unknown'),
        agents: (res.agents ?? []) as WhoAgent[],
      })}\n`,
    );
    return 0;
  } finally {
    client.close();
  }
}

async function cmdDoctor(): Promise<number> {
  process.stdout.write(`${renderDoctor(await collectDoctorReport())}\n`);
  return 0;
}

async function cmdLog(): Promise<number> {
  const { Journal } = await import('../journal.ts');
  const { meshPaths } = await import('../paths.ts');
  const { systemClock } = await import('../clock.ts');
  for (const entry of new Journal(meshPaths().journal, systemClock).read()) {
    process.stdout.write(`${JSON.stringify(entry)}\n`);
  }
  return 0;
}

export async function main(argv: string[]): Promise<number> {
  const command = argv[2];
  switch (command) {
    case 'who':
      return cmdWho();
    case 'doctor':
      return cmdDoctor();
    case 'log':
      return cmdLog();
    case 'daemon':
      await import('../daemon/main.ts');
      return 0;
    case undefined:
    case '-h':
    case '--help':
      process.stdout.write(USAGE);
      return 0;
    default:
      process.stderr.write(`mesh: unknown command "${command}"\n\n${USAGE}`);
      return 1;
  }
}

process.exitCode = await main(process.argv);
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
cd ~/Projects/mesh && node --test 'test/cli.test.ts' && npm run typecheck
```

Expected: 5 tests pass, typecheck clean.

- [ ] **Step 5: Verify the CLI end to end by hand**

```bash
cd ~/Projects/mesh
chmod +x src/cli/index.ts
node src/cli/index.ts doctor
node src/cli/index.ts who
```

Expected: `doctor` reports node ok, daemon not running (or ok after `who` starts it), both hook sets not installed, and the spike recorded. `who` autostarts the daemon and reports no agents in this workspace.

Now prove the actual Phase 1 goal — two sessions seeing each other:

```bash
cd ~/Projects/mesh
node --input-type=module -e '
import { MeshClient } from "./src/client.ts";
const a = await MeshClient.open();
const b = await MeshClient.open();
await a.request("register", { sessionId: "demo-a", provider: "claude", cwd: process.cwd(), role: "frontend" });
await b.request("register", { sessionId: "demo-b", provider: "codex", cwd: process.cwd(), role: "backend" });
const who = await a.request("who", { cwd: process.cwd() });
console.log(JSON.stringify(who.agents, null, 2));
a.close(); b.close();
'
node src/cli/index.ts who
```

Expected: the inline script prints both `claude-1` and `codex-1`. The follow-up `mesh who` then prints **no agents**, because both connections closed — which is the liveness rule working, not a bug.

- [ ] **Step 6: Run the whole suite**

```bash
cd ~/Projects/mesh && npm test && npm run typecheck
```

Expected: all tests across all files pass, typecheck clean.

- [ ] **Step 7: Commit**

```bash
cd ~/Projects/mesh
git add src/cli/ test/cli.test.ts
git commit -m "$(cat <<'EOF'
Add mesh who and mesh doctor

Rendering is a pure function of data so output is asserted directly rather
than captured from a subprocess. doctor reports hooks as not installed,
which is the honest Phase 1 answer until mesh init lands in Phase 5.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

---

## Plan Self-Review

**Spec coverage for Phases 0–1.** Phase 0 spike → Task 0. Daemon, socket, journal → Tasks 5, 8. Registry and per-workspace naming → Tasks 2, 3, 6. Wire protocol → Task 4. `mesh who`, `mesh doctor`, `mesh log` → Task 10. Connection-as-liveness → Task 8. Socket 0600 and `~/.mesh` 0700 → Tasks 5, 8. Fail-open → Task 9. Autostart and idle shutdown → Tasks 8, 9.

**Deferred to later plans, by design:** `mesh mcp` and all `mesh_*` tools (Phase 2), claims and `PreToolUse` enforcement (Phase 3), tasks and `mesh board` (Phase 4), `mesh init`, `mesh watch`, and the latency benchmark (Phase 5), real-agent e2e (Phase 6). The `MAX_BODY_BYTES` cap is defined in Task 4 and first enforced in Phase 2, where the first body-carrying op appears.

**Type consistency.** `Clock` is `() => number` throughout, and every consumer takes `clock.now` (the function), never the `TestClock` wrapper. `Workspace` carries `{root,label,key}` in Tasks 3, 6, 7. `Response` is `{id, ok, error?, ...}` in Tasks 4, 7, 9. `ConnectionContext` gains `requestShutdown` in Task 9 Step 3 before Task 9's client test relies on the `shutdown` op. `Registry.list()` returns `AgentView[]` with `status`/`idleMs`, which is exactly what the `who` handler projects and what `WhoAgent` in Task 10 consumes.

**Known ordering note.** Task 9 modifies two files created in Tasks 7 and 8. This is deliberate — the `shutdown` op exists only because autostart needs a way to stop a daemon it spawned, so it is introduced where that need first appears rather than speculatively earlier.
