// Settings › Your voice (reply voice design §5, §6, §11, § Copy, § Accessibility): where the voice
// comes from (Off or a reply-context plugin) with its state line, the facts checkbox, the privacy
// line, the style card (its read-only head and the editable card), the instructions with their
// inline editor, the people index, Connect's copy, and the skill import preview that takes the
// instructions' place while it is open. Pure: voice-controller.js owns the actions and the view
// state (`state.voice`: the open editors, the import preview, busy flags); view-settings.js draws
// this as the `voice` tab. Default and Compact draw the same markup.
//
// Every provider, profile, rule, skill and style string goes through `escapeHtml`. Profile and
// about texts are never in the snapshot: the Profile dialog reads them with `voice_read`.
import { escapeHtml as e } from './store.js';
import { icon } from './icons.js';
import { button, card } from './ui.js';
import { agoLabel, dayKey, formatDateTime, formatTime } from './format.js';

/** The instruction kinds in matching order (design §4): [kind, choice, value label or null]. */
export const RULE_KINDS = [
  ['to', 'A person\'s address', 'Address'],
  ['chat', 'A Teams chat', 'Chat title'],
  ['domain', 'Anyone at a domain', 'Domain'],
  ['topic', 'A topic', 'Topic words'],
  ['no-profile', 'Anyone without a profile', null],
  ['everyone', 'Everyone', null],
];
/** "Only in": [channel ('' for both), choice]. */
export const RULE_CHANNELS = [['', 'Mail and Teams'], ['mail', 'Mail only'], ['teams', 'Teams only']];
const KIND_ORDER = RULE_KINDS.map(([kind]) => kind);
const valueLabel = kind => RULE_KINDS.find(([k]) => k === kind)?.[2] || null;

/** Off as the snapshot says it when nothing is chosen (also for a snapshot without the field). */
const OFF = { provider: 'off', name: null, state: 'off', available: [], facts: { on: true, offered: false }, refreshedAt: null, copy: false, style: null, rules: [], people: [] };

const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const slug = id => String(id).replace(/[^A-Za-z0-9_-]/g, '_');
const pluginId = provider => String(provider || '').replace(/^plugin:/, '');

/** The chosen provider's name: the snapshot's, its `available` entry's, the installed plugin's,
 *  or (while it loads and lists nothing) its id in sentence case. */
export function providerName(rv, info, plugins = []) {
  const id = pluginId(rv?.provider);
  return rv?.name || info?.name || plugins.find(p => p.id === id)?.name || (id ? id[0].toUpperCase() + id.slice(1) : '');
}

/** When the copy was made, as "<time>" reads in the copy lines: the time today, else the date and
 *  the time. */
export function copyTime(at, zone, now = Date.now()) {
  if (!at) return '';
  return dayKey(at, zone) === dayKey(now, zone) ? formatTime(at, zone) : formatDateTime(at, zone);
}

/** A rule's scope as its row names it: "To <address>", "In the chat “<title>”", … with
 *  " · mail only" / " · Teams only" when it is scoped to a channel. Not escaped. */
export function scopeLabel(applies = {}) {
  const v = applies.value ?? '';
  const base = {
    to: `To ${v}`, chat: `In the chat “${v}”`, domain: `Anyone at ${v}`, topic: `About “${v}”`,
    'no-profile': 'Anyone without a profile', everyone: 'Everyone',
  }[applies.kind] || 'Everyone';
  return base + channelSuffix(applies.channel);
}
const channelSuffix = channel => (channel === 'mail' ? ' · mail only' : channel === 'teams' ? ' · Teams only' : '');

/** What a row's buttons name ("Edit the instruction for priya.n@example.test"). */
const ruleTarget = applies => (['to', 'chat', 'domain', 'topic'].includes(applies?.kind) ? String(applies.value ?? '')
  : applies?.kind === 'no-profile' ? 'anyone without a profile' : 'everyone') + channelSuffix(applies?.channel);

/** The rules in matching order: by kind, channel-scoped first within a kind, then as given. */
export function sortRules(rules = []) {
  const rank = r => KIND_ORDER.indexOf(r.applies?.kind) * 2 + (r.applies?.channel ? 0 : 1);
  return rules.map((r, i) => [r, i]).sort((a, b) => rank(a[0]) - rank(b[0]) || a[1] - b[1]).map(([r]) => r);
}

