// The meeting's five tabs on the Meetings page (Notes · Transcript · Tasks · Files · People), the
// explainers for meetings without a transcript, the template chip and the Make notes form the
// dialog and the Notes tab share. Pure: each takes the page (`p`, see view-meetings.js) and one
// meeting's context (`meetingContext`) and returns HTML; every meeting- or transcript-sourced
// string is escaped, notes Markdown goes through markdown.js.
import { escapeHtml as e } from './store.js';
import { icon } from './icons.js';
import { avatar, badge, button, card, emptyState, toggle } from './ui.js';
import { agoLabel, durationLabel, formatTime } from './format.js';
import { renderMarkdown } from './markdown.js';
import { columnName, isMine, meOf, ownerOf, peopleFor, taskStatus } from './tasks-model.js';
import { meetingTasks, peopleOf, resolveTemplate, ruleText, templatesOf } from './meetings-model.js';

export const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const option = (value, label, selected) => `<option value="${e(value)}"${selected ? ' selected' : ''}>${e(label)}</option>`;
export const selectBox = (attrs, options, cls = '') => `<span class="ws-select-wrap${cls ? ` ${cls}` : ''}"><select class="ws-select" ${attrs}>${options}</select>${icon('chevron-down', 'ws-select-caret')}</span>`;
const attr = (k, v) => ` ${k}="${e(v)}"`;
const COLOR = /^#[0-9a-f]{3,8}$/i;
/** A template's colour for `--tpl` (only a plain hex colour gets through). */
export const tplColor = t => (COLOR.test(String(t?.color || '')) ? t.color : '#5677C8');
const tplIcon = t => (t?.kind === 'skill' ? 'skill' : ['note', 'list', 'users', 'sparkles', 'quote', 'tasks', 'transcript'].includes(t?.icon) ? t.icon : 'note');

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
  return {
    m, d, r, docs, tasks, data,
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

/** The Make notes form (dialog and Notes tab): the template (the meeting's choice first; with
 *  documents already, the first template without one is picked), what to focus on, tasks,
 *  remembering the choice, and where the result goes. */
export function makeNotesForm(p, mc) {
  const all = templatesOf(p.s);
  const current = mc.tpl.template;
  const has = new Map(mc.docs.map(doc => [doc.template || doc.id, doc]));
  const pick = mc.docs.length ? (all.find(t => !has.has(t.id) && t.kind !== 'skill') || all.find(t => !has.has(t.id)) || current) : current;
  const ordered = [current, ...all.filter(t => t.id !== current.id)];
  const options = ordered.map(t => {
    const doc = has.get(t.id);
    const tag = doc ? `<em class="ws-tpl-tag ws-tpl-has-doc">Made · adds version ${Math.max(Number(doc.version) || 1, ...(doc.versions || []).map(v => Number(v.version) || 0)) + 1}</em>`
      : t.id === current.id ? `<em class="ws-tpl-tag">${mc.tpl.why === 'meeting' ? 'Chosen' : mc.tpl.why === 'rule' ? 'From rule' : 'Default'}</em>` : '';
    const kind = t.kind === 'skill' ? badge('Skill', 'purple', 'skill') : t.kind === 'custom' ? badge('Yours', 'info') : '';
    return `<label class="ws-tpl-option" style="--tpl:${tplColor(t)}"><input type="radio" name="template" value="${e(t.id)}"${t.id === pick.id ? ' checked' : ''}><span class="ws-tpl-icon">${icon(tplIcon(t))}</span><span class="ws-tpl-copy"><strong><span>${e(t.name)}</span>${tag}${kind}</strong>${t.blurb ? `<small>${e(t.blurb)}</small>` : ''}</span></label>`;
  }).join('');
  const review = p.s.settings.meetings?.review !== false;
  const n = mc.docs.length;
  const keep = n ? `<p class="ws-mtg-keep">${icon('check-circle')}<span>Your ${n > 1 ? `${n} documents stay as they are` : `<strong>${e(mc.docs[0].name)}</strong> stays as it is`}. Another template adds a document next to ${n > 1 ? 'them' : 'it'}; the same template adds a new version.</span></p>` : '';
  const folder = folderName(mc);
  const remember = n ? '' : `<label class="ws-check"><input type="checkbox" name="remember"${mc.tpl.why === 'rule' ? ' disabled' : ''}><span class="ws-check-box" aria-hidden="true">${icon('check')}</span><span class="ws-check-text"><span>Always use this template for “${e(mc.d.title || mc.m.title)}”</span><small>${mc.tpl.why === 'rule' ? e(mc.tpl.reason) : 'Adds a rule to your automatic rules.'}</small></span></label>`;
  return `${keep}<div class="ws-mtg-form-grid">
    <fieldset class="ws-tpl-options"><legend class="ws-field-label">Template</legend>${options}<button type="button" class="ws-link ws-mtg-linkbtn ws-tpl-more" data-action="settings-tab" data-tab="meetings-templates">${icon('plus')}<span>Write your own or add a skill</span></button></fieldset>
    <div class="ws-mtg-form-side">
      <label class="ws-field"><span class="ws-field-label">Anything to focus on? <small class="ws-muted">optional</small></span><textarea class="ws-textarea" name="wishes" rows="3" maxlength="1000" placeholder="e.g. Focus on the pilot plan. Keep it short."></textarea><small class="ws-field-hint">Added to the template’s instructions for this run only.</small></label>
      <div class="ws-mtg-form-checks">
        <label class="ws-check"><input type="checkbox" name="findTasks" checked><span class="ws-check-box" aria-hidden="true">${icon('check')}</span><span class="ws-check-text"><span>Find tasks and owners</span><small>${review ? 'New ones land in To review; ones already found are kept.' : 'They go straight to To do; ones already found are kept.'}</small></span></label>
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
  return `<article class="ws-md${compact ? ' ws-md-compact' : ''}">${renderMarkdown(read.text)}</article>`;
}

function docEditor(p, mc, doc, ed) {
  const conflict = ed.conflict ? `<div class="ws-banner ws-banner-warning ws-mtg-conflict" role="alert">${icon('alert')}<div><strong>These notes changed while you were editing</strong><p>Version ${e(ed.conflict.version)} was saved meanwhile, so your edit wasn’t saved over it. Read the newer text, then start again from it — your edit stays below to copy from.</p><details class="ws-mtg-newer"><summary>The newer text</summary><pre class="ws-mtg-pre">${e(ed.conflict.text)}</pre></details></div><div class="ws-actions">${button('Copy my edit', { action: 'doc-edit-copy', variant: 'ghost', size: 'sm', iconName: 'copy' })}${button('Start from the newer text', { action: 'doc-edit-rebase', variant: 'primary', size: 'sm', attrs: { 'data-id': mc.m.id, 'data-doc': doc.id } })}</div></div>` : '';
  const mine = !ed.conflict && ed.mine ? `<details class="ws-mtg-newer ws-mtg-mine"><summary>Your earlier edit</summary><pre class="ws-mtg-pre">${e(ed.mine)}</pre></details>` : '';
  return `${conflict}${mine}<textarea id="meeting-doc-editor" class="ws-textarea ws-mtg-editor" spellcheck="true" aria-label="Edit ${e(doc.name)} (Markdown)">${e(ed.draft)}</textarea>`;
}

function docCard(p, mc, doc, { compare = false, side = 'left' } = {}) {
  const { m, r } = mc;
  const t = templatesOf(p.s).find(x => x.id === doc.template) || { name: doc.name, kind: 'builtin', color: '#5677C8' };
  const ed = p.v.editing && p.v.editing.meetingId === m.id && p.v.editing.docId === doc.id && !compare ? p.v.editing : null;
  const viewing = !compare && !ed ? Number(p.v.version?.[docKey(m.id, doc.id)]) || null : null;
  const earlier = viewing && (doc.versions || []).find(v => Number(v.version) === viewing);
  const versions = [{ version: doc.version, at: doc.updatedAt, edited: doc.edited, current: true }, ...[...(doc.versions || [])].reverse().map(v => ({ ...v, current: false }))];
  const ids = { 'data-id': m.id, 'data-doc': doc.id };
  const isMain = doc.id === r.main;
  const vSelect = versions.length > 1 && !ed ? selectBox(`data-action="doc-version" data-id="${e(m.id)}" data-doc="${e(doc.id)}" aria-label="Version of ${e(doc.name)}"`, versions.map(v => option(v.current ? '' : v.version, `Version ${v.version}${v.current ? ' (current)' : ''} · ${agoLabel(v.at, p.zone, p.now)}${v.edited ? ' · edited' : ''}`, v.current ? !earlier : Number(v.version) === viewing)).join(''), 'ws-mtg-ver-select') : '';
  const picker = compare
    ? selectBox(`data-action="doc-compare-pick" data-id="${e(m.id)}" data-side="${side}" aria-label="Document on the ${side}"`, mc.docs.map(x => option(x.id, `${x.name}${x.id === r.main ? ' (main)' : ''}`, x.id === doc.id)).join(''), 'ws-mtg-doc-pick')
    : `<span class="ws-mtg-doc-name" style="--tpl:${tplColor(t)}"><span class="ws-tpl-dot"></span>${e(doc.name)}</span>`;
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
  const meta = compare ? '' : `<p class="ws-mtg-doc-meta">${e(kind)} · made ${e(agoLabel(made.at || made.updatedAt, p.zone, p.now))} ${made.auto ? 'automatically' : 'by you'}${who ? ` · ${e(who)}` : ''}${made.edited ? ' · edited' : ''}${versions.length > 1 ? ` · version ${e(made.version)} of ${versions.length}` : ''}${!isMain && !earlier ? ` · <button type="button" class="ws-link ws-mtg-linkbtn" data-action="doc-main" data-id="${e(m.id)}" data-doc="${e(doc.id)}">make it the main notes</button>` : ''}</p>`;
  const earlierBar = earlier ? `<div class="ws-mtg-version-bar">${icon('history')}<span>You’re reading version ${e(viewing)}, from ${e(agoLabel(earlier.at, p.zone, p.now))}. The current one is version ${e(doc.version)}.</span>${button('Back to the current one', { action: 'doc-version-current', variant: 'ghost', size: 'sm', attrs: ids })}${button('Use this version', { action: 'doc-use-version', size: 'sm', attrs: { ...ids, 'data-version': viewing } })}</div>` : '';
  const wishes = made.wishes ? `<p class="ws-mtg-wishes">${icon('quote')}<span>You asked: “${e(made.wishes)}”</span></p>` : '';
  const count = read?.text ? `${words(read.text)} words · ` : '';
  return `<section class="ws-card ws-mtg-doc${compare ? ' ws-mtg-doc-compare' : ''}" data-doc="${e(doc.id)}">
    <header class="ws-mtg-doc-bar">${picker}${isMain && !compare ? '<em class="ws-mtg-main">Main</em>' : ''}${vSelect}<span class="ws-muted ws-mtg-small ws-mtg-hide-narrow">${count}${e(doc.file || '')}</span><span class="ws-spacer"></span>${tools}</header>
    ${meta}${earlierBar}${wishes}
    ${ed ? docEditor(p, mc, doc, ed) : docBody(p, mc, doc, earlier ? viewing : null, compare)}
  </section>`;
}

export function notesTab(p, mc) {
  const { m, r, docs, run } = mc;
  const notesRun = run?.kind === 'meeting_notes' ? run : null;
  if ((notesRun || run?.kind === 'transcript_download') && !docs.length) return card({ className: 'ws-mtg-busy-card', body: skeleton() });
  if (['pending', 'blocked', 'none', 'offline', 'upcoming'].includes(m.state)) return explainer(p, mc);
  const failedBanner = !r.lastError || notesRun ? ''
    : ['failed', 'ready'].includes(m.state) ? lastRunBanner(mc)
      : m.state === 'available' ? `<div class="ws-banner ws-banner-warning ws-mtg-run-failed" role="status">${icon('alert')}<div><strong>Couldn’t get the transcript from Teams</strong><p>${e(r.lastError.message || '')} ${e(saveNextStep(r.lastError.code))} Make notes tries again first.</p></div><div class="ws-actions">${saveFix(mc, r.lastError.code)}</div></div>` : '';
  if (!docs.length) {
    const intro = m.state === 'available' ? 'Connect gets the transcript from Teams first, then writes the notes.' : mc.segments ? `${plural(mc.segments.length, 'line')} from ${plural(new Set(mc.segments.map(x => x.address || x.voice)).size, 'speaker')}, already in the meeting folder.` : 'The transcript is in the meeting folder.';
    return `${failedBanner}<form class="ws-card ws-mtg-make" data-form="meeting-notes" data-id="${e(m.id)}">
      <header class="ws-card-header"><div class="ws-mtg-card-head"><h2 class="ws-card-title"><span class="ws-card-icon">${icon('sparkles')}</span>Make notes from this transcript</h2><p>${e(intro)}</p></div></header>
      <div class="ws-card-body">${makeNotesForm(p, mc)}</div>
      <footer class="ws-card-footer ws-mtg-make-foot"><span class="ws-spacer"></span>${button('Make notes', { type: 'submit', variant: 'magic', iconName: 'sparkles', size: 'lg' })}</footer>
    </form>`;
  }
  const view = docs.find(x => x.id === p.v.docView?.[m.id]) || mc.main || docs[0];
  const compare = !!p.v.compare && docs.length > 1;
  const chips = docs.map(doc => {
    const t = templatesOf(p.s).find(x => x.id === doc.template) || {};
    const mark = doc.auto ? icon('automations', 'ws-mtg-doctab-icon') : t.kind === 'skill' ? icon('skill', 'ws-mtg-doctab-icon') : t.kind === 'custom' ? icon('user', 'ws-mtg-doctab-icon') : '';
    return `<button type="button" role="tab" class="ws-mtg-doctab" data-action="doc-view" data-id="${e(m.id)}" data-doc="${e(doc.id)}" aria-selected="${!compare && doc.id === view.id}" style="--tpl:${tplColor(t)}"><span class="ws-tpl-dot"></span><span>${e(doc.name)}</span>${doc.id === r.main ? '<em class="ws-mtg-main">Main</em>' : ''}${mark}</button>`;
  }).join('');
  const busy = notesRun ? `<span class="ws-mtg-doctab ws-mtg-doctab-busy" role="status">${icon('refresh', 'ws-spin')}<span>Making ${e((templatesOf(p.s).find(t => t.id === notesRun.templateId) || {}).name || 'notes')}…</span></span>`
    : `<button type="button" class="ws-mtg-doctab ws-mtg-doctab-add" data-action="meeting-make-notes" data-id="${e(m.id)}">${icon('plus')}<span>Another summary</span></button>`;
  const layout = docs.length > 1 ? `<div class="ws-segmented" role="tablist" aria-label="Layout"><button type="button" role="tab" data-action="meeting-compare" data-v="0" aria-selected="${!compare}">${icon('note')}One</button><button type="button" role="tab" data-action="meeting-compare" data-v="1" aria-selected="${compare}">${icon('board')}Side by side</button></div>` : '';
  const bar = `<div class="ws-mtg-docbar"><div class="ws-mtg-doctabs" role="tablist" aria-label="Documents">${chips}${busy}</div>${layout}</div>`;
  if (compare) {
    const right = docs.find(x => x.id === p.v.compareWith?.[m.id] && x.id !== view.id) || docs.find(x => x.id !== view.id);
    return `${failedBanner}${bar}<div class="ws-mtg-compare">${docCard(p, mc, view, { compare: true, side: 'left' })}${docCard(p, mc, right, { compare: true, side: 'right' })}</div>`;
  }
  return `${failedBanner}${bar}${docCard(p, mc, view)}`;
}

/** The last notes run failed: why, and the way on (sign in again, Try again). */
function lastRunBanner(mc) {
  const err = mc.r.lastError || {};
  const login = err.code === 'needs_login';
  const choice = err.code === 'needs_choice';
  return `<div class="ws-banner ws-banner-warning ws-mtg-run-failed" role="status">${icon('alert')}<div><strong>${mc.docs.length ? 'The last notes run didn’t finish' : 'The notes weren’t written'}</strong><p>${e(err.message || 'Claude stopped before the notes were ready.')} ${mc.docs.length ? 'Your documents are as they were.' : 'Nothing was lost — the transcript is in the folder, and the run log is in Files.'}</p></div><div class="ws-actions">${login || choice ? button(login ? 'Sign in again' : 'Choose Claude', { action: 'ai-open-settings', variant: 'ghost' }) : ''}${button('Try again', { action: 'meeting-retry', variant: 'primary', iconName: 'refresh', attrs: { 'data-id': mc.m.id } })}</div></div>`;
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
  return `<div class="ws-banner ws-mtg-speakers-banner">${icon('users')}<div><strong>${e(title)}</strong><p>${e(text)}</p></div><div class="ws-mtg-speaker-map">${unnamed.map(seg => `<label><span>${e(seg.name)}</span>${selectBox(`data-action="meeting-speaker" data-id="${e(mc.m.id)}" data-voice="${e(seg.voice)}" aria-label="${e(`Who is ${seg.name}?`)}"`, `${option('', 'Who is it?', true)}${choices.map(x => option(x.address, x.name, false)).join('')}`)}</label>`).join('')}</div></div>`;
}

/** A transcript that isn't readable yet: still in Teams, its save failed, being read, or gone. */
function transcriptMissing(p, mc) {
  const { m, r } = mc;
  if (['pending', 'blocked', 'none', 'offline', 'upcoming'].includes(m.state)) return explainer(p, mc);
  if (m.state === 'available') {
    const err = r.lastError;
    return card({ body: emptyState({ iconName: 'transcript', title: err ? 'Couldn’t get the transcript from Teams' : 'Saving the transcript from Teams', text: err ? `${err.message || ''} ${saveNextStep(err.code)}`.trim() : 'It shows here in a moment, with a copy in the meeting folder.', actions: err ? saveFix(mc, err.code) : '' }) });
  }
  const read = mc.data.transcript;
  if (read?.error) return folderGone(mc, read.error);
  return card({ body: skeleton(8) });
}

const SAVE_NEXT = {
  folder_unwritable: 'Choose the meetings folder again in Settings.',
  needs_login: 'Sign in to Microsoft 365 again, then try again.',
  throttled: 'Connect tries again by itself in a few minutes.',
  offline: 'Connect tries again by itself once it is online.',
  provider: 'Connect tries again by itself in a few minutes.',
  transcript_missing: 'Teams no longer has it. Import the file instead.',
};
export const saveNextStep = code => SAVE_NEXT[code] || '';

/** What a failed save offers: sign in again, or Try again. */
export function saveFix(mc, code) {
  if (code === 'needs_login') return button('Sign in again', { action: 'graph-connect', variant: 'primary' });
  if (code === 'transcript_missing') return button('Import transcript file', { action: 'meeting-import', variant: 'primary', iconName: 'upload', attrs: { 'data-id': mc.m.id } });
  return button('Try again', { action: 'meeting-download', variant: 'primary', iconName: 'refresh', attrs: { 'data-id': mc.m.id } });
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
      <div class="ws-mtg-line-body">${same ? '' : `<strong>${e(seg.name)}${!named ? ' <button type="button" class="ws-mtg-name-it" data-action="meeting-tab" data-tab="people">Who is this?</button>' : ''}</strong>`}<p>${highlight(seg.text, pairs, q)}</p>
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

// ---------------------------------------------------------------- tasks

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

export function tasksTab(p, mc) {
  const { m } = mc;
  const order = t => (taskStatus(t) === 'review' ? 0 : taskStatus(t) === 'done' ? 2 : 1);
  const tasks = [...mc.tasks].sort((a, b) => order(a) - order(b) || (Number(a.data.line) || 0) - (Number(b.data.line) || 0));
  const review = mc.review.length;
  const me = meOf(p.s);
  const quote = t => {
    const seg = Number.isInteger(t.data.line) ? mc.segments?.[t.data.line] : null;
    const text = seg?.text || t.data.quote;
    if (!text) return '<small class="ws-muted">Added by you</small>';
    const who = seg?.name || t.data.speaker || '';
    const first = who.includes(',') ? who.split(',')[1].trim().split(/\s+/)[0] : who.split(/\s+/)[0];
    const at = seg ? formatTime(transcriptBase(mc) + Number(seg.start || 0) * 1000, p.zone) : Number.isFinite(t.data.quoteAt) ? formatTime(transcriptBase(mc) + t.data.quoteAt * 1000, p.zone) : '';
    const short = text.length > 140 ? `${text.slice(0, 138)}…` : text;
    return `<button type="button" class="ws-mtg-quote" data-action="meeting-goto-line" data-id="${e(m.id)}" data-line="${e(t.data.line ?? '')}" title="Show in the transcript">${icon('quote')}<span>${first ? `${e(first)}: ` : ''}“${e(short)}”</span>${at ? `<em>${e(at)}</em>` : ''}</button>`;
  };
  const row = t => {
    const status = taskStatus(t);
    const isReview = status === 'review';
    return `<div class="ws-mtg-trow${isReview ? ' ws-mtg-trow-review' : ''}${status === 'done' ? ' ws-mtg-trow-done' : ''}">
      <label class="ws-check" title="${status === 'done' ? 'Mark as not done' : 'Mark as done'}"><input type="checkbox" data-action="task-done" data-id="${e(t.id)}"${status === 'done' ? ' checked' : ''} aria-label="${status === 'done' ? 'Reopen' : 'Mark as done'}: ${e(t.data.text)}"><span class="ws-check-box" aria-hidden="true">${icon('check')}</span></label>
      <div class="ws-mtg-trow-main">
        <button type="button" class="ws-mtg-trow-title" data-action="task-open-today" data-id="${e(t.id)}">${e(t.data.text)}</button>
        ${quote(t)}
        ${isReview && t.data.confidence === 'low' ? `<span class="ws-mtg-low">${icon('alert')}Not sure about the owner — check it</span>` : ''}
      </div>
      ${ownerSelect(p, t)}
      <input type="date" class="ws-input ws-mtg-date" value="${e(t.data.due || '')}" data-commit="task-due" data-id="${e(t.id)}" aria-label="Due date of ${e(t.data.text)}">
      ${isReview ? `<span class="ws-mtg-trow-act">${button('', { action: 'task-dismiss', iconName: 'close', variant: 'ghost', size: 'sm', title: 'Dismiss — not a task', attrs: { 'data-id': t.id } })}${button('Accept', { action: 'task-accept', variant: 'primary', size: 'sm', iconName: 'check', attrs: { 'data-id': t.id } })}</span>`
    : selectBox(`data-action="task-status" data-id="${e(t.id)}" aria-label="Status of ${e(t.data.text)}"`, ['todo', 'doing', 'waiting', 'done'].map(c => option(c, columnName(c, p.s.settings), status === c)).join(''), 'ws-mtg-status')}
    </div>`;
  };
  const empty = m.state === 'ready'
    ? emptyState({ iconName: 'tasks', title: 'No tasks in this meeting', text: 'The notes didn’t name any concrete next steps. Add one yourself if something was agreed.' })
    : emptyState({ iconName: 'tasks', title: 'Tasks come from the notes', text: 'Make notes first: Connect finds the tasks and matches each owner to someone in the meeting.', actions: ['available', 'downloaded', 'failed'].includes(m.state) ? button('Make notes', { action: 'meeting-make-notes', variant: 'primary', iconName: 'sparkles', attrs: { 'data-id': m.id } }) : '' });
  const people = mc.people.filter(x => x.address && !x.me);
  const mine = me.address || 'You';
  return `<section class="ws-card ws-mtg-tasks">
    <header class="ws-card-header"><div class="ws-mtg-card-head"><h2 class="ws-card-title"><span class="ws-card-icon">${icon('tasks')}</span>Tasks from this meeting</h2>${review ? `<p>${plural(review, 'task')} found in the notes ${review === 1 ? 'waits' : 'wait'} for your review — check the owner and the date, then accept.</p>` : tasks.length ? '<p>From every document of this meeting, without duplicates. Changes show on your Tasks board too.</p>' : ''}</div>
      <div class="ws-card-actions">${review > 1 ? button(`Accept all ${review}`, { action: 'meeting-tasks-accept', iconName: 'check', size: 'sm', attrs: { 'data-id': m.id } }) : ''}${button('Open on board', { action: 'meeting-board', variant: 'ghost', size: 'sm', iconRight: 'arrow', attrs: { 'data-id': m.id } })}</div></header>
    <div class="ws-card-body">${tasks.length ? `<div class="ws-mtg-trows">${tasks.map(row).join('')}</div>` : empty}
      <form class="ws-mtg-add-task" data-form="meeting-task" data-id="${e(m.id)}">${icon('plus')}<input class="ws-input" name="text" maxlength="2000" placeholder="Add a task from this meeting…" aria-label="New task from this meeting" autocomplete="off">${selectBox('name="owner" aria-label="Owner of the new task"', `${option(mine, 'Me', true)}${people.map(x => option(x.address, x.name, false)).join('')}${option('', 'Nobody yet', false)}`)}${button('Add', { type: 'submit' })}</form>
    </div>
  </section>`;
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
    return explainer(p, mc) || card({ body: emptyState({ iconName: 'folder', title: 'No folder yet', text: 'Connect creates the meeting’s folder in your meetings folder as soon as it has the transcript.', actions: m.state === 'available' && r.lastError ? saveFix(mc, r.lastError.code) : '' }) });
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

export function peopleTab(p, mc) {
  const { m, r } = mc;
  const segs = mc.segments || [];
  const total = segs.reduce((n, x) => n + String(x.text || '').length, 0) || 1;
  const spoke = address => segs.filter(x => String(x.address || '').toLowerCase() === address).reduce((n, x) => n + String(x.text || '').length, 0);
  const unnamed = [];
  const seen = new Set();
  for (const seg of segs) if (!seg.address && !seen.has(seg.voice)) { seen.add(seg.voice); unnamed.push(seg); }
  const was = address => Object.entries(r.speakers || {}).filter(([, a]) => String(a).toLowerCase() === address).map(([voice]) => voice);
  const me = meOf(p.s);
  const rows = mc.people.map(x => {
    const address = String(x.address || '').toLowerCase();
    const chars = mc.segments ? spoke(address) : null;
    const share = chars === null ? null : Math.round((chars / total) * 100);
    const tasks = mc.tasks.filter(t => String(t.data.owner || '').toLowerCase() === address || (x.me && isMine(t, me))).length;
    return `<div class="ws-mtg-person">
      ${avatar({ name: x.name, size: 36, seed: address || x.name })}
      <div class="ws-mtg-person-copy"><strong>${e(x.name)}</strong>${x.me ? '<small class="ws-mtg-you">you</small>' : ''}<small>${e([x.address, x.company].filter(Boolean).join(' · '))}</small></div>
      <span class="ws-mtg-person-badges">${x.organizer ? badge('Organizer', 'info') : ''}${was(address).map(v => badge(`was “${v}”`, 'purple')).join('')}</span>
      <span class="ws-mtg-talk">${share === null ? '' : chars ? `<i style="--w:${share}%"></i><small>${share}% talking</small>` : '<small class="ws-muted">didn’t speak</small>'}</span>
      <span class="ws-mtg-person-tasks">${tasks ? `<button type="button" class="ws-link ws-mtg-linkbtn" data-action="meeting-tab" data-tab="tasks">${plural(tasks, 'task')}</button>` : '<small class="ws-muted">no tasks</small>'}</span>
    </div>`;
  }).join('');
  return `${unnamed.length ? speakerMap(p, mc, unnamed, ['Match the unnamed speakers', 'Pick who each voice is. Connect remembers it for this meeting and rewrites the transcript, so tasks get the right owner.']) : ''}
  <section class="ws-card ws-mtg-people-card">
    <header class="ws-card-header"><div class="ws-mtg-card-head"><h2 class="ws-card-title"><span class="ws-card-icon">${icon('users')}</span>${plural(mc.people.length, 'person', 'people')} invited</h2><p>Tasks go only to people who were in the meeting, unless you pick someone else.</p></div></header>
    <div class="ws-card-body"><div class="ws-mtg-people">${rows || '<p class="ws-muted ws-hint">The calendar lists nobody for this meeting.</p>'}</div></div>
  </section>`;
}
