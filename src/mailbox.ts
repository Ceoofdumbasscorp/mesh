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
