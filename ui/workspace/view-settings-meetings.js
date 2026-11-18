// Settings › Meetings: Transcripts & folders, Note templates, Automatic rules, Glossary & tags
// and Tasks (spec "Settings › Meetings", prototype v5 view-settings.js). Pure: each panel takes
// the snapshot and the settings view state (`newMeetingsSettingsView`) and returns HTML; actions
// go to meetings-settings-controller.js as `meetings-settings-*`. Every person-supplied string is
// escaped; the live editors are in settings-meetings-editors.js.
import { escapeHtml as e } from './store.js';
import { icon } from './icons.js';
import { badge, button, card, checkbox, emptyState, field, select, settingRow, spinner, textInput, toggle } from './ui.js';
import { zonedParts } from './format.js';
import { COLUMNS, COLUMN_NAMES, columnName } from './tasks-model.js';
import { RULE_FIELDS, meetingItems, ruleMatches, ruleText, templatesOf, transcriptsAllowed, firstRule } from './meetings-model.js';
import { dotsSummary, menu, plural, tplColor } from './view-meeting-tabs.js';
import {
  SECTION_LABELS, fieldError, mdEditor, ruleTestResult, sortedRules, subCard, templateEditor, tplIcon,
} from './settings-meetings-editors.js';

/** The page's view state: the template being edited (`{id, isNew, draft}`), refusals by field,
 *  the glossary and tag texts as read (and typed), Write/Preview, the rule tester, and the
 *  latest document read for the editor. */
export const newMeetingsSettingsView = () => ({
  edit: null,
  errors: {},
  // Text a refusal kept in its field (by the same key as the refusal).
  drafts: {},
  texts: { glossary: null, tags: null },
  textsKey: '',
  textsAt: 0,
  mdTab: { glossary: 'write', tags: 'write' },
  test: { title: '', people: 3 },
  latest: {},
});

export const TAB_TEXT = {
  'meetings-transcripts': 'When Connect looks for Teams transcripts, where it saves them and what goes in each meeting folder.',
  'meetings-templates': 'A template tells the AI what to write from a transcript. Two are built in; add your own or a skill for the meetings that need something else.',
  'meetings-rules': 'Pick a template automatically by meeting title, organizer, company or size, and decide what happens without you.',
  'meetings-glossary': 'Two plain Markdown documents the AI reads before every run: how names and terms are spelled, and which tags notes may use.',
  'meetings-tasks': 'How tasks found in notes reach your board.',
};

const set = (key, checked, label) => toggle({ action: 'meetings-settings-set', checked: !!checked, attrs: { 'data-key': key, 'aria-label': label } });
/** A select over `options`, keeping a stored value the list doesn't name. */
const choose = (key, options, value, label, name = v => String(v)) => select(options.some(([v]) => String(v) === String(value)) ? options : [...options, [value, name(value)]], value, { 'data-action': 'meetings-settings-set', 'data-key': key, 'aria-label': label });
const row = (v, key, options) => `${settingRow(options)}${fieldError(v, `meetings.${key}`)}`;

// ---------------------------------------------------------------- folder names (folder.rs)

const pad = n => String(n).padStart(2, '0');
const ALNUM = /^[\p{Alphabetic}\p{N}]$/u;

/** folder.rs `slug`: lower case, every run of other characters one `-`, cut at 60, `meeting`
 *  when nothing is left. Letters of every script are kept. */
export function slug(title) {
  let out = '';
  let gap = false;
  for (const ch of [...String(title ?? '')].map(c => c.toLowerCase()).join('')) {
    if (ALNUM.test(ch)) {
      if (gap && out) out += '-';
      gap = false;
      out += ch;
    } else {
      gap = true;
    }
  }
  const cut = [...out].slice(0, 60).join('').replace(/^-+|-+$/g, '');
  return cut || 'meeting';
}

/** folder.rs `folder_name` for a meeting that started (or began transcribing) at `startMs`, in
 *  the workspace's time zone. */
