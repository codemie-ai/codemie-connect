import { test } from 'node:test';
import { strict as assert } from 'node:assert';

test('strips complete CSI sequence', async () => {
  const { default: s } = await import('../ansi-strip.mjs');
  assert.equal(s('\x1b[31mred\x1b[0m'), 'red');
});
test('strips complete OSC sequence', async () => {
  const { default: s } = await import('../ansi-strip.mjs');
  assert.equal(s('\x1b]0;title\x07text'), 'text');
});
test('leaves plain text unchanged', async () => {
  const { default: s } = await import('../ansi-strip.mjs');
  assert.equal(s('hello'), 'hello');
});
test('leaves partial escape at end of string unchanged', async () => {
  const { default: s } = await import('../ansi-strip.mjs');
  assert.equal(s('text\x1b[0'), 'text\x1b[0');
});
test('chunk boundary: partial artefact in chunk1, chunk2 processes independently', async () => {
  const { default: s } = await import('../ansi-strip.mjs');
  assert.equal(s('abc\x1b[3'), 'abc\x1b[3'); // partial preserved
  assert.equal(s('1mXYZ\x1b[0m'), '1mXYZ');  // chunk2: '1m' is plain text; '\x1b[0m' stripped
});
test('TextDecoder streams multi-byte UTF-8 split across two payloads', () => {
  const dec = new TextDecoder('utf-8', { fatal: false });
  const bytes1 = new Uint8Array([0xE2, 0x82]); // first 2 bytes of U+20AC '€'
  const bytes2 = new Uint8Array([0xAC]);
  assert.equal(dec.decode(bytes1, { stream: true }), '');
  assert.equal(dec.decode(bytes2, { stream: false }), '€');
});
