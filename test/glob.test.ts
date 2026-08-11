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
  assert.equal(matchGlob('src/**', 'src'), true, 'a recursive claim protects its directory');
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
