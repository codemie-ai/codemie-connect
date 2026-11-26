// Quick capture (ask-capture design § 9): the bar ⌘N opens under the top bar, its line ("Task in
// Todoist · Due Fri 27 Nov × · From: Atlas budget ×") and the `task_save` it sends. Pure: takes
// the capture view state and a snapshot and returns HTML or request data, so node:test imports it.
// capture-controller.js owns the state; app.js draws `captureBar` and routes its keys and actions.
import { escapeHtml as e } from './store.js';
import { activeProvider, meetingOf } from './tasks-model.js';
import { messageTitle } from './selectors.js';
import { viewOf } from './view-mode.js';

/** `state.capture`: open or not, Task or Note now (`mode`) and as chosen this session (`choice`),
 *  the words, the last `capture_parse` answer with the text it was for (`parsed.text`), whether ×
 *  dropped the read date, the source (`{kind, id}` or null) and a refusal shown under the box. */
export const newCaptureView = () => ({ open: false, mode: 'task', choice: 'task', text: '', parsed: null, dueDropped: false, source: null, error: '', busy: false });

const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** `"2026-11-27"` → `"Due Fri 27 Nov"` (a calendar day, no zone involved); null for anything else. */
export function dueLabel(due) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(due ?? ''));
  if (!m) return null;
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  return `Due ${DAYS[d.getUTCDay()]} ${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]}`;
}

/** Where a captured task goes: "Task in <provider>", "Task in Connect" for Local. */
export function targetLine(snap) {
  return activeProvider(snap) === 'local' ? 'Task in Connect' : `Task in ${snap.taskProvider?.name || 'your task app'}`;
}

/** The source the page offers when the bar opens: the Inbox message selected (or open, in
 *  Compact), or the meeting `#/meetings/<id>` shows; null elsewhere. */
export function pageSource(state, snap) {
  if (state.route === 'inbox') {
    const id = viewOf(snap.settings) === 'compact' ? state.openMessage || state.selectedMessage : state.selectedMessage;
    return id && snap.records.some(r => r.kind === 'message' && r.id === id) ? { kind: 'message', id } : null;
  }
  if (state.route === 'meetings' && state.meetings?.selected) return meetingOf(snap, state.meetings.selected) ? { kind: 'meeting', id: state.meetings.selected } : null;
  return null;
}

const oneLine = text => String(text ?? '').replace(/\s+/g, ' ').trim();

/** The bar's source as drawn and sent: `{kind, id, label, record}`, or null when there is none,
 *  × dropped it, or its record is gone. A note links a message only, labelled with the subject
 *  `note_append` writes in ` (from <subject>)` (its `data.title`, on one line); a message with
 *  none links nothing. */
export function captureSource(state, snap) {
  const src = state.capture?.source;
  if (!src) return null;
  const note = state.capture.mode === 'note';
  if (src.kind === 'message') {
    const record = snap.records.find(r => r.kind === 'message' && r.id === src.id);
    if (!record) return null;
    const label = note ? oneLine(record.data.title) : messageTitle(record, snap);
    return label ? { kind: 'message', id: src.id, label, record } : null;
  }
  if (src.kind === 'meeting' && !note) {
    const m = meetingOf(snap, src.id);
    return m ? { kind: 'meeting', id: src.id, label: m.title, record: null } : null;
  }
  return null;
}

/** The read due date, only while it is for the words in the box and × hasn't dropped it. */
export function captureDue(cap) {
  return cap.mode === 'task' && !cap.dueDropped && cap.parsed && cap.parsed.text === cap.text ? cap.parsed.due || null : null;
}

/** Add's `task_save`: the title without the date phrase (the words as typed when no date is
 *  used), owned by me, To do, with the message's or the meeting's source fields. */
