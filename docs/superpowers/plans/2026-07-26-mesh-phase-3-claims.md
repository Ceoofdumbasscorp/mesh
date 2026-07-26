# mesh Phase 3: Claims and Hard Enforcement — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** An agent that claims a path exclusively cannot have it edited by another agent — the write is blocked before it happens, and the blocked agent is told who holds it and what to do next.

**Architecture:** A pure `ClaimTable` alongside the existing state modules, with a dependency-free glob matcher that is deliberately conservative: patterns it cannot prove disjoint are treated as overlapping. The hook gains an enforcement branch on `PreToolUse` that asks the daemon whether the target path is claimed and, if so, returns a deny decision. Stale claims are defended against three ways — TTL, owning-connection liveness, and idle auto-downgrade — plus a `--force` escape hatch named in every denial message.

**Tech Stack:** Unchanged from Phase 2. Node 25 (>= 22.6), TypeScript with native type-stripping, `node:test`. The enforcement path is in the hook, so it stays dependency-free.

## Global Constraints

All Phase 2 constraints carry forward. Phase 3 additions:

- **`permissionDecisionReason` is MANDATORY on every deny.** Phase 0 measured this: without it Codex reports the hook `Failed` and **runs the tool anyway** — a silent fail-open indistinguishable from a rejected payload. A contract test asserts every deny output carries a non-empty reason.
- **Enforcement is fail-open too.** If the daemon is unreachable, the check times out, or anything throws, the hook allows the edit. mesh blocking an edit because it is broken would be worse than not blocking at all.
- **Conservative glob intersection.** If mesh cannot prove two patterns are disjoint, it treats them as overlapping and refuses the claim. Over-refusing is recoverable; under-refusing means silent data loss.
- **No claims cache file.** The spec proposed mirroring the claim table to disk so the hook could skip IPC. Phase 2 measured the hook's actual cost — Node startup (~50ms) and type-stripping (~40ms), with builtins and a Unix-socket round-trip at roughly 0 — so that cache would add a staleness bug to save nothing. The hook does one socket round-trip.
- **Codex `PreToolUse` fires for shell commands only** (Phase 0). Task 6 measures what that actually leaves uncovered and documents the gap honestly rather than claiming coverage mesh does not have.
- `npm run bench:hook` must still pass at < 90ms p95 with enforcement added.
- Commit messages end with `Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>`.

## File Structure

| Path | Responsibility |
|---|---|
| `src/glob.ts` | Path glob matching and conservative intersection |
| `src/claims.ts` | Claim table: grant, conflict detection, TTL, release, lookup |
| `src/daemon/handlers.ts` | *(modify)* add `claim`, `release`, `claims`, `check` ops |
| `src/daemon/server.ts` | *(modify)* release a departing owner's claims |
| `src/hook.ts` | *(modify)* enforcement branch + deny output builder |
| `src/cli/index.ts` | *(modify)* `mesh claims`, `mesh release` |
| `src/cli/claims.ts` | Rendering for `mesh claims` |
| `spikes/codex-nonshell-enforcement/` | Task 6 probe: what Codex edit paths bypass `PreToolUse` |
| `test/glob.test.ts`, `test/claims.test.ts`, `test/enforcement.test.ts`, `test/e2e-claims.test.ts` | One per module plus end-to-end |

---

### Task 1: Glob matching and intersection

**Files:**
- Create: `src/glob.ts`
- Test: `test/glob.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `function globToRegExp(pattern: string): RegExp`
  - `function matchGlob(pattern: string, path: string): boolean` — `path` is workspace-relative, `/`-separated
  - `function literalPrefix(pattern: string): string`
  - `function globsIntersect(a: string, b: string): boolean` — conservative: `true` unless provably disjoint

Semantics: `*` matches within one segment, `**` matches across segments, `?` matches one non-separator character. A pattern with no wildcard matches that exact path, and also anything beneath it when it names a directory (`src` covers `src/a.ts`) — claiming a directory is the common case and must not require typing `src/**`.

- [ ] **Step 1: Write the failing test**

Create `test/glob.test.ts`:

```typescript
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { matchGlob, literalPrefix, globsIntersect } from '../src/glob.ts';

test('a literal pattern matches only that exact path', () => {
  assert.equal(matchGlob('src/app.ts', 'src/app.ts'), true);
  assert.equal(matchGlob('src/app.ts', 'src/other.ts'), false);
});

test('a bare directory name covers everything beneath it', () => {
  assert.equal(matchGlob('src', 'src/app.ts'), true);
  assert.equal(matchGlob('src', 'src/deep/nested/x.ts'), true);
  assert.equal(matchGlob('src', 'srcolate.ts'), false, 'must not match a mere prefix of a name');
});

test('* matches within one segment only', () => {
  assert.equal(matchGlob('src/*.ts', 'src/app.ts'), true);
  assert.equal(matchGlob('src/*.ts', 'src/deep/app.ts'), false);
});

test('** matches across segments', () => {
  assert.equal(matchGlob('src/**', 'src/app.ts'), true);
  assert.equal(matchGlob('src/**', 'src/deep/nested/app.ts'), true);
  assert.equal(matchGlob('src/**/*.ts', 'src/deep/app.ts'), true);
  assert.equal(matchGlob('src/**', 'other/app.ts'), false);
});

test('? matches exactly one non-separator character', () => {
  assert.equal(matchGlob('src/a?.ts', 'src/ab.ts'), true);
  assert.equal(matchGlob('src/a?.ts', 'src/abc.ts'), false);
  assert.equal(matchGlob('src/a?.ts', 'src/a/.ts'), false);
});

test('regex metacharacters in a pattern are literal', () => {
  assert.equal(matchGlob('src/a.b.ts', 'src/a.b.ts'), true);
  assert.equal(matchGlob('src/a.b.ts', 'src/axbxts'), false, 'dot must not act as a wildcard');
  assert.equal(matchGlob('src/(x).ts', 'src/(x).ts'), true);
});

test('literalPrefix returns everything before the first wildcard', () => {
  assert.equal(literalPrefix('src/api/**'), 'src/api/');
  assert.equal(literalPrefix('src/*.ts'), 'src/');
  assert.equal(literalPrefix('src/app.ts'), 'src/app.ts');
  assert.equal(literalPrefix('**'), '');
});

test('identical patterns intersect', () => {
  assert.equal(globsIntersect('src/**', 'src/**'), true);
});

test('nested patterns intersect', () => {
  assert.equal(globsIntersect('src/**', 'src/api/**'), true);
  assert.equal(globsIntersect('src/api/**', 'src/**'), true, 'intersection is symmetric');
});

test('sibling directories are provably disjoint', () => {
  assert.equal(globsIntersect('app/**', 'server/**'), false);
  assert.equal(globsIntersect('src/api/**', 'src/ui/**'), false);
});

test('a bare ** intersects everything', () => {
  assert.equal(globsIntersect('**', 'anything/at/all'), true);
  assert.equal(globsIntersect('anything/at/all', '**'), true);
});

test('a literal path intersects a glob that covers it', () => {
  assert.equal(globsIntersect('src/api/leads.ts', 'src/api/**'), true);
  assert.equal(globsIntersect('src/api/leads.ts', 'app/**'), false);
});

test('unprovable cases are treated as intersecting, never as disjoint', () => {
  // Both start wildcarded, so nothing can be proven about their overlap.
  // Refusing a legal claim is recoverable; allowing a collision is not.
  assert.equal(globsIntersect('**/*.ts', 'src/**'), true);
});

