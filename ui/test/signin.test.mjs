import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { findLoginError } from '../signin-parse.js';

test('findLoginError returns the ✗ line on SSO failure', () => {
  const lines = [
    '✗ No SSO credentials found for https://codemie.lab.epam.com. Please run: codemie profile login --url https://codemie.lab.epam.com',
    'Opening browser...',
  ];
  const result = findLoginError(lines);
  assert.ok(result.startsWith('✗ No SSO credentials found'));
});

test('findLoginError returns the Error: line on generic failure', () => {
  const lines = ['Connecting...', 'Error: endpoint unreachable'];
  const result = findLoginError(lines);
  assert.equal(result, 'Error: endpoint unreachable');
});

test('findLoginError returns null on clean run with no error lines', () => {
  const lines = ['Opening browser...', 'Login successful.'];
  const result = findLoginError(lines);
  assert.equal(result, null);
});

// CR-007: broader error-prefix coverage
test('findLoginError matches lowercase "error: ..." prefix', () => {
  const lines = ['Connecting...', 'error: timeout waiting for browser'];
  const result = findLoginError(lines);
  assert.equal(result, 'error: timeout waiting for browser');
});

test('findLoginError matches "FAILED: ..." prefix', () => {
  const lines = ['Starting...', 'FAILED: OAuth exchange rejected'];
  const result = findLoginError(lines);
  assert.equal(result, 'FAILED: OAuth exchange rejected');
});

test('findLoginError matches lowercase "failed: ..." prefix', () => {
  const lines = ['Starting...', 'failed: network unreachable'];
  const result = findLoginError(lines);
  assert.equal(result, 'failed: network unreachable');
});

// Measured 2026-09-23 on an empty home directory: with no profile, `codemie
// profile login` prints this and exits 0. Nothing matched it, so Sign in did
// nothing at all on screen.
test('findLoginError reports the CLI\'s ❌ refusal', () => {
  assert.equal(
    findLoginError(['', '❌ No AI/Run CodeMie URL configured or provided', 'Use: codemie profile login --url https://your-airun-codemie-instance.com']),
    '❌ No AI/Run CodeMie URL configured or provided',
  );
});
