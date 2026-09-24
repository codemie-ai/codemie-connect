import test from 'node:test';
import assert from 'node:assert/strict';
import { findProxyConnectError, parseProxyStatusDeep } from '../proxy-parse.js';

test('findProxyConnectError finds an error-prefixed line', () => {
  const line = findProxyConnectError(['Connecting…', '✗ Error: no active profile']);
  assert.equal(line, '✗ Error: no active profile');
});

test('findProxyConnectError returns null when no error line is present', () => {
  assert.equal(findProxyConnectError(['Connecting…', 'Done.']), null);
});

test('parseProxyStatusDeep reports healthy for a running daemon', () => {
  assert.deepEqual(parseProxyStatusDeep('{"status":"running"}'), { healthy: true });
});

test('parseProxyStatusDeep reports unhealthy for stopped/malformed output', () => {
  assert.deepEqual(parseProxyStatusDeep('{"status":"stopped"}'), { healthy: false });
  assert.deepEqual(parseProxyStatusDeep('not json'), { healthy: false });
  assert.deepEqual(parseProxyStatusDeep(''), { healthy: false });
});
