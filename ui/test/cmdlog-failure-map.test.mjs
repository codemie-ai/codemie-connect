// ui/test/cmdlog-failure-map.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import mapFailure from '../cmdlog-failure-map.mjs';

test('null exit_code (in-flight record) returns empty string', () => {
  assert.equal(
    mapFailure({ exit_code: null, raw_output: '' }),
    ''
  );
});
test('null exit_code with partial output returns empty string', () => {
  assert.equal(
    mapFailure({ exit_code: null, raw_output: 'ENOTFOUND partial output' }),
    ''
  );
});
test('non-zero exit with empty output returns plain-language string', () => {
  assert.equal(
    mapFailure({ exit_code: 1, raw_output: '' }),
    'Command exited with code 1 and produced no output.'
  );
});

test('raw_output containing ENOTFOUND returns network error string', () => {
  assert.equal(
    mapFailure({ exit_code: 1, raw_output: 'getaddrinfo ENOTFOUND example.com' }),
    'A network error occurred. Check your internet connection.'
  );
});

test('exit_code 127 returns command-not-found string', () => {
  assert.equal(
    mapFailure({ exit_code: 127, raw_output: 'some output' }),
    'Command not found. Check that the required tool is installed and on your PATH.'
  );
});

test('unrecognised failure returns raw_output verbatim', () => {
  assert.equal(
    mapFailure({ exit_code: 1, raw_output: 'some unknown error' }),
    'some unknown error'
  );
});
