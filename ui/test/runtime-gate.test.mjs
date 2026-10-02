import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

// Node and the CLI are downloaded on first launch (commands/runtime.rs); the
// renderer gates boot() on it.
const renderer = readFileSync('ui/renderer.js', 'utf8');
const html = readFileSync('ui/index.html', 'utf8');
const fnSrc = renderer.slice(renderer.indexOf('async function ensureRuntime()'), renderer.indexOf('async function boot()'));

test('boot() waits for the runtime before anything else', () => {
  const boot = renderer.slice(renderer.indexOf('async function boot()'));
  const at = boot.indexOf('await ensureRuntime()');
  assert.ok(at > -1, 'boot must call ensureRuntime');
  assert.ok(at < boot.indexOf('invoke('), 'no other command may run before the runtime is there');
  assert.ok(at < boot.indexOf('bridge.'), 'nothing may run the CLI before the runtime is there');
});

test('the runtime overlay says Preparing CodeMie, shows progress and offers Try again', () => {
  assert.match(html, /id="runtime-overlay"/);
  assert.match(html, /Preparing CodeMie…/);
  assert.match(html, /id="runtime-bar"/);
  assert.match(html, /id="runtime-error"/);
  assert.match(html, /id="runtime-retry"[^>]*>Try again</);
});

// A tiny DOM: just the classList/textContent/style/addEventListener the gate touches.
function fakeDom() {
  const els = {};
  const el = () => {
    const hidden = new Set(['hidden']);
    const listeners = {};
    return {
      textContent: '',
      style: {},
      classList: { add: (c) => hidden.add(c), remove: (c) => hidden.delete(c), has: (c) => hidden.has(c) },
      addEventListener: (ev, fn) => { listeners[ev] = fn; },
      click: () => listeners.click?.(),
      hasListener: () => !!listeners.click,
    };
  };
  return { getElementById: (id) => (els[id] ??= el()), els };
}

function gate(invoke, listen = async () => () => {}) {
  const document = fakeDom();
  // eslint-disable-next-line no-new-func
  const ensureRuntime = new Function('invoke', 'listen', 'document', `${fnSrc}; return ensureRuntime;`)(invoke, listen, document);
  return { ensureRuntime, document };
}

test('ensureRuntime does nothing when the runtime is ready (no overlay, no download)', async () => {
  const calls = [];
  const { ensureRuntime, document } = gate(async (cmd) => { calls.push(cmd); return true; });
  await ensureRuntime();
  assert.deepEqual(calls, ['runtime_ready']);
  assert.ok(document.getElementById('runtime-overlay').classList.has('hidden'));
});

test('ensureRuntime downloads once, then hides the overlay', async () => {
  const calls = [];
  const { ensureRuntime, document } = gate(async (cmd) => { calls.push(cmd); return cmd === 'runtime_ready' ? false : undefined; });
  await ensureRuntime();
  assert.deepEqual(calls, ['runtime_ready', 'ensure_runtime']);
  assert.ok(document.getElementById('runtime-overlay').classList.has('hidden'));
});

test('a failed download shows the error and Try again; clicking it retries and succeeds', async () => {
  let attempts = 0;
  const { ensureRuntime, document } = gate(async (cmd) => {
    if (cmd === 'runtime_ready') return false;
    if (++attempts === 1) throw new Error('offline');
    return undefined;
  });
  const done = ensureRuntime();
  const retry = document.getElementById('runtime-retry');
  for (let i = 0; i < 20 && !retry.hasListener(); i++) await new Promise((r) => setTimeout(r, 0));
  assert.ok(!retry.classList.has('hidden'), 'Try again is shown');
  assert.match(document.getElementById('runtime-error').textContent, /offline/);
  assert.ok(!document.getElementById('runtime-overlay').classList.has('hidden'), 'the gate stays up while it failed');
  retry.click();
  await done;
  assert.equal(attempts, 2);
  assert.ok(document.getElementById('runtime-overlay').classList.has('hidden'));
});