export function folderName(startMs, title, pattern, zone) {
  const p = zonedParts(startMs, zone);
  const date = `${p.year}-${pad(p.month)}-${pad(p.day)}`;
  const s = slug(title);
  if (pattern === 'date-title') return `${date}-${s}`;
  if (pattern === 'title-date') return `${s}-${date}`;
  return `${date}_${pad(p.hour)}${pad(p.minute)}${pad(new Date(startMs).getUTCSeconds())}-${s}`;
}

const SAMPLE_TITLES = ['Philips CodeMie conversations syncup', 'Interview: Senior Python Engineer', 'Daily stand-up'];

/** Three meetings to show folder names with: your latest ones with a transcript, then examples. */
export function folderSamples(s, now = Date.now()) {
  const seen = new Set();
  const out = [];
  const mine = meetingItems(s, now).filter(m => m.rec && m.ended).sort((a, b) => b.start - a.start);
  for (const m of mine) {
    if (out.length === 3 || seen.has(m.title)) continue;
    seen.add(m.title);
    out.push({ title: m.title, start: Date.parse(m.rec.data?.transcriptStart) || m.start });
  }
  for (const [i, title] of SAMPLE_TITLES.entries()) if (out.length < 3 && !seen.has(title)) out.push({ title, start: Math.floor(now / 86_400_000 - i - 1) * 86_400_000 + (9 + 2 * i) * 3_600_000 + 1_234_000 });
  return out;
}

// ---------------------------------------------------------------- transcripts & folders

/** Whether Connect reads Teams transcripts: `signed-out`, `off`, `on`, or `ungranted` (asked for
 *  but Microsoft didn't grant the scopes, graph.rs `permitted`). */
export function transcriptAccess(s) {
  const c = s.connection;
  if (!c || c.status === 'disconnected') return 'signed-out';
  if (!transcriptsAllowed(s)) return 'off';
  const scopes = new Set((c.scopes || []).map(x => String(x).toLowerCase()));
  const granted = (scopes.has('onlinemeetings.read') || scopes.has('onlinemeetings.readwrite')) && scopes.has('onlinemeetingtranscript.read.all');
  return granted ? 'on' : 'ungranted';
}

const FILES = [
  ['transcript.vtt', 'Original from Teams, untouched', 'keepVtt'],
  ['transcript.md', 'Readable transcript, one line per speaker turn', null],
  ['segments.json · meeting.json · meta.json', 'Speaker turns, calendar details, where it came from', null],
  ['notes.md', 'The notes from the template you chose; other documents sit next to it', null],
  ['tasks.json', 'Tasks with owner, due date and the quote they came from', null],
  ['notes-history/', 'Earlier versions when you make notes again', 'keepVersions'],
  ['run.log', 'What each notes run did, or why it failed', null],
];
const PATTERNS = [['echo', 'Date, time and title', 'Same as Echo — sorts by time, unique to the second'], ['date-title', 'Date and title', 'Shorter; a number is added for a second meeting that day'], ['title-date', 'Title, then date', 'Groups a recurring meeting together']];

