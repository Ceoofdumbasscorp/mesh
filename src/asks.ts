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
