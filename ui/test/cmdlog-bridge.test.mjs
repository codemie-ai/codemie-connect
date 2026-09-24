import { test } from 'node:test';
import { strict as assert } from 'node:assert';

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

const { runner, pty, updater, cmdlog } = await import('../runner-bridge.js');

// ---- test 1: runStream invoke order ----
test('runStream: invoke order is cmdlog_open → run_stream, cmdlog_append per line, cmdlog_close with exit code', async () => {
  const calls = [];
  let streamCb;
  listenImpl = async (evt, cb) => {
    if (evt === 'engine:cmd-line') streamCb = cb;
    return () => {};
  };
  invokeImpl = async (cmd, args) => {
    calls.push({ cmd, args });
    if (cmd === 'run_stream') {
      // fire a synthetic line event
      streamCb?.({ payload: { id: args.streamId, text: 'hello', tag: 'stdout' } });
      return 42;
    }
    if (cmd === 'cmdlog_open') return 'log-1';
    return null;
  };

  await runner.runStream('echo hi');

  const cmds = calls.map(c => c.cmd);
  assert.ok(cmds.indexOf('cmdlog_open') < cmds.indexOf('run_stream'), 'cmdlog_open must precede run_stream');
  assert.ok(cmds.indexOf('run_stream') < cmds.indexOf('cmdlog_append'), 'run_stream must precede cmdlog_append');
  assert.ok(cmds.indexOf('cmdlog_append') < cmds.indexOf('cmdlog_close'), 'cmdlog_append must precede cmdlog_close');

  const closeCall = calls.find(c => c.cmd === 'cmdlog_close');
  assert.equal(closeCall?.args?.exitCode, 42, 'cmdlog_close must receive stream exit code');
  const appendCall = calls.find(c => c.cmd === 'cmdlog_append');
  assert.equal(appendCall?.args?.chunk, 'hello', 'cmdlog_append must receive line text');
});

// ---- test 2: runCapture invoke order ----
test('runCapture: invoke order is cmdlog_open → run_capture → cmdlog_append(result) → cmdlog_close(0)', async () => {
  const calls = [];
  listenImpl = async () => () => {};
  invokeImpl = async (cmd, args) => {
    calls.push({ cmd, args });
    if (cmd === 'run_capture') return 'capture-output';
    if (cmd === 'cmdlog_open') return 'log-2';
    return null;
  };

  await runner.runCapture('ls');

  const cmds = calls.map(c => c.cmd);
  assert.ok(cmds.indexOf('cmdlog_open') < cmds.indexOf('run_capture'), 'cmdlog_open must precede run_capture');
  assert.ok(cmds.indexOf('run_capture') < cmds.indexOf('cmdlog_append'), 'run_capture must precede cmdlog_append');
  assert.ok(cmds.indexOf('cmdlog_append') < cmds.indexOf('cmdlog_close'), 'cmdlog_append must precede cmdlog_close');

  const appendCall = calls.find(c => c.cmd === 'cmdlog_append');
  assert.equal(appendCall?.args?.chunk, 'capture-output', 'cmdlog_append must receive capture result');
  const closeCall = calls.find(c => c.cmd === 'cmdlog_close');
  assert.equal(closeCall?.args?.exitCode, 0, 'cmdlog_close must receive exitCode 0');
});

// ---- test 3: runFreshEnv invoke order ----
test('runFreshEnv: invoke order is cmdlog_open → run_fresh_env → cmdlog_append(result) → cmdlog_close(0)', async () => {
  const calls = [];
  listenImpl = async () => () => {};
  invokeImpl = async (cmd, args) => {
    calls.push({ cmd, args });
    if (cmd === 'run_fresh_env') return 'fresh-output';
    if (cmd === 'cmdlog_open') return 'log-3';
    return null;
  };

  await runner.runFreshEnv('node -v');

  const cmds = calls.map(c => c.cmd);
  assert.ok(cmds.indexOf('cmdlog_open') < cmds.indexOf('run_fresh_env'), 'cmdlog_open must precede run_fresh_env');
  assert.ok(cmds.indexOf('run_fresh_env') < cmds.indexOf('cmdlog_append'), 'run_fresh_env must precede cmdlog_append');
  assert.ok(cmds.indexOf('cmdlog_append') < cmds.indexOf('cmdlog_close'), 'cmdlog_append must precede cmdlog_close');

  const appendCall = calls.find(c => c.cmd === 'cmdlog_append');
  assert.equal(appendCall?.args?.chunk, 'fresh-output', 'cmdlog_append must receive fresh-env result');
  const closeCall = calls.find(c => c.cmd === 'cmdlog_close');
  assert.equal(closeCall?.args?.exitCode, 0, 'cmdlog_close must receive exitCode 0');
});

