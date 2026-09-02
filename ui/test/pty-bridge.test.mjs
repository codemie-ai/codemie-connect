import { test } from 'node:test';
import assert from 'node:assert/strict';

test('spawnPty resolves only on its own id and onData filters by id', async () => {
  const listeners = {};
  const invocations = [];
  const fakeListen = async (evt, cb) => {
    (listeners[evt] ??= []).push(cb);
    return () => {};
  };
  const fakeInvoke = async (cmd, args) => {
    invocations.push({ cmd, args });
    return args?.runId ?? null; // echo back the id the bridge generated
  };
  globalThis.window = {
    __TAURI__: { core: { invoke: fakeInvoke }, event: { listen: fakeListen } }
  };
  const { pty } = await import('../runner-bridge.js');

  const received = [];
  const p = pty.spawnPty('echo hi', 80, 24, d => received.push(d));
  // Yield so spawnPty can register its listeners before we fire events
  await new Promise(r => setTimeout(r, 0));

  const id = invocations.find(i => i.cmd === 'spawn_pty')?.args?.runId;
  assert.ok(id, 'spawn_pty must be invoked with a runId');

  // Wrong-id data must NOT reach onData
  listeners['engine:pty-data']?.forEach(cb => cb({ payload: { id: 'pty-other', data: 'noise' } }));
  // Correct-id data must reach onData
  listeners['engine:pty-data']?.forEach(cb => cb({ payload: { id, data: 'signal' } }));
  // Wrong-id exit must NOT resolve the promise
  listeners['engine:pty-exit']?.forEach(cb => cb({ payload: { id: 'pty-other', code: 99 } }));
  await new Promise(r => setTimeout(r, 10));
  // Correct-id exit resolves
  listeners['engine:pty-exit']?.forEach(cb => cb({ payload: { id, code: 0 } }));

  const result = await p;
  assert.deepEqual(received, ['signal'], 'onData must only deliver data for own id');
  assert.deepEqual(result, { code: 0, id }, 'spawnPty must resolve with { code, id }');
});