/**
 * The chosen provider's state line (§ Copy): `ready` "Ready · <n> people · style card · <n>
 * instructions", `needs_setup`, `unavailable`, a plugin turned off, `loading`; '' for Off. `info`
 * is the provider's `available` entry. `opts`: `{now, zone, name}`.
 */
export function stateLine(rv, info, { now = Date.now(), zone, name } = {}) {
  const n = name || providerName(rv, info);
  if (info && info.on === false) return 'Turned off in Settings › Plugins';
  switch (rv?.state) {
    case 'loading': return `Starting ${n}…`;
    case 'needs_setup': return `Choose its folder in ${n} first.`;
    case 'unavailable': {
      const at = rv.copy ? copyTime(rv.refreshedAt, zone, now) : '';
      return at ? `${n} isn't answering. Drafts use Connect's copy from ${at}.` : `${n} isn't answering.`;
    }
    case 'ready':
      return `Ready · ${plural((rv.people || []).length, 'person', 'people')} · ${rv.style?.text ? 'style card' : 'no style card yet'} · ${plural((rv.rules || []).length, 'instruction')}`;
    default: return '';
  }
}

/** The style card's meta line: what it was built from (a channel with 0 left out) or "Written
 *  by you", and when it was updated. */
function styleMeta(style, zone, now) {
  const based = style.basedOn && typeof style.basedOn === 'object' ? style.basedOn : null;
  const parts = based ? [
    based.mail ? plural(based.mail, 'mail preview') : '',
    based.teams ? plural(based.teams, 'Teams message') : '',
  ].filter(Boolean) : [];
  const from = parts.length ? `From ${parts.join(' and ')}` : 'Written by you';
  const ago = style.updatedAt ? agoLabel(style.updatedAt, zone, now) : '';
  return ago ? `${from} · updated ${ago}` : from;
}

// ---------------------------------------------------------------- the card

/**
 * The whole tab: one card drawn from `s.replyVoice`. `ui` is the controller's view state plus
 * `{now, plugins}`: `style` (`{text, error}` while the card is edited), `rule` (`{id, scope,
 * value, channel, text, error}` while an instruction is added or edited), `import` (`{preview,
 * checked, busy, error, saving}` while the preview is open), `busy` (`{refresh, forget, provider}`),
 * `plugins` the installed list (a name while the provider loads).
 */
export function voiceCard(s, ui = {}) {
  const rv = { ...OFF, ...(s.replyVoice || {}) };
  const zone = s.settings?.timeZone;
  const now = ui.now ?? Date.now();
  const chosen = !!rv.provider && rv.provider !== 'off';
  const info = (rv.available || []).find(a => a.id === rv.provider);
  const name = chosen ? providerName(rv, info, ui.plugins || []) : '';
  const v = { rv, zone, now, chosen, info, name, ui };
  const body = [
    providerSection(v),
    styleSection(v),
    ui.import?.preview ? importPanel(ui.import.preview, ui.import) : instructionsSection(v),
    peopleSection(v),
    copyRow(v),
  ].filter(Boolean).join('');
  return card({ className: 'ws-voice-card', body });
}

function optionRow(a, v) {
  const off = a.id === 'off';
  const active = a.id === v.rv.provider || (off && !v.chosen);
  const turnedOff = !off && a.on === false;
  const label = off ? 'Off' : a.name || providerName({ provider: a.id }, a, v.ui.plugins || []);
  const line = off ? 'Drafts use only the conversation.'
    : turnedOff ? 'Turned off in Settings › Plugins'
      : active ? stateLine(v.rv, a, { now: v.now, zone: v.zone, name: v.name }) || 'Installed and on.'
        : 'Installed and on.';
  const descId = `ws-voice-state-${slug(a.id)}`;
  const input = `<input type="radio" name="voice-provider" value="${e(a.id)}" data-change="voice-provider" data-provider="${e(a.id)}"${active ? ' checked' : ''}${turnedOff && !active ? ' disabled' : ''} aria-describedby="${descId}">`;
  const busy = v.ui.busy?.turnOn;
  const action = turnedOff
    ? button(busy ? 'Turning on…' : 'Turn on', { action: 'voice-turn-on', size: 'sm', disabled: !!busy, attrs: { 'data-provider': a.id } })
    : active && v.rv.state === 'needs_setup' ? button(`Set up in ${label}`, { action: 'voice-setup', size: 'sm', attrs: { 'data-provider': a.id } }) : '';
  return `<div class="ws-voice-option">
    <label class="ws-ms-radio-card">${input}<span><strong>${e(label)}</strong><small id="${descId}">${e(line)}</small></span></label>
    ${action}
  </div>`;
}

