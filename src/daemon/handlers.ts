import type { Clock } from '../clock.ts';
import type { Journal } from '../journal.ts';
import type { Registry } from '../registry.ts';
import type { Response } from '../protocol.ts';
import { resolveWorkspace } from '../workspace.ts';
import type { Mailbox } from '../mailbox.ts';
import type { AskRegistry } from '../asks.ts';
import type { Waiters } from './waiters.ts';

export interface DaemonState {
  registry: Registry;
  journal: Journal;
  clock: Clock;
  mailbox: Mailbox;
  asks: AskRegistry;
  waiters: Waiters;
}

/**
 * Per-connection, mutable. The socket layer uses this to know which agent to
 * unregister when the connection drops — that drop is our liveness signal.
 */
export interface ConnectionContext {
  sessionId: string | null;
  /**
   * Whether this connection OWNS its agent's lifetime.
   *
   * Only an owning connection closing means the agent is gone. The MCP server
   * holds one long-lived owning connection per session; the hook opens a
   * transient connection on every tool call, and those must not evict the
   * agent when they close.
   */
  owns: boolean;
  /** Set by the server so a client can ask the daemon to stop. */
  requestShutdown?: () => void;
}

function fail(id: number, error: string): Response {
  return { id, ok: false, error };
}

function readString(source: Record<string, unknown>, key: string): string | undefined {
  const value = source[key];
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;
}

/**
 * The agent behind this connection. Messaging ops need a sender identity, and
 * an unregistered connection has none.
 */
function callerOf(
  state: DaemonState,
  ctx: ConnectionContext,
  req: Record<string, unknown>,
): { name: string; workspaceRoot: string } | null {
  const sessionId = readString(req, 'sessionId') ?? ctx.sessionId;
  if (!sessionId) return null;
  const agent = state.registry.get(sessionId);
  if (!agent) return null;
  return { name: agent.name, workspaceRoot: agent.workspaceRoot };
}

/** Resolves a target string to agent names: a name, a role, or "*". */
function resolveTargets(
  state: DaemonState,
  workspaceRoot: string,
  senderName: string,
  target: string,
): string[] {
  const peers = state.registry.list(workspaceRoot).filter((a) => a.name !== senderName);
  if (target === '*') return peers.map((a) => a.name);
  const byName = peers.filter((a) => a.name === target);
  if (byName.length > 0) return byName.map((a) => a.name);
  return peers.filter((a) => a.role === target).map((a) => a.name);
}

export async function handleRequest(
  state: DaemonState,
  ctx: ConnectionContext,
  request: unknown,
): Promise<Response> {
  if (typeof request !== 'object' || request === null || Array.isArray(request)) {
    return fail(0, 'Request must be a JSON object');
  }

  const req = request as Record<string, unknown>;
  const id = typeof req.id === 'number' ? req.id : 0;
  const op = readString(req, 'op');
  if (!op) return fail(id, 'Request is missing "op"');

  switch (op) {
    case 'ping':
      return { id, ok: true, at: state.clock() };

    case 'register': {
      const sessionId = readString(req, 'sessionId');
      if (!sessionId) return fail(id, 'register requires "sessionId"');
      const provider = readString(req, 'provider');
      if (!provider) return fail(id, 'register requires "provider"');

      const workspace = resolveWorkspace(readString(req, 'cwd') ?? process.cwd());
      const agent = state.registry.register({
        sessionId,
        provider,
        workspace,
        role: readString(req, 'role'),
        pid: typeof req.pid === 'number' ? req.pid : undefined,
      });

      ctx.sessionId = sessionId;
      // Ownership is opt-in and sticky: a connection that ever claimed
      // ownership keeps it, so a later non-owning register on the same
      // connection cannot silently downgrade it.
      if (req.own === true) ctx.owns = true;
      state.journal.append('register', {
        name: agent.name,
        sessionId,
        provider,
        workspace: workspace.root,
      });

      return {
        id,
        ok: true,
        name: agent.name,
        workspace: workspace.root,
        workspaceLabel: workspace.label,
      };
    }

    case 'unregister': {
      const sessionId = readString(req, 'sessionId') ?? ctx.sessionId;
      if (!sessionId) return fail(id, 'unregister requires "sessionId"');

      const removed = state.registry.unregister(sessionId);
      if (ctx.sessionId === sessionId) ctx.sessionId = null;
      if (removed) {
        state.journal.append('unregister', { name: removed.name, sessionId });
      }
      return { id, ok: true, removed: removed !== null };
    }

    case 'touch': {
      const sessionId = readString(req, 'sessionId') ?? ctx.sessionId;
      if (!sessionId) return fail(id, 'touch requires "sessionId"');
      const known = state.registry.touch(sessionId, readString(req, 'activity'));
      return { id, ok: true, known };
    }

    case 'who': {
      const workspace = resolveWorkspace(readString(req, 'cwd') ?? process.cwd());
      const agents = state.registry.list(workspace.root).map((agent) => ({
        name: agent.name,
        provider: agent.provider,
        role: agent.role,
        status: agent.status,
        activity: agent.activity,
        idleMs: agent.idleMs,
        pid: agent.pid,
      }));
      return {
        id,
        ok: true,
        workspace: workspace.root,
        workspaceLabel: workspace.label,
        agents,
      };
    }

    case 'send': {
      const caller = callerOf(state, ctx, req);
      if (!caller) return fail(id, 'send requires a registered agent (call register first)');
      const target = readString(req, 'to');
      if (!target) return fail(id, 'send requires "to"');

      const names = resolveTargets(state, caller.workspaceRoot, caller.name, target);
      if (names.length === 0) return fail(id, `No agent matching "${target}" in this workspace`);

      try {
        for (const name of names) {
          state.mailbox.deliver({
            kind: 'message',
            from: caller.name,
            to: name,
            body: req.body as string,
          });
        }
      } catch (error) {
        return fail(id, (error as Error).message);
      }

      state.journal.append('send', { from: caller.name, to: names, count: names.length });
      return { id, ok: true, delivered: names.length, to: names };
    }

    case 'inbox': {
      const caller = callerOf(state, ctx, req);
      if (!caller) return fail(id, 'inbox requires a registered agent (call register first)');
      const drain = req.drain !== false;
      const envelopes = drain ? state.mailbox.drain(caller.name) : state.mailbox.peek(caller.name);
      return {
        id,
        ok: true,
        messages: envelopes.map((e) => ({
          id: e.id,
          kind: e.kind,
          from: e.from,
          body: e.body,
          at: e.at,
          askId: e.askId,
        })),
      };
    }

    case 'shutdown': {
      state.journal.append('shutdown', {});
      // Answer before stopping, so the caller is not left waiting on a socket
      // that is about to disappear.
      queueMicrotask(() => ctx.requestShutdown?.());
      return { id, ok: true };
    }

    default:
      return fail(id, `Unknown op: ${op}`);
  }
}
