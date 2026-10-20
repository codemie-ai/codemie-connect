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

test('parseProxyStatusDeep reads the JSON past migration notes the CLI prints first', () => {
  assert.deepEqual(parseProxyStatusDeep('Migrating config…\n✓ Applied\n{\n  "status": "healthy"\n}\n'), { healthy: true });
});

import { analyzeProxyOutput, extractDownloadUrl } from '../proxy-parse.js';

test('analyzeProxyOutput finds a ✗ line wrapped in raw ANSI colour codes', () => {
  const r = analyzeProxyOutput('start\n\x1b[31m✗ boom\x1b[0m\n');
  assert.equal(r.errorLine, '✗ boom');
});

test('analyzeProxyOutput extracts an https download page and ignores others', () => {
  assert.equal(analyzeProxyOutput('Download page: https://x/y\n').downloadUrl, 'https://x/y');
  assert.equal(analyzeProxyOutput('Download page: http://x/y\n').downloadUrl, null);
  assert.equal(analyzeProxyOutput('Download page: javascript:alert(1)\n').downloadUrl, null);
  assert.equal(analyzeProxyOutput('Download page: garbage\n').downloadUrl, null);
});

test('extractDownloadUrl returns the normalised href for https only', () => {
  assert.equal(extractDownloadUrl(['x', '  Download page: https://a.b']), 'https://a.b/');
  assert.equal(extractDownloadUrl(['nothing']), null);
});

test('analyzeProxyOutput finds the ✗ line when an escape is split across decoder chunks', () => {
  const buf = '\x1b[3' + '1m✗ split\x1b[0m\n';
  assert.equal(analyzeProxyOutput(buf).errorLine, '✗ split');
});

test('a cursor-down escape before the ✗ line does not hide it', () => {
  assert.equal(analyzeProxyOutput('working\x1b[1B✗ after-move\n').errorLine, '✗ after-move');
});

test('findProxyConnectError strips ANSI per line', () => {
  assert.equal(findProxyConnectError(['\x1b[31m✗ red\x1b[0m']), '✗ red');
});

test('analyzeProxyOutput finds the ✗ line and download page after a lone \\r spinner frame', () => {
  const r = analyzeProxyOutput('⠋ Installing...\r✗ install failed\n⠙ Retrying\rDownload page: https://x/y\n');
  assert.equal(r.errorLine, '✗ install failed');
  assert.equal(r.downloadUrl, 'https://x/y');
});
