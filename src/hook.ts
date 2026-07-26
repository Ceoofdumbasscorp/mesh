import { basename } from 'node:path';
import { MeshClient } from './client.ts';

export interface HookInput {
  hook_event_name?: string;
  session_id?: string;
  cwd?: string;
  tool_name?: string;
  tool_input?: Record<string, unknown>;
  [key: string]: unknown;
}

export interface InjectedMessage {
  kind: string;
  from: string;
  body: string;
  askId: number | null;
}

/**
 * Reads stdin with a deadline and never blockingly.
 *
 * Phase 0 finding: Codex holds the hook's stdin pipe open without closing it.
 * A synchronous read never returns, the host waits on the hook, and the whole
 * run deadlocks. destroy() matters as much as the deadline — an open stdin
 * handle keeps the event loop alive well past the point of doing any work.
 */
export function readStdinWithDeadline(stream: NodeJS.ReadStream, ms: number): Promise<string> {
  return new Promise((resolve) => {
    let buffer = '';
    let done = false;

    const finish = () => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      stream.removeAllListeners();
      stream.pause();
      stream.destroy?.();
      resolve(buffer);
    };

    const timer = setTimeout(finish, ms);
    timer.unref?.();

    stream.setEncoding?.('utf8');
    stream.on('data', (chunk: string | Buffer) => {
      buffer += typeof chunk === 'string' ? chunk : chunk.toString('utf8');
    });
    stream.on('end', finish);
    stream.on('error', finish);
  });
}

export function parseHookInput(raw: string): HookInput | null {
  try {
    const parsed = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null;
    return parsed as HookInput;
  } catch {
    return null;
  }
}

/** A short human-readable description of what the agent is doing right now. */
export function summarizeTool(input: HookInput): string | null {
  const tool = typeof input.tool_name === 'string' ? input.tool_name : null;
  if (!tool) return null;

  const args = input.tool_input ?? {};
  const filePath = args.file_path;
  if (typeof filePath === 'string' && filePath.length > 0) {
    return `${tool} ${basename(filePath)}`;
  }
  const command = args.command;
  if (typeof command === 'string' && command.length > 0) {
    // First two words only: enough to identify the command, without dragging
    // a full shell line into a peer's context.
    return `${tool} ${command.trim().split(/\s+/).slice(0, 2).join(' ')}`;
  }
  return tool;
}

/**
 * Renders queued mail as directive text. Fenced and attributed so the agent
 * treats it as a report from a peer rather than an instruction from its user.
 */
export function formatInjection(messages: InjectedMessage[]): string {
  if (messages.length === 0) return '';

  const lines = ['[MESH] Messages from other agents on this project:'];
  for (const message of messages) {
    if (message.kind === 'ask') {
      lines.push(
        `  • ${message.from} asks you: ${message.body}`,
        `    Answer with mesh_reply(askId: ${message.askId}, body: "..."). ` +
          `${message.from} is blocked waiting on you.`,
      );
    } else if (message.kind === 'reply') {
      lines.push(`  • ${message.from} answered your question #${message.askId}: ${message.body}`);
    } else {
      lines.push(`  • ${message.from}: ${message.body}`);
    }
  }
  return lines.join('\n');
}

/**
 * The output envelope. Phase 0 verified Claude and Codex accept this exact
 * shape, so there is no per-host compat layer.
 */
export function buildHookOutput(event: string, context: string | null): Record<string, unknown> {
  if (!context) return {};
  return { hookSpecificOutput: { hookEventName: event, additionalContext: context } };
}

/**
 * Fail-open at every step: any problem yields {} and the agent proceeds
 * exactly as it would without mesh installed.
 */
export async function runHook(
  event: string,
  options: { stdin?: NodeJS.ReadStream; provider?: string } = {},
): Promise<Record<string, unknown>> {
  try {
    const raw = await readStdinWithDeadline(options.stdin ?? process.stdin, 400);
    const input = parseHookInput(raw) ?? {};
    const sessionId = typeof input.session_id === 'string' ? input.session_id : null;
    const cwd = typeof input.cwd === 'string' ? input.cwd : process.cwd();
    if (!sessionId) return {};

    const provider = options.provider ?? process.env.MESH_PROVIDER ?? 'claude';
    // Never autostart from the hook. This runs before every tool call, and
    // spawning a daemon here costs ~50ms on the path that must stay cheapest.
    // The MCP server owns starting the daemon; if it is not running, mesh is
    // simply not active for this session and the hook gets out of the way.
    const client = await MeshClient.open({ autostart: false, connectTimeoutMs: 300 });
    if (!client) return {};

    try {
      // Deliberately no `own: true` — the hook's connection is transient and
      // closes after every tool call. Owning it would evict the agent.
      await client.request('register', { sessionId, provider, cwd, pid: process.ppid });

      if (event === 'SessionStart') return {};

      const activity = summarizeTool(input);
      await client.request('touch', { sessionId, ...(activity ? { activity } : {}) });

      const inbox = await client.request('inbox', { sessionId });
      if (!inbox.ok) return {};
      const messages = (inbox.messages ?? []) as InjectedMessage[];
      return buildHookOutput(event, formatInjection(messages));
    } finally {
      client.close();
    }
  } catch {
    // mesh must never be able to break the user's agent.
    return {};
  }
}