// ---- test 4: spawnPty with onData — cmdlog records decoded+stripped output ----
test('spawnPty with onData: cmdlog_append receives decoded+ANSI-stripped text; onData receives original base64', async () => {
  const calls = [];
  const listeners = {};
  listenImpl = async (evt, cb) => {
    (listeners[evt] ??= []).push(cb);
    return () => {};
  };
  invokeImpl = async (cmd, args) => {
    calls.push({ cmd, args });
    if (cmd === 'cmdlog_open') return 'log-4';
    if (cmd === 'spawn_pty') {
      const id = args.runId;
      // fire pty-data with base64-encoded ANSI string
      const raw = '\x1b[31mhi\x1b[0m';
      const b64 = btoa(raw);
      listeners['engine:pty-data']?.forEach(cb => cb({ payload: { id, data: b64 } }));
      // fire pty-exit
      listeners['engine:pty-exit']?.forEach(cb => cb({ payload: { id, code: 0 } }));
      return id;
    }
    return null;
  };

  const received = [];
  await pty.spawnPty('echo hi', 80, 24, d => received.push(d));

  // onData receives original base64
  const raw = '\x1b[31mhi\x1b[0m';
  assert.deepEqual(received, [btoa(raw)], 'onData must receive original base64');

  // cmdlog_append receives decoded + stripped
  const appendCall = calls.find(c => c.cmd === 'cmdlog_append');
  assert.ok(appendCall, 'cmdlog_append must be called');
  assert.equal(appendCall.args.chunk, 'hi', 'cmdlog_append must receive decoded+stripped text');

  // cmdlog_close receives exit code 0
  const closeCall = calls.find(c => c.cmd === 'cmdlog_close');
  assert.ok(closeCall, 'cmdlog_close must be called');
  assert.equal(closeCall.args.exitCode, 0, 'cmdlog_close must receive exit code 0');
});

// ---- test 5: spawnPty with onData=undefined — cmdlog behavior identical ----
test('spawnPty without onData: cmdlog_append still receives decoded+stripped text', async () => {
  const calls = [];
  const listeners = {};
  listenImpl = async (evt, cb) => {
    (listeners[evt] ??= []).push(cb);
    return () => {};
  };
  invokeImpl = async (cmd, args) => {
    calls.push({ cmd, args });
    if (cmd === 'cmdlog_open') return 'log-5';
    if (cmd === 'spawn_pty') {
      const id = args.runId;
      const raw = '\x1b[31mhi\x1b[0m';
      const b64 = btoa(raw);
      listeners['engine:pty-data']?.forEach(cb => cb({ payload: { id, data: b64 } }));
      listeners['engine:pty-exit']?.forEach(cb => cb({ payload: { id, code: 0 } }));
      return id;
    }
    return null;
  };

  await pty.spawnPty('echo hi', 80, 24, undefined);

  const appendCall = calls.find(c => c.cmd === 'cmdlog_append');
  assert.ok(appendCall, 'cmdlog_append must be called even without onData');
  assert.equal(appendCall.args.chunk, 'hi', 'cmdlog_append must receive decoded+stripped text');

  const closeCall = calls.find(c => c.cmd === 'cmdlog_close');
  assert.equal(closeCall?.args?.exitCode, 0, 'cmdlog_close must receive exit code 0');
});

