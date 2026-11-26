// The quick-capture controller (ask-capture design § 9, § 11): the words and the date read
// from them, Task / Note, Add (Enter closes, ⌘↩ stays), Undo, Esc. app.js opens it (⌘N, its
// `openCapture`), draws the bar from `state.capture` (capture-model.js `captureBar`) whenever
// this calls `render`, and routes the `capture-*` actions, the box's `input` and the bar's keys
// (capture phase) here. Nothing here touches the DOM, so node:test drives it over fakes.
// Writes: Add sends one `task_save` (the active provider's path, step 4) or one `note_append`,
// through the store's `mutate`; the date comes from the read-only `capture_parse` (`query`).
import { captureRequest, captureSource, newCaptureView, pageSource } from './capture-model.js';
import { meOf } from './tasks-model.js';
import { addedLine } from './task-target.js';

/** How long the words rest before `capture_parse` is asked (at most one ask per pause). */
export const PARSE_WAIT_MS = 120;

/**
 * `state.capture` is the bar's view state (made here when missing); `snap()` the snapshot;
 * `mutate(op, data)` a fenced write; `query(op, data)` a read-only request; `render()` draws the
 * bar again; `toast(message, tone, {label, run})`; `go(hash)` opens a Connect hash;
 * `savePendingNote()` saves what is typed in Today's Notes widget; `focusBack()` puts focus where
 * it was before the bar opened.
 */
export function createCaptureController({ state, snap, mutate, query, render = () => {}, toast = () => {}, go = () => {}, savePendingNote = async () => {}, focusBack = () => {}, wait = PARSE_WAIT_MS }) {
  state.capture ||= newCaptureView();
  const cap = () => state.capture;
  let timer = null;
  // One number per ask: an answer for older words, arriving after newer ones, is dropped.
  let seq = 0;

  const stopParse = () => {
    clearTimeout(timer);
    timer = null;
    seq++;
  };

  async function parseNow() {
    clearTimeout(timer);
    timer = null;
    const c = cap();
    const text = c.text;
    const mine = ++seq;
    if (c.mode !== 'task' || !text.trim()) {
      c.parsed = null;
      return;
    }
    let answer = null;
    try {
      answer = await query('capture_parse', { text });
    } catch {
      answer = null;
    }
    if (mine !== seq || cap().text !== text) return;
    cap().parsed = answer ? { ...answer, text } : null;
    render();
  }

  function schedule() {
    clearTimeout(timer);
    timer = cap().mode === 'task' && cap().text.trim() ? setTimeout(() => { parseNow(); }, wait) : null;
  }

  /** Opens the bar: `mode` for this opening (else the session's choice), `text` and `due` filled
   *  in (an Ask action), `source` `{kind: 'message'|'meeting', id}` or null; left out, the
   *  page's own (the selected or open Inbox message, the meeting `#/meetings/<id>` shows). */
  function open({ mode, text = '', due = null, source } = {}) {
    const c = cap();
    stopParse();
    Object.assign(c, { open: true, mode: mode === 'note' || mode === 'task' ? mode : c.choice, text: String(text ?? ''), parsed: null, dueDropped: false, source: source === undefined ? pageSource(state, snap()) : source || null, error: '', busy: false });
    if (c.text && due) c.parsed = { text: c.text, title: c.text, due };
    else schedule();
    render();
  }

  function close({ refocus = true } = {}) {
    if (!cap().open) return;
    stopParse();
    Object.assign(cap(), { open: false, text: '', parsed: null, dueDropped: false, source: null, error: '', busy: false });
    render();
    if (refocus) focusBack();
  }

  /** What is typed in the box. A change brings a dropped date back and asks again. */
  function input(value) {
    const c = cap();
    const text = String(value ?? '');
    if (text === c.text) return;
    Object.assign(c, { text, dueDropped: false, error: '' });
    schedule();
    render();
  }

  function setMode(mode) {
    if (mode !== 'task' && mode !== 'note') return;
    const c = cap();
    c.mode = mode;
    c.choice = mode;
    c.error = '';
    if (mode === 'task') schedule();
    else stopParse();
    render();
  }

  function clearWords() {
    stopParse();
    Object.assign(cap(), { text: '', parsed: null, dueDropped: false, error: '' });
    render();
  }

  /** Add: `keep` (⌘↩) leaves the bar open and empty for another. A refusal shows under the box. */
  async function add({ keep = false } = {}) {
    const c = cap();
    if (!c.open || c.busy) return null;
    c.busy = true;
    c.error = '';
    try {
      if (c.mode === 'note') return await addNote(keep);
      return await addTask(keep);
    } finally {
      cap().busy = false;
      if (cap().open) render();
    }
  }

  async function addTask(keep) {
    const c = cap();
    // Words not read yet (typed within the last 120 ms): read them now, so what is sent is what
    // the line would say.
    if (!c.dueDropped && c.text.trim() && c.parsed?.text !== c.text) await parseNow();
    const s = snap();
    let result;
    try {
      result = await mutate('task_save', captureRequest(state, s, meOf(s)));
    } catch (err) {
      c.error = err?.message || String(err);
      return null;
    }
    const id = result?.id;
    toast(addedLine(snap(), 'Added to Connect'), 'success', id ? { label: 'Undo', run: () => mutate('task_delete', { id }) } : null);
    done(keep);
    return result;
  }

  async function addNote(keep) {
    const c = cap();
    const src = captureSource(state, snap());
    let result;
    try {
      // What is typed in the Notes widget is saved first, so the line never overwrites it.
      await savePendingNote();
      result = await mutate('note_append', src ? { text: c.text, sourceId: src.id } : { text: c.text });
    } catch (err) {
      c.error = err?.message || String(err);
      return null;
    }
    toast('Added to Notes on Today', 'success', { label: 'Open', run: () => go('#/today') });
    done(keep);
    return result;
  }

  function done(keep) {
    if (keep) clearWords();
    else close();
  }

  /** The bar's own keys, from app.js's capture-phase listener for an event inside the bar.
   *  ⌘↩ and Enter add, Esc clears then closes, ← → move between Task and Note. A key handled
   *  here goes no further (the Inbox's ⌘↩ would send the reply). Returns whether it was. */
  function key(ev) {
    if (!cap().open || ev.isComposing || ev.keyCode === 229) return false;
    const stop = () => {
      ev.preventDefault();
      ev.stopPropagation();
      return true;
    };
    const inBox = ev.target?.id === 'capture-input';
    if (ev.key === 'Enter' && (ev.metaKey || ev.ctrlKey) && !ev.altKey) {
      add({ keep: true });
      return stop();
    }
    if (ev.key === 'Enter' && inBox && !ev.shiftKey && !ev.altKey) {
      add({ keep: false });
      return stop();
    }
    if (ev.key === 'Escape') {
      if (cap().text) clearWords();
      else close();
      return stop();
    }
    const radio = ev.target?.dataset?.captureMode;
    if (radio && ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(ev.key)) {
      setMode(radio === 'task' ? 'note' : 'task');
      return stop();
    }
    return false;
  }

  async function handle(action, el) {
    switch (action) {
      case 'capture-mode': return setMode(el?.dataset?.captureMode);
      case 'capture-due-drop':
        cap().dueDropped = true;
        return render();
      case 'capture-source-drop':
        cap().source = null;
        return render();
      case 'capture-add': return add({ keep: false });
      case 'capture-close': return close();
      default: return undefined;
    }
  }

  return { open, close, input, add, key, handle };
}