test('a partial name prefix is not an intersection', () => {
  assert.equal(globsIntersect('src/api/**', 'src/apiary/**'), false);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd ~/Projects/mesh && node --test 'test/glob.test.ts'`
Expected: FAIL — `Cannot find module '../src/glob.ts'`.

- [ ] **Step 3: Write minimal implementation**

Create `src/glob.ts`:

```typescript
const WILDCARD = /[*?]/;

/**
 * Compiles a glob to an anchored RegExp. Every regex metacharacter is escaped
 * first, so a pattern like `src/a.b.ts` matches a literal dot rather than any
 * character — the difference between a precise claim and one that silently
 * covers unrelated files.
 */
export function globToRegExp(pattern: string): RegExp {
  let out = '';
  for (let i = 0; i < pattern.length; i += 1) {
    const char = pattern[i] as string;
    if (char === '*') {
      if (pattern[i + 1] === '*') {
        // ** spans separators. Consume a following slash so `src/**` also
        // matches `src` itself rather than only things strictly beneath it.
        i += 1;
        if (pattern[i + 1] === '/') i += 1;
        out += '.*';
      } else {
        out += '[^/]*';
      }
    } else if (char === '?') {
      out += '[^/]';
    } else {
      out += char.replace(/[.+^${}()|[\]\\]/g, '\\$&');
    }
  }
  return new RegExp(`^${out}$`);
}

export function matchGlob(pattern: string, path: string): boolean {
  if (globToRegExp(pattern).test(path)) return true;
  // A wildcard-free pattern naming a directory covers everything beneath it:
  // claiming `src` should not require typing `src/**`. The trailing slash is
  // what stops `src` from also matching `srcolate.ts`.
  if (!WILDCARD.test(pattern)) return path.startsWith(`${pattern}/`);
  return false;
}

/** Everything before the first wildcard. The part we can reason about exactly. */
export function literalPrefix(pattern: string): string {
  const index = pattern.search(WILDCARD);
  return index === -1 ? pattern : pattern.slice(0, index);
}

/**
 * Conservative: returns true unless the two patterns are PROVABLY disjoint.
 *
 * Proving general glob disjointness is not worth the complexity here, so we
 * only decide the case we can be certain about — literal prefixes that
 * diverge at a path boundary. Everything else is reported as overlapping.
 * Over-refusing a claim is an inconvenience; under-refusing is silent data
 * loss when two agents edit the same file.
 */
export function globsIntersect(a: string, b: string): boolean {
  if (a === b) return true;
  if (matchGlob(a, b) || matchGlob(b, a)) return true;

  const prefixA = literalPrefix(a);
  const prefixB = literalPrefix(b);
  // A pattern starting with a wildcard could match anywhere.
  if (prefixA.length === 0 || prefixB.length === 0) return true;

  const shorter = prefixA.length <= prefixB.length ? prefixA : prefixB;
  const longer = prefixA.length <= prefixB.length ? prefixB : prefixA;
  if (!longer.startsWith(shorter)) return false;

  // The prefixes share a head. That is only a real overlap if the head ends
  // at a path boundary — otherwise `src/api/` and `src/apiary/` would look
  // related when they are separate directories.
  const rest = longer.slice(shorter.length);
  return shorter.endsWith('/') || rest.length === 0 || rest.startsWith('/');
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd ~/Projects/mesh && node --test 'test/glob.test.ts' && npm run typecheck`
Expected: 14 tests pass, typecheck clean.

- [ ] **Step 5: Commit**

```bash
cd ~/Projects/mesh
git add src/glob.ts test/glob.test.ts
git commit -m "$(cat <<'EOF'
Add dependency-free glob matching and conservative intersection

Intersection only decides the case it can prove — literal prefixes diverging
at a path boundary — and reports everything else as overlapping. Over-refusing
a claim is recoverable; under-refusing means two agents silently editing the
same file.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 2: Claim table

**Files:**
- Create: `src/claims.ts`
- Test: `test/claims.test.ts`

**Interfaces:**
- Consumes: `Clock`, `globsIntersect`/`matchGlob` from `src/glob.ts`.
- Produces:
  - `type ClaimMode = 'shared' | 'exclusive'`
  - `interface Claim { id: number; holder: string; workspaceRoot: string; patterns: string[]; mode: ClaimMode; grantedAt: number; expiresAt: number }`
  - `interface Conflict { pattern: string; holder: string; claimId: number }`
  - `type ClaimResult = { ok: true; claim: Claim } | { ok: false; conflicts: Conflict[] }`
  - `interface CheckResult { allowed: boolean; holder?: string; claimId?: number; pattern?: string }`
  - `class ClaimTable { constructor(o: { clock: Clock; defaultTtlMs?: number }); claim(i: { holder: string; workspaceRoot: string; patterns: string[]; mode?: ClaimMode; ttlMs?: number }): ClaimResult; release(holder: string, patterns?: string[]): number; forceRelease(workspaceRoot: string, pattern: string): number; refresh(holder: string): number; check(workspaceRoot: string, path: string, requester: string): CheckResult; list(workspaceRoot: string): Claim[]; expire(): Claim[] }`

`check` returns `allowed: true` for the holder itself, for unclaimed paths, and for `shared` claims. Only an `exclusive` claim held by someone else denies.

- [ ] **Step 1: Write the failing test**

Create `test/claims.test.ts`:

```typescript
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { testClock } from '../src/clock.ts';
import { ClaimTable } from '../src/claims.ts';

const WS = '/repo';

function setup(defaultTtlMs = 900_000) {
  const clock = testClock(1000);
  return { clock, claims: new ClaimTable({ clock: clock.now, defaultTtlMs }) };
}

test('grants a claim and reports it', () => {
  const { claims } = setup();
  const res = claims.claim({ holder: 'codex-1', workspaceRoot: WS, patterns: ['server/**'] });
  assert.equal(res.ok, true);
  if (!res.ok) return;
  assert.equal(res.claim.mode, 'exclusive', 'exclusive is the default');
  assert.equal(res.claim.expiresAt, 1000 + 900_000);
  assert.deepEqual(claims.list(WS).map((c) => c.holder), ['codex-1']);
});

test('blocks a non-holder from a claimed path', () => {
  const { claims } = setup();
  claims.claim({ holder: 'codex-1', workspaceRoot: WS, patterns: ['server/**'] });

  const check = claims.check(WS, 'server/api/leads.ts', 'claude-2');
  assert.equal(check.allowed, false);
  assert.equal(check.holder, 'codex-1');
});

test('allows the holder to edit its own claim', () => {
  const { claims } = setup();
  claims.claim({ holder: 'codex-1', workspaceRoot: WS, patterns: ['server/**'] });
  assert.equal(claims.check(WS, 'server/api/leads.ts', 'codex-1').allowed, true);
});

test('allows paths outside every claim', () => {
  const { claims } = setup();
  claims.claim({ holder: 'codex-1', workspaceRoot: WS, patterns: ['server/**'] });
  assert.equal(claims.check(WS, 'app/page.tsx', 'claude-2').allowed, true);
});

test('a shared claim never blocks anyone', () => {
  const { claims } = setup();
  claims.claim({ holder: 'codex-1', workspaceRoot: WS, patterns: ['docs/**'], mode: 'shared' });
  assert.equal(claims.check(WS, 'docs/readme.md', 'claude-2').allowed, true);
});

test('refuses an overlapping exclusive claim and names the conflict', () => {
  const { claims } = setup();
  claims.claim({ holder: 'codex-1', workspaceRoot: WS, patterns: ['server/**'] });

  const second = claims.claim({ holder: 'claude-2', workspaceRoot: WS, patterns: ['server/api/**'] });
  assert.equal(second.ok, false);
  if (second.ok) return;
  assert.equal(second.conflicts[0]?.holder, 'codex-1');
});

test('allows a non-overlapping claim', () => {
  const { claims } = setup();
  claims.claim({ holder: 'codex-1', workspaceRoot: WS, patterns: ['server/**'] });
  const second = claims.claim({ holder: 'claude-2', workspaceRoot: WS, patterns: ['app/**'] });
  assert.equal(second.ok, true);
});

test('two shared claims may overlap', () => {
  const { claims } = setup();
  claims.claim({ holder: 'a', workspaceRoot: WS, patterns: ['docs/**'], mode: 'shared' });
  const second = claims.claim({ holder: 'b', workspaceRoot: WS, patterns: ['docs/**'], mode: 'shared' });
  assert.equal(second.ok, true);
});

test('claims are scoped to a workspace', () => {
  const { claims } = setup();
  claims.claim({ holder: 'codex-1', workspaceRoot: WS, patterns: ['server/**'] });

  assert.equal(claims.check('/other-repo', 'server/api/leads.ts', 'claude-2').allowed, true);
  const elsewhere = claims.claim({
    holder: 'claude-2', workspaceRoot: '/other-repo', patterns: ['server/**'],
  });
  assert.equal(elsewhere.ok, true);
});

test('re-claiming the same pattern as the same holder refreshes rather than conflicts', () => {
  const { clock, claims } = setup();
  claims.claim({ holder: 'codex-1', workspaceRoot: WS, patterns: ['server/**'] });
  clock.advance(60_000);

  const again = claims.claim({ holder: 'codex-1', workspaceRoot: WS, patterns: ['server/**'] });
  assert.equal(again.ok, true);
  if (!again.ok) return;
  assert.equal(again.claim.expiresAt, 61_000 + 900_000);
  assert.equal(claims.list(WS).length, 1, 'no duplicate claim');
});

test('an expired claim stops blocking', () => {
  const { clock, claims } = setup(1000);
  claims.claim({ holder: 'codex-1', workspaceRoot: WS, patterns: ['server/**'] });
  assert.equal(claims.check(WS, 'server/x.ts', 'claude-2').allowed, false);

  clock.advance(1001);
  assert.equal(claims.check(WS, 'server/x.ts', 'claude-2').allowed, true);
});

test('expire removes lapsed claims and returns them', () => {
  const { clock, claims } = setup(1000);
  claims.claim({ holder: 'codex-1', workspaceRoot: WS, patterns: ['server/**'] });
  clock.advance(1001);

  const expired = claims.expire();
  assert.equal(expired.length, 1);
  assert.deepEqual(claims.list(WS), []);
});

test('refresh extends every claim a holder has', () => {
  const { clock, claims } = setup(1000);
  claims.claim({ holder: 'codex-1', workspaceRoot: WS, patterns: ['server/**'] });
  clock.advance(900);

  assert.equal(claims.refresh('codex-1'), 1);
  clock.advance(900);
  assert.equal(claims.check(WS, 'server/x.ts', 'claude-2').allowed, false, 'still held');
});

test('release drops a holder claims and returns the count', () => {
  const { claims } = setup();
  claims.claim({ holder: 'codex-1', workspaceRoot: WS, patterns: ['server/**'] });
  claims.claim({ holder: 'codex-1', workspaceRoot: WS, patterns: ['db/**'] });

  assert.equal(claims.release('codex-1'), 2);
  assert.deepEqual(claims.list(WS), []);
});

test('release can target one pattern', () => {
  const { claims } = setup();
  claims.claim({ holder: 'codex-1', workspaceRoot: WS, patterns: ['server/**'] });
  claims.claim({ holder: 'codex-1', workspaceRoot: WS, patterns: ['db/**'] });

  assert.equal(claims.release('codex-1', ['server/**']), 1);
  assert.deepEqual(claims.list(WS).map((c) => c.patterns[0]), ['db/**']);
});

test('forceRelease breaks another agent claim', () => {
  const { claims } = setup();
  claims.claim({ holder: 'codex-1', workspaceRoot: WS, patterns: ['server/**'] });

  assert.equal(claims.forceRelease(WS, 'server/**'), 1);
  assert.equal(claims.check(WS, 'server/x.ts', 'claude-2').allowed, true);
});

test('forceRelease reports zero when nothing matched', () => {
  const { claims } = setup();
  assert.equal(claims.forceRelease(WS, 'nothing/**'), 0);
});

test('one claim can cover several patterns', () => {
  const { claims } = setup();
  const res = claims.claim({
    holder: 'codex-1', workspaceRoot: WS, patterns: ['server/**', 'db/**'],
  });
  assert.equal(res.ok, true);
  assert.equal(claims.check(WS, 'server/x.ts', 'claude-2').allowed, false);
  assert.equal(claims.check(WS, 'db/y.sql', 'claude-2').allowed, false);
});

test('check reports which pattern matched, for the denial message', () => {
  const { claims } = setup();
  claims.claim({ holder: 'codex-1', workspaceRoot: WS, patterns: ['server/**'] });
  const check = claims.check(WS, 'server/api/leads.ts', 'claude-2');
  assert.equal(check.pattern, 'server/**');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd ~/Projects/mesh && node --test 'test/claims.test.ts'`
Expected: FAIL — `Cannot find module '../src/claims.ts'`.

- [ ] **Step 3: Write minimal implementation**

Create `src/claims.ts`:

```typescript
import type { Clock } from './clock.ts';
import { globsIntersect, matchGlob } from './glob.ts';

export type ClaimMode = 'shared' | 'exclusive';

export interface Claim {
  id: number;
  holder: string;
  workspaceRoot: string;
  patterns: string[];
  mode: ClaimMode;
  grantedAt: number;
  expiresAt: number;
}

export interface Conflict {
  pattern: string;
  holder: string;
  claimId: number;
}

export type ClaimResult = { ok: true; claim: Claim } | { ok: false; conflicts: Conflict[] };

export interface CheckResult {
  allowed: boolean;
  holder?: string;
  claimId?: number;
  pattern?: string;
}

export interface ClaimTableOptions {
  clock: Clock;
  /** How long a claim survives without a refresh. */
  defaultTtlMs?: number;
}

const DEFAULT_TTL_MS = 15 * 60_000;

export class ClaimTable {
  #clock: Clock;
  #defaultTtlMs: number;
  #claims = new Map<number, Claim>();
  #nextId = 1;

  constructor(options: ClaimTableOptions) {
    this.#clock = options.clock;
    this.#defaultTtlMs = options.defaultTtlMs ?? DEFAULT_TTL_MS;
  }

  /** Live claims in a workspace. Expiry is evaluated on read, not by a timer. */
  #live(workspaceRoot: string): Claim[] {
    const now = this.#clock();
    return [...this.#claims.values()].filter(
      (c) => c.workspaceRoot === workspaceRoot && c.expiresAt > now,
    );
  }

  claim(input: {
    holder: string;
    workspaceRoot: string;
    patterns: string[];
    mode?: ClaimMode;
    ttlMs?: number;
  }): ClaimResult {
    const mode = input.mode ?? 'exclusive';
    const now = this.#clock();
    const expiresAt = now + (input.ttlMs ?? this.#defaultTtlMs);

    // Re-claiming exactly what you already hold is a refresh, not a conflict.
    // Agents re-assert claims routinely and should never fight themselves.
    const existing = this.#live(input.workspaceRoot).find(
      (c) =>
        c.holder === input.holder &&
        c.patterns.length === input.patterns.length &&
        c.patterns.every((p, i) => p === input.patterns[i]),
    );
    if (existing) {
      existing.expiresAt = expiresAt;
      existing.mode = mode;
      return { ok: true, claim: existing };
    }

    const conflicts: Conflict[] = [];
    if (mode === 'exclusive') {
      for (const other of this.#live(input.workspaceRoot)) {
        if (other.holder === input.holder) continue;
        if (other.mode !== 'exclusive') continue;
        for (const wanted of input.patterns) {
          for (const held of other.patterns) {
            if (globsIntersect(wanted, held)) {
              conflicts.push({ pattern: held, holder: other.holder, claimId: other.id });
            }
          }
        }
      }
    }
    if (conflicts.length > 0) return { ok: false, conflicts };

    const claim: Claim = {
      id: this.#nextId++,
      holder: input.holder,
      workspaceRoot: input.workspaceRoot,
      patterns: [...input.patterns],
      mode,
      grantedAt: now,
      expiresAt,
    };
    this.#claims.set(claim.id, claim);
    return { ok: true, claim };
  }

  release(holder: string, patterns?: string[]): number {
    let removed = 0;
    for (const [id, claim] of [...this.#claims]) {
      if (claim.holder !== holder) continue;
      if (patterns && !patterns.some((p) => claim.patterns.includes(p))) continue;
      this.#claims.delete(id);
      removed += 1;
    }
    return removed;
  }

  /** Breaks any claim whose patterns overlap the given one, whoever holds it. */
  forceRelease(workspaceRoot: string, pattern: string): number {
    let removed = 0;
    for (const [id, claim] of [...this.#claims]) {
      if (claim.workspaceRoot !== workspaceRoot) continue;
      if (!claim.patterns.some((p) => globsIntersect(p, pattern))) continue;
      this.#claims.delete(id);
      removed += 1;
    }
    return removed;
  }

  /** Extends every claim a holder has. Called when the holder shows activity. */
  refresh(holder: string): number {
    const expiresAt = this.#clock() + this.#defaultTtlMs;
    let refreshed = 0;
    for (const claim of this.#claims.values()) {
      if (claim.holder !== holder) continue;
      claim.expiresAt = expiresAt;
      refreshed += 1;
    }
    return refreshed;
  }

  check(workspaceRoot: string, path: string, requester: string): CheckResult {
    for (const claim of this.#live(workspaceRoot)) {
      if (claim.holder === requester) continue;
      if (claim.mode !== 'exclusive') continue;
      for (const pattern of claim.patterns) {
        if (matchGlob(pattern, path)) {
          return { allowed: false, holder: claim.holder, claimId: claim.id, pattern };
        }
      }
    }
    return { allowed: true };
  }

  list(workspaceRoot: string): Claim[] {
    return this.#live(workspaceRoot);
  }

  expire(): Claim[] {
    const now = this.#clock();
    const expired: Claim[] = [];
    for (const [id, claim] of [...this.#claims]) {
      if (claim.expiresAt <= now) {
        this.#claims.delete(id);
        expired.push(claim);
      }
    }
    return expired;
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd ~/Projects/mesh && node --test 'test/claims.test.ts' && npm run typecheck`
Expected: 19 tests pass, typecheck clean.

- [ ] **Step 5: Commit**

```bash
cd ~/Projects/mesh
git add src/claims.ts test/claims.test.ts
git commit -m "$(cat <<'EOF'
Add claim table with TTL and conflict detection

Expiry is evaluated on read rather than by a timer, so the module stays a pure
state machine like Registry and AskRegistry. Re-claiming what you already hold
refreshes instead of conflicting, because agents re-assert claims routinely and
should never fight themselves.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 3: Claim ops on the daemon

**Files:**
- Modify: `src/daemon/handlers.ts`, `src/daemon/server.ts`
- Test: `test/enforcement.test.ts` (first half)

**Interfaces:**
- Consumes: `ClaimTable`.
- Produces:
  - `DaemonState` gains `claims: ClaimTable`.
  - Ops: `claim` (`patterns: string[]`, `mode?`, `ttlMs?`), `release` (`patterns?`, `force?`), `claims` (list), `check` (`path`, returns allow/deny plus a ready-made `reason`).
  - `function denialReason(o: { path: string; holder: string; pattern: string; holderIdleMs: number }): string`

`check` composes the denial text on the daemon rather than in the hook, so the message stays identical no matter which client asks.

**Idle auto-downgrade:** if the holder is alive but idle beyond the claim TTL, `check` returns `allowed: true` with a `warning`. A stalled agent must not wedge a working one.

- [ ] **Step 1: Write the failing test**

Create `test/enforcement.test.ts`:

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
import { ClaimTable } from '../src/claims.ts';
import { Waiters } from '../src/daemon/waiters.ts';
import { handleRequest, denialReason } from '../src/daemon/handlers.ts';
import type { ConnectionContext, DaemonState } from '../src/daemon/handlers.ts';

function setup() {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'mesh-enf-')));
  const clock = testClock(1000);
  const state: DaemonState = {
    clock: clock.now,
    registry: new Registry({ clock: clock.now }),
    journal: new Journal(join(base, 'journal.jsonl'), clock.now),
    mailbox: new Mailbox({ clock: clock.now }),
    asks: new AskRegistry({ clock: clock.now }),
    claims: new ClaimTable({ clock: clock.now }),
    waiters: new Waiters(),
  };
  return { base, clock, state, cleanup: () => rmSync(base, { recursive: true, force: true }) };
}

const ctx = (): ConnectionContext => ({ sessionId: null, owns: false });

async function join2(state: DaemonState, base: string) {
  const a = ctx();
  const b = ctx();
  await handleRequest(state, a, { id: 1, op: 'register', sessionId: 'sa', provider: 'claude', cwd: base });
  await handleRequest(state, b, { id: 1, op: 'register', sessionId: 'sb', provider: 'codex', cwd: base });
  return { a, b };
}

test('denialReason names the holder, the pattern, and the escape hatch', () => {
  const text = denialReason({
    path: 'server/api/leads.ts', holder: 'codex-1', pattern: 'server/**', holderIdleMs: 4000,
  });
  assert.match(text, /server\/api\/leads\.ts/);
  assert.match(text, /codex-1/);
  assert.match(text, /mesh_ask/, 'tells the agent how to unblock itself');
  assert.match(text, /mesh release --force/, 'names the escape hatch');
});

test('claim grants and is visible to claims', async () => {
  const { base, state, cleanup } = setup();
  try {
    const { b } = await join2(state, base);
    const res = await handleRequest(state, b, { id: 2, op: 'claim', patterns: ['server/**'] });
    assert.equal(res.ok, true);

    const list = await handleRequest(state, b, { id: 3, op: 'claims', cwd: base });
    const held = list.claims as Array<Record<string, unknown>>;
    assert.equal(held.length, 1);
    assert.equal(held[0]?.holder, 'codex-1');
  } finally {
    cleanup();
  }
});

test('check denies a non-holder and supplies a reason', async () => {
  const { base, state, cleanup } = setup();
  try {
    const { a, b } = await join2(state, base);
    await handleRequest(state, b, { id: 2, op: 'claim', patterns: ['server/**'] });

    const res = await handleRequest(state, a, { id: 3, op: 'check', path: 'server/api/leads.ts' });
    assert.equal(res.allowed, false);
    assert.equal(res.holder, 'codex-1');
    assert.match(String(res.reason), /codex-1/);
    assert.ok(String(res.reason).length > 0, 'a deny must always carry a reason');
  } finally {
    cleanup();
  }
});

test('check allows the holder and unclaimed paths', async () => {
  const { base, state, cleanup } = setup();
  try {
    const { a, b } = await join2(state, base);
    await handleRequest(state, b, { id: 2, op: 'claim', patterns: ['server/**'] });

    assert.equal((await handleRequest(state, b, { id: 3, op: 'check', path: 'server/x.ts' })).allowed, true);
    assert.equal((await handleRequest(state, a, { id: 4, op: 'check', path: 'app/page.tsx' })).allowed, true);
  } finally {
    cleanup();
  }
});

test('check accepts an absolute path and resolves it against the workspace', async () => {
  const { base, state, cleanup } = setup();
  try {
    const { a, b } = await join2(state, base);
    await handleRequest(state, b, { id: 2, op: 'claim', patterns: ['server/**'] });

    const res = await handleRequest(state, a, {
      id: 3, op: 'check', path: join(base, 'server/api/leads.ts'),
    });
    assert.equal(res.allowed, false, 'an absolute path must resolve to the same claim');
  } finally {
    cleanup();
  }
});

test('an overlapping claim is refused and names the holder', async () => {
  const { base, state, cleanup } = setup();
  try {
    const { a, b } = await join2(state, base);
    await handleRequest(state, b, { id: 2, op: 'claim', patterns: ['server/**'] });

    const res = await handleRequest(state, a, { id: 3, op: 'claim', patterns: ['server/api/**'] });
    assert.equal(res.ok, false);
    assert.match(String(res.error), /codex-1/);
  } finally {
    cleanup();
  }
});

test('an idle holder auto-downgrades from deny to a warning', async () => {
  const { base, clock, state, cleanup } = setup();
  try {
    const { a, b } = await join2(state, base);
    await handleRequest(state, b, { id: 2, op: 'claim', patterns: ['server/**'], ttlMs: 60_000 });

    // codex-1 goes quiet for longer than the claim's own TTL.
    clock.advance(120_000);
    const res = await handleRequest(state, a, { id: 3, op: 'check', path: 'server/x.ts' });
    assert.equal(res.allowed, true, 'a stalled agent must not wedge a working one');
    assert.match(String(res.warning), /idle/i);
  } finally {
    cleanup();
  }
});

test('release frees the path', async () => {
  const { base, state, cleanup } = setup();
  try {
    const { a, b } = await join2(state, base);
    await handleRequest(state, b, { id: 2, op: 'claim', patterns: ['server/**'] });
    const released = await handleRequest(state, b, { id: 3, op: 'release' });
    assert.equal(released.released, 1);

    assert.equal((await handleRequest(state, a, { id: 4, op: 'check', path: 'server/x.ts' })).allowed, true);
  } finally {
    cleanup();
  }
});

test('force release breaks another agent claim', async () => {
  const { base, state, cleanup } = setup();
  try {
    const { a, b } = await join2(state, base);
    await handleRequest(state, b, { id: 2, op: 'claim', patterns: ['server/**'] });

    const forced = await handleRequest(state, a, {
      id: 3, op: 'release', patterns: ['server/**'], force: true, cwd: base,
    });
    assert.equal(forced.released, 1);
    assert.equal((await handleRequest(state, a, { id: 4, op: 'check', path: 'server/x.ts' })).allowed, true);
  } finally {
    cleanup();
  }
});

test('a non-forced release cannot touch another agent claim', async () => {
  const { base, state, cleanup } = setup();
  try {
    const { a, b } = await join2(state, base);
    await handleRequest(state, b, { id: 2, op: 'claim', patterns: ['server/**'] });

    const attempt = await handleRequest(state, a, { id: 3, op: 'release', patterns: ['server/**'] });
    assert.equal(attempt.released, 0);
    assert.equal((await handleRequest(state, a, { id: 4, op: 'check', path: 'server/x.ts' })).allowed, false);
  } finally {
    cleanup();
  }
});

test('touch refreshes the claims of an active holder', async () => {
  const { base, clock, state, cleanup } = setup();
  try {
    const { a, b } = await join2(state, base);
    await handleRequest(state, b, { id: 2, op: 'claim', patterns: ['server/**'], ttlMs: 60_000 });

    clock.advance(50_000);
    await handleRequest(state, b, { id: 3, op: 'touch', activity: 'Edit server/api.ts' });
    clock.advance(50_000);

    const res = await handleRequest(state, a, { id: 4, op: 'check', path: 'server/x.ts' });
    assert.equal(res.allowed, false, 'an active holder keeps its claim');
  } finally {
    cleanup();
  }
});

test('claim requires a registered agent', async () => {
  const { state, cleanup } = setup();
  try {
    const res = await handleRequest(state, ctx(), { id: 1, op: 'claim', patterns: ['x/**'] });
    assert.equal(res.ok, false);
    assert.match(String(res.error), /register/i);
  } finally {
    cleanup();
  }
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd ~/Projects/mesh && node --test 'test/enforcement.test.ts'`
Expected: FAIL — `claims` is not on `DaemonState` and `denialReason` is not exported.

- [ ] **Step 3: Add ClaimTable to state and the claim ops**

In `src/daemon/handlers.ts`, add the import and state field:

```typescript
import type { ClaimTable } from '../claims.ts';
```

Add `claims: ClaimTable;` to the `DaemonState` interface.

Add this exported helper above `handleRequest`:

```typescript
/**
 * The text an agent sees when its edit is blocked. Composed on the daemon so
 * every client shows the same wording, and written to be acted on rather than
 * merely to explain: it names the holder, how to unblock, and the escape hatch.
 */
export function denialReason(input: {
  path: string;
  holder: string;
  pattern: string;
  holderIdleMs: number;
}): string {
  const idleSeconds = Math.round(input.holderIdleMs / 1000);
  return (
    `BLOCKED by mesh: ${input.path} is claimed exclusively by ${input.holder} ` +
    `(matched "${input.pattern}", active ${idleSeconds}s ago). Do not edit it. ` +
    `Either mesh_ask ${input.holder} to make the change, or run ` +
    `\`mesh release --force "${input.pattern}"\` if ${input.holder} has been abandoned.`
  );
}
```

Add these cases immediately before `case 'shutdown':`:

```typescript
    case 'claim': {
      const caller = callerOf(state, ctx, req);
      if (!caller) return fail(id, 'claim requires a registered agent (call register first)');
      const patterns = Array.isArray(req.patterns)
        ? req.patterns.filter((p): p is string => typeof p === 'string' && p.trim().length > 0)
        : [];
      if (patterns.length === 0) return fail(id, 'claim requires a non-empty "patterns" array');

      const mode = req.mode === 'shared' ? 'shared' : 'exclusive';
      const result = state.claims.claim({
        holder: caller.name,
        workspaceRoot: caller.workspaceRoot,
        patterns,
        mode,
        ...(typeof req.ttlMs === 'number' ? { ttlMs: req.ttlMs } : {}),
      });

      if (!result.ok) {
        const first = result.conflicts[0];
        return fail(
          id,
          `Cannot claim: ${first?.holder} already holds "${first?.pattern}". ` +
            `Ask them to release it, or claim a narrower path.`,
        );
      }

      state.journal.append('claim', { holder: caller.name, patterns, mode });
      return { id, ok: true, claimId: result.claim.id, patterns, mode, expiresAt: result.claim.expiresAt };
    }

    case 'release': {
      const caller = callerOf(state, ctx, req);
      if (!caller) return fail(id, 'release requires a registered agent (call register first)');
      const patterns = Array.isArray(req.patterns)
        ? req.patterns.filter((p): p is string => typeof p === 'string')
        : undefined;

      let released = 0;
      if (req.force === true) {
        for (const pattern of patterns ?? []) {
          released += state.claims.forceRelease(caller.workspaceRoot, pattern);
        }
        state.journal.append('release-force', { by: caller.name, patterns });
      } else {
        released = state.claims.release(caller.name, patterns);
        state.journal.append('release', { holder: caller.name, patterns, released });
      }
      return { id, ok: true, released };
    }

    case 'claims': {
      const workspace = resolveWorkspace(readString(req, 'cwd') ?? process.cwd());
      const caller = callerOf(state, ctx, req);
      const root = caller?.workspaceRoot ?? workspace.root;
      const now = state.clock();
      return {
        id,
        ok: true,
        claims: state.claims.list(root).map((c) => ({
          id: c.id,
          holder: c.holder,
          patterns: c.patterns,
          mode: c.mode,
          expiresInMs: c.expiresAt - now,
        })),
      };
    }

    case 'check': {
      const caller = callerOf(state, ctx, req);
      if (!caller) return { id, ok: true, allowed: true };
      const rawPath = readString(req, 'path');
      if (!rawPath) return { id, ok: true, allowed: true };

      // Accept absolute or workspace-relative paths: hooks report absolute
      // ones, agents think in relative ones, and both must hit the same claim.
      const relative = rawPath.startsWith(caller.workspaceRoot)
        ? rawPath.slice(caller.workspaceRoot.length).replace(/^\/+/, '')
        : rawPath;

      const verdict = state.claims.check(caller.workspaceRoot, relative, caller.name);
      if (verdict.allowed) return { id, ok: true, allowed: true };

      const holderAgent = state.registry.byName(caller.workspaceRoot, verdict.holder as string);
      const holderIdleMs = holderAgent ? state.clock() - holderAgent.lastSeen : 0;
      const ttlMs = 15 * 60_000;

      // A stalled holder must not wedge a working agent. Warn instead of deny.
      if (holderAgent && holderIdleMs > ttlMs) {
        return {
          id,
          ok: true,
          allowed: true,
          warning:
            `${verdict.holder} holds "${verdict.pattern}" but has been idle ` +
            `${Math.round(holderIdleMs / 1000)}s. Proceeding; consider releasing the claim.`,
        };
      }

      return {
        id,
        ok: true,
        allowed: false,
        holder: verdict.holder,
        pattern: verdict.pattern,
        reason: denialReason({
          path: relative,
          holder: verdict.holder as string,
          pattern: verdict.pattern as string,
          holderIdleMs,
        }),
      };
    }
```

Finally, make `touch` refresh claims. Replace the `touch` case body with:

```typescript
    case 'touch': {
      const sessionId = readString(req, 'sessionId') ?? ctx.sessionId;
      if (!sessionId) return fail(id, 'touch requires "sessionId"');
      const known = state.registry.touch(sessionId, readString(req, 'activity'));
      // Activity is what keeps a claim alive: an agent still working never
      // loses its claims, while a stalled one lets them lapse.
      const agent = state.registry.get(sessionId);
      if (agent) state.claims.refresh(agent.name);
      return { id, ok: true, known };
    }
```

- [ ] **Step 4: Wire ClaimTable into daemon state and release on disconnect**

In `src/daemon/server.ts`, add `import { ClaimTable } from '../claims.ts';` and add `claims: new ClaimTable({ clock }),` to the object returned by `createDaemonState`.

In the connection `cleanup` function, release the departing agent's claims. Replace the block inside `if (ctx.sessionId && ctx.owns) {` with:

```typescript
        const removed = this.#options.state.registry.unregister(ctx.sessionId);
        if (removed) {
          // A dead agent must not hold paths hostage.
          const releasedClaims = this.#options.state.claims.release(removed.name);
          this.#options.state.journal.append('disconnect', {
            name: removed.name,
            sessionId: ctx.sessionId,
            releasedClaims,
          });
        }
        ctx.sessionId = null;