function transcriptsPanel(s, { v, auth = {}, now }) {
  const m = s.settings.meetings || {};
  const c = s.connection;
  const access = transcriptAccess(s);
  const pending = !!auth.authPending;
  const needsLogin = c && c.status !== 'connected' && c.status !== 'disconnected';
  const text = access === 'signed-out' ? 'Sign in to Microsoft 365 first: Connect reads transcripts with that sign-in.'
    : needsLogin ? 'Sign in to Microsoft 365 again to change this.'
      : access === 'on' ? `Connected as ${c.email || c.displayName}. Reads the transcripts of Teams meetings you attended (OnlineMeetingTranscript.Read.All). Meetings in other companies’ Teams may still refuse — Connect tells you which and why.`
        : 'Connect finds your Teams meetings and saves each transcript into its meeting folder. Microsoft asks you to allow it once.';
  const control = access === 'signed-out' ? button('Microsoft 365', { action: 'settings-tab', iconName: 'link', attrs: { 'data-tab': 'microsoft' } })
    : pending ? `<span class="ws-ms-pending">${spinner('Waiting for Microsoft')}<span>Finish in your browser</span></span>${button('Cancel', { action: 'graph-cancel', variant: 'ghost', size: 'sm' })}`
      : toggle({ action: 'meetings-settings-transcripts', checked: access === 'on', attrs: { 'aria-label': 'Read Teams transcripts', disabled: !!needsLogin } });
  const reason = access === 'on' || pending ? ''
    : auth.authError ? `<p class="ws-inline-note ws-error ws-ms-reason" role="alert">${icon('alert')}<span>Transcripts stay off: ${e(auth.authError)}</span></p>`
      : access === 'ungranted' ? `<p class="ws-inline-note ws-warning ws-ms-reason" role="alert">${icon('alert')}<span>Microsoft didn’t allow Connect to read transcripts. Your organization may have to approve it first; turn it on to ask again.</span></p>` : '';
  const transcripts = card({
    title: 'Teams transcripts', iconName: 'transcript',
    body: `${settingRow({ title: 'Read Teams transcripts', text, control })}${reason}
      ${row(v, 'checkEveryMin', { title: 'Look for transcripts', text: 'From 10 minutes after a Teams meeting ends, for a day. Each transcript is saved into its meeting folder as soon as Teams has it; nothing goes to the AI until notes are made.', control: choose('checkEveryMin', [[5, 'Every 5 minutes'], [10, 'Every 10 minutes'], [30, 'Every 30 minutes']], m.checkEveryMin ?? 10, 'Look for transcripts') })}
      ${row(v, 'autoNotes', { title: 'Make notes automatically', text: 'Uses the template its rule picks. Notes wait until the transcript appears.', control: choose('autoNotes', [['off', 'Never — I start them'], ['rules', 'When a rule says so'], ['all', 'For every meeting with a transcript']], m.autoNotes ?? 'rules', 'Make notes automatically') })}
      ${row(v, 'waitMin', { title: 'Wait after the meeting', text: 'Gives Teams time to finish the transcript and you time to add context.', control: choose('waitMin', [[0, 'Right away'], [15, '15 minutes'], [60, '1 hour']], m.waitMin ?? 15, 'Wait after the meeting', x => `${x} minutes`) })}
      ${row(v, 'skipShort', { title: 'Skip very short meetings', text: 'No automatic notes for meetings under 3 minutes or with almost no talking.', control: set('skipShort', m.skipShort !== false, 'Skip very short meetings') })}`,
  });
  const root = s.meetingsRoot || {};
  const zone = s.settings.timeZone;
  const pattern = PATTERNS.some(([p]) => p === m.folderPattern) ? m.folderPattern : 'echo';
  const samples = folderSamples(s, now);
  const folders = card({
    title: 'Meeting folders', iconName: 'folder',
    body: `<div class="ws-ms-location">
        <div class="ws-ms-location-path"><span class="ws-field-label">Location</span><span class="ws-ms-path-line"><code class="ws-ms-path" title="${e(root.path || '')}">${e(root.path || 'Your home folder › CodeMie Connect › Meetings')}</code>${root.isDefault !== false ? badge('Default', 'neutral') : ''}</span></div>
        <div class="ws-actions">${button('Change…', { action: 'meetings-settings-root-pick', size: 'sm', iconName: 'folder' })}${button('Show in Finder', { action: 'meetings-settings-root-reveal', variant: 'ghost', size: 'sm', iconName: 'folder-open' })}${root.isDefault === false ? button('Use the default', { action: 'meetings-settings-root-default', variant: 'ghost', size: 'sm', iconName: 'undo' }) : ''}</div>
      </div>
      ${fieldError(v, 'meetings.root')}
      <p class="ws-field-hint ws-ms-location-hint">New meetings are saved here. Meetings saved before keep their folders.</p>
      <div class="ws-ms-pattern">
        <span class="ws-field-label" id="ms-pattern-label">Folder name</span>
        <div class="ws-ms-options" role="radiogroup" aria-labelledby="ms-pattern-label">${PATTERNS.map(([value, label, hint]) => `<label class="ws-ms-radio-card"><input type="radio" name="folderPattern" value="${value}" data-change="meetings-settings-set" data-key="folderPattern"${value === pattern ? ' checked' : ''}><span><strong>${e(label)}</strong><small>${e(hint)}</small></span></label>`).join('')}</div>
        ${fieldError(v, 'meetings.folderPattern')}
        <div class="ws-ms-pattern-preview" aria-live="polite"><span class="ws-field-label">Preview</span>${samples.map(x => `<code>${e(`${folderName(x.start, x.title, pattern, zone)}/`)}</code>`).join('')}</div>
        <small class="ws-field-hint">Title in lowercase, anything that isn’t a letter or digit becomes “-”, cut at 60 characters. Two meetings with the same name get “-2”, “-3”.</small>
      </div>
      <div class="ws-ms-files">
        <span class="ws-field-label">In each folder</span>
        ${FILES.map(([name, what, key]) => `<div class="ws-ms-file-row"><code>${e(name)}</code><span>${e(what)}</span>${key ? set(key, m[key] !== false, key === 'keepVtt' ? 'Keep original .vtt' : 'Keep earlier versions') : '<small class="ws-muted">always</small>'}</div>${key ? fieldError(v, `meetings.${key}`) : ''}`).join('')}
      </div>`,
  });
  return transcripts + folders;
}

