# mesh Phase 2: Messaging, MCP Server, and the Hook Shim — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let one agent send a message to another, and ask a blocking question that the other answers in-turn — delivered through hook context injection, driven through MCP tools.

**Architecture:** Two new pure state modules (`Mailbox`, `AskRegistry`) sit beside the existing `Registry`, all clock-injected and timer-free. `handleRequest` becomes async so a blocking `ask` can await its answer without stalling other connections. Two new client surfaces talk to the daemon: an MCP stdio server that gives agents their tools, and a dependency-free hook shim that reports activity and injects anything addressed to the agent.

**Tech Stack:** Node 25 (>= 22.6), TypeScript with native type-stripping, `node:test`, `@modelcontextprotocol/sdk` 1.29 + `zod` 4 (MCP server only), `node:net`/`node:fs` (everything else).

## Global Constraints

Carried from Plan 1, plus Phase 2 additions. Every task inherits these.

- Node >= 22.6. TypeScript must be **erasable-syntax-only**. ESM only, explicit `.ts` extensions on relative imports.
- **The hook shim must never import `@modelcontextprotocol/sdk` or `zod`.** Measured on this machine: bare `node` + `node:net` starts in **50–60ms**; adding the SDK import makes it **100ms**. The hook runs before every tool call, so it imports `node:net`, `node:fs`, and mesh's own dependency-free modules — nothing else. A test asserts this.
- **Revised latency budget.** The spec's "p95 < 30ms" is unachievable: Node's own startup floor is ~50ms. The real budget is **p95 < 90ms total for the hook, of which mesh's own work is < 15ms**. Node startup dominates; a native shim is the only way below that, and it is out of scope. Update the spec accordingly (Task 9).
- **Fail-open is absolute.** Any hook failure — daemon down, socket timeout, malformed input, unexpected throw — exits 0 having printed `{}`. The hook must never block or break the user's agent.
- **Hook stdin discipline (Phase 0 findings).** Read stdin with a deadline, never blockingly; then `pause()` **and** `destroy()`. Exit only from the `process.stdout.write` callback. A bare `process.exit()` truncates unflushed output; a blocking read deadlocks the host. Both are regression-tested.
- **Claude and Codex share one hook output shape** — verified in Phase 0. `{"hookSpecificOutput": {"hookEventName": "<event>", "additionalContext": "..."}}`. No per-host compat layer.
- Message and task bodies capped at `MAX_BODY_BYTES` (4096), enforced on entry.
- All time-dependent logic takes an injected `Clock`. Pure modules never create timers — real timeouts live in the daemon layer.
- Socket mode `0600`, mesh home `0700`.
- Commit messages end with `Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>`.

## File Structure

| Path | Responsibility |
|---|---|
| `src/mailbox.ts` | Per-agent message queue; deliver, peek, drain |
| `src/asks.ts` | Pending questions: create, answer, expire, deadlock + rate-limit rules |
| `src/daemon/handlers.ts` | *(modify)* async dispatch; add `send`/`inbox`/`ask`/`reply` |
| `src/daemon/server.ts` | *(modify)* await async handlers |
| `src/daemon/waiters.ts` | Real timers + promise resolution for blocking asks |
| `src/hook.ts` | Hook shim core: bounded stdin, event handling, output shaping |
| `src/cli/index.ts` | *(modify)* add the `mesh hook <event>` subcommand |
| `src/mcp/server.ts` | MCP stdio server exposing the `mesh_*` tools |
| `test/mailbox.test.ts`, `test/asks.test.ts`, `test/messaging.test.ts`, `test/hook.test.ts`, `test/mcp.test.ts` | One per module, plus an end-to-end ask round-trip |

`Mailbox` and `AskRegistry` never touch sockets or timers. `waiters.ts` exists precisely so the timing concern has one home instead of leaking into either.

---

### Task 1: Mailbox

**Files:**
- Create: `src/mailbox.ts`
- Test: `test/mailbox.test.ts`

**Interfaces:**
- Consumes: `Clock` from `src/clock.ts`, `MAX_BODY_BYTES` from `src/protocol.ts`.
- Produces:
  - `type EnvelopeKind = 'message' | 'ask' | 'reply'`
  - `interface Envelope { id: number; kind: EnvelopeKind; from: string; to: string; body: string; at: number; askId: number | null }`
  - `interface DeliverInput { kind: EnvelopeKind; from: string; to: string; body: string; askId?: number }`
  - `function validateBody(body: unknown): string` — returns the trimmed body or throws `RangeError`.
  - `class Mailbox { constructor(o: { clock: Clock }); deliver(i: DeliverInput): Envelope; peek(agent: string): Envelope[]; drain(agent: string): Envelope[]; pendingCount(agent: string): number; clear(agent: string): void }`

`drain` removes; `peek` does not. The hook peeks when deciding whether to inject and drains once it has committed the text to output — a drain that happened before the write could lose messages if the write failed.

- [ ] **Step 1: Write the failing test**

Create `test/mailbox.test.ts`:

```typescript
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { testClock } from '../src/clock.ts';
import { Mailbox, validateBody } from '../src/mailbox.ts';
import { MAX_BODY_BYTES } from '../src/protocol.ts';

test('validateBody trims and accepts ordinary text', () => {
  assert.equal(validateBody('  hello  '), 'hello');
});

test('validateBody rejects empty, non-string, and oversized bodies', () => {
  assert.throws(() => validateBody(''), RangeError);
  assert.throws(() => validateBody('   '), RangeError);
  assert.throws(() => validateBody(42), RangeError);
  assert.throws(() => validateBody('x'.repeat(MAX_BODY_BYTES + 1)), RangeError);
});

test('validateBody measures bytes, not characters', () => {
  // Each emoji is 4 bytes, so this is over the cap despite being far
  // fewer than MAX_BODY_BYTES characters.
  const emoji = '🙂'.repeat(MAX_BODY_BYTES / 2);
  assert.throws(() => validateBody(emoji), RangeError);
});

test('delivers a message and stamps it with id and clock time', () => {
  const clock = testClock(1000);
  const box = new Mailbox({ clock: clock.now });

  const env = box.deliver({ kind: 'message', from: 'claude-1', to: 'codex-2', body: 'hi' });
  assert.equal(env.id, 1);
  assert.equal(env.at, 1000);
  assert.equal(env.kind, 'message');
  assert.equal(env.askId, null);
});

test('ids increment across all recipients', () => {
  const box = new Mailbox({ clock: testClock().now });
  const a = box.deliver({ kind: 'message', from: 'x', to: 'a', body: '1' });
  const b = box.deliver({ kind: 'message', from: 'x', to: 'b', body: '2' });
  assert.equal(b.id, a.id + 1);
});

test('peek is non-destructive, drain removes', () => {
  const box = new Mailbox({ clock: testClock().now });
  box.deliver({ kind: 'message', from: 'claude-1', to: 'codex-2', body: 'one' });
  box.deliver({ kind: 'message', from: 'claude-1', to: 'codex-2', body: 'two' });

  assert.equal(box.peek('codex-2').length, 2);
  assert.equal(box.peek('codex-2').length, 2, 'peek must not consume');

  const drained = box.drain('codex-2');
  assert.deepEqual(drained.map((e) => e.body), ['one', 'two']);
  assert.deepEqual(box.drain('codex-2'), [], 'second drain is empty');
});

test('mail is kept per recipient', () => {
  const box = new Mailbox({ clock: testClock().now });
  box.deliver({ kind: 'message', from: 'a', to: 'codex-2', body: 'for codex' });
  box.deliver({ kind: 'message', from: 'a', to: 'fable-3', body: 'for fable' });

  assert.deepEqual(box.drain('codex-2').map((e) => e.body), ['for codex']);
  assert.deepEqual(box.drain('fable-3').map((e) => e.body), ['for fable']);
});

test('pendingCount reports without consuming', () => {
  const box = new Mailbox({ clock: testClock().now });
  assert.equal(box.pendingCount('codex-2'), 0);
  box.deliver({ kind: 'message', from: 'a', to: 'codex-2', body: 'x' });
  assert.equal(box.pendingCount('codex-2'), 1);
  assert.equal(box.pendingCount('codex-2'), 1);
});

test('ask envelopes carry their askId, plain messages do not', () => {
  const box = new Mailbox({ clock: testClock().now });
  const ask = box.deliver({ kind: 'ask', from: 'a', to: 'b', body: 'q?', askId: 7 });
  assert.equal(ask.askId, 7);
  assert.equal(ask.kind, 'ask');
});

test('deliver rejects an invalid body before queueing anything', () => {
  const box = new Mailbox({ clock: testClock().now });
  assert.throws(() => box.deliver({ kind: 'message', from: 'a', to: 'b', body: '' }), RangeError);
  assert.equal(box.pendingCount('b'), 0, 'nothing was queued');
});

test('clear empties one recipient only', () => {
  const box = new Mailbox({ clock: testClock().now });
  box.deliver({ kind: 'message', from: 'a', to: 'b', body: 'x' });
  box.deliver({ kind: 'message', from: 'a', to: 'c', body: 'y' });
  box.clear('b');
  assert.equal(box.pendingCount('b'), 0);
  assert.equal(box.pendingCount('c'), 1);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd ~/Projects/mesh && node --test 'test/mailbox.test.ts'`
Expected: FAIL — `Cannot find module '../src/mailbox.ts'`.

- [ ] **Step 3: Write minimal implementation**

Create `src/mailbox.ts`:

```typescript
import type { Clock } from './clock.ts';
import { MAX_BODY_BYTES } from './protocol.ts';

export type EnvelopeKind = 'message' | 'ask' | 'reply';

export interface Envelope {
  id: number;
  kind: EnvelopeKind;
  from: string;
  to: string;
  body: string;
  at: number;
  askId: number | null;
}

export interface DeliverInput {
  kind: EnvelopeKind;
  from: string;
  to: string;
  body: string;
  askId?: number;
}

/**
 * Bodies are capped in BYTES, not characters — a message of emoji is four
 * times its length in bytes, and the cap exists to bound what one agent can
 * push into another's context.
 */
export function validateBody(body: unknown): string {
  if (typeof body !== 'string') throw new RangeError('Body must be a string');
  const trimmed = body.trim();
  if (trimmed.length === 0) throw new RangeError('Body must not be empty');
  if (Buffer.byteLength(trimmed, 'utf8') > MAX_BODY_BYTES) {
    throw new RangeError(`Body exceeds ${MAX_BODY_BYTES} bytes`);
  }
  return trimmed;
}

export class Mailbox {
  #clock: Clock;
  #queues = new Map<string, Envelope[]>();
  #nextId = 1;

  constructor(options: { clock: Clock }) {
    this.#clock = options.clock;
  }

  deliver(input: DeliverInput): Envelope {
    // Validate before mutating: a rejected message must leave no trace.
    const body = validateBody(input.body);
    const envelope: Envelope = {
      id: this.#nextId++,
      kind: input.kind,
      from: input.from,
      to: input.to,
      body,
      at: this.#clock(),
      askId: input.askId ?? null,
    };
    const queue = this.#queues.get(input.to);
    if (queue) queue.push(envelope);
    else this.#queues.set(input.to, [envelope]);
    return envelope;
  }

  peek(agent: string): Envelope[] {
    return [...(this.#queues.get(agent) ?? [])];
  }

  drain(agent: string): Envelope[] {
    const queue = this.#queues.get(agent);
    if (!queue || queue.length === 0) return [];
    this.#queues.set(agent, []);
    return queue;
  }

  pendingCount(agent: string): number {
    return this.#queues.get(agent)?.length ?? 0;
  }

  clear(agent: string): void {
    this.#queues.set(agent, []);
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd ~/Projects/mesh && node --test 'test/mailbox.test.ts' && npm run typecheck`
Expected: 11 tests pass, typecheck clean.

