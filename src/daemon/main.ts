#!/usr/bin/env node
import { meshPaths, ensureMeshHome } from '../paths.ts';
import { MeshServer, createDaemonState } from './server.ts';

function argValue(flag: string, fallback: string): string {
  const index = process.argv.indexOf(flag);
  if (index === -1) return fallback;
  return process.argv[index + 1] ?? fallback;
}

const paths = meshPaths();
const socketPath = argValue('--socket', paths.socket);
const journalPath = argValue('--journal', paths.journal);

ensureMeshHome(paths);

const server = new MeshServer({
  socketPath,
  state: createDaemonState({ journalPath }),
  onShutdown: () => process.exit(0),
});

await server.start();

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    void server.close().then(() => process.exit(0));
  });
}
