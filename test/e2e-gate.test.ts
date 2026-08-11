import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { MeshServer, createDaemonState } from '../src/daemon/server.ts';
import { MeshClient } from '../src/client.ts';
import { runHook } from '../src/hook.ts';
import { enableWorkspace, disableWorkspace } from '../src/enabled.ts';
import { writeSessionCapability } from '../src/session-capability.ts';

/**
 * The gate's whole promise is "mesh does nothing here". Proving that with a
 * dead daemon would prove nothing — the hook returns {} in that case anyway.
 *
 * So each case below runs against a LIVE daemon holding REAL mail addressed to
 * the calling session, in a workspace the hook is told about. The only
 * variable is whether `mesh on` was run. Off must yield {}; on must wake.
 */
async function withGatedDaemon<T>(
  fn: (ctx: { workspace: string; stdinFor: (event: string) => Readable }) => Promise<T>,
): Promise<T> {
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'mesh-gate-home-')));
  const workspace = realpathSync(mkdtempSync(join(tmpdir(), 'mesh-gate-ws-')));
  mkdirSync(join(workspace, '.git'));

  const previousHome = process.env.MESH_HOME;
  process.env.MESH_HOME = home;

  const server = new MeshServer({
    socketPath: join(home, 'mesh.sock'),
    state: createDaemonState({ journalPath: join(home, 'journal.jsonl') }),
  });
  await server.start();

  // A peer leaves mail for us, then we run the hook as the recipient.
  const peer = await MeshClient.open({ socketPath: join(home, 'mesh.sock'), autostart: false });
  assert.ok(peer, 'peer client should connect');
  await peer.request('register', {
    sessionId: 'peer-session', provider: 'codex', cwd: workspace, own: true,
  });
  const me = await MeshClient.open({ socketPath: join(home, 'mesh.sock'), autostart: false });
  assert.ok(me, 'recipient client should connect');
  const registered = await me.request('register', {
    sessionId: 'my-session', provider: 'claude', cwd: workspace, pid: process.ppid, own: true,
  });
  assert.equal(typeof registered.capability, 'string');
  writeSessionCapability(process.ppid, registered.capability as string);
  await peer.request('send', { to: 'claude-1', body: 'MAIL-IS-WAITING' });

  const stdinFor = (event: string): Readable =>
    Readable.from([
      JSON.stringify({ session_id: 'my-session', cwd: workspace, hook_event_name: event }),
    ]);

  try {
    return await fn({ workspace, stdinFor });
  } finally {
    me.close();
    peer.close();
    await server.close();
    if (previousHome === undefined) delete process.env.MESH_HOME;
    else process.env.MESH_HOME = previousHome;
    rmSync(home, { recursive: true, force: true });
    rmSync(workspace, { recursive: true, force: true });
  }
}

test('OFF: the Stop hook stays silent even with a live daemon and mail waiting', async () => {
  await withGatedDaemon(async ({ stdinFor }) => {
    const out = await runHook('Stop', { stdin: stdinFor('Stop') });
    assert.deepEqual(out, {}, 'a disabled workspace must produce no decision at all');
  });
});

test('OFF: SessionStart injects nothing', async () => {
  await withGatedDaemon(async ({ stdinFor }) => {
    const out = await runHook('SessionStart', { stdin: stdinFor('SessionStart') });
    assert.deepEqual(out, {});
  });
});

test('OFF then ON: the same daemon and the same mail now wake the agent', async () => {
  await withGatedDaemon(async ({ workspace, stdinFor }) => {
    // Same call, twice, with only the switch changing between them.
    const off = await runHook('Stop', { stdin: stdinFor('Stop') });
    assert.deepEqual(off, {}, 'baseline: silent while off');

    enableWorkspace(workspace);
    const on = await runHook('Stop', { stdin: stdinFor('Stop') });

    assert.equal(on.decision, 'block', 'enabling must restore the wake channel');
    assert.match(String(on.reason), /MAIL-IS-WAITING/);

    // And turning it back off silences it again without touching the mail.
    disableWorkspace(workspace);
    const offAgain = await runHook('Stop', { stdin: stdinFor('Stop') });
    assert.deepEqual(offAgain, {}, 'off must be reversible, not one-way');
  });
});

test('OFF: enabling a DIFFERENT workspace does not enable this one', async () => {
  await withGatedDaemon(async ({ stdinFor }) => {
    const elsewhere = realpathSync(mkdtempSync(join(tmpdir(), 'mesh-gate-other-')));
    try {
      enableWorkspace(elsewhere);
      const out = await runHook('Stop', { stdin: stdinFor('Stop') });
      assert.deepEqual(out, {}, 'the switch is per-workspace, not global');
    } finally {
      rmSync(elsewhere, { recursive: true, force: true });
    }
  });
});
