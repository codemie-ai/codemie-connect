import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeHandlers } from '../handlers.js';

function fakeCtx(step) {
  const subtitles = [];
  const lines = [];
  return {
    step,
    setSubtitle: (id, text) => subtitles.push({ id, text }),
    line: (text, tag) => lines.push({ text, tag }),
    emit: () => {},
    subtitles,
    lines,
  };
}

test('2.3.5 on Windows dispatches to runExternalWindow, not runPty', async () => {
  const calls = { spawnPs: [], spawnPty: [] };
  const handlers = makeHandlers({
    platform: { os: 'windows', arch: 'x86_64' },
    externalWindow: { spawnPs: async (cmd) => { calls.spawnPs.push(cmd); return 0; } },
    pty: { spawnPty: async (cmd) => { calls.spawnPty.push(cmd); return { code: 0 }; } },
  });
  const ctx = fakeCtx({ id: '2.3.5', title: 'Install Claude Code engine' });
  const ok = await handlers['2.3.5'](ctx);
  assert.equal(ok, true);
  assert.deepEqual(calls.spawnPs, ['codemie install claude --supported']);
  assert.deepEqual(calls.spawnPty, [], 'must not fall through to the embedded PTY path on Windows');
});

test('runExternalWindow names the step title and exit code on non-zero exit', async () => {
  const handlers = makeHandlers({
    platform: { os: 'windows', arch: 'x86_64' },
    externalWindow: { spawnPs: async () => 1 },
    pty: { spawnPty: async () => ({ code: 0 }) },
  });
  const ctx = fakeCtx({ id: '2.3.5', title: 'Install Claude Code engine' });
  const ok = await handlers['2.3.5'](ctx);
  assert.equal(ok, false);
  const last = ctx.subtitles.at(-1);
  assert.match(last.text, /Install Claude Code engine/);
  assert.match(last.text, /exit 1/);
});

test('runExternalWindow names the step title when the window fails to open', async () => {
  const handlers = makeHandlers({
    platform: { os: 'windows', arch: 'x86_64' },
    externalWindow: { spawnPs: async () => { throw new Error('boom'); } },
    pty: { spawnPty: async () => ({ code: 0 }) },
  });
  const ctx = fakeCtx({ id: '2.3.3', title: 'Configure CodeMie' });
  const ok = await handlers['2.3.3'](ctx);
  assert.equal(ok, false);
  const last = ctx.subtitles.at(-1);
  assert.match(last.text, /Configure CodeMie/);
  assert.match(last.text, /boom/);
});
