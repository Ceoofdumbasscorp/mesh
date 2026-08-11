import { appendFileSync, chmodSync, readFileSync, renameSync, statSync } from 'node:fs';
import type { Clock } from './clock.ts';

/**
 * Rotate past this. The daemon runs for weeks across every project on the
 * machine, and an append-only file with no ceiling eventually fills the disk
 * and makes `mesh log` read hundreds of megabytes into memory. One previous
 * generation is kept, which is all a debugging asset needs.
 */
export const MAX_JOURNAL_BYTES = 5 * 1024 * 1024;

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
  #maxBytes: number;
  /** Tracked in memory; -1 until the first append reads it from disk once. */
  #size = -1;

  constructor(file: string, clock: Clock, maxBytes: number = MAX_JOURNAL_BYTES) {
    this.#file = file;
    this.#clock = clock;
    this.#maxBytes = maxBytes;
  }

  /** Renames the current file aside, keeping exactly one previous generation. */
  #rotate(): void {
    try {
      renameSync(this.#file, `${this.#file}.1`);
    } catch {
      // Nothing to rotate, or the directory is gone. Either way, keep writing.
    }
    this.#size = 0;
  }

  append(kind: string, data: Record<string, unknown>): void {
    if (this.#closed) return;
    const entry: JournalEntry = { at: this.#clock(), kind, ...data };
    const line = `${JSON.stringify(entry)}\n`;

    if (this.#size < 0) {
      try {
        this.#size = statSync(this.#file).size;
        chmodSync(this.#file, 0o600);
      } catch {
        this.#size = 0;
      }
    }
    if (this.#size + line.length > this.#maxBytes) this.#rotate();

    // appendFileSync is atomic for writes this small, so a crash cannot
    // interleave two entries into one corrupt line.
    appendFileSync(this.#file, line, { encoding: 'utf8', mode: 0o600, flag: 'a' });
    chmodSync(this.#file, 0o600);
    this.#size += Buffer.byteLength(line);
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
