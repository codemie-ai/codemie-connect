// Meetings (spec "Meetings page", "Page sections"): page sections — a compact list of meetings
// grouped by day (time, title, a coloured status, a spinner only while something runs; filters
// All · To do · Ready · Needs you · Upcoming, search, Make notes for all) and the meeting's five
// tabs from view-meeting-tabs.js, which can sit side by side. The meeting's header (when, who by
// name, the Transcript › Notes › Tasks strip with a button only where something is needed, a slim
// progress line during a run) shows once, above the first section holding a meeting tab. Also
// the transcript badge and the "Transcript & notes" section the calendar uses, Today's "From
// your meetings" card, and the Make notes and Import dialogs' bodies. Pure: takes the snapshot
// and the page's view state (`ctx.state.meetings`), its sections (`ctx.dock`), plus what the
// controller read of meeting folders (`ctx.reads(id)`) and the parsed glossary (`ctx.glossary`),
// and returns HTML.
import { escapeHtml as e } from './store.js';
import { icon } from './icons.js';
import { avatar, button, card, emptyState, select, toggle } from './ui.js';
import { addDaysToKey, agoLabel, dayKey, durationLabel, formatDate, formatTime } from './format.js';
import { taskStatus } from './tasks-model.js';
import { activateTab, normalizeDock, paneOf } from './dock-model.js';
import { renderDock } from './dock-view.js';
import {
  LANES, LEGEND, STATES, TABS, legendOf, meetingCounts, meetingErrors, meetingItems, meetingRows, newMeetingsView, resolveTemplate, rulesOf, tasksByMeeting, transcriptsAllowed,
} from './meetings-model.js';
import {
  dotsSummary, explainer, filesTab, makeNotesForm, meetingContext, menu, notesTab, peopleTab, plural, PAUSED, pausedFix, saveFixAction, saveNextStep, tasksTab, tplChip, tplColor, transcriptTab,
} from './view-meeting-tabs.js';

/** Meetings' sections (spec "Page sections"): the list, pinned to Today as "From your meetings"
 *  (the `meetings` widget), and the meeting's five tabs, `mtg-<tab>` for each of `TABS`. */
export const MEETINGS_DOCK = {
  title: 'Meetings',
  tabs: {
    'mtg-list': { title: 'Meetings', icon: 'meetings', min: 260, w: 340, pin: 'meetings', pinTitle: 'From your meetings' },
    'mtg-notes': { title: 'Notes', icon: 'note', min: 340, w: 760 },
    'mtg-transcript': { title: 'Transcript', icon: 'transcript', min: 320, w: 520 },
    'mtg-tasks': { title: 'Tasks', icon: 'tasks', min: 300, w: 420 },
    'mtg-files': { title: 'Files', icon: 'folder', min: 300, w: 420 },
    'mtg-people': { title: 'People', icon: 'users', min: 260, w: 320 },
  },
  initial: [['mtg-list'], ['mtg-notes', 'mtg-transcript', 'mtg-tasks', 'mtg-files', 'mtg-people']],
};

const PILL_TONE = { muted: 'neutral', info: 'info', purple: 'purple', success: 'success', error: 'error', warning: 'warning' };
const STATE_ICON = { upcoming: 'clock', pending: 'refresh', available: 'transcript', downloaded: 'transcript', ready: 'sparkles', failed: 'alert', blocked: 'lock', none: 'minus', offline: 'pin' };

/** Everything one render needs, computed once. */
function pageOf(s, ctx = {}) {
  const now = ctx.now ?? Date.now();
  const v = { ...newMeetingsView(), ...(ctx.state?.meetings || {}) };
  const items = ctx.items || meetingItems(s, now);
  return {
    s, v, now, zone: s.settings.timeZone, items, byId: new Map(items.map(m => [m.id, m])), reads: ctx.reads || (() => ({})), glossary: ctx.glossary || null,
    rules: rulesOf(s), tasksBy: tasksByMeeting(s),
  };
}

/** "Today", "Yesterday", "Tomorrow" or null for a day further away. */
function relDay(value, zone, now) {
  const key = dayKey(value, zone);
  const today = dayKey(now, zone);
  if (key === today) return 'Today';
  if (key === addDaysToKey(today, -1)) return 'Yesterday';
  if (key === addDaysToKey(today, 1)) return 'Tomorrow';
  return null;
}
const longDay = (value, zone) => formatDate(value, zone, { weekday: 'long', month: 'long', day: 'numeric' });
const shortDay = (value, zone) => formatDate(value, zone, { weekday: 'short', month: 'short', day: 'numeric' });

// ---------------------------------------------------------------- shared pieces

/** What a running job is doing, in a few words. */
function runText(run, p) {
  if (run.kind === 'meeting_notes') return run.step || (run.state === 'queued' ? 'Waiting for Claude' : 'Starting');
  if (run.kind === 'transcript_download') return 'Saving the transcript';
  return 'Checking Teams';
}

/** The state shown for a meeting: a running notes job or save is `processing` / `downloading`. */
const shownState = m => (m.run?.kind === 'meeting_notes' ? 'processing' : m.run?.kind === 'transcript_download' ? 'downloading' : m.state);

