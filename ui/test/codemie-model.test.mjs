// Settings → CodeMie derived state: setup progress, agent and app states, the attention list,
// navigation dots, where setup starts, and the gateway status parser.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  emptyCodemie, agentStatus, appState, setupProgress, attention, tabDots, firstStep, shouldAutoOpen,
} from '../workspace/codemie/model.js';
import { parseProxyStatus } from '../workspace/codemie/parse.js';

const agent = (command, extra = {}) => ({
  name: command, command, installed: false, version: null, description: '', updateAvailable: false, ...extra,
});

function cmWith(over = {}) {
  const cm = emptyCodemie();
  cm.loaded = true;
  cm.runtime.state = 'ready';
  cm.config = { state: 'valid', active: 'prod', account: 'a@b.c' };
  cm.profiles = [{ name: 'prod', provider: 'ai-run-sso', codemieUrl: 'https://codemie.lab.epam.com' }];
  cm.auth = { state: 'signed_in', detail: '' };
  cm.agents = [agent('codemie-code', { installed: true, version: '0.0.47' }), agent('claude')];
  cm.gateway = { state: 'stopped', port: null, profile: null };
  cm.apps = [
    { id: 'claude-desktop', installed: true, configured: false },
    { id: 'vscode-copilot', installed: false, configured: false },
    { id: 'vscode-claude', installed: false, configured: false },
    { id: 'codex-desktop', installed: false, configured: false },
  ];
  return Object.assign(cm, over);
}

test('parse_proxy_status_drops_api_key', () => {
  const s = parseProxyStatus('{"status":"healthy","apiKey":"gk","port":4001,"profile":"prod"}');
  assert.deepEqual(s, { state: 'running', port: 4001, profile: 'prod' });
  assert.doesNotMatch(JSON.stringify(s), /gk/);
  assert.equal(parseProxyStatus('{\n  "status": "unhealthy",\n  "port": 4001\n}').state, 'unhealthy');
  assert.deepEqual(parseProxyStatus('{"status":"stopped"}'), { state: 'stopped', port: null, profile: null });
  assert.deepEqual(parseProxyStatus('Error: boom'), { state: 'stopped', port: null, profile: null });
});

test('builtin_agent_does_not_count_for_setup', () => {
  const cm = cmWith();
  assert.equal(setupProgress(cm, {}).agent, false);
  assert.equal(setupProgress(cm, {}).complete, false);
  cm.agents[1].installed = true;
  const p = setupProgress(cm, {});
  assert.deepEqual([p.account, p.agent, p.apps, p.count, p.complete], [true, true, false, 2, true]);
  assert.equal(setupProgress(cm, { appsSkipped: true }).count, 3);
});

test('agent_status_ranks_states', () => {
  assert.equal(agentStatus(agent('claude')), 'none');
  assert.equal(agentStatus(agent('claude', { installed: true, version: '2.1.0' }), true), 'busy');
  assert.equal(agentStatus(agent('claude', { installed: true, version: '2.1.0', belowMinimum: true, updateAvailable: true })), 'too_old');
  assert.equal(agentStatus(agent('claude', { installed: true, version: '2.1.0', updateAvailable: true })), 'update');
  assert.equal(agentStatus(agent('claude', { installed: true, version: '2.1.0' })), 'ok');
});

test('app_state_follows_gateway', () => {
  const cm = cmWith();
  assert.equal(appState(cm, 'claude-desktop'), 'not_set');
  assert.equal(appState(cm, 'codex-desktop'), 'not_installed');
  cm.apps[0].configured = true;
  assert.equal(appState(cm, 'claude-desktop'), 'disconnected');
  cm.gateway.state = 'running';
  assert.equal(appState(cm, 'claude-desktop'), 'connected');
  assert.equal(setupProgress(cm, {}).apps, true);
});

