/**
 * Every time-dependent module takes a Clock rather than calling Date.now().
 * That is what lets liveness, TTL, and timeout logic be tested with plain
 * assertions instead of sleeps.
 */
export type Clock = () => number;

export const systemClock: Clock = () => Date.now();

export interface TestClock {
  now: Clock;
  advance(ms: number): void;
  set(ms: number): void;
}

export function testClock(start = 0): TestClock {
  let current = start;
  return {
    now: () => current,
    advance(ms: number) {
      current += ms;
    },
    set(ms: number) {
      current = ms;
    },
  };
}