// ---- test 6: runSelfUpdate — cmdlog_open fires before run_self_update; close gets correct code ----
test('runSelfUpdate resolve path: cmdlog_open before run_self_update; cmdlog_close(0)', async () => {
  const calls = [];
  listenImpl = async () => () => {};
  invokeImpl = async (cmd, args) => {
    calls.push({ cmd, args });
    if (cmd === 'cmdlog_open') return 'log-6a';
    if (cmd === 'run_self_update') return 'v2.0';
    return null;
  };

  await updater.runSelfUpdate();

  const cmds = calls.map(c => c.cmd);
  assert.ok(cmds.indexOf('cmdlog_open') < cmds.indexOf('run_self_update'), 'cmdlog_open must precede run_self_update');
  const closeCall = calls.find(c => c.cmd === 'cmdlog_close');
  assert.equal(closeCall?.args?.exitCode, 0, 'cmdlog_close must receive exitCode 0 on success');
});

// ---- test CR-006: null result skipped, non-null coerced to String ----
test('runCapture: null result skips cmdlog_append; String result is coerced', async () => {
  // null result — no append expected
  const calls = [];
  listenImpl = async () => () => {};
  invokeImpl = async (cmd, args) => {
    calls.push({ cmd, args });
    if (cmd === 'run_capture') return null;
    if (cmd === 'cmdlog_open') return 'log-cr6a';
    return null;
  };
  await runner.runCapture('ls');
  assert.ok(!calls.find(c => c.cmd === 'cmdlog_append'), 'no append for null result');

  // numeric result — coerced to String
  const calls2 = [];
  invokeImpl = async (cmd, args) => {
    calls2.push({ cmd, args });
    if (cmd === 'run_capture') return 42;
    if (cmd === 'cmdlog_open') return 'log-cr6b';
    return null;
  };
  await runner.runCapture('echo 42');
  const appendCall = calls2.find(c => c.cmd === 'cmdlog_append');
  assert.ok(appendCall, 'append must fire for non-null result');
  assert.equal(typeof appendCall.args.chunk, 'string', 'chunk must be a string');
  assert.equal(appendCall.args.chunk, '42', 'chunk must be String(result)');
});

// ---- test CR-007: close waits for in-flight appends ----
test('runStream: cmdlog_close does not fire until all pending appends resolve', async () => {
  const order = [];
  let streamCb;
  let resolveAppend;
  const appendP = new Promise(r => { resolveAppend = r; });
  listenImpl = async (evt, cb) => {
    if (evt === 'engine:cmd-line') streamCb = cb;
    return () => {};
  };
  invokeImpl = async (cmd, args) => {
    if (cmd === 'cmdlog_open') return 'log-cr7';
    if (cmd === 'cmdlog_append') {
      order.push('append-start');
      await appendP;
      order.push('append-done');
      return null;
    }
    if (cmd === 'cmdlog_close') { order.push('close'); return null; }
    if (cmd === 'run_stream') {
      streamCb?.({ payload: { id: args.streamId, text: 'line', tag: 'stdout' } });
      return 0;
    }
    return null;
  };
  const p = runner.runStream('cmd');
  await Promise.resolve(); // yield so run_stream starts and append suspends
  resolveAppend();
  await p;
  assert.ok(order.indexOf('append-done') < order.indexOf('close'), 'append-done must precede close');
});

// ---- test CR-008: pty.kill resolves spawnPty via kill sentinel ----
test('spawnPty: pty.kill() resolves exitP when engine:pty-exit never fires', async () => {
  const calls = [];
  const listeners = {};
  listenImpl = async (evt, cb) => {
    (listeners[evt] ??= []).push(cb);
    return () => {};
  };
  invokeImpl = async (cmd, args) => {
    calls.push({ cmd, args });
    if (cmd === 'cmdlog_open') return 'log-cr8';
    if (cmd === 'spawn_pty') return args.runId; // no pty-exit fired
    return null;
  };

  const spawnPromise = pty.spawnPty('bash', 80, 24);
  await Promise.resolve(); // let spawn start and reach await exitP
  await pty.kill();        // should resolve killP with -1
  const result = await spawnPromise;
  assert.equal(result.code, -1, 'kill path must yield exit code -1');
  const closeCall = calls.find(c => c.cmd === 'cmdlog_close');
  assert.ok(closeCall, 'cmdlog_close must be called after kill');
  assert.equal(closeCall.args.exitCode, -1, 'cmdlog_close must receive -1');
});

