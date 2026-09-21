import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { isBlockedState } from '../auth-gate.js';

// CR-004: no_profile must block the gate and never silently pass through.
test('isBlockedState returns true for no_profile', () => {
  assert.strictEqual(isBlockedState('no_profile'), true);
});

// CR-005: unknown is intentionally permissive — providers that omit an Auth Status
// row must never block the user.
test('isBlockedState returns false for unknown', () => {
  assert.strictEqual(isBlockedState('unknown'), false);
});

// Sanity: not_signed_in is blocked.
test('isBlockedState returns true for not_signed_in', () => {
  assert.strictEqual(isBlockedState('not_signed_in'), true);
});

// Sanity: signed_in passes the gate.
test('isBlockedState returns false for signed_in', () => {
  assert.strictEqual(isBlockedState('signed_in'), false);
});