export function captureRequest(state, snap, me) {
  const cap = state.capture;
  const due = captureDue(cap);
  const text = due ? String(cap.parsed.title ?? '').trim() : String(cap.text).trim();
  const src = captureSource(state, snap);
  const fields = src?.kind === 'message'
    ? { sourceId: src.id, sourceRevision: src.record.revision || null, quote: src.record.data.text ? String(src.record.data.text).slice(0, 2000) : null }
    : src?.kind === 'meeting' ? { meetingId: src.id } : {};
  return { text, due, owner: me?.address || 'You', ownerName: me?.name || null, status: 'todo', ...fields };
}

/** The bar: the box, Task / Note, Add, the line under the box and a refusal. The same markup in
 *  Default and Compact (the view's tokens size it); the grid puts Task / Note first on screen,
 *  while Tab goes from the box to Task, Note, then Add (§ 11). Every part app.js may swap in
 *  place carries `data-capture-part`; the box and the line (a live region) are kept, so typing
 *  is never interrupted and the line speaks only what changed.
 *  The read date stays drawn while newer words wait for their answer, marked `data-stale` (not
 *  shown, nothing for the live region to say), and changes once that answer settles. */
export function captureBar(state, snap) {
  const cap = state.capture;
  const task = cap.mode === 'task';
  const mode = (id, label) => `<button type="button" role="radio" aria-checked="${cap.mode === id}" data-capture-mode="${id}" data-action="capture-mode">${label}</button>`;
  const src = captureSource(state, snap);
  const due = task && !cap.dueDropped && cap.parsed?.due ? cap.parsed.due : null;
  const stale = due && cap.parsed.text !== cap.text;
  const item = (html, extra = '') => `<span class="ws-capture-item"${extra}><span class="ws-capture-sep" aria-hidden="true">·</span>${html}</span>`;
  const parts = [task ? `<span data-capture-target>${e(targetLine(snap))}</span>` : '<span data-capture-target>Adds a line to Notes on Today</span>'];
  if (due) parts.push(item(`<span class="ws-capture-chip" data-capture-due="${e(due)}">${e(dueLabel(due))}<button type="button" class="ws-capture-x" data-action="capture-due-drop" aria-label="Keep the words, no due date">×</button></span>`, stale ? ' data-stale' : ''));
  if (src) parts.push(item(`<span class="ws-capture-chip" data-capture-source="${e(src.kind)}">From: ${e(src.label)}<button type="button" class="ws-capture-x" data-action="capture-source-drop" aria-label="Don’t link ${e(src.label)}">×</button></span>`));
  return `<form class="ws-capture" aria-label="Quick capture" data-mode="${task ? 'task' : 'note'}" novalidate>
      <input id="capture-input" class="ws-input ws-capture-input" type="text" value="${e(cap.text)}" maxlength="2000" autocomplete="off" spellcheck="true" aria-label="${task ? 'New task' : 'New note'}" aria-keyshortcuts="Meta+N" aria-describedby="capture-line"${cap.error ? ' aria-invalid="true"' : ''}>
      <div class="ws-segmented ws-capture-modes" role="radiogroup" aria-label="Add as" data-capture-part="modes">${mode('task', 'Task')}${mode('note', 'Note')}</div>
      <button type="button" class="ws-btn ws-btn-primary ws-capture-add" data-action="capture-add" data-capture-part="add"${cap.busy ? ' disabled' : ''}>Add</button>
      <p id="capture-line" class="ws-capture-line" role="status" aria-live="polite" data-capture-part="line">${parts.join('')}</p>
      <p class="ws-capture-error" role="alert" data-capture-part="error"${cap.error ? '' : ' hidden'}>${e(cap.error)}</p>
    </form>`;
}

/** Whether `ev` is ⌘N (or Ctrl+N), no ⌥, not mid-composition, with no dialog or setup sheet open. */
export function isCaptureKey(ev, { modal = false, sheet = false } = {}) {
  if (!(ev.metaKey || ev.ctrlKey) || ev.altKey || ev.isComposing || modal || sheet) return false;
  return ev.code === 'KeyN' || String(ev.key || '').toLowerCase() === 'n';
}