test('attention_orders_signed_out_before_agents', () => {
  const cm = cmWith();
  cm.auth = { state: 'not_signed_in', detail: '' };
  cm.agents[1] = agent('claude', { name: 'Claude Code', installed: true, version: '2.1.0', belowMinimum: true });
  cm.apps[0].configured = true;
  cm.runtime.state = 'failed';
  const keys = attention(cm).map((a) => a.key);
  assert.deepEqual(keys, ['runtime-failed', 'signed-out', 'agent-old:claude', 'gateway-stopped']);
  const signedOut = attention(cm).find((a) => a.key === 'signed-out');
  assert.deepEqual(signedOut.action, { label: 'Sign in again', action: 'cm-profile-login', id: 'prod' });
  assert.match(attention(cm).find((a) => a.key === 'gateway-stopped').title, /Claude Desktop can’t reach CodeMie/);
});

test('broken_config_asks_to_set_up_again', () => {
  const cm = cmWith({ config: { state: 'broken', active: 'gone', account: null } });
  const [first] = attention(cm);
  assert.equal(first.key, 'config-broken');
  assert.equal(first.title, 'Your CodeMie profile is no longer working');
  assert.equal(first.action.action, 'cm-setup-open');
});

test('tab_dots_follow_attention', () => {
  const cm = cmWith();
  assert.deepEqual([...tabDots(cm, {})].sort(), ['cm-overview']);
  cm.agents[1].installed = true;
  assert.deepEqual([...tabDots(cm, {})], []);
  cm.auth = { state: 'not_signed_in', detail: '' };
  assert.deepEqual([...tabDots(cm, {})].sort(), ['ai', 'cm-overview', 'cm-profiles']);
  assert.deepEqual([...tabDots({ ...emptyCodemie() }, {})], [], 'nothing before the first read');
});

test('first_step_follows_cli_state', () => {
  const cm = cmWith({ runtime: { ...emptyCodemie().runtime, state: 'ready', ownCli: { version: '0.16.9' } } });
  assert.equal(firstStep(cm, {}), 'agents', 'a CodeMie set up in Terminal goes straight to what is missing');
  assert.equal(firstStep(cm, { introduced: true }), 'agents');
  assert.equal(firstStep(cmWith({ profiles: [] }), {}), 'welcome');
  assert.equal(firstStep(cmWith({ profiles: [] }), { introduced: true }), 'signin');
  const done = cmWith();
  done.agents[1].installed = true;
  assert.equal(firstStep(done, { introduced: true }), 'apps');
  assert.equal(firstStep(done, { introduced: true, appsSkipped: true }), 'done');
});

test('auto_open_only_once', () => {
  const fresh = cmWith({ profiles: [] });
  assert.equal(shouldAutoOpen(fresh, {}), true);
  assert.equal(shouldAutoOpen(fresh, { introduced: true }), false);
  assert.equal(shouldAutoOpen(cmWith(), {}), false, 'a working profile from Connect needs no welcome');
  assert.equal(shouldAutoOpen({ ...fresh, loaded: false }, {}), false);
  // Someone who set CodeMie up themselves (their own npm copy, their own profiles) is not
  // walked through setup again.
  const own = cmWith({ runtime: { ...emptyCodemie().runtime, state: 'ready', ownCli: { version: '0.16.9' } } });
  assert.equal(shouldAutoOpen(own, {}), false);
});

test('dismissed_agent_notice_stays_hidden_until_its_version_changes', () => {
  const cm = cmWith();
  cm.agents[1] = { name: 'Gemini CLI', command: 'gemini', installed: true, version: '0.15.4', belowMinimum: true };
  const [notice] = attention(cm);
  assert.equal(notice.key, 'agent-old:gemini');
  assert.equal(notice.dismissKey, 'agent-old:gemini@0.15.4');
  const dismissed = new Set([notice.dismissKey]);
  assert.deepEqual(attention(cm, dismissed), []);
  assert.ok(!tabDots(cm, { dismissed }).has('cm-agents'));
  cm.agents[1].version = '0.16.0';
  assert.equal(attention(cm, dismissed).length, 1, 'a different version shows again');
});

test('sign_in_and_broken_config_cannot_be_dismissed', () => {
  const cm = cmWith({ config: { state: 'broken', active: 'gone', account: null } });
  assert.equal(attention(cm)[0].dismissKey, undefined);
});

test('a_closed_setup_card_takes_its_dot_away', () => {
  const cm = cmWith();
  assert.ok(tabDots(cm, {}).has('cm-overview'));
  assert.ok(!tabDots(cm, { setupDismissed: true }).has('cm-overview'));
});
