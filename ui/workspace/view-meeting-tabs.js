// The meeting's panes on the Meetings page (the summary; Transcript, Notes, Files and Action items
// behind ⋯), the people popover, the explainers for meetings without a transcript, the template
// chip and the Make notes form the dialog and the Notes pane share. Pure: each takes the page (`p`, see view-meetings.js) and one
// meeting's context (`meetingContext`) and returns HTML; every meeting- or transcript-sourced
// string is escaped, notes Markdown goes through markdown.js.
import { escapeHtml as e } from './store.js';
import { icon } from './icons.js';
import { avatar, badge, button, card, emptyState, toggle } from './ui.js';
import { agoLabel, durationLabel, formatTime } from './format.js';
import { renderMarkdown } from './markdown.js';
import { columnName, dueInfo, isMine, meOf, ownerOf, peopleFor, taskStatus } from './tasks-model.js';
import { hasTranscript, meetingErrors, meetingTasks, peopleOf, resolveTemplate, ruleText, templatesOf } from './meetings-model.js';
import { defaultTicks, itemsOf, ownerLine } from './meeting-view-model.js';

export const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const option = (value, label, selected) => `<option value="${e(value)}"${selected ? ' selected' : ''}>${e(label)}</option>`;
export const selectBox = (attrs, options, cls = '') => `<span class="ws-select-wrap${cls ? ` ${cls}` : ''}"><select class="ws-select" ${attrs}>${options}</select>${icon('chevron-down', 'ws-select-caret')}</span>`;
const attr = (k, v) => ` ${k}="${e(v)}"`;
const COLOR = /^#[0-9a-f]{3,8}$/i;
/** A template's colour for `--tpl` (only a plain hex colour gets through). */
export const tplColor = t => (COLOR.test(String(t?.color || '')) ? t.color : '#5677C8');
/** The icon a template shows: a skill's own, else one of the template icons (a note by default). */
export const tplIcon = t => (t?.kind === 'skill' ? 'skill' : ['note', 'list', 'users', 'sparkles', 'quote', 'tasks', 'transcript'].includes(t?.icon) ? t.icon : 'note');

/** One item of a ⋯ menu: `[label, action, attrs, icon, danger]`; `'-'` is a divider, `['#', text]` a heading. */
export function menuItems(items) {
  return items.filter(Boolean).map(it => {
    if (it === '-') return '<hr>';
    if (it[0] === '#') return `<div class="ws-menu-label">${e(it[1])}</div>`;
    const [label, action, attrs = {}, ico, danger] = it;
    const checked = attrs['aria-checked'] === 'true';
    return `<button type="button" class="ws-menu-item${danger ? ' ws-menu-danger' : ''}${checked ? ' ws-mtg-menu-on' : ''}" data-action="${e(action)}"${Object.entries(attrs).map(([k, v]) => attr(k, v)).join('')}${checked ? ' role="menuitemradio"' : ''}>${ico ? icon(ico) : '<span class="ws-mtg-menu-pad"></span>'}<span>${e(label)}</span>${checked ? icon('check', 'ws-mtg-menu-tick') : ''}</button>`;
  }).join('');
}

/** A ⋯ menu (`details.ws-menu`, one open at a time; Escape returns to its button). */
export function menu(id, summary, items, { right = true, cls = '' } = {}) {
  return `<details class="ws-menu${right ? ' ws-menu-right' : ''}${cls ? ` ${cls}` : ''}" data-menu="${e(id)}">${summary}<div class="ws-menu-panel">${menuItems(items)}</div></details>`;
}
export const dotsSummary = (title, extra = '') => `<summary class="ws-btn ws-btn-ghost ws-btn-icon${extra ? ` ${extra}` : ''}" aria-label="${e(title)}" title="${e(title)}">${icon('dots')}</summary>`;

// ---------------------------------------------------------------- a meeting's context

/** Everything a meeting's views need, computed once: its event or record data `d`, record data
 *  `r`, template choice, documents, tasks, people, and what has been read of its folder. */
export function meetingContext(p, m) {
  const d = m.ev?.data || m.rec?.data || {};
  const r = m.rec?.data || {};
  const docs = Array.isArray(r.docs) ? r.docs : [];
  const tasks = p.tasksBy ? p.tasksBy.get(m.id) || [] : meetingTasks(p.s, m.id);
  const data = (p.reads && p.reads(m.id)) || {};
  const errors = meetingErrors(r);
  const pendingTpl = r.pendingNotes?.templateId ? templatesOf(p.s).find(t => t.id === r.pendingNotes.templateId) || null : null;
  return {
    m, d, r, docs, tasks, data,
    // Why the last save from Teams failed, and why the last notes run did: each has its own way on.
    saveError: errors.save, notesError: errors.notes,
    // The template of the notes asked for while the save failed: made after the transcript.
    pending: pendingTpl,
    connected: p.s.connection?.status === 'connected',
    paused: m.paused || null,
    tpl: resolveTemplate(m.ev, m.rec, p.s, p.rules),
    main: docs.find(x => x.id === r.main) || docs[0] || null,
    review: tasks.filter(t => taskStatus(t) === 'review'),
    people: peopleOf(p.s, d),
    segments: Array.isArray(data.transcript?.segments) ? data.transcript.segments : null,
    saved: ['downloaded', 'ready', 'failed'].includes(m.state),
    imported: !!r.imported,
    fromTeams: Array.isArray(r.transcriptIds) && r.transcriptIds.length > 0 && !!r.external,
    run: m.run,
  };
}

/** The start of the transcript (when Teams started transcribing, else the meeting), ms. */
const transcriptBase = mc => Date.parse(mc.r.transcriptStart || mc.d.start) || 0;
const folderName = mc => String(mc.r.folder || '').split(/[\\/]/).filter(Boolean).pop() || '';

// ---------------------------------------------------------------- template chip

/** The template chip: what notes will use and why; its menu changes it for this meeting. */
export function tplChip(p, mc, { id = 'tpl', compact = false } = {}) {
  const { tpl } = mc;
  const all = templatesOf(p.s);
  const src = tpl.why === 'rule' ? icon('automations', 'ws-tpl-src') : tpl.why === 'meeting' ? icon('pin', 'ws-tpl-src') : '';
  const summary = `<summary class="ws-tpl-chip${compact ? ' ws-tpl-chip-compact' : ''}" style="--tpl:${tplColor(tpl.template)}" title="${e(`${tpl.template.name} — ${tpl.reason}. Click to change.`)}" aria-label="${e(`Template: ${tpl.template.name}. ${tpl.reason}. Change`)}"><span class="ws-tpl-dot"></span><span class="ws-tpl-name">${e(tpl.template.name)}</span>${src}${icon('chevron-down', 'ws-tpl-caret')}</summary>`;
  const group = kind => all.filter(t => t.kind === kind).map(t => [t.name, 'meeting-template', { 'data-id': mc.m.id, 'data-template': t.id, 'aria-checked': String(t.id === tpl.id) }, tplIcon(t)]);
  const title = mc.d.title || mc.m.title;
  const items = [
    ['#', `For this meeting${tpl.why === 'rule' ? ` · ${ruleText(tpl.ruleRecord)}` : tpl.why === 'default' ? ' · default' : ''}`],
    ...group('builtin'),
    ...(all.some(t => t.kind === 'custom') ? ['-', ['#', 'Yours'], ...group('custom')] : []),
    ...(all.some(t => t.kind === 'skill') ? ['-', ['#', 'Skills'], ...group('skill')] : []),
    '-',
    tpl.why === 'meeting' ? ['Back to the automatic choice', 'meeting-template', { 'data-id': mc.m.id, 'data-template': '' }, 'undo'] : null,
    [`Always use this for “${title.length > 26 ? `${title.slice(0, 26)}…` : title}”`, 'meeting-template-remember', { 'data-id': mc.m.id }, 'automations'],
    ['Edit templates…', 'settings-tab', { 'data-tab': 'meetings-templates' }, 'settings'],
  ];
  return menu(`${id}-${mc.m.id}`, summary, items, { right: false, cls: 'ws-tpl-menu' });
}

// ---------------------------------------------------------------- explainers

const autoSwitch = (mc, label) => toggle({ action: 'meeting-auto', checked: !!mc.tpl.auto, label, attrs: { 'data-id': mc.m.id } });

