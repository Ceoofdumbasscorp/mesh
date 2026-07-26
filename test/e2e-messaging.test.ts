import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MeshServer, createDaemonState } from '../src/daemon/server.ts';
import { MeshClient } from '../src/client.ts';

async function withDaemon<T>(fn: (socketPath: string, base: string) => Promise<T>): Promise<T> {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'mesh-e2e-')));
  const socketPath = join(base, 'mesh.sock');
  const server = new MeshServer({
    socketPath,
    state: createDaemonState({ journalPath: join(base, 'journal.jsonl') }),
  });
  await server.start();
  try {
    return await fn(socketPath, base);
  } finally {
    await server.close();
    rmSync(base, { recursive: true, force: true });
  }
}

test('two clients complete a full ask round-trip over a real socket', async () => {
  await withDaemon(async (socketPath, base) => {
    const claude = await MeshClient.open({ socketPath, autostart: false });
    const codex = await MeshClient.open({ socketPath, autostart: false });
    assert.ok(claude && codex);

    await claude.request('register', {
      sessionId: 'sa', provider: 'claude', cwd: base, role: 'frontend', own: true,
    });
    await codex.request('register', {
      sessionId: 'sb', provider: 'codex', cwd: base, role: 'backend', own: true,
    });
    await codex.request('touch', { activity: 'Edit server/api/leads.ts' });

    // claude-1 sees codex-1 and what it is doing.
    const who = await claude.request('who', { cwd: base });
    const agents = who.agents as Array<Record<string, unknown>>;
    assert.equal(agents.length, 2);
    assert.equal(
      agents.find((a) => a.name === 'codex-1')?.activity,
      'Edit server/api/leads.ts',
    );

    // claude-1 asks the backend a question and blocks.
    const asking = claude.request('ask', {
      to: 'backend',
      body: 'does POST /leads accept a partial payload?',
      timeoutMs: 5000,
    });

    // codex-1 finds it, answers it.
    const inbox = await codex.request('inbox');
    const messages = inbox.messages as Array<Record<string, unknown>>;
    assert.equal(messages.length, 1);
    assert.equal(messages[0]?.kind, 'ask');
    assert.equal(messages[0]?.from, 'claude-1');

    await codex.request('reply', {
      askId: messages[0]?.askId,
      body: 'no — email is required. adding an optional path now',
    });

    const answer = await asking;
    assert.equal(answer.state, 'answered');
    assert.equal(answer.from, 'codex-1');
    assert.match(String(answer.body), /email is required/);

    // The answer also lands in claude-1's inbox for its next hook to inject.
    const claudeInbox = await claude.request('inbox');
    const replies = claudeInbox.messages as Array<Record<string, unknown>>;
    assert.equal(replies[0]?.kind, 'reply');

    claude.close();
    codex.close();
  });
});

test('a broadcast reaches every peer over a real socket', async () => {
  await withDaemon(async (socketPath, base) => {
    const a = await MeshClient.open({ socketPath, autostart: false });
    const b = await MeshClient.open({ socketPath, autostart: false });
    const c = await MeshClient.open({ socketPath, autostart: false });
    assert.ok(a && b && c);

    await a.request('register', { sessionId: 'sa', provider: 'claude', cwd: base, own: true });
    await b.request('register', { sessionId: 'sb', provider: 'codex', cwd: base, own: true });
    await c.request('register', { sessionId: 'sc', provider: 'fable', cwd: base, own: true });

    const sent = await a.request('send', { to: '*', body: 'switching the schema in 5 minutes' });
    assert.equal(sent.delivered, 2);

    for (const client of [b, c]) {
      const inbox = await client.request('inbox');
      const messages = inbox.messages as Array<Record<string, unknown>>;
      assert.equal(messages.length, 1);
      assert.match(String(messages[0]?.body), /switching the schema/);
    }

    a.close();
    b.close();
    c.close();
  });
});

test('an agent that disconnects mid-ask does not strand the asker', async () => {
  await withDaemon(async (socketPath, base) => {
    const a = await MeshClient.open({ socketPath, autostart: false });
    const b = await MeshClient.open({ socketPath, autostart: false });
    assert.ok(a && b);

    await a.request('register', { sessionId: 'sa', provider: 'claude', cwd: base, own: true });
    await b.request('register', { sessionId: 'sb', provider: 'codex', cwd: base, own: true });
    await b.request('touch', { activity: 'working' });

    const asking = a.request('ask', { to: 'codex-1', body: 'still there?', timeoutMs: 400 });
    b.close();

    const res = await asking;
    assert.equal(res.ok, true);
    assert.equal(res.state, 'timeout', 'the asker gets a timeout, not a hang');

    a.close();
  });
});

test('the journal records the whole conversation for mesh log', async () => {
  await withDaemon(async (socketPath, base) => {
    const a = await MeshClient.open({ socketPath, autostart: false });
    const b = await MeshClient.open({ socketPath, autostart: false });
    assert.ok(a && b);

    await a.request('register', { sessionId: 'sa', provider: 'claude', cwd: base, own: true });
    await b.request('register', { sessionId: 'sb', provider: 'codex', cwd: base, own: true });
    await b.request('touch', { activity: 'busy' });

    const asking = a.request('ask', { to: 'codex-1', body: 'q?', timeoutMs: 3000 });
    const inbox = await b.request('inbox');
    const askId = (inbox.messages as Array<Record<string, unknown>>)[0]?.askId;
    await b.request('reply', { askId, body: 'a!' });
    await asking;

    const { Journal } = await import('../src/journal.ts');
    const { systemClock } = await import('../src/clock.ts');
    const kinds = new Journal(join(base, 'journal.jsonl'), systemClock).read().map((e) => e.kind);
    assert.ok(kinds.includes('register'), 'registrations are journaled');
    assert.ok(kinds.includes('ask'), 'asks are journaled');
    assert.ok(kinds.includes('reply'), 'replies are journaled');

    a.close();
    b.close();
  });
});
