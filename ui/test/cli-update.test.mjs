import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cliUpdateResult } from '../cli-update.js';

// EPMCDME-15304: the banner offered 0.15.3, the update left 0.15.2 in place, and
// the app still said "Updated! → 0.15.2" and kept the banner.
test('0.15.2 still installed after an update to 0.15.3 is not a success', () => {
  assert.deepEqual(cliUpdateResult('0.15.2', '0.15.3'), { ok: false, label: 'Still on 0.15.2 — retry?', hideBanner: false });
});

test('0.15.3 installed after an update to 0.15.3 hides the banner', () => {
  assert.deepEqual(cliUpdateResult('0.15.3', '0.15.3'), { ok: true, label: 'Updated to 0.15.3', hideBanner: true });
});

test('a version newer than the one offered is a success too', () => {
  assert.equal(cliUpdateResult('0.16.0', '0.15.3').ok, true);
});

test('a version that cannot be read after the update is not reported as a success', () => {
  assert.equal(cliUpdateResult(null, '0.15.3').ok, false);
  assert.equal(cliUpdateResult(null, '0.15.3').hideBanner, false);
});
