// Settings → Claude (DESIGN 6.1/6.2). Pure: takes the loaded AI state, returns HTML and next settings.
import { escapeHtml as e } from './store.js';
import { icon } from './icons.js';
import { badge, button, card, emptyState, select, settingRow, spinner } from './ui.js';

export const PRIVACY_NOTE = 'The message text you draft from is sent to this provider.';
export const LOGIN_STEPS = 'Open Terminal and run claude, then type /login';

export const PURPOSES = [
  ['mail_draft', 'Mail replies', 'Drafts for Outlook messages.'],
  ['chat_draft', 'Teams replies', 'Drafts for Teams chats.'],
  ['summary', 'Summaries', 'Thread and day summaries.'],
  ['automation', 'Automations', 'Scheduled and rule-based work.'],
  ['plugin', 'Plugins', 'Plugins that ask Claude for help.'],
  ['meeting', 'Meeting notes', 'Notes and summaries from transcripts.'],
];

const STATE_CHIP = {
  ready: ['Ready', 'success', 'check'],
  needs_login: ['Needs sign-in', 'warning', 'alert'],
  not_installed: ['Not installed', 'neutral'],
  too_old: ['Too old', 'warning', 'alert'],
  not_configured: ['Not configured', 'warning', 'alert'],
  checking: ['Checking…', 'info', 'refresh'],
  error: ['Error', 'error', 'alert'],
};
const STATE_TEXT = {
  ready: 'Ready to draft and summarize.',
  needs_login: 'Sign in before Connect can use this profile.',
  not_installed: 'This profile is not installed on this Mac.',
  too_old: 'This version is too old for AI features.',
  not_configured: 'This profile is not fully set up yet.',
  checking: 'Checking this profile…',
  error: 'Connect could not check this profile.',
};

export const isNative = p => p?.kind?.type === 'native' || p?.id === 'claude';
const CODEMIE = 'codemie:';

/**
 * Detection calls a CodeMie profile ready once `codemie-claude` and the profile exist; its sign-in
 * is proved by the first run. Settings → CodeMie reads the active profile's sign-in
 * (`codemie profile status`), so a profile it found signed out is "Needs sign-in" here too, and
 * each CodeMie profile says whether it signs in with a browser (`codemieUrl`) or with a key.
 * `signIn`: the CodeMie controller's `signIn()` (`{ loaded, active, state, profiles: [{name, browser}] }`).
 */
export function withCodemieSignIn(profiles = [], signIn) {
  if (!signIn?.loaded) return profiles;
  const browser = new Map((signIn.profiles || []).map(x => [x.name, !!x.browser]));
  return profiles.map(p => {
    if (!String(p.id || '').startsWith(CODEMIE)) return p;
    const name = p.id.slice(CODEMIE.length);
    const out = browser.has(name) ? { ...p, browserSignIn: browser.get(name) } : p;
    if (p.state !== 'ready' || signIn.state !== 'not_signed_in' || signIn.active !== name) return out;
    return { ...out, state: 'needs_login', message: 'Its CodeMie sign-in expired. Sign in again to use it.' };
  });
}
const profileLabel = (profiles, id) => profiles.find(p => p.id === id)?.label || id;
const shortLabel = (profiles, id) => { const p = profiles.find(x => x.id === id); return !p ? id : isNative(p) ? 'Claude Code' : p.label; };

/** Model options for a profile: its own choices, with an empty "use the default" entry first. */
export function modelOptions(profile) {
  const models = (profile?.models || []).map(m => [m.id, m.label || m.id]);
  return models.some(([id]) => id === '') ? models : [['', 'Profile default'], ...models];
}

const seconds = ms => `${(Math.max(0, Number(ms) || 0) / 1000).toFixed(1)} s`;
export const money = n => `$${Number(n || 0).toFixed(Number(n || 0) >= 1 ? 2 : 4)}`;

export function testResultLabel(t) {
  if (!t.ok) return t.message || 'The test did not pass.';
  return ['OK', seconds(t.ms), t.costUsd != null ? money(t.costUsd) : ''].filter(Boolean).join(' · ');
}

/** Next `{defaultProfile, routes}` after one control changed. Models a profile does not offer are dropped. */
export function nextAiSettings(settings, profiles, { field, purpose, value }) {
  let defaultProfile = settings.defaultProfile || null;
  const routes = {};
  for (const [k, r] of Object.entries(settings.routes || {})) routes[k] = { ...r };
  if (field === 'default') defaultProfile = value || null;
  else {
    const r = routes[purpose] ||= {};
    if (field === 'profile') r.profile = value || undefined;
    if (field === 'model') r.model = value || undefined;
  }
  for (const [k, r] of Object.entries(routes)) {
    const profile = profiles.find(p => p.id === (r.profile || defaultProfile));
    if (r.model && !(profile?.models || []).some(m => m.id === r.model)) r.model = undefined;
    const clean = Object.fromEntries(Object.entries(r).filter(([, v]) => v));
    if (Object.keys(clean).length) routes[k] = clean; else delete routes[k];
  }
  return { defaultProfile, routes };
}