test('runSelfUpdate rejection path: cmdlog_open before run_self_update; cmdlog_close(-1)', async () => {
  const calls = [];
  listenImpl = async () => () => {};
  invokeImpl = async (cmd, args) => {
    calls.push({ cmd, args });
    if (cmd === 'cmdlog_open') return 'log-6b';
    if (cmd === 'run_self_update') throw new Error('update failed');
    return null;
  };

  await assert.rejects(() => updater.runSelfUpdate(), /update failed/);

  const cmds = calls.map(c => c.cmd);
  assert.ok(cmds.indexOf('cmdlog_open') < cmds.indexOf('run_self_update'), 'cmdlog_open must precede run_self_update');
  const closeCall = calls.find(c => c.cmd === 'cmdlog_close');
  assert.equal(closeCall?.args?.exitCode, -1, 'cmdlog_close must receive exitCode -1 on failure');
});

test('cmdlog.list: invokes cmdlog_list', async () => {
  let calledCmd;
  invokeImpl = async (cmd) => { calledCmd = cmd; return []; };
  const result = await cmdlog.list();
  assert.equal(calledCmd, 'cmdlog_list');
  assert.deepEqual(result, []);
});

test('cmdlog.get: invokes cmdlog_get with { id }', async () => {
  let calledCmd, calledArgs;
  invokeImpl = async (cmd, args) => { calledCmd = cmd; calledArgs = args; return null; };
  await cmdlog.get('abc-123');
  assert.equal(calledCmd, 'cmdlog_get');
  assert.equal(calledArgs?.id, 'abc-123');
});

// ---- CR-010: runStream strips ANSI before appending ----
test('runStream: cmdlog_append receives ANSI-stripped text', async () => {
  const calls = [];
  let streamCb;
  listenImpl = async (evt, cb) => {
    if (evt === 'engine:cmd-line') streamCb = cb;
    return () => {};
  };
  invokeImpl = async (cmd, args) => {
    calls.push({ cmd, args });
    if (cmd === 'cmdlog_open') return 'log-ansi';
    if (cmd === 'run_stream') {
      streamCb?.({ payload: { id: args.streamId, text: '\x1b[31mred\x1b[0m', tag: 'stdout' } });
      return 0;
    }
    return null;
  };
  await runner.runStream('echo red');
  const appendCall = calls.find(c => c.cmd === 'cmdlog_append');
  assert.ok(appendCall, 'cmdlog_append must be called');
  assert.equal(appendCall.args.chunk, 'red', 'chunk must have ANSI stripped');
});

// ---- CR-011: spawnPty close waits for in-flight appends ----
test('spawnPty: cmdlog_close does not fire until all pending pty appends resolve', async () => {
  const order = [];
  const listeners = {};
  let resolveAppend;
  const appendP = new Promise(r => { resolveAppend = r; });
  listenImpl = async (evt, cb) => {
    (listeners[evt] ??= []).push(cb);
    return () => {};
  };
  invokeImpl = async (cmd, args) => {
    if (cmd === 'cmdlog_open') return 'log-pty-order';
    if (cmd === 'cmdlog_append') {
      order.push('append-start');
      await appendP;
      order.push('append-done');
      return null;
    }
    if (cmd === 'cmdlog_close') { order.push('close'); return null; }
    if (cmd === 'spawn_pty') {
      const id = args.runId;
      const raw = 'hi';
      const b64 = btoa(raw);
      listeners['engine:pty-data']?.forEach(cb => cb({ payload: { id, data: b64 } }));
      listeners['engine:pty-exit']?.forEach(cb => cb({ payload: { id, code: 0 } }));
      return id;
    }
    return null;
  };
  const p = pty.spawnPty('echo hi', 80, 24);
  await Promise.resolve();
  resolveAppend();
  await p;
  assert.ok(order.indexOf('append-done') < order.indexOf('close'), 'append-done must precede close');
});