/** The coloured status line of a meeting: its label and tone. A meeting that waits while
 *  transcripts are off never looks like work in progress. */
function statusOf(m, mc) {
  if (m.run && m.run.kind !== 'transcript_check') return { tone: m.run.kind === 'meeting_notes' ? 'purple' : 'info', label: `${runText(m.run)}…` };
  if (m.paused) return { tone: 'warning', label: PAUSED[m.paused].status };
  if (m.state === 'available' && mc.saveError) return mc.saveError.code === 'cancelled' ? { tone: 'muted', label: 'Saving stopped' } : { tone: 'error', label: 'Couldn’t get the transcript' };
  if (m.state === 'upcoming') return { tone: 'muted', label: m.online ? (mc.tpl.auto ? 'Notes after the meeting' : 'Upcoming') : mc.d.location || 'In person' };
  return STATES[m.state] ? { tone: STATES[m.state].tone, label: STATES[m.state].label } : { tone: 'muted', label: m.state };
}

/** A small pill with the state, as the event card shows it. */
export function statePill(m, mc) {
  const st = statusOf(m, mc);
  const spin = m.run || (m.state === 'pending' && !m.paused);
  return `<span class="ws-pill ws-pill-${PILL_TONE[st.tone] || 'neutral'}">${icon(spin ? 'refresh' : STATE_ICON[m.state] || 'clock', spin ? 'ws-spin' : '')}${e(st.label.replace(/…$/, ''))}</span>`;
}

/** The one thing to do next for a meeting (Make notes, Try again, Import, Check now); `ready`
 *  meetings get Another summary in the meeting's header and Open notes elsewhere. */
export function primaryAction(m, mc, { size, where = 'detail' } = {}) {
  if (m.run && m.run.kind !== 'transcript_check') return '';
  const id = { 'data-id': m.id };
  if (m.paused) return pausedFix(m.paused, size);
  switch (m.state) {
    case 'available':
    case 'downloaded': return button('Make notes', { action: 'meeting-make-notes', variant: 'primary', iconName: 'sparkles', attrs: id, size });
    case 'ready': return where === 'detail' ? button('Another summary', { action: 'meeting-make-notes', iconName: 'plus', attrs: id, size }) : button('Open notes', { action: 'meeting-open', iconName: 'note', attrs: id, size });
    case 'failed': return button('Try again', { action: 'meeting-retry', variant: 'primary', iconName: 'refresh', attrs: id, size });
    case 'blocked': return button('Import file', { action: 'meeting-import', iconName: 'upload', attrs: id, size });
    case 'pending': return button('Check now', { action: 'meeting-check', iconName: 'refresh', variant: 'ghost', attrs: id, size });
    case 'none': case 'offline': return m.ended ? button('Import file', { action: 'meeting-import', iconName: 'upload', variant: 'ghost', attrs: id, size }) : '';
    default: return '';
  }
}

/** One line on where a meeting stands (the event card and Today). */
function stateLine(m, mc) {
  if (m.run && m.run.kind !== 'transcript_check') return `${e(runText(m.run))}…`;
  if (m.paused) return e(PAUSED[m.paused].line);
  const tasks = mc.tasks.length;
  const review = mc.review.length;
  switch (m.state) {
    case 'ready': return tasks ? `${plural(tasks, 'task')}${review ? ` · <span class="ws-mtg-accent">${review} to review</span>` : ' on the board'}` : 'No tasks found';
    case 'downloaded': return `Transcript saved${mc.imported ? ' · from a file' : ''}`;
    case 'available': return mc.saveError ? `<span class="ws-mtg-err">${mc.saveError.code === 'cancelled' ? 'Saving stopped' : 'Couldn’t get it from Teams'}</span> · ${e(mc.saveError.message || '')}` : 'Saving it from Teams…';
    case 'pending': return mc.tpl.auto ? `${icon('automations')}Notes as soon as it arrives` : 'Teams usually has it 5–15 minutes after the end';
    case 'failed': return `<span class="ws-mtg-err">${e(mc.notesError?.message || 'The notes run failed.')}</span>`;
    case 'blocked': return 'Guests can’t read it — import the file';
    case 'none': return 'Nobody started transcription';
    case 'offline': return e(mc.d.location || 'In person');
    case 'upcoming': return m.online ? (mc.tpl.auto ? `${icon('automations')}Notes made automatically` : 'Transcript saved after it ends') : e(mc.d.location || 'In person');
    default: return '';
  }
}

/** The transcript badge on a calendar event (Teams meetings only): its legend colour and icon;
 *  `label` adds the words (the agenda). */
