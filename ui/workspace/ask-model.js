// The Ask field at the top of the main menu (ask-capture design § 2, § 11, Copy "Field" and
// "Rail", Accessibility): the box, the About chip that follows the selection, Recent, and the
// rail's ✦ button. Pure: takes the window's view state and a snapshot and returns HTML or data,
// so node:test imports it. ask-controller.js owns `state.ask`; shell.js draws the field.
import { escapeHtml as e } from './store.js';
import { icon } from './icons.js';
import { viewOf } from './view-mode.js';
import { shownView } from './tasks-dates-model.js';

/** `state.ask`: the hash the Ask page was first opened from (`from`), the control focus goes
 *  back to on Esc (`focusBack`, a selector), whether × dropped the About for this question, the
 *  words in the field, whether its list is open, the Recent row the arrows are on, a refusal
 *  shown under the box, the thread `#/ask/<id>` shows, and the page box's words and refusal.
 *  `backFocus` is the page's own copy of `focusBack`, taken on the way into `#/ask` (the field
 *  forgets its own whenever it closes): the Ask page's Back and Esc put focus there. */
export const newAskView = () => ({ from: null, focusBack: null, backFocus: null, aboutDropped: false, text: '', open: false, active: -1, error: '', busy: false, threadId: null, pageText: '', pageError: '' });

/** A question that comes back while an answer runs (Copy "Field"). */
export const BUSY = 'Connect is still answering. Stop it or wait.';
/** Recent shows at most this many questions. */
export const RECENT_MAX = 5;
/** A label's own text (a sender, a title) is cut to this many characters, as native cuts it. */
const LABEL_TEXT = 80;

const oneLine = text => String(text ?? '').replace(/\s+/g, ' ').trim();
const cut = text => {
  const chars = [...oneLine(text)];
  return chars.length <= LABEL_TEXT ? chars.join('') : `${chars.slice(0, LABEL_TEXT - 1).join('').trimEnd()}…`;
};
const zoneOf = snap => snap?.settings?.timeZone || 'UTC';
function fmt(value, zone, options) {
  const d = typeof value === 'number' ? new Date(value * 1000) : new Date(value);
  if (Number.isNaN(d.getTime())) return '';
  try {
    return new Intl.DateTimeFormat('en-GB', { ...options, timeZone: zone }).format(d).replace(',', '');
  } catch {
    return new Intl.DateTimeFormat('en-GB', { ...options, timeZone: 'UTC' }).format(d).replace(',', '');
  }
}
const day = (value, zone) => fmt(value, zone, { weekday: 'short', day: 'numeric', month: 'short' });
const dayTime = (value, zone) => fmt(value, zone, { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', hour12: false });

const find = (snap, kind, id) => (id ? (snap?.records || []).find(r => r.kind === kind && r.id === id) : null);

function messageAbout(m, zone) {
  const from = oneLine(m.data.from) || oneLine(m.data.fromAddress) || 'Unknown sender';
  return { kind: 'message', recordId: m.id, label: `${cut(from)} · ${m.data.channel === 'chat' ? 'Teams' : 'mail'} · ${day(m.data.at, zone)}` };
}

function eventAbout(ev, zone) {
  const title = ev.data.private ? 'Private event' : oneLine(ev.data.title) || 'Untitled event';
  const when = ev.data.allDay ? day(ev.data.startDate ? `${ev.data.startDate}T12:00:00Z` : ev.data.start, ev.data.startDate ? 'UTC' : zone) : dayTime(ev.data.start, zone);
  return { kind: 'event', recordId: ev.id, label: `Event · ${when} · ${cut(title)}` };
}

/**
 * The record the field asks about (ruling 19, 32): the Inbox message selected (or open, in
 * Compact), the meeting `#/meetings/<id>` shows, the task whose drawer is open (By date: whose
 * row is unfolded), the calendar event open; `{kind, recordId, label}` with native's label
 * ("Priya N. · mail · Tue 24 Nov", "Meeting · Atlas QBR · Fri 20 Nov", "Task · Send the Atlas
 * budget", "Event · Fri 27 Nov 10:00 · QBR"). Anywhere else, or when the record is gone, null.
 * Read live on every render, and once more at Enter (ruling 34).
 */
export function aboutOf(state, snap) {
  if (!state || !snap) return null;
  const zone = zoneOf(snap);
  if (state.route === 'inbox') {
    const id = viewOf(snap.settings) === 'compact' ? state.openMessage || state.selectedMessage : state.selectedMessage;
    const m = find(snap, 'message', id);
    return m ? messageAbout(m, zone) : null;
  }
  if (state.route === 'meetings') {
    const id = state.meetings?.selected;
    const m = find(snap, 'meeting', id);
    if (m) return { kind: 'meeting', recordId: m.id, label: `Meeting · ${cut(m.data.title || 'Untitled meeting')} · ${day(m.data.start, zone)}` };
    const ev = find(snap, 'event', id);
    return ev ? eventAbout(ev, zone) : null;
  }
  if (state.route === 'tasks') {
    // The view the page shows: with a provider active, its own (By date by default).
    const t = state.tasks || {};
    const task = find(snap, 'commitment', shownView(t, snap) === 'dates' ? t.rowOpen : t.drawer);
    return task ? { kind: 'task', recordId: task.id, label: `Task · ${cut(task.data.text)}` } : null;
  }
  if (state.route === 'calendar') {
    const ev = find(snap, 'event', state.openEvent);
    return ev && !ev.data.cancelled ? eventAbout(ev, zone) : null;
  }
  return null;
}

/** Up to five first questions of the newest threads, newest first. */
export function recentQuestions(snap) {
  return [...(snap?.ask?.threads || [])]
    .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0))
    .slice(0, RECENT_MAX)
    .map(t => ({ threadId: t.id, title: String(t.title ?? '') }));
}