/** Why a meeting has no transcript, and what can be done: waiting for Teams, blocked, nobody
 *  transcribed, in person, or not over yet. Empty for meetings that have one. */
export function explainer(p, mc) {
  const { m, d } = mc;
  const id = { 'data-id': m.id };
  const box = (iconName, tone, body) => card({ className: 'ws-mtg-explain', body: `<div class="ws-mtg-explain-body"><span class="ws-mtg-explain-icon${tone ? ` ws-mtg-explain-${tone}` : ''}">${icon(iconName)}</span><div>${body}</div></div>` });
  const every = Number(p.s.settings.meetings?.checkEveryMin) || 10;
  if (m.state === 'pending' && mc.paused) {
    const why = PAUSED[mc.paused];
    return box('info', 'warning', `<h3>${e(why.title)}</h3>
      <p>The meeting ended at ${e(formatTime(d.end, p.zone))}. Connect doesn’t look for its transcript ${why.until}; Teams keeps it meanwhile. If you have the file, import it.</p>
      <div class="ws-actions ws-mtg-explain-actions">${pausedFix(mc.paused)}${button('Import transcript file', { action: 'meeting-import', iconName: 'upload', attrs: id })}</div>`);
  }
  if (m.state === 'pending') {
    return box('clock', '', `<h3>Teams is still preparing the transcript</h3>
      <p>The meeting ended at ${e(formatTime(d.end, p.zone))}. Teams usually needs 5–15 minutes. Connect checks every ${every} minutes for a day and saves the transcript here as soon as it appears.</p>
      ${mc.r.error?.message ? `<p class="ws-mtg-err-text">${icon('alert')}<span>The last check didn’t get through: ${e(mc.r.error.message)}</span></p>` : ''}
      <div class="ws-mtg-opts">${tplChip(p, mc, { id: 'tpl-wait' })}${autoSwitch(mc, 'Make notes as soon as it arrives')}</div>
      <div class="ws-actions ws-mtg-explain-actions">${button('Check now', { action: 'meeting-check', variant: 'ghost', iconName: 'refresh', attrs: id })}</div>`);
  }
  if (m.state === 'blocked') {
    const org = mc.people.find(x => x.organizer);
    return box('lock', 'warning', `<h3>${e(org?.company ? `${org.company}’s Teams` : 'The organizer’s Teams')} doesn’t share this transcript with you</h3>
      <p>The meeting was organized in another company’s Microsoft 365, and it doesn’t let guests read transcripts. Signing in again won’t change it.</p>
      ${mc.r.error?.message ? `<p class="ws-mtg-said">Microsoft said: <code>${e(mc.r.error.message)}</code></p>` : ''}
      <ol><li>Ask ${e(org?.name || 'the organizer')} to send the transcript (.vtt) from Teams — <button type="button" class="ws-link ws-mtg-linkbtn" data-action="meeting-copy-ask" data-id="${e(m.id)}">copy a ready message</button>.</li><li>Import the file here. Connect matches the speakers to the attendees and carries on as usual.</li></ol>
      <div class="ws-actions ws-mtg-explain-actions">${button('Import transcript file', { action: 'meeting-import', variant: 'primary', iconName: 'upload', attrs: id })}</div>`);
  }
  if (m.state === 'none') {
    return box('transcript', '', `<h3>Nobody transcribed this meeting</h3>
      <p>Teams keeps a transcript only when the organizer or a presenter starts one (<em>More › Record and transcribe › Start transcription</em>). If someone has notes or a recording transcript, import it.</p>
      <div class="ws-actions ws-mtg-explain-actions">${button('Import transcript file', { action: 'meeting-import', iconName: 'upload', attrs: id })}</div>`);
  }
  if (m.state === 'offline') {
    return card({ body: emptyState({ iconName: 'pin', title: 'Not a Teams meeting', text: `This was ${d.location ? `in ${d.location}` : 'in person'}, so there is no Teams transcript. If you recorded it elsewhere, import the transcript file.`, actions: button('Import transcript file', { action: 'meeting-import', iconName: 'upload', attrs: id }) }) });
  }
  if (m.state === 'upcoming') {
    const { template, reason, auto } = mc.tpl;
    const lead = reason.charAt(0).toLowerCase() + reason.slice(1);
    return box('calendar-check', '', `<h3>${m.ended ? 'This meeting is still going' : 'After this meeting'}</h3>
      <p>${m.online ? `Connect saves the transcript from Teams once it ends. Notes will use <strong>${e(template.name)}</strong> (${e(lead)})${auto ? ' and are made by themselves' : ''}. You can add more summaries with other templates afterwards.` : `This is an in-person meeting${d.location ? ` (${e(d.location)})` : ''}, so there will be no Teams transcript. If you record it elsewhere, import the transcript afterwards.`}</p>
      ${m.online ? `<div class="ws-mtg-opts">${tplChip(p, mc, { id: 'tpl-up' })}${autoSwitch(mc, 'Make notes automatically')}</div>` : ''}
      ${m.online && d.isOrganizer ? `<p class="ws-hint ws-muted">${icon('info')} You organize this one — remember to start transcription in Teams.</p>` : ''}`);
  }
  return '';
}

// ---------------------------------------------------------------- make notes form

/** The Make notes form (dialog and Notes pane): the template (the meeting's choice first; with
 *  documents already, the first template without one is picked), what to focus on, tasks,
 *  remembering the choice, and where the result goes. On the Notes pane (`kept`, the view
 *  state's `makeForm[meetingId]`) it shows what was chosen and typed, and its fields carry
 *  `data-make` so each change is kept there: a background render never resets it. */
export function makeNotesForm(p, mc, { kept = null, tab = false } = {}) {
  const all = templatesOf(p.s);
  const current = mc.tpl.template;
  const has = new Map(mc.docs.map(doc => [doc.template || doc.id, doc]));
  const first = mc.docs.length ? (all.find(t => !has.has(t.id) && t.kind !== 'skill') || all.find(t => !has.has(t.id)) || current) : current;
  const pick = all.find(t => t.id === kept?.templateId) || first;
  const make = tab ? ` data-make="${e(mc.m.id)}"` : '';
  const findTasks = kept?.findTasks ?? true;
  const remembered = kept?.remember ?? false;
  const ordered = [current, ...all.filter(t => t.id !== current.id)];
  const options = ordered.map(t => {
    const doc = has.get(t.id);
    const tag = doc ? `<em class="ws-tpl-tag ws-tpl-has-doc">Made · adds version ${Math.max(Number(doc.version) || 1, ...(doc.versions || []).map(v => Number(v.version) || 0)) + 1}</em>`
      : t.id === current.id ? `<em class="ws-tpl-tag">${mc.tpl.why === 'meeting' ? 'Chosen' : mc.tpl.why === 'rule' ? 'From rule' : 'Default'}</em>` : '';
    const kind = t.kind === 'skill' ? badge('Skill', 'purple', 'skill') : t.kind === 'custom' ? badge('Yours', 'info') : '';
    return `<label class="ws-tpl-option" style="--tpl:${tplColor(t)}"><input type="radio" name="template" value="${e(t.id)}"${t.id === pick.id ? ' checked' : ''}${make}><span class="ws-tpl-icon">${icon(tplIcon(t))}</span><span class="ws-tpl-copy"><strong><span>${e(t.name)}</span>${tag}${kind}</strong>${t.blurb ? `<small>${e(t.blurb)}</small>` : ''}</span></label>`;
  }).join('');
  const review = p.s.settings.meetings?.review !== false;
  const n = mc.docs.length;
  const keep = n ? `<p class="ws-mtg-keep">${icon('check-circle')}<span>Your ${n > 1 ? `${n} documents stay as they are` : `<strong>${e(mc.docs[0].name)}</strong> stays as it is`}. Another template adds a document next to ${n > 1 ? 'them' : 'it'}; the same template adds a new version.</span></p>` : '';
  const folder = folderName(mc);
  const remember = n ? '' : `<label class="ws-check"><input type="checkbox" name="remember"${mc.tpl.why === 'rule' ? ' disabled' : remembered ? ' checked' : ''}${make}><span class="ws-check-box" aria-hidden="true">${icon('check')}</span><span class="ws-check-text"><span>Always use this template for “${e(mc.d.title || mc.m.title)}”</span><small>${mc.tpl.why === 'rule' ? e(mc.tpl.reason) : 'Adds a rule to your automatic rules.'}</small></span></label>`;
  return `${keep}<div class="ws-mtg-form-grid">
    <fieldset class="ws-tpl-options"><legend class="ws-field-label">Template</legend>${options}<button type="button" class="ws-link ws-mtg-linkbtn ws-tpl-more" data-action="settings-tab" data-tab="meetings-templates">${icon('plus')}<span>Write your own or add a skill</span></button></fieldset>
    <div class="ws-mtg-form-side">
      <label class="ws-field"><span class="ws-field-label">Anything to focus on? <small class="ws-muted">optional</small></span><textarea class="ws-textarea" name="wishes" rows="3" maxlength="1000" placeholder="e.g. Focus on the pilot plan. Keep it short."${make}>${e(kept?.wishes || '')}</textarea><small class="ws-field-hint">Added to the template’s instructions for this run only.</small></label>
      <div class="ws-mtg-form-checks">
        <label class="ws-check"><input type="checkbox" name="findTasks"${findTasks ? ' checked' : ''}${make}><span class="ws-check-box" aria-hidden="true">${icon('check')}</span><span class="ws-check-text"><span>Find tasks and owners</span><small>${review ? 'New ones land in To review; ones already found are kept.' : 'They go straight to To do; ones already found are kept.'}</small></span></label>
        ${remember}
      </div>
      <p class="ws-mtg-privacy">${icon('shield')}<span>The transcript goes only to the Claude chosen for Meeting notes in <button type="button" class="ws-link ws-mtg-linkbtn" data-action="ai-open-settings">Settings › Claude</button>.${folder ? ` Everything is saved in <code>${e(folder)}</code>.` : ' Everything is saved in the meeting’s folder.'}</span></p>
    </div>
  </div>`;
}

