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
test('strips ST-terminated OSC sequence (ESC backslash terminator)', async () => {
  const { default: s } = await import('../ansi-strip.mjs');
  // OSC title set terminated by ST (\x1b\) instead of BEL
  assert.equal(s('\x1b]0;title\x1b\\text'), 'text');
});
test('strips DEC-private CSI sequence \\x1b[?25h (cursor hide)', async () => {
  const { default: s } = await import('../ansi-strip.mjs');
  assert.equal(s('\x1b[?25htext'), 'text');
});
test('strips DEC-private CSI sequence \\x1b[>0c', async () => {
  const { default: s } = await import('../ansi-strip.mjs');
  assert.equal(s('\x1b[>0ctext'), 'text');
});
test('strips DEC-private CSI sequence \\x1b[!p (soft reset)', async () => {
  const { default: s } = await import('../ansi-strip.mjs');
  assert.equal(s('\x1b[!ptext'), 'text');
});
test('TextDecoder streams multi-byte UTF-8 split across two payloads', () => {
  const dec = new TextDecoder('utf-8', { fatal: false });
  const bytes1 = new Uint8Array([0xE2, 0x82]); // first 2 bytes of U+20AC '€'
  const bytes2 = new Uint8Array([0xAC]);
  assert.equal(dec.decode(bytes1, { stream: true }), '');
  assert.equal(dec.decode(bytes2, { stream: false }), '€');
});
test('normalises "\\r\\n" to "\\n" and keeps consecutive newlines (blank lines)', async () => {
  const { default: s } = await import('../ansi-strip.mjs');
  assert.equal(s('a\r\n\r\n\r\nb'), 'a\n\n\nb');
});
test('converts cursor-next-line escape (\\x1b[nE) to n newlines instead of deleting it', async () => {
  const { default: s } = await import('../ansi-strip.mjs');
  assert.equal(s('a\x1b[2Eb'), 'a\n\nb');
  assert.equal(s('a\x1b[Eb'), 'a\nb'); // omitted param defaults to 1
});
test('converts cursor-down escape (\\x1b[nB) to n newlines instead of deleting it', async () => {
  const { default: s } = await import('../ansi-strip.mjs');
  assert.equal(s('a\x1b[1Bb'), 'a\nb');
});
test('EPMCDME-15232: PTY record with ANSI colour and CRLF endings keeps every blank line and line break', async () => {
  const { default: s } = await import('../ansi-strip.mjs');
  // Raw PTY bytes: normal lines end "\r\n" (terminal ONLCR); blank-line gaps
  // are produced by the CLI's cursor-next-line escape rather than literal "\n".
  const raw =
    'Current active profile: "\x1b[32mpersonal-sub\x1b[0m" (provider: anthropic-subscription)\r\n' +
    '\x1b[2E' +
    'Next step:\r\n' +
    '  codemie profile switch <codemie-profile>\r\n' +
    '  codemie proxy connect --claude-desktop\r\n' +
    '\x1b[1E' +
    'Or run once with a specific profile:\r\n' +
    '  codemie proxy connect --claude-desktop --profile <codemie-profile>\r\n' +
    '\x1b[1E' +
    'Profiles to try:\r\n' +
    '- default\r\n';
  const expected =
    'Current active profile: "personal-sub" (provider: anthropic-subscription)\n' +
    '\n\n' +
    'Next step:\n' +
    '  codemie profile switch <codemie-profile>\n' +
    '  codemie proxy connect --claude-desktop\n' +
    '\n' +
    'Or run once with a specific profile:\n' +
    '  codemie proxy connect --claude-desktop --profile <codemie-profile>\n' +
    '\n' +
    'Profiles to try:\n' +
    '- default\n';
  assert.equal(s(raw), expected);
});