/** Off, every installed reply-context plugin, and the chosen one even while it lists nothing
 *  (it is loading). */
function providerSection(v) {
  const listed = [...(v.rv.available || [])];
  if (v.chosen && !listed.some(a => a.id === v.rv.provider)) listed.push({ id: v.rv.provider, name: v.name });
  const options = [{ id: 'off' }, ...listed].map(a => optionRow(a, v)).join('');
  return `<div class="ws-voice-section ws-voice-where">
    <fieldset class="ws-voice-provider" data-voice-provider><legend class="ws-voice-legend">Where your voice comes from</legend><div class="ws-voice-options">${options}</div></fieldset>
    ${v.chosen ? factsRow(v) : ''}
    <p class="ws-muted ws-hint ws-voice-privacy">Connect keeps a copy on this Mac and adds the parts that fit to each reply draft, including drafts automations make. Facts are looked up for each draft and never kept. It goes only to the AI profile your Mail and Teams replies use (Settings › AI).</p>
  </div>`;
}

/** "Add facts from <name>" (only with a plugin chosen): disabled with "<name> doesn't look up
 *  facts." when the loaded provider offers no `facts` op. */
function factsRow(v) {
  const { info, name, rv } = v;
  const notOffered = !!info && info.on !== false && info.ready !== false && info.facts === false;
  const hint = notOffered ? `${name} doesn't look up facts.`
    : `Before each draft, Connect sends ${name} the names, codes and amounts it finds in the message, never the message, and adds the notes it finds.`;
  const checked = !notOffered && rv.facts?.on !== false;
  return `<div class="ws-voice-facts"><label class="ws-check"><input type="checkbox" data-voice-facts data-action="voice-facts"${checked ? ' checked' : ''}${notOffered ? ' disabled' : ''} aria-describedby="ws-voice-facts-hint"><span class="ws-check-box" aria-hidden="true">${icon('check')}</span><span class="ws-check-text"><span>${e(`Add facts from ${name}`)}</span><small id="ws-voice-facts-hint">${e(hint)}</small></span></label></div>`;
}

const offNote = 'Choose where your voice comes from first.';

function styleSection(v) {
  const { rv, ui, name, chosen } = v;
  const style = rv.style;
  const meta = style?.text ? `<span class="ws-voice-meta">${e(styleMeta(style, v.zone, v.now))}</span>` : '';
  const head = style?.head?.text
    ? `<div class="ws-voice-style-head" data-voice-style-head><p class="ws-voice-src">${e(`From your page ${style.head.source || ''} · edit it in ${name || 'its plugin'}`)}</p><p class="ws-voice-text">${e(style.head.text)}</p></div>`
    : '';
  let main;
  if (ui.style) {
    const err = ui.style.error ? `<p class="ws-field-error" id="ws-voice-style-error" role="alert">${e(ui.style.error)}</p>` : '';
    main = `<div class="ws-voice-editor">
      <label class="ws-field-label" for="ws-voice-style-text">Style card</label>
      <textarea class="ws-textarea ws-voice-area" id="ws-voice-style-text" data-voice-input="style" maxlength="8000" rows="10" spellcheck="true"${err ? ' aria-describedby="ws-voice-style-error"' : ''}>${e(ui.style.text ?? '')}</textarea>
      ${err}
      <div class="ws-actions">${button(ui.style.saving ? 'Saving…' : 'Save', { action: 'voice-save-style', variant: 'primary', size: 'sm', disabled: !!ui.style.saving })}${button('Cancel', { action: 'voice-cancel', variant: 'ghost', size: 'sm' })}</div>
    </div>`;
  } else {
    const shown = style?.text
      ? `<div class="ws-voice-text ws-voice-card-text" data-voice-style>${e(style.text)}</div>`
      : `<p class="ws-muted ws-hint">${e(name ? `No style card yet. Build one in ${name} from the messages you sent.` : 'No style card yet.')}</p>`;
    main = `${shown}<div class="ws-actions ws-voice-row-actions">${button('Edit', { action: 'voice-edit-style', size: 'sm', disabled: !chosen, title: chosen ? undefined : offNote, attrs: { 'aria-label': 'Edit the style card' } })}</div>`;
  }
  return `<section class="ws-voice-section" aria-labelledby="ws-voice-style-title">
    <div class="ws-voice-head"><h3 id="ws-voice-style-title">Style card</h3>${meta}</div>
    ${head}${main}
  </section>`;
}

