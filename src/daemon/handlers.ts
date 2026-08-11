import type { Clock } from '../clock.ts';
import type { Journal } from '../journal.ts';
import type { Registry } from '../registry.ts';
import type { Response } from '../protocol.ts';
import { resolveWorkspace } from '../workspace.ts';
import type { Mailbox } from '../mailbox.ts';
import type { AskRegistry } from '../asks.ts';
import type { ClaimTable } from '../claims.ts';
import type { Waiters } from './waiters.ts';
import { randomBytes } from 'node:crypto';
import { normalizeClaimPattern, workspaceRelativeTarget } from '../workspace.ts';

export interface DaemonState {
  registry: Registry;
  journal: Journal;
  clock: Clock;
  mailbox: Mailbox;
  asks: AskRegistry;
  claims: ClaimTable;
  waiters: Waiters;
  /** Whether a host process is still running. Injected so tests stay hermetic. */
  isAlive: (pid: number) => boolean;
}

/**
 * Removes agents whose host process has exited, releasing whatever they held.
 * Called wherever a stale agent would otherwise mislead someone: when listing
 * agents, and before enforcing a claim — a dead holder must never block a live
 * agent's edit.
 */
function reapDeadAgents(state: DaemonState): void {
  for (const agent of state.registry.reap(state.isAlive)) {
    const releasedClaims = state.claims.release(agent.name);
    state.journal.append('reap', {
      name: agent.name,
      pid: agent.pid,
      releasedClaims,
    });
  }
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
): { name: string; workspaceRoot: string } | null {
  const sessionId = ctx.sessionId;
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
      if (Buffer.byteLength(sessionId) > 256) return fail(id, 'sessionId exceeds 256 bytes');
      const provider = readString(req, 'provider');
      if (!provider) return fail(id, 'register requires "provider"');
      if (Buffer.byteLength(provider) > 64) return fail(id, 'provider exceeds 64 bytes');

      const workspace = resolveWorkspace(readString(req, 'cwd') ?? process.cwd());
      const bound = ctx.sessionId ? state.registry.get(ctx.sessionId) : undefined;
      const requested = state.registry.get(sessionId);
      if (
        bound &&
        (!requested || requested.name !== bound.name || requested.workspaceRoot !== bound.workspaceRoot)
      ) {
        return fail(id, 'connection is already bound to another session');
      }
      // The hook re-registers before every tool call, so journaling every
      // register buried the interesting events under thousands of identical
      // lines and grew the file for no information.
      const alreadyKnown = state.registry.get(sessionId) !== undefined;
      const suppliedCapability = readString(req, 'capability');
      if (suppliedCapability && Buffer.byteLength(suppliedCapability) > 128) {
        return fail(id, 'capability exceeds 128 bytes');
      }
      const role = readString(req, 'role');
      if (role && Buffer.byteLength(role) > 128) return fail(id, 'role exceeds 128 bytes');
      const pid = typeof req.pid === 'number' && Number.isSafeInteger(req.pid) && req.pid > 0
        ? req.pid
        : undefined;
      const capability = req.own === true
        ? (state.registry.get(ctx.sessionId ?? '')?.capability ?? suppliedCapability ?? randomBytes(32).toString('base64url'))
        : suppliedCapability;
      let agent;
      try {
        agent = state.registry.register({
          sessionId,
          provider,
          workspace,
          ...(role ? { role } : {}),
          ...(pid !== undefined ? { pid } : {}),
          // The registry needs this too, not just the connection: it is the only
          // evidence that separates a rotated session id from a second agent.
          owns: req.own === true,
          ...(capability ? { capability } : {}),
        });
      } catch (error) {
        return fail(id, (error as Error).message);
      }

      ctx.sessionId = sessionId;
      // Ownership is opt-in and sticky: a connection that ever claimed
      // ownership keeps it, so a later non-owning register on the same
      // connection cannot silently downgrade it.
      if (req.own === true) ctx.owns = true;
      if (!alreadyKnown) {
        state.journal.append('register', {
          name: agent.name,
          provider,
          workspace: workspace.root,
        });
      }

      return {
        id,
        ok: true,
        name: agent.name,
        workspace: workspace.root,
        workspaceLabel: workspace.label,
        ...(req.own === true ? { capability: agent.capability } : {}),
      };
    }

    case 'unregister': {
      const sessionId = ctx.sessionId;
      if (!sessionId) return fail(id, 'unregister requires "sessionId"');

      const removed = state.registry.unregister(sessionId);
      if (ctx.sessionId === sessionId) ctx.sessionId = null;
      if (removed) {
        state.journal.append('unregister', { name: removed.name });
      }
      return { id, ok: true, removed: removed !== null };
    }

    case 'touch': {
      const sessionId = ctx.sessionId;
      if (!sessionId) return fail(id, 'touch requires "sessionId"');
      const activity = readString(req, 'activity');
      if (activity && Buffer.byteLength(activity) > 512) return fail(id, 'activity exceeds 512 bytes');
      const known = state.registry.touch(sessionId, activity);
      // Activity is what keeps a claim alive: an agent still working never
      // loses its claims, while a stalled one lets them lapse.
      const toucher = state.registry.get(sessionId);
      if (toucher) state.claims.refresh(toucher.name);
      return { id, ok: true, known };
    }

    case 'who': {
      reapDeadAgents(state);
      const workspace = resolveWorkspace(readString(req, 'cwd') ?? process.cwd());
      const agents = state.registry.list(workspace.root).map((agent) => ({
        name: agent.name,
        provider: agent.provider,
        role: agent.role,
        status: agent.status,
        activity: agent.activity,
        idleMs: agent.idleMs,
        // An idle agent cannot be reached by a hook-based transport, so the
        // human is the fallback: mesh watch shows them what is stuck.
        unanswered: state.asks.pendingFor(agent.name).length,
        waitingOn: state.asks.waitingOn(agent.name).map((ask) => ask.to),
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
      const caller = callerOf(state, ctx);
      if (!caller) return fail(id, 'send requires a registered agent (call register first)');
      const target = readString(req, 'to');
      if (!target) return fail(id, 'send requires "to"');

      const names = resolveTargets(state, caller.workspaceRoot, caller.name, target);
      // A broadcast to an empty room is a no-op, not a failure. Erroring on it
      // made "tell whoever is here" unusable exactly when an agent was alone
      // and most needed to leave word — and an error reads to the agent as
      // something it did wrong, so it retries instead of moving on.
      if (names.length === 0 && target === '*') {
        return { id, ok: true, delivered: 0, to: [], note: 'No other agents on this workspace.' };
      }
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
      const caller = callerOf(state, ctx);
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
      const caller = callerOf(state, ctx);
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

      const requestedTimeout = typeof req.timeoutMs === 'number' && Number.isFinite(req.timeoutMs)
        ? req.timeoutMs
        : 90_000;
      const timeoutMs = Math.min(Math.max(Math.trunc(requestedTimeout), 1), 5 * 60_000);
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
      const caller = callerOf(state, ctx);
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
      const caller = callerOf(state, ctx);
      if (!caller) return fail(id, 'claim requires a registered agent (call register first)');
      const rawPatterns = Array.isArray(req.patterns)
        ? req.patterns.filter((p): p is string => typeof p === 'string' && p.trim().length > 0)
        : [];
      if (rawPatterns.length > 128) return fail(id, 'claim accepts at most 128 patterns');
      const normalized = rawPatterns.map(normalizeClaimPattern);
      if (normalized.some((pattern) => pattern === null)) {
        return fail(id, 'claim patterns must be workspace-relative and contain no dot segments');
      }
      const patterns = [...new Set(normalized as string[])];
      if (patterns.some((pattern) => Buffer.byteLength(pattern) > 512)) {
        return fail(id, 'each claim pattern must be at most 512 bytes');
      }
      if (patterns.reduce((sum, pattern) => sum + Buffer.byteLength(pattern), 0) > 16_384) {
        return fail(id, 'claim patterns exceed 16384 bytes');
      }
      if (patterns.length === 0) return fail(id, 'claim requires a non-empty "patterns" array');

      const mode = req.mode === 'shared' ? 'shared' : 'exclusive';
      let result;
      try {
        const requestedTtl = typeof req.ttlMs === 'number' && Number.isFinite(req.ttlMs)
          ? req.ttlMs
          : undefined;
        const ttlMs = requestedTtl === undefined
          ? undefined
          : Math.min(Math.max(Math.trunc(requestedTtl), 1000), 24 * 60 * 60_000);
        result = state.claims.claim({
          holder: caller.name,
          workspaceRoot: caller.workspaceRoot,
          patterns,
          mode,
          ...(ttlMs !== undefined ? { ttlMs } : {}),
        });
      } catch (error) {
        return fail(id, (error as Error).message);
      }

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
      const caller = callerOf(state, ctx);
      const patterns = Array.isArray(req.patterns)
        ? req.patterns.filter((p): p is string => typeof p === 'string')
        : undefined;

      let released = 0;
      if (req.force === true) {
        // The escape hatch named in every denial message, so it must work from
        // a plain shell. `mesh release --force` is a human typing into their
        // own terminal — not a registered agent — and requiring registration
        // meant the one documented way out of a stuck claim always failed.
        const root =
          caller?.workspaceRoot ?? resolveWorkspace(readString(req, 'cwd') ?? process.cwd()).root;
        for (const pattern of patterns ?? []) {
          released += state.claims.forceRelease(root, pattern);
        }
        state.journal.append('release-force', {
          by: caller?.name ?? 'cli',
          patterns,
          released,
        });
        return { id, ok: true, released };
      }

      if (!caller) return fail(id, 'release requires a registered agent (call register first)');
      {
        released = state.claims.release(caller.name, patterns);
        state.journal.append('release', { holder: caller.name, patterns, released });
      }
      return { id, ok: true, released };
    }

    case 'claims': {
      const caller = callerOf(state, ctx);
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
      // A claim held by a session that has since died must not block anyone.
      reapDeadAgents(state);
      const caller = callerOf(state, ctx);
      if (!caller) return { id, ok: true, allowed: true };
      const rawPath = readString(req, 'path');
      if (!rawPath) return { id, ok: true, allowed: true };

      // Accept absolute or workspace-relative paths: hooks report absolute
      // ones, agents think in relative ones, and both must hit the same claim.
      const cwd = readString(req, 'cwd') ?? caller.workspaceRoot;
      const relative = workspaceRelativeTarget(caller.workspaceRoot, cwd, rawPath);
      if (relative === null) return { id, ok: true, allowed: true };

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
      // Flag it; the server stops once this response has actually flushed, so
      // the caller is not left holding a socket that vanished mid-answer.
      ctx.requestShutdown?.();
      return { id, ok: true };
    }

    default:
      return fail(id, `Unknown op: ${op}`);
  }
}
