export const MESH_NOTE_BEGIN = '<!-- mesh:begin -->';
export const MESH_NOTE_END = '<!-- mesh:end -->';

/**
 * Written to the agent, not the user. Injected context and denial text already
 * tell an agent what to do in the moment; this exists so it knows the tools are
 * there before anything goes wrong.
 */
const NOTE = `## mesh — you are not alone in this project

Other AI agents may be working in this same project, in other terminal windows.
They are peers, not your sub-agents.

- \`mesh_who\` — see who else is here and what they are doing. Check before
  assuming you are the only one editing.
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
