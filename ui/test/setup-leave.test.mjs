import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { stopSetupOnLeave } from '../setup-leave.js';

function fakes(running) {
  const calls = [];
  let release;
  const settled = new Promise((r) => { release = r; });
  return {
    calls,
    release,
    deps: {
      running,
      cancel: async () => { calls.push('cancel'); return true; },
      settled: () => settled.then(() => calls.push('settled')),
    },
  };
}

test('leaving setup while a run is open cancels it and waits for it to unwind', async () => {
  const f = fakes(true);
  const stopping = stopSetupOnLeave('setup', 'health', f.deps);
  assert.ok(stopping);
  let done = false;
  stopping.then(() => { done = true; });
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(f.calls, ['cancel']);
  assert.equal(done, false, 'must not resolve before the run has unwound');
  f.release();
  await stopping;
  assert.deepEqual(f.calls, ['cancel', 'settled']);
});

test('nothing is stopped when no run is open, when staying on setup, or when not on setup', () => {
  for (const [from, to, running] of [
    ['setup', 'home', false],
    ['setup', 'setup', true],
    ['home', 'health', true],
    [null, 'setup', true],
  ]) {
    const f = fakes(running);
    assert.equal(stopSetupOnLeave(from, to, f.deps), null, `${from} -> ${to}`);
    assert.deepEqual(f.calls, []);
  }
});

test('a cancel that throws still waits for the run to settle', async () => {
  const f = fakes(true);
  f.deps.cancel = async () => { throw new Error('boom'); };
  f.release();
  await stopSetupOnLeave('setup', 'home', f.deps);
  assert.deepEqual(f.calls, ['settled']);
});

// The renderer wiring: every view change goes through the check, and the next
// "Set up again" waits for the stop before start() (or start() would hand back
// the old run and reopen on the question where the user left).
test('renderer: showView stops a left setup run and openGuidedSetup waits for it', () => {
  const renderer = readFileSync('ui/renderer.js', 'utf8');
  const showView = renderer.slice(renderer.indexOf('function showView('));
  assert.match(showView.slice(0, 600), /stopSetupOnLeave\(/);
  const open = renderer.slice(renderer.indexOf('async function openGuidedSetup('));
  const body = open.slice(0, open.indexOf('return setupView.start()'));
  assert.match(body, /await setupStopping/);
});
