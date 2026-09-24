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

test('findProxyConnectError matches mixed-case Failed: prefix', () => {
  const line = findProxyConnectError(['Connecting…', 'Failed: proxy unreachable']);
  assert.equal(line, 'Failed: proxy unreachable');
});

test('parseProxyStatusDeep reports healthy for a healthy daemon', () => {
  assert.deepEqual(parseProxyStatusDeep('{"status":"healthy"}'), { healthy: true });
});

test('parseProxyStatusDeep reports unhealthy for unhealthy/stopped/malformed output', () => {
  assert.deepEqual(parseProxyStatusDeep('{"status":"unhealthy","reason":"no creds"}'), { healthy: false });
  assert.deepEqual(parseProxyStatusDeep('{"status":"stopped"}'), { healthy: false });
  assert.deepEqual(parseProxyStatusDeep('not json'), { healthy: false });
  assert.deepEqual(parseProxyStatusDeep(''), { healthy: false });
});
