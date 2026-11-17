import test from 'node:test';
import assert from 'node:assert/strict';
import { pluginUrl } from '../plugins/frame-url.js';

const mac = { macos: true };

test('plugin frames use one connect-plugin host per plugin on macOS', () => {
  assert.equal(pluginUrl('github', '__host/frame.html', mac), 'connect-plugin://github/__host/frame.html');
  assert.equal(pluginUrl('isolation-probe', '/__host/frame.html?probe=1', mac), 'connect-plugin://isolation-probe/__host/frame.html?probe=1');
});

test('plugin frames are refused off macOS', () => {
  // Windows: wry injects its init scripts into subframes, so a frame would get the invoke key.
  // Linux: WebKitGTK isolation isn't verified (R30).
  assert.throws(() => pluginUrl('github', '__host/frame.html', { macos: false }), /only available on macOS/);
});

test('a malformed plugin id never becomes a frame URL', () => {
  for (const id of ['', 'a', 'GitHub', '1abc', '__host', 'a.b', 'a/b', 'evil.com', 'x'.repeat(42)]) {
    assert.throws(() => pluginUrl(id, '__host/frame.html', mac), /plugin id/, id);
  }
});
