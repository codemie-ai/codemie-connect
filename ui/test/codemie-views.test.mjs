// Settings → CodeMie views: pure markup from CLI state. Copy and structure come from the
// prototype (prototypes/codemie-tools/proto.js); every CLI string is escaped.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { emptyCodemie } from '../workspace/codemie/model.js';
import { createRunLog } from '../workspace/codemie/run-log.js';
import { overviewPanel } from '../workspace/codemie/view-overview.js';
import { healthPanel } from '../workspace/codemie/view-health.js';
import { profilesPanel } from '../workspace/codemie/view-profiles.js';
import { agentsPanel } from '../workspace/codemie/view-agents.js';

export function cmState(over = {}) {
  const cm = emptyCodemie();
  Object.assign(cm, {
    loaded: true,
    runtime: { ...cm.runtime, state: 'ready', version: '0.16.3' },
    config: { state: 'valid', active: 'prod', account: 'taylor@epam.com' },
    profiles: [{ name: 'prod', provider: 'ai-run-sso', model: 'claude-sonnet-4-5', codemieUrl: 'https://codemie.lab.epam.com', codemieProject: 'EPM-CDME' }],
    auth: { state: 'signed_in', detail: '' },
    agents: [
      { name: 'CodeMie Code', command: 'codemie-code', installed: true, version: '0.0.47', description: 'CodeMie Code - AI coding assistant', updateAvailable: false },
      { name: 'Claude Code', command: 'claude', installed: false, version: null, description: 'Claude Code - official Anthropic CLI tool', updateAvailable: false },
      { name: 'Gemini CLI', command: 'gemini', installed: false, version: null, description: 'Google Gemini CLI', updateAvailable: false },
    ],
    gateway: { state: 'stopped', port: null, profile: null },
    apps: [
      { id: 'claude-desktop', installed: true, configured: false },
      { id: 'vscode-copilot', installed: false, configured: false },
      { id: 'vscode-claude', installed: false, configured: false },
      { id: 'codex-desktop', installed: false, configured: false },
    ],
  }, over);
  return cm;
}

const installClaude = (cm) => { cm.agents[1] = { ...cm.agents[1], installed: true, version: '2.1.281' }; return cm; };

test('overview_shows_checklist_until_complete', () => {
  const html = overviewPanel(cmState(), {}, {});
  assert.match(html, /class="cm-hero"/);
  assert.match(html, /Set up CodeMie/);
  assert.match(html, /1\/3/);
  assert.match(html, /data-action="cm-setup-open"/);
  assert.doesNotMatch(html, /class="cm-tile/);
});

test('overview_tiles_when_complete', () => {
  const html = overviewPanel(installClaude(cmState()), {}, {});
  assert.equal(html.match(/class="cm-tile[ "]/g)?.length, 4);
  assert.match(html, /Start coding/);
  assert.match(html, /codemie-claude --profile prod/);
  assert.doesNotMatch(html, /class="cm-hero"/);
});

test('overview_switcher_only_with_two_profiles', () => {
  const one = overviewPanel(installClaude(cmState()), {}, {});
  assert.doesNotMatch(one, /data-action="cm-profile-switch"/);
  const two = installClaude(cmState());
  two.profiles.push({ name: 'staging', provider: 'litellm', baseUrl: 'http://localhost:4000' });
  assert.match(overviewPanel(two, {}, {}), /data-action="cm-profile-switch"/);
});

test('cli_card_names_own_copy', () => {
  const own = cmState();
  own.runtime.ownCli = { version: '0.16.9' };
  assert.match(overviewPanel(own, {}, {}), /installed with npm/);
  const bundled = overviewPanel(cmState(), {}, {});
  assert.match(bundled, /Included with Connect/);
  assert.doesNotMatch(bundled, /data-action="terminal-path"|ws-switch/, 'no Terminal toggle');
});

test('runtime_failure_offers_retry', () => {
  const cm = cmState();
  Object.assign(cm.runtime, { state: 'failed', error: 'download failed: timeout', network: true });
  const html = overviewPanel(cm, {}, {});
  assert.match(html, /CodeMie could not finish downloading/);
  assert.match(html, /data-action="cm-runtime-retry"/);
});

test('health_maps_actions', () => {
  const cm = cmState();
  cm.health = {
    rows: [
      { group: 'account', label: 'Authentication required', status: 'fail', remedyText: 'Sign in again to restore your CodeMie session.', action: { kind: 'signin', label: 'Sign in again' } },
      { group: 'tools', label: 'Claude Code 2.1.0', status: 'fail', remedyText: 'Open the Tools screen to check for an update.', action: { kind: 'navigate', view: 'agents', label: 'Go to Tools' } },
      { group: 'codemie', label: 'Everything CodeMie needs to run is in place', status: 'pass', detail: 'Node.js 22' },
    ],
    summary: { passing: 1, total: 3 }, checkedAt: Date.UTC(2026, 10, 17, 9, 30),
  };
  const html = healthPanel(cm, createRunLog(), {});
  assert.match(html, /data-action="cm-profile-login" data-id="prod"/);
  assert.match(html, /data-action="cm-tab" data-tab="cm-agents"/);
  assert.match(html, /Your CodeMie account/);
  assert.match(html, /Your tools/);
  assert.match(html, /CodeMie itself/);
  assert.match(html, /1 of 3 fine/);
  assert.doesNotMatch(html, /Tools screen/, 'old screen names are reworded');
});