// ---------------------------------------------------------------- note templates

const kindBadge = t => (t.kind === 'skill' ? badge('Skill', 'purple', 'skill') : t.kind === 'custom' ? badge('Yours', 'info') : badge('Built-in', 'neutral'));

/** How a template is used: documents written with it and the rules that pick it. */
function usage(s, t, rules) {
  let notes = 0;
  for (const r of s.records || []) if (r.kind === 'meeting') notes += (r.data?.docs || []).filter(d => d.id === t.id || d.template === t.id).length;
  const by = rules.filter(r => r.template === t.id);
  return [notes ? `${plural(notes, 'note')} written` : '', by.length ? `rule: ${by.map(ruleText).join(', ')}` : ''].filter(Boolean).join(' · ');
}

function templateCard(s, t, { def, rules }) {
  const ids = { 'data-id': t.id };
  const items = [
    ['Edit', 'meetings-settings-tpl-edit', ids, 'edit'],
    ['Duplicate', 'meetings-settings-tpl-dup', ids, 'copy'],
    t.id !== def ? ['Make default', 'meetings-settings-tpl-default', ids, 'check'] : null,
    t.kind === 'builtin' && t.edited ? ['Reset to built-in', 'meetings-settings-tpl-reset', ids, 'undo'] : null,
    t.kind !== 'builtin' ? '-' : null,
    t.kind !== 'builtin' ? [t.kind === 'skill' ? 'Remove skill' : 'Delete', 'meetings-settings-tpl-delete', ids, 'trash', true] : null,
  ];
  const sections = (t.sections || []).filter(x => x !== 'frontmatter');
  const chips = `${sections.slice(0, 6).map(x => `<span>${e(SECTION_LABELS[x] || x)}</span>`).join('')}${sections.length > 6 ? `<span>+${sections.length - 6}</span>` : ''}${t.extractTasks !== false ? `<span class="ws-ms-sec-tasks">${icon('tasks')}tasks</span>` : ''}`;
  const used = usage(s, t, rules) || 'Not used yet';
  const foot = t.kind === 'skill' ? `${icon('skill')}<span>${e(t.skillPath || '')}</span>` : `<span>${e(used)}</span>`;
  return `<article class="ws-ms-tpl-card" style="--tpl:${tplColor(t)}" data-template="${e(t.id)}">
    <header><span class="ws-tpl-icon">${icon(tplIcon(t))}</span><div><strong>${e(t.name)}</strong><span class="ws-ms-tpl-badges">${t.id === def ? badge('Default', 'success') : ''}${kindBadge(t)}${t.edited ? badge('Edited', 'warning') : ''}</span></div>
      ${menu(`ms-tpl-${t.id}`, dotsSummary(`More for ${t.name}`, 'ws-btn-sm'), items)}</header>
    <p>${t.blurb ? e(t.blurb) : '<span class="ws-faint">No description yet.</span>'}</p>
    ${chips ? `<div class="ws-ms-tpl-sections">${chips}</div>` : ''}
    <footer><small class="ws-muted" title="${e(t.kind === 'skill' ? t.skillPath || '' : used)}">${foot}</small>${button(t.kind === 'skill' ? 'Settings' : 'Edit', { action: 'meetings-settings-tpl-edit', size: 'sm', variant: 'ghost', iconRight: 'arrow', className: 'ws-ms-tpl-open', attrs: ids })}</footer>
  </article>`;
}