```

- [ ] **Step 5: Add the field to every other DaemonState literal**

In `test/handlers.test.ts`, `test/server.test.ts`, `test/client.test.ts`, `test/messaging.test.ts`, and `test/ask.test.ts`, add:

```typescript
import { ClaimTable } from '../src/claims.ts';
```

and add this line to each `DaemonState` object literal:

```typescript
    claims: new ClaimTable({ clock: clock.now }),
```

(In `test/ask.test.ts` the clock variable is named `clock` and holds `systemClock`, so the line there is `claims: new ClaimTable({ clock }),`.)

- [ ] **Step 6: Run tests to verify they pass**

Run: `cd ~/Projects/mesh && npm test && npm run typecheck`
Expected: every suite passes, including 12 new enforcement tests.

- [ ] **Step 7: Commit**

```bash
cd ~/Projects/mesh
git add src/ test/
git commit -m "$(cat <<'EOF'
Add claim, release, claims, and check ops

The denial message is composed on the daemon so every client shows identical
wording, and it is written to be acted on: it names the holder, how to reach
them, and the force-release escape hatch.

Activity refreshes claims, so an agent still working never loses them while a
stalled one lets them lapse. An idle holder auto-downgrades from deny to a
warning, and a disconnecting owner's claims are released outright.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 4: Hook enforcement

