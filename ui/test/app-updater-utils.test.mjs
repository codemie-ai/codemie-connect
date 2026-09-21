import test from 'node:test';
import assert from 'node:assert/strict';
import { shouldCheckForAppUpdate } from '../app-updater-utils.mjs';

test('allows check when no timestamp is stored', () => {
  assert.equal(shouldCheckForAppUpdate(null), true);
  assert.equal(shouldCheckForAppUpdate(undefined), true);
  assert.equal(shouldCheckForAppUpdate(''), true);
});

test('blocks check when last check was within 24 h', () => {
  const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000).toISOString();
  assert.equal(shouldCheckForAppUpdate(oneHourAgo), false);
});

test('allows check when last check was more than 24 h ago', () => {
  const twentyFiveHoursAgo = new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString();
  assert.equal(shouldCheckForAppUpdate(twentyFiveHoursAgo), true);
});

test('allows check when exactly 24 h have elapsed', () => {
  const exactlyTwentyFourHoursAgo = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  assert.equal(shouldCheckForAppUpdate(exactlyTwentyFourHoursAgo), true);
});
