import type { Clock } from '../clock.ts';
import type { Journal } from '../journal.ts';
import type { Registry } from '../registry.ts';
import type { Response } from '../protocol.ts';
import { resolveWorkspace } from '../workspace.ts';
import type { Mailbox } from '../mailbox.ts';
import type { AskRegistry } from '../asks.ts';
import type { ClaimTable } from '../claims.ts';
import type { Waiters } from './waiters.ts';

export interface DaemonState {
  registry: Registry;
  journal: Journal;
  clock: Clock;
  mailbox: Mailbox;
  asks: AskRegistry;
  claims: ClaimTable;
  waiters: Waiters;
}

/** Silence beyond this downgrades a holder's claim from deny to warning. */
const HOLDER_IDLE_THRESHOLD_MS = 15 * 60_000;

/**
 * The text an agent sees when its edit is blocked. Composed on the daemon so
 * every client shows the same wording, and written to be acted on rather than
 * merely to explain: it names the holder, how to unblock, and the escape hatch.
 */
export function denialReason(input: {
  path: string;
  holder: string;
  pattern: string;
  holderIdleMs: number;
}): string {
  const idleSeconds = Math.round(input.holderIdleMs / 1000);
  return (
    `BLOCKED by mesh: ${input.path} is claimed exclusively by ${input.holder} ` +
    `(matched "${input.pattern}", active ${idleSeconds}s ago). Do not edit it. ` +
    `Either mesh_ask ${input.holder} to make the change, or run ` +
    `\`mesh release --force "${input.pattern}"\` if ${input.holder} has been abandoned.`
  );
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
      // Activity is what keeps a claim alive: an agent still working never
      // loses its claims, while a stalled one lets them lapse.
      const toucher = state.registry.get(sessionId);
      if (toucher) state.claims.refresh(toucher.name);
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

    case 'ask': {
      const caller = callerOf(state, ctx, req);
      if (!caller) return fail(id, 'ask requires a registered agent (call register first)');
      const target = readString(req, 'to');
      if (!target) return fail(id, 'ask requires "to"');

      const names = resolveTargets(state, caller.workspaceRoot, caller.name, target);
      const targetName = names[0];
      if (names.length === 0 || targetName === undefined) {
        return {
          id,
          ok: true,
          state: 'undeliverable',
          note: `No agent matching "${target}" is on this workspace right now.`,
        };
      }
      if (names.length > 1) {
        return fail(id, `"${target}" matches ${names.length} agents; ask one by name`);
      }

      const timeoutMs = typeof req.timeoutMs === 'number' ? req.timeoutMs : 90_000;
      const created = state.asks.create({
        from: caller.name,
        to: targetName,
        body: req.body as string,
        timeoutMs,
      });
      if (!created.ok) return fail(id, created.error);

      state.mailbox.deliver({
        kind: 'ask',
        from: caller.name,
        to: targetName,
        body: created.ask.body,
        askId: created.ask.id,
      });
      state.journal.append('ask', { id: created.ask.id, from: caller.name, to: targetName });

      // A hook-based transport cannot reach an agent that is not running
      // tools, so blocking on an idle peer would just burn the timeout.
      // Queue instead, and say so.
      const targetView = state.registry
        .list(caller.workspaceRoot)
        .find((a) => a.name === targetName);
      if (targetView?.status === 'idle') {
        return {
          id,
          ok: true,
          state: 'queued',
          askId: created.ask.id,
          to: targetName,
          note: `${targetName} is idle, so the question is queued and will be delivered when it next acts.`,
        };
      }

      const outcome = await state.waiters.wait(created.ask.id, timeoutMs);
      const settled = state.asks.get(created.ask.id);

      if (outcome === 'answered' && settled?.state === 'answered') {
        return {
          id,
          ok: true,
          state: 'answered',
          askId: created.ask.id,
          from: targetName,
          body: settled.answer,
        };
      }
      return {
        id,
        ok: true,
        state: 'timeout',
        askId: created.ask.id,
        to: targetName,
        note: `No answer within ${timeoutMs}ms. The question is still queued for ${targetName}.`,
      };
    }

    case 'reply': {
      const caller = callerOf(state, ctx, req);
      if (!caller) return fail(id, 'reply requires a registered agent (call register first)');
      const askId = typeof req.askId === 'number' ? req.askId : null;
      if (askId === null) return fail(id, 'reply requires a numeric "askId"');

      const result = state.asks.answer(askId, caller.name, req.body as string);
      if (!result.ok || !result.ask) return fail(id, result.error ?? 'reply failed');

      state.mailbox.deliver({
        kind: 'reply',
        from: caller.name,
        to: result.ask.from,
        body: result.ask.answer as string,
        askId,
      });
      state.journal.append('reply', { id: askId, from: caller.name, to: result.ask.from });
      state.waiters.resolve(askId, 'answered');

      return { id, ok: true, askId, to: result.ask.from };
    }

    case 'claim': {
      const caller = callerOf(state, ctx, req);
      if (!caller) return fail(id, 'claim requires a registered agent (call register first)');
      const patterns = Array.isArray(req.patterns)
        ? req.patterns.filter((p): p is string => typeof p === 'string' && p.trim().length > 0)
        : [];
      if (patterns.length === 0) return fail(id, 'claim requires a non-empty "patterns" array');

      const mode = req.mode === 'shared' ? 'shared' : 'exclusive';
      const result = state.claims.claim({
        holder: caller.name,
        workspaceRoot: caller.workspaceRoot,
        patterns,
        mode,
        ...(typeof req.ttlMs === 'number' ? { ttlMs: req.ttlMs } : {}),
      });

      if (!result.ok) {
        const first = result.conflicts[0];
        return fail(
          id,
          `Cannot claim: ${first?.holder} already holds "${first?.pattern}". ` +
            `Ask them to release it, or claim a narrower path.`,
        );
      }

      state.journal.append('claim', { holder: caller.name, patterns, mode });
      return {
        id,
        ok: true,
        claimId: result.claim.id,
        patterns,
        mode,
        expiresAt: result.claim.expiresAt,
      };
    }

    case 'release': {
      const caller = callerOf(state, ctx, req);
      if (!caller) return fail(id, 'release requires a registered agent (call register first)');
      const patterns = Array.isArray(req.patterns)
        ? req.patterns.filter((p): p is string => typeof p === 'string')
        : undefined;

      let released = 0;
      if (req.force === true) {
        for (const pattern of patterns ?? []) {
          released += state.claims.forceRelease(caller.workspaceRoot, pattern);
        }
        state.journal.append('release-force', { by: caller.name, patterns });
      } else {
        released = state.claims.release(caller.name, patterns);
        state.journal.append('release', { holder: caller.name, patterns, released });
      }
      return { id, ok: true, released };
    }

    case 'claims': {
      const caller = callerOf(state, ctx, req);
      const root =
        caller?.workspaceRoot ?? resolveWorkspace(readString(req, 'cwd') ?? process.cwd()).root;
      const now = state.clock();
      return {
        id,
        ok: true,
        claims: state.claims.list(root).map((c) => ({
          id: c.id,
          holder: c.holder,
          patterns: c.patterns,
          mode: c.mode,
          expiresInMs: c.expiresAt - now,
        })),
      };
    }

    case 'check': {
      const caller = callerOf(state, ctx, req);
      if (!caller) return { id, ok: true, allowed: true };
      const rawPath = readString(req, 'path');
      if (!rawPath) return { id, ok: true, allowed: true };

      // Accept absolute or workspace-relative paths: hooks report absolute
      // ones, agents think in relative ones, and both must hit the same claim.
      const relative = rawPath.startsWith(caller.workspaceRoot)
        ? rawPath.slice(caller.workspaceRoot.length).replace(/^\/+/, '')
        : rawPath;

      const verdict = state.claims.check(caller.workspaceRoot, relative, caller.name);
      if (verdict.allowed) return { id, ok: true, allowed: true };

      const holderName = verdict.holder as string;
      const pattern = verdict.pattern as string;
      const holderAgent = state.registry.byName(caller.workspaceRoot, holderName);
      const holderIdleMs = holderAgent ? state.clock() - holderAgent.lastSeen : 0;

      // A stalled holder must not wedge a working agent. Warn instead of deny.
      if (holderAgent && holderIdleMs > HOLDER_IDLE_THRESHOLD_MS) {
        return {
          id,
          ok: true,
          allowed: true,
          warning:
            `${holderName} holds "${pattern}" but has been idle ` +
            `${Math.round(holderIdleMs / 1000)}s. Proceeding; consider releasing the claim.`,
        };
      }

      return {
        id,
        ok: true,
        allowed: false,
        holder: holderName,
        pattern,
        reason: denialReason({ path: relative, holder: holderName, pattern, holderIdleMs }),
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
