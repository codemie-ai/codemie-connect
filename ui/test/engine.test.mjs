// Ported from the Electron app's test/engine.test.js to ESM (node --test).
// The orchestration engine is reused verbatim under Option B, so its unit tests carry over.
import test from 'node:test';
import assert from 'node:assert';
import { Engine } from '../engine.js';

function mkSteps() {
  return [
    { id: 'a', title: 'A', status: 'PENDING', requires_approval: false, fatal: true, is_sub_step: false, spinner: false },
    { id: 'b', title: 'B', status: 'PENDING', requires_approval: true, fatal: false, is_sub_step: false, spinner: false },
    { id: 'c', title: 'C', status: 'PENDING', requires_approval: false, fatal: false, is_sub_step: false, spinner: false },
  ];
}

test('runs steps in order and completes', async () => {
  const order = [];
  const events = [];
  const e = new Engine({
    steps: mkSteps(),
    handlers: {
      a: async () => { order.push('a'); return true; },
      b: async () => { order.push('b'); return true; },
      c: async () => { order.push('c'); return true; },
    },
    emit: (ev, p) => events.push([ev, p]),
    isUnattended: () => true,
  });
  await e.run();
  assert.deepStrictEqual(order, ['a', 'b', 'c']);
  assert.ok(events.some(([ev]) => ev === 'complete'));
});

test('fatal failure halts and marks remaining SKIPPED', async () => {
  const events = [];
  const steps = mkSteps();
  const e = new Engine({
    steps,
    handlers: { a: async () => false, b: async () => true, c: async () => true },
    emit: (ev, p) => events.push([ev, p]),
    isUnattended: () => true,
  });
  await e.run();
  assert.strictEqual(steps.find((s) => s.id === 'a').status, 'ERROR');
  assert.strictEqual(steps.find((s) => s.id === 'b').status, 'SKIPPED');
  assert.strictEqual(steps.find((s) => s.id === 'c').status, 'SKIPPED');
  assert.ok(events.some(([ev]) => ev === 'fatal'));
  assert.ok(!events.some(([ev]) => ev === 'complete'));
});

test('approval gate: ignore() skips the step', async () => {
  const ran = [];
  const e = new Engine({
    steps: mkSteps(),
    handlers: {
      a: async () => { ran.push('a'); return true; },
      b: async () => { ran.push('b'); return true; },
      c: async () => { ran.push('c'); return true; },
    },
    emit: () => {},
    isUnattended: () => false,
  });
  const p = e.run();
  await new Promise((r) => setTimeout(r, 10));
  e.ignore();
  await p;
  assert.deepStrictEqual(ran, ['a', 'c']);
});

test('approval gate: approve() runs the step', async () => {
  const ran = [];
  const e = new Engine({
    steps: mkSteps(),
    handlers: {
      a: async () => { ran.push('a'); return true; },
      b: async () => { ran.push('b'); return true; },
      c: async () => { ran.push('c'); return true; },
    },
    emit: () => {},
    isUnattended: () => false,
  });
  const p = e.run();
  await new Promise((r) => setTimeout(r, 10));
  e.approve();
  await p;
  assert.deepStrictEqual(ran, ['a', 'b', 'c']);
});

test('non-fatal handler false sets ERROR but continues', async () => {
  const steps = mkSteps();
  const e = new Engine({
    steps,
    handlers: { a: async () => true, b: async () => false, c: async () => true },
    emit: () => {},
    isUnattended: () => true,
  });
  await e.run();
  assert.strictEqual(steps.find((s) => s.id === 'b').status, 'ERROR');
  assert.strictEqual(steps.find((s) => s.id === 'c').status, 'COMPLETE');
});

test('complete event carries ok=false when any step errored', async () => {
  const events = [];
  const e = new Engine({
    steps: mkSteps(),
    handlers: { a: async () => true, b: async () => false, c: async () => true },
    emit: (ev, p) => events.push([ev, p]),
    isUnattended: () => true,
  });
  await e.run();
  const complete = events.find(([ev]) => ev === 'complete');
  assert.ok(complete, 'complete event emitted');
  assert.strictEqual(complete[1].ok, false);
});

test('complete event carries ok=true when all steps succeed', async () => {
  const events = [];
  const e = new Engine({
    steps: mkSteps(),
    handlers: { a: async () => true, b: async () => true, c: async () => true },
    emit: (ev, p) => events.push([ev, p]),
    isUnattended: () => true,
  });
  await e.run();
  const complete = events.find(([ev]) => ev === 'complete');
  assert.strictEqual(complete[1].ok, true);
});