export function tBadge(s, m, { label = false, rules } = {}) {
  if (!m?.online) return '';
  const auto = m.state === 'upcoming' && resolveTemplate(m.ev, m.rec, s, rules).auto;
  const key = legendOf(m.state, { busy: !!m.run, auto, paused: m.paused });
  if (!key) return '';
  const [, text, ico] = LEGEND.find(([id]) => id === key);
  const st = shownState(m);
  const docs = m.rec?.data?.docs || [];
  const main = docs.find(d => d.id === m.rec?.data?.main) || docs[0];
  const title = m.paused ? PAUSED[m.paused].line : `${(STATES[st]?.label || text).replace(/…$/, '')}${st === 'ready' && main ? ` · ${main.name}` : ''}`;
  return `<span class="ws-tb ws-tb-${key}${label ? ' ws-tb-label' : ''}" title="${e(title)}">${icon(ico, key === 'busy' ? 'ws-spin' : '')}${label ? `<span>${e(text)}</span>` : ''}</span>`;
}

/** The calendar's meetings by event id, with each one's legend group (null: no badge). */
export function calendarMeetings(s, now = Date.now()) {
  const out = new Map();
  const rules = rulesOf(s);
  for (const m of meetingItems(s, now)) {
    const auto = m.online && m.state === 'upcoming' && resolveTemplate(m.ev, m.rec, s, rules).auto;
    out.set(m.id, { ...m, legend: m.online ? legendOf(m.state, { busy: !!m.run, auto, paused: m.paused }) : null });
  }
  return out;
}

// ---------------------------------------------------------------- the list

function rowExtra(m, mc) {
  if (m.run && m.run.kind !== 'transcript_check') return [];
  if (m.state === 'ready') {
    const docs = mc.docs.length;
    return [docs > 1 ? `${docs} documents` : e(mc.docs[0]?.name || ''), mc.review.length ? `<span class="ws-mtg-accent">${mc.review.length} to review</span>` : ''];
  }
  if (['available', 'downloaded', 'failed'].includes(m.state)) return [e(mc.tpl.template.name)];
  if (m.state === 'pending' && mc.tpl.auto) return ['notes when it arrives'];
  return [];
}

function row(p, m) {
  const mc = meetingContext({ ...p, reads: () => ({}) }, m);
  const st = statusOf(m, mc);
  const on = p.selectedId === m.id;
  const extra = rowExtra(m, mc).filter(Boolean);
  return `<button type="button" class="ws-mtg-row${on ? ' ws-mtg-on' : ''}" role="option" aria-selected="${on}" data-action="meeting-select" data-id="${e(m.id)}">
    <span class="ws-mtg-row-time">${e(formatTime(m.start, p.zone))}</span>
    <span class="ws-mtg-row-main"><strong>${mc.d.private ? icon('lock', 'ws-mtg-lock') : ''}${e(m.title)}</strong><small><em class="ws-tone-${st.tone}">${e(st.label)}</em>${extra.map(x => `<i>·</i>${x}`).join('')}</small></span>
    ${m.run ? '<span class="ws-spinner ws-mtg-row-spin" role="status" aria-label="In progress"></span>' : ''}
  </button>`;
}

function listEmpty(p) {
  const { v } = p;
  if (v.q.trim()) return emptyState({ iconName: 'search', title: `Nothing matches “${v.q.trim()}”`, text: 'Try another word, or another filter.' });
  if (v.filter === 'attention') return emptyState({ iconName: 'check-circle', title: 'Nothing needs you', text: 'No failed notes and no blocked transcripts.' });
  if (v.filter === 'process') return emptyState({ iconName: 'check-circle', title: 'Every transcript has notes', text: 'New transcripts appear here as Teams makes them.' });
  if (v.filter === 'ready') return emptyState({ iconName: 'note', title: 'No notes yet', text: 'Notes you make show here.' });
  if (v.filter === 'upcoming') return emptyState({ iconName: 'calendar', title: 'Nothing coming up', text: 'Your next meetings appear here.' });
  return emptyState({ iconName: 'meetings', title: 'No meetings here', text: 'Past Teams meetings with a transcript show here.' });
}