function templatesPanel(s, ctx) {
  const { v } = ctx;
  if (v.edit) return templateEditor(s, v, { ...ctx, tryable: tryableMeetings(s, ctx.now).length });
  const all = templatesOf(s);
  const def = (s.settings.meetings || {}).defaultTemplate || 'meeting-notes';
  const rules = sortedRules(s);
  const groups = [['builtin', 'Built-in'], ['custom', 'Yours'], ['skill', 'Skills']].map(([kind, label]) => {
    const list = all.filter(t => t.kind === kind);
    if (!list.length) return '';
    return `<h3 class="ws-ms-group-title">${e(label)}<small>${list.length}</small></h3><div class="ws-ms-tpl-grid">${list.map(t => templateCard(s, t, { def, rules })).join('')}</div>`;
  }).join('');
  return `<div class="ws-ms-naming">${icon('info', 'ws-ms-naming-icon')}<div><strong>What’s a note template?</strong><p>The instructions the AI follows to turn a transcript into a document. <em>Meeting notes</em> is your reference format and runs by default; <em>Short summary</em> is the quick version. Add <em>your own</em> or a <em>skill</em> for anything else. One transcript can have several documents — the automatic meeting notes plus any summary you make on demand.</p></div></div>
    ${card({ body: row(v, 'defaultTemplate', { title: 'Default template', text: 'Used when you haven’t picked one for a meeting and no rule matches.', control: defaultSelect(s, 'Default template') }) })}
    ${groups}`;
}

const defaultSelect = (s, label) => {
  const def = (s.settings.meetings || {}).defaultTemplate || 'meeting-notes';
  return choose('defaultTemplate', templatesOf(s).map(t => [t.id, t.name]), def, label, () => 'A template that is gone');
};

/** Meetings Try on a meeting can use: a transcript is there (or is being saved). */
export function tryableMeetings(s, now = Date.now()) {
  return meetingItems(s, now).filter(m => ['available', 'downloaded', 'ready', 'failed'].includes(m.state)).sort((a, b) => b.start - a.start);
}

// ---------------------------------------------------------------- automatic rules

const FIELD_LABELS = Object.entries(RULE_FIELDS).map(([value, label]) => [value, label[0].toUpperCase() + label.slice(1)]);
const PLACEHOLDERS = { title: 'e.g. stand-up', organizer: 'name or e-mail', org: 'e.g. philips', people: 'e.g. 2' };

