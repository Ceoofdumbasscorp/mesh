import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  MAX_BODY_BYTES,
  MAX_FRAME_BYTES,
  encodeFrame,
  createFrameDecoder,
} from '../src/protocol.ts';

test('body cap matches the constellation.js precedent of 4 KiB', () => {
  assert.equal(MAX_BODY_BYTES, 4096);
});

test('encodeFrame emits one newline-terminated JSON line', () => {
  const line = encodeFrame({ id: 1, op: 'ping' });
  assert.equal(line, '{"id":1,"op":"ping"}\n');
});

test('decodes a single complete frame', () => {
  const decode = createFrameDecoder();
  const out = decode('{"id":1,"op":"ping"}\n');
  assert.deepEqual(out, [{ id: 1, op: 'ping' }]);
});

test('decodes several frames arriving in one chunk', () => {
  const decode = createFrameDecoder();
  const out = decode('{"id":1}\n{"id":2}\n{"id":3}\n');
  assert.deepEqual(out, [{ id: 1 }, { id: 2 }, { id: 3 }]);
});

test('buffers a frame split across chunks', () => {
  const decode = createFrameDecoder();
  assert.deepEqual(decode('{"id":1,"op":'), []);
  assert.deepEqual(decode('"ping"}'), []);
  assert.deepEqual(decode('\n'), [{ id: 1, op: 'ping' }]);
});

test('accepts Buffer chunks as well as strings', () => {
  const decode = createFrameDecoder();
  const out = decode(Buffer.from('{"id":7}\n', 'utf8'));
  assert.deepEqual(out, [{ id: 7 }]);
});

test('skips blank lines rather than emitting undefined', () => {
  const decode = createFrameDecoder();
  const out = decode('\n\n{"id":1}\n\n');
  assert.deepEqual(out, [{ id: 1 }]);
});

test('throws on malformed JSON so the caller can close the connection', () => {
  const decode = createFrameDecoder();
  assert.throws(() => decode('not json\n'), /Malformed frame/);
});

test('throws when a single line exceeds the frame cap', () => {
  const decode = createFrameDecoder();
  const huge = 'x'.repeat(MAX_FRAME_BYTES + 1);
  assert.throws(() => decode(huge), /Frame exceeds/);
});

test('a decoder that threw stays unusable rather than resuming mid-frame', () => {
  const decode = createFrameDecoder();
  assert.throws(() => decode('bad\n'), /Malformed frame/);
  assert.throws(() => decode('{"id":1}\n'), /decoder is closed/);
});
