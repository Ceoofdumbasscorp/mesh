import type { Clock } from '../clock.ts';
import type { Journal } from '../journal.ts';
import type { Registry } from '../registry.ts';
import type { Response } from '../protocol.ts';
import { resolveWorkspace } from '../workspace.ts';

export interface DaemonState {
  registry: Registry;
  journal: Journal;
  clock: Clock;
}

/**
 * Per-connection, mutable. The socket layer uses this to know which agent to
 * unregister when the connection drops — that drop is our liveness signal.
 */
export interface ConnectionContext {
  sessionId: string | null;
}

function fail(id: number, error: string): Response {
  return { id, ok: false, error };
}

function readString(source: Record<string, unknown>, key: string): string | undefined {
  const value = source[key];
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;
}

export function handleRequest(
  state: DaemonState,
  ctx: ConnectionContext,
  request: unknown,
): Response {
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

    default:
      return fail(id, `Unknown op: ${op}`);
  }
}
