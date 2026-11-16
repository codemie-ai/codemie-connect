import test from 'node:test';
import assert from 'node:assert/strict';

test('connectors.checkStatus invokes check_connector_status', async () => {
  globalThis.window = { __TAURI__: { core: { invoke: async (cmd) => {
    assert.equal(cmd, 'check_connector_status');
    return { claudeDesktop: true, codexDesktop: false, vscodeCopilot: false, vscodeClaudeCode: false };
  } }, event: { listen: async () => () => {} } } };
  const { connectors } = await import('../runner-bridge.js');
  const result = await connectors.checkStatus();
  assert.equal(result.claudeDesktop, true);
});
