import { appendFileSync, readFileSync } from 'node:fs';
import type { Clock } from './clock.ts';

export interface JournalEntry {
  at: number;
  kind: string;
  [key: string]: unknown;
}

/**
 * Append-only record of everything the daemon did. Primarily a debugging and
 * forensics asset (`mesh log`); crash recovery is secondary, since live state
 * is small and cheap to rebuild.
 */
export class Journal {
  #file: string;
  #clock: Clock;
  #closed = false;

  constructor(file: string, clock: Clock) {
    this.#file = file;
    this.#clock = clock;
  }

  append(kind: string, data: Record<string, unknown>): void {
    if (this.#closed) return;
    const entry: JournalEntry = { at: this.#clock(), kind, ...data };
    // appendFileSync is atomic for writes this small, so a crash cannot
    // interleave two entries into one corrupt line.
    appendFileSync(this.#file, `${JSON.stringify(entry)}\n`, 'utf8');
  }

  read(): JournalEntry[] {
    let raw: string;
    try {
      raw = readFileSync(this.#file, 'utf8');
    } catch {
      return [];
    }

    const entries: JournalEntry[] = [];
    for (const line of raw.split('\n')) {
      const trimmed = line.trim();
      if (trimmed.length === 0) continue;
      try {
        entries.push(JSON.parse(trimmed) as JournalEntry);
      } catch {
        // A torn final line means we crashed mid-append. Everything before it
        // is still good, so drop the fragment rather than failing the read.
        continue;
      }
    }
    return entries;
  }

  close(): void {
    this.#closed = true;
  }
}