**Files:**
- Modify: `src/hook.ts`
- Test: `test/hook.test.ts` (extend)

**Interfaces:**
- Consumes: the `check` op.
- Produces:
  - `const WRITE_TOOLS: ReadonlySet<string>`
  - `function targetPathOf(input: HookInput): string | null`
  - `function buildDenyOutput(event: string, reason: string): Record<string, unknown>`
  - `runHook` gains the enforcement branch.

`buildDenyOutput` **always** emits `permissionDecisionReason`. Phase 0 proved that without it Codex reports the hook `Failed` and runs the tool anyway.

- [ ] **Step 1: Write the failing test**

Append to `test/hook.test.ts`:

```typescript
import { WRITE_TOOLS, targetPathOf, buildDenyOutput } from '../src/hook.ts';

test('write-capable tools are recognised, read-only ones are not', () => {
  for (const tool of ['Write', 'Edit', 'MultiEdit', 'NotebookEdit']) {
    assert.ok(WRITE_TOOLS.has(tool), `${tool} should be enforced`);
  }
  for (const tool of ['Read', 'Grep', 'Glob', 'WebSearch']) {
    assert.equal(WRITE_TOOLS.has(tool), false, `${tool} must not be enforced`);
  }
});

test('targetPathOf reads file_path from an edit', () => {
  assert.equal(
    targetPathOf({ tool_name: 'Edit', tool_input: { file_path: '/repo/server/api.ts' } }),
    '/repo/server/api.ts',
  );
});

test('targetPathOf reads notebook_path as well', () => {
  assert.equal(
    targetPathOf({ tool_name: 'NotebookEdit', tool_input: { notebook_path: '/repo/a.ipynb' } }),
    '/repo/a.ipynb',
  );
});

test('targetPathOf returns null when there is no path to check', () => {
  assert.equal(targetPathOf({ tool_name: 'Edit', tool_input: {} }), null);
  assert.equal(targetPathOf({ tool_name: 'Read' }), null);
});

test('buildDenyOutput ALWAYS carries permissionDecisionReason', () => {
  // Phase 0: a deny without a reason makes Codex report the hook Failed and
  // run the tool anyway — a silent fail-open. This test is the guard.
  const out = buildDenyOutput('PreToolUse', 'BLOCKED by mesh: held by codex-1');
  const specific = (out.hookSpecificOutput ?? {}) as Record<string, unknown>;
  assert.equal(specific.hookEventName, 'PreToolUse');
  assert.equal(specific.permissionDecision, 'deny');
  assert.ok(
    typeof specific.permissionDecisionReason === 'string' &&
      specific.permissionDecisionReason.length > 0,
    'a deny without a reason silently fails open on Codex',
  );
});

test('buildDenyOutput does not emit systemMessage alongside the decision', () => {
  // Phase 0 measured this exact combination reporting Failed.
  const out = buildDenyOutput('PreToolUse', 'blocked');
  assert.equal('systemMessage' in out, false);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd ~/Projects/mesh && node --test 'test/hook.test.ts'`