- [ ] **Step 5: Commit**

```bash
cd ~/Projects/mesh
git add src/mailbox.ts test/mailbox.test.ts
git commit -m "$(cat <<'EOF'
Add per-agent mailbox

Bodies are capped in bytes rather than characters, so a message of emoji
cannot smuggle four times the intended payload into a peer's context.
peek is separate from drain because the hook must not consume messages
until it has committed them to its output.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 2: Ask registry

**Files:**
- Create: `src/asks.ts`
- Test: `test/asks.test.ts`

**Interfaces:**
- Consumes: `Clock`, `validateBody` from `src/mailbox.ts`.
- Produces:
  - `type AskState = 'pending' | 'answered' | 'timeout' | 'cancelled'`
  - `interface Ask { id: number; from: string; to: string; body: string; createdAt: number; deadline: number; state: AskState; answer: string | null }`
  - `type CreateResult = { ok: true; ask: Ask } | { ok: false; code: 'self' | 'deadlock' | 'rate-limit' | 'too-many-open' | 'bad-body'; error: string }`
  - `class AskRegistry { constructor(o: { clock: Clock; maxPerMinute?: number; maxOpenPerAgent?: number }); create(i: { from: string; to: string; body: string; timeoutMs: number }): CreateResult; answer(askId: number, from: string, answer: string): { ok: boolean; error?: string; ask?: Ask }; expire(): Ask[]; get(id: number): Ask | undefined; pendingFor(agent: string): Ask[]; waitingOn(agent: string): Ask[]; wouldDeadlock(from: string, to: string): boolean }`

No timers here. `expire()` is called by the daemon; the registry only knows the clock it was given.

Deadlock detection walks the full pending-ask graph, not just the two-agent case: if A is waiting on B and B is waiting on C, C asking A would hang all three.

- [ ] **Step 1: Write the failing test**

Create `test/asks.test.ts`:

```typescript
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { testClock } from '../src/clock.ts';
import { AskRegistry } from '../src/asks.ts';

function setup(overrides: { maxPerMinute?: number; maxOpenPerAgent?: number } = {}) {
  const clock = testClock(1000);
  return { clock, asks: new AskRegistry({ clock: clock.now, ...overrides }) };
}

test('creates a pending ask with a deadline derived from the clock', () => {
  const { asks } = setup();
  const result = asks.create({ from: 'claude-1', to: 'codex-2', body: 'ready?', timeoutMs: 90_000 });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.ask.state, 'pending');
  assert.equal(result.ask.createdAt, 1000);
  assert.equal(result.ask.deadline, 91_000);
});

test('refuses an ask addressed to yourself', () => {
  const { asks } = setup();
  const result = asks.create({ from: 'claude-1', to: 'claude-1', body: 'hi', timeoutMs: 1000 });
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.code, 'self');
});

test('rejects an invalid body without creating an ask', () => {
  const { asks } = setup();
  const result = asks.create({ from: 'a', to: 'b', body: '   ', timeoutMs: 1000 });
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.code, 'bad-body');
  assert.deepEqual(asks.pendingFor('b'), []);
});

test('answering resolves the ask and records the answer', () => {
  const { asks } = setup();
  const created = asks.create({ from: 'claude-1', to: 'codex-2', body: 'q?', timeoutMs: 1000 });
  assert.equal(created.ok, true);
  if (!created.ok) return;

  const res = asks.answer(created.ask.id, 'codex-2', 'yes');
  assert.equal(res.ok, true);
  assert.equal(asks.get(created.ask.id)?.state, 'answered');
  assert.equal(asks.get(created.ask.id)?.answer, 'yes');
});

test('only the addressee may answer', () => {
  const { asks } = setup();
  const created = asks.create({ from: 'claude-1', to: 'codex-2', body: 'q?', timeoutMs: 1000 });
  if (!created.ok) return;

  const res = asks.answer(created.ask.id, 'fable-3', 'butting in');
  assert.equal(res.ok, false);
  assert.match(String(res.error), /addressed/);
  assert.equal(asks.get(created.ask.id)?.state, 'pending');
});

test('an ask cannot be answered twice', () => {
  const { asks } = setup();
  const created = asks.create({ from: 'a', to: 'b', body: 'q?', timeoutMs: 1000 });
  if (!created.ok) return;

  assert.equal(asks.answer(created.ask.id, 'b', 'first').ok, true);
  const second = asks.answer(created.ask.id, 'b', 'second');
  assert.equal(second.ok, false);
  assert.equal(asks.get(created.ask.id)?.answer, 'first');
});

test('answering an unknown ask fails cleanly', () => {
  const { asks } = setup();
  assert.equal(asks.answer(999, 'b', 'x').ok, false);
});

test('expire moves only past-deadline pending asks to timeout', () => {
  const { clock, asks } = setup();
  const soon = asks.create({ from: 'a', to: 'b', body: 'soon', timeoutMs: 1000 });
  const later = asks.create({ from: 'a', to: 'c', body: 'later', timeoutMs: 10_000 });
  if (!soon.ok || !later.ok) return;

  clock.advance(1001);
  const expired = asks.expire();
  assert.deepEqual(expired.map((a) => a.id), [soon.ask.id]);
  assert.equal(asks.get(soon.ask.id)?.state, 'timeout');
  assert.equal(asks.get(later.ask.id)?.state, 'pending');
});

test('expire does not re-expire an already answered ask', () => {
  const { clock, asks } = setup();
  const created = asks.create({ from: 'a', to: 'b', body: 'q', timeoutMs: 1000 });
  if (!created.ok) return;
  asks.answer(created.ask.id, 'b', 'done');

  clock.advance(5000);
  assert.deepEqual(asks.expire(), []);
  assert.equal(asks.get(created.ask.id)?.state, 'answered');
});

test('pendingFor lists asks awaiting an agent, waitingOn lists what blocks it', () => {
  const { asks } = setup();
  asks.create({ from: 'claude-1', to: 'codex-2', body: 'q1', timeoutMs: 1000 });

  assert.deepEqual(asks.pendingFor('codex-2').map((a) => a.body), ['q1']);
  assert.deepEqual(asks.waitingOn('claude-1').map((a) => a.body), ['q1']);
  assert.deepEqual(asks.pendingFor('claude-1'), []);
});

test('detects a direct two-agent deadlock', () => {
  const { asks } = setup();
  asks.create({ from: 'claude-1', to: 'codex-2', body: 'q1', timeoutMs: 60_000 });

  assert.equal(asks.wouldDeadlock('codex-2', 'claude-1'), true);
  const blocked = asks.create({ from: 'codex-2', to: 'claude-1', body: 'q2', timeoutMs: 60_000 });
  assert.equal(blocked.ok, false);
  if (blocked.ok) return;
  assert.equal(blocked.code, 'deadlock');
  assert.match(blocked.error, /already waiting on you/);
});

test('detects a three-agent cycle', () => {
  const { asks } = setup();
  asks.create({ from: 'a', to: 'b', body: 'q', timeoutMs: 60_000 });
  asks.create({ from: 'b', to: 'c', body: 'q', timeoutMs: 60_000 });

  assert.equal(asks.wouldDeadlock('c', 'a'), true, 'c→a closes the a→b→c chain');
  assert.equal(asks.wouldDeadlock('c', 'b'), true, 'c→b closes b→c');
  assert.equal(asks.wouldDeadlock('a', 'c'), false, 'a→c adds no cycle');
});

test('an answered ask no longer contributes to a deadlock', () => {
  const { asks } = setup();
  const first = asks.create({ from: 'a', to: 'b', body: 'q', timeoutMs: 60_000 });
  if (!first.ok) return;
  assert.equal(asks.wouldDeadlock('b', 'a'), true);

  asks.answer(first.ask.id, 'b', 'done');
  assert.equal(asks.wouldDeadlock('b', 'a'), false);
});

test('enforces a per-minute ask rate limit', () => {
  const { clock, asks } = setup({ maxPerMinute: 2 });
  assert.equal(asks.create({ from: 'a', to: 'b', body: '1', timeoutMs: 100 }).ok, true);
  assert.equal(asks.create({ from: 'a', to: 'c', body: '2', timeoutMs: 100 }).ok, true);

  const third = asks.create({ from: 'a', to: 'd', body: '3', timeoutMs: 100 });
  assert.equal(third.ok, false);
  if (third.ok) return;
  assert.equal(third.code, 'rate-limit');

  clock.advance(60_001);
  assert.equal(asks.create({ from: 'a', to: 'd', body: '4', timeoutMs: 100 }).ok, true);
});

test('the rate limit is per asker', () => {
  const { asks } = setup({ maxPerMinute: 1 });
  assert.equal(asks.create({ from: 'a', to: 'x', body: '1', timeoutMs: 100 }).ok, true);
  assert.equal(asks.create({ from: 'b', to: 'x', body: '1', timeoutMs: 100 }).ok, true);
  assert.equal(asks.create({ from: 'a', to: 'x', body: '2', timeoutMs: 100 }).ok, false);
});

