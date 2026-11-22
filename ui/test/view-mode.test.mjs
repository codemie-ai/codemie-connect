// The native view / hiddenPages settings reach the UI fixture as the contract fixture has them.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { buildSnapshot } from './fixtures/workspace-fixture.mjs';

test('the fixture settings carry native’s defaults for view and hiddenPages', () => {
  const native = JSON.parse(readFileSync(new URL('./fixtures/contract/settings-view.json', import.meta.url))).default;
  const { view, hiddenPages } = buildSnapshot(Date.now()).settings;
  assert.deepEqual({ view, hiddenPages }, native);
});