function list(p) {
  const { v, s } = p;
  const rows = meetingRows(s, v.filter, v.q, v.showNone, p.now, p.items);
  const counts = meetingCounts(s, p.now, p.items);
  const toDo = p.items.filter(m => (m.state === 'available' || m.state === 'downloaded') && !m.run && !m.paused);
  const groups = [];
  for (const m of rows) {
    const key = dayKey(m.start, p.zone);
    let g = groups.at(-1);
    if (!g || g.key !== key) {
      g = { key, start: m.start, items: [] };
      groups.push(g);
    }
    g.items.push(m);
  }
  const lanes = LANES.map(([id, label]) => {
    const n = id === 'process' ? counts.process : id === 'attention' ? counts.attention : 0;
    return `<button type="button" role="tab" data-action="meeting-filter" data-filter="${id}" aria-selected="${v.filter === id}">${e(label)}${n ? `<span class="ws-segmented-count${id === 'attention' ? ' ws-mtg-count-alert' : ''}">${n}</span>` : ''}</button>`;
  }).join('');
  const body = groups.length ? groups.map(g => {
    const rel = relDay(g.start, p.zone, p.now);
    return `<div class="ws-mtg-group" role="group" aria-label="${e(longDay(g.start, p.zone))}"><div class="ws-mtg-day">${e(rel || shortDay(g.start, p.zone))}${rel ? `<span>${e(longDay(g.start, p.zone))}</span>` : ''}</div>${g.items.map(m => row(p, m)).join('')}</div>`;
  }).join('') : `<div class="ws-mtg-empty">${listEmpty(p)}</div>`;
  const off = s.connection && s.connection.status === 'connected' && !transcriptsAllowed(s);
  return `<section class="ws-mtg-list" aria-label="Meetings list">
    <header class="ws-mtg-list-head">
      <div class="ws-mtg-list-title"><h1>Meetings</h1><span class="ws-actions">${button('', { action: 'meeting-import', iconName: 'upload', variant: 'ghost', title: 'Import a transcript file' })}${button('', { action: 'meeting-check-all', iconName: 'refresh', variant: 'ghost', title: 'Check Teams for new transcripts', disabled: !transcriptsAllowed(s) })}</span></div>
      <label class="ws-search">${icon('search')}<input id="meetings-search" type="search" placeholder="Search titles and people" value="${e(v.q)}" aria-label="Search meetings" autocomplete="off"></label>
      <div class="ws-segmented ws-mtg-filters" role="tablist" aria-label="Filter meetings">${lanes}</div>
    </header>
    ${off ? `<div class="ws-mtg-off">${icon('info')}<span>Connect isn’t reading Teams transcripts yet.</span>${button('Turn on', { action: 'meeting-transcripts-on', variant: 'ghost', size: 'sm' })}${button('', { action: 'settings-tab', iconName: 'settings', variant: 'ghost', size: 'sm', title: 'Settings › Meetings › Transcripts & folders', attrs: { 'data-tab': 'meetings-transcripts' } })}</div>` : ''}
    ${toDo.length && ['all', 'process'].includes(v.filter) ? `<div class="ws-mtg-bulk">${icon('sparkles')}<span class="ws-mtg-bulk-text">${plural(toDo.length, 'transcript')} without notes</span>${button(`Make notes for all ${toDo.length}`, { action: 'meeting-make-all', variant: 'ghost', size: 'sm' })}</div>` : ''}
    <div class="ws-mtg-list-body" role="listbox" aria-label="Meetings" tabindex="-1">${body}</div>
    ${v.filter === 'all' ? `<footer class="ws-mtg-list-foot">${toggle({ action: 'meeting-show-none', checked: v.showNone, label: `Show meetings without a transcript (${counts.none})` })}</footer>` : ''}
  </section>`;
}

// ---------------------------------------------------------------- the meeting

function peopleLine(p, mc) {
  const spoke = mc.segments ? new Set(mc.segments.map(x => String(x.address || '').toLowerCase()).filter(Boolean)) : null;
  const all = p.v.peopleAll === mc.m.id;
  const limit = all ? mc.people.length : 6;
  const chip = x => {
    const note = [x.organizer ? 'organizer' : '', x.me ? 'you' : '', x.company].filter(Boolean).join(' · ');
    const quiet = spoke && !spoke.has(String(x.address || '').toLowerCase());
    return `<button type="button" class="ws-mtg-pchip${quiet ? ' ws-mtg-quiet' : ''}" data-action="meeting-tab" data-tab="people" title="${e(`${x.name}${x.company ? ` · ${x.company}` : ''}${quiet ? ' · didn’t speak' : ''}`)}">${avatar({ name: x.name, size: 20, seed: String(x.address || x.name).toLowerCase() })}<span>${e(x.name)}</span>${note ? `<small>${e(note)}</small>` : ''}</button>`;
  };
  const more = mc.people.length > limit ? `<button type="button" class="ws-mtg-pchip ws-mtg-pchip-more" data-action="meeting-people-all" data-id="${e(mc.m.id)}">+${mc.people.length - limit} more</button>` : '';
  return mc.people.length ? `<div class="ws-mtg-people-line" aria-label="People">${mc.people.slice(0, limit).map(chip).join('')}${more}</div>` : '';
}

function seg(tone, label, text, action = '') {
  const ico = { done: 'check', now: 'clock', busy: 'refresh', error: 'alert', blocked: 'lock', todo: 'minus' }[tone];
  return `<span class="ws-mtg-seg ws-mtg-seg-${tone}"><span class="ws-mtg-seg-ico">${icon(ico, tone === 'busy' ? 'ws-spin' : '')}</span><strong>${e(label)}</strong><small>${text}</small>${action}</span>`;
}
const segBtn = (label, action, attrs, variant = 'ghost') => button(label, { action, size: 'sm', variant, attrs, className: 'ws-mtg-seg-btn' });

/** The slim line on where the transcript, the notes and the tasks stand, with a button only on
 *  the step that needs one; during a run, the run's progress instead. */
