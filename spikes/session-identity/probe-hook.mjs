import { record } from './probe-common.mjs';

const raw = await new Promise((resolve) => {
  let buffer = '';
  let done = false;
  const finish = () => {
    if (done) return;
    done = true;
    clearTimeout(timer);
    process.stdin.removeAllListeners();
    process.stdin.pause();
    process.stdin.destroy?.();
    resolve(buffer);
  };
  const timer = setTimeout(finish, 400);
  timer.unref?.();
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (chunk) => {
    buffer += chunk;
  });
  process.stdin.on('end', finish);
  process.stdin.on('error', finish);
});

let payloadSessionId = null;
let event = null;
try {
  const parsed = JSON.parse(raw);
  payloadSessionId = parsed.session_id ?? null;
  event = parsed.hook_event_name ?? null;
} catch {}

record('hook', { payloadSessionId, event });

// Exit from the write callback: a bare process.exit() truncates stdout.
await new Promise((resolve) => process.stdout.write('{}', () => resolve()));