Expected: FAIL — `WRITE_TOOLS`, `targetPathOf`, `buildDenyOutput` are not exported.

- [ ] **Step 3: Write minimal implementation**

In `src/hook.ts`, add above `runHook`:

```typescript
/**
 * Tools that can modify a file. Only these are checked against claims —
 * enforcing reads would cost a round-trip on every Grep for no benefit.
 */
export const WRITE_TOOLS: ReadonlySet<string> = new Set([
  'Write',
  'Edit',
  'MultiEdit',
  'NotebookEdit',
]);

export function targetPathOf(input: HookInput): string | null {
  const args = input.tool_input ?? {};
  for (const key of ['file_path', 'notebook_path', 'path']) {
    const value = args[key];
    if (typeof value === 'string' && value.length > 0) return value;
  }
  return null;
}

/**
 * A deny decision. permissionDecisionReason is NOT optional: Phase 0 measured
 * that omitting it makes Codex report the hook as Failed and run the tool
 * anyway — a silent fail-open that looks identical to a rejected payload.
 * systemMessage is deliberately absent; that combination measured as Failed.
 */
export function buildDenyOutput(event: string, reason: string): Record<string, unknown> {
  return {
    hookSpecificOutput: {
      hookEventName: event,
      permissionDecision: 'deny',
      permissionDecisionReason: reason,
    },
  };
}
```

