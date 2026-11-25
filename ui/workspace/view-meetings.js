// Meetings (spec "Meetings page", redesigned in docs/superpowers/specs/2026-11-19-meetings-calm-design.md,
// and "Page sections"): page sections — the list (one header row with search, a filter menu and ⋯;
// the Needs you card; days that fold; rows with no controls inside, colour only for what needs the
// person; hidden meetings and the row's right-click menu) and the meeting's four tabs from
// view-meeting-tabs.js, which can sit side by side. The meeting's header (the title once, when and
// the people as faces, a slim progress line during a run) shows once, above the first section
// holding a meeting tab; before there is a transcript that section shows the explainer alone. Also
// the transcript badge and the "Transcript & notes" section the calendar uses, Today's "From
// your meetings" card, and the Make notes and Import dialogs' bodies. Pure: takes the snapshot
// and the page's view state (`ctx.state.meetings`), its sections (`ctx.dock`), plus what the
// controller read of meeting folders (`ctx.reads(id)`) and the parsed glossary (`ctx.glossary`),
// and what plugins' call slots say for the meeting shown (`ctx.callSlots`, text only), and returns
// HTML.
import { escapeHtml as e } from './store.js';
import { icon } from './icons.js';
import { avatar, button, card, emptyState, select, toggle } from './ui.js';
import { addDaysToKey, agoLabel, dayKey, formatDate, formatTime } from './format.js';
import { taskStatus } from './tasks-model.js';
import { activateTab, normalizeDock, paneOf, visibleTabs } from './dock-model.js';
import { renderDock } from './dock-view.js';
import {
  FILTERS, LEGEND, STATES, TABS, callOfMeeting, inLane, isHidden, legendOf, listModel, listOrder, meetingCounts, meetingErrors, meetingItems, meetingRows, newMeetingsView, resolveTemplate, rulesOf, seriesOf, tabsOf, tasksByMeeting, transcriptsAllowed,
} from './meetings-model.js';
import {
  dotsSummary, explainer, filesTab, makeNotesForm, meetingContext, menu, menuItems, notesTab, peopleList, plural, PAUSED, pausedFix, saveNextStep, tasksTab, tplChip, tplColor, transcriptTab,
} from './view-meeting-tabs.js';
import { FILE_MANAGER } from './platform.js';

/** Meetings' sections (spec "Page sections"): the list, pinned to Today as "From your meetings"
 *  (the `meetings` widget), and the meeting's four tabs, `mtg-<tab>` for each of `TABS`. Who was
 *  there is the header's popover. */
export const MEETINGS_DOCK = {
  title: 'Meetings',
  tabs: {
    'mtg-list': { title: 'Meetings', icon: 'meetings', min: 260, w: 340, pin: 'meetings', pinTitle: 'From your meetings' },
    'mtg-notes': { title: 'Notes', icon: 'note', min: 340, w: 760 },
    'mtg-transcript': { title: 'Transcript', icon: 'transcript', min: 320, w: 520 },
    'mtg-tasks': { title: 'Tasks', icon: 'tasks', min: 300, w: 420 },
    'mtg-files': { title: 'Files', icon: 'folder', min: 300, w: 420 },
  },
  initial: [['mtg-list'], ['mtg-notes', 'mtg-transcript', 'mtg-tasks', 'mtg-files']],
};

const PILL_TONE = { muted: 'neutral', info: 'info', purple: 'purple', success: 'success', error: 'error', warning: 'warning' };
const STATE_ICON = { upcoming: 'clock', pending: 'refresh', available: 'transcript', downloaded: 'transcript', ready: 'sparkles', failed: 'alert', blocked: 'lock', none: 'minus', offline: 'pin' };

/** Everything one render needs, computed once. */
function pageOf(s, ctx = {}) {
  const now = ctx.now ?? Date.now();
  const v = { ...newMeetingsView(), ...(ctx.state?.meetings || {}) };
  const items = ctx.items || meetingItems(s, now);
  const zone = s.settings.timeZone;
  return {
    s, v, now, zone, items, byId: new Map(items.map(m => [m.id, m])), reads: ctx.reads || (() => ({})), glossary: ctx.glossary || null,
    rules: rulesOf(s), tasksBy: tasksByMeeting(s), callSlots: Array.isArray(ctx.callSlots) ? ctx.callSlots : [],
    // The list as it shows: the Needs you card and the days.
    model: listModel(s, v, { now, zone, items }),
  };
}

