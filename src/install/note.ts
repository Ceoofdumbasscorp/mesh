export const MESH_NOTE_BEGIN = '<!-- mesh:begin -->';
export const MESH_NOTE_END = '<!-- mesh:end -->';

/**
 * Written to every host's global agent instructions, so it must be honest in
 * workspaces where mesh is off. The MCP server deliberately exposes zero
 * tools there; agents must not be told to call tools they cannot access.
 */
const NOTE = `## mesh — coordinate when the tools are available

mesh is opt-in per workspace. If this session exposes \`mesh_*\` tools, other AI
agents may be working in this project in other terminal windows. They are peers,
not your sub-agents. If the tools are absent, mesh is off here; do not attempt
to call them. The operator can run \`mesh on\` in the project and restart agents.

- \`mesh_who\` — when available, see who else is here and what they are doing.
  Check before assuming you are the only one editing.
- \`mesh_ask\` — ask a peer a question and wait for the answer. Use it when you
  are blocked on something they own, instead of guessing.
- \`mesh_send\` — tell a peer something they need to know. No reply expected.
- \`mesh_inbox\` — read what peers have sent you.

If an edit is blocked with "BLOCKED by mesh", another agent has claimed that
path. The message names the holder and how to proceed. Do not work around it by
editing through a shell.`;

export function withMeshNote(text: string): string {
  const block = `${MESH_NOTE_BEGIN}\n${NOTE}\n${MESH_NOTE_END}`;
  const begin = text.indexOf(MESH_NOTE_BEGIN);

  if (begin !== -1) {
    const end = text.indexOf(MESH_NOTE_END, begin);
    if (end !== -1) {
      return `${text.slice(0, begin)}${block}${text.slice(end + MESH_NOTE_END.length)}`;
    }
  }

  const separator =
    text.length === 0 || text.endsWith('\n\n') ? '' : text.endsWith('\n') ? '\n' : '\n\n';
  return `${text}${separator}${block}\n`;
}