Then, inside `runHook`, replace the block that starts at `const activity = summarizeTool(input);` with:

```typescript
      const activity = summarizeTool(input);
      await client.request('touch', { sessionId, ...(activity ? { activity } : {}) });

      // Enforcement: only write-capable tools, and only when a path is present.
      const tool = typeof input.tool_name === 'string' ? input.tool_name : '';
      if (event === 'PreToolUse' && WRITE_TOOLS.has(tool)) {
        const path = targetPathOf(input);
        if (path) {
          const verdict = await client.request('check', { sessionId, path });
          if (verdict.ok && verdict.allowed === false && typeof verdict.reason === 'string') {
            return buildDenyOutput(event, verdict.reason);
          }
        }
      }

      const inbox = await client.request('inbox', { sessionId });
      if (!inbox.ok) return {};
      const messages = (inbox.messages ?? []) as InjectedMessage[];
      return buildHookOutput(event, formatInjection(messages));
```

- [ ] **Step 4: Run tests and re-measure the hook**

```bash
cd ~/Projects/mesh
node --test 'test/hook.test.ts' && npm run typecheck && npm run build && npm run bench:hook
```

Expected: 19 hook tests pass; the benchmark still reports under 90ms. Enforcement adds one socket round-trip on write tools only, which measured near zero next to Node startup — if the number jumped, that is the finding, so investigate rather than raise the budget.

- [ ] **Step 5: Commit**

```bash
cd ~/Projects/mesh
git add src/hook.ts test/hook.test.ts
git commit -m "$(cat <<'EOF'
Add claim enforcement to the hook

PreToolUse on a write-capable tool checks the target path against the claim
table and returns a deny decision when another agent holds it.

buildDenyOutput always emits permissionDecisionReason and never
systemMessage. Phase 0 measured that a deny without a reason makes Codex
report the hook Failed and run the tool anyway — a silent fail-open. A test
guards it directly.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 5: `mesh claims` and `mesh release`

**Files:**
- Create: `src/cli/claims.ts`
- Modify: `src/cli/index.ts`
- Test: `test/cli.test.ts` (extend)

**Interfaces:**
- Produces:
  - `interface ClaimRow { id: number; holder: string; patterns: string[]; mode: string; expiresInMs: number }`
  - `function renderClaims(rows: ClaimRow[]): string`
  - `mesh claims` and `mesh release [--force] <pattern>` subcommands.

- [ ] **Step 1: Write the failing test**

Append to `test/cli.test.ts`:

```typescript
import { renderClaims } from '../src/cli/claims.ts';