export function statusStrip(p, mc) {
  const { m, r, tpl } = mc;
  const id = { 'data-id': m.id };
  const run = m.run;
  if (run && run.kind === 'meeting_notes') {
    const total = Math.max(1, run.total);
    const pct = Math.round(((run.index + 0.5) / total) * 100);
    const name = (p.s.noteTemplates || []).find(t => t.id === run.templateId)?.name || tpl.template.name;
    return `<div class="ws-mtg-strip ws-mtg-strip-run" aria-live="polite">${icon('sparkles')}<strong>Making ${e(name)}</strong><small>${e(runText(run))}… · step ${run.index + 1} of ${total}</small><span class="ws-runbar" role="progressbar" aria-label="Progress" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${pct}"><span style="width:${pct}%"></span></span>${button('Cancel', { action: 'meeting-cancel', variant: 'ghost', size: 'sm', attrs: { 'data-id': run.id } })}</div>`;
  }
  if (run && run.kind === 'transcript_download') {
    return `<div class="ws-mtg-strip ws-mtg-strip-run" aria-live="polite">${icon('download')}<strong>Saving the transcript</strong><small>Getting it from Teams…</small><span class="ws-runbar ws-runbar-busy" role="progressbar" aria-label="Saving the transcript"><span></span></span>${button('Cancel', { action: 'meeting-cancel', variant: 'ghost', size: 'sm', attrs: { 'data-id': run.id } })}</div>`;
  }
  const lines = mc.segments ? plural(mc.segments.length, 'line') : 'saved';
  const checking = run?.kind === 'transcript_check';
  const org = mc.people.find(x => x.organizer);
  const saveError = m.state === 'available' && !mc.paused ? mc.saveError : null;
  const fix = err => {
    const [label, action, attrs] = saveFixAction(mc, err.code);
    return segBtn(label.replace(' transcript file', ''), action, attrs);
  };
  const off = mc.paused ? segBtn(...PAUSED[mc.paused].fix, {}) : '';
  // A Download again that failed on a saved transcript says so here (the saved one stays); its
  // banner has the details.
  const resave = mc.saved && mc.saveError && !run;
  const t = mc.saved ? seg('done', 'Transcript', resave ? '<span class="ws-mtg-err">download again failed</span>' : `${lines}${mc.imported ? ' · from a file' : ''}`)
    : mc.paused ? seg('todo', 'Transcript', PAUSED[mc.paused].seg, off)
      : m.state === 'available' ? seg(!saveError ? 'busy' : saveError.code === 'cancelled' ? 'now' : 'error', 'Transcript', !saveError ? 'saving it from Teams' : saveError.code === 'cancelled' ? 'saving stopped' : 'couldn’t get it from Teams', saveError ? fix(saveError) : '')
        : m.state === 'pending' ? seg('busy', 'Transcript', checking ? 'checking Teams…' : 'Teams is still processing', checking ? '' : segBtn('Check now', 'meeting-check', id))
          : m.state === 'blocked' ? seg('blocked', 'Transcript', `blocked by ${e(org?.company ? `${org.company}’s Teams` : 'the organizer’s Teams')}`, segBtn('Import', 'meeting-import', id))
            : m.state === 'upcoming' ? seg('todo', 'Transcript', m.online ? 'after the meeting' : 'in person, none')
              : seg('todo', 'Transcript', m.state === 'offline' ? 'in person, none' : 'nobody transcribed', m.ended ? segBtn('Import', 'meeting-import', id) : '');
  const docs = mc.docs.length;
  // Notes are promised after the transcript only when they will be made: the person asked
  // while the save failed (`pending`), or the meeting makes them by itself.
  const n = m.state === 'ready' ? seg('done', 'Notes', docs > 1 ? `${docs} documents` : e(mc.docs[0]?.name || 'made'))
    : m.state === 'failed' ? seg('error', 'Notes', e(mc.notesError?.message || 'the run failed'), segBtn('Try again', 'meeting-retry', id, 'primary'))
      : mc.paused ? seg('todo', 'Notes', `${e(tpl.template.name)} · ${mc.paused === 'off' ? 'once transcripts are on' : 'once you sign in again'}`)
        : mc.pending && m.state === 'available' ? seg('todo', 'Notes', `${e(mc.pending.name)} · after the transcript`)
          : m.state === 'downloaded' || (m.state === 'available' && !saveError) ? seg('now', 'Notes', `not made · ${e(tpl.template.name)}`, segBtn('Make notes', 'meeting-make-notes', id, 'primary'))
            : m.state === 'available' ? seg('todo', 'Notes', `not made · ${e(tpl.template.name)}`)
              : ['upcoming', 'pending'].includes(m.state) && m.online ? seg('todo', 'Notes', `${e(tpl.template.name)} · ${tpl.auto ? (m.state === 'pending' ? 'as soon as it arrives' : 'automatic') : 'you start them'}`)
                : seg('todo', 'Notes', '—');
  const total = mc.tasks.length;
  const review = mc.review.length;
  const k = total ? seg(review ? 'now' : 'done', 'Tasks', review ? `<span class="ws-mtg-accent">${review} to review</span> of ${total}` : `${total} on the board`, review ? segBtn('Review', 'meeting-tab', { 'data-tab': 'tasks' }) : '')
    : seg('todo', 'Tasks', m.state === 'ready' ? 'none found' : 'from the notes');
  const folder = r.folder ? `<span class="ws-mtg-strip-folder">${button('', { action: 'meeting-reveal', iconName: 'folder-open', variant: 'ghost', size: 'sm', title: `Show in Finder — ${r.folder}`, attrs: id })}${button('', { action: 'meeting-copy-folder', iconName: 'copy', variant: 'ghost', size: 'sm', title: 'Copy folder path', attrs: id })}</span>` : '';
  const sep = `<span class="ws-mtg-seg-sep" aria-hidden="true">${icon('chevron-right')}</span>`;
  return `<div class="ws-mtg-strip">${t}${sep}${n}${sep}${k}${folder}</div>`;
}

