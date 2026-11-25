import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { aiPanel, nextAiSettings, routeState, testResultLabel, withCodemieSignIn, ROUTES, ROW_LABEL } from '../workspace/settings-ai.js';
import { chooserBody, CHOOSER_TITLE } from '../workspace/ai-chooser.js';
import { aiStatus, aiUsage, chooseAll, contractFixtures } from './fixtures/workspace-fixture.mjs';

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
  for (const row of ['Mail replies', 'Teams replies', 'Summaries', 'Automations', 'Plugins', 'Meeting notes']) assert.match(both, new RegExp(row));
  assert.match(both, /Notes and summaries from transcripts\./);
  // Ten rows (Ask's hidden), each with a profile, a model and a fallback.
  assert.equal((both.match(/data-route="/g) || []).length, 30);
  assert.match(both, /data-route="meeting"[^>]*data-field="profile"|data-field="profile"[^>]*data-route="meeting"/);
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
  // The window sends the edit as made; Rust's save drops a model whose row moved to a profile
  // without it (workspace::ai a_row_moved_to_a_profile_without_its_model_drops_the_model).
  const { profiles, settings } = aiStatus('both');
  const a = nextAiSettings(settings, profiles, { purpose: 'summary', field: 'profile', value: 'claude' });
  assert.deepEqual(a.routes.summary, { profile: 'claude', model: 'claude-haiku-4-5' });
  const b = nextAiSettings(settings, profiles, { field: 'default', value: 'codemie:prod' });
  assert.equal(b.defaultProfile, 'codemie:prod');
  assert.deepEqual(b.routes.mail_draft, { model: 'sonnet' });
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

// Merge with native CodeMie settings: one Claude tab. A CodeMie profile's readiness there agrees with
// Settings → CodeMie, which reads the active profile's sign-in (`codemie profile status`).
const cardOf = (html, id) => html.split('data-ai-profile=').find((c) => c.startsWith(`"${id}"`)) || '';
const expired = { loaded: true, active: 'prod', state: 'not_signed_in', profiles: [{ name: 'prod', browser: true }, { name: 'staging', browser: true }] };

test('claude_tab_shows_the_codemie_sign_in_settings_codemie_read', () => {
  const ai = loaded('both');
  const html = aiPanel(ai, { codemie: expired });
  const prod = cardOf(html, 'codemie:prod');
  assert.match(prod, /Needs sign-in/);
  assert.doesNotMatch(prod, /ws-badge-success/);
  assert.match(prod, /data-action="cm-profile-login"[^>]*data-id="prod"/);
  // One list: the CodeMie profiles appear once each, as detection found them.
  assert.equal((html.match(/data-ai-profile="/g) || []).length, 3);
  // Routing offers only what is ready, so the signed-out profile is marked there too.
  assert.doesNotMatch(html.split('data-ai-route-row')[0], /<option value="codemie:prod"/);
  // Signed in again, or nothing read yet: detection stands.
  assert.match(cardOf(aiPanel(ai, { codemie: { ...expired, state: 'signed_in' } }), 'codemie:prod'), /ws-badge-success/);
  assert.match(cardOf(aiPanel(ai, { codemie: { ...expired, loaded: false } }), 'codemie:prod'), /ws-badge-success/);
  assert.match(cardOf(aiPanel(ai), 'codemie:prod'), /ws-badge-success/);
});

test('a_codemie_profile_without_browser_sign_in_gets_no_sign_in_button', () => {
  const ai = loaded('both');
  const html = aiPanel(ai, { codemie: { ...expired, profiles: [{ name: 'prod', browser: true }, { name: 'staging', browser: false }] } });
  const staging = cardOf(html, 'codemie:staging');
  assert.match(staging, /Needs sign-in/);
  assert.doesNotMatch(staging, /data-action="cm-profile-login"/);
  assert.match(staging, /data-action="cm-tab"[^>]*data-tab="cm-profiles"/);
});

test('chooser_does_not_offer_a_signed_out_codemie_profile', () => {
  const profiles = withCodemieSignIn(loaded('both').profiles, expired);
  assert.equal(profiles.find((p) => p.id === 'codemie:prod').state, 'needs_login');
  assert.equal(profiles.find((p) => p.id === 'claude').state, 'ready');
  const body = chooserBody(profiles);
  assert.doesNotMatch(body, /codemie:prod/);
  assert.match(body, /data-profile="claude"/);
});

// ---------------------------------------------------------------- Settings › AI (profiles and models)

const routeCases = () => JSON.parse(readFileSync(new URL('./fixtures/contract/ai-route-cases.json', import.meta.url), 'utf8'));
const rowOf = (html, key) => html.match(new RegExp(`<tr[^>]*data-ai-route-row="${key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}"[\\s\\S]*?</tr>`))?.[0] || '';
const firstOption = (row, field) => row.match(new RegExp(`data-field="${field}"[^>]*>\\s*<option[^>]*>([^<]*)</option>`))?.[1];
const knowledge = { id: 'knowledge', name: 'Knowledge', enabled: true, agreed: ['claude', 'network'] };
const github = { id: 'github', name: 'GitHub', enabled: true, agreed: ['claude'] };

test('chooses_like_rust', () => {
  // The test mirror the browser mock and presets use agrees with Rust `choose`.
  for (const c of routeCases()) assert.deepEqual(chooseAll(c.settings), c.chosen, c.name);
  const { settings, chosen } = contractFixtures().status;
  assert.deepEqual(chooseAll(settings), chosen);
});

test('route_state_covers_working_fallback_broken_and_unset', () => {
  const { profiles } = aiStatus('all');
  const claude = profiles.find(p => p.id === 'claude');
  const signedOut = profiles.map(p => (p.id === 'claude' ? { ...claude, state: 'needs_login', message: 'Claude Code is not signed in.' } : p));
  assert.deepEqual(routeState({ profile: 'claude', model: null, fallback: 'codemie:prod' }, profiles), { state: 'working', text: 'Claude Code · Account default', using: 'claude' });
  assert.equal(routeState({ profile: 'codemie:prod', model: 'claude-haiku-4-5', fallback: null }, profiles).text, 'CodeMie · prod · claude-haiku-4-5');
  const fell = routeState({ profile: 'claude', model: null, fallback: 'codemie:prod' }, signedOut);
  assert.equal(fell.state, 'fallback');
  assert.equal(fell.using, 'codemie:prod');
  assert.equal(fell.text, 'Using CodeMie · prod: Claude Code is not signed in.');
  // Both unready: the chosen profile's own message.
  const broken = routeState({ profile: 'claude', model: null, fallback: 'codemie:staging' }, signedOut);
  assert.deepEqual(broken, { state: 'broken', text: 'Claude Code is not signed in.', using: null });
  assert.deepEqual(routeState({ profile: null, model: null, fallback: 'codemie:prod' }, profiles), { state: 'unset', text: 'Nothing runs until you choose one.', using: null });
  assert.equal(routeState(undefined, profiles).state, 'unset');
  // Ollama is running but no longer has the saved model: the row says so instead of dropping it.
  const pulledNone = profiles.map(p => (p.provider === 'ollama' ? { ...p, models: [{ id: 'llama3.2:latest', label: 'llama3.2:latest' }] } : p));
  assert.deepEqual(routeState({ profile: 'codemie:local-ollama', model: 'qwen3:8b', fallback: null }, pulledNone), { state: 'broken', text: "CodeMie · local-ollama doesn't offer qwen3:8b.", using: null });
  // A name without a tag is the :latest one.
  assert.equal(routeState({ profile: 'codemie:local-ollama', model: 'llama3.2', fallback: null }, pulledNone).state, 'working');
  // The model a profile lacks falls back like an unready profile.
  assert.equal(routeState({ profile: 'codemie:local-ollama', model: 'qwen3:8b', fallback: 'claude' }, pulledNone).text, "Using Claude Code: CodeMie · local-ollama doesn't offer qwen3:8b.");
  // A saved profile that no longer exists is not ready; its fallback runs.
  assert.equal(routeState({ profile: 'codemie:gone', model: null, fallback: null }, profiles).state, 'broken');
  assert.equal(routeState({ profile: 'codemie:gone', model: null, fallback: 'claude' }, profiles).state, 'fallback');
  // Not running Ollama.
  const stopped = profiles.map(p => (p.provider === 'ollama' ? { ...p, state: 'not_running', message: "Ollama isn't running. Open Ollama, then check again." } : p));
  assert.deepEqual(routeState({ profile: 'codemie:local-ollama', model: 'qwen3:8b', fallback: null }, stopped), { state: 'broken', text: "Ollama isn't running. Open Ollama, then check again.", using: null });
});

test('route_state_says_what_a_run_does', () => {
  // Each case's state and profile are what Rust's `resolve` does before the run
  // (ai-route-status-cases.json), so a row never promises a fallback the run doesn't make.
  const cases = JSON.parse(readFileSync(new URL('./fixtures/contract/ai-route-status-cases.json', import.meta.url), 'utf8'));
  assert.ok(cases.some(c => c.name === 'missing model, fallback' && c.state === 'fallback'));
  assert.ok(cases.some(c => c.name === 'no model list, fallback' && c.state === 'working'));
  for (const c of cases) {
    const { state, using } = routeState(c.chosen, c.profiles);
    assert.deepEqual({ state, using }, { state: c.state, using: c.using }, c.name);
  }
});

test('route_state_reads_profiles_after_the_codemie_sign_in_overlay', () => {
  const ai = loaded('all');
  // Summaries run on codemie:prod with no fallback (its default fallback is itself).
  assert.match(rowOf(aiPanel(ai), 'summary'), /Working/);
  const row = rowOf(aiPanel(ai, { codemie: expired }), 'summary');
  assert.ok(row, 'summary row');
  assert.doesNotMatch(row, /Working/);
  assert.match(row, /Not working/);
  assert.match(row, /Its CodeMie sign-in expired\./);
  assert.match(row, /data-action="ai-refresh"/);
  // Rows on Claude Code whose fallback is prod still say Working, and do not use the fallback.
  assert.match(rowOf(aiPanel(ai, { codemie: expired }), 'chat_draft'), /Working/);
});

test('ai_panel_draws_groups_plugin_rows_and_fallback_columns', () => {
  const html = aiPanel(loaded('all'), { plugins: [github, knowledge, { ...github, id: 'off', name: 'Off', enabled: false }, { ...github, id: 'noai', name: 'No AI', agreed: ['network'] }] });
  assert.match(html, /What each job uses/);
  assert.doesNotMatch(html, /Which Claude writes for you/);
  assert.match(html, /Used for every job below unless you pick another\./);
  for (const g of ['Replies', 'Summaries and notes', 'Automations', 'Plugins']) assert.match(html, new RegExp(`<th scope="rowgroup"[^>]*>${g}</th>`));
  for (const c of ['Job', 'Profile', 'Model', 'Fallback', 'Status']) assert.match(html, new RegExp(`<th scope="col">${c}</th>`));
  const keys = [...html.matchAll(/data-ai-route-row="([^"]+)"/g)].map(m => m[1]);
  assert.deepEqual(keys, ['mail_draft', 'chat_draft', 'summary', 'meeting', 'briefing', 'triage', 'commitments', 'automation', 'ask', 'plugin', 'plugin:github', 'plugin:knowledge']);
  assert.match(html, /<tr[^>]*data-ai-route-row="ask"[^>]*hidden/);
  assert.match(rowOf(html, 'ask'), /Questions you type in ⌘K\./);
  assert.match(html, /aria-label="Inbox triage: fallback"/);
  assert.match(html, /aria-label="Knowledge: profile"/);
  assert.match(rowOf(html, 'plugin:knowledge'), /Your choice here wins over the profile the plugin asks for\./);
  assert.match(rowOf(html, 'plugin:knowledge'), /data-route="plugin:knowledge"/);
  assert.match(rowOf(html, 'plugin'), /Plugins without a choice of their own\./);
  // Empty options name the group the row follows, from `chosen`.
  const triage = rowOf(html, 'triage');
  assert.equal(firstOption(triage, 'profile'), 'Same as Automations (Claude Code)');
  assert.equal(firstOption(triage, 'fallback'), 'Same as Automations (CodeMie · prod)');
  assert.match(triage, /<option value="codemie:local-ollama" selected>/);
  assert.equal(firstOption(rowOf(html, 'plugin:github'), 'profile'), 'Same as All plugins (Claude Code)');
  assert.equal(firstOption(rowOf(html, 'mail_draft'), 'model'), 'Account default');
  assert.equal(firstOption(rowOf(html, 'summary'), 'model'), 'Profile default');
  // The fallback list leaves out the row's own profile.
  assert.doesNotMatch(rowOf(html, 'summary').split('data-field="fallback"')[1], /<option value="codemie:prod"/);
  // Default row: profile, model and fallback.
  assert.match(html, /select[^>]*name="ai-default"/);
  assert.match(html, /data-action="ai-default"[^>]*data-field="defaultModel"/);
  assert.match(html, /data-action="ai-default"[^>]*data-field="defaultFallback"/);
  // Statuses are words beside the chip.
  assert.match(rowOf(html, 'plugin:knowledge'), /Working[\s\S]*CodeMie · local-ollama · qwen3:8b/);
  // No per-row test.
  assert.doesNotMatch(html.slice(html.indexOf('What each job uses')), /data-action="ai-test"/);
  // Nothing chosen anywhere: every row says so and models are off.
  const unset = aiPanel(loaded('all', { settings: { defaultProfile: null, routes: {}, plugins: {} }, chosen: chooseAll({}) }));
  assert.match(rowOf(unset, 'summary'), /Choose a profile[\s\S]*Nothing runs until you choose one\./);
  assert.match(rowOf(unset, 'summary'), /data-field="model"[^>]*disabled/);
  assert.equal(firstOption(rowOf(unset, 'summary'), 'profile'), 'Same as Default (None)');
});

test('same_as_labels_follow_the_native_groups', () => {
  // Expected groups come from Rust (`chosen[key].group` in ai-route-cases.json), and the names
  // are written here, apart from the renderer.
  const { profiles } = aiStatus('all');
  const label = id => (!id ? 'None' : id === 'claude' ? 'Claude Code' : profiles.find(p => p.id === id).label);
  const NAME = { default: 'Default', automation: 'Automations', plugin: 'All plugins' };
  for (const c of routeCases()) {
    const ai = { status: 'ready', profiles, settings: c.settings, chosen: c.chosen, usage: aiUsage(), tests: {} };
    const html = aiPanel(ai, { plugins: [github, knowledge] });
    for (const key of [...ROUTES.filter(x => !x.hidden).map(x => x.key), 'plugin:github', 'plugin:knowledge']) {
      const own = c.chosen[key] || c.chosen.plugin;
      const groupKey = c.chosen[key] ? own.group : 'plugin';
      assert.ok(NAME[groupKey], `${c.name} ${key} group ${groupKey}`);
      const group = c.chosen[groupKey];
      const row = rowOf(html, key);
      assert.equal(firstOption(row, 'profile'), `Same as ${NAME[groupKey]} (${label(group.profile)})`, `${c.name} ${key} profile`);
      assert.equal(firstOption(row, 'fallback'), `Same as ${NAME[groupKey]} (${label(group.fallback)})`, `${c.name} ${key} fallback`);
    }
  }
  // Rust's groups for the rows the spec names.
  const { chosen } = routeCases()[0];
  assert.deepEqual(['briefing', 'triage', 'commitments', 'summary', 'plugin'].map(k => chosen[k].group), ['automation', 'automation', 'automation', 'default', 'default']);
});

test('profile_cards_show_engine_and_provider_and_not_running', () => {
  const ai = loaded('all');
  const html = aiPanel(ai);
  const ollama = cardOf(html, 'codemie:local-ollama');
  assert.match(ollama, /<dt>Engine<\/dt><dd>Ollama<\/dd>/);
  assert.match(ollama, /<dt>Provider<\/dt><dd>Ollama<\/dd>/);
  const prod = cardOf(html, 'codemie:prod');
  assert.match(prod, /<dt>Engine<\/dt><dd>Claude<\/dd>/);
  assert.match(prod, /<dt>Provider<\/dt><dd>CodeMie SSO<\/dd>/);
  assert.doesNotMatch(html, /<dd>CodeMie<\/dd>/);
  const odd = aiPanel({ ...ai, profiles: ai.profiles.map(p => (p.id === 'codemie:prod' ? { ...p, provider: 'my-<b>' } : p)) });
  assert.match(cardOf(odd, 'codemie:prod'), /<dd>my-&lt;b&gt;<\/dd>/);
  const stopped = aiPanel({ ...ai, profiles: ai.profiles.map(p => (p.provider === 'ollama' ? { ...p, state: 'not_running', message: null } : p)) });
  const card = cardOf(stopped, 'codemie:local-ollama');
  assert.match(card, /Not running/);
  assert.match(card, /ws-badge-warning/);
  assert.match(card, /Ollama isn(?:'|&#39;)t running\. Open Ollama, then check again\./);
  assert.match(card, /data-action="ai-refresh"/);
  assert.doesNotMatch(card, /data-action="cm-setup-open"/);
  const missing = aiPanel({ ...ai, profiles: ai.profiles.map(p => (p.provider === 'ollama' ? { ...p, state: 'not_configured', message: "Ollama doesn't have qwen3:8b. Pull it in Ollama, then check again." } : p)) });
  const nc = cardOf(missing, 'codemie:local-ollama');
  assert.match(nc, /Ollama doesn(?:'|&#39;)t have qwen3:8b\. Pull it in Ollama, then check again\./);
  assert.match(nc, /data-action="ai-refresh"/);
  assert.doesNotMatch(nc, /data-action="cm-setup-open"/);
});

test('next_ai_settings_handles_fallback_and_plugin_rows', () => {
  const { profiles, settings } = aiStatus('all');
  const a = nextAiSettings(settings, profiles, { purpose: 'plugin:knowledge', field: 'profile', value: 'claude' });
  assert.deepEqual(a.plugins.knowledge, { profile: 'claude', model: 'qwen3:8b' });
  const b = nextAiSettings(settings, profiles, { purpose: 'plugin:github', field: 'model', value: 'claude-haiku-4-5' });
  assert.deepEqual(b.plugins.github, { model: 'claude-haiku-4-5' });
  const c = nextAiSettings(settings, profiles, { purpose: 'triage', field: 'fallback', value: 'codemie:prod' });
  assert.deepEqual(c.routes.triage, { fallback: 'codemie:prod' });
  const d = nextAiSettings(c, profiles, { purpose: 'triage', field: 'fallback', value: '' });
  assert.equal(d.routes.triage, undefined);
  assert.equal(nextAiSettings(settings, profiles, { field: 'defaultFallback', value: 'codemie:local-ollama' }).defaultFallback, 'codemie:local-ollama');
  assert.equal(nextAiSettings(settings, profiles, { field: 'defaultModel', value: 'opus' }).defaultModel, 'opus');
  const cleared = nextAiSettings(settings, profiles, { purpose: 'plugin:knowledge', field: 'profile', value: '' });
  assert.deepEqual(cleared.plugins.knowledge, { model: 'qwen3:8b' });
});

test('next_ai_settings_keeps_a_model_when_its_profile_did_not_change', () => {
  // Ollama closed: its profile lists no models, and an edit of another row keeps the saved choice.
  const { profiles } = aiStatus('all');
  const closed = profiles.map(p => (p.provider === 'ollama' ? { ...p, id: 'codemie:ol', state: 'not_running', models: [] } : p));
  const settings = { defaultProfile: 'claude', routes: { plugin: { profile: 'codemie:ol', model: 'qwen3:8b' } }, plugins: { knowledge: { model: 'qwen3:8b' } } };
  const next = nextAiSettings(settings, closed, { purpose: 'summary', field: 'profile', value: 'codemie:prod' });
  assert.deepEqual(next.routes.plugin, { profile: 'codemie:ol', model: 'qwen3:8b' });
  assert.deepEqual(next.plugins.knowledge, { model: 'qwen3:8b' });
  assert.deepEqual(nextAiSettings(settings, closed, { field: 'default', value: 'codemie:prod' }).routes.plugin, { profile: 'codemie:ol', model: 'qwen3:8b' });
});

test('next_ai_settings_sends_only_the_changed_field', () => {
  // ruling 16: the window walks no chain; Rust's save decides what a moved row's model becomes.
  const { profiles, settings } = aiStatus('all');
  const clean = rows => Object.fromEntries(Object.entries(rows).map(([k, r]) => [k, Object.fromEntries(Object.entries(r).filter(([, v]) => v))]));
  const base = { defaultProfile: 'claude', defaultModel: null, defaultFallback: 'codemie:prod', routes: clean(settings.routes), plugins: clean(settings.plugins) };
  const edits = [
    [{ field: 'default', value: 'codemie:local-ollama' }, { defaultProfile: 'codemie:local-ollama' }],
    [{ field: 'defaultModel', value: 'opus' }, { defaultModel: 'opus' }],
    [{ purpose: 'plugin', field: 'profile', value: 'codemie:prod' }, { routes: { ...base.routes, plugin: { profile: 'codemie:prod' } } }],
    [{ purpose: 'summary', field: 'profile', value: 'claude' }, { routes: { ...base.routes, summary: { profile: 'claude', model: 'claude-haiku-4-5' } } }],
    [{ purpose: 'plugin:knowledge', field: 'model', value: 'llama3.2:latest' }, { plugins: { knowledge: { profile: 'codemie:local-ollama', model: 'llama3.2:latest' } } }],
  ];
  for (const [edit, changed] of edits) assert.deepEqual(nextAiSettings(settings, profiles, edit), { ...base, ...changed }, JSON.stringify(edit));
});

test('next_ai_settings_clears_a_fallback_the_row_now_runs_on', () => {
  // Rust refuses a row whose own profile and fallback are equal; picking the fallback as the
  // profile clears the fallback in the same edit, which Rust accepts
  // (workspace::ai moving_a_row_onto_its_own_fallback_with_the_fallback_cleared_is_saved).
  const { profiles, settings } = aiStatus('all');
  const a = nextAiSettings(settings, profiles, { field: 'default', value: 'codemie:prod' });
  assert.equal(a.defaultProfile, 'codemie:prod');
  assert.equal(a.defaultFallback, null);
  const b = nextAiSettings(settings, profiles, { purpose: 'triage', field: 'profile', value: 'codemie:local-ollama' });
  assert.deepEqual(b.routes.triage, { profile: 'codemie:local-ollama' });
  const withFallback = { ...settings, plugins: { knowledge: { profile: 'codemie:local-ollama', fallback: 'claude' } } };
  assert.deepEqual(nextAiSettings(withFallback, profiles, { purpose: 'plugin:knowledge', field: 'profile', value: 'claude' }).plugins.knowledge, { profile: 'claude' });
  // Another profile leaves the fallback alone.
  assert.equal(nextAiSettings(settings, profiles, { field: 'default', value: 'codemie:local-ollama' }).defaultFallback, 'codemie:prod');
});

test('same_as_label_follows_the_group_chosen_names', () => {
  // The group comes from Rust's `chosen[key].group`, not from a copy of the chain.
  const ai = loaded('all');
  ai.chosen = { ...ai.chosen, briefing: { ...ai.chosen.briefing, group: 'default' }, default: { ...ai.chosen.default, profile: 'codemie:prod', fallback: null } };
  const row = rowOf(aiPanel(ai), 'briefing');
  assert.equal(firstOption(row, 'profile'), 'Same as Default (CodeMie · prod)');
  assert.equal(firstOption(row, 'fallback'), 'Same as Default (None)');
});

test('chooser_names_ollama', () => {
  assert.equal(CHOOSER_TITLE, 'Choose which AI writes for you');
  const { profiles } = aiStatus('all');
  const html = chooserBody(profiles.map(p => (p.provider === 'ollama' ? { ...p, defaultModel: 'llama3.2:latest' } : p)));
  assert.match(html, /data-profile="codemie:local-ollama"[\s\S]*?Ollama · llama3\.2:latest/);
  assert.match(html, /CodeMie profile · claude-sonnet-4-5/);
});