/** What plugins' call slots say for meeting `m` (the ones for its folder only). */
function slotsOf(p, m) {
  const call = callOfMeeting(m);
  return call ? p.callSlots.filter(x => x.call === call.name) : [];
}

/** A plugin's chips by the meeting's title (`call.header`), as text. */
function pluginChips(slots) {
  return slots.flatMap(x => x.header.map(t => `<span class="ws-mtg-plugin-chip" title="${e(`${x.pluginName}: ${t}`)}">${icon('puzzle')}<span>${e(t)}</span></span>`)).join('');
}

/** A plugin's lines while the meeting's notes are being made (`call.minutes`), as text. */
function pluginLines(slots, m) {
  if (m.run?.kind !== 'meeting_notes') return '';
  return slots.flatMap(x => x.minutes.map(t => `<p class="ws-mtg-plugin-line" title="${e(x.pluginName)}">${icon('puzzle')}<span>${e(t)}</span></p>`)).join('');
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
  if (m.state === 'upcoming') return { tone: 'muted', label: m.live ? 'On now' : m.online ? (mc.tpl.auto ? 'Notes after the meeting' : 'Upcoming') : mc.d.location || 'In person' };
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
    // On now by the calendar, perhaps over already: its transcript may be in Teams.
    case 'upcoming': return m.live ? button('Check now', { action: 'meeting-check', iconName: 'refresh', variant: 'ghost', attrs: id, size }) : '';
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

/** The hide items of a meeting's menus (the row's right-click menu and the meeting's ⋯):
 *  hide it or its whole series, or show it again. */
export function hideMenuItems(m, hidden) {
  const id = { 'data-id': m.id };
  const series = seriesOf(m);
  if (isHidden(m, hidden)) {
    return [series && (hidden?.series || []).includes(series) ? [`Show every “${m.title}” again`, 'meeting-unhide', id, 'eye'] : ['Show in the list again', 'meeting-unhide', id, 'eye']];
  }
  return [['Hide from the list', 'meeting-hide', id, 'eye-off'], series ? [`Hide every “${m.title}”`, 'meeting-hide-series', id, 'eye-off'] : null];
}

/** A row's status: grey for the usual, a colour and a dot only for what needs the person, purple
 *  while notes are being made; a ready meeting says its documents and what waits for review. */
function rowStatus(m, mc) {
  if (m.run && m.run.kind === 'meeting_notes') return `<em class="ws-tone-purple">${e(runText(m.run))}…</em>`;
  if (m.state === 'ready' && !m.run) {
    const docs = mc.docs.length > 1 ? `${mc.docs.length} documents` : e(mc.docs[0]?.name || 'Notes');
    return `${docs}${mc.review.length ? `<i>·</i><span class="ws-mtg-accent">${mc.review.length} to review</span>` : ''}`;
  }
  const st = statusOf(m, mc);
  // A meeting waiting for Teams that makes its notes by itself says so.
  const after = m.state === 'pending' && mc.tpl.auto && !m.paused ? '<i>·</i><span>notes when it arrives</span>' : '';
  if (!inLane(m, 'needs') || st.tone === 'muted') return `<span>${e(st.label)}</span>${after}`;
  // "No notes yet" asks for a click, not an alarm: blue.
  const tone = st.tone === 'purple' && !m.run ? 'info' : st.tone;
  return `<em class="ws-tone-${tone}"><i class="ws-mtg-dot"></i>${e(st.label)}</em>`;
}

function row(p, m, { withDay = false } = {}) {
  const mc = meetingContext({ ...p, reads: () => ({}) }, m);
  const on = p.selectedId === m.id;
  const hid = isHidden(m, p.v.hidden);
  const time = formatTime(m.start, p.zone);
  const when = withDay ? `${relDay(m.start, p.zone, p.now) || shortDay(m.start, p.zone)}, ${time}` : time;
  const cls = ['ws-mtg-row', on && 'ws-mtg-on', m.state === 'upcoming' && 'ws-mtg-future', hid && 'ws-mtg-hid'].filter(Boolean).join(' ');
  // In the Needs you card the status (why it's there) comes first, so a narrow list cuts the date, not the status.
  const at = `<span class="ws-mtg-row-time">${e(when)}</span>`;
  const meta = withDay ? `${rowStatus(m, mc)}<i>·</i>${at}` : `${at}<i>·</i>${rowStatus(m, mc)}`;
  return `<button type="button" class="${cls}" role="option" aria-selected="${on}" data-action="meeting-select" data-id="${e(m.id)}">
    <span class="ws-mtg-row-main"><strong>${mc.d.private ? icon('lock', 'ws-mtg-lock') : ''}${e(m.title)}</strong><small>${hid ? '<span class="ws-mtg-hid-tag">Hidden</span><i>·</i>' : ''}${meta}</small></span>
    ${m.run ? '<span class="ws-spinner ws-mtg-row-spin" role="status" aria-label="In progress"></span>' : ''}
  </button>`;
}

function listEmpty(p) {
  const { v } = p;
  if (v.q.trim()) return emptyState({ iconName: 'search', title: `Nothing matches “${v.q.trim()}”`, text: 'Try another word, or another filter.' });
  if (v.filter === 'needs') return emptyState({ iconName: 'check-circle', title: 'Nothing needs you', text: 'Every transcript has notes, and nothing failed.' });
  if (v.filter === 'ready') return emptyState({ iconName: 'note', title: 'No notes yet', text: 'Notes you make show here.' });
  if (v.filter === 'upcoming') return emptyState({ iconName: 'calendar', title: 'Nothing coming up', text: 'Your next meetings appear here.' });
  return emptyState({ iconName: 'meetings', title: 'No meetings here', text: 'Past Teams meetings with a transcript show here.' });
}

/** The row's right-click menu, at the pointer: open it, hide it (or its series), the calendar. */
function rowMenu(p) {
  const r = p.v.rowMenu;
  const m = r && p.byId.get(r.id);
  if (!m) return '';
  const id = { 'data-id': m.id };
  return `<div class="ws-menu-panel ws-mtg-rowmenu" role="menu" aria-label="${e(m.title)}" style="left:${Math.round(Number(r.x)) || 0}px;top:${Math.round(Number(r.y)) || 0}px">${menuItems([
    ['Open', 'meeting-select', id, 'arrow'],
    ...hideMenuItems(m, p.v.hidden),
    m.ev ? '-' : null,
    m.ev ? ['Show in calendar', 'meeting-calendar', id, 'calendar'] : null,
  ])}</div>`;
}

const foldButton = (attrs, open, inner, title) => `<button type="button" class="ws-mtg-fold" ${attrs} aria-expanded="${open}"${title ? ` title="${e(title)}"` : ''}>${icon('chevron-down')}${inner}</button>`;

function list(p) {
  const { v, s, model } = p;
  const counts = meetingCounts(s, p.now, p.items, v.hidden);
  const lane = { process: 'needs', attention: 'needs' }[v.filter] || (FILTERS.some(([id]) => id === v.filter) ? v.filter : 'all');
  const toDo = model.needs.filter(m => (m.state === 'available' || m.state === 'downloaded') && !m.run && !m.paused);
  const filtered = lane !== 'all' || v.showNone || v.showHidden;
  const filterMenu = menu('meetings-filter', `<summary class="ws-btn ws-btn-ghost ws-btn-icon${filtered ? ' ws-mtg-filtered' : ''}" aria-label="Filter" title="Filter">${icon('sliders')}</summary>`, [
    ['#', 'Show'],
    ...FILTERS.map(([id, label]) => [label, 'meeting-filter', { 'data-filter': id, 'aria-checked': String(lane === id) }]),
    '-',
    [`Without a transcript (${counts.none})`, 'meeting-show-none', { 'aria-checked': String(!!v.showNone) }],
    [`Hidden meetings (${model.hiddenCount})`, 'meeting-show-hidden', { 'aria-checked': String(!!v.showHidden) }],
  ]);
  const moreMenu = menu('meetings-more', dotsSummary('More'), [
    ['Fold all days', 'meeting-fold-all', {}, 'chevron-up'],
    ['Unfold all days', 'meeting-unfold-all', {}, 'chevron-down'],
    '-',
    ['Import a transcript file…', 'meeting-import', {}, 'upload'],
    transcriptsAllowed(s) ? ['Check Teams for new transcripts', 'meeting-check-all', {}, 'refresh'] : null,
    '-',
    ['Meetings settings', 'settings-tab', { 'data-tab': 'meetings-transcripts' }, 'settings'],
  ]);
  const card = model.needs.length ? `<section class="ws-mtg-needs" aria-label="Needs you">
      <div class="ws-mtg-needs-head">${foldButton('data-action="meeting-needs-fold"', !v.needsFolded, '<strong>Needs you</strong>')}<span class="ws-mtg-count">${model.needs.length}</span><span class="ws-spacer"></span>${toDo.length > 1 ? button(`Make notes for ${toDo.length}`, { action: 'meeting-make-all', variant: 'ghost', size: 'sm' }) : ''}</div>
      ${v.needsFolded ? '' : model.needs.map(m => row(p, m, { withDay: true })).join('')}
    </section>` : '';
  const days = model.days.map(d => {
    const closed = !!v.folded?.[d.key];
    const rel = relDay(d.start, p.zone, p.now);
    const waiting = closed ? d.items.filter(m => inLane(m, 'needs') || (p.tasksBy.get(m.id) || []).some(t => taskStatus(t) === 'review')).length : 0;
    // Today's meetings still to come have their own group (`d.label`), soonest first.
    const title = d.label ? `<strong>${e(d.label)}</strong><span>${e(rel || shortDay(d.start, p.zone))}</span>`
      : `<strong>${e(rel || shortDay(d.start, p.zone))}</strong>${rel ? `<span>${e(shortDay(d.start, p.zone))}</span>` : ''}`;
    const head = foldButton(`data-action="meeting-day-fold" data-day="${e(d.key)}"`, !closed, title, 'Fold or unfold this day (⌥-click keeps only this day open)');
    const tail = closed ? `<span class="ws-spacer"></span>${waiting ? `<span class="ws-mtg-day-dot" title="Need you or have tasks to review">● ${waiting}</span>` : ''}<span class="ws-mtg-count">${plural(d.items.length, 'meeting')}</span>` : '';
    const label = d.label ? `${d.label}, ${longDay(d.start, p.zone)}` : longDay(d.start, p.zone);
    return `<div class="ws-mtg-group" role="group" aria-label="${e(label)}" data-day="${e(d.key)}"><div class="ws-mtg-day">${head}${tail}</div>${closed ? '' : d.items.map(m => row(p, m)).join('')}</div>`;
  }).join('');
  const n = model.hiddenCount;
  const hiddenFoot = n ? `<button type="button" class="ws-mtg-hid-foot" data-action="meeting-show-hidden">${icon(v.showHidden ? 'eye' : 'eye-off')}<span>${v.showHidden ? `Showing ${plural(n, 'hidden meeting')} · <u>Hide them</u>` : `${plural(n, 'hidden meeting')} · <u>Show</u>`}</span></button>` : '';
  const body = card || days ? `${card}${days}` : `<div class="ws-mtg-empty">${listEmpty(p)}</div>`;
  const off = s.connection && s.connection.status === 'connected' && !transcriptsAllowed(s);
  const search = v.searchOpen || v.q ? `<label class="ws-search">${icon('search')}<input id="meetings-search" type="search" placeholder="Search titles and people" value="${e(v.q)}" aria-label="Search meetings" autocomplete="off"></label>` : '';
  return `<section class="ws-mtg-list" aria-label="Meetings list">
    <header class="ws-mtg-list-head">
      <div class="ws-mtg-list-title"><h1>Meetings</h1><span class="ws-actions">${button('', { action: 'meeting-search-open', iconName: 'search', variant: 'ghost', title: 'Search (/)', attrs: { 'aria-pressed': String(!!(v.searchOpen || v.q)) } })}${filterMenu}${moreMenu}</span></div>
      ${search}
    </header>
    ${off ? `<div class="ws-mtg-off">${icon('info')}<span>Connect isn’t reading Teams transcripts yet.</span>${button('Turn on', { action: 'meeting-transcripts-on', variant: 'ghost', size: 'sm' })}${button('', { action: 'settings-tab', iconName: 'settings', variant: 'ghost', size: 'sm', title: 'Settings › Meetings › Transcripts & folders', attrs: { 'data-tab': 'meetings-transcripts' } })}</div>` : ''}
    <div class="ws-mtg-list-body" role="listbox" aria-label="Meetings" tabindex="-1">${body}${hiddenFoot}</div>
    ${rowMenu(p)}
  </section>`;
}

// ---------------------------------------------------------------- the meeting

/** The people in the header: up to four faces and "N people"; the popover lists who they are. */
function peopleStack(p, mc) {
  if (!mc.people.length) return '';
  const faces = mc.people.slice(0, 4).map(x => avatar({ name: x.name, size: 22, seed: String(x.address || x.name).toLowerCase() })).join('');
  const label = plural(mc.people.length, 'person', 'people');
  return `<details class="ws-menu ws-mtg-stack" data-menu="people-${e(mc.m.id)}"><summary class="ws-mtg-stack-sum" aria-label="${e(label)}" title="Who was invited"><span class="ws-mtg-faces">${faces}</span><span>${e(label)}</span></summary><div class="ws-menu-panel ws-mtg-people-pop">${peopleList(p, mc)}</div></details>`;
}

/** While notes are being made or the transcript saved: one slim line under the header with the
 *  step, a progress bar and Cancel. Nothing otherwise. */
export function runLine(p, mc) {
  const { m, tpl } = mc;
  const run = m.run;
  if (run && run.kind === 'meeting_notes') {
    const total = Math.max(1, run.total);
    const pct = Math.round(((run.index + 0.5) / total) * 100);
    const name = (p.s.noteTemplates || []).find(t => t.id === run.templateId)?.name || tpl.template.name;
    return `<div class="ws-mtg-runline" aria-live="polite">${icon('sparkles')}<strong>Making ${e(name)}</strong><small>${e(runText(run))}… · step ${run.index + 1} of ${total}</small><span class="ws-runbar" role="progressbar" aria-label="Progress" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${pct}"><span style="width:${pct}%"></span></span>${button('Cancel', { action: 'meeting-cancel', variant: 'ghost', size: 'sm', attrs: { 'data-id': run.id } })}</div>`;
  }
  if (run && run.kind === 'transcript_download') {
    return `<div class="ws-mtg-runline" aria-live="polite">${icon('download')}<strong>Saving the transcript</strong><small>Getting it from Teams…</small><span class="ws-runbar ws-runbar-busy" role="progressbar" aria-label="Saving the transcript"><span></span></span>${button('Cancel', { action: 'meeting-cancel', variant: 'ghost', size: 'sm', attrs: { 'data-id': run.id } })}</div>`;
  }
  return '';
}

function meetingMenu(p, mc, slots = []) {
  const { m } = mc;
  const id = { 'data-id': m.id };
  const view = mc.docs.find(x => x.id === p.v.docView?.[m.id]) || mc.main;
  // A plugin's ⋯ items for this meeting (`call.menu`), each run in its own page.
  const fromPlugins = slots.flatMap(x => x.menu.map((label, i) => [label, 'plugin-call-menu', { 'data-plugin-id': x.plugin, 'data-index': String(i) }, 'puzzle']));
  return menu(`meeting-${m.id}`, dotsSummary('More for this meeting'), [
    ...hideMenuItems(m, p.v.hidden),
    '-',
    mc.r.folder ? [`Show folder in ${FILE_MANAGER}`, 'meeting-reveal', id, 'folder-open'] : null,
    mc.r.folder ? ['Copy folder path', 'meeting-copy-folder', id, 'copy'] : null,
    mc.saved && mc.fromTeams && !mc.imported ? ['Download again from Teams', 'meeting-download', id, 'refresh'] : null,
    ['available', 'downloaded', 'ready', 'failed'].includes(m.state) ? ['Make notes with…', 'meeting-make-notes', id, 'sparkles'] : null,
    m.ended && ['blocked', 'none', 'offline', 'available', 'downloaded'].includes(m.state) ? ['Import a transcript file…', 'meeting-import', id, 'upload'] : null,
    m.ev ? ['Show in calendar', 'meeting-calendar', id, 'calendar'] : null,
    fromPlugins.length ? '-' : null,
    ...fromPlugins,
    view ? '-' : null,
    view ? [`Delete “${view.name}”…`, 'doc-delete', { ...id, 'data-doc': view.id }, 'trash', true] : null,
  ]);
}

/** The meeting's header: the list's toggle, the title once, when and the people as faces, a
 *  hidden meeting's note, Review while the Tasks tab isn't shown, a plugin's chips and the ⋯ menu,
 *  then a slim progress line during a run. `p.listHidden` says the list's section is collapsed,
 *  `p.tasksShown` that an open section shows the Tasks tab. */
export function meetingHeader(p, m, mc = meetingContext(p, m)) {
  const { d } = mc;
  const rel = relDay(m.start, p.zone, p.now);
  const where = m.online ? 'Teams' : d.location || 'In person';
  const when = `${rel || shortDay(m.start, p.zone)} · ${formatTime(m.start, p.zone)}–${formatTime(m.end, p.zone)} · ${where}`;
  const slots = slotsOf(p, m);
  const review = mc.review.length && !p.tasksShown && tabsOf(m).length ? button(`Review ${plural(mc.review.length, 'task')}`, { action: 'meeting-tab', size: 'sm', attrs: { 'data-tab': 'tasks' } }) : '';
  const hidden = isHidden(m, p.v.hidden) ? `<span class="ws-mtg-hid-note">${icon('eye-off')}<span>Hidden from the list</span><button type="button" class="ws-link ws-mtg-linkbtn" data-action="meeting-unhide" data-id="${e(m.id)}">Show again</button></span>` : '';
  return `<div class="ws-mtg-meeting" data-meeting="${e(m.id)}">
    <header class="ws-mtg-head">
      <div class="ws-mtg-head-title">${button('', { action: 'meeting-list-toggle', iconName: 'list', variant: 'ghost', size: 'sm', title: p.listHidden ? 'Show the meeting list' : 'Hide the meeting list — more room for notes', attrs: { 'aria-pressed': String(!p.listHidden) } })}<div class="ws-mtg-head-copy"><h2>${d.private ? icon('lock', 'ws-mtg-lock') : ''}${e(m.title)}</h2><div class="ws-mtg-meta"><span class="ws-mtg-when">${e(when)}</span>${peopleStack(p, mc)}${hidden}</div></div><div class="ws-actions">${review}${pluginChips(slots)}${meetingMenu(p, mc, slots)}</div></div>
    </header>
    ${runLine(p, mc)}${pluginLines(slots, m)}
  </div>`;
}

const TAB_BODIES = { notes: notesTab, transcript: transcriptTab, tasks: tasksTab, files: filesTab };
/** A meeting tab of the sections (`mtg-notes` …), not the list. */
const meetingTab = id => id !== 'mtg-list' && Object.hasOwn(MEETINGS_DOCK.tabs, id);

/** The body of meeting tab `tab` (`notes` …): that tab of meeting `m`, or, with none, what to do.
 *  Before a transcript the meeting has no tabs: the `first` section holding one says why, with
 *  the meeting's tasks and Add a task, and any other says it waits for the transcript. */
function tabBody(p, m, mc, tab, first) {
  const body = !m ? `<div class="ws-mtg-detail-empty">${emptyDetail(p.s)}</div>`
    : tabsOf(m).length ? TAB_BODIES[tab](p, mc)
      : first ? `<div class="ws-mtg-panel-alone">${explainer(p, mc)}${tasksTab(p, mc, { alone: true })}</div>`
        : `<p class="ws-hint ws-muted ws-mtg-wait">Nothing here until the meeting has a transcript.</p>`;
  return `<div class="ws-mtg-detail"${m ? ` data-meeting="${e(m.id)}"` : ''} data-panel="${tab}">${body}</div>`;
}

function emptyDetail(s) {
  const c = s.connection;
  if (!c || c.status === 'disconnected') return emptyState({ iconName: 'meetings', title: 'Your meetings live here', text: 'Sign in with Microsoft 365: Teams meetings, their transcripts, notes and tasks show here.', actions: button('Sign in with Microsoft', { action: 'graph-connect', variant: 'primary' }) });
  return emptyState({ iconName: 'meetings', title: 'Pick a meeting', text: 'Its transcript, notes and tasks show here.' });
}

/** The meeting the Meetings page shows: the one picked, else the list's first. */
function selectedOf(p) {
  return p.byId.get(p.v.selected) || p.byId.get(listOrder(p.model, p.v)[0]) || null;
}

/** The meeting the Meetings page shows, as plugins' call slots get it (Echo's call), or null. */
export function shownCall(s, ctx = {}) {
  return callOfMeeting(selectedOf(pageOf(s, ctx)));
}

/** The Meetings page in its sections as `ctx.dock` (`{layouts, locked}`) has them; without a
 *  stored layout, the designed one showing the tab chosen last. */
export function meetings(s, ctx = {}) {
  const p = pageOf(s, ctx);
  const selected = selectedOf(p);
  p.selectedId = selected?.id || null;
  const layout = ctx.dock?.layouts?.meetings || activateTab(normalizeDock(MEETINGS_DOCK, null), `mtg-${TABS.includes(p.v.tab) ? p.v.tab : 'notes'}`);
  p.listHidden = !!paneOf(layout, 'mtg-list')?.collapsed;
  p.tasksShown = visibleTabs(layout).includes('mtg-tasks');
  const mc = selected ? meetingContext(p, selected) : null;
  // The header shows once, above the first open section holding a meeting tab; the banners go
  // there too, or above the first open section when no meeting tab is open.
  const head = layout.panes.find(x => !x.collapsed && x.tabs.some(meetingTab));
  const top = head || layout.panes.find(x => !x.collapsed);
  const header = `${ctx.banners || ''}${head && selected ? meetingHeader(p, selected, mc) : ''}`;
  // Only the Tasks tab counts: the tasks to review.
  const counts = mc && tabsOf(selected).length ? { 'mtg-tasks': mc.review.length } : {};
  return renderDock('meetings', MEETINGS_DOCK, layout, id => (id === 'mtg-list' ? list(p) : tabBody(p, selected, mc, id.slice(4), id === head?.active)), {
    locked: !!ctx.dock?.locked,
    before: pane => (pane.id === top?.id && header ? `<div class="ws-mtg-top">${header}</div>` : ''),
    count: id => counts[id],
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
export function showMeetingsCard(w, s, now = Date.now(), hidden = null) {
  const grid = Array.isArray(w.today?.items) ? w.today : null;
  // A saved Today grid draws the card where it placed it, and a card the user removed stays away.
  if (grid && (grid.items.some(i => i.id === 'meetings') || (grid.hidden || []).includes('meetings'))) return false;
  if ((w.layout || []).includes('meetings')) return true;
  if (!grid && w.widgetWidths && 'meetings' in w.widgetWidths) return false;
  const c = meetingCounts(s, now, undefined, hidden);
  return c.process + c.attention > 0;
}

/** Today's "From your meetings": what needs the person first, then transcripts without notes
 *  (unless `needsMe`); each row opens the meeting on the Meetings page. Meetings `hidden` from the
 *  Meetings list stay away. */
export function todayMeetingsCard(s, now = Date.now(), { needsMe = false, hidden = null } = {}) {
  const zone = s.settings.timeZone;
  // Meetings hidden from the Meetings list don't ask for the person here either.
  const items = meetingItems(s, now).filter(m => !isHidden(m, hidden));
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