// ---------------------------------------------------------------- notes

const skeleton = (n = 9) => `<div class="ws-mtg-skeleton" aria-hidden="true">${Array.from({ length: n }, (_, i) => `<i style="width:${[38, 92, 84, 88, 60, 90, 78, 70, 50][i % 9]}%"></i>`).join('')}</div>`;
const words = text => String(text || '').split(/\s+/).filter(Boolean).length;
const docKey = (meetingId, docId) => `${meetingId}:${docId}`;
/** Which Claude wrote a document: Claude Code on this Mac, or a CodeMie profile. */
const profileLabel = id => (!id ? '' : id === 'claude' ? 'Claude Code on this Mac' : String(id).startsWith('codemie:') ? `CodeMie “${String(id).slice(8)}”` : String(id));
const DOC_TEXT = { folder_missing: 'The meeting folder is gone, so this document can’t be read. Download the transcript again or import it; your notes are not in Connect.' };

/** The text of a document (or an earlier version) as read: `{text}`, `{error}` or undefined. */
const docRead = (mc, docId, version) => mc.data.docs?.[version ? `${docId}@${version}` : docId];

function docBody(p, mc, doc, version, compact) {
  const read = docRead(mc, doc.id, version);
  if (!read) return `<div class="ws-md${compact ? ' ws-md-compact' : ''}">${skeleton(7)}</div>`;
  if (read.error) {
    const missing = read.error.code === 'folder_missing';
    return `<div class="ws-mtg-doc-error">${emptyState({ iconName: missing ? 'folder' : 'alert', title: missing ? 'The meeting folder is gone' : 'This document couldn’t be read', text: DOC_TEXT[read.error.code] || read.error.message || '', actions: missing ? folderFix(mc) : button('Try again', { action: 'meeting-reload', attrs: { 'data-id': mc.m.id } }) })}</div>`;
  }
  // The page already shows the title, the date and the people: only the tags, no repeated title.
  return `<article class="ws-md${compact ? ' ws-md-compact' : ''}">${renderMarkdown(read.text, { front: 'tags', dropTitle: mc.d.title || mc.m.title })}</article>`;
}

function docEditor(p, mc, doc, ed) {
  const conflict = ed.conflict ? `<div class="ws-banner ws-banner-warning ws-mtg-conflict" role="alert">${icon('alert')}<div><strong>These notes changed while you were editing</strong><p>Version ${e(ed.conflict.version)} was saved meanwhile, so your edit wasn’t saved over it. Read the newer text, then start again from it — your edit stays below to copy from.</p><details class="ws-mtg-newer"><summary>The newer text</summary><pre class="ws-mtg-pre">${e(ed.conflict.text)}</pre></details></div><div class="ws-actions">${button('Copy my edit', { action: 'doc-edit-copy', variant: 'ghost', size: 'sm', iconName: 'copy' })}${button('Start from the newer text', { action: 'doc-edit-rebase', variant: 'primary', size: 'sm', attrs: { 'data-id': mc.m.id, 'data-doc': doc.id } })}</div></div>` : '';
  const mine = !ed.conflict && ed.mine ? `<details class="ws-mtg-newer ws-mtg-mine"><summary>Your earlier edit</summary><pre class="ws-mtg-pre">${e(ed.mine)}</pre></details>` : '';
  return `${conflict}${mine}<textarea id="meeting-doc-editor" class="ws-textarea ws-mtg-editor" spellcheck="true" aria-label="Edit ${e(doc.name)} (Markdown)">${e(ed.draft)}</textarea>`;
}

/** What a document shows, computed once: its template, the version select, its tools (Cancel
 *  and Save while edited; Copy, Save a copy, Edit and ⋯ otherwise; Copy and Save a copy in Side by
 *  side), the grey line saying who made it, the earlier-version bar and the body. */
function docParts(p, mc, doc, { compare = false, side = 'left' } = {}) {
  const { m, r } = mc;
  const t = templatesOf(p.s).find(x => x.id === doc.template) || { name: doc.name, kind: 'builtin', color: '#5677C8' };
  const ed = p.v.editing && p.v.editing.meetingId === m.id && p.v.editing.docId === doc.id && !compare ? p.v.editing : null;
  const viewing = !compare && !ed ? Number(p.v.version?.[docKey(m.id, doc.id)]) || null : null;
  const earlier = viewing && (doc.versions || []).find(v => Number(v.version) === viewing);
  const versions = [{ version: doc.version, at: doc.updatedAt, edited: doc.edited, current: true }, ...[...(doc.versions || [])].reverse().map(v => ({ ...v, current: false }))];
  const ids = { 'data-id': m.id, 'data-doc': doc.id };
  const isMain = doc.id === r.main;
  const vSelect = versions.length > 1 && !ed ? selectBox(`data-action="doc-version" data-id="${e(m.id)}" data-doc="${e(doc.id)}" aria-label="Version of ${e(doc.name)}"`, versions.map(v => option(v.current ? '' : v.version, `Version ${v.version}${v.current ? ' (current)' : ''} · ${agoLabel(v.at, p.zone, p.now)}${v.edited ? ' · edited' : ''}`, v.current ? !earlier : Number(v.version) === viewing)).join(''), 'ws-mtg-ver-select') : '';
  const more = menu(`doc-${m.id}-${doc.id}-${side}`, dotsSummary('Document actions', 'ws-btn-sm'), [
    !isMain ? ['Make it the main notes', 'doc-main', ids, 'check'] : null,
    ['Make again (new version)', 'doc-again', { 'data-id': m.id, 'data-template': doc.template }, 'refresh'],
    ['Edit the template', 'settings-tab', { 'data-tab': 'meetings-templates', 'data-template': doc.template || doc.id }, 'settings'],
    '-',
    ['Delete this document…', 'doc-delete', ids, 'trash', true],
  ]);
  const read = docRead(mc, doc.id, earlier ? viewing : null);
  const tools = ed
    ? `${button('Cancel', { action: 'doc-edit-cancel', variant: 'ghost', size: 'sm', attrs: ids })}${button('Save', { action: 'doc-edit-save', variant: 'primary', size: 'sm', iconName: 'check', attrs: ids })}`
    : `${button('', { action: 'doc-copy', iconName: 'copy', variant: 'ghost', size: 'sm', title: 'Copy as Markdown', attrs: ids, disabled: !read?.text })}${button('', { action: 'doc-save', iconName: 'download', variant: 'ghost', size: 'sm', title: 'Save a copy (.md)', attrs: ids, disabled: !read?.text })}${compare || earlier ? '' : button('Edit', { action: 'doc-edit', iconName: 'edit', variant: 'ghost', size: 'sm', attrs: ids, disabled: !read?.text })}${compare ? '' : more}`;
  const made = earlier || doc;
  const kind = t.kind === 'skill' ? 'Skill' : t.kind === 'custom' ? 'Your template' : 'Built-in template';
  const who = [profileLabel(made.profile), made.model].filter(Boolean).join(' · ');
  const facts = [
    kind, `made ${agoLabel(made.at || made.updatedAt, p.zone, p.now)} ${made.auto ? 'automatically' : 'by you'}`, who, made.edited ? 'edited' : '',
    versions.length > 1 ? `version ${made.version} of ${versions.length}` : '', read?.text ? `${words(read.text)} words` : '', doc.file || '',
  ].filter(Boolean).map(e).join(' · ');
  const foot = `<p class="ws-mtg-docfoot">${facts}${!isMain && !earlier ? ` · <button type="button" class="ws-link ws-mtg-linkbtn" data-action="doc-main" data-id="${e(m.id)}" data-doc="${e(doc.id)}">make it the main notes</button>` : ''}${made.wishes ? ` · You asked: “${e(made.wishes)}”` : ''}</p>`;
  const earlierBar = earlier ? `<div class="ws-mtg-version-bar">${icon('history')}<span>You’re reading version ${e(viewing)}, from ${e(agoLabel(earlier.at, p.zone, p.now))}. The current one is version ${e(doc.version)}.</span>${button('Back to the current one', { action: 'doc-version-current', variant: 'ghost', size: 'sm', attrs: ids })}${button('Use this version', { action: 'doc-use-version', size: 'sm', attrs: { ...ids, 'data-version': viewing } })}</div>` : '';
  const body = ed ? docEditor(p, mc, doc, ed) : docBody(p, mc, doc, earlier ? viewing : null, compare);
  return { t, ed, vSelect, tools, foot, earlierBar, body };
}

