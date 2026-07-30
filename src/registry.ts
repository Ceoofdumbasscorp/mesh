import type { Clock } from './clock.ts';
import { NameAllocator } from './names.ts';
import type { Workspace } from './workspace.ts';

export type AgentStatus = 'working' | 'idle';

export interface RegisterInput {
  sessionId: string;
  provider: string;
  workspace: Workspace;
  role?: string;
  pid?: number;
}

export interface Agent {
  name: string;
  sessionId: string;
  provider: string;
  role: string | null;
  pid: number | null;
  workspaceRoot: string;
  workspaceLabel: string;
  registeredAt: number;
  lastSeen: number;
  activity: string | null;
}

export interface AgentView extends Agent {
  status: AgentStatus;
  idleMs: number;
}

export interface RegistryOptions {
  clock: Clock;
  /** Silence beyond this is reported as idle. */
  idleAfterMs?: number;
}

const DEFAULT_IDLE_AFTER_MS = 60_000;

/**
 * The id the MCP server invents when its host does not give it one.
 * Measured 2026-07-27: Codex passes no session id and scrubs the environment
 * it hands an MCP server, so this is the normal Codex path, not an edge case.
 * See spikes/session-identity/FINDINGS.md.
 */
const PROVISIONAL_ID = /^pid-\d+$/;

export function isProvisionalSessionId(sessionId: string): boolean {
  return PROVISIONAL_ID.test(sessionId);
}

export class Registry {
  #clock: Clock;
  #idleAfterMs: number;
  #agents = new Map<string, Agent>();
  #order: string[] = [];
  #names = new Map<string, NameAllocator>();
  /** provisional id → the real id that superseded it. */
  #aliases = new Map<string, string>();

  constructor(options: RegistryOptions) {
    this.#clock = options.clock;
    this.#idleAfterMs = options.idleAfterMs ?? DEFAULT_IDLE_AFTER_MS;
  }