/** The inline instruction editor (Add, or Edit in a row's place). */
function ruleEditor(r, saving) {
  const field = r.error?.field;
  const error = (which, id) => (field === which ? `<p class="ws-field-error" id="${id}" role="alert">${e(r.error.message)}</p>` : '');
  const label = valueLabel(r.scope);
  const appliesErr = error('applies', 'ws-voice-rule-applies-error');
  const textErr = error('text', 'ws-voice-rule-text-error');
  const other = r.error && !['applies', 'text'].includes(field) ? `<p class="ws-field-error" role="alert">${e(r.error.message)}</p>` : '';
  const options = (list, value) => list.map(([v, text]) => `<option value="${e(v)}"${String(v) === String(value ?? '') ? ' selected' : ''}>${e(text)}</option>`).join('');
  return `<div class="ws-voice-rule-editor" role="group" aria-label="${r.id ? 'Edit the instruction' : 'New instruction'}">
    <div class="ws-voice-rule-fields">
      <div class="ws-field"><label class="ws-field-label" for="ws-voice-rule-kind">Applies to</label><span class="ws-select-wrap"><select class="ws-select" id="ws-voice-rule-kind" data-change="voice-rule-kind"${!label && appliesErr ? ' aria-describedby="ws-voice-rule-applies-error"' : ''}>${options(RULE_KINDS, r.scope)}</select>${icon('chevron-down', 'ws-select-caret')}</span></div>
      ${label ? `<div class="ws-field"><label class="ws-field-label" for="ws-voice-rule-value">${e(label)}</label><input class="ws-input" type="text" id="ws-voice-rule-value" data-voice-input="rule-value" value="${e(r.value ?? '')}" autocomplete="off" spellcheck="false"${appliesErr ? ' aria-describedby="ws-voice-rule-applies-error"' : ''}></div>` : ''}
      <div class="ws-field"><label class="ws-field-label" for="ws-voice-rule-channel">Only in</label><span class="ws-select-wrap"><select class="ws-select" id="ws-voice-rule-channel" data-voice-input="rule-channel">${options(RULE_CHANNELS, r.channel)}</select>${icon('chevron-down', 'ws-select-caret')}</span></div>
    </div>
    ${appliesErr}
    <label class="ws-field-label" for="ws-voice-rule-text">What to do</label>
    <textarea class="ws-textarea ws-voice-area" id="ws-voice-rule-text" data-voice-input="rule-text" maxlength="2000" rows="3"${textErr ? ' aria-describedby="ws-voice-rule-text-error"' : ''}>${e(r.text ?? '')}</textarea>
    ${textErr}${other}
    <div class="ws-actions">${button(saving ? 'Saving…' : 'Save', { action: 'voice-save-rule', variant: 'primary', size: 'sm', disabled: !!saving })}${button('Cancel', { action: 'voice-cancel', variant: 'ghost', size: 'sm' })}</div>
  </div>`;
}

function ruleRow(rule, v) {
  const editing = v.ui.rule && v.ui.rule.id === rule.id;
  if (editing) return `<li class="ws-voice-rule ws-voice-rule-editing" data-voice-rule="${e(rule.id)}">${ruleEditor(v.ui.rule, v.ui.rule.saving)}</li>`;
  const target = ruleTarget(rule.applies);
  const actions = rule.editable === false
    ? `<span class="ws-voice-src">${e(`From ${rule.source || ''} · edit it in ${v.name || 'its plugin'}`)}</span>`
    : `<span class="ws-actions">${button('Edit', { action: 'voice-edit-rule', size: 'sm', variant: 'ghost', disabled: !v.chosen, attrs: { 'data-id': rule.id, 'aria-label': `Edit the instruction for ${target}` } })}${button('Delete', { action: 'voice-delete-rule', size: 'sm', variant: 'ghost', disabled: !v.chosen, attrs: { 'data-id': rule.id, 'aria-label': `Delete the instruction for ${target}` } })}</span>`;
  return `<li class="ws-voice-rule" data-voice-rule="${e(rule.id)}"><span class="ws-voice-scope">${e(scopeLabel(rule.applies))}</span><span class="ws-voice-text">${e(rule.text)}</span>${actions}</li>`;
}