function meetingMenu(p, mc) {
  const { m } = mc;
  const id = { 'data-id': m.id };
  const view = mc.docs.find(x => x.id === p.v.docView?.[m.id]) || mc.main;
  return menu(`meeting-${m.id}`, dotsSummary('More for this meeting'), [
    mc.r.folder ? ['Show folder in Finder', 'meeting-reveal', id, 'folder-open'] : null,
    mc.r.folder ? ['Copy folder path', 'meeting-copy-folder', id, 'copy'] : null,
    mc.saved && mc.fromTeams && !mc.imported ? ['Download again from Teams', 'meeting-download', id, 'refresh'] : null,
    ['available', 'downloaded', 'ready', 'failed'].includes(m.state) ? ['Make notes with…', 'meeting-make-notes', id, 'sparkles'] : null,
    m.ended && ['blocked', 'none', 'offline', 'available', 'downloaded'].includes(m.state) ? ['Import a transcript file…', 'meeting-import', id, 'upload'] : null,
    m.ev ? ['Show in calendar', 'meeting-calendar', id, 'calendar'] : null,
    view ? '-' : null,
    view ? [`Delete “${view.name}”…`, 'doc-delete', { ...id, 'data-doc': view.id }, 'trash', true] : null,
  ]);
}

/** The meeting's header: when and where, the list's toggle, the title with its actions, who was
 *  there, and the Transcript › Notes › Tasks strip. `p.listHidden` says the list is collapsed. */
export function meetingHeader(p, m, mc = meetingContext(p, m)) {
  const { d } = mc;
  const rel = relDay(m.start, p.zone, p.now);
  const minutes = Math.round((m.end - m.start) / 60000);
  const where = m.online ? 'Microsoft Teams' : d.location || 'In person';
  return `<div class="ws-mtg-meeting" data-meeting="${e(m.id)}">
    <header class="ws-mtg-head">
      <div class="ws-mtg-head-row">${button('', { action: 'meeting-list-toggle', iconName: 'list', variant: 'ghost', size: 'sm', title: p.listHidden ? 'Show the meeting list' : 'Hide the meeting list — more room for notes', attrs: { 'aria-pressed': String(!p.listHidden) } })}<p class="ws-eyebrow">${rel ? `${e(rel)} · ` : ''}${e(longDay(m.start, p.zone))} · ${e(formatTime(m.start, p.zone))}–${e(formatTime(m.end, p.zone))} · ${e(durationLabel(minutes))} · ${e(where)}</p></div>
      <div class="ws-mtg-head-title"><h2>${d.private ? icon('lock', 'ws-mtg-lock') : ''}${e(m.title)}</h2><div class="ws-actions">${primaryAction(m, mc)}${meetingMenu(p, mc)}</div></div>
      ${peopleLine(p, mc)}
    </header>
    ${statusStrip(p, mc)}
  </div>`;
}

const TAB_BODIES = { notes: notesTab, transcript: transcriptTab, tasks: tasksTab, files: filesTab, people: peopleTab };
/** A meeting tab of the sections (`mtg-notes` …), not the list. */
const meetingTab = id => id !== 'mtg-list' && Object.hasOwn(MEETINGS_DOCK.tabs, id);

/** The body of meeting tab `tab` (`notes` …): that tab of meeting `m`, or, with none, what to do. */
function tabBody(p, m, mc, tab) {
  const body = m ? TAB_BODIES[tab](p, mc) : `<div class="ws-mtg-detail-empty">${emptyDetail(p.s)}</div>`;
  return `<div class="ws-mtg-detail"${m ? ` data-meeting="${e(m.id)}"` : ''} data-panel="${tab}">${body}</div>`;
}

function emptyDetail(s) {
  const c = s.connection;
  if (!c || c.status === 'disconnected') return emptyState({ iconName: 'meetings', title: 'Your meetings live here', text: 'Sign in with Microsoft 365: Teams meetings, their transcripts, notes and tasks show here.', actions: button('Sign in with Microsoft', { action: 'graph-connect', variant: 'primary' }) });
  return emptyState({ iconName: 'meetings', title: 'Pick a meeting', text: 'Its transcript, notes and tasks show here.' });
}

/** The Meetings page in its sections as `ctx.dock` (`{layouts, locked}`) has them; without a
 *  stored layout, the designed one showing the tab chosen last. */
