import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { MeshClient } from '../client.ts';
import type { WhoAgent } from '../cli/who.ts';
import { formatDuration } from '../cli/who.ts';

export interface McpOptions {
  sessionId: string;
  provider: string;
  cwd: string;
  role?: string;
}

/**
 * Where a session id comes from, in order of trust:
 *
 *   1. `--session <id>`        explicit; wins over everything
 *   2. MESH_SESSION_ID         the operator's escape hatch
 *   3. CLAUDE_CODE_SESSION_ID  measured 2026-07-27: Claude Code exports this to
 *                              its MCP servers, interactive and `-p` alike, and
 *                              it equals the session_id the hook receives.
 *   4. `pid-<ppid>`            provisional. Codex passes no session id at all —
 *                              it scrubs the environment it gives an MCP server
 *                              — so this is the normal Codex path. The daemon
 *                              reconciles it with the hook's real id by
 *                              (workspace, host pid), which is the same number
 *                              on both sides. See
 *                              spikes/session-identity/FINDINGS.md.
 *
 * The host variable is read ONLY under Claude: a Codex session launched from a
 * Claude session inherits CLAUDE_CODE_SESSION_ID, and trusting it there would
 * merge two different agents into one.
 */
export function resolveMcpIdentity(
  env: NodeJS.ProcessEnv,
  argv: string[],
  ppid: number = process.ppid,
): McpOptions {
  const flagIndex = argv.indexOf('--session');
  const fromFlag = flagIndex === -1 ? undefined : argv[flagIndex + 1];
  const provider = env.MESH_PROVIDER ?? 'claude';
  const isClaude = provider === 'claude';
  const role = env.MESH_ROLE;

  return {
    sessionId:
      fromFlag ??
      env.MESH_SESSION_ID ??
      (isClaude ? env.CLAUDE_CODE_SESSION_ID : undefined) ??
      `pid-${ppid}`,
    provider,
    cwd: env.MESH_CWD ?? (isClaude ? env.CLAUDE_PROJECT_DIR : undefined) ?? process.cwd(),
    ...(role ? { role } : {}),
  };
}

export function toolText(value: unknown): { content: Array<{ type: 'text'; text: string }> } {
  const text = typeof value === 'string' ? value : JSON.stringify(value, null, 1);
  return { content: [{ type: 'text', text }] };
}

export function describeWho(agents: WhoAgent[]): string {
  if (agents.length === 0) return 'No other agents are working on this project right now.';
  return agents
    .map((a) => {
      const role = a.role ? ` (${a.role})` : '';
      const doing = a.activity ?? (a.status === 'idle' ? 'idle' : 'starting up');
      return `${a.name}${role} — ${a.status}, last seen ${formatDuration(a.idleMs)} ago: ${doing}`;
    })
    .join('\n');
}

export async function startMcpServer(options: McpOptions): Promise<void> {
  const client = await MeshClient.open();
  if (!client) throw new Error('mesh: could not reach or start the daemon');

  await client.request('register', {
    sessionId: options.sessionId,
    provider: options.provider,
    cwd: options.cwd,
    ...(options.role ? { role: options.role } : {}),
    pid: process.ppid,
    // This connection owns the agent's lifetime: when the MCP server exits,
    // the session is genuinely over. The hook deliberately does NOT set this,
    // since it connects and disconnects on every tool call.
    own: true,
  });

  const server = new McpServer({ name: 'mesh', version: '0.1.0' });
  const session = { sessionId: options.sessionId };

  server.registerTool(
    'mesh_who',
    {
      description:
        'List the other AI agents working on this project right now, with their role and current activity.',
      inputSchema: {},
    },
    async () => {
      const res = await client.request('who', { cwd: options.cwd, ...session });
      const agents = ((res.agents ?? []) as WhoAgent[]).filter((a) => a.name !== options.sessionId);
      return toolText(describeWho(agents));
    },
  );

  server.registerTool(
    'mesh_send',
    {
      description:
        'Send a one-way message to another agent. Use "*" to broadcast. Returns immediately; use mesh_ask if you need an answer.',
      inputSchema: {
        to: z.string().describe('Agent name (claude-1), role (backend), or "*" for everyone'),
        body: z.string().describe('The message text'),
      },
    },
    async ({ to, body }) => {
      const res = await client.request('send', { to, body, ...session });
      return toolText(
        res.ok ? `Sent to ${(res.to as string[]).join(', ')}.` : `Failed: ${res.error}`,
      );
    },
  );

  server.registerTool(
    'mesh_ask',
    {
      description:
        'Ask another agent a question and WAIT for the answer. Use when you are blocked on something they own.',
      inputSchema: {
        to: z.string().describe('Agent name (codex-2) or role (backend)'),
        body: z.string().describe('The question'),
        timeoutMs: z.number().optional().describe('How long to wait. Default 90000.'),
      },
    },
    async ({ to, body, timeoutMs }) => {
      const res = await client.request('ask', {
        to,
        body,
        ...(timeoutMs ? { timeoutMs } : {}),
        ...session,
      });
      if (!res.ok) return toolText(`Could not ask: ${res.error}`);
      if (res.state === 'answered') return toolText(`${res.from} answered: ${res.body}`);
      return toolText(`${res.state}: ${res.note}`);
    },
  );

  server.registerTool(
    'mesh_reply',
    {
      description: 'Answer a question another agent asked you. The askId came with the question.',
      inputSchema: {
        askId: z.number().describe('The askId from the question'),
        body: z.string().describe('Your answer'),
      },
    },
    async ({ askId, body }) => {
      const res = await client.request('reply', { askId, body, ...session });
      return toolText(res.ok ? `Answered ${res.to}.` : `Failed: ${res.error}`);
    },
  );

  server.registerTool(
    'mesh_inbox',
    {
      description: 'Read messages and questions other agents have sent you.',
      inputSchema: {},
    },
    async () => {
      const res = await client.request('inbox', session);
      const messages = (res.messages ?? []) as Array<Record<string, unknown>>;
      if (messages.length === 0) return toolText('No new messages.');
      return toolText(
        messages
          .map((m) =>
            m.kind === 'ask'
              ? `${m.from} asks (askId ${m.askId}): ${m.body}`
              : `${m.from}: ${m.body}`,
          )
          .join('\n'),
      );
    },
  );

  await server.connect(new StdioServerTransport());
}
