// The native view / hiddenPages settings reach the UI fixture as the contract fixture has them.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { buildSnapshot } from './fixtures/workspace-fixture.mjs';
import { viewOf, readViewMirror, writeViewMirror } from '../workspace/view-mode.js';

test('the fixture settings carry native’s defaults for view and hiddenPages', () => {
  const native = JSON.parse(readFileSync(new URL('./fixtures/contract/settings-view.json', import.meta.url))).default;
  const { view, hiddenPages } = buildSnapshot(Date.now()).settings;
  assert.deepEqual({ view, hiddenPages }, native);
});

test('viewOf reads compact only', () => {
  assert.equal(viewOf({ view: 'compact' }), 'compact');
  assert.equal(viewOf({ view: 'dense' }), 'default');
  assert.equal(viewOf({}), 'default');
});

test('the mirror reads garbage and a throwing storage as default and writes without throwing', () => {
  let stored;
  const ok = { getItem: () => 'x', setItem: (_, v) => { stored = v; } };
  assert.equal(readViewMirror(ok), 'default');
  const throwing = { getItem: () => { throw new Error('nope'); }, setItem: () => { throw new Error('nope'); } };
  assert.equal(readViewMirror(throwing), 'default');
  assert.doesNotThrow(() => writeViewMirror(throwing, 'compact'));
  writeViewMirror(ok, 'compact');
  assert.equal(stored, 'compact');
  ok.getItem = () => stored;
  assert.equal(readViewMirror(ok), 'compact');
});
