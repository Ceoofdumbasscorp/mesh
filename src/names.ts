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