function ruleRow(s, r, i, list, { v, items }) {
  const all = templatesOf(s);
  const known = all.some(t => t.id === r.template);
  const options = [...all.map(t => [t.id, t.name]), ...(known ? [] : [[r.template, 'A template that is gone']])];
  const hits = r.value ? items.filter(m => ruleMatches(r, m.ev.data)) : [];
  const taken = hits.filter(m => firstRule(list, m.ev.data)?.id !== r.id).length;
  const titles = [...new Set(hits.map(m => m.title))];
  const note = !String(r.value || '').trim() ? 'Type what to look for.'
    : r.field === 'people' && !/^\+?\d+$/.test(String(r.value).trim()) ? 'Type a number of people.'
      : hits.length ? `Matches ${plural(hits.length, 'meeting')} in your calendar: ${titles.slice(0, 2).join(', ')}${titles.length > 2 ? '…' : ''}${taken ? ` · ${taken} taken by an earlier rule` : ''}`
        : 'No meetings in your calendar match yet.';
  const id = { 'data-id': r.id };
  return `<div class="ws-ms-rule${r.on === false ? ' ws-ms-rule-off' : ''}" data-rule="${e(r.id)}">
    <span class="ws-ms-rule-n" aria-hidden="true">${i + 1}</span>
    <div class="ws-ms-rule-main">
      <div class="ws-ms-rule-when"><span class="ws-ms-rule-word">When</span>
        ${select(FIELD_LABELS, r.field, { 'data-action': 'meetings-settings-rule-set', 'data-id': r.id, 'data-k': 'field', 'aria-label': `Rule ${i + 1}: what it looks at` })}
        <input class="ws-input ws-ms-rule-value" data-commit="meetings-settings-rule-value" data-id="${e(r.id)}" value="${e(v.drafts?.[`rule.${r.id}.value`] ?? r.value)}" maxlength="200" placeholder="${e(PLACEHOLDERS[r.field] || '')}"${r.field === 'people' ? ' inputmode="numeric"' : ''} aria-label="Rule ${i + 1}: value" autocomplete="off" spellcheck="false">
        <span class="ws-ms-rule-word">use</span>
        ${select(options, r.template, { 'data-action': 'meetings-settings-rule-set', 'data-id': r.id, 'data-k': 'template', 'aria-label': `Rule ${i + 1}: template` })}
      </div>
      ${fieldError(v, `rule.${r.id}.value`)}${fieldError(v, `rule.${r.id}.field`)}${fieldError(v, `rule.${r.id}.template`)}
      <div class="ws-ms-rule-opts">${checkbox({ action: 'meetings-settings-rule-flag', checked: !!r.autoNotes, label: 'Make notes automatically', attrs: { ...id, 'data-k': 'autoNotes' } })}<small class="ws-muted">${e(note)}</small></div>
    </div>
    <div class="ws-ms-rule-act">
      ${button('', { action: 'meetings-settings-rule-move', iconName: 'chevron-up', variant: 'ghost', size: 'sm', title: 'Move up', disabled: i === 0, attrs: { ...id, 'data-d': '-1' } })}
      ${button('', { action: 'meetings-settings-rule-move', iconName: 'chevron-down', variant: 'ghost', size: 'sm', title: 'Move down', disabled: i === list.length - 1, attrs: { ...id, 'data-d': '1' } })}
      ${toggle({ action: 'meetings-settings-rule-flag', checked: r.on !== false, attrs: { ...id, 'data-k': 'on', 'aria-label': `Rule ${i + 1} on` } })}
      ${button('', { action: 'meetings-settings-rule-delete', iconName: 'trash', variant: 'ghost', size: 'sm', title: 'Delete rule', attrs: id })}
    </div>
  </div>`;
}