function instructionsSection(v) {
  const { rv, ui, chosen } = v;
  const rules = sortRules(rv.rules || []);
  const adding = ui.rule && ui.rule.id === null;
  const importButton = button('Import from skills…', { action: 'voice-import', size: 'sm', disabled: !chosen, attrs: chosen ? {} : { 'aria-describedby': 'ws-voice-import-off' } });
  const add = button('Add', { action: 'voice-add-rule', size: 'sm', iconName: 'plus', disabled: !chosen || adding });
  const list = rules.length ? `<ul class="ws-voice-rules">${rules.map(r => ruleRow(r, v)).join('')}</ul>` : `<p class="ws-muted ws-hint">No instructions yet.</p>`;
  return `<section class="ws-voice-section" aria-labelledby="ws-voice-rules-title">
    <div class="ws-voice-head"><h3 id="ws-voice-rules-title">Instructions</h3><span class="ws-actions">${importButton}${add}</span></div>
    ${chosen ? '' : `<p class="ws-muted ws-hint" id="ws-voice-import-off">${offNote}</p>`}
    ${adding ? ruleEditor(ui.rule, ui.rule.saving) : ''}
    ${list}
  </section>`;
}

function peopleSection(v) {
  const people = v.rv.people || [];
  const row = p => {
    const where = p.addresses?.[0] || (Number(p.ids) > 0 ? 'Teams only' : '');
    return `<li class="ws-voice-person" data-voice-person="${e(p.id)}"><strong>${e(p.name)}</strong><span class="ws-muted">${e(where)}</span>${button('Profile', { action: 'voice-person', size: 'sm', variant: 'ghost', attrs: { 'data-id': p.id, 'aria-label': `Open ${p.name}'s profile` } })}</li>`;
  };
  return `<section class="ws-voice-section" aria-labelledby="ws-voice-people-title">
    <div class="ws-voice-head"><h3 id="ws-voice-people-title">People (${people.length})</h3></div>
    ${people.length ? `<ul class="ws-voice-people">${people.map(row).join('')}</ul>` : '<p class="ws-muted ws-hint">No people pages yet.</p>'}
  </section>`;
}

/** Connect's copy: when it was refreshed, Refresh now and Delete Connect's copy; with Off and a
 *  copy kept, "Off. Connect still keeps a copy from <time>."; nothing with Off and no copy. */
function copyRow(v) {
  const { rv, chosen, ui } = v;
  if (!chosen && !rv.copy) return '';
  const when = copyTime(rv.refreshedAt, v.zone, v.now);
  const line = !chosen ? `Off. Connect still keeps a copy from ${when}.`
    : rv.copy && rv.refreshedAt ? `Connect's copy · refreshed ${agoLabel(rv.refreshedAt, v.zone, v.now)}` : 'No copy yet.';
  const refresh = chosen ? button(ui.busy?.refresh ? 'Refreshing…' : 'Refresh now', { action: 'voice-refresh', size: 'sm', iconName: 'refresh', disabled: !!ui.busy?.refresh }) : '';
  const forget = rv.copy ? button('Delete Connect\'s copy', { action: 'voice-forget', size: 'sm', variant: 'danger', disabled: !!ui.busy?.forget }) : '';
  return `<div class="ws-voice-section ws-voice-copy"><span class="ws-muted">${e(line)}</span><span class="ws-actions">${refresh}${forget}</span></div>`;
}

// ---------------------------------------------------------------- the import preview

/** The preview's rows grouped by skill, in the order the scan gave them. */
function bySkill(items) {
  const groups = new Map();
  for (const item of items) {
    if (!groups.has(item.skill)) groups.set(item.skill, []);
    groups.get(item.skill).push(item);
  }
  return groups;
}

function distilButton(skill, busy) {
  return button(busy ? 'Shortening…' : 'Shorten with AI', {
    action: 'voice-import-distil', size: 'sm', variant: 'ghost', iconName: 'spark', disabled: !!busy,
    attrs: { 'data-skill': skill, 'aria-label': `Shorten ${skill} with AI`, 'aria-busy': busy ? 'true' : undefined },
  });
}

/**
 * The import preview (§ 11): `preview` is the scan's answer as the window keeps it (rows a
 * Shorten with AI replaced carry `ai: true`); `ui`: `{checked: {[key]: bool}, busy: {[skill]:
 * true}, error, saving}`. A region named by its title; each row a labelled checkbox; Shorten with
 * AI once per offered skill, on its last row or its Not imported row.
 */
