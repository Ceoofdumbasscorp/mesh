import { record } from './probe-common.mjs';

// Records what the host gave it, then speaks just enough JSON-RPC to look like
// a healthy MCP stdio server so the host does not tear it down.
record('mcp');

let buffer = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  buffer += chunk;
  let index;
  while ((index = buffer.indexOf('\n')) !== -1) {
    const line = buffer.slice(0, index).trim();
    buffer = buffer.slice(index + 1);
    if (!line) continue;
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      continue;
    }
    if (message.id === undefined) continue; // a notification needs no reply
    const result =
      message.method === 'initialize'
        ? {
            protocolVersion: '2024-11-05',
            capabilities: { tools: {} },
            serverInfo: { name: 'probe', version: '0.0.1' },
          }
        : message.method === 'tools/list'
          ? { tools: [] }
          : {};
    process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: message.id, result })}\n`);
  }
});
