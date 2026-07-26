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
