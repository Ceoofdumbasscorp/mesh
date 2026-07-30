/**
 * Whether a host process is still running.
 *
 * An agent's lifetime is normally bounded by its MCP connection, but a session
 * whose MCP server never started — or failed — is registered by the hook
 * alone, and nothing closes that. Those agents used to sit in `mesh who`
 * forever, holding a name and any claims they had taken. The recorded pid is
 * the host process, so asking the OS whether it still exists is the honest
 * liveness check.
 *
 * Signal 0 performs the permission and existence checks without delivering
 * anything. EPERM means the process exists but belongs to someone else, which
 * still counts as alive.
 */
export function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}
