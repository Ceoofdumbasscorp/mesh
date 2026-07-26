import { createServer, connect } from 'node:net';
import type { Server, Socket } from 'node:net';
import { chmodSync, existsSync, unlinkSync } from 'node:fs';
import { systemClock } from '../clock.ts';
import type { Clock } from '../clock.ts';
import { Journal } from '../journal.ts';
import { Registry } from '../registry.ts';
import { createFrameDecoder, encodeFrame } from '../protocol.ts';
import { handleRequest } from './handlers.ts';
import type { ConnectionContext, DaemonState } from './handlers.ts';

export interface ServerOptions {
  socketPath: string;
  state: DaemonState;
  /** Exit after this long with no connections. Zero disables. */
  idleShutdownMs?: number;
  onShutdown?: () => void;
}

const DEFAULT_IDLE_SHUTDOWN_MS = 30 * 60_000;

export function createDaemonState(options: {
  journalPath: string;
  clock?: Clock;
  idleAfterMs?: number;
}): DaemonState {
  const clock = options.clock ?? systemClock;
  return {
    clock,
    registry: new Registry({ clock, idleAfterMs: options.idleAfterMs }),
    journal: new Journal(options.journalPath, clock),
  };
}

/**
 * Determines whether a socket file has a live listener behind it. A daemon
 * killed with SIGKILL leaves the file in place, and binding would fail with
 * EADDRINUSE forever if we did not clear it.
 */
async function isSocketLive(socketPath: string): Promise<boolean> {
  if (!existsSync(socketPath)) return false;
  return await new Promise<boolean>((resolve) => {
    const probe = connect(socketPath);
    const settle = (live: boolean) => {
      probe.removeAllListeners();
      probe.destroy();
      resolve(live);
    };
    probe.once('connect', () => settle(true));
    probe.once('error', () => settle(false));
  });
}

export class MeshServer {
  #options: ServerOptions;
  #server: Server | null = null;
  #connections = new Set<Socket>();
  #idleTimer: NodeJS.Timeout | null = null;

  constructor(options: ServerOptions) {
    this.#options = options;
  }

  get connectionCount(): number {
    return this.#connections.size;
  }

  async start(): Promise<void> {
    const { socketPath } = this.#options;

    if (existsSync(socketPath) && !(await isSocketLive(socketPath))) {
      unlinkSync(socketPath);
    }

    const server = createServer((socket) => this.#onConnection(socket));
    this.#server = server;

    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(socketPath, () => {
        server.removeListener('error', reject);
        resolve();
      });
    });

    // Owner-only: mesh state describes what an agent is doing.
    chmodSync(socketPath, 0o600);
    this.#armIdleTimer();
  }

  #onConnection(socket: Socket): void {
    this.#connections.add(socket);
    this.#clearIdleTimer();

    const ctx: ConnectionContext = {
      sessionId: null,
      requestShutdown: () => {
        void this.close().then(() => this.#options.onShutdown?.());
      },
    };
    const decode = createFrameDecoder();

    socket.on('data', (chunk) => {
      let frames: unknown[];
      try {
        frames = decode(chunk);
      } catch {
        // Protocol violation is that client's problem alone.
        socket.destroy();
        return;
      }
      for (const frame of frames) {
        const response = handleRequest(this.#options.state, ctx, frame);
        socket.write(encodeFrame(response));
      }
    });

    const cleanup = () => {
      if (!this.#connections.delete(socket)) return;
      // A dropped connection is how we learn an agent is gone. This is the
      // liveness signal the rest of the design depends on.
      if (ctx.sessionId) {
        const removed = this.#options.state.registry.unregister(ctx.sessionId);
        if (removed) {
          this.#options.state.journal.append('disconnect', {
            name: removed.name,
            sessionId: ctx.sessionId,
          });
        }
        ctx.sessionId = null;
      }
      if (this.#connections.size === 0) this.#armIdleTimer();
    };

    socket.on('close', cleanup);
    socket.on('error', cleanup);
  }

  #armIdleTimer(): void {
    const idleShutdownMs = this.#options.idleShutdownMs ?? DEFAULT_IDLE_SHUTDOWN_MS;
    if (idleShutdownMs <= 0) return;
    this.#clearIdleTimer();
    this.#idleTimer = setTimeout(() => {
      void this.close().then(() => this.#options.onShutdown?.());
    }, idleShutdownMs);
    // Never hold the process open purely to wait for its own shutdown.
    this.#idleTimer.unref?.();
  }

  #clearIdleTimer(): void {
    if (this.#idleTimer) clearTimeout(this.#idleTimer);
    this.#idleTimer = null;
  }

  async close(): Promise<void> {
    this.#clearIdleTimer();
    for (const socket of this.#connections) socket.destroy();
    this.#connections.clear();

    const server = this.#server;
    this.#server = null;
    if (server) {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }

    this.#options.state.journal.close();
    if (existsSync(this.#options.socketPath)) {
      try {
        unlinkSync(this.#options.socketPath);
      } catch {
        // Already gone. Nothing to do.
      }
    }
  }
}
