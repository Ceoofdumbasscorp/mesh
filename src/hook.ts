import { basename } from 'node:path';
import { MeshClient } from './client.ts';
import { shellWriteTargets } from './shell.ts';

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
 * Tools that can modify a file. Only these are checked against claims —
 * enforcing reads would cost a round-trip on every Grep for no benefit.
 */
export const WRITE_TOOLS: ReadonlySet<string> = new Set([
  'Write',
  'Edit',
  'MultiEdit',
  'NotebookEdit',
  // Codex's own edit tool. The Phase 3 spike measured Codex reaching for
  // apply_patch FIRST and only falling back to a shell when blocked, so
  // omitting it would leave its primary edit path unenforced.
  'apply_patch',
  // Shell tools. A blocked agent that reaches for `echo > file` must hit the
  // same wall as one that reaches for Edit; targetPathsOf reads the command
  // string for redirections, tee, sed -i, mv/cp, rm and friends.
  'Bash',
  'shell',
  'local_shell',
  'run_terminal_cmd',
]);

/** `*** Update File: path` and its Add/Delete siblings, from the patch envelope. */
const PATCH_FILE_LINE = /^\*\*\* (?:Update|Add|Delete) File: (.+)$/gm;

export function targetPathOf(input: HookInput): string | null {
  return targetPathsOf(input)[0] ?? null;
}

/**
 * Every path a tool call would touch. Most tools name exactly one; an
 * apply_patch can rewrite several files in a single call, and missing any of
 * them would leave a claimed file unprotected.
 */
export function targetPathsOf(input: HookInput): string[] {
  const args = input.tool_input ?? {};

  // A shell command is an edit tool with extra steps. Any host's shell tool
  // carries its command as a string, so this covers Claude's Bash and Codex's
  // shell without hardcoding either name — and without it, `echo x > file`
  // bypassed a claim the design promises is enforced rather than advised.
  const command = args.command;
  if (typeof command === 'string' && command.length > 0) {
    return shellWriteTargets(command);
  }

  const direct: string[] = [];
  for (const key of ['file_path', 'notebook_path', 'path']) {
    const value = args[key];
    if (typeof value === 'string' && value.length > 0) direct.push(value);
  }
  if (direct.length > 0) return direct;

  // The field carrying an apply_patch body is an undocumented implementation
  // detail, so scan every string value for the envelope rather than trusting
  // one key name that could change between Codex releases.
  const fromPatch: string[] = [];
  for (const value of Object.values(args)) {
    if (typeof value !== 'string' || !value.includes('*** ')) continue;
    for (const match of value.matchAll(PATCH_FILE_LINE)) {
      const path = match[1]?.trim();
      if (path) fromPatch.push(path);
    }
  }
  return fromPatch;
}

/**
 * A deny decision. permissionDecisionReason is NOT optional: Phase 0 measured
 * that omitting it makes Codex report the hook as Failed and run the tool
 * anyway — a silent fail-open that looks identical to a rejected payload.
 * systemMessage is deliberately absent; that combination measured as Failed.
 */
export function buildDenyOutput(event: string, reason: string): Record<string, unknown> {
  return {
    hookSpecificOutput: {
      hookEventName: event,
      permissionDecision: 'deny',
      permissionDecisionReason: reason,
    },
  };
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

      // Enforcement: only write-capable tools, and only when a path is present.
      const tool = typeof input.tool_name === 'string' ? input.tool_name : '';
      if (event === 'PreToolUse' && WRITE_TOOLS.has(tool)) {
        // A single call can touch several files; one claimed path is enough
        // to block the whole call, since patches apply atomically.
        for (const path of targetPathsOf(input)) {
          const verdict = await client.request('check', { sessionId, path });
          if (verdict.ok && verdict.allowed === false && typeof verdict.reason === 'string') {
            return buildDenyOutput(event, verdict.reason);
          }
        }
      }

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
