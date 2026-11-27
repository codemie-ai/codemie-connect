import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { withAppOrigin } from '../workspace/app-invoke.js';

function recorder() {
  const calls = [];
  const raw = async (...args) => {
    calls.push(args);
    return 'ok';
  };
  return { calls, raw };
}

test('every call carries the page origin as an Origin header', async () => {
  const { calls, raw } = recorder();
  const invoke = withAppOrigin(raw, 'tauri://localhost');
  assert.equal(await invoke('workspace_request', { request: { op: 'snapshot' } }), 'ok');
  assert.deepEqual(calls, [['workspace_request', { request: { op: 'snapshot' } }, { headers: { Origin: 'tauri://localhost' } }]]);
});

test('the origin header keeps other options and headers, and wins over a caller-chosen one', async () => {
  const { calls, raw } = recorder();
  const invoke = withAppOrigin(raw, 'tauri://localhost');
  await invoke('storage_status', undefined, { headers: { 'X-Trace': '1', Origin: 'null' }, other: true });
  assert.deepEqual(calls[0], ['storage_status', undefined, { other: true, headers: { 'X-Trace': '1', Origin: 'tauri://localhost' } }]);
});

test('errors from the native call reach the caller unchanged', async () => {
  const failure = { code: 'permission_required', message: "Only Connect's own page can do this." };
  const invoke = withAppOrigin(async () => { throw failure; }, 'tauri://localhost');
  await assert.rejects(invoke('storage_status'), (e) => e === failure);
});

test('the workspace builds its invoke with the page origin', () => {
  const app = readFileSync(new URL('../workspace/app.js', import.meta.url), 'utf8');
  assert.match(app, /const appInvoke = rawInvoke && withAppOrigin\(rawInvoke, location\.origin\);/);
  // Every call goes through it; a tour build only puts its gate in front (tour/runner.js `gate`).
  assert.match(app, /const invoke = appInvoke && \(\(cmd, args, options\) => \(tourGated \|\| appInvoke\)\(cmd, args, options\)\);/);
});