test('health_before_a_run_offers_a_check', () => {
  const html = healthPanel(cmState(), createRunLog(), {});
  assert.match(html, /Check that everything works/);
  assert.match(html, /data-action="cm-doctor"/);
});

test('ran_log_output_is_escaped', () => {
  const log = createRunLog();
  const r = log.start('codemie list < /dev/null');
  r.append('<img src=x onerror=1>');
  r.finish(1);
  const html = healthPanel(cmState(), log, { expandedRan: 1 });
  assert.match(html, /&lt;img src=x onerror=1&gt;/);
  assert.doesNotMatch(html, /<img src=x/);
  assert.match(html, /data-action="cm-copy-all"/);
});

// ---------------------------------------------------------------- Profiles

const cardOf = (html, name) => html.split('data-profile=').find((c) => c.startsWith(`"${name}"`));

test('unsafe_profile_name_disables_actions', () => {
  const cm = cmState();
  cm.profiles.push({ name: 'my profile', provider: 'litellm', baseUrl: 'http://localhost:4000' });
  const card = cardOf(profilesPanel(cm, {}), 'my profile');
  assert.ok(card, 'the profile is shown');
  assert.match(card, /Rename this profile in Terminal to manage it here\./);
  for (const action of ['cm-profile-activate', 'cm-profile-rename', 'cm-profile-delete', 'cm-profile-login', 'cm-profile-test', 'cm-profile-edit']) {
    assert.doesNotMatch(card, new RegExp(`data-action="${action}"`), action);
  }
});

test('only_active_profile_shows_sign_in_state', () => {
  const cm = cmState();
  cm.auth = { state: 'not_signed_in', detail: '' };
  cm.profiles.push({ name: 'staging', provider: 'ai-run-sso', codemieUrl: 'https://codemie.acme-bank.com' });
  const html = profilesPanel(cm, {});
  const prod = cardOf(html, 'prod');
  const staging = cardOf(html, 'staging');
  assert.match(prod, /Signed out/);
  assert.match(prod, /data-action="cm-profile-login"/);
  assert.doesNotMatch(staging, /Signed (in|out)/);
  assert.match(staging, /codemie\.acme-bank\.com/);
});

test('profile_strings_are_escaped', () => {
  const cm = cmState();
  cm.profiles[0].model = '<b>x</b>';
  assert.match(profilesPanel(cm, {}), /&lt;b&gt;x&lt;\/b&gt;/);
});

// ---------------------------------------------------------------- Coding agents

const agentCardOf = (html, command) => html.split('data-agent=').find((c) => c.startsWith(`"${command}"`));

test('incompatible_agent_cannot_install', () => {
  const cm = cmState();
  cm.profiles[0] = { name: 'prod', provider: 'bedrock' };
  const card = agentCardOf(agentsPanel(cm, {}, createRunLog()), 'gemini');
  assert.ok(card);
  assert.doesNotMatch(card, /data-action="cm-agent-install"/);
  assert.match(card, /Doesn’t work with AWS Bedrock profiles/);
  assert.match(agentCardOf(agentsPanel(cm, {}, createRunLog()), 'claude'), /data-action="cm-agent-install"/);
});

test('unknown_cli_agent_still_listed', () => {
  const cm = cmState();
  cm.agents.push({ name: 'New Agent', command: 'newagent', installed: false, version: null, description: 'A brand-new agent from a newer CLI', updateAvailable: false });
  assert.match(agentsPanel(cm, {}, createRunLog()), /Show \d+ more/);
  const card = agentCardOf(agentsPanel(cm, { showAllAgents: true }, createRunLog()), 'newagent');
  assert.match(card, /New Agent/);
  assert.match(card, /A brand-new agent from a newer CLI/);
});

test('agents_unreadable_offers_retry', () => {
  const html = agentsPanel(cmState({ agents: null }), {}, createRunLog());
  assert.match(html, /CodeMie could not list the agents/);
  assert.match(html, /data-action="cm-agents-refresh"/);
});

test('installed_agent_offers_update_and_terminal', () => {
  const cm = cmState();
  cm.agents[1] = { ...cm.agents[1], installed: true, version: '2.1.200', updateAvailable: true, latest: '2.1.281' };
  const card = agentCardOf(agentsPanel(cm, {}, createRunLog()), 'claude');
  assert.match(card, /Update to 2\.1\.281/);
  assert.match(card, /data-action="cm-open-terminal" data-id="claude"/);
  assert.match(card, /Start with codemie-claude/);
});

test('no_profile_offers_sign_in', () => {
  const html = profilesPanel(cmState({ profiles: [] }), {});
  assert.match(html, /No CodeMie profile yet/);
  assert.match(html, /data-action="cm-setup-open"/);
});
