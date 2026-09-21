import { test } from 'node:test';
import assert from 'node:assert/strict';

const calls = [];
globalThis.window = { __TAURI__: { core: { invoke: (...a) => { calls.push(a); return Promise.resolve(); } } } };

const { suspendPtyInput, resumePtyInput, __forwardOnData } = await import('../terminal.js');

test('onData forwarding is suspended and restored', () => {
  __forwardOnData('a');
  assert.equal(calls.length, 1, 'forwards while active');
  suspendPtyInput();
  __forwardOnData('b');
  assert.equal(calls.length, 1, 'suspended: no new invoke call');
  resumePtyInput();
  __forwardOnData('c');
  assert.equal(calls.length, 2, 'resumed: forwards again');
});