// ---------------------------------------------------------------- profile cards

function chip(state) {
  const [text, tone, ico] = STATE_CHIP[state] || STATE_CHIP.error;
  return badge(text, tone, ico);
}

function testResult(t) {
  if (!t) return '';
  if (t.busy) return `<span class="ws-ai-result">${spinner('Testing')}<span>Testing…</span></span>`;
  return `<span class="ws-ai-result ${t.ok ? 'ws-ai-ok' : 'ws-ai-bad'}" data-ai-test-result role="status">${icon(t.ok ? 'check-circle' : 'alert')}<span>${e(testResultLabel(t))}</span></span>`;
}

function stateAction(p) {
  const setup = button('Set up CodeMie', { action: 'cm-setup-open', variant: 'secondary', iconName: 'download' });
  const again = button('Check again', { action: 'ai-refresh', variant: 'ghost', iconName: 'refresh' });
  if (p.state === 'needs_login' && isNative(p)) {
    return `<div class="ws-ai-steps"><span>Open Terminal and run <code>claude</code>, then type <code>/login</code></span>${button('Copy', { action: 'ai-copy-login', iconName: 'link', size: 'sm' })}</div><div class="ws-actions">${again}</div>`;
  }
  // A CodeMie profile signs in again in the browser, from here (Settings → CodeMie's sign-in dialog).
  if (p.state === 'needs_login') {
    const name = String(p.id || '').replace(/^codemie:/, '');
    const manage = button('Manage profiles', { action: 'cm-tab', variant: 'ghost', attrs: { 'data-tab': 'cm-profiles' } });
    // A LiteLLM, Bedrock or subscription profile has no browser sign-in to offer.
    if (p.browserSignIn === false) return `<div class="ws-ai-steps"><span>This profile signs in with a key. Set it up again in Settings → CodeMie → Profiles.</span></div><div class="ws-actions">${manage}${again}</div>`;
    return `<div class="ws-actions">${button('Sign in', { action: 'cm-profile-login', variant: 'primary', iconName: 'link', attrs: { 'data-id': name } })}${manage}${again}</div>`;
  }
  if (p.state === 'too_old') return `<div class="ws-ai-steps"><span>Update Claude Code: open Terminal, run <code>claude update</code>, then check again.</span></div><div class="ws-actions">${isNative(p) ? '' : setup}${again}</div>`;
  if (p.state === 'not_installed' || p.state === 'not_configured') return `<div class="ws-actions">${setup}${again}</div>`;
  if (p.state === 'error' || p.state === 'checking') return `<div class="ws-actions">${button('Retry', { action: 'ai-refresh', variant: 'secondary', iconName: 'refresh' })}</div>`;
  return '';
}

function profileCard(p, ai) {
  const native = isNative(p);
  const a = p.account || {};
  const facts = native
    ? [['Version', p.version], ['Plan', a.plan], ['Signed in as', a.email]]
    : [['Provider', 'CodeMie'], ['Default model', p.defaultModel]];
  const factList = facts.filter(([, v]) => v).map(([k, v]) => `<div><dt>${e(k)}</dt><dd>${e(v)}</dd></div>`).join('');
  const message = p.message || STATE_TEXT[p.state] || '';
  const testable = ['ready', 'needs_login', 'error'].includes(p.state);
  const model = ai.testModels?.[p.id] ?? '';
  const modelPicker = p.state === 'ready' ? `<label class="ws-ai-model"><span class="ws-field-label">Test with model</span>${select(modelOptions(p), model, { 'data-action': 'ai-test-model', 'data-profile': p.id, 'aria-label': `Model to test for ${p.label}` })}</label>` : '';
  const test = testable ? `<div class="ws-ai-test">${button('Test', { action: 'ai-test', iconName: 'play', attrs: { 'data-profile': p.id }, disabled: ai.tests?.[p.id]?.busy })}${testResult(ai.tests?.[p.id])}</div>` : '';
  return card({
    title: p.label, iconName: native ? 'spark' : 'tools', actions: chip(p.state), className: 'ws-ai-card',
    attrs: { 'data-ai-profile': p.id },
    body: `<p class="ws-ai-message">${e(message)}</p>
      ${factList ? `<dl class="ws-ai-facts">${factList}</dl>` : ''}
      ${stateAction(p)}
      ${modelPicker || test ? `<div class="ws-ai-controls">${modelPicker}${test}</div>` : ''}`,
  });
}

// ---------------------------------------------------------------- routing

