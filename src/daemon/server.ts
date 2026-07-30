import { createServer, connect } from 'node:net';
import type { Server, Socket } from 'node:net';
import { chmodSync, existsSync, unlinkSync } from 'node:fs';
import { systemClock } from '../clock.ts';
import type { Clock } from '../clock.ts';
import { Journal } from '../journal.ts';
import { Registry } from '../registry.ts';
import { Mailbox } from '../mailbox.ts';
import { AskRegistry } from '../asks.ts';
import { ClaimTable } from '../claims.ts';
import { Waiters } from './waiters.ts';
import { processIsAlive } from './liveness.ts';
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
  isAlive?: (pid: number) => boolean;
}): DaemonState {
  const clock = options.clock ?? systemClock;
  return {
    clock,
    isAlive: options.isAlive ?? processIsAlive,
    registry: new Registry({ clock, idleAfterMs: options.idleAfterMs }),
    journal: new Journal(options.journalPath, clock),
    mailbox: new Mailbox({ clock }),
    asks: new AskRegistry({ clock }),
    claims: new ClaimTable({ clock }),
    waiters: new Waiters(),
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

    // Shutdown is deferred until the reply has flushed. Closing straight away
    // destroyed the socket with the response still buffered, so `mesh stop`
    // reported "connection closed" instead of success even though the daemon
    // had stopped correctly.
    let shutdownRequested = false;
    const ctx: ConnectionContext = {
      sessionId: null,
      owns: false,
      requestShutdown: () => {
        shutdownRequested = true;
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
        // Each frame is handled independently and concurrently. A blocking ask
        // must never stall another connection — or another op on this one.
        void (async () => {
          let response;
          try {
            response = await handleRequest(this.#options.state, ctx, frame);
          } catch (error) {
            response = { id: 0, ok: false, error: `daemon error: ${(error as Error).message}` };
          }
          if (!socket.destroyed) {
            socket.write(encodeFrame(response), () => {
              if (shutdownRequested) {
                void this.close().then(() => this.#options.onShutdown?.());
              }
            });
          }
        })();
      }
    });

    const cleanup = () => {
      if (!this.#connections.delete(socket)) return;
      // A dropped OWNING connection is how we learn an agent is gone. The
      // hook connects and disconnects on every tool call, so treating any
      // close as death would evict the agent constantly.
      if (ctx.sessionId && ctx.owns) {
        const removed = this.#options.state.registry.unregister(ctx.sessionId);
        if (removed) {
          // A dead agent must not hold paths hostage.
          const releasedClaims = this.#options.state.claims.release(removed.name);
          this.#options.state.journal.append('disconnect', {
            name: removed.name,
            sessionId: ctx.sessionId,
            releasedClaims,
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

    // Disarm any parked asks so a shutdown does not leave timers running.
    this.#options.state.waiters.clear();
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
