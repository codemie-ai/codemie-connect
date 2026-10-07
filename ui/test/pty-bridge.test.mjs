import { test } from 'node:test';
import assert from 'node:assert/strict';

// ES modules are cached after the first import, so `listen` and `invoke` are
// bound once at module-init time.  Use mutable delegates so each test can
// inject its own behaviour without re-importing.
let listenImpl = async () => () => {};
let invokeImpl = async () => null;

globalThis.window = {
  __TAURI__: {
    core: { invoke: async (cmd, args) => invokeImpl(cmd, args) },
    event: { listen: async (evt, cb) => listenImpl(evt, cb) },
  },
};

const { pty, inspector, updater } = await import('../runner-bridge.js');

test('spawnPty resolves only on its own id and onData filters by id', async () => {
  const listeners = {};
  const invocations = [];
  listenImpl = async (evt, cb) => {
    (listeners[evt] ??= []).push(cb);
    return () => {};
  };
  invokeImpl = async (cmd, args) => {
    invocations.push({ cmd, args });
    return args?.runId ?? null; // echo back the id the bridge generated
  };

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

// CR-005: when listen('engine:pty-exit') throws after listen('engine:pty-data')
// has already succeeded, the data unlisten function must still be called.
// Mutation check: reverting the fix (dataUnlisten registered outside try) means
// the finally block is never entered and dataUnlistenCalled stays false.
test('CR-005: data listener is cleaned up when exit-listen throws', async () => {
  let dataUnlistenCalled = false;
  listenImpl = async (evt, _cb) => {
    if (evt === 'engine:pty-data') {
      return () => { dataUnlistenCalled = true; };
    }
    if (evt === 'engine:pty-exit') {
      throw new Error('simulated exit-listen failure');
    }
    return () => {};
  };
  invokeImpl = async () => null;

  await assert.rejects(
    () => pty.spawnPty('echo hi', 80, 24, () => {}),
    /simulated exit-listen failure/,
    'spawnPty must reject when exit-listen throws',
  );

  assert.ok(
    dataUnlistenCalled,
    'data listener must be unlistened even when the exit-listen call throws',
  );
});

// Commands Rust runs itself (profile status) are recorded in the command log
// with their outcome; a rejection is recorded as failed (-1).
test('commands Rust runs itself reach the command log, with their outcome', async () => {
  const calls = [];
  invokeImpl = async (cmd, args) => {
    calls.push([cmd, args]);
    if (cmd === 'cmdlog_open') return 'cmd-1';
    if (cmd === 'check_profile_status') return { state: 'unknown', detail: '', code: 1 };
    return null;
  };
  await inspector.checkProfileStatus();
  invokeImpl = async (cmd, args) => {
    calls.push([cmd, args]);
    if (cmd === 'cmdlog_open') return 'cmd-2';
    if (cmd === 'check_profile_status') throw new Error('ipc failed');
    return null;
  };
  await assert.rejects(inspector.checkProfileStatus());
  const log = calls.filter(([c]) => c.startsWith('cmdlog_'));
  assert.deepEqual(log, [
    ['cmdlog_open', { command: 'codemie profile status' }],
    ['cmdlog_close', { id: 'cmd-1', exitCode: 1 }],
    ['cmdlog_open', { command: 'codemie profile status' }],
    ['cmdlog_close', { id: 'cmd-2', exitCode: -1 }],
  ]);
});

// EPMCDME-15342: About forces the app update check past the 24h throttle; the
// boot check does not. Tauri reads the `force` key, so its name matters.
test('checkForAppUpdate sends force to check_for_update, false by default', async () => {
  const invocations = [];
  invokeImpl = async (cmd, args) => {
    invocations.push({ cmd, args });
    return null;
  };
  await updater.checkForAppUpdate(true);
  await updater.checkForAppUpdate();
  assert.deepEqual(invocations, [
    { cmd: 'check_for_update', args: { force: true } },
    { cmd: 'check_for_update', args: { force: false } },
  ]);
});