test('caps how many open asks one agent may be holding', () => {
  const { asks } = setup({ maxOpenPerAgent: 2, maxPerMinute: 100 });
  asks.create({ from: 'a', to: 'target', body: '1', timeoutMs: 60_000 });
  asks.create({ from: 'b', to: 'target', body: '2', timeoutMs: 60_000 });

  const third = asks.create({ from: 'c', to: 'target', body: '3', timeoutMs: 60_000 });
  assert.equal(third.ok, false);
  if (third.ok) return;
  assert.equal(third.code, 'too-many-open');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd ~/Projects/mesh && node --test 'test/asks.test.ts'`
Expected: FAIL — `Cannot find module '../src/asks.ts'`.

- [ ] **Step 3: Write minimal implementation**

Create `src/asks.ts`:

```typescript
import type { Clock } from './clock.ts';
import { validateBody } from './mailbox.ts';

export type AskState = 'pending' | 'answered' | 'timeout' | 'cancelled';

export interface Ask {
  id: number;
  from: string;
  to: string;
  body: string;
  createdAt: number;
  deadline: number;
  state: AskState;
  answer: string | null;
}

export type CreateResult =
  | { ok: true; ask: Ask }
  | {
      ok: false;
      code: 'self' | 'deadlock' | 'rate-limit' | 'too-many-open' | 'bad-body';
      error: string;
    };

export interface AskRegistryOptions {
  clock: Clock;
  /** Asks one agent may start per rolling minute. */
  maxPerMinute?: number;
  /** Unanswered asks one agent may be holding at once. */
  maxOpenPerAgent?: number;
}

const DEFAULT_MAX_PER_MINUTE = 10;
const DEFAULT_MAX_OPEN_PER_AGENT = 5;
const RATE_WINDOW_MS = 60_000;

export class AskRegistry {
  #clock: Clock;
  #maxPerMinute: number;
  #maxOpenPerAgent: number;
  #asks = new Map<number, Ask>();
  #recent = new Map<string, number[]>();
  #nextId = 1;

  constructor(options: AskRegistryOptions) {
    this.#clock = options.clock;
    this.#maxPerMinute = options.maxPerMinute ?? DEFAULT_MAX_PER_MINUTE;
    this.#maxOpenPerAgent = options.maxOpenPerAgent ?? DEFAULT_MAX_OPEN_PER_AGENT;
  }

  #pending(): Ask[] {
    return [...this.#asks.values()].filter((a) => a.state === 'pending');
  }

  /**
   * True when from→to would close a cycle in the pending-ask graph. Walks the
   * whole chain, not just the direct case: if A waits on B and B waits on C,
   * then C asking A hangs all three.
   */
  wouldDeadlock(from: string, to: string): boolean {
    const edges = new Map<string, string[]>();
    for (const ask of this.#pending()) {
      const list = edges.get(ask.from);
      if (list) list.push(ask.to);
      else edges.set(ask.from, [ask.to]);
    }

    // Reachable from `to` following existing waits. If that reaches `from`,
    // adding from→to closes a loop.
    const seen = new Set<string>();
    const stack = [to];
    while (stack.length > 0) {
      const current = stack.pop() as string;
      if (current === from) return true;
      if (seen.has(current)) continue;
      seen.add(current);
      for (const next of edges.get(current) ?? []) stack.push(next);
    }
    return false;
  }

  #rateExceeded(from: string): boolean {
    const now = this.#clock();
    const recent = (this.#recent.get(from) ?? []).filter((at) => now - at < RATE_WINDOW_MS);
    this.#recent.set(from, recent);
    return recent.length >= this.#maxPerMinute;
  }

  create(input: { from: string; to: string; body: string; timeoutMs: number }): CreateResult {
    if (input.from === input.to) {
      return { ok: false, code: 'self', error: 'An agent cannot ask itself' };
    }

    let body: string;
    try {
      body = validateBody(input.body);
    } catch (error) {
      return { ok: false, code: 'bad-body', error: (error as Error).message };
    }

    if (this.wouldDeadlock(input.from, input.to)) {
      return {
        ok: false,
        code: 'deadlock',
        error: `Deadlock: ${input.to} is already waiting on you. Answer that first.`,
      };
    }

    if (this.#rateExceeded(input.from)) {
      return {
        ok: false,
        code: 'rate-limit',
        error: `Rate limit: at most ${this.#maxPerMinute} asks per minute`,
      };
    }

    if (this.pendingFor(input.to).length >= this.#maxOpenPerAgent) {
      return {
        ok: false,
        code: 'too-many-open',
        error: `${input.to} already has ${this.#maxOpenPerAgent} unanswered questions`,
      };
    }

    const now = this.#clock();
    const ask: Ask = {
      id: this.#nextId++,
      from: input.from,
      to: input.to,
      body,
      createdAt: now,
      deadline: now + input.timeoutMs,
      state: 'pending',
      answer: null,
    };
    this.#asks.set(ask.id, ask);
    this.#recent.set(input.from, [...(this.#recent.get(input.from) ?? []), now]);
    return { ok: true, ask };
  }

  answer(askId: number, from: string, answer: string): { ok: boolean; error?: string; ask?: Ask } {
    const ask = this.#asks.get(askId);
    if (!ask) return { ok: false, error: `No such ask: ${askId}` };
    if (ask.state !== 'pending') return { ok: false, error: `Ask ${askId} is already ${ask.state}` };
    if (ask.to !== from) {
      return { ok: false, error: `Ask ${askId} is addressed to ${ask.to}, not ${from}` };
    }

    let body: string;
    try {
      body = validateBody(answer);
    } catch (error) {
      return { ok: false, error: (error as Error).message };
    }

    ask.state = 'answered';
    ask.answer = body;
    return { ok: true, ask };
  }

  /** Moves past-deadline pending asks to timeout. Called by the daemon. */
  expire(): Ask[] {
    const now = this.#clock();
    const expired: Ask[] = [];
    for (const ask of this.#asks.values()) {
      if (ask.state === 'pending' && ask.deadline <= now) {
        ask.state = 'timeout';
        expired.push(ask);
      }
    }
    return expired;
  }

  get(id: number): Ask | undefined {
    return this.#asks.get(id);
  }

  /** Questions this agent has been asked and has not answered. */
  pendingFor(agent: string): Ask[] {
    return this.#pending().filter((a) => a.to === agent);
  }

  /** Questions this agent is blocked waiting on. */
  waitingOn(agent: string): Ask[] {
    return this.#pending().filter((a) => a.from === agent);
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd ~/Projects/mesh && node --test 'test/asks.test.ts' && npm run typecheck`
Expected: 16 tests pass, typecheck clean.

- [ ] **Step 5: Commit**

```bash
cd ~/Projects/mesh
git add src/asks.ts test/asks.test.ts
git commit -m "$(cat <<'EOF'
Add ask registry with deadlock and rate limiting

Deadlock detection walks the whole pending-ask graph rather than only the
two-agent case, so an A→B→C→A chain is refused at creation instead of
hanging three sessions. No timers here: expire() is driven by the daemon,
which keeps the module testable without sleeps.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 3: Async handlers with send and inbox

**Files:**
- Modify: `src/daemon/handlers.ts`, `src/daemon/server.ts`
- Test: `test/messaging.test.ts`

**Interfaces:**
- Consumes: `Mailbox`, `AskRegistry`, existing `DaemonState`.
- Produces:
  - `DaemonState` gains `mailbox: Mailbox` and `asks: AskRegistry`.
  - `handleRequest` becomes `async`, returning `Promise<Response>`.
  - Ops `send` (params `sessionId?`, `to`, `body`; `to: "*"` broadcasts) and `inbox` (params `sessionId?`, `drain?: boolean`).

Making `handleRequest` async is what lets Task 4's blocking `ask` await an answer without stalling other connections — each connection is handled independently, so one agent waiting never freezes another.

- [ ] **Step 1: Write the failing test**

Create `test/messaging.test.ts`:

```typescript
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { testClock } from '../src/clock.ts';
import { Registry } from '../src/registry.ts';
import { Journal } from '../src/journal.ts';
import { Mailbox } from '../src/mailbox.ts';
import { AskRegistry } from '../src/asks.ts';
import { handleRequest } from '../src/daemon/handlers.ts';
import type { ConnectionContext, DaemonState } from '../src/daemon/handlers.ts';

function setup() {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'mesh-msg-')));
  const clock = testClock(1000);
  const state: DaemonState = {
    clock: clock.now,
    registry: new Registry({ clock: clock.now }),
    journal: new Journal(join(base, 'journal.jsonl'), clock.now),
    mailbox: new Mailbox({ clock: clock.now }),
    asks: new AskRegistry({ clock: clock.now }),
  };
  return { base, clock, state, cleanup: () => rmSync(base, { recursive: true, force: true }) };
}

function ctx(): ConnectionContext {
  return { sessionId: null };
}

async function register(state: DaemonState, c: ConnectionContext, sessionId: string, provider: string, cwd: string) {
  return handleRequest(state, c, { id: 1, op: 'register', sessionId, provider, cwd });
}

test('send delivers to a named peer in the same workspace', async () => {
  const { base, state, cleanup } = setup();
  try {
    const a = ctx();
    const b = ctx();
    await register(state, a, 'sa', 'claude', base);
    await register(state, b, 'sb', 'codex', base);

    const sent = await handleRequest(state, a, { id: 2, op: 'send', to: 'codex-1', body: 'hello' });
    assert.equal(sent.ok, true);
    assert.equal(sent.delivered, 1);

    const inbox = await handleRequest(state, b, { id: 3, op: 'inbox' });
    const messages = inbox.messages as Array<Record<string, unknown>>;
    assert.equal(messages.length, 1);
    assert.equal(messages[0]?.body, 'hello');
    assert.equal(messages[0]?.from, 'claude-1');
  } finally {
    cleanup();
  }
});

test('inbox drains by default so a message is delivered once', async () => {
  const { base, state, cleanup } = setup();
  try {
    const a = ctx();
    const b = ctx();
    await register(state, a, 'sa', 'claude', base);
    await register(state, b, 'sb', 'codex', base);
    await handleRequest(state, a, { id: 2, op: 'send', to: 'codex-1', body: 'once' });

    const first = await handleRequest(state, b, { id: 3, op: 'inbox' });
    assert.equal((first.messages as unknown[]).length, 1);
    const second = await handleRequest(state, b, { id: 4, op: 'inbox' });
    assert.equal((second.messages as unknown[]).length, 0);
  } finally {
    cleanup();
  }
});

test('inbox with drain false leaves messages queued', async () => {
  const { base, state, cleanup } = setup();
  try {
    const a = ctx();
    const b = ctx();
    await register(state, a, 'sa', 'claude', base);
    await register(state, b, 'sb', 'codex', base);
    await handleRequest(state, a, { id: 2, op: 'send', to: 'codex-1', body: 'peek me' });

    const peeked = await handleRequest(state, b, { id: 3, op: 'inbox', drain: false });
    assert.equal((peeked.messages as unknown[]).length, 1);
    const again = await handleRequest(state, b, { id: 4, op: 'inbox', drain: false });
    assert.equal((again.messages as unknown[]).length, 1, 'peek did not consume');
  } finally {
    cleanup();
  }
});

test('send to "*" broadcasts to every peer but not the sender', async () => {
  const { base, state, cleanup } = setup();
  try {
    const a = ctx();
    const b = ctx();
    const c = ctx();
    await register(state, a, 'sa', 'claude', base);
    await register(state, b, 'sb', 'codex', base);
    await register(state, c, 'sc', 'fable', base);

    const sent = await handleRequest(state, a, { id: 2, op: 'send', to: '*', body: 'all hands' });
    assert.equal(sent.delivered, 2);

    assert.equal((((await handleRequest(state, b, { id: 3, op: 'inbox' })).messages) as unknown[]).length, 1);
    assert.equal((((await handleRequest(state, c, { id: 4, op: 'inbox' })).messages) as unknown[]).length, 1);
    assert.equal((((await handleRequest(state, a, { id: 5, op: 'inbox' })).messages) as unknown[]).length, 0);
  } finally {
    cleanup();
  }
});

test('send to an unknown peer reports undeliverable', async () => {
  const { base, state, cleanup } = setup();
  try {
    const a = ctx();
    await register(state, a, 'sa', 'claude', base);
    const sent = await handleRequest(state, a, { id: 2, op: 'send', to: 'nobody-9', body: 'x' });
    assert.equal(sent.ok, false);
    assert.match(String(sent.error), /nobody-9/);
  } finally {
    cleanup();
  }
});

test('send resolves a target by role as well as by name', async () => {
  const { base, state, cleanup } = setup();
  try {
    const a = ctx();
    const b = ctx();
    await register(state, a, 'sa', 'claude', base);
    await handleRequest(state, b, { id: 1, op: 'register', sessionId: 'sb', provider: 'codex', cwd: base, role: 'backend' });

    const sent = await handleRequest(state, a, { id: 2, op: 'send', to: 'backend', body: 'via role' });
    assert.equal(sent.ok, true);
    assert.equal(sent.delivered, 1);
  } finally {
    cleanup();
  }
});

test('send rejects an oversized body', async () => {
  const { base, state, cleanup } = setup();
  try {
    const a = ctx();
    const b = ctx();
    await register(state, a, 'sa', 'claude', base);
    await register(state, b, 'sb', 'codex', base);

    const sent = await handleRequest(state, a, { id: 2, op: 'send', to: 'codex-1', body: 'x'.repeat(5000) });
    assert.equal(sent.ok, false);
    assert.match(String(sent.error), /exceeds/);
  } finally {
    cleanup();
  }
});

test('send requires a registered sender', async () => {
  const { base, state, cleanup } = setup();
  try {
    const stranger = ctx();
    const sent = await handleRequest(state, stranger, { id: 2, op: 'send', to: 'anyone', body: 'x' });
    assert.equal(sent.ok, false);
    assert.match(String(sent.error), /register/i);
    void base;
  } finally {
    cleanup();
  }
});

test('messages do not cross workspaces', async () => {
  const { base, state, cleanup } = setup();
  const other = realpathSync(mkdtempSync(join(tmpdir(), 'mesh-msg-other-')));
  try {
    const a = ctx();
    const b = ctx();
    await register(state, a, 'sa', 'claude', base);
    await register(state, b, 'sb', 'claude', other);

    // Both are claude-1, but in different workspaces.
    const sent = await handleRequest(state, a, { id: 2, op: 'send', to: 'claude-1', body: 'x' });
    assert.equal(sent.ok, false, 'the only claude-1 in this workspace is the sender');
  } finally {
    rmSync(other, { recursive: true, force: true });
    cleanup();
  }
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd ~/Projects/mesh && node --test 'test/messaging.test.ts'`
Expected: FAIL — `Mailbox`/`asks` are not on `DaemonState`, and `send` is an unknown op.

- [ ] **Step 3: Extend DaemonState and make dispatch async**

In `src/daemon/handlers.ts`, replace the imports and `DaemonState` interface:

```typescript
import type { Clock } from '../clock.ts';
import type { Journal } from '../journal.ts';
import type { Registry } from '../registry.ts';
import type { Response } from '../protocol.ts';
import { resolveWorkspace } from '../workspace.ts';
import { Mailbox } from '../mailbox.ts';
import { AskRegistry } from '../asks.ts';

export interface DaemonState {
  registry: Registry;
  journal: Journal;
  clock: Clock;
  mailbox: Mailbox;
  asks: AskRegistry;
}
```

Change the signature line from `export function handleRequest(` to:

```typescript
export async function handleRequest(
  state: DaemonState,
  ctx: ConnectionContext,
  request: unknown,
): Promise<Response> {
```

Add this helper above `handleRequest`, which every messaging op uses to find out who is calling:

```typescript
/**
 * The agent behind this connection. Messaging ops need a sender identity, and
 * an unregistered connection has none.
 */
function callerOf(
  state: DaemonState,
  ctx: ConnectionContext,
  req: Record<string, unknown>,
): { name: string; workspaceRoot: string } | null {
  const sessionId = readString(req, 'sessionId') ?? ctx.sessionId;
  if (!sessionId) return null;
  const agent = state.registry.get(sessionId);
  if (!agent) return null;
  return { name: agent.name, workspaceRoot: agent.workspaceRoot };
}

/** Resolves a target string to agent names: a name, a role, or "*". */
function resolveTargets(
  state: DaemonState,
  workspaceRoot: string,
  senderName: string,
  target: string,
): string[] {
  const peers = state.registry.list(workspaceRoot).filter((a) => a.name !== senderName);
  if (target === '*') return peers.map((a) => a.name);
  const byName = peers.filter((a) => a.name === target);
  if (byName.length > 0) return byName.map((a) => a.name);
  return peers.filter((a) => a.role === target).map((a) => a.name);
}
```

Add these two cases immediately before `case 'shutdown':`:

```typescript
    case 'send': {
      const caller = callerOf(state, ctx, req);
      if (!caller) return fail(id, 'send requires a registered agent (call register first)');
      const target = readString(req, 'to');
      if (!target) return fail(id, 'send requires "to"');

      const names = resolveTargets(state, caller.workspaceRoot, caller.name, target);
      if (names.length === 0) return fail(id, `No agent matching "${target}" in this workspace`);

      try {
        for (const name of names) {
          state.mailbox.deliver({
            kind: 'message',
            from: caller.name,
            to: name,
            body: req.body as string,
          });
        }
      } catch (error) {
        return fail(id, (error as Error).message);
      }

      state.journal.append('send', { from: caller.name, to: names, count: names.length });
      return { id, ok: true, delivered: names.length, to: names };
    }

    case 'inbox': {
      const caller = callerOf(state, ctx, req);
      if (!caller) return fail(id, 'inbox requires a registered agent (call register first)');
      const drain = req.drain !== false;
      const envelopes = drain
        ? state.mailbox.drain(caller.name)
        : state.mailbox.peek(caller.name);
      return {
        id,
        ok: true,
        messages: envelopes.map((e) => ({
          id: e.id,
          kind: e.kind,
          from: e.from,
          body: e.body,
          at: e.at,
          askId: e.askId,
        })),
      };
    }
```

- [ ] **Step 4: Make the server await the handler**

In `src/daemon/server.ts`, replace the `socket.on('data', ...)` body inside `#onConnection` with:

```typescript
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
        // Each frame is handled independently and concurrently. A blocking ask
        // must never stall another connection — or another op on this one.
        void (async () => {
          let response;
          try {
            response = await handleRequest(this.#options.state, ctx, frame);
          } catch (error) {
            response = { id: 0, ok: false, error: `daemon error: ${(error as Error).message}` };
          }
          if (!socket.destroyed) socket.write(encodeFrame(response));
        })();
      }
    });
```

Also update `createDaemonState` in the same file to build the new state fields. Replace its body with:

```typescript
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
    mailbox: new Mailbox({ clock }),
    asks: new AskRegistry({ clock }),
  };
}
```

and add these imports at the top of `src/daemon/server.ts`:

```typescript
import { Mailbox } from '../mailbox.ts';
import { AskRegistry } from '../asks.ts';
```

- [ ] **Step 5: Update the existing handler and server tests for the new state shape**

`test/handlers.test.ts` and `test/server.test.ts` build `DaemonState` literals that now lack two fields. In BOTH files, add these imports:

```typescript
import { Mailbox } from '../src/mailbox.ts';
import { AskRegistry } from '../src/asks.ts';
```

and add these two lines to each `DaemonState` object literal:

```typescript
    mailbox: new Mailbox({ clock: clock.now }),
    asks: new AskRegistry({ clock: clock.now }),
```

In `test/handlers.test.ts`, every `handleRequest(...)` call now returns a promise. Make each test function `async` and `await` every `handleRequest` call. For example:

```typescript
test('ping answers with ok and the daemon time', async () => {
  const { state, ctx, cleanup } = setup();
  try {
    const res = await handleRequest(state, ctx, { id: 1, op: 'ping' });
    assert.equal(res.ok, true);
    assert.equal(res.id, 1);
    assert.equal(res.at, 1000);
  } finally {
    cleanup();
  }
});
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `cd ~/Projects/mesh && npm test && npm run typecheck`
Expected: all previous tests plus 9 new messaging tests pass; typecheck clean.

- [ ] **Step 7: Commit**

```bash
cd ~/Projects/mesh
git add src/daemon/handlers.ts src/daemon/server.ts src/mailbox.ts test/
git commit -m "$(cat <<'EOF'
Add send and inbox ops, and make dispatch async

handleRequest becomes async so a blocking ask can await its answer without
stalling other connections. Frames are handled concurrently for the same
reason. Targets resolve by name, by role, or "*" for broadcast, and never
cross a workspace boundary.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 4: Blocking ask and reply

**Files:**
- Create: `src/daemon/waiters.ts`
- Modify: `src/daemon/handlers.ts`
- Test: `test/ask.test.ts`

**Interfaces:**
- Consumes: `AskRegistry`, `Mailbox`, `DaemonState`.
- Produces:
  - `class Waiters { constructor(o: { defaultTimeoutMs?: number }); wait(askId: number, timeoutMs: number): Promise<'answered' | 'timeout'>; resolve(askId: number, outcome: 'answered' | 'timeout'): boolean; size: number; clear(): void }`
  - `DaemonState` gains `waiters: Waiters`.
  - Ops `ask` (params `to`, `body`, `timeoutMs?`) and `reply` (params `askId`, `body`).

`Waiters` is where real `setTimeout` lives — deliberately isolated so `AskRegistry` stays a pure state machine.

An ask to an **idle** agent still returns immediately with `state: "queued"` rather than blocking, because a hook-based transport cannot reach an agent that is not running tools. That limitation is in the spec; here it becomes observable behavior.

- [ ] **Step 1: Write the failing test**

Create `test/ask.test.ts`:

```typescript
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { systemClock } from '../src/clock.ts';
import { Registry } from '../src/registry.ts';
import { Journal } from '../src/journal.ts';
import { Mailbox } from '../src/mailbox.ts';
import { AskRegistry } from '../src/asks.ts';
import { Waiters } from '../src/daemon/waiters.ts';
import { handleRequest } from '../src/daemon/handlers.ts';
import type { ConnectionContext, DaemonState } from '../src/daemon/handlers.ts';

// These tests exercise real timing, so they use the system clock rather than
// a fake one — the point is that a blocking ask actually resolves.
function setup() {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'mesh-ask-')));
  const clock = systemClock;
  const state: DaemonState = {
    clock,
    registry: new Registry({ clock }),
    journal: new Journal(join(base, 'journal.jsonl'), clock),
    mailbox: new Mailbox({ clock }),
    asks: new AskRegistry({ clock }),
    waiters: new Waiters(),
  };
  return { base, state, cleanup: () => rmSync(base, { recursive: true, force: true }) };
}

const ctx = (): ConnectionContext => ({ sessionId: null });

test('Waiters resolves a pending wait', async () => {
  const waiters = new Waiters();
  const pending = waiters.wait(1, 5000);
  assert.equal(waiters.size, 1);
  assert.equal(waiters.resolve(1, 'answered'), true);
  assert.equal(await pending, 'answered');
  assert.equal(waiters.size, 0);
});

test('Waiters times out on its own', async () => {
  const waiters = new Waiters();
  assert.equal(await waiters.wait(2, 30), 'timeout');
  assert.equal(waiters.size, 0);
});

test('Waiters.resolve on an unknown id is a no-op', () => {
  const waiters = new Waiters();
  assert.equal(waiters.resolve(999, 'answered'), false);
});

test('ask blocks until the target replies, and returns the answer', async () => {
  const { base, state, cleanup } = setup();
  try {
    const a = ctx();
    const b = ctx();
    await handleRequest(state, a, { id: 1, op: 'register', sessionId: 'sa', provider: 'claude', cwd: base });
    await handleRequest(state, b, { id: 1, op: 'register', sessionId: 'sb', provider: 'codex', cwd: base });

    // Keep codex-1 "working" so the ask blocks rather than queueing.
    await handleRequest(state, b, { id: 2, op: 'touch', activity: 'Edit api.ts' });

    const asking = handleRequest(state, a, {
      id: 3, op: 'ask', to: 'codex-1', body: 'does POST /leads accept a partial payload?', timeoutMs: 5000,
    });

    // The question is waiting in codex-1's inbox.
    const inbox = await handleRequest(state, b, { id: 4, op: 'inbox' });
    const messages = inbox.messages as Array<Record<string, unknown>>;
    assert.equal(messages.length, 1);
    assert.equal(messages[0]?.kind, 'ask');
    const askId = messages[0]?.askId as number;

    const replied = await handleRequest(state, b, { id: 5, op: 'reply', askId, body: 'no — email is required' });
    assert.equal(replied.ok, true);

    const answer = await asking;
    assert.equal(answer.ok, true);
    assert.equal(answer.state, 'answered');
    assert.equal(answer.body, 'no — email is required');
    assert.equal(answer.from, 'codex-1');
  } finally {
    cleanup();
  }
});

test('ask times out when nobody answers', async () => {
  const { base, state, cleanup } = setup();
  try {
    const a = ctx();
    const b = ctx();
    await handleRequest(state, a, { id: 1, op: 'register', sessionId: 'sa', provider: 'claude', cwd: base });
    await handleRequest(state, b, { id: 1, op: 'register', sessionId: 'sb', provider: 'codex', cwd: base });
    await handleRequest(state, b, { id: 2, op: 'touch', activity: 'busy' });

    const res = await handleRequest(state, a, { id: 3, op: 'ask', to: 'codex-1', body: 'hello?', timeoutMs: 60 });
    assert.equal(res.ok, true);
    assert.equal(res.state, 'timeout');
    assert.match(String(res.note), /still queued/i);
  } finally {
    cleanup();
  }
});

test('ask to an idle agent returns queued immediately rather than blocking', async () => {
  const { base, state, cleanup } = setup();
  try {
    const a = ctx();
    const b = ctx();
    await handleRequest(state, a, { id: 1, op: 'register', sessionId: 'sa', provider: 'claude', cwd: base });
    await handleRequest(state, b, { id: 1, op: 'register', sessionId: 'sb', provider: 'codex', cwd: base });

    // Force codex-1 idle by aging its lastSeen past the idle window.
    const agent = state.registry.get('sb');
    if (agent) agent.lastSeen = Date.now() - 120_000;

    const started = Date.now();
    const res = await handleRequest(state, a, { id: 3, op: 'ask', to: 'codex-1', body: 'you there?', timeoutMs: 10_000 });
    const elapsed = Date.now() - started;

    assert.equal(res.state, 'queued');
    assert.ok(elapsed < 1000, `should return immediately, took ${elapsed}ms`);
    assert.match(String(res.note), /idle/i);
  } finally {
    cleanup();
  }
});

test('ask to an unknown target is undeliverable and does not block', async () => {
  const { base, state, cleanup } = setup();
  try {
    const a = ctx();
    await handleRequest(state, a, { id: 1, op: 'register', sessionId: 'sa', provider: 'claude', cwd: base });

    const started = Date.now();
    const res = await handleRequest(state, a, { id: 2, op: 'ask', to: 'ghost-9', body: 'hi', timeoutMs: 10_000 });
    assert.equal(res.state, 'undeliverable');
    assert.ok(Date.now() - started < 1000);
  } finally {
    cleanup();
  }
});

test('a mutual ask is refused as a deadlock instead of hanging', async () => {
  const { base, state, cleanup } = setup();
  try {
    const a = ctx();
    const b = ctx();
    await handleRequest(state, a, { id: 1, op: 'register', sessionId: 'sa', provider: 'claude', cwd: base });
    await handleRequest(state, b, { id: 1, op: 'register', sessionId: 'sb', provider: 'codex', cwd: base });
    await handleRequest(state, a, { id: 2, op: 'touch', activity: 'x' });
    await handleRequest(state, b, { id: 2, op: 'touch', activity: 'y' });

    const first = handleRequest(state, a, { id: 3, op: 'ask', to: 'codex-1', body: 'q1', timeoutMs: 3000 });

    const second = await handleRequest(state, b, { id: 4, op: 'ask', to: 'claude-1', body: 'q2', timeoutMs: 3000 });
    assert.equal(second.ok, false);
    assert.match(String(second.error), /Deadlock/);

    // Unblock the first ask so the test does not wait out its timeout.
    const inbox = await handleRequest(state, b, { id: 5, op: 'inbox' });
    const askId = (inbox.messages as Array<Record<string, unknown>>)[0]?.askId as number;
    await handleRequest(state, b, { id: 6, op: 'reply', askId, body: 'ok' });
    await first;
  } finally {
    cleanup();
  }
});

test('reply to an ask you were not asked is refused', async () => {
  const { base, state, cleanup } = setup();
  try {
    const a = ctx();
    const b = ctx();
    const c = ctx();
    await handleRequest(state, a, { id: 1, op: 'register', sessionId: 'sa', provider: 'claude', cwd: base });
    await handleRequest(state, b, { id: 1, op: 'register', sessionId: 'sb', provider: 'codex', cwd: base });
    await handleRequest(state, c, { id: 1, op: 'register', sessionId: 'sc', provider: 'fable', cwd: base });
    await handleRequest(state, b, { id: 2, op: 'touch', activity: 'x' });

    const asking = handleRequest(state, a, { id: 3, op: 'ask', to: 'codex-1', body: 'q', timeoutMs: 3000 });
    const inbox = await handleRequest(state, b, { id: 4, op: 'inbox' });
    const askId = (inbox.messages as Array<Record<string, unknown>>)[0]?.askId as number;

    const intruder = await handleRequest(state, c, { id: 5, op: 'reply', askId, body: 'me!' });
    assert.equal(intruder.ok, false);

    await handleRequest(state, b, { id: 6, op: 'reply', askId, body: 'real answer' });
    assert.equal((await asking).body, 'real answer');
  } finally {
    cleanup();
  }
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd ~/Projects/mesh && node --test 'test/ask.test.ts'`
Expected: FAIL — `Cannot find module '../src/daemon/waiters.ts'`.

- [ ] **Step 3: Write the waiters module**

Create `src/daemon/waiters.ts`:

```typescript
export type WaitOutcome = 'answered' | 'timeout';

interface Waiter {
  resolve: (outcome: WaitOutcome) => void;
  timer: NodeJS.Timeout;
}

/**
 * Holds the promises that blocking asks are parked on, and the only real
 * timers in the daemon. AskRegistry stays a pure state machine because this
 * module owns the clock-driven half.
 */
export class Waiters {
  #waiters = new Map<number, Waiter>();

  get size(): number {
    return this.#waiters.size;
  }

  wait(askId: number, timeoutMs: number): Promise<WaitOutcome> {
    return new Promise<WaitOutcome>((resolve) => {
      const timer = setTimeout(() => {
        this.#waiters.delete(askId);
        resolve('timeout');
      }, timeoutMs);
      // A pending ask must not keep the daemon alive on its own.
      timer.unref?.();
      this.#waiters.set(askId, { resolve, timer });
    });
  }

  resolve(askId: number, outcome: WaitOutcome): boolean {
    const waiter = this.#waiters.get(askId);
    if (!waiter) return false;
    clearTimeout(waiter.timer);
    this.#waiters.delete(askId);
    waiter.resolve(outcome);
    return true;
  }

  clear(): void {
    for (const waiter of this.#waiters.values()) clearTimeout(waiter.timer);
    this.#waiters.clear();
  }
}
```

- [ ] **Step 4: Add the ask and reply ops**

In `src/daemon/handlers.ts`, add the import and the state field:

```typescript
import type { Waiters } from './waiters.ts';
```

Add `waiters: Waiters;` to the `DaemonState` interface.

Add these cases immediately before `case 'shutdown':`:

```typescript
    case 'ask': {
      const caller = callerOf(state, ctx, req);
      if (!caller) return fail(id, 'ask requires a registered agent (call register first)');
      const target = readString(req, 'to');
      if (!target) return fail(id, 'ask requires "to"');

      const names = resolveTargets(state, caller.workspaceRoot, caller.name, target);
      const targetName = names[0];
      if (names.length === 0 || targetName === undefined) {
        return {
          id, ok: true, state: 'undeliverable',
          note: `No agent matching "${target}" is on this workspace right now.`,
        };
      }
      if (names.length > 1) {
        return fail(id, `"${target}" matches ${names.length} agents; ask one by name`);
      }

      const timeoutMs = typeof req.timeoutMs === 'number' ? req.timeoutMs : 90_000;
      const created = state.asks.create({
        from: caller.name, to: targetName, body: req.body as string, timeoutMs,
      });
      if (!created.ok) return fail(id, created.error);

      state.mailbox.deliver({
        kind: 'ask', from: caller.name, to: targetName,
        body: created.ask.body, askId: created.ask.id,
      });
      state.journal.append('ask', { id: created.ask.id, from: caller.name, to: targetName });

      // A hook-based transport cannot reach an agent that is not running
      // tools, so blocking on an idle peer would just burn the timeout.
      // Queue instead, and say so.
      const targetView = state.registry.list(caller.workspaceRoot).find((a) => a.name === targetName);
      if (targetView?.status === 'idle') {
        return {
          id, ok: true, state: 'queued', askId: created.ask.id, to: targetName,
          note: `${targetName} is idle, so the question is queued and will be delivered when it next acts.`,
        };
      }

      const outcome = await state.waiters.wait(created.ask.id, timeoutMs);
      const settled = state.asks.get(created.ask.id);

      if (outcome === 'answered' && settled?.state === 'answered') {
        return {
          id, ok: true, state: 'answered', askId: created.ask.id,
          from: targetName, body: settled.answer,
        };
      }
      return {
        id, ok: true, state: 'timeout', askId: created.ask.id, to: targetName,
        note: `No answer within ${timeoutMs}ms. The question is still queued for ${targetName}.`,
      };
    }

    case 'reply': {
      const caller = callerOf(state, ctx, req);
      if (!caller) return fail(id, 'reply requires a registered agent (call register first)');
      const askId = typeof req.askId === 'number' ? req.askId : null;
      if (askId === null) return fail(id, 'reply requires a numeric "askId"');

      const result = state.asks.answer(askId, caller.name, req.body as string);
      if (!result.ok || !result.ask) return fail(id, result.error ?? 'reply failed');

      state.mailbox.deliver({
        kind: 'reply', from: caller.name, to: result.ask.from,
        body: result.ask.answer as string, askId,
      });
      state.journal.append('reply', { id: askId, from: caller.name, to: result.ask.from });
      state.waiters.resolve(askId, 'answered');

      return { id, ok: true, askId, to: result.ask.from };
    }
```

- [ ] **Step 5: Wire Waiters into daemon state and the other test setups**

In `src/daemon/server.ts`, add `import { Waiters } from './waiters.ts';` and add `waiters: new Waiters(),` to the object returned by `createDaemonState`. In `MeshServer.close()`, add `this.#options.state.waiters.clear();` immediately before `this.#options.state.journal.close();` so a shutdown does not leave timers armed.

In `test/handlers.test.ts`, `test/server.test.ts`, and `test/messaging.test.ts`, add `import { Waiters } from '../src/daemon/waiters.ts';` and `waiters: new Waiters(),` to each `DaemonState` literal.

- [ ] **Step 6: Run tests to verify they pass**

Run: `cd ~/Projects/mesh && npm test && npm run typecheck`
Expected: all suites pass, including 9 new ask tests. Typecheck clean.

- [ ] **Step 7: Commit**

```bash
cd ~/Projects/mesh
git add src/daemon/ test/
git commit -m "$(cat <<'EOF'
Add blocking ask and reply

Waiters isolates the only real timers in the daemon so AskRegistry stays a
pure state machine. An ask to an idle agent returns "queued" immediately
rather than burning its timeout, because a hook-based transport cannot reach
an agent that is not running tools — the honest limit, made observable.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 5: Hook shim

**Files:**
- Create: `src/hook.ts`
- Modify: `src/cli/index.ts`
- Test: `test/hook.test.ts`

**Interfaces:**
- Consumes: `MeshClient`, `Response`.
- Produces:
  - `interface HookInput { hook_event_name?: string; session_id?: string; cwd?: string; tool_name?: string; tool_input?: Record<string, unknown>; [k: string]: unknown }`
  - `function readStdinWithDeadline(stream: NodeJS.ReadStream, ms: number): Promise<string>`
  - `function parseHookInput(raw: string): HookInput | null`
  - `function summarizeTool(input: HookInput): string | null`
  - `function formatInjection(messages: InjectedMessage[]): string` where `interface InjectedMessage { kind: string; from: string; body: string; askId: number | null }`
  - `function buildHookOutput(event: string, context: string | null): Record<string, unknown>`
  - `function runHook(event: string, options?: { stdin?: NodeJS.ReadStream; provider?: string }): Promise<Record<string, unknown>>`
  - `mesh hook <event>` CLI subcommand.

Every function above is pure except `runHook`, so the output contract is asserted directly.

- [ ] **Step 1: Write the failing test**

Create `test/hook.test.ts`:

```typescript
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { readFileSync } from 'node:fs';
import {
  readStdinWithDeadline,
  parseHookInput,
  summarizeTool,
  formatInjection,
  buildHookOutput,
} from '../src/hook.ts';

function fakeStdin(text: string, keepOpen = false): NodeJS.ReadStream {
  const stream = new Readable({ read() {} });
  stream.push(text);
  if (!keepOpen) stream.push(null);
  return stream as unknown as NodeJS.ReadStream;
}

test('reads stdin that closes normally', async () => {
  const raw = await readStdinWithDeadline(fakeStdin('{"a":1}'), 500);
  assert.equal(raw, '{"a":1}');
});

test('returns what it has when the deadline fires on an open pipe', async () => {
  // Phase 0: Codex holds the hook's stdin open. A blocking read deadlocks
  // the host, so the deadline must win.
  const started = Date.now();
  const raw = await readStdinWithDeadline(fakeStdin('{"partial":', true), 60);
  const elapsed = Date.now() - started;
  assert.equal(raw, '{"partial":');
  assert.ok(elapsed < 500, `deadline should fire promptly, took ${elapsed}ms`);
});

test('parseHookInput tolerates junk instead of throwing', () => {
  assert.equal(parseHookInput('not json'), null);
  assert.equal(parseHookInput(''), null);
  assert.deepEqual(parseHookInput('{"hook_event_name":"PreToolUse"}'), {
    hook_event_name: 'PreToolUse',
  });
});

test('summarizeTool describes a file edit', () => {
  assert.equal(
    summarizeTool({ tool_name: 'Edit', tool_input: { file_path: '/repo/app/page.tsx' } }),
    'Edit app/page.tsx',
  );
});

test('summarizeTool describes a bash command without its arguments', () => {
  assert.equal(
    summarizeTool({ tool_name: 'Bash', tool_input: { command: 'npm test --silent' } }),
    'Bash npm test',
  );
});

test('summarizeTool falls back to the bare tool name', () => {
  assert.equal(summarizeTool({ tool_name: 'WebSearch' }), 'WebSearch');
  assert.equal(summarizeTool({}), null);
});

test('formatInjection renders nothing for an empty inbox', () => {
  assert.equal(formatInjection([]), '');
});

test('formatInjection attributes each message to its sender', () => {
  const out = formatInjection([
    { kind: 'message', from: 'codex-2', body: 'backend is deployed', askId: null },
  ]);
  assert.match(out, /MESH/);
  assert.match(out, /codex-2/);
  assert.match(out, /backend is deployed/);
});

test('formatInjection tells the agent how to answer a question', () => {
  const out = formatInjection([
    { kind: 'ask', from: 'codex-2', body: 'does the form send phone?', askId: 42 },
  ]);
  assert.match(out, /codex-2/);
  assert.match(out, /mesh_reply/, 'the agent must be told the tool to use');
  assert.match(out, /42/, 'and the askId to pass');
});

test('formatInjection marks a reply as an answer to your question', () => {
  const out = formatInjection([
    { kind: 'reply', from: 'codex-2', body: 'no, email only', askId: 42 },
  ]);
  assert.match(out, /answered/i);
  assert.match(out, /no, email only/);
});

test('buildHookOutput emits the shape Claude and Codex both accept', () => {
  // Verified in Phase 0: both hosts take this exact shape.
  const out = buildHookOutput('PreToolUse', 'hello');
  assert.deepEqual(out, {
    hookSpecificOutput: { hookEventName: 'PreToolUse', additionalContext: 'hello' },
  });
});

test('buildHookOutput emits a bare object when there is nothing to inject', () => {
  assert.deepEqual(buildHookOutput('PreToolUse', null), {});
  assert.deepEqual(buildHookOutput('PreToolUse', ''), {});
});

test('the hook module imports no heavy dependencies', () => {
  // The hook runs before every tool call. Importing the MCP SDK measured at
  // 100ms of startup versus 50ms without it, which would double the cost of
  // every tool call in the session.
  const source = readFileSync(new URL('../src/hook.ts', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /@modelcontextprotocol/, 'hook must not import the MCP SDK');
  assert.doesNotMatch(source, /from 'zod'/, 'hook must not import zod');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd ~/Projects/mesh && node --test 'test/hook.test.ts'`
Expected: FAIL — `Cannot find module '../src/hook.ts'`.

- [ ] **Step 3: Write minimal implementation**

Create `src/hook.ts`:

```typescript
import { basename } from 'node:path';
import { MeshClient } from './client.ts';

export interface HookInput {
  hook_event_name?: string;
  session_id?: string;
  cwd?: string;
  tool_name?: string;
  tool_input?: Record<string, unknown>;
  [key: string]: unknown;
}

export interface InjectedMessage {
  kind: string;
  from: string;
  body: string;
  askId: number | null;
}

/**
 * Reads stdin with a deadline and never blockingly.
 *
 * Phase 0 finding: Codex holds the hook's stdin pipe open without closing it.
 * A synchronous read never returns, the host waits on the hook, and the whole
 * run deadlocks. destroy() matters as much as the deadline — an open stdin
 * handle keeps the event loop alive well past the point of doing any work.
 */
export function readStdinWithDeadline(stream: NodeJS.ReadStream, ms: number): Promise<string> {
  return new Promise((resolve) => {
    let buffer = '';
    let done = false;

    const finish = () => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      stream.removeAllListeners();
      stream.pause();
      stream.destroy?.();
      resolve(buffer);
    };

    const timer = setTimeout(finish, ms);
    timer.unref?.();

    stream.setEncoding?.('utf8');
    stream.on('data', (chunk: string | Buffer) => {
      buffer += typeof chunk === 'string' ? chunk : chunk.toString('utf8');
    });
    stream.on('end', finish);
    stream.on('error', finish);
  });
}

export function parseHookInput(raw: string): HookInput | null {
  try {
    const parsed = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null;
    return parsed as HookInput;
  } catch {
    return null;
  }
}

/** A short human-readable description of what the agent is doing right now. */
export function summarizeTool(input: HookInput): string | null {
  const tool = typeof input.tool_name === 'string' ? input.tool_name : null;
  if (!tool) return null;

  const args = input.tool_input ?? {};
  const filePath = args.file_path;
  if (typeof filePath === 'string' && filePath.length > 0) {
    return `${tool} ${basename(filePath)}`;
  }
  const command = args.command;
  if (typeof command === 'string' && command.length > 0) {
    // First two words only: enough to identify the command, without dragging
    // a full shell line into a peer's context.
    return `${tool} ${command.trim().split(/\s+/).slice(0, 2).join(' ')}`;
  }
  return tool;
}

/**
 * Renders queued mail as directive text. Fenced and attributed so the agent
 * treats it as a report from a peer rather than an instruction from its user.
 */
export function formatInjection(messages: InjectedMessage[]): string {
  if (messages.length === 0) return '';

  const lines = ['[MESH] Messages from other agents on this project:'];
  for (const message of messages) {
    if (message.kind === 'ask') {
      lines.push(
        `  • ${message.from} asks you: ${message.body}`,
        `    Answer with mesh_reply(askId: ${message.askId}, body: "..."). ` +
          `${message.from} is blocked waiting on you.`,
      );
    } else if (message.kind === 'reply') {
      lines.push(`  • ${message.from} answered your question #${message.askId}: ${message.body}`);
    } else {
      lines.push(`  • ${message.from}: ${message.body}`);
    }
  }
  return lines.join('\n');
}

/**
 * The output envelope. Phase 0 verified Claude and Codex accept this exact
 * shape, so there is no per-host compat layer.
 */
export function buildHookOutput(event: string, context: string | null): Record<string, unknown> {
  if (!context) return {};
  return { hookSpecificOutput: { hookEventName: event, additionalContext: context } };
}

/**
 * Fail-open at every step: any problem yields {} and the agent proceeds
 * exactly as it would without mesh installed.
 */
export async function runHook(
  event: string,
  options: { stdin?: NodeJS.ReadStream; provider?: string } = {},
): Promise<Record<string, unknown>> {
  try {
    const raw = await readStdinWithDeadline(options.stdin ?? process.stdin, 400);
    const input = parseHookInput(raw) ?? {};
    const sessionId = typeof input.session_id === 'string' ? input.session_id : null;
    const cwd = typeof input.cwd === 'string' ? input.cwd : process.cwd();
    if (!sessionId) return {};

    const provider = options.provider ?? process.env.MESH_PROVIDER ?? 'claude';
    const client = await MeshClient.open({ connectTimeoutMs: 300 });
    if (!client) return {};

    try {
      if (event === 'SessionStart') {
        await client.request('register', { sessionId, provider, cwd, pid: process.ppid });
        return {};
      }

      await client.request('register', { sessionId, provider, cwd, pid: process.ppid });
      const activity = summarizeTool(input);
      await client.request('touch', { sessionId, ...(activity ? { activity } : {}) });

      const inbox = await client.request('inbox', { sessionId });
      if (!inbox.ok) return {};
      const messages = (inbox.messages ?? []) as InjectedMessage[];
      return buildHookOutput(event, formatInjection(messages));
    } finally {
      client.close();
    }
  } catch {
    // mesh must never be able to break the user's agent.
    return {};
  }
}
```

- [ ] **Step 4: Add the CLI subcommand**

In `src/cli/index.ts`, add to the imports:

```typescript
import { runHook } from '../hook.ts';
```

Add this function above `main`:

```typescript
async function cmdHook(event: string | undefined): Promise<number> {
  const output = await runHook(event ?? 'PreToolUse');
  // Exit only from the write callback: a bare process.exit() truncates
  // unflushed stdout, which the host then reports as a failed hook.
  await new Promise<void>((resolve) => {
    process.stdout.write(JSON.stringify(output), () => resolve());
  });
  return 0;
}
```

Add this case to the `switch` in `main`, before `case 'daemon':`:

```typescript
    case 'hook':
      return cmdHook(argv[3]);
```

And add this line to `USAGE`, after the `mesh log` line:

```
  mesh hook <ev>  Internal: called by Claude/Codex hooks, not by hand
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd ~/Projects/mesh && node --test 'test/hook.test.ts' && npm run typecheck`
Expected: 13 tests pass, typecheck clean.

- [ ] **Step 6: Measure the hook's real cost**

```bash
cd ~/Projects/mesh
for i in 1 2 3; do
  /usr/bin/time -p sh -c 'echo "{}" | node src/cli/index.ts hook PreToolUse >/dev/null' 2>&1 \
    | awk '/real/{printf "  %.0fms\n", $2*1000}'
done
```

Expected: roughly 60–90ms each, dominated by Node startup (measured floor: 50–60ms). Anything above ~120ms means mesh's own work has grown past its 15ms share and needs investigating.

- [ ] **Step 7: Commit**

```bash
cd ~/Projects/mesh
git add src/hook.ts src/cli/index.ts test/hook.test.ts
git commit -m "$(cat <<'EOF'
Add hook shim for activity reporting and message injection

Encodes all four Phase 0 traps: bounded async stdin read with pause and
destroy, exit only from the stdout write callback, one output shape for both
hosts, and fail-open on every path. A test asserts the module never imports
the MCP SDK — that import alone measured 50ms of extra startup on a path that
runs before every tool call.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 6: MCP server

**Files:**
- Create: `src/mcp/server.ts`
- Modify: `src/cli/index.ts`
- Test: `test/mcp.test.ts`

**Interfaces:**
- Consumes: `MeshClient`, `@modelcontextprotocol/sdk` 1.29, `zod` 4.
- Produces:
  - `interface McpOptions { sessionId: string; provider: string; cwd: string; role?: string }`
  - `function resolveMcpIdentity(env: NodeJS.ProcessEnv, argv: string[]): McpOptions`
  - `function toolText(value: unknown): { content: Array<{ type: 'text'; text: string }> }`
  - `function describeWho(agents: WhoAgent[]): string`
  - `async function startMcpServer(options: McpOptions): Promise<void>`
  - `mesh mcp` CLI subcommand.

**Known gap, deliberate:** the MCP server has no access to the host's session id, so it takes one from `MESH_SESSION_ID` or `--session`, falling back to `pid-<ppid>`. Until `mesh init` (Phase 5) sets that variable to the same id the hook reports, an agent can appear twice — once from its hook and once from its MCP server. Tests pass the id explicitly. This is recorded in the spec's open questions by Task 7.

- [ ] **Step 1: Write the failing test**

Create `test/mcp.test.ts`:

```typescript
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveMcpIdentity, toolText, describeWho } from '../src/mcp/server.ts';

test('identity prefers an explicit --session flag', () => {
  const id = resolveMcpIdentity({}, ['node', 'mesh', 'mcp', '--session', 'abc123']);
  assert.equal(id.sessionId, 'abc123');
});

test('identity falls back to MESH_SESSION_ID', () => {
  const id = resolveMcpIdentity({ MESH_SESSION_ID: 'from-env' }, ['node', 'mesh', 'mcp']);
  assert.equal(id.sessionId, 'from-env');
});

test('identity falls back to the parent pid when nothing is set', () => {
  const id = resolveMcpIdentity({}, ['node', 'mesh', 'mcp']);
  assert.match(id.sessionId, /^pid-\d+$/);
});

test('identity reads provider and role from the environment', () => {
  const id = resolveMcpIdentity(
    { MESH_SESSION_ID: 's', MESH_PROVIDER: 'codex', MESH_ROLE: 'backend' },
    ['node', 'mesh', 'mcp'],
  );
  assert.equal(id.provider, 'codex');
  assert.equal(id.role, 'backend');
});

test('identity defaults the provider to claude', () => {
  const id = resolveMcpIdentity({ MESH_SESSION_ID: 's' }, ['node', 'mesh', 'mcp']);
  assert.equal(id.provider, 'claude');
});

test('toolText wraps a string as MCP text content', () => {
  assert.deepEqual(toolText('hello'), { content: [{ type: 'text', text: 'hello' }] });
});

test('toolText serializes non-strings as JSON', () => {
  const out = toolText({ a: 1 });
  assert.equal(out.content[0]?.text, '{\n "a": 1\n}');
});

test('describeWho renders an empty roster plainly', () => {
  assert.match(describeWho([]), /No other agents/i);
});

test('describeWho lists each agent with role and activity', () => {
  const out = describeWho([
    { name: 'codex-2', provider: 'codex', role: 'backend', status: 'working', activity: 'Edit api.ts', idleMs: 500 },
  ]);
  assert.match(out, /codex-2/);
  assert.match(out, /backend/);
  assert.match(out, /Edit api\.ts/);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd ~/Projects/mesh && node --test 'test/mcp.test.ts'`
Expected: FAIL — `Cannot find module '../src/mcp/server.ts'`.

- [ ] **Step 3: Write minimal implementation**

Create `src/mcp/server.ts`:

```typescript
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { MeshClient } from '../client.ts';
import type { WhoAgent } from '../cli/who.ts';
import { formatDuration } from '../cli/who.ts';

export interface McpOptions {
  sessionId: string;
  provider: string;
  cwd: string;
  role?: string;
}

/**
 * The MCP server is spawned by the host and is not told the host's session id,
 * so it takes one from --session or MESH_SESSION_ID. `mesh init` (Phase 5)
 * will set that to the same id the hook reports; until then the pid fallback
 * can register a second agent for one session.
 */
export function resolveMcpIdentity(env: NodeJS.ProcessEnv, argv: string[]): McpOptions {
  const flagIndex = argv.indexOf('--session');
  const fromFlag = flagIndex === -1 ? undefined : argv[flagIndex + 1];
  const role = env.MESH_ROLE;
  return {
    sessionId: fromFlag ?? env.MESH_SESSION_ID ?? `pid-${process.ppid}`,
    provider: env.MESH_PROVIDER ?? 'claude',
    cwd: env.MESH_CWD ?? process.cwd(),
    ...(role ? { role } : {}),
  };
}

export function toolText(value: unknown): { content: Array<{ type: 'text'; text: string }> } {
  const text = typeof value === 'string' ? value : JSON.stringify(value, null, 1);
  return { content: [{ type: 'text', text }] };
}

export function describeWho(agents: WhoAgent[]): string {
  if (agents.length === 0) return 'No other agents are working on this project right now.';
  return agents
    .map((a) => {
      const role = a.role ? ` (${a.role})` : '';
      const doing = a.activity ?? (a.status === 'idle' ? 'idle' : 'starting up');
      return `${a.name}${role} — ${a.status}, last seen ${formatDuration(a.idleMs)} ago: ${doing}`;
    })
    .join('\n');
}

export async function startMcpServer(options: McpOptions): Promise<void> {
  const client = await MeshClient.open();
  if (!client) throw new Error('mesh: could not reach or start the daemon');

  await client.request('register', {
    sessionId: options.sessionId,
    provider: options.provider,
    cwd: options.cwd,
    ...(options.role ? { role: options.role } : {}),
    pid: process.ppid,
  });

  const server = new McpServer({ name: 'mesh', version: '0.1.0' });
  const session = { sessionId: options.sessionId };

  server.registerTool(
    'mesh_who',
    {
      description:
        'List the other AI agents working on this project right now, with their role and current activity.',
      inputSchema: {},
    },
    async () => {
      const res = await client.request('who', { cwd: options.cwd, ...session });
      const agents = ((res.agents ?? []) as WhoAgent[]).filter((a) => a.name !== undefined);
      return toolText(describeWho(agents));
    },
  );

  server.registerTool(
    'mesh_send',
    {
      description:
        'Send a one-way message to another agent. Use "*" to broadcast. Returns immediately; use mesh_ask if you need an answer.',
      inputSchema: {
        to: z.string().describe('Agent name (claude-1), role (backend), or "*" for everyone'),
        body: z.string().describe('The message text'),
      },
    },
    async ({ to, body }) => {
      const res = await client.request('send', { to, body, ...session });
      return toolText(res.ok ? `Sent to ${(res.to as string[]).join(', ')}.` : `Failed: ${res.error}`);
    },
  );

  server.registerTool(
    'mesh_ask',
    {
      description:
        'Ask another agent a question and WAIT for the answer. Use when you are blocked on something they own.',
      inputSchema: {
        to: z.string().describe('Agent name (codex-2) or role (backend)'),
        body: z.string().describe('The question'),
        timeoutMs: z.number().optional().describe('How long to wait. Default 90000.'),
      },
    },
    async ({ to, body, timeoutMs }) => {
      const res = await client.request('ask', {
        to, body, ...(timeoutMs ? { timeoutMs } : {}), ...session,
      });
      if (!res.ok) return toolText(`Could not ask: ${res.error}`);
      if (res.state === 'answered') return toolText(`${res.from} answered: ${res.body}`);
      return toolText(`${res.state}: ${res.note}`);
    },
  );

  server.registerTool(
    'mesh_reply',
    {
      description: 'Answer a question another agent asked you. The askId came with the question.',
      inputSchema: {
        askId: z.number().describe('The askId from the question'),
        body: z.string().describe('Your answer'),
      },
    },
    async ({ askId, body }) => {
      const res = await client.request('reply', { askId, body, ...session });
      return toolText(res.ok ? `Answered ${res.to}.` : `Failed: ${res.error}`);
    },
  );

  server.registerTool(
    'mesh_inbox',
    {
      description: 'Read messages and questions other agents have sent you.',
      inputSchema: {},
    },
    async () => {
      const res = await client.request('inbox', session);
      const messages = (res.messages ?? []) as Array<Record<string, unknown>>;
      if (messages.length === 0) return toolText('No new messages.');
      return toolText(
        messages
          .map((m) =>
            m.kind === 'ask'
              ? `${m.from} asks (askId ${m.askId}): ${m.body}`
              : `${m.from}: ${m.body}`,
          )
          .join('\n'),
      );
    },
  );

  await server.connect(new StdioServerTransport());
}
```

- [ ] **Step 4: Add the CLI subcommand**

In `src/cli/index.ts`, add this case to the `switch` in `main`, before `case 'daemon':`:

```typescript
    case 'mcp': {
      const { resolveMcpIdentity, startMcpServer } = await import('../mcp/server.ts');
      await startMcpServer(resolveMcpIdentity(process.env, argv));
      return 0;
    }
```

The dynamic `import` matters: it keeps the SDK out of the module graph for every other subcommand, including `mesh hook`.

Add this line to `USAGE`, after the `mesh hook` line:

```
  mesh mcp        Internal: MCP server exposing mesh_* tools to an agent
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd ~/Projects/mesh && node --test 'test/mcp.test.ts' && npm run typecheck`
Expected: 9 tests pass, typecheck clean.

- [ ] **Step 6: Verify the tool list over real MCP stdio**

```bash
cd ~/Projects/mesh
printf '%s\n%s\n' \
  '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"probe","version":"1"}}}' \
  '{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}' \
  | MESH_SESSION_ID=probe-1 node src/cli/index.ts mcp 2>/dev/null \
  | python3 -c "import sys,json;[print(' ',t['name']) for l in sys.stdin if l.strip() for t in json.loads(l).get('result',{}).get('tools',[])]"
```

Expected: the five tool names — `mesh_who`, `mesh_send`, `mesh_ask`, `mesh_reply`, `mesh_inbox`.

Then stop the daemon this started:

```bash
node -e "import('./src/client.ts').then(async ({MeshClient})=>{const c=await MeshClient.open({autostart:false}); if(c){await c.request('shutdown'); c.close(); console.log('daemon stopped');} else console.log('no daemon');})"
```

- [ ] **Step 7: Commit**

```bash
cd ~/Projects/mesh
git add src/mcp/ src/cli/index.ts test/mcp.test.ts package.json package-lock.json
git commit -m "$(cat <<'EOF'
Add MCP server exposing the mesh_* tools

Five tools: who, send, ask, reply, inbox. The SDK is loaded via dynamic
import from the CLI so it stays out of the module graph for `mesh hook`,
where a 50ms import would land on every tool call.

Identity comes from --session or MESH_SESSION_ID with a pid fallback; wiring
it to the host's real session id is Phase 5's mesh init.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 7: End-to-end round-trip and spec update

**Files:**
- Create: `test/e2e-messaging.test.ts`
- Modify: `docs/superpowers/specs/2026-07-25-mesh-design.md`

**Interfaces:**
- Consumes: everything above.
- Produces: no new API. Proves two independent client connections complete a full ask round-trip through a real daemon over a real socket.

- [ ] **Step 1: Write the failing test**

Create `test/e2e-messaging.test.ts`:

```typescript
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MeshServer, createDaemonState } from '../src/daemon/server.ts';
import { MeshClient } from '../src/client.ts';

async function withDaemon<T>(fn: (socketPath: string, base: string) => Promise<T>): Promise<T> {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'mesh-e2e-')));
  const socketPath = join(base, 'mesh.sock');
  const server = new MeshServer({
    socketPath,
    state: createDaemonState({ journalPath: join(base, 'journal.jsonl') }),
  });
  await server.start();
  try {
    return await fn(socketPath, base);
  } finally {
    await server.close();
    rmSync(base, { recursive: true, force: true });
  }
}

test('two clients complete a full ask round-trip over a real socket', async () => {
  await withDaemon(async (socketPath, base) => {
    const claude = await MeshClient.open({ socketPath, autostart: false });
    const codex = await MeshClient.open({ socketPath, autostart: false });
    assert.ok(claude && codex);

    await claude.request('register', { sessionId: 'sa', provider: 'claude', cwd: base, role: 'frontend' });
    await codex.request('register', { sessionId: 'sb', provider: 'codex', cwd: base, role: 'backend' });
    await codex.request('touch', { activity: 'Edit server/api/leads.ts' });

    // claude-1 sees codex-1 and what it is doing.
    const who = await claude.request('who', { cwd: base });
    const agents = who.agents as Array<Record<string, unknown>>;
    assert.equal(agents.length, 2);
    assert.equal(agents.find((a) => a.name === 'codex-1')?.activity, 'Edit server/api/leads.ts');

    // claude-1 asks the backend a question and blocks.
    const asking = claude.request('ask', {
      to: 'backend', body: 'does POST /leads accept a partial payload?', timeoutMs: 5000,
    });

    // codex-1 finds it, answers it.
    const inbox = await codex.request('inbox');
    const messages = inbox.messages as Array<Record<string, unknown>>;
    assert.equal(messages.length, 1);
    assert.equal(messages[0]?.kind, 'ask');
    assert.equal(messages[0]?.from, 'claude-1');

    await codex.request('reply', {
      askId: messages[0]?.askId, body: 'no — email is required. adding an optional path now',
    });

    const answer = await asking;
    assert.equal(answer.state, 'answered');
    assert.equal(answer.from, 'codex-1');
    assert.match(String(answer.body), /email is required/);

    // The answer also lands in claude-1's inbox for its next hook to inject.
    const claudeInbox = await claude.request('inbox');
    const replies = claudeInbox.messages as Array<Record<string, unknown>>;
    assert.equal(replies[0]?.kind, 'reply');

    claude.close();
    codex.close();
  });
});

test('a broadcast reaches every peer over a real socket', async () => {
  await withDaemon(async (socketPath, base) => {
    const a = await MeshClient.open({ socketPath, autostart: false });
    const b = await MeshClient.open({ socketPath, autostart: false });
    const c = await MeshClient.open({ socketPath, autostart: false });
    assert.ok(a && b && c);

    await a.request('register', { sessionId: 'sa', provider: 'claude', cwd: base });
    await b.request('register', { sessionId: 'sb', provider: 'codex', cwd: base });
    await c.request('register', { sessionId: 'sc', provider: 'fable', cwd: base });

    const sent = await a.request('send', { to: '*', body: 'switching the schema in 5 minutes' });
    assert.equal(sent.delivered, 2);

    for (const client of [b, c]) {
      const inbox = await client.request('inbox');
      const messages = inbox.messages as Array<Record<string, unknown>>;
      assert.equal(messages.length, 1);
      assert.match(String(messages[0]?.body), /switching the schema/);
    }

    a.close();
    b.close();
    c.close();
  });
});

test('an agent that disconnects mid-ask does not strand the asker', async () => {
  await withDaemon(async (socketPath, base) => {
    const a = await MeshClient.open({ socketPath, autostart: false });
    const b = await MeshClient.open({ socketPath, autostart: false });
    assert.ok(a && b);

    await a.request('register', { sessionId: 'sa', provider: 'claude', cwd: base });
    await b.request('register', { sessionId: 'sb', provider: 'codex', cwd: base });
    await b.request('touch', { activity: 'working' });

    const asking = a.request('ask', { to: 'codex-1', body: 'still there?', timeoutMs: 400 });
    b.close();

    const res = await asking;
    assert.equal(res.ok, true);
    assert.equal(res.state, 'timeout', 'the asker gets a timeout, not a hang');

    a.close();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd ~/Projects/mesh && node --test 'test/e2e-messaging.test.ts'`

Unlike every other task, this test is expected to **pass on first run** — it is a composition test over Tasks 1–6, adding no new implementation. If it fails, the failure is real and points at an integration bug between modules that each passed their own unit tests. Read the assertion before changing anything.

- [ ] **Step 3: Run the full suite**

Run: `cd ~/Projects/mesh && npm test && npm run typecheck`
Expected: every suite passes, including 3 new end-to-end tests. Typecheck clean.

- [ ] **Step 4: Update the spec with what Phase 2 measured**

In `docs/superpowers/specs/2026-07-25-mesh-design.md`, replace the latency acceptance-criterion paragraph (the one beginning "Acceptance criterion: **p95 added latency < 30ms") with:

```markdown
Acceptance criterion, revised after measurement in Phase 2: **p95 < 90ms total
for the hook, of which mesh's own work is < 15ms.** Node's own process startup
is the floor — measured at 50–60ms on the development machine for a bare
`node:net` import — so the original "< 30ms" target was never reachable in
Node. Importing the MCP SDK measured 100ms, which is why the hook shim imports
neither the SDK nor zod, and why the CLI loads the MCP server through a
dynamic import. Getting below the Node floor requires a native shim; that is a
later optimization, not a v1 requirement.
```

And add this row to the Open risks table:

```markdown
| MCP server and hook may register the same session twice | The MCP server is not told the host's session id and falls back to `pid-<ppid>`. `mesh init` (Phase 5) must set `MESH_SESSION_ID` to the id the hook reports. |
```

- [ ] **Step 5: Commit**

```bash
cd ~/Projects/mesh
git add test/e2e-messaging.test.ts docs/superpowers/specs/2026-07-25-mesh-design.md
git commit -m "$(cat <<'EOF'
Add end-to-end messaging tests and revise the latency budget

Proves a full cross-client ask round-trip through a real daemon over a real
socket: register, see each other, ask by role, reply, answer returned.

The spec's p95 < 30ms hook budget was unreachable — Node's own startup floor
measured 50-60ms — so it is revised to < 90ms total with < 15ms of mesh work,
and the identity gap between the MCP server and the hook is recorded as a
risk for mesh init to close.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

---

## Plan Self-Review

**Spec coverage for Phase 2.** MCP server and `mesh_*` tools → Task 6. `mesh_send`/`mesh_inbox` → Task 3. Hook injection → Task 5. `mesh_ask`/`mesh_reply` with timeout and deadlock → Tasks 2 and 4. Push-only-what's-addressed-to-you awareness model → Task 5's `formatInjection`, which renders only queued mail and never a general feed. 4KB body cap → Task 1 `validateBody`. Rate limiting and chain caps → Task 2. The idle-agent limitation → Task 4, made observable as `state: "queued"`. Journal entries for send/ask/reply → Tasks 3 and 4.

**Deferred by design:** claims and `PreToolUse` deny (Phase 3), tasks and `mesh board` (Phase 4), `mesh init`/`mesh watch`/the latency benchmark as a CI gate (Phase 5), real-agent e2e (Phase 6). The `mesh_feed` tool is deferred to Phase 3, where the activity ring buffer it reads is built — Phase 2 has no feed to serve.

**Placeholder scan:** clean. Every step contains runnable code or an exact command.

**Type consistency.** `DaemonState` grows `mailbox` (Task 3), `asks` (Task 3), and `waiters` (Task 4); every task that constructs one lists all five fields, and Tasks 3 and 4 each include the step that updates the earlier tests' literals. `Envelope.askId` is `number | null` in Task 1 and consumed as `number | null` in Task 5's `InjectedMessage`. `handleRequest` becomes `Promise<Response>` in Task 3, and Task 3 Step 5 converts the Plan 1 tests that call it synchronously. `WhoAgent` and `formatDuration` are imported in Task 6 from `src/cli/who.ts`, exactly where Plan 1 defined them. `AskState` includes `'cancelled'` for Phase 4's task-cancellation path; nothing in Phase 2 produces it, which is intentional rather than an oversight.
