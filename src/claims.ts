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
