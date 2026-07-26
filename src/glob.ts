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
