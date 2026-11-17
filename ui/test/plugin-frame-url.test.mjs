import test from 'node:test';
import assert from 'node:assert/strict';
import { pluginUrl } from '../plugins/frame-url.js';

const mac = { windows: false, protocol: 'tauri:' };

test('plugin frames use one connect-plugin host per plugin on macOS', () => {
  assert.equal(pluginUrl('github', '__host/frame.html', mac), 'connect-plugin://github/__host/frame.html');
  assert.equal(pluginUrl('isolation-probe', '/__host/frame.html?probe=1', mac), 'connect-plugin://isolation-probe/__host/frame.html?probe=1');
  // Under `cargo tauri dev` the page comes from the CLI's http server; the scheme is unchanged.
  assert.equal(pluginUrl('github', 'client.js', { windows: false, protocol: 'http:' }), 'connect-plugin://github/client.js');
});

test('plugin frames use the host WebView2 gives the scheme on Windows', () => {
  assert.equal(pluginUrl('github', '__host/frame.html', { windows: true, protocol: 'http:' }), 'http://connect-plugin.localhost/github/__host/frame.html');
  // With useHttpsScheme the page and the scheme are both https.
  assert.equal(pluginUrl('github', 'client.js', { windows: true, protocol: 'https:' }), 'https://connect-plugin.localhost/github/client.js');
});

test('a malformed plugin id never becomes a frame URL', () => {
  for (const id of ['', 'a', 'GitHub', '1abc', '__host', 'a.b', 'a/b', 'evil.com', 'x'.repeat(42)]) {
    assert.throws(() => pluginUrl(id, '__host/frame.html', mac), /plugin id/, id);
  }
});