/** One column of Side by side: its document select, Copy and Save a copy, the notes. */
function docCard(p, mc, doc, side) {
  const x = docParts(p, mc, doc, { compare: true, side });
  const picker = selectBox(`data-action="doc-compare-pick" data-id="${e(mc.m.id)}" data-side="${side}" aria-label="Document on the ${side}"`, mc.docs.map(d => option(d.id, `${d.name}${d.id === mc.r.main ? ' (main)' : ''}`, d.id === doc.id)).join(''), 'ws-mtg-doc-pick');
  return `<section class="ws-mtg-doc ws-mtg-doc-compare" data-doc="${e(doc.id)}"><header class="ws-mtg-doc-bar">${picker}<span class="ws-spacer"></span>${x.tools}</header>${x.body}</section>`;
}

/** The one toolbar over the notes: the document picker (each document, Side by side), New
 *  summary, the version select, the Side by side toggle, then the document's own tools. */
function docToolbar(p, mc, view, compare, x) {
  const { m, r, docs } = mc;
  const n = docs.length;
  const summary = `<summary class="ws-mtg-doc-pick-sum" style="--tpl:${tplColor(x.t)}" title="This meeting’s documents"><span class="ws-tpl-dot"></span><span class="ws-mtg-doc-pick-name">${compare ? 'Side by side' : e(view.name)}</span>${n > 1 && !compare ? `<small>${docs.indexOf(view) + 1} of ${n}</small>` : ''}${icon('chevron-down')}</summary>`;
  const picker = menu(`docs-${m.id}`, summary, [
    ['#', 'Documents'],
    ...docs.map(doc => [`${doc.name}${doc.id === r.main ? ' (main)' : ''}`, 'doc-view', { 'data-id': m.id, 'data-doc': doc.id, 'aria-checked': String(!compare && doc.id === view.id) }, null]),
    n > 1 ? '-' : null,
    n > 1 ? [compare ? 'Show one at a time' : 'Compare side by side', 'meeting-compare', { 'data-v': compare ? '0' : '1' }, 'board'] : null,
  ], { right: false, cls: 'ws-mtg-doc-picker' });
  const side = n > 1 ? button('', { action: 'meeting-compare', iconName: 'board', variant: 'ghost', size: 'sm', title: compare ? 'Show one at a time' : 'Side by side', attrs: { 'data-v': compare ? '0' : '1', 'aria-pressed': String(compare) } }) : '';
  const another = button('New summary', { action: 'meeting-make-notes', iconName: 'plus', variant: 'ghost', size: 'sm', attrs: { 'data-id': m.id } });
  return `<div class="ws-mtg-doctools">${picker}${another}<span class="ws-spacer"></span>${compare ? '' : x.vSelect}${side}${compare ? '' : x.tools}</div>`;
}

export function notesTab(p, mc) {
  const { m, docs, run } = mc;
  const notesRun = run?.kind === 'meeting_notes' ? run : null;
  const saving = run?.kind === 'transcript_download';
  if ((notesRun || saving) && !docs.length) return card({ className: 'ws-mtg-busy-card', body: skeleton() });
  if (['pending', 'blocked', 'none', 'offline', 'upcoming'].includes(m.state)) return explainer(p, mc);
  // Each step's failure has its own banner and its own way on: a save's (also a Download again
  // on saved notes) and a notes run's.
  const failedBanner = `${saving || notesRun ? '' : saveBanner(mc)}${!notesRun && mc.notesError && ['failed', 'ready'].includes(m.state) ? lastRunBanner(mc) : ''}`;
  if (!docs.length) {
    const intro = m.state === 'available' ? 'Connect gets the transcript from Teams first, then writes the notes.' : mc.segments ? `${plural(mc.segments.length, 'line')} from ${plural(new Set(mc.segments.map(x => x.address || x.voice)).size, 'speaker')}, already in the meeting folder.` : 'The transcript is in the meeting folder.';
    return `${failedBanner}<form class="ws-card ws-mtg-make" data-form="meeting-notes" data-id="${e(m.id)}">
      <header class="ws-card-header"><div class="ws-mtg-card-head"><h2 class="ws-card-title"><span class="ws-card-icon">${icon('sparkles')}</span>Make notes from this transcript</h2><p>${e(intro)}</p></div></header>
      <div class="ws-card-body">${makeNotesForm(p, mc, { kept: p.v.makeForm?.[m.id] || null, tab: true })}</div>
      <footer class="ws-card-footer ws-mtg-make-foot"><span class="ws-spacer"></span>${button('Make notes', { type: 'submit', variant: 'magic', iconName: 'sparkles', size: 'lg' })}</footer>
    </form>`;
  }
  const view = docs.find(x => x.id === p.v.docView?.[m.id]) || mc.main || docs[0];
  const compare = !!p.v.compare && docs.length > 1;
  const x = docParts(p, mc, view);
  const toolbar = docToolbar(p, mc, view, compare, x);
  if (compare) {
    const right = docs.find(d => d.id === p.v.compareWith?.[m.id] && d.id !== view.id) || docs.find(d => d.id !== view.id);
    return `${failedBanner}${toolbar}<div class="ws-mtg-compare">${docCard(p, mc, view, 'left')}${docCard(p, mc, right, 'right')}</div>`;
  }
  // A run making another document is said once, by the line under the header.
  return `${failedBanner}${toolbar}
    <div class="ws-mtg-docpage" data-doc="${e(view.id)}">${x.earlierBar}${x.body}${x.ed ? '' : x.foot}</div>`;
}

// ---------------------------------------------------------------- the summary

/** A summary tab whose document isn't made yet (spec "Before there is a document"): "No <name>
 *  yet.", where the transcript stands, and "More options…" for the Make notes dialog. */
export function noSummaryCard(p, mc, tab) {
  const { m } = mc;
  const line = m.state === 'available' ? 'Connect gets the transcript from Teams first, then writes the notes.'
    : mc.segments ? `${plural(mc.segments.length, 'line')} from ${plural(new Set(mc.segments.map(x => x.address || x.voice)).size, 'speaker')} are in the meeting folder.`
      : 'The transcript is in the meeting folder.';
  return `<div class="ws-card ws-mtg-nosummary"><div class="ws-card-body"><h3>No ${e(tab?.label || mc.tpl.template.name)} yet.</h3><p class="ws-muted">${e(line)}</p><button type="button" class="ws-link ws-mtg-linkbtn" data-action="meeting-make-notes" data-id="${e(m.id)}">More options…</button></div></div>`;
}

