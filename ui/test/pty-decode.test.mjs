import test from 'node:test';
import assert from 'node:assert/strict';
import { createPtyDecoder } from '../pty-decode.js';

const b64 = (bytes) => Buffer.from(bytes).toString('base64');

test('createPtyDecoder keeps a multi-byte character split across chunks', () => {
  const decode = createPtyDecoder();
  const a = decode(b64([0xe2, 0x9c]));
  const b = decode(b64([0x97]));
  assert.equal(a + b, '✗');
});

test('createPtyDecoder decodes plain ASCII chunks', () => {
  const decode = createPtyDecoder();
  assert.equal(decode(b64(Buffer.from('hello'))), 'hello');
});