export function meetings(s, ctx = {}) {
  const p = pageOf(s, ctx);
  const selected = p.byId.get(p.v.selected) || meetingRows(s, p.v.filter, p.v.q, p.v.showNone, p.now, p.items)[0] || null;
  p.selectedId = selected?.id || null;
  const layout = ctx.dock?.layouts?.meetings || activateTab(normalizeDock(MEETINGS_DOCK, null), `mtg-${TABS.includes(p.v.tab) ? p.v.tab : 'notes'}`);
  p.listHidden = !!paneOf(layout, 'mtg-list')?.collapsed;
  const mc = selected ? meetingContext(p, selected) : null;
  // The header shows once, above the first open section holding a meeting tab; the banners go
  // there too, or above the first open section when no meeting tab is open.
  const head = layout.panes.find(x => !x.collapsed && x.tabs.some(meetingTab));
  const top = head || layout.panes.find(x => !x.collapsed);
  const header = `${ctx.banners || ''}${head && selected ? meetingHeader(p, selected, mc) : ''}`;
  return renderDock('meetings', MEETINGS_DOCK, layout, id => (id === 'mtg-list' ? list(p) : tabBody(p, selected, mc, id.slice(4))), {
    locked: !!ctx.dock?.locked,
    before: pane => (pane.id === top?.id && header ? `<div class="ws-mtg-top">${header}</div>` : ''),
  });
}

// ---------------------------------------------------------------- calendar's event card

/** The event card's "Transcript & notes" section: where the transcript stands, the template
 *  and the next step; nothing for an event that isn't a meeting. */
export function meetingCard(s, ev, { now = Date.now(), items } = {}) {
  const all = items || meetingItems(s, now);
  const m = all.find(x => x.id === ev.id);
  if (!m) return '';
  const p = pageOf(s, { now, items: all });
  const mc = meetingContext(p, m);
  if (!m.online) {
    return `<p class="ws-hint ws-muted ws-mtg-ev-hint">${icon('info')} In-person meeting — Teams won’t have a transcript. If you recorded it elsewhere, you can import the transcript ${m.ended ? 'now' : 'after it ends'}.${m.ended ? ` ${button('Import file', { action: 'meeting-import', variant: 'ghost', size: 'sm', iconName: 'upload', attrs: { 'data-id': m.id } })}` : ''}</p>`;
  }
  const { tpl } = mc;
  const facts = m.run && m.run.kind !== 'transcript_check' ? stateLine(m, mc)
    : m.state === 'ready' ? `${e(mc.main?.name || 'Notes')} · made ${e(agoLabel(mc.main?.updatedAt, p.zone, p.now))}${mc.docs.length > 1 ? ` · ${mc.docs.length} documents` : ''}${mc.tasks.length ? ` · ${plural(mc.tasks.length, 'task')}` : ''}`
      : m.state === 'upcoming' ? `After it ends: ${tpl.auto ? `notes with <strong>${e(tpl.template.name)}</strong>, made automatically` : `the transcript is saved; you make the notes (${e(tpl.template.name)})`}`
        : stateLine(m, mc);
  const chip = ['available', 'downloaded', 'failed', 'upcoming', 'pending'].includes(m.state)
    ? `<div class="ws-mtg-ev-tpl"><span class="ws-field-label">Template</span>${tplChip(p, mc, { id: 'tpl-ev', compact: true })}<small class="ws-muted">${e(tpl.reason)}</small></div>` : '';
  const auto = ['upcoming', 'pending'].includes(m.state)
    ? toggle({ action: 'meeting-auto', checked: !!tpl.auto, label: m.state === 'pending' ? 'Make notes as soon as the transcript arrives' : 'Make notes automatically after this meeting', attrs: { 'data-id': m.id } }) : '';
  const run = m.run && m.run.kind === 'meeting_notes' ? `<div class="ws-mtg-ev-run" aria-live="polite">${icon('refresh', 'ws-spin')}<span>${e(runText(m.run))}… · step ${m.run.index + 1} of ${Math.max(1, m.run.total)}</span></div>` : '';
  const actions = `${primaryAction(m, mc, { where: 'card' })}${mc.r.folder ? button('Show folder', { action: 'meeting-reveal', variant: 'ghost', iconName: 'folder-open', attrs: { 'data-id': m.id } }) : ''}`;
  return `<section class="ws-mtg-ev">
    <header>${icon('transcript')}<strong>Transcript &amp; notes</strong>${statePill(m, mc)}</header>
    <p>${facts}</p>
    ${chip}${auto}${run}
    ${actions ? `<div class="ws-actions ws-mtg-ev-actions">${actions}</div>` : ''}
  </section>`;
}

// ---------------------------------------------------------------- Today

const TODAY_TEXT = { available: 'Saving the transcript from Teams', downloaded: 'Transcript saved, no notes yet', failed: 'Notes failed — try again', blocked: 'Teams blocked the transcript' };

/** Whether Today shows "From your meetings": when the layout has it, or until a saved layout
 *  hides it, whenever a meeting needs the person or has a transcript without notes. */