/** Whether an Ask answer is running now (one at a time, app-wide). */
export const fieldRunning = snap => !!snap?.ask?.running;

/** Whether the menu draws Ask (Settings › Layout's "Ask in the menu", on by default). */
export const askInMenu = snap => snap?.ask?.inMenu !== false;

/** Recent is shown: the field open and empty, with questions to show. */
export const recentShown = (state, snap) => !!state?.ask?.open && !state.ask.text && recentQuestions(snap).length > 0;

/**
 * The field: a search form with the box ("Ask…", ⌘K), and under it, while it is open or holds
 * words, the About chip, a refusal, Recent (a listbox the box controls) and the foot. The same
 * markup in Default and Compact.
 */
export function askField(state, snap) {
  const ask = state?.ask || newAskView();
  const running = fieldRunning(snap);
  const about = ask.aboutDropped ? null : aboutOf(state, snap);
  const showAbout = about && (ask.open || ask.text);
  const recent = recentShown(state, snap) ? recentQuestions(snap) : [];
  const active = ask.active >= 0 && ask.active < recent.length ? ask.active : -1;
  const chip = showAbout
    ? `<p class="ws-ask-chip" data-ask-about="${e(about.kind)}"><span>About: ${e(about.label)}</span><button type="button" class="ws-ask-x" data-action="ask-about-drop" aria-label="Don’t ask about ${e(about.label)}">×</button></p>`
    : '';
  const list = recent.length
    ? `<div class="ws-ask-recent"><p class="ws-ask-recent-title" id="ask-recent-title">Recent</p><ul id="ask-recent" role="listbox" aria-labelledby="ask-recent-title">${recent.map((r, i) => `<li role="option" id="ask-recent-${i}" aria-selected="${i === active}" data-action="ask-recent" data-ask-recent="${e(r.threadId)}" title="${e(r.title)}">${e(r.title)}</li>`).join('')}</ul></div>`
    : '';
  const foot = ask.open ? '<p class="ws-ask-foot">Enter to ask · Esc to close</p>' : '';
  const error = ask.error ? `<p class="ws-ask-error" role="alert">${e(ask.error)}</p>` : '';
  return `<form class="ws-ask-field${ask.open ? ' ws-ask-open' : ''}" role="search" aria-label="Ask" novalidate${running ? ' data-running' : ''}>
      <div class="ws-ask-box">${icon('sparkles', 'ws-ask-icon')}<input id="ask-input" class="ws-ask-input" type="text" value="${e(ask.text)}" placeholder="${running ? 'Answering… ⌘. to stop' : 'Ask…'}" maxlength="2000" autocomplete="off" spellcheck="false" role="combobox" aria-label="Ask Connect" aria-keyshortcuts="Meta+K" aria-autocomplete="list"${recent.length ? ' aria-controls="ask-recent"' : ''} aria-expanded="${recent.length > 0}"${active >= 0 ? ` aria-activedescendant="ask-recent-${active}"` : ''}${ask.error ? ' aria-invalid="true"' : ''}>${running ? '' : '<kbd class="ws-ask-hint" aria-hidden="true">⌘K</kbd>'}</div>
      ${chip}${error}${list}${foot}
    </form>`;
}

/** The rail's ✦ button, in the field's place on the collapsed menu. */
export function askRailButton() {
  return `<button type="button" class="ws-ask-rail" data-action="ask-rail" aria-label="Ask" aria-keyshortcuts="Meta+K" title="Ask (⌘K)" data-tip="Ask (⌘K)">${icon('sparkles')}</button>`;
}

/** Whether `ev` is ⌘K (Meta only: Ctrl+K stays the text boxes' "kill to end of line"), no ⌥,
 *  not mid-composition, with no dialog or setup sheet open, and not from the terminal dock
 *  (whose ⌘K clears the terminal). */
export function isAskKey(ev, { modal = false, sheet = false } = {}) {
  if (!ev.metaKey || ev.ctrlKey || ev.altKey || ev.shiftKey || ev.isComposing || modal || sheet) return false;
  if (ev.target?.closest?.('.ws-term')) return false;
  return ev.code === 'KeyK' || String(ev.key || '').toLowerCase() === 'k';
}

/** Whether `ev` is ⌘. (Stop an answer): Meta only, no ⌥ ⇧ ⌃, not mid-composition, with no dialog
 *  or setup sheet open. */
export function isStopKey(ev, { modal = false, sheet = false } = {}) {
  if (!ev.metaKey || ev.ctrlKey || ev.altKey || ev.shiftKey || ev.isComposing || modal || sheet) return false;
  return ev.key === '.' || ev.code === 'Period';
}