function rulesPanel(s, ctx) {
  const { v, now } = ctx;
  const list = sortedRules(s);
  const items = meetingItems(s, now).filter(m => m.ev && m.online);
  const rows = list.map((r, i) => ruleRow(s, r, i, list, { v, items })).join('');
  const rules = subCard({
    title: 'Rules', iconName: 'automations', sub: 'The first rule that matches wins. A template you pick for one meeting always beats a rule.',
    body: `<div class="ws-ms-rules">${rows || emptyState({ iconName: 'automations', title: 'No rules', text: 'Every meeting uses your default template.' })}</div>
      <div class="ws-ms-rule ws-ms-rule-default"><span class="ws-ms-rule-n" aria-hidden="true">${icon('arrow')}</span><div class="ws-ms-rule-main"><div class="ws-ms-rule-when"><span class="ws-ms-rule-word">Otherwise use</span>${defaultSelect(s, 'Otherwise use')}</div>${fieldError(v, 'meetings.defaultTemplate')}</div></div>`,
  });
  const t = v.test || { title: '', people: 3 };
  const tester = subCard({
    title: 'Try a meeting', iconName: 'search', sub: 'See which template a meeting would get.',
    body: `<div class="ws-ms-rule-test">
      <label class="ws-field"><span class="ws-field-label">Title</span><input class="ws-input" data-ms-input="test-title" value="${e(t.title)}" placeholder="e.g. Daily stand-up" autocomplete="off"></label>
      <label class="ws-field"><span class="ws-field-label">People</span><input class="ws-input" type="number" min="1" max="500" data-ms-input="test-people" value="${e(t.people)}"></label>
      ${ruleTestResult(s, t)}
    </div>`,
  });
  return rules + tester;
}

// ---------------------------------------------------------------- glossary & tags

function glossaryPanel(s, { v }) {
  const m = s.settings.meetings || {};
  const linked = m.glossarySource === 'file';
  const source = (value, title, text) => `<label class="ws-ms-radio-card"><input type="radio" name="glossarySource" value="${value}" data-change="meetings-settings-set" data-key="glossarySource"${(value === 'file') === linked ? ' checked' : ''}><span><strong>${e(title)}</strong><small>${e(text)}</small></span></label>`;
  const path = (key, label, example) => `${field(label, textInput({ 'data-commit': 'meetings-settings-field', 'data-key': key, value: v.drafts?.[`meetings.${key}`] ?? (m[key] || ''), placeholder: example, spellcheck: 'false', autocomplete: 'off', class: 'ws-input ws-ms-mono' }))}${fieldError(v, `meetings.${key}`)}`;
  const where = card({
    body: `<div class="ws-ms-source">
      <span class="ws-field-label" id="ms-source-label">Where these live</span>
      <div class="ws-ms-options ws-ms-two" role="radiogroup" aria-labelledby="ms-source-label">${source('connect', 'Here in Connect', 'Two Markdown files in your meetings folder, edited on this page.')}${source('file', 'Files I already keep', 'Point at your own Markdown, e.g. the twin knowledge base’s TERMS_TAXONOMY.md and TAG_TAXONOMY.md.')}</div>
      ${fieldError(v, 'meetings.glossarySource')}
      ${linked ? `<div class="ws-ms-paths">${path('glossaryFile', 'Glossary file', '/Users/you/knowledge/TERMS_TAXONOMY.md')}${path('tagsFile', 'Tags file', '/Users/you/knowledge/TAG_TAXONOMY.md')}<small class="ws-field-hint">Full paths of Markdown files. Connect reads them before every run and never changes them.</small></div>` : ''}
    </div>`,
  });
  const speakers = card({
    title: 'Speakers', iconName: 'users',
    body: `${row(v, 'weMe', { title: '“We will…” becomes your task', text: 'When the team takes something on without naming anyone, the task goes to you (the name under “## Me”).', control: set('weMe', m.weMe !== false, '“We will…” becomes your task') })}
      ${row(v, 'askSpeakers', { title: 'Ask me to name unknown speakers', text: 'Guests from other companies often show up as “Speaker 1”. Connect asks before making notes so tasks get the right owner.', control: set('askSpeakers', m.askSpeakers !== false, 'Ask me to name unknown speakers') })}`,
  });
  return `${where}${mdEditor('glossary', s, v)}${mdEditor('tags', s, v)}${speakers}`;
}

// ---------------------------------------------------------------- tasks

const COLUMN_TONE = { review: 'purple', todo: 'muted', doing: 'blue', waiting: 'amber', done: 'green' };