/** The summary pane (spec "The summary pane"): the failure banners, then the shown tab's document
 *  as a page with who made it under it; a plugin's minutes as escaped Markdown; or, before the
 *  document, the skeleton while a run makes it, else "No <name> yet.". */
export function summaryPane(p, mc, tab, { retry = true } = {}) {
  const { m, run } = mc;
  const notesRun = run?.kind === 'meeting_notes' ? run : null;
  const saving = run?.kind === 'transcript_download';
  // As in the Notes pane: a save's failure and a notes run's, each with its own way on (`retry`:
  // false when the strip's primary is that Try again).
  const failedBanner = `${saving || notesRun ? '' : saveBanner(mc)}${!notesRun && mc.notesError && ['failed', 'ready'].includes(m.state) ? lastRunBanner(mc, { retry }) : ''}`;
  let body;
  if (tab?.doc) {
    const { foot } = docParts(p, mc, tab.doc, { compare: true, side: 'summary' });
    body = `<div class="ws-mtg-docpage ws-mtg-summary" data-doc="${e(tab.doc.id)}">${docBody(p, mc, tab.doc, null, false)}${foot}</div>`;
  } else if (tab?.kind === 'plugin') {
    body = tab.text ? `<div class="ws-mtg-docpage ws-mtg-summary"><article class="ws-md">${renderMarkdown(tab.text)}</article></div>`
      : `<div class="ws-card ws-mtg-nosummary"><div class="ws-card-body"><p class="ws-muted">No ${e(tab.label)} summary for this meeting yet.</p></div></div>`;
  } else if ((notesRun && (!tab || notesRun.templateId === tab.templateId)) || (saving && !mc.docs.length)) {
    body = card({ className: 'ws-mtg-busy-card', body: skeleton() });
  } else {
    body = noSummaryCard(p, mc, tab);
  }
  return `${failedBanner}${body}`;
}

/** Why a found or awaited transcript waits (`mc.paused`, see meetingItems), in the words each
 *  place uses, and the one button that ends the wait. */
export const PAUSED = {
  off: { status: 'Waiting: transcripts are off', line: 'Waiting: reading Teams transcripts is off', seg: 'waiting · transcripts are off', title: 'Reading Teams transcripts is off', until: 'until you turn reading transcripts on again', fix: ['Turn on', 'meeting-transcripts-on'] },
  signin: { status: 'Waiting: sign in to Microsoft 365', line: 'Waiting: Microsoft 365 needs you to sign in again', seg: 'waiting · sign in to Microsoft 365', title: 'Microsoft 365 needs you to sign in again', until: 'until you sign in again', fix: ['Sign in again', 'graph-connect'] },
};
export const pausedFix = (paused, size) => button(PAUSED[paused].fix[0], { action: PAUSED[paused].fix[1], variant: 'primary', size });

/** A transcript found or waited for that nothing can get now: why, and the way on. */
function pausedBanner(mc) {
  const why = PAUSED[mc.paused];
  const found = mc.m.state === 'available';
  return `<div class="ws-banner ws-banner-warning ws-mtg-paused" role="status">${icon('info')}<div><strong>${e(why.title)}</strong><p>${found ? 'Connect found this transcript in Teams but can’t save it' : 'Connect doesn’t look for this transcript'} ${why.until}. Nothing is lost meanwhile.</p></div><div class="ws-actions">${pausedFix(mc.paused)}</div></div>`;
}

/** The last save from Teams failed, or the person stopped it: why, and the way on. On saved
 *  notes it was a Download again, which changed nothing. */
function saveBanner(mc) {
  const { m } = mc;
  if (m.state === 'available' && mc.paused) return pausedBanner(mc);
  const err = mc.saveError;
  if (!err) return '';
  const stopped = err.code === 'cancelled';
  const title = stopped ? 'Saving the transcript stopped' : mc.saved ? 'Download again didn’t work' : 'Couldn’t get the transcript from Teams';
  // Only a transcript still in Teams is tried again by itself; Download again is the person's.
  const next = mc.saved && saveFixAction(mc, err.code)[1] === 'meeting-download' ? 'Try again in a moment.' : saveNextStep(err.code, mc);
  const after = mc.saved ? 'Your transcript and notes are as they were.' : mc.pending ? `${mc.pending.name} is made as soon as it’s saved.` : 'Make notes tries again first.';
  return `<div class="ws-banner ws-banner-warning ws-mtg-run-failed" role="status">${icon('alert')}<div><strong>${e(title)}</strong><p>${[err.message || '', next, after].filter(Boolean).map(e).join(' ')}</p></div><div class="ws-actions">${saveFix(mc, err.code)}</div></div>`;
}

/** The last notes run failed: why, and the way on (sign in again, Try again; `retry` false when
 *  the strip already offers Try again). */
function lastRunBanner(mc, { retry = true } = {}) {
  const err = mc.notesError || {};
  const login = err.code === 'needs_login';
  const choice = err.code === 'needs_choice';
  return `<div class="ws-banner ws-banner-warning ws-mtg-run-failed" role="status">${icon('alert')}<div><strong>${mc.docs.length ? 'The last notes run didn’t finish' : 'The notes weren’t written'}</strong><p>${e(err.message || 'Claude stopped before the notes were ready.')} ${mc.docs.length ? 'Your documents are as they were.' : 'Nothing was lost — the transcript is in the folder, and the run log is in Files.'}</p></div><div class="ws-actions">${login || choice ? button(login ? 'Sign in again' : 'Choose Claude', { action: 'ai-open-settings', variant: 'ghost' }) : ''}${retry ? button('Try again', { action: 'meeting-retry', variant: 'primary', iconName: 'refresh', attrs: { 'data-id': mc.m.id } }) : ''}</div></div>`;
}

/** What fixes a missing meeting folder: download it again from Teams, or import it again. */
export function folderFix(mc) {
  return mc.fromTeams && !mc.imported
    ? button('Download again', { action: 'meeting-download', variant: 'primary', iconName: 'refresh', attrs: { 'data-id': mc.m.id } })
    : button('Import transcript file', { action: 'meeting-import', variant: 'primary', iconName: 'upload', attrs: { 'data-id': mc.m.id } });
}

// ---------------------------------------------------------------- transcript

const reEsc = x => x.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** A line's text, escaped, with glossary spellings underlined and search hits marked (one pass,
 *  so a mark is never put inside another). */
function highlight(text, pairs, q) {
  const raw = String(text ?? '');
  const terms = new Map();
  for (const [heard, written] of pairs) if (heard && heard.trim()) terms.set(heard.toLowerCase(), written);
  const needle = String(q || '').trim().toLowerCase();
  const alts = [...new Set([...terms.keys(), ...(needle ? [needle] : [])])].sort((a, b) => b.length - a.length).map(reEsc);
  if (!alts.length) return e(raw);
  // Matched on the text itself, escaped piece by piece: a search for "amp" never splits "&amp;".
  let out = '';
  let at = 0;
  for (const m of raw.matchAll(new RegExp(alts.join('|'), 'gi'))) {
    const hit = m[0];
    const written = terms.get(hit.toLowerCase());
    out += e(raw.slice(at, m.index));
    out += needle && hit.toLowerCase() === needle ? `<mark class="ws-mtg-hit">${e(hit)}</mark>`
      : written ? `<mark class="ws-mtg-fix" title="${e(`Written as “${written}” in notes (your glossary)`)}">${e(hit)}</mark>` : e(hit);
    at = m.index + hit.length;
  }
  return out + e(raw.slice(at));
}

const voiceKey = seg => (seg.address ? `a:${String(seg.address).toLowerCase()}` : `v:${seg.voice}`);

/** The unnamed voices of a transcript and a picker of the people they could be. */
function speakerMap(p, mc, unnamed, [title, text]) {
  const mapped = new Set(Object.values(mc.r.speakers || {}).map(a => String(a).toLowerCase()));
  const choices = mc.people.filter(x => x.address && !x.me && !mapped.has(x.address.toLowerCase()));
  return `<div class="ws-banner ws-mtg-speakers-banner">${icon('users')}<div><strong>${e(title)}</strong><p>${e(text)}</p></div><div class="ws-mtg-speaker-map">${unnamed.map(seg => `<label><span>${e(seg.name)}</span>${selectBox(`data-action="meeting-speaker" data-id="${e(mc.m.id)}" data-voice="${e(seg.voice)}" data-name="${e(seg.name)}" aria-label="${e(`Who is ${seg.name}?`)}"`, `${option('', 'Who is it?', true)}${choices.map(x => option(x.address, x.name, false)).join('')}`)}</label>`).join('')}</div></div>`;
}

