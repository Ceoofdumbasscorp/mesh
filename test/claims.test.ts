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

test('claim storage has a global ceiling and prunes expired entries', () => {
  const clock = testClock(1000);
  const claims = new ClaimTable({ clock: clock.now, defaultTtlMs: 1000, maxClaims: 1 });
  claims.claim({ holder: 'a', workspaceRoot: WS, patterns: ['a/**'], mode: 'shared' });
  assert.throws(
    () => claims.claim({ holder: 'b', workspaceRoot: WS, patterns: ['b/**'], mode: 'shared' }),
    /quota/i,
  );
  clock.advance(1001);
  assert.doesNotThrow(() =>
    claims.claim({ holder: 'b', workspaceRoot: WS, patterns: ['b/**'], mode: 'shared' }),
  );
});
