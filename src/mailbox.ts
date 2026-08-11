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
  #totalMessages = 0;
  #maxMessagesPerRecipient: number;
  #maxMessagesTotal: number;

  constructor(options: {
    clock: Clock;
    maxMessagesPerRecipient?: number;
    maxMessagesTotal?: number;
  }) {
    this.#clock = options.clock;
    this.#maxMessagesPerRecipient = options.maxMessagesPerRecipient ?? 128;
    this.#maxMessagesTotal = options.maxMessagesTotal ?? 2048;
  }

  deliver(input: DeliverInput): Envelope {
    // Validate before mutating: a rejected message must leave no trace.
    const body = validateBody(input.body);
    const queue = this.#queues.get(input.to);
    if ((queue?.length ?? 0) >= this.#maxMessagesPerRecipient) {
      throw new RangeError(`Mailbox quota exceeded for ${input.to}`);
    }
    if (this.#totalMessages >= this.#maxMessagesTotal) {
      throw new RangeError('Global mailbox quota exceeded');
    }
    const envelope: Envelope = {
      id: this.#nextId++,
      kind: input.kind,
      from: input.from,
      to: input.to,
      body,
      at: this.#clock(),
      askId: input.askId ?? null,
    };
    if (queue) queue.push(envelope);
    else this.#queues.set(input.to, [envelope]);
    this.#totalMessages += 1;
    return envelope;
  }

  peek(agent: string): Envelope[] {
    return [...(this.#queues.get(agent) ?? [])];
  }

  drain(agent: string): Envelope[] {
    const queue = this.#queues.get(agent);
    if (!queue || queue.length === 0) return [];
    this.#queues.delete(agent);
    this.#totalMessages -= queue.length;
    return queue;
  }

  pendingCount(agent: string): number {
    return this.#queues.get(agent)?.length ?? 0;
  }

  clear(agent: string): void {
    const queue = this.#queues.get(agent);
    if (queue) this.#totalMessages -= queue.length;
    this.#queues.delete(agent);
  }
}