/** A transcript that isn't readable yet: still in Teams, its save failed, being read, or gone. */
function transcriptMissing(p, mc) {
  const { m } = mc;
  if (['pending', 'blocked', 'none', 'offline', 'upcoming'].includes(m.state)) return explainer(p, mc);
  if (m.state === 'available') {
    if (mc.paused) return pausedBanner(mc);
    const err = mc.saveError;
    const title = !err ? 'Saving the transcript from Teams' : err.code === 'cancelled' ? 'Saving the transcript stopped' : 'Couldn’t get the transcript from Teams';
    return card({ body: emptyState({ iconName: 'transcript', title, text: err ? `${err.message || ''} ${saveNextStep(err.code, mc)}`.trim() : 'It shows here in a moment, with a copy in the meeting folder.', actions: err ? saveFix(mc, err.code) : '' }) });
  }
  const read = mc.data.transcript;
  if (read?.error) return folderGone(mc, read.error);
  return card({ body: skeleton(8) });
}

const SAVE_NEXT = {
  folder_unwritable: 'Choose the meetings folder again in Settings › Meetings.',
  throttled: 'Connect tries again by itself in a few minutes.',
  offline: 'Connect tries again by itself once it is online.',
  provider: 'Connect tries again by itself in a few minutes.',
  transcript_missing: 'Teams no longer has it. Import the file instead.',
};
/** What happens next after a failed save, in words that match its button (`saveFix`). A
 *  Microsoft sign-in depends on the account: signed out, sign in; signed in again, the round
 *  tries by itself (`mc.connected`). */
export function saveNextStep(code, mc = {}) {
  if (code === 'needs_login') return mc.connected ? 'You’re signed in again: Connect tries again by itself in a few minutes.' : 'Sign in to Microsoft 365 again: Connect then tries again by itself.';
  return SAVE_NEXT[code] || '';
}

/** The one button that fixes a failed save, or the step it waits on (`[label, action, attrs]`). */
export function saveFixAction(mc, code) {
  if (code === 'needs_login' && !mc.connected) return ['Sign in again', 'graph-connect', {}];
  if (code === 'folder_unwritable') return ['Open Settings › Meetings', 'settings-tab', { 'data-tab': 'meetings-transcripts' }];
  if (code === 'transcript_missing') return ['Import transcript file', 'meeting-import', { 'data-id': mc.m.id }];
  return ['Try again', 'meeting-download', { 'data-id': mc.m.id }];
}

/** What a failed save offers: sign in again, choose the folder again, import, or Try again. */
export function saveFix(mc, code) {
  const [label, action, attrs] = saveFixAction(mc, code);
  const iconName = { 'meeting-import': 'upload', 'settings-tab': 'settings', 'meeting-download': 'refresh' }[action];
  return button(label, { action, variant: 'primary', iconName, attrs });
}

function folderGone(mc, error) {
  const missing = error.code === 'folder_missing';
  const text = !missing ? error.message || '' : mc.fromTeams && !mc.imported ? error.message || 'The meeting folder was moved or deleted. Download the transcript again.' : 'The meeting folder was moved or deleted. Import the transcript file again.';
  return card({ body: emptyState({ iconName: missing ? 'folder' : 'alert', title: missing ? 'This meeting’s folder is gone' : 'The meeting folder couldn’t be read', text, actions: missing ? folderFix(mc) : button('Try again', { action: 'meeting-reload', attrs: { 'data-id': mc.m.id } }) }) });
}

export function transcriptTab(p, mc) {
  const { m } = mc;
  if (!mc.saved && !mc.segments) return transcriptMissing(p, mc);
  if (!mc.segments) return transcriptMissing(p, mc);
  const lines = mc.segments;
  const total = lines.reduce((n, x) => n + String(x.text || '').length, 0) || 1;
  const voices = new Map();
  for (const seg of lines) {
    const key = voiceKey(seg);
    const v = voices.get(key) || { key, seg, chars: 0 };
    v.chars += String(seg.text || '').length;
    voices.set(key, v);
  }
  const unnamed = [...voices.values()].filter(v => !v.seg.address).map(v => v.seg);
  const q = String(p.v.tq || '').trim();
  const pairs = p.glossary?.pairs || [];
  const tasksAt = new Map();
  for (const t of mc.tasks) if (Number.isInteger(t.data.line)) tasksAt.set(t.data.line, [...(tasksAt.get(t.data.line) || []), t]);
  const me = meOf(p.s);
  const base = transcriptBase(mc);
  const shown = lines.map((seg, i) => ({ seg, i })).filter(({ seg }) => (!p.v.speaker || voiceKey(seg) === p.v.speaker) && (!q || String(seg.text || '').toLowerCase().includes(q.toLowerCase())));
  let prev = null;
  const rows = shown.map(({ seg, i }) => {
    const same = prev && voiceKey(prev.seg) === voiceKey(seg) && prev.i === i - 1;
    prev = { seg, i };
    const named = !!seg.address;
    const tasks = tasksAt.get(i) || [];
    const at = base + Number(seg.start || 0) * 1000;
    return `<div class="ws-mtg-line${same ? ' ws-mtg-cont' : ''}${p.v.focusLine === i ? ' ws-mtg-focus' : ''}${tasks.length ? ' ws-mtg-has-task' : ''}" id="meeting-line-${i}" data-line="${i}">
      <span class="ws-mtg-line-time" title="${e(`${durationLabel(Math.floor(Number(seg.start || 0) / 60))} into the meeting`)}">${e(formatTime(at, p.zone))}</span>
      <span class="ws-mtg-line-face">${same ? '' : named ? avatar({ name: seg.name, size: 28, seed: String(seg.address).toLowerCase() }) : `<span class="ws-mtg-unknown" aria-hidden="true">${icon('user')}</span>`}</span>
      <div class="ws-mtg-line-body">${same ? '' : `<strong>${e(seg.name)}${!named ? ` <button type="button" class="ws-mtg-name-it" data-action="meeting-name-speaker" data-voice="${e(seg.voice)}">Who is this?</button>` : ''}</strong>`}<p>${highlight(seg.text, pairs, q)}</p>
        ${tasks.map(t => `<button type="button" class="ws-mtg-line-task" data-action="task-open-today" data-id="${e(t.id)}">${icon('tasks')}<span>Task for ${e(ownerOf(t, me).first)}: ${e(t.data.text)}</span></button>`).join('')}
      </div>
    </div>`;
  }).join('');
  const share = v => Math.round((v.chars / total) * 100);
  const chip = v => {
    const name = String(v.seg.name || v.seg.voice || '');
    // Named people by first name ("You" for me); a voice Teams couldn't name keeps its whole label.
    const first = !v.seg.address ? name : String(v.seg.address).toLowerCase() === String(me.address || '').toLowerCase() ? 'You' : name.includes(',') ? name.split(',')[1].trim().split(/\s+/)[0] : name.split(/\s+/)[0];
    return `<button type="button" class="ws-mtg-spk${p.v.speaker === v.key ? ' ws-mtg-on' : ''}" data-action="meeting-speaker-filter" data-key="${e(v.key)}" aria-pressed="${p.v.speaker === v.key}" title="${e(`${v.seg.name} · ${share(v)}% of the talking`)}">${v.seg.address ? avatar({ name: v.seg.name, size: 18, seed: String(v.seg.address).toLowerCase() }) : ''}<span>${e(first || v.seg.name)}</span><i style="--w:${share(v)}%"></i><small>${share(v)}%</small></button>`;
  };
  const fixes = pairs.filter(([h]) => h && lines.some(seg => String(seg.text || '').toLowerCase().includes(h.toLowerCase()))).length;
  const minutes = Math.round((Number(lines.at(-1)?.end || 0)) / 60);
  return `<div class="ws-mtg-transcript">
    ${unnamed.length ? speakerMap(p, mc, unnamed, [`${plural(unnamed.length, 'speaker')} without a name`, 'Teams couldn’t name them. Match them to the people invited so tasks get the right owner.']) : ''}
    <div class="ws-mtg-tr-toolbar">
      <label class="ws-search">${icon('search')}<input id="meeting-transcript-search" type="search" placeholder="Find in transcript" value="${e(p.v.tq || '')}" aria-label="Find in transcript" autocomplete="off"></label>
      <div class="ws-mtg-speakers" role="group" aria-label="Filter by speaker"><button type="button" class="ws-mtg-spk${!p.v.speaker ? ' ws-mtg-on' : ''}" data-action="meeting-speaker-filter" data-key="" aria-pressed="${!p.v.speaker}">Everyone</button>${[...voices.values()].map(chip).join('')}</div>
    </div>
    <p class="ws-mtg-tr-info ws-muted">${plural(lines.length, 'line')}${minutes ? ` · ${e(durationLabel(minutes))}` : ''} · started ${e(formatTime(base, p.zone))}${mc.imported ? ` · imported from ${e(mc.r.imported)}` : ''}${fixes ? ` · <mark class="ws-mtg-fix">${plural(fixes, 'term')}</mark> spelled by your glossary` : ''}${q ? ` · ${plural(shown.length, 'match', 'matches')}` : ''}</p>
    <div class="ws-card ws-mtg-lines">${rows || emptyState({ iconName: 'search', title: 'No lines match', text: 'Try another word or speaker.' })}</div>
  </div>`;
}

