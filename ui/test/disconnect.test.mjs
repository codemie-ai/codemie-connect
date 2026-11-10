import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseDisconnect } from '../disconnect.js';

const cases = [
  ['success', { code: 0, stdout: '✓ Claude Desktop disconnected\n', stderr: '' }, 'disconnected'],
  ['ansi success', { code: 0, stdout: '\x1b[32m✓ Claude Desktop disconnected\x1b[0m\n', stderr: '' }, 'disconnected'],
  ['already', { code: 0, stdout: 'Claude Desktop: nothing to disconnect\n', stderr: '' }, 'nothing'],
  ['old CLI target list', { code: 0, stdout: 'Targets:\n  desktop\n', stderr: '' }, 'unknown'],
];
for (const [name, input, kind] of cases) {
  test(`parseDisconnect: ${name}`, () => assert.equal(parseDisconnect(input).kind, kind));
}

test('parseDisconnect: failure takes the CLI message', () => {
  const r = parseDisconnect({ code: 1, stdout: '\x1b[31m✗ Claude Desktop — config is locked\x1b[0m\n', stderr: '' });
  assert.deepEqual(r, { kind: 'failed', message: 'config is locked' });
});

test('parseDisconnect: failure falls back to stderr, then stdout', () => {
  assert.equal(parseDisconnect({ code: 2, stdout: 'x', stderr: ' boom \n' }).message, 'boom');
  assert.equal(parseDisconnect({ code: 2, stdout: ' out ', stderr: '' }).message, 'out');
});