  #allocatorFor(workspaceRoot: string): NameAllocator {
    let allocator = this.#names.get(workspaceRoot);
    if (!allocator) {
      allocator = new NameAllocator();
      this.#names.set(workspaceRoot, allocator);
    }
    return allocator;
  }

  #resolve(sessionId: string): string {
    return this.#aliases.get(sessionId) ?? sessionId;
  }

  /**
   * An agent that is the same session as `incomingId` under another name.
   * Exactly one of the two ids must be provisional: two *real* ids sharing a
   * pid are genuinely different sessions and merging them would silently fuse
   * two agents — far worse than the duplicate row this fixes.
   */
  #twinFor(workspaceRoot: string, pid: number, incomingId: string): Agent | undefined {
    const incomingProvisional = isProvisionalSessionId(incomingId);
    for (const agent of this.#agents.values()) {
      if (agent.workspaceRoot !== workspaceRoot || agent.pid !== pid) continue;
      if (isProvisionalSessionId(agent.sessionId) !== incomingProvisional) return agent;
    }
    return undefined;
  }

  /**
   * Folds a second registration into the agent that already exists. The name
   * never changes: claims and mailboxes are keyed by name, so renaming here
   * would strand both.
   */
  #adopt(twin: Agent, input: RegisterInput, now: number): Agent {
    twin.lastSeen = now;
    if (input.role !== undefined) twin.role = input.role;

    if (isProvisionalSessionId(twin.sessionId)) {
      // The real id wins. The provisional one becomes an alias, because the
      // connection that registered it still refers to itself that way — and
      // for the MCP server that connection closing is our liveness signal.
      const provisional = twin.sessionId;
      this.#agents.delete(provisional);
      twin.sessionId = input.sessionId;
      this.#agents.set(input.sessionId, twin);
      this.#order = this.#order.map((id) => (id === provisional ? input.sessionId : id));
      this.#aliases.set(provisional, input.sessionId);
    } else {
      this.#aliases.set(input.sessionId, twin.sessionId);
    }
    return twin;
  }

  register(input: RegisterInput): Agent {
    const now = this.#clock();
    const sessionId = this.#resolve(input.sessionId);

    // Idempotent per session: a hook can fire before the MCP server connects,
    // and both paths register. Neither should mint a second agent.
    const existing = this.#agents.get(sessionId);
    if (existing) {
      existing.lastSeen = now;
      if (input.role !== undefined) existing.role = input.role;
      if (input.pid !== undefined) existing.pid = input.pid;
      return existing;
    }

    // One host process, two ids: the hook knows the host's real session id and
    // the MCP server had to invent one. Measured 2026-07-27: on Claude and on
    // Codex both processes are direct children of the host, so process.ppid is
    // the same number on both sides and identifies the session.
    const twin =
      input.pid === undefined
        ? undefined
        : this.#twinFor(input.workspace.root, input.pid, input.sessionId);
    if (twin) return this.#adopt(twin, input, now);

    const agent: Agent = {
      name: this.#allocatorFor(input.workspace.root).allocate(input.provider),
      sessionId: input.sessionId,
      provider: input.provider,
      role: input.role ?? null,
      pid: input.pid ?? null,
      workspaceRoot: input.workspace.root,
      workspaceLabel: input.workspace.label,
      registeredAt: now,
      lastSeen: now,
      activity: null,
    };

    this.#agents.set(agent.sessionId, agent);
    this.#order.push(agent.sessionId);
    return agent;
  }

  /**
   * Drops agents whose host process is gone.
   *
   * The MCP connection is the normal liveness signal, but an agent registered
   * only by its hook has no owning connection, so nothing ever removes it. Its
   * row lingered in `mesh who` and its claims kept blocking live agents. The
   * predicate is injected so this stays a pure module with no syscalls of its
   * own; agents that never reported a pid are left alone, since there is
   * nothing to check.
   */
  reap(isAlive: (pid: number) => boolean): Agent[] {
    const dead: Agent[] = [];
    for (const agent of [...this.#agents.values()]) {
      if (agent.pid === null) continue;
      if (isAlive(agent.pid)) continue;
      dead.push(agent);
    }
    for (const agent of dead) this.unregister(agent.sessionId);
    return dead;
  }

  unregister(sessionId: string): Agent | null {
    const resolved = this.#resolve(sessionId);
    const agent = this.#agents.get(resolved);
    if (!agent) return null;
    this.#agents.delete(resolved);
    this.#order = this.#order.filter((id) => id !== resolved);
    for (const [alias, target] of this.#aliases) {
      if (alias === resolved || target === resolved) this.#aliases.delete(alias);
    }
    this.#allocatorFor(agent.workspaceRoot).release(agent.name);
    return agent;
  }

  touch(sessionId: string, activity?: string): boolean {
    const agent = this.#agents.get(this.#resolve(sessionId));
    if (!agent) return false;
    agent.lastSeen = this.#clock();
    if (activity !== undefined) agent.activity = activity;
    return true;
  }

  get(sessionId: string): Agent | undefined {
    return this.#agents.get(this.#resolve(sessionId));
  }

  byName(workspaceRoot: string, name: string): Agent | undefined {
    for (const agent of this.#agents.values()) {
      if (agent.workspaceRoot === workspaceRoot && agent.name === name) return agent;
    }
    return undefined;
  }

  #view(agent: Agent): AgentView {
    const idleMs = this.#clock() - agent.lastSeen;
    return {
      ...agent,
      idleMs,
      status: idleMs > this.#idleAfterMs ? 'idle' : 'working',
    };
  }

  list(workspaceRoot: string): AgentView[] {
    return this.#order
      .map((id) => this.#agents.get(id))
      .filter(
        (agent): agent is Agent => agent !== undefined && agent.workspaceRoot === workspaceRoot,
      )
      .map((agent) => this.#view(agent));
  }

  all(): AgentView[] {
    return this.#order
      .map((id) => this.#agents.get(id))
      .filter((agent): agent is Agent => agent !== undefined)
      .map((agent) => this.#view(agent));
  }
}
