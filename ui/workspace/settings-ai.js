// Settings › AI (DESIGN 6.1/6.2, profiles and models §4–§5). Pure: takes the loaded AI state,
// returns HTML and next settings. Which profile a row runs on is Rust's `choose` (`ai.chosen`);
// this file only draws it.
import { escapeHtml as e } from './store.js';
import { icon } from './icons.js';
import { badge, button, card, emptyState, select, settingRow, spinner } from './ui.js';

export const PRIVACY_NOTE = 'The message text you draft from is sent to this provider.';
export const LOGIN_STEPS = 'Open Terminal and run claude, then type /login';

/**
 * The rows of "What each job uses", in spec §2 order. `group`: the heading it is drawn under.
 * The row each one follows when it sets nothing is Rust's (`chosen[key].group`). Ask is hidden
 * until step 9.
 */
export const ROUTES = [
  { key: 'mail_draft', label: 'Mail replies', hint: 'Drafts for Outlook messages.', group: 'replies' },
  { key: 'chat_draft', label: 'Teams replies', hint: 'Drafts for Teams chats.', group: 'replies' },
  { key: 'summary', label: 'Summaries', hint: 'Thread and day summaries.', group: 'notes' },
  { key: 'meeting', label: 'Meeting notes', hint: 'Notes and summaries from transcripts.', group: 'notes' },
  { key: 'briefing', label: 'Morning briefing', hint: 'Automations made from the Morning briefing template.', group: 'automations' },
  { key: 'triage', label: 'Inbox triage', hint: 'Automations made from the Inbox triage template.', group: 'automations' },
  { key: 'commitments', label: 'Commitments', hint: 'Automations made from the Commitments template.', group: 'automations' },
  { key: 'automation', label: 'Automations', hint: 'Every other automation, unless it picks its own profile.', group: 'automations' },
  { key: 'ask', label: 'Ask', hint: 'Questions you type in ⌘K.', group: null, hidden: true },
  { key: 'plugin', label: 'All plugins', hint: 'Plugins without a choice of their own.', group: 'plugins' },
];
/** A row's name by key: "Inbox triage", "All plugins", and "Default" for the Default row. */
export const ROW_LABEL = { default: 'Default', ...Object.fromEntries(ROUTES.map(r => [r.key, r.label])) };
const GROUPS = [['replies', 'Replies'], ['notes', 'Summaries and notes'], ['automations', 'Automations'], [null, ''], ['plugins', 'Plugins']];
const PLUGIN_HINT = 'Your choice here wins over the profile the plugin asks for.';

/** CodeMie provider ids as people know them; anything else is shown as its id. */
export const PROVIDER_LABEL = {
  'ai-run-sso': 'CodeMie SSO', litellm: 'LiteLLM', bedrock: 'AWS Bedrock', ollama: 'Ollama',
  'anthropic-subscription': 'Anthropic subscription', 'moonshot-subscription': 'Moonshot subscription',
};
export const isOllama = p => p?.provider === 'ollama';