function tasksPanel(s, { v }) {
  const m = s.settings.meetings || {};
  const review = columnName('review', s.settings);
  const todo = columnName('todo', s.settings);
  const fromNotes = card({
    title: 'Tasks from notes', iconName: 'sparkles',
    body: `${row(v, 'review', { title: 'Review before they reach the board', text: `New tasks wait in “${review}” so you can fix an owner or a date first. Turn off to send them straight to “${todo}”.`, control: set('review', m.review !== false, 'Review before they reach the board') })}
      ${row(v, 'onlyAttendees', { title: 'Only assign to people in the meeting', text: 'If the transcript names someone who wasn’t there, the task stays unassigned.', control: set('onlyAttendees', m.onlyAttendees !== false, 'Only assign to people in the meeting') })}
      ${row(v, 'dueOnlySaid', { title: 'Due dates only when someone said one', text: '“By Friday” becomes a date; a vague “soon” stays empty instead of a guess.', control: set('dueOnlySaid', m.dueOnlySaid !== false, 'Due dates only when someone said one') })}`,
  });
  const board = card({
    title: 'Board', iconName: 'board',
    body: `<span class="ws-field-label">Column names</span>
      <div class="ws-ms-col-names">${COLUMNS.map(c => `<div class="ws-ms-col"><label class="ws-ms-col-name"><span class="ws-ms-col-swatch" style="--col:var(--ws-${COLUMN_TONE[c]})"></span><input class="ws-input" data-commit="meetings-settings-field" data-key="columns.${c}" value="${e(v.drafts?.[`meetings.columns.${c}`] ?? columnName(c, s.settings))}" placeholder="${e(COLUMN_NAMES[c])}" maxlength="40" aria-label="Name of the ${e(COLUMN_NAMES[c])} column" autocomplete="off"></label>${fieldError(v, `meetings.columns.${c}`)}</div>`).join('')}</div>
      <small class="ws-field-hint ws-ms-col-hint">Leave one empty to use its usual name.</small>
      ${row(v, 'doneDays', { title: 'Hide done tasks after', text: 'They stay in the meeting and in tasks.json.', control: choose('doneDays', [[7, '7 days'], [14, '14 days'], [30, '30 days']], m.doneDays ?? 14, 'Hide done tasks after', x => `${x} days`) })}
      ${row(v, 'remind', { title: 'Remind me about tasks due today', text: 'A desktop notification at 09:00 with what you owe today.', control: set('remind', m.remind !== false, 'Remind me about tasks due today') })}`,
  });
  return fromNotes + board;
}

// ---------------------------------------------------------------- the page

const PANELS = { 'meetings-transcripts': transcriptsPanel, 'meetings-templates': templatesPanel, 'meetings-rules': rulesPanel, 'meetings-glossary': glossaryPanel, 'meetings-tasks': tasksPanel };

/** One Settings › Meetings tab. `ctx`: `{v, auth, now}`. */
export function meetingsSettingsPanel(tab, s, ctx = {}) {
  const panel = PANELS[tab] || transcriptsPanel;
  return panel(s, { v: ctx.v || newMeetingsSettingsView(), auth: ctx.auth || {}, now: ctx.now ?? Date.now() });
}

/** The header of a Meetings tab: its actions, or, in the template editor, the way back and the
 *  template's name. */
export function meetingsSettingsHeader(tab, s, v) {
  if (tab === 'meetings-templates' && v?.edit) {
    return {
      label: v.edit.draft.name || 'New template',
      back: `<button type="button" class="ws-link ws-mtg-linkbtn ws-ms-back" data-action="meetings-settings-tpl-close">${icon('chevron-left')}Note templates</button>`,
      description: '',
      actions: '',
    };
  }
  const actions = tab === 'meetings-templates'
    ? `${button('Add a skill', { action: 'meetings-settings-skill-add', iconName: 'skill' })}${button('New template', { action: 'meetings-settings-tpl-new', variant: 'primary', iconName: 'plus' })}`
    : tab === 'meetings-rules' ? button('Add rule', { action: 'meetings-settings-rule-add', variant: 'primary', iconName: 'plus' }) : '';
  return { label: null, back: '', description: TAB_TEXT[tab], actions };
}
