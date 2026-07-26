/** Message and task bodies. Matches constellation.js MAX_BODY. */
export const MAX_BODY_BYTES = 4096;

/**
 * Whole-frame ceiling. Generous next to the body cap so metadata and a
 * maximum-size body fit, while still bounding what one malformed client can
 * make the daemon buffer.
 */
export const MAX_FRAME_BYTES = 64 * 1024;

export interface Request {
  id: number;
  op: string;
  [key: string]: unknown;
}

export interface Response {
  id: number;
  ok: boolean;
  error?: string;
  [key: string]: unknown;
}

export function encodeFrame(value: unknown): string {
  return `${JSON.stringify(value)}\n`;
}

export type FrameDecoder = (chunk: string | Buffer) => unknown[];

/**
 * Stateful line decoder. A socket splits writes wherever it likes, so frames
 * arrive fragmented or batched. Once a decoder rejects input it stays closed:
 * resuming mid-frame after a parse error would silently reinterpret the
 * remaining bytes.
 */
export function createFrameDecoder(): FrameDecoder {
  let buffer = '';
  let closed = false;

  return function decode(chunk: string | Buffer): unknown[] {
    if (closed) throw new Error('Frame decoder is closed after a protocol error');

    buffer += typeof chunk === 'string' ? chunk : chunk.toString('utf8');

    if (buffer.length > MAX_FRAME_BYTES) {
      closed = true;
      buffer = '';
      throw new Error(`Frame exceeds ${MAX_FRAME_BYTES} bytes`);
    }

    const parts = buffer.split('\n');
    buffer = parts.pop() ?? '';

    const frames: unknown[] = [];
    for (const part of parts) {
      const line = part.trim();
      if (line.length === 0) continue;
      try {
        frames.push(JSON.parse(line));
      } catch {
        closed = true;
        buffer = '';
        throw new Error('Malformed frame: invalid JSON');
      }
    }
    return frames;
  };
}
