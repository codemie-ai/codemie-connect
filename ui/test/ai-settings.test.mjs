import { test } from 'node:test';
import assert from 'node:assert/strict';
import { aiPanel, nextAiSettings, testResultLabel } from '../workspace/settings-ai.js';
import { chooserBody } from '../workspace/ai-chooser.js';
import { aiStatus, aiUsage, contractFixtures } from './fixtures/workspace-fixture.mjs';

const loaded = (kind, extra = {}) => ({ status: 'ready', ...aiStatus(kind), usage: aiUsage(), tests: {}, ...extra });

test('ai_panel_renders_each_state', () => {
  const none = aiPanel(loaded('none'));
  assert.match(none, /Not installed/);
  assert.match(none, /data-action="cm-setup-open"/);
  assert.doesNotMatch(none, /Open CodeMie tools|data-action="setup-tools"/);
  assert.doesNotMatch(none, /data-action="ai-test"/);

  // A CodeMie profile that needs a sign-in is signed in from here, in the browser.
  const signedOut = loaded('both');
  signedOut.profiles[2] = { ...signedOut.profiles[2], state: 'needs_login' };
  const staging = aiPanel(signedOut).split('data-ai-profile=').find((c) => c.startsWith(`"${signedOut.profiles[2].id}"`));
  assert.match(staging, /data-action="cm-profile-login"[^>]*data-id="staging"/);
  assert.match(staging, /data-action="cm-tab"[^>]*data-tab="cm-profiles"/);
  assert.doesNotMatch(staging, /Open CodeMie tools|codemie profile login/);

  const native = aiPanel(loaded('native'));
  assert.match(native, /data-ai-profile="claude"/);
  assert.match(native, /Ready/);
  assert.match(native, /2\.1\.150/);
  assert.match(native, /Max/);
  assert.match(native, /taylor@example\.com/);
  assert.match(native, /<option value="opus"/);
  assert.match(native, /data-action="ai-test"[^>]*data-profile="claude"/);

  const login = aiPanel(loaded('native_needs_login'));
  assert.match(login, /Needs sign-in/);
  assert.match(login, /Open Terminal and run <code>claude<\/code>, then type <code>\/login<\/code>/);
  assert.match(login, /data-action="ai-copy-login"/);

  const both = aiPanel(loaded('both'));
  assert.equal((both.match(/data-ai-profile="/g) || []).length, 3);
  assert.match(both, /select[^>]*name="ai-default"/);
  for (const row of ['Mail replies', 'Teams replies', 'Summaries', 'Automations', 'Plugins']) assert.match(both, new RegExp(row));
  assert.equal((both.match(/data-route="/g) || []).length, 10);
  assert.match(both, /id="ai-usage"/);
  assert.match(both, /estimate/i);
  assert.match(both, /The message text you draft from is sent to this provider\./);

  const tooOld = aiPanel({ ...loaded('native'), profiles: [{ ...aiStatus('native').profiles[0], state: 'too_old', message: null }] });
  assert.match(tooOld, /Too old/);
  assert.match(tooOld, /Update Claude Code/);
  const broken = aiPanel({ ...loaded('native'), profiles: [{ ...aiStatus('native').profiles[0], state: 'error', message: 'Could not read the Claude Code sign-in status.' }] });
  assert.match(broken, /ws-badge-error/);
  assert.match(broken, /Could not read the Claude Code sign-in status\./);
});

test('ai_panel_default_placeholder_and_loading_and_error', () => {
  assert.match(aiPanel(loaded('both', { settings: { defaultProfile: null, routes: {} } })), /<option value="" selected>Choose…<\/option>/);
  assert.match(aiPanel({ status: 'loading' }), /ws-spinner/);
  const err = aiPanel({ status: 'error', error: 'Native is busy' });
  assert.match(err, /Native is busy/);
  assert.match(err, /data-action="ai-refresh"/);
});

test('ai_panel_shows_test_progress_and_results', () => {
  const busy = aiPanel(loaded('native', { tests: { claude: { busy: true } } }));
  assert.match(busy, /ws-spinner/);
  const ok = aiPanel(loaded('native', { tests: { claude: { ok: true, ms: 2100, costUsd: 0.0004 } } }));
  assert.match(ok, /OK · 2\.1 s · \$0\.0004/);
  const bad = aiPanel(loaded('native', { tests: { claude: { ok: false, message: 'Claude is rate limited right now.' } } }));
  assert.match(bad, /Claude is rate limited right now\./);
  assert.equal(testResultLabel({ ok: true, ms: 800 }), 'OK · 0.8 s');
});

test('ai_panel_escapes_profile_names', () => {
  const evil = '<img src=x onerror=alert(1)>';
  const status = aiStatus('both');
  status.profiles[1] = { ...status.profiles[1], label: evil, message: evil, models: [{ id: 'm"x', label: evil }] };
  status.profiles[0] = { ...status.profiles[0], account: { plan: evil, email: evil } };
  const html = aiPanel({ status: 'ready', ...status, usage: { runs: 1, costUsd: 0, byProfile: { 'codemie:prod': { runs: 1, costUsd: 0 } } }, tests: {} });
  assert.doesNotMatch(html, /<img src=x/);
  assert.match(html, /&lt;img src=x onerror=alert\(1\)&gt;/);
});

test('chooser_lists_only_ready_profiles_with_privacy_note', () => {
  const html = chooserBody(aiStatus('both').profiles);
  assert.equal((html.match(/data-action="ai-choose"/g) || []).length, 2);
  assert.match(html, /data-profile="claude"/);
  assert.match(html, /data-profile="codemie:prod"/);
  assert.doesNotMatch(html, /staging/);
  assert.match(html, /The message text you draft from is sent to this provider\./);
  const none = chooserBody(aiStatus('none').profiles);
  assert.doesNotMatch(none, /data-action="ai-choose"/);
  assert.match(none, /data-action="ai-open-settings"/);
  assert.match(none, /Settings/);
});

test('next_ai_settings_resets_models_a_profile_does_not_offer', () => {
  const { profiles, settings } = aiStatus('both');
  // Summaries uses codemie:prod + haiku; switching its profile to Claude drops the model.
  const a = nextAiSettings(settings, profiles, { purpose: 'summary', field: 'profile', value: 'claude' });
  assert.deepEqual(a.routes.summary, { profile: 'claude' });
  // Changing the default drops models of routes that follow it and the new default lacks.
  const b = nextAiSettings(settings, profiles, { field: 'default', value: 'codemie:prod' });
  assert.equal(b.defaultProfile, 'codemie:prod');
  assert.equal(b.routes.mail_draft, undefined);
  assert.deepEqual(b.routes.summary, { profile: 'codemie:prod', model: 'claude-haiku-4-5' });
  // Setting a model keeps the profile; clearing everything removes the route.
  const c = nextAiSettings(b, profiles, { purpose: 'plugin', field: 'model', value: 'claude-haiku-4-5' });
  assert.deepEqual(c.routes.plugin, { model: 'claude-haiku-4-5' });
  const d = nextAiSettings(c, profiles, { purpose: 'plugin', field: 'model', value: '' });
  assert.equal(d.routes.plugin, undefined);
});

test('ai_panel_renders_usage_rows_per_profile', () => {
  const html = aiPanel(loaded('both'));
  const usage = html.slice(html.indexOf('id="ai-usage"'));
  assert.match(usage, /Claude Code · your subscription/);
  assert.match(usage, /CodeMie · prod/);
  assert.match(usage, /1 run · Claude Code’s estimate/);
  assert.match(usage, /\$0\.0302/);
});

test('ai_panel_explains_a_codemie_profile_that_needs_sign_in_and_hides_routing_when_nothing_is_ready', () => {
  const both = aiPanel(loaded('both'));
  // Signed in from here, not by typing `codemie profile login` in Terminal.
  assert.match(both, /data-action="cm-profile-login"/);
  assert.doesNotMatch(both, /codemie profile login/);
  const none = aiPanel(loaded('none'));
  assert.match(none, /data-ai-routing-off/);
  assert.doesNotMatch(none, /data-route="/);
});

test('ui_renderers_accept_the_contract_fixtures_from_the_real_backend', () => {
  const { status, usage, testOk, testFail } = contractFixtures();
  assert.equal(testResultLabel(testOk), 'OK · 2.1 s · $0.0004');
  assert.match(testResultLabel(testFail), /Sign in to this CodeMie profile\./);
  const html = aiPanel({ status: 'ready', ...status, usage, tests: { claude: testOk, 'codemie:staging': testFail } });
  assert.match(html, /data-ai-profile="codemie:prod"/);
  assert.match(html, /claude-sonnet-4-5/, 'default model comes from defaultModel');
  assert.match(html, /\$0\.0302/);
  const chooser = chooserBody(status.profiles);
  assert.match(chooser, /claude-sonnet-4-5/);
  // Round trip through the settings logic with the real shapes.
  const next = nextAiSettings(status.settings, status.profiles, { field: 'default', value: 'codemie:prod' });
  assert.equal(next.defaultProfile, 'codemie:prod');
});
