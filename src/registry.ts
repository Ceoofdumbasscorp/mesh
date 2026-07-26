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

export class Registry {
  #clock: Clock;
  #idleAfterMs: number;
  #agents = new Map<string, Agent>();
  #order: string[] = [];
  #names = new Map<string, NameAllocator>();

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

  register(input: RegisterInput): Agent {
    const now = this.#clock();

    // Idempotent per session: a hook can fire before the MCP server connects,
    // and both paths register. Neither should mint a second agent.
    const existing = this.#agents.get(input.sessionId);
    if (existing) {
      existing.lastSeen = now;
      if (input.role !== undefined) existing.role = input.role;
      if (input.pid !== undefined) existing.pid = input.pid;
      return existing;
    }

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

  unregister(sessionId: string): Agent | null {
    const agent = this.#agents.get(sessionId);
    if (!agent) return null;
    this.#agents.delete(sessionId);
    this.#order = this.#order.filter((id) => id !== sessionId);
    this.#allocatorFor(agent.workspaceRoot).release(agent.name);
    return agent;
  }

  touch(sessionId: string, activity?: string): boolean {
    const agent = this.#agents.get(sessionId);
    if (!agent) return false;
    agent.lastSeen = this.#clock();
    if (activity !== undefined) agent.activity = activity;
    return true;
  }

  get(sessionId: string): Agent | undefined {
    return this.#agents.get(sessionId);
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