export function importPanel(preview, ui = {}) {
  const items = preview.items || [];
  const skipped = preview.skipped || [];
  const offered = new Set(preview.ai || []);
  const checked = ui.checked || {};
  const busy = ui.busy || {};
  const ticked = items.filter(i => checked[i.key]).length;
  const folder = preview.folder || '';
  const rows = [];
  for (const [skill, group] of bySkill(items)) {
    group.forEach((item, n) => {
      const last = n === group.length - 1;
      const scope = scopeLabel(item.applies);
      const foot = [`From ${skill}`];
      if (item.ai) foot.push('Shortened by AI');
      else if (last && Number(item.total) > Number(item.kept)) foot.push(`Kept ${item.kept} of ${item.total} lines.`);
      rows.push(`<li class="ws-voice-import-row" data-voice-import-item="${e(item.key)}">
        <label class="ws-check"><input type="checkbox" data-action="voice-import-toggle" data-key="${e(item.key)}"${checked[item.key] ? ' checked' : ''} aria-label="${e(`Add the ${scope} instruction from ${skill}`)}"><span class="ws-check-box" aria-hidden="true">${icon('check')}</span></label>
        <div class="ws-voice-import-main"><span class="ws-voice-scope">${e(scope)}</span><span class="ws-voice-text">${e(item.text)}</span><small class="ws-voice-src">${e(foot.join(' · '))}</small></div>
        ${last && !item.ai && offered.has(skill) ? distilButton(skill, busy[skill]) : ''}
      </li>`);
    });
  }
  const skippedRows = skipped.map(s => `<li class="ws-voice-import-skip" data-voice-import-skipped="${e(s.skill)}"><strong>${e(s.skill)}</strong><span class="ws-muted">${e(s.reason)}</span>${offered.has(s.skill) ? distilButton(s.skill, busy[s.skill]) : ''}</li>`).join('');
  const found = Number(preview.found) || 0;
  const summary = found ? `Found ${plural(found, 'skill')}. ${plural(items.length, 'instruction')} to add.` : `No skills found in ${folder}.`;
  const error = ui.error ? `<p class="ws-field-error" role="alert">${e(ui.error)}</p>` : '';
  const save = button(ui.saving ? 'Adding…' : `Add ${plural(ticked, 'instruction')}`, { action: 'voice-import-save', variant: 'primary', size: 'sm', disabled: !ticked || !!ui.saving });
  return `<section class="ws-voice-section ws-voice-import" role="region" aria-labelledby="ws-voice-import-title">
    <div class="ws-voice-head"><h3 id="ws-voice-import-title" tabindex="-1">${e(`Import from skills · ${folder}`)}</h3></div>
    <p class="ws-muted ws-hint">${e(summary)}</p>
    ${rows.length ? `<ul class="ws-voice-import-rows">${rows.join('')}</ul>` : ''}
    ${skipped.length ? `<h4 class="ws-voice-subhead">Not imported (${skipped.length})</h4><ul class="ws-voice-import-skipped">${skippedRows}</ul>` : ''}
    ${offered.size ? '<p class="ws-muted ws-hint">Shorten with AI uses the AI profile your Mail replies use.</p>' : ''}
    ${error}
    <div class="ws-actions ws-voice-import-actions">${button('Cancel', { action: 'voice-import-cancel', variant: 'ghost', size: 'sm' })}${save}</div>
  </section>`;
}

// ---------------------------------------------------------------- what a save sends

/** `voice_save`'s input from an editor: `{style: text}` → the style card; `{rule: {id, scope,
 *  value, channel, text}}` → an instruction (`value` only for the kinds that take one, `channel`
 *  only when it is scoped). */
export function nextVoiceSave(form) {
  if (form.rule) {
    const r = form.rule;
    const applies = { kind: r.scope };
    if (valueLabel(r.scope)) applies.value = String(r.value ?? '').trim();
    if (r.channel === 'mail' || r.channel === 'teams') applies.channel = r.channel;
    return { kind: 'rule', id: r.id ?? null, applies, text: String(r.text ?? '').trim() };
  }
  return { kind: 'style', text: String(form.style ?? '') };
}

/** `voice_import`'s input: the ticked rows, each `{applies, text, from}` (from: its skill). */
export function nextVoiceImport(preview, ui = {}) {
  const checked = ui.checked || {};
  return { items: (preview.items || []).filter(i => checked[i.key]).map(i => ({ applies: i.applies, text: i.text, from: i.skill })) };
}