test('renderClaims explains an empty table rather than printing a bare header', () => {
  const out = renderClaims([]);
  assert.match(out, /No claims/i);
});

test('renderClaims lists holder, patterns, mode, and remaining time', () => {
  const out = renderClaims([
    { id: 1, holder: 'codex-1', patterns: ['server/**'], mode: 'exclusive', expiresInMs: 540_000 },
  ]);
  assert.match(out, /codex-1/);
  assert.match(out, /server\/\*\*/);
  assert.match(out, /exclusive/);
  assert.match(out, /9m/, 'remaining time is rendered in human units');
});

test('renderClaims joins multiple patterns on one row', () => {
  const out = renderClaims([
    { id: 1, holder: 'codex-1', patterns: ['server/**', 'db/**'], mode: 'exclusive', expiresInMs: 60_000 },
  ]);
  assert.match(out, /server\/\*\*/);
  assert.match(out, /db\/\*\*/);
});

test('renderClaims flags a claim that is nearly expired', () => {
  const out = renderClaims([
    { id: 1, holder: 'codex-1', patterns: ['server/**'], mode: 'exclusive', expiresInMs: 5_000 },
  ]);
  assert.match(out, /expiring/i);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd ~/Projects/mesh && node --test 'test/cli.test.ts'`
Expected: FAIL — `Cannot find module '../src/cli/claims.ts'`.

- [ ] **Step 3: Write minimal implementation**

Create `src/cli/claims.ts`:

```typescript
import { formatDuration } from './who.ts';

export interface ClaimRow {
  id: number;
  holder: string;
  patterns: string[];
  mode: string;
  expiresInMs: number;
}

const EXPIRING_SOON_MS = 30_000;

export function renderClaims(rows: ClaimRow[]): string {
  if (rows.length === 0) {
    return 'No claims held in this workspace.\nAgents claim paths with mesh_claim before editing.';
  }

  const holderWidth = Math.max(...rows.map((r) => r.holder.length), 6);
  const lines: string[] = ['claims:', ''];
  for (const row of rows) {
    const soon = row.expiresInMs < EXPIRING_SOON_MS ? '  (expiring)' : '';
    lines.push(
      `  ${row.holder.padEnd(holderWidth)}  ${row.mode.padEnd(9)}  ` +
        `${formatDuration(row.expiresInMs).padEnd(5)} left  ${row.patterns.join(', ')}${soon}`,
    );
  }
  return lines.join('\n');
}
```

In `src/cli/index.ts`, add the import:

```typescript
import { renderClaims } from './claims.ts';
import type { ClaimRow } from './claims.ts';
```

Add these two functions above `main`:

```typescript
async function cmdClaims(): Promise<number> {
  const client = await MeshClient.open();
  if (!client) {
    process.stdout.write('mesh: daemon unreachable — no claims visible\n');
    return 0;
  }
  try {
    const res = await client.request('claims', { cwd: process.cwd() });
    if (!res.ok) {
      process.stderr.write(`mesh: ${res.error ?? 'claims failed'}\n`);
      return 1;
    }
    process.stdout.write(`${renderClaims((res.claims ?? []) as ClaimRow[])}\n`);
    return 0;
  } finally {
    client.close();
  }
}

async function cmdRelease(args: string[]): Promise<number> {
  const force = args.includes('--force');
  const patterns = args.filter((a) => !a.startsWith('--'));
  if (patterns.length === 0) {
    process.stderr.write('mesh: release needs a pattern, e.g. mesh release --force "server/**"\n');
    return 1;
  }

  const client = await MeshClient.open();
  if (!client) {
    process.stdout.write('mesh: daemon unreachable — nothing to release\n');
    return 0;
  }
  try {
    const res = await client.request('release', { patterns, force, cwd: process.cwd() });
    if (!res.ok) {
      process.stderr.write(`mesh: ${res.error ?? 'release failed'}\n`);
      return 1;
    }
    process.stdout.write(`Released ${res.released} claim(s).\n`);
    return 0;
  } finally {
    client.close();
  }
}
```

Add these cases to the `switch` in `main`, before `case 'hook':`:

```typescript
    case 'claims':
      return cmdClaims();
    case 'release':
      return cmdRelease(argv.slice(3));
```

Add to `USAGE`, after the `mesh who` line:

```
  mesh claims     Show which agent has claimed which paths
  mesh release [--force] <pattern>
                  Release a claim; --force breaks another agent's
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd ~/Projects/mesh && node --test 'test/cli.test.ts' && npm run typecheck`
Expected: 9 CLI tests pass, typecheck clean.

- [ ] **Step 5: Commit**

```bash
cd ~/Projects/mesh
git add src/cli/ test/cli.test.ts
git commit -m "$(cat <<'EOF'
Add mesh claims and mesh release

Rendering stays a pure function of data so output is asserted directly. A
claim close to expiry is flagged, since a lapsed claim silently stops
protecting anything.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 6: End-to-end blocking, plus the Codex non-shell gap

**Files:**
- Create: `test/e2e-claims.test.ts`
- Create: `spikes/codex-nonshell-enforcement/run.sh`, `spikes/codex-nonshell-enforcement/FINDINGS.md`
- Modify: `docs/superpowers/specs/2026-07-25-mesh-design.md`

**Interfaces:**
- Consumes: everything above. Produces no new API.

The spike answers the open question Phase 0 raised: Codex's `PreToolUse` runs for shell commands only, so what happens when Codex edits a file through `apply_patch` instead? Either enforcement covers it or it does not, and the answer belongs in the spec either way.

- [ ] **Step 1: Write the failing end-to-end test**

Create `test/e2e-claims.test.ts`:

```typescript
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MeshServer, createDaemonState } from '../src/daemon/server.ts';
import { MeshClient } from '../src/client.ts';

async function withDaemon<T>(fn: (socketPath: string, base: string) => Promise<T>): Promise<T> {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'mesh-e2e-claims-')));
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

test('a claimed path is blocked for another agent and allowed for the holder', async () => {
  await withDaemon(async (socketPath, base) => {
    const claude = await MeshClient.open({ socketPath, autostart: false });
    const codex = await MeshClient.open({ socketPath, autostart: false });
    assert.ok(claude && codex);

    await claude.request('register', { sessionId: 'sa', provider: 'claude', cwd: base, role: 'frontend', own: true });
    await codex.request('register', { sessionId: 'sb', provider: 'codex', cwd: base, role: 'backend', own: true });

    const claimed = await codex.request('claim', { patterns: ['server/**'] });
    assert.equal(claimed.ok, true);

    const denied = await claude.request('check', { path: 'server/api/leads.ts' });
    assert.equal(denied.allowed, false);
    assert.match(String(denied.reason), /codex-1/);
    assert.match(String(denied.reason), /mesh release --force/);

    const allowedForHolder = await codex.request('check', { path: 'server/api/leads.ts' });
    assert.equal(allowedForHolder.allowed, true);

    const elsewhere = await claude.request('check', { path: 'app/page.tsx' });
    assert.equal(elsewhere.allowed, true);

    claude.close();
    codex.close();
  });
});

test('the blocked agent can ask the holder and then proceed after release', async () => {
  await withDaemon(async (socketPath, base) => {
    const claude = await MeshClient.open({ socketPath, autostart: false });
    const codex = await MeshClient.open({ socketPath, autostart: false });
    assert.ok(claude && codex);

    await claude.request('register', { sessionId: 'sa', provider: 'claude', cwd: base, own: true });
    await codex.request('register', { sessionId: 'sb', provider: 'codex', cwd: base, own: true });
    await codex.request('touch', { activity: 'Edit server/api/leads.ts' });
    await codex.request('claim', { patterns: ['server/**'] });

    assert.equal((await claude.request('check', { path: 'server/api/leads.ts' })).allowed, false);

    // The denial told claude-1 to ask, so it asks.
    const asking = claude.request('ask', { to: 'codex-1', body: 'can I edit server/api/leads.ts?', timeoutMs: 5000 });
    const inbox = await codex.request('inbox');
    const askId = (inbox.messages as Array<Record<string, unknown>>)[0]?.askId;
    await codex.request('reply', { askId, body: 'yes, releasing it now' });
    assert.equal((await asking).state, 'answered');

    await codex.request('release', { patterns: ['server/**'] });
    assert.equal((await claude.request('check', { path: 'server/api/leads.ts' })).allowed, true);

    claude.close();
    codex.close();
  });
});

test('a departing agent releases its claims', async () => {
  await withDaemon(async (socketPath, base) => {
    const claude = await MeshClient.open({ socketPath, autostart: false });
    const codex = await MeshClient.open({ socketPath, autostart: false });
    assert.ok(claude && codex);

    await claude.request('register', { sessionId: 'sa', provider: 'claude', cwd: base, own: true });
    await codex.request('register', { sessionId: 'sb', provider: 'codex', cwd: base, own: true });
    await codex.request('claim', { patterns: ['server/**'] });
    assert.equal((await claude.request('check', { path: 'server/x.ts' })).allowed, false);

    codex.close();
    await new Promise((resolve) => setTimeout(resolve, 50));

    assert.equal(
      (await claude.request('check', { path: 'server/x.ts' })).allowed,
      true,
      'a dead agent must not hold paths hostage',
    );
    claude.close();
  });
});

test('force release breaks a claim held by an unresponsive agent', async () => {
  await withDaemon(async (socketPath, base) => {
    const claude = await MeshClient.open({ socketPath, autostart: false });
    const codex = await MeshClient.open({ socketPath, autostart: false });
    assert.ok(claude && codex);

    await claude.request('register', { sessionId: 'sa', provider: 'claude', cwd: base, own: true });
    await codex.request('register', { sessionId: 'sb', provider: 'codex', cwd: base, own: true });
    await codex.request('claim', { patterns: ['server/**'] });

    const forced = await claude.request('release', { patterns: ['server/**'], force: true, cwd: base });
    assert.equal(forced.released, 1);
    assert.equal((await claude.request('check', { path: 'server/x.ts' })).allowed, true);

    claude.close();
    codex.close();
  });
});
```

- [ ] **Step 2: Run the end-to-end test**

Run: `cd ~/Projects/mesh && node --test 'test/e2e-claims.test.ts'`

This composes Tasks 1–5 and adds no implementation, so it should **pass on first run**. A failure is a real integration bug between modules that each passed their own unit tests — read the assertion before changing anything.

- [ ] **Step 3: Write the Codex non-shell enforcement spike**

Create `spikes/codex-nonshell-enforcement/run.sh`:

```bash
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
echo "target.txt seeded so an edit has something to change"
echo "original" > "$WORK/target.txt"

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
grep -iE "apply_patch|exec |/bin/zsh|shell" "$WORK/out.txt" | head -5
echo "--- was the deny honored? ---"
if grep -q "^original$" "$WORK/target.txt"; then
  echo "RESULT: file UNCHANGED -> the deny was enforced on this edit path"
else
  echo "RESULT: file MODIFIED  -> this edit path BYPASSES PreToolUse enforcement"
fi
echo "workdir retained: $WORK"
```

- [ ] **Step 4: Run the spike and record the finding**

```bash
cd ~/Projects/mesh
chmod +x spikes/codex-nonshell-enforcement/run.sh
./spikes/codex-nonshell-enforcement/run.sh
```

Create `spikes/codex-nonshell-enforcement/FINDINGS.md` recording, from observed output: whether `PreToolUse` fired at all, which mechanism Codex used to edit the file, and whether the deny was honored. Record a negative result plainly if that is what happened — a documented gap is useful; a claim of coverage mesh does not have is not.

```markdown
# Codex non-shell edit enforcement — Phase 3 findings

**Date:** <YYYY-MM-DD>
**Codex version:** <output of `codex --version`>

## Question
Phase 0 established that Codex `PreToolUse` "currently runs for shell commands
only". Does a Codex file edit that does not go through a shell fire the hook,
and is a deny honored?

## Observed
- Hook fired: <yes/no>, <n> time(s)
- Edit mechanism Codex chose: <apply_patch | shell | other>
- File after the run: <unchanged | modified>

## Conclusion
<one of:>
- Enforcement covers this path — the deny was honored.
- **GAP: this edit path bypasses enforcement.** Codex edits via <mechanism>,
  which does not fire `PreToolUse`, so mesh cannot block it.

## Consequence for mesh
<if a gap:> Claim enforcement on Codex is partial — it covers shell-mediated
writes but not <mechanism>. This must be stated plainly in the README and in
`mesh doctor` rather than implied to be complete. Claude-side enforcement is
unaffected.
```

- [ ] **Step 5: Update the spec with the answer**

In `docs/superpowers/specs/2026-07-25-mesh-design.md`, replace the open-risk row:

```markdown
| Codex `PreToolUse` fires for shell commands only | Non-shell edit paths (`apply_patch`) may bypass enforcement. Phase 3 must measure the gap and document it rather than overclaim coverage. |
```

with a row stating the measured answer, and update the Goals section's claim-enforcement bullet to match what was actually observed. If a gap exists, say so in the goal itself — the spec must not promise enforcement mesh cannot deliver.

- [ ] **Step 6: Full verification**

```bash
cd ~/Projects/mesh
npm test && npm run typecheck && npm run build && npm run bench:hook
pgrep -fl "daemon/main.ts" || echo "no stray daemons"
diff ~/.codex/hooks.json ~/.codex/hooks.json.phase3-backup && echo "codex config restored"
```

Expected: all suites pass, benchmark under 90ms, no strays, and the user's Codex config byte-identical to its backup.

- [ ] **Step 7: Commit**

```bash
cd ~/Projects/mesh
git add test/e2e-claims.test.ts spikes/ docs/
git commit -m "$(cat <<'EOF'
Add end-to-end claim tests and measure the Codex non-shell gap

Proves the full collision-prevention loop over a real socket: claim, block a
peer, ask the holder, release, proceed. Also covers a departing agent's claims
being freed and force-release breaking a stuck one.

The spike answers the question Phase 0 left open — whether a Codex edit that
does not go through a shell fires PreToolUse — and the spec now records the
measured answer instead of an assumption.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

---

## Plan Self-Review

**Spec coverage for Phase 3.** Claim table with shared/exclusive modes → Task 2. Glob granularity and conservative intersection → Task 1. TTL plus heartbeat refresh → Tasks 2 and 3 (`touch` refreshes). Liveness via owning connection → Task 3 Step 4 (disconnect releases claims). Idle auto-downgrade → Task 3's `check`. `PreToolUse` deny → Task 4. Force-release escape hatch named in every denial → Task 3's `denialReason`, asserted in Task 1 of the enforcement tests. `mesh claims` / `mesh release --force` → Task 5. The Phase 0 open question about non-shell edits → Task 6.

**Deliberately not built:** `mesh_claim`/`mesh_release`/`mesh_feed` MCP tools. The daemon ops land here; exposing them as agent-callable tools belongs with the rest of the tool surface, and `mesh_feed` needs the activity ring buffer that no phase has built yet. Tasks and `mesh board` remain Phase 4; `mesh init` and `mesh watch` remain Phase 5.

**Placeholder scan:** clean. Every step contains runnable code or an exact command. The two `FINDINGS.md` templates have angle-bracket fields, which are data to be filled from observed output rather than unfinished plan content.

**Type consistency.** `DaemonState` gains `claims: ClaimTable` in Task 3, and Task 3 Step 5 lists every existing test literal that must be updated. `CheckResult.holder`/`pattern` are `string | undefined` in Task 2 and narrowed with `as string` at the two call sites in Task 3 where a deny guarantees they are set. `ClaimRow` in Task 5 matches exactly the shape the `claims` op returns in Task 3 (`id`, `holder`, `patterns`, `mode`, `expiresInMs`). `formatDuration` is imported from `src/cli/who.ts`, where Plan 1 defined it. `buildDenyOutput` returns the same envelope shape as `buildHookOutput` but with `permissionDecision` and `permissionDecisionReason` instead of `additionalContext`.