// ---------------------------------------------------------------- action items column

function ownerSelect(p, t) {
  const me = meOf(p.s);
  const people = peopleFor(p.s, t, me);
  const current = String(t.data.owner || '').trim().toLowerCase();
  const mine = isMine(t, me);
  const pick = x => (x.me ? mine : current === x.key.toLowerCase());
  const label = x => (x.me ? `${x.name || 'Me'} (you)` : x.name);
  const opts = list => list.map(x => option(x.key, label(x), pick(x))).join('');
  const body = people.meeting.length ? `${option('', 'Nobody named', !current)}<optgroup label="In this meeting">${opts(people.meeting)}</optgroup><optgroup label="Everyone else">${opts(people.others)}</optgroup>` : `${option('', 'Nobody named', !current)}${opts(people.others)}`;
  const owner = ownerOf(t, me);
  return `<span class="ws-mtg-owner">${owner.key ? avatar({ name: owner.name, size: 20, seed: owner.seed }) : `<span class="ws-task-nobody" style="--size:20px" aria-hidden="true">${icon('user')}</span>`}${selectBox(`data-action="task-owner" data-id="${e(t.id)}" aria-label="Owner of ${e(t.data.text)}"`, body)}</span>`;
}

/** The quote in an open to-add row (spec "The action items column"): its transcript line (today's
 *  `meeting-goto-line`), or "Added by you" when there is none. */
function itemQuote(p, mc, t) {
  const seg = Number.isInteger(t.data.line) ? mc.segments?.[t.data.line] : null;
  const text = seg?.text || t.data.quote;
  if (!text) return '<small class="ws-muted">Added by you</small>';
  const who = seg?.name || t.data.speaker || '';
  const first = who.includes(',') ? who.split(',')[1].trim().split(/\s+/)[0] : who.split(/\s+/)[0];
  const at = seg ? formatTime(transcriptBase(mc) + Number(seg.start || 0) * 1000, p.zone) : Number.isFinite(t.data.quoteAt) ? formatTime(transcriptBase(mc) + t.data.quoteAt * 1000, p.zone) : '';
  const short = text.length > 140 ? `${text.slice(0, 138)}…` : text;
  return `<button type="button" class="ws-mtg-quote" data-action="meeting-goto-line" data-id="${e(mc.m.id)}" data-line="${e(t.data.line ?? '')}" title="Show in the transcript">${icon('quote')}<span>${first ? `${e(first)}: ` : ''}“${e(short)}”</span>${at ? `<em>${e(at)}</em>` : ''}</button>`;
}

/** The action items column's ticks for a meeting (spec "Ticks"): `v.ticked[id]` pruned to tasks
 *  still in To review, or `defaultTicks` the first time it is drawn (`v.ticked[id]` undefined).
 *  Both the column (the checkboxes and the count) and the controller (what "Add N to Tasks"
 *  sends) read it, so a render and an add see the same set. */
export function ticksOf(v, mc, me) {
  const { toAdd } = itemsOf(mc);
  const ids = new Set(toAdd.map(t => t.id));
  const stored = v.ticked[mc.m.id];
  return (stored === undefined ? defaultTicks(toAdd, me) : stored).filter(id => ids.has(id));
}

/** A to-add row, closed: a checkbox, the text and the owner line. Open (`v.itemOpen` is its id):
 *  also the quote, the owner and due date, and "Not a task". */
function toAddRow(p, mc, t, { open, ticked, me }) {
  const text = t.data.text;
  const isOpen = open === t.id;
  const detail = isOpen ? `<div class="ws-mtg-item-detail">${itemQuote(p, mc, t)}${ownerSelect(p, t)}<input type="date" class="ws-input ws-mtg-date" value="${e(t.data.due || '')}" data-commit="task-due" data-id="${e(t.id)}" aria-label="${e(`Due date of ${text}`)}">${button('Not a task', { action: 'task-dismiss', variant: 'ghost', size: 'sm', iconName: 'close', attrs: { 'data-id': t.id } })}</div>` : '';
  return `<div class="ws-mtg-item" data-task="${e(t.id)}">
    <label class="ws-check"><input type="checkbox" data-action="meeting-item-tick" data-task="${e(t.id)}" aria-label="${e(`Add ${text}`)}"${ticked.has(t.id) ? ' checked' : ''}><span class="ws-check-box" aria-hidden="true">${icon('check')}</span></label>
    <button type="button" class="ws-mtg-item-open" data-action="meeting-item-open" data-task="${e(t.id)}" aria-expanded="${isOpen}"><span class="ws-mtg-item-text">${e(text)}</span><span class="ws-mtg-item-owner">${e(ownerLine(t, me, p.zone))}</span></button>
    ${detail}
  </div>`;
}

/** An "In Tasks" row (spec "In Tasks"): a done checkbox, the text (opens it in Tasks) and its
 *  due date, or its column name when it has none. */
function boardRow(p, t) {
  const status = taskStatus(t);
  const done = status === 'done';
  const info = !done && dueInfo(t.data.due, p.now, p.zone);
  const when = info ? info.text : columnName(status, p.s.settings);
  return `<div class="ws-mtg-item-board${done ? ' ws-mtg-item-done' : ''}">
    <label class="ws-check" title="${done ? 'Mark as not done' : 'Mark as done'}"><input type="checkbox" data-action="task-done" data-id="${e(t.id)}"${done ? ' checked' : ''} aria-label="${e(`${done ? 'Reopen' : 'Mark as done'}: ${t.data.text}`)}"><span class="ws-check-box" aria-hidden="true">${icon('check')}</span></label>
    <button type="button" class="ws-mtg-item-title" data-action="task-open-today" data-id="${e(t.id)}">${e(t.data.text)}</button>
    <span class="ws-mtg-item-when">${e(when)}</span>
  </div>`;
}

/** The action items column (spec "The action items column"): the meeting's To review tasks to
 *  add, "Add N to Tasks" with Undo, and the tasks already in Tasks. Beside every pane (`pane`
 *  false, the default), or the Action items pane with the column off (`pane` true) — the same
 *  content, drawn full width. The label comes from `p.taskLabel` (the page's `ctx.taskLabel`,
 *  default "Tasks" — the task target's `label`). */
