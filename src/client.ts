import { connect } from 'node:net';
import type { Socket } from 'node:net';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { meshPaths, ensureMeshHome } from './paths.ts';
import { createFrameDecoder, encodeFrame } from './protocol.ts';
import type { Response } from './protocol.ts';

export interface ClientOptions {
  socketPath?: string;
  journalPath?: string;
  connectTimeoutMs?: number;
  /** Spawn a daemon if none is listening. Default true. */
  autostart?: boolean;
}

const DEFAULT_CONNECT_TIMEOUT_MS = 1000;
const AUTOSTART_POLL_MS = 50;

function tryConnect(socketPath: string, timeoutMs: number): Promise<Socket | null> {
  return new Promise((resolve) => {
    const socket = connect(socketPath);

    const settle = (result: Socket | null) => {
      clearTimeout(timer);
      socket.removeAllListeners('connect');
      socket.removeAllListeners('error');
      if (result === null) socket.destroy();
      resolve(result);
    };

    const timer = setTimeout(() => settle(null), timeoutMs);
    socket.once('connect', () => settle(socket));
    socket.once('error', () => settle(null));
  });
}

/**
 * The daemon module to spawn, matching how THIS module is running.
 *
 * Hardcoding `main.ts` shipped a package that could not start its own daemon:
 * from dist/ it resolved to dist/daemon/main.ts, which does not exist. The
 * spawn is detached with stdio ignored, so nothing surfaced except a later
 * "could not reach or start the daemon" — and every test ran from src/, where
 * the .ts file does exist, so the suite stayed green.
 */
export function daemonEntryPoint(moduleUrl: string = import.meta.url): string {
  const here = fileURLToPath(moduleUrl);
  const extension = here.endsWith('.ts') ? 'ts' : 'js';
  return join(dirname(here), 'daemon', `main.${extension}`);
}

/**
 * Talks to meshd. Every failure to reach the daemon surfaces as null rather
 * than an exception — that is the fail-open contract, expressed in the type.
 */
export class MeshClient {
  #socket: Socket;
  #decode = createFrameDecoder();
  #pending = new Map<number, (response: Response) => void>();
  #nextId = 1;
  #closed = false;

  private constructor(socket: Socket) {
    this.#socket = socket;

    socket.on('data', (chunk) => {
      let frames: unknown[];
      try {
        frames = this.#decode(chunk);
      } catch {
        this.#failAll('mesh client: protocol error');
        return;
      }
      for (const frame of frames) {
        const response = frame as Response;
        const resolve = this.#pending.get(response.id);
        if (resolve) {
          this.#pending.delete(response.id);
          resolve(response);
        }
      }
    });

    socket.on('close', () => this.#failAll('mesh client: connection closed'));
    socket.on('error', () => this.#failAll('mesh client: connection error'));
  }

  #failAll(reason: string): void {
    this.#closed = true;
    for (const [id, resolve] of this.#pending) {
      resolve({ id, ok: false, error: reason });
    }
    this.#pending.clear();
  }

  static async open(options: ClientOptions = {}): Promise<MeshClient | null> {
    const defaults = meshPaths();
    const socketPath = options.socketPath ?? defaults.socket;
    const timeoutMs = options.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS;

    const direct = await tryConnect(socketPath, timeoutMs);
    if (direct) return new MeshClient(direct);

    if (options.autostart === false) return null;

    // The socket's own directory is the home to create — an explicit
    // socketPath may point somewhere other than ~/.mesh.
    ensureMeshHome(meshPaths(dirname(socketPath)));

    const child = spawn(
      process.execPath,
      [
        daemonEntryPoint(),
        '--socket',
        socketPath,
        '--journal',
        options.journalPath ?? defaults.journal,
      ],
      { detached: true, stdio: 'ignore' },
    );
    child.unref();

    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, AUTOSTART_POLL_MS));
      const socket = await tryConnect(socketPath, AUTOSTART_POLL_MS * 2);
      if (socket) return new MeshClient(socket);
    }
    return null;
  }

  request(op: string, params: Record<string, unknown> = {}): Promise<Response> {
    if (this.#closed) {
      return Promise.reject(new Error('mesh client is closed'));
    }
    const id = this.#nextId++;
    return new Promise<Response>((resolve) => {
      this.#pending.set(id, resolve);
      this.#socket.write(encodeFrame({ id, op, ...params }));
    });
  }

  close(): void {
    this.#closed = true;
    this.#pending.clear();
    this.#socket.end();
    this.#socket.destroy();
  }
}
