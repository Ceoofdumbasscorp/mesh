export interface HookEntry {
  type: 'command';
  command: string;
  timeout?: number;
}

export interface HookMatcher {
  matcher?: string;
  hooks: HookEntry[];
}

export type HookConfig = Record<string, HookMatcher[]>;

/**
 * The events mesh installs, and no others.
 *
 * SessionStart registers the agent. PreToolUse reports activity, injects
 * anything addressed to this agent, and is the enforcement point for claims.
 * Stop is what makes an idle agent reachable: PreToolUse rides tool calls, and
 * an agent sitting at its prompt makes none, so without Stop a message to it
 * waits for a human to type. It costs nothing on the critical path — it fires
 * once per turn, not once per tool call.
 *
 * PostToolUse would report nothing PreToolUse has not already reported, and
 * every installed event costs another 64ms process on the user's critical path.
 */
export const MESH_HOOK_EVENTS: readonly string[] = ['SessionStart', 'PreToolUse', 'Stop'];

/**
 * Events that take a matcher. Stop is not one of them — it has no tool to
 * match on, and both hosts key trust and dispatch off the exact block shape.
 * Source: OpenAI's own Claude→Codex converter, CODEX_HOOK_MATCHER_EVENTS.
 */
const MATCHER_EVENTS: ReadonlySet<string> = new Set([
  'PreToolUse',
  'PostToolUse',
  'SessionStart',
]);

/** Ten seconds is far above the 90ms budget; it exists to bound a wedged host. */
const HOOK_TIMEOUT_SECONDS = 10;

const SAFE_UNQUOTED = /^[A-Za-z0-9_@%+=:,./-]+$/;

export function shellQuote(value: string): string {
  if (SAFE_UNQUOTED.test(value)) return value;
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/**
 * The command a host runs for one event.
 *
 * `nodePath` is absolute — the node that ran `mesh init`, not whatever `node`
 * a hook's minimal PATH might resolve to. Env is a shell prefix rather than a
 * wrapper script: measured 2026-07-27, a prefixed command is still exec'd to a
 * direct child of the host, which is what keeps process.ppid equal to the host
 * pid and lets the daemon reconcile the hook with the MCP server.
 */
export function meshHookCommand(input: {
  nodePath: string;
  entry: string;
  event: string;
  env?: Record<string, string>;
}): string {
  const prefix = Object.entries(input.env ?? {})
    .map(([key, value]) => `${key}=${shellQuote(value)} `)
    .join('');
  return `${prefix}${shellQuote(input.nodePath)} ${shellQuote(input.entry)} hook ${input.event}`;
}

export function blockMentions(block: HookMatcher, entry: string): boolean {
  return (block.hooks ?? []).some(
    (hook) => typeof hook.command === 'string' && hook.command.includes(entry),
  );
}

/**
 * Adds mesh's hooks to a host's hook config.
 *
 * Idempotent by entry point: a block already pointing at this entry is dropped
 * and rewritten, so re-running init repoints instead of duplicating. Every
 * other block is preserved untouched — cmux, the user, and other tools all
 * live in these files, and mesh is a guest in them.
 */
export function withMeshHooks(
  config: HookConfig,
  options: {
    nodePath: string;
    entry: string;
    env?: Record<string, string>;
    includeMatcher: boolean;
  },
): HookConfig {
  const next: HookConfig = { ...config };

  for (const event of MESH_HOOK_EVENTS) {
    const others = (next[event] ?? []).filter((block) => !blockMentions(block, options.entry));
    const block: HookMatcher = {
      ...(options.includeMatcher && MATCHER_EVENTS.has(event) ? { matcher: '' } : {}),
      hooks: [
        {
          type: 'command',
          command: meshHookCommand({
            nodePath: options.nodePath,
            entry: options.entry,
            event,
            ...(options.env ? { env: options.env } : {}),
          }),
          timeout: HOOK_TIMEOUT_SECONDS,
        },
      ],
    };
    next[event] = [...others, block];
  }

  return next;
}