function defaultCard(ai) {
  const { profiles, settings } = ai;
  const ready = profiles.filter(p => p.state === 'ready');
  const current = settings.defaultProfile;
  const options = ready.map(p => [p.id, p.label]);
  if (current && !ready.some(p => p.id === current)) options.push([current, `${profileLabel(profiles, current)} (not ready)`]);
  if (!current) options.unshift(['', 'Choose…']);
  const control = select(options, current || '', { name: 'ai-default', 'data-action': 'ai-default', 'aria-label': 'Default Claude profile', disabled: !options.length });
  if (!ready.length) {
    return card({ title: 'Which Claude writes for you', iconName: 'sliders', body: `<p class="ws-muted ws-hint" data-ai-routing-off>No Claude is ready yet, so there is nothing to choose. Set one up above and check again.</p>` });
  }
  const rows = PURPOSES.map(([purpose, label, hint]) => {
    const route = settings.routes?.[purpose] || {};
    const effective = profiles.find(p => p.id === (route.profile || current));
    const profileOptions = [['', current ? `Default (${shortLabel(profiles, current)})` : 'Default']].concat(ready.map(p => [p.id, shortLabel(profiles, p.id)]));
    if (route.profile && !ready.some(p => p.id === route.profile)) profileOptions.push([route.profile, `${shortLabel(profiles, route.profile)} (not ready)`]);
    return `<tr data-ai-route-row="${e(purpose)}">
      <th scope="row"><strong>${e(label)}</strong><span>${e(hint)}</span></th>
      <td>${select(profileOptions, route.profile || '', { 'data-action': 'ai-route', 'data-route': purpose, 'data-field': 'profile', 'aria-label': `${label}: profile` })}</td>
      <td>${select(modelOptions(effective), route.model || '', { 'data-action': 'ai-route', 'data-route': purpose, 'data-field': 'model', 'aria-label': `${label}: model`, disabled: !effective })}</td>
    </tr>`;
  }).join('');
  return card({
    title: 'Which Claude writes for you', iconName: 'sliders',
    body: `${settingRow({ title: 'Default', text: 'Used for every task below unless you pick another.', control })}
      <div class="ws-ai-table-wrap"><table class="ws-ai-table"><caption class="ws-ai-caption">Use for</caption><thead><tr><th>Task</th><th>Profile</th><th>Model</th></tr></thead><tbody>${rows}</tbody></table></div>
      <p class="ws-inline-note">${icon('lock')}<span>${e(PRIVACY_NOTE)} Runs are isolated and tool-free, and Connect never sends a reply without your review.</span></p>`,
  });
}

function usageCard(ai) {
  const u = ai.usage;
  let body;
  if (!u) body = `<p class="ws-muted ws-hint">Usage is not available yet.</p>`;
  else if (!u.runs) body = `<p class="ws-muted ws-hint">No AI runs yet this month.</p>`;
  else {
    const rows = Object.entries(u.byProfile || {}).map(([id, r]) => `<div class="ws-source-row"><div><strong>${e(profileLabel(ai.profiles, id))}</strong><span>${e(r.runs)} run${r.runs === 1 ? '' : 's'}${id === 'claude' ? ' · Claude Code’s estimate' : ''}</span></div><span class="ws-mono">${e(money(r.costUsd))}</span></div>`).join('');
    body = `<div class="ws-ai-totals"><div><strong>${e(u.runs)}</strong><span>runs</span></div><div><strong>${e(money(u.costUsd))}</strong><span>estimated cost</span></div></div><div class="ws-source-list">${rows}</div>
      <p class="ws-muted ws-hint">On a Claude subscription the cost is Claude Code’s own estimate, not a charge.</p>`;
  }
  return card({ title: 'This month', iconName: 'chart', body, attrs: { id: 'ai-usage' } });
}

/** Settings → Claude. `codemie`: the CodeMie controller's sign-in state (`withCodemieSignIn`). */
export function aiPanel(ai = {}, { codemie } = {}) {
  if (ai.status === 'loading' || !ai.status || ai.status === 'idle') {
    return card({ body: `<div class="ws-ai-loading" role="status">${spinner('Checking Claude')}<span>Checking your Claude setup…</span></div>` });
  }
  if (ai.status === 'error') {
    return card({ body: emptyState({ iconName: 'alert', title: 'Could not check Claude', text: ai.error || 'Something went wrong while checking.', actions: button('Retry', { action: 'ai-refresh', variant: 'primary', iconName: 'refresh' }) }) });
  }
  const profiles = withCodemieSignIn(ai.profiles || [], codemie);
  const state = { ...ai, profiles, settings: ai.settings || { defaultProfile: null, routes: {} } };
  return `${profiles.map(p => profileCard(p, state)).join('')}${defaultCard(state)}${usageCard(state)}`;
}