const STATE_CHIP = {
  ready: ['Ready', 'success', 'check'],
  needs_login: ['Needs sign-in', 'warning', 'alert'],
  not_installed: ['Not installed', 'neutral'],
  too_old: ['Too old', 'warning', 'alert'],
  not_configured: ['Not configured', 'warning', 'alert'],
  not_running: ['Not running', 'warning', 'alert'],
  checking: ['Checking…', 'info', 'refresh'],
  error: ['Error', 'error', 'alert'],
};
const STATE_TEXT = {
  ready: 'Ready to draft and summarize.',
  needs_login: 'Sign in before Connect can use this profile.',
  not_installed: 'This profile is not installed on this Mac.',
  too_old: 'This version is too old for AI features.',
  not_configured: 'This profile is not fully set up yet.',
  not_running: "Ollama isn't running. Open Ollama, then check again.",
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

// ---------------------------------------------------------------- working status per row (§4)

/** Ollama treats a name without a tag as `:latest`. */
const tagged = (p, id) => (isOllama(p) && id && !String(id).includes(':') ? `${id}:latest` : id);
const offers = (p, model) => !model || (p?.models || []).some(m => tagged(p, m.id) === tagged(p, model));

/**
 * A row's status from Rust's `chosen` for it (which carries the row's saved model) and the
 * profiles as drawn (after `withCodemieSignIn`), so a row and its profile card never disagree.
 * Never probes.
 */
export function routeState(chosen, profiles = []) {
  const id = chosen?.profile;
  if (!id) return { state: 'unset', text: 'Nothing runs until you choose one.', using: null };
  const p = profiles.find(x => x.id === id);
  const model = chosen.model || null;
  const name = shortLabel(profiles, id);
  let reason;
  if (!p) reason = `Connect has no AI profile “${id}”.`;
  else if (p.state !== 'ready') reason = p.message || STATE_TEXT[p.state] || STATE_TEXT.error;
  else if (!offers(p, model)) reason = `${name} doesn't offer ${model}.`;
  else {
    // No model: the name the row's Model select gives the profile's default ("Account default").
    const m = model ? (p.models || []).find(x => tagged(p, x.id) === tagged(p, model))?.label || model : modelOptions(p)[0][1];
    return { state: 'working', text: `${name} · ${m}`, using: id };
  }
  const f = chosen.fallback && chosen.fallback !== id ? profiles.find(x => x.id === chosen.fallback) : null;
  if (f?.state === 'ready') return { state: 'fallback', text: `Using ${shortLabel(profiles, f.id)}: ${reason}`, using: f.id };
  return { state: 'broken', text: reason, using: null };
}

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

/**
 * Next `settings.ai` after one control changed: only that field changes. `field`: default |
 * defaultModel | defaultFallback for the Default row, or profile | model | fallback on row
 * `purpose` (a purpose or `plugin:<id>`). Rust's save decides what a moved row's saved model
 * becomes (dropped when its new profile doesn't offer it, kept otherwise; ruling 13). Picking a
 * row's own fallback as its profile clears that fallback, which Rust would refuse as equal.
 */
export function nextAiSettings(settings, profiles, { field, purpose, value }) {
  const copy = rows => Object.fromEntries(Object.entries(rows || {}).map(([k, r]) => [k, { ...r }]));
  const next = {
    defaultProfile: settings.defaultProfile || null, defaultModel: settings.defaultModel || null, defaultFallback: settings.defaultFallback || null,
    routes: copy(settings.routes), plugins: copy(settings.plugins),
  };
  if (field === 'default') {
    next.defaultProfile = value || null;
    if (value && next.defaultFallback === value) next.defaultFallback = null;
  } else if (field === 'defaultModel') next.defaultModel = value || null;
  else if (field === 'defaultFallback') next.defaultFallback = value || null;
  else {
    const plugin = purpose.startsWith('plugin:');
    const rows = plugin ? next.plugins : next.routes;
    const r = rows[plugin ? purpose.slice(7) : purpose] ||= {};
    if (['profile', 'model', 'fallback'].includes(field)) r[field] = value || undefined;
    if (field === 'profile' && value && r.fallback === value) r.fallback = undefined;
  }
  for (const rows of [next.routes, next.plugins]) {
    for (const [k, r] of Object.entries(rows)) {
      const clean = Object.fromEntries(Object.entries(r).filter(([, v]) => v));
      if (Object.keys(clean).length) rows[k] = clean; else delete rows[k];
    }
  }
  return next;
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
  // Ollama is started and models are pulled in Ollama itself; Connect checks again.
  if (isOllama(p) && ['not_running', 'not_configured'].includes(p.state)) return `<div class="ws-actions">${again}</div>`;
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
    : [['Engine', isOllama(p) ? 'Ollama' : 'Claude'], ['Provider', p.provider ? PROVIDER_LABEL[p.provider] || p.provider : null], ['Default model', p.defaultModel]];
  const factList = facts.filter(([, v]) => v).map(([k, v]) => `<div><dt>${e(k)}</dt><dd>${e(v)}</dd></div>`).join('');
  const message = p.message || STATE_TEXT[p.state] || '';
  const testable = ['ready', 'needs_login', 'error'].includes(p.state);
  const model = ai.testModels?.[p.id] ?? '';
  const modelPicker = p.state === 'ready' ? `<label class="ws-ai-model"><span class="ws-field-label">Test with model</span>${select(modelOptions(p), model, { 'data-action': 'ai-test-model', 'data-profile': p.id, 'aria-label': `Model to test for ${p.label}` })}</label>` : '';
  const test = testable ? `<div class="ws-ai-test">${button('Test', { action: 'ai-test', iconName: 'play', attrs: { 'data-profile': p.id }, disabled: ai.tests?.[p.id]?.busy })}${testResult(ai.tests?.[p.id])}</div>` : '';
  return card({
    title: p.label, iconName: native ? 'spark' : isOllama(p) ? 'cpu' : 'tools', actions: chip(p.state), className: 'ws-ai-card',
    attrs: { 'data-ai-profile': p.id },
    body: `<p class="ws-ai-message">${e(message)}</p>
      ${factList ? `<dl class="ws-ai-facts">${factList}</dl>` : ''}
      ${stateAction(p)}
      ${modelPicker || test ? `<div class="ws-ai-controls">${modelPicker}${test}</div>` : ''}`,
  });
}

// ---------------------------------------------------------------- routing

const STATUS_CHIP = {
  working: ['Working', 'success', 'check'],
  fallback: ['Using fallback', 'warning', 'alert'],
  broken: ['Not working', 'error', 'alert'],
  unset: ['Choose a profile', 'neutral'],
};

/** Options for a profile select: `first`, then the ready profiles (less `except`), then `saved` when it isn't among them. */
function profileChoices(profiles, first, saved, except = null) {
  const ready = profiles.filter(p => p.state === 'ready' && p.id !== except);
  const options = [first, ...ready.map(p => [p.id, shortLabel(profiles, p.id)])];
  if (saved && !ready.some(p => p.id === saved)) {
    const p = profiles.find(x => x.id === saved);
    options.push([saved, p?.state === 'ready' ? shortLabel(profiles, saved) : `${shortLabel(profiles, saved)} (not ready)`]);
  }
  return options;
}

/** Model options for a row's profile, keeping a saved model it can't list right now (ruling 13). */
function modelChoices(profile, saved) {
  const options = modelOptions(profile);
  return saved && !options.some(([id]) => tagged(profile, id) === tagged(profile, saved)) ? [...options, [saved, saved]] : options;
}

function routeRow(r, { profiles, settings, chosen }) {
  const plugin = r.key.startsWith('plugin:');
  const saved = (plugin ? settings.plugins?.[r.key.slice(7)] : settings.routes?.[r.key]) || {};
  // A plugin row with nothing saved has no entry of its own: it runs as All plugins.
  const mine = chosen[r.key] || (plugin ? chosen.plugin : null) || {};
  const groupKey = chosen[r.key]?.group || (plugin ? 'plugin' : 'default');
  const group = chosen[groupKey] || {};
  const name = ROW_LABEL[groupKey] || groupKey;
  const same = id => `Same as ${name} (${id ? shortLabel(profiles, id) : 'None'})`;
  const profile = profiles.find(p => p.id === mine.profile);
  const attrs = field => ({ 'data-action': 'ai-route', 'data-route': r.key, 'data-field': field, 'aria-label': `${r.label}: ${field}` });
  const status = routeState(mine, profiles);
  const [chipText, tone, ico] = STATUS_CHIP[status.state];
  const again = status.state === 'broken' ? button('Check again', { action: 'ai-refresh', variant: 'ghost', size: 'sm', iconName: 'refresh' }) : '';
  return `<tr data-ai-route-row="${e(r.key)}"${r.hidden ? ' hidden' : ''}>
      <th scope="row" class="ws-ai-job"><strong>${e(r.label)}</strong><span>${e(r.hint)}</span></th>
      <td class="ws-ai-cell-profile">${select(profileChoices(profiles, ['', same(group.profile)], saved.profile), saved.profile || '', attrs('profile'))}</td>
      <td class="ws-ai-cell-model">${select(modelChoices(profile, saved.model), saved.model || '', { ...attrs('model'), disabled: !mine.profile })}</td>
      <td class="ws-ai-cell-fallback">${select(profileChoices(profiles, ['', same(group.fallback)], saved.fallback, mine.profile), saved.fallback || '', attrs('fallback'))}</td>
      <td class="ws-ai-cell-status" data-ai-route-state="${status.state}"><div class="ws-ai-status">${badge(chipText, tone, ico)}${again}</div><p class="ws-ai-status-text">${e(status.text)}</p></td>
    </tr>`;
}

/** "What each job uses": the Default row, then a row per job by group, one per AI plugin. */
function routesCard(ai, plugins) {
  const { profiles, settings } = ai;
  if (!profiles.some(p => p.state === 'ready')) {
    return card({ title: 'What each job uses', iconName: 'sliders', body: `<p class="ws-muted ws-hint" data-ai-routing-off>No profile is ready yet, so there is nothing to choose. Set one up above and check again.</p>` });
  }
  const current = settings.defaultProfile || null;
  const defaultProfile = profiles.find(p => p.id === current);
  const profileOptions = profileChoices(profiles, ['', 'Choose…'], current).filter(([id]) => id || !current);
  const fallbackOptions = profileChoices(profiles, ['', 'None'], settings.defaultFallback, current);
  const control = `<div class="ws-ai-default">
      ${select(profileOptions, current || '', { name: 'ai-default', 'data-action': 'ai-default', 'aria-label': 'Default: profile' })}
      ${select(modelChoices(defaultProfile, settings.defaultModel), settings.defaultModel || '', { 'data-action': 'ai-default', 'data-field': 'defaultModel', 'aria-label': 'Default: model', disabled: !current })}
      <label class="ws-ai-default-fallback"><span>Fallback</span>${select(fallbackOptions, settings.defaultFallback || '', { 'data-action': 'ai-default', 'data-field': 'defaultFallback', 'aria-label': 'Default: fallback' })}</label>
    </div>`;
  const pluginRows = plugins
    .filter(p => p?.enabled && (p.agreed || []).includes('claude'))
    .sort((a, b) => String(a.name || a.id).localeCompare(String(b.name || b.id)))
    .map(p => ({ key: `plugin:${p.id}`, label: p.name || p.id, hint: PLUGIN_HINT, group: 'plugins' }));
  const rows = [...ROUTES, ...pluginRows];
  const state = { ...ai, chosen: ai.chosen || {} };
  const bodies = GROUPS.map(([group, heading]) => {
    const own = rows.filter(r => r.group === group);
    if (!own.length) return '';
    const head = heading ? `<tr class="ws-ai-group"><th scope="rowgroup" colspan="5">${e(heading)}</th></tr>` : '';
    return `<tbody${own.every(r => r.hidden) ? ' hidden' : ''}>${head}${own.map(r => routeRow(r, state)).join('')}</tbody>`;
  }).join('');
  return card({
    title: 'What each job uses', iconName: 'sliders', className: 'ws-ai-routes',
    body: `${settingRow({ title: 'Default', text: 'Used for every job below unless you pick another.', control })}
      <div class="ws-ai-table-wrap"><table class="ws-ai-table"><thead><tr><th scope="col">Job</th><th scope="col">Profile</th><th scope="col">Model</th><th scope="col">Fallback</th><th scope="col">Status</th></tr></thead>${bodies}</table></div>
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

/**
 * Settings › AI. `codemie`: the CodeMie controller's sign-in state (`withCodemieSignIn`);
 * `plugins`: the installed plugins (a row for each enabled one with `claude` agreed).
 */
export function aiPanel(ai = {}, { codemie, plugins = [] } = {}) {
  if (ai.status === 'loading' || !ai.status || ai.status === 'idle') {
    return card({ body: `<div class="ws-ai-loading" role="status">${spinner('Checking your AI profiles')}<span>Checking your AI profiles…</span></div>` });
  }
  if (ai.status === 'error') {
    return card({ body: emptyState({ iconName: 'alert', title: 'Could not check your AI profiles', text: ai.error || 'Something went wrong while checking.', actions: button('Retry', { action: 'ai-refresh', variant: 'primary', iconName: 'refresh' }) }) });
  }
  const profiles = withCodemieSignIn(ai.profiles || [], codemie);
  const state = { ...ai, profiles, settings: ai.settings || { defaultProfile: null, routes: {} } };
  return `${profiles.map(p => profileCard(p, state)).join('')}${routesCard(state, plugins || [])}${usageCard(state)}`;
}