export function actionItems(p, mc, { pane = false } = {}) {
  const { m } = mc;
  const v = p.v;
  const me = meOf(p.s);
  const { toAdd, inTasks } = itemsOf(mc);
  const ticked = new Set(ticksOf(v, mc, me));
  const label = p.taskLabel || 'Tasks';
  const people = mc.people.filter(x => x.address && !x.me);
  const mine = me.address || 'You';
  const addForm = v.addOpen ? `<form class="ws-mtg-add-task" data-form="meeting-task" data-id="${e(m.id)}">${icon('plus')}<input class="ws-input" name="text" maxlength="2000" placeholder="Add a task from this meeting…" aria-label="New task from this meeting" autocomplete="off">${selectBox('name="owner" aria-label="Owner of the new task"', `${option(mine, 'Me', true)}${people.map(x => option(x.address, x.name, false)).join('')}${option('', 'Nobody yet', false)}`)}${button('Add', { type: 'submit' })}</form>` : '';
  const toAddHtml = toAdd.length ? `<div class="ws-mtg-item-list">${toAdd.map(t => toAddRow(p, mc, t, { open: v.itemOpen, ticked, me })).join('')}</div>` : '';
  const n = ticked.size;
  const addBtn = n >= 1 ? button(`Add ${n} to ${label}`, { action: 'meeting-items-add', variant: 'primary', attrs: { 'data-id': m.id }, className: 'ws-mtg-items-add' }) : '';
  const error = v.addError ? `<p class="ws-mtg-items-error">${e(v.addError)}</p>` : '';
  const inTasksHtml = inTasks.length ? `<div class="ws-mtg-items-board"><h4 class="ws-mtg-items-sub">In Tasks</h4>${inTasks.map(t => boardRow(p, t)).join('')}</div>` : '';
  const added = v.added && v.added.meetingId === m.id ? v.added : null;
  const footer = added && added.ids.length
    ? `<p class="ws-mtg-items-foot" role="status">Added ${added.ids.length} to Tasks · ${button('Undo', { action: 'meeting-items-undo', attrs: { 'data-id': m.id } })}</p>`
    : inTasks.length
      ? `<p class="ws-mtg-items-foot" role="status">${button(`${inTasks.length} in Tasks ›`, { action: 'meeting-board', variant: 'ghost', attrs: { 'data-id': m.id } })}</p>`
      : `<p class="ws-mtg-items-foot" role="status">None in this meeting yet.</p>`;
  return `<aside class="ws-mtg-items${pane ? ' ws-mtg-items-pane' : ''}" aria-label="Action items">
    <header class="ws-mtg-items-head"><h3>Action items</h3>${button('+ Add', { action: 'meeting-item-add-open', variant: 'ghost', size: 'sm', attrs: { 'data-id': m.id } })}</header>
    ${addForm}
    ${toAddHtml}
    ${addBtn}${error}
    ${inTasksHtml}
    ${footer}
  </aside>`;
}

// ---------------------------------------------------------------- files

const FILE_WHAT = {
  'transcript.vtt': 'Original transcript from Teams, untouched',
  'imported.vtt': 'The file you imported, untouched',
  'imported.txt': 'The file you imported, untouched',
  'transcript.md': 'Readable transcript: one line per speaker turn',
  'segments.json': 'Speaker turns with their start and end times',
  'meeting.json': 'Calendar details: organizer, attendees, join link',
  'meta.json': 'Where the transcript came from, templates, Claude, versions',
  'tasks.json': 'Tasks with owner, due date and the quote they came from',
  'run.log': 'What each notes run did, or why it failed',
};
const sizeLabel = n => (n < 1024 ? `${n} B` : n < 1024 * 1024 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1024 / 1024).toFixed(1)} MB`);
const fileIcon = n => (n.endsWith('.json') ? 'file-code' : n.endsWith('.md') ? 'note' : n.endsWith('.log') ? 'list' : 'transcript');

export function filesTab(p, mc) {
  const { m, r } = mc;
  if (!r.folder) {
    return explainer(p, mc) || card({ body: emptyState({ iconName: 'folder', title: 'No folder yet', text: 'Connect creates the meeting’s folder in your meetings folder as soon as it has the transcript.', actions: m.state === 'available' && mc.saveError && !mc.paused ? saveFix(mc, mc.saveError.code) : '' }) });
  }
  const read = mc.data.files;
  if (read?.error) return folderGone(mc, read.error);
  const name = folderName(mc);
  const root = String(r.folder).slice(0, Math.max(0, String(r.folder).length - name.length));
  const files = read?.files || null;
  const docName = file => mc.docs.find(doc => doc.file === file)?.name;
  const what = file => FILE_WHAT[file] || (docName(file) ? `${docName(file)}${mc.docs.find(doc => doc.file === file)?.id === r.main ? ' — the main notes' : ''}` : file.startsWith('transcript-') ? 'Another original transcript from Teams' : file.endsWith('.md') ? 'Notes' : '');
  const rows = files ? files.map(f => `<div class="ws-mtg-file">
      <span class="ws-mtg-file-icon">${icon(fileIcon(f.name))}</span>
      <div class="ws-mtg-file-copy"><strong>${e(f.name)}</strong>${what(f.name) ? `<small>${e(what(f.name))}</small>` : ''}</div>
      <span class="ws-mtg-file-size">${e(sizeLabel(Number(f.size) || 0))}</span>
      <span class="ws-mtg-file-act">${button('Preview', { action: 'meeting-file-preview', variant: 'ghost', size: 'sm', attrs: { 'data-id': m.id, 'data-file': f.name } })}${button('', { action: 'meeting-file-save', iconName: 'download', variant: 'ghost', size: 'sm', title: `Save a copy of ${f.name}`, attrs: { 'data-id': m.id, 'data-file': f.name } })}</span>
    </div>`).join('') : skeleton(5);
  return `<section class="ws-card ws-mtg-files-card">
    <header class="ws-card-header"><div class="ws-mtg-card-head"><h2 class="ws-card-title"><span class="ws-card-icon">${icon('folder')}</span><span class="ws-mtg-folder-name">${e(name)}</span></h2><p><code class="ws-mtg-path">${e(root)}</code></p></div>
      <div class="ws-card-actions">${button('Copy path', { action: 'meeting-copy-folder', iconName: 'copy', variant: 'ghost', size: 'sm', attrs: { 'data-id': m.id } })}${button('Show in Finder', { action: 'meeting-reveal', iconName: 'folder-open', size: 'sm', attrs: { 'data-id': m.id } })}</div></header>
    <div class="ws-card-body"><div class="ws-mtg-files">${files && !files.length ? '<p class="ws-muted ws-hint">The folder is empty.</p>' : rows}</div></div>
    <footer class="ws-card-footer"><p class="ws-hint ws-muted">${icon('info')} The same layout as Echo’s call folders, so existing folders and tools keep working.</p></footer>
  </section>`;
}

// ---------------------------------------------------------------- people

/** Who was invited, as the meeting's people popover lists them: who each one is (organizer, you,
 *  company), how much they talked (dimmed when they didn't), and their tasks; "+n more" past 12. */
export function peopleList(p, mc) {
  const segs = mc.segments || [];
  const total = segs.reduce((n, x) => n + String(x.text || '').length, 0) || 1;
  const spoke = address => segs.filter(x => String(x.address || '').toLowerCase() === address).reduce((n, x) => n + String(x.text || '').length, 0);
  const me = meOf(p.s);
  const all = p.v.peopleAll === mc.m.id;
  const shown = all ? mc.people : mc.people.slice(0, 12);
  const rows = shown.map(x => {
    const address = String(x.address || '').toLowerCase();
    const chars = mc.segments ? spoke(address) : null;
    const share = chars === null ? null : Math.round((chars / total) * 100);
    const note = [x.organizer ? 'organizer' : '', x.me ? 'you' : '', x.company].filter(Boolean).join(' · ');
    const tasks = mc.tasks.filter(t => String(t.data.owner || '').toLowerCase() === address || (x.me && isMine(t, me))).length;
    return `<div class="ws-mtg-person${chars === 0 ? ' ws-mtg-quiet' : ''}" title="${e(x.address || x.name)}">
      ${avatar({ name: x.name, size: 24, seed: address || x.name })}
      <span class="ws-mtg-person-copy"><strong>${e(x.name)}</strong>${note ? `<small>${e(note)}</small>` : ''}</span>
      <span class="ws-mtg-talk">${share === null ? '' : chars ? `${share}% talking` : 'didn’t speak'}</span>
      <span class="ws-mtg-person-tasks">${tasks ? (hasTranscript(mc.m) ? `<button type="button" class="ws-link ws-mtg-linkbtn" data-action="meeting-pane" data-pane="tasks">${plural(tasks, 'task')}</button>` : `<small>${plural(tasks, 'task')}</small>`) : ''}</span>
    </div>`;
  }).join('');
  const more = mc.people.length > shown.length ? `<button type="button" class="ws-link ws-mtg-linkbtn ws-mtg-people-more" data-action="meeting-people-all" data-id="${e(mc.m.id)}">+${mc.people.length - shown.length} more</button>` : '';
  return rows ? `<div class="ws-mtg-people">${rows}</div>${more}` : '<p class="ws-muted ws-hint">The calendar lists nobody for this meeting.</p>';
}