export function showMeetingsCard(w, s, now = Date.now()) {
  const grid = Array.isArray(w.today?.items) ? w.today : null;
  // A saved Today grid draws the card where it placed it, and a card the user removed stays away.
  if (grid && (grid.items.some(i => i.id === 'meetings') || (grid.hidden || []).includes('meetings'))) return false;
  if ((w.layout || []).includes('meetings')) return true;
  if (!grid && w.widgetWidths && 'meetings' in w.widgetWidths) return false;
  const c = meetingCounts(s, now);
  return c.process + c.attention > 0;
}

/** Today's "From your meetings": what needs the person first, then transcripts without notes
 *  (unless `needsMe`); each row opens the meeting on the Meetings page. */
export function todayMeetingsCard(s, now = Date.now(), { needsMe = false } = {}) {
  const zone = s.settings.timeZone;
  const items = meetingItems(s, now);
  const attention = meetingRows(s, 'attention', '', false, now, items);
  const toDo = needsMe ? [] : meetingRows(s, 'process', '', false, now, items);
  const rows = [...attention, ...toDo].slice(0, 5).map(m => {
    const rel = relDay(m.start, zone, now);
    const saveError = m.state === 'available' ? meetingErrors(m.rec).save : null;
    const text = m.run && m.run.kind !== 'transcript_check' ? `${runText(m.run)}…`
      : m.paused ? PAUSED[m.paused].line
        : saveError ? (saveError.code === 'cancelled' ? 'Saving stopped — try again' : 'Couldn’t get the transcript — try again') : TODAY_TEXT[m.state];
    return `<button type="button" class="ws-mtg-today-row" data-action="meeting-open" data-id="${e(m.id)}"><span class="ws-mtg-today-when">${e(rel || formatDate(m.start, zone, { month: 'short', day: 'numeric' }))}<small>${e(formatTime(m.start, zone))}</small></span><span class="ws-mtg-today-copy"><strong>${e(m.title)}</strong><small class="${['failed', 'blocked'].includes(m.state) ? 'ws-mtg-err' : ''}">${e(text || '')}</small></span>${m.run ? '<span class="ws-spinner ws-mtg-row-spin" role="status" aria-label="In progress"></span>' : icon('chevron-right')}</button>`;
  }).join('');
  const more = attention.length + toDo.length - 5;
  return card({
    title: 'From your meetings', iconName: 'meetings', className: 'ws-mtg-today',
    actions: button('Meetings', { action: 'route', variant: 'ghost', iconRight: 'arrow', attrs: { 'data-route': 'meetings' } }),
    body: rows ? `<div class="ws-mtg-today-list">${rows}</div>${more > 0 ? `<button type="button" class="ws-link ws-mtg-today-more" data-action="route" data-route="meetings">${plural(more, 'more meeting')} waiting</button>` : ''}`
      : emptyState({ iconName: 'check-circle', title: 'All caught up', text: 'Every transcript has notes.' }),
  });
}

// ---------------------------------------------------------------- dialogs

/** The Make notes dialog's body for a meeting (an item of `meetingItems`). */
export function makeNotesBody(s, m, ctx = {}) {
  const p = pageOf(s, { now: ctx.now, reads: ctx.reads, items: ctx.items });
  return `<div class="ws-mtg-make-dialog">${m.state === 'available' ? `<p class="ws-mtg-make-intro">${icon('download')}<span>Connect gets the transcript from Teams first, then writes the notes.</span></p>` : ''}${makeNotesForm(p, meetingContext(p, m))}</div>`;
}

/** The Import dialog's body: which meeting (`m` preselected) and the file. */
export function importBody(s, m, { now = Date.now(), items } = {}) {
  const all = items || meetingItems(s, now);
  const zone = s.settings.timeZone;
  const candidates = all.filter(x => x.ended && (!['downloaded', 'ready', 'failed'].includes(x.state) || x.id === m?.id)).sort((a, b) => b.start - a.start).slice(0, 60);
  const options = candidates.map(x => [x.id, `${x.title} · ${relDay(x.start, zone, now) || shortDay(x.start, zone)}, ${formatTime(x.start, zone)}`]);
  return `<div class="ws-mtg-import">
    ${options.length ? `<label class="ws-field"><span class="ws-field-label">Meeting</span>${select(options, m?.id || options[0][0], { name: 'meetingId' })}<small class="ws-field-hint">The file is matched to this meeting’s people and saved in its folder.</small></label>` : '<p class="ws-muted ws-hint">There is no past meeting to import a transcript into.</p>'}
    <label class="ws-mtg-drop" data-drop-file>
      <input type="file" name="file" accept=".vtt,.txt,text/vtt,text/plain" class="ws-mtg-file-input" aria-label="Transcript file">
      ${icon('upload')}<strong>Drop a .vtt or .txt file here, or click to choose</strong><small>In Teams: open the meeting’s Recap › Transcript › Download. A .txt file has one “Name: what they said” per line.</small>
      <span class="ws-mtg-drop-file" hidden></span>
    </label>
  </div>`;
}

export { tplColor, explainer, saveNextStep };
