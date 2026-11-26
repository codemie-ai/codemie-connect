// The Ask controller (ask-capture design § 2, § 11): the menu's field (focus with ⌘K, the About
// chip read at Enter, Recent with ↑ ↓, Esc), the rail's button, and the Ask page's box. app.js
// owns the instance, draws the field from `state.ask` (ask-model.js `askField`) whenever this
// calls `render`, and routes the `ask-*` actions, the field's input and its keys (capture phase)
// here. Nothing here touches the DOM, so node:test drives it over fakes.
// Writes: Enter sends one `ask_start` through the store's `mutate` (wrapped in `withClaudeChoice`,
// which opens the first-use chooser on `needs_choice` and asks again); rendering sends nothing.
import { aboutOf, BUSY, fieldRunning, newAskView, recentQuestions, recentShown } from './ask-model.js';

/**
 * `state.ask` is the field's view state (made here when missing); `snap()` the snapshot;
 * `mutate(op, data)` a fenced write; `query(op, data)` a read-only request (the page's);
 * `render()` draws again; `go(hash)` opens a Connect hash; `toast(message, tone)`;
 * `withClaudeChoice(run)` runs an AI operation, asking for a profile once on `needs_choice`;
 * `focusBack(selector)` puts focus back where it was before ⌘K (or the page's main region);
 * `focus(selector, {select})` focuses a control; `fieldShown()` whether the menu's field is on
 * screen (not hidden by the setting or the rail); `hash()` the hash open now;
 * `hiddenCalendars()` the calendar ids the window hides (kept out of Ask's context);
 * `openCapture({mode, text, due, source})` app.js's quick capture, for the page's Add as task;
 * `fail(err)` the window's error path.
 */
export function createAskController({ state, snap, mutate, query = async () => null, render = () => {}, go = async () => {}, toast = () => {}, withClaudeChoice = run => run(), focusBack = () => {}, focus = () => {}, fieldShown = () => true, hash = () => '', hiddenCalendars = () => [], openCapture = () => {}, fail = () => {} }) {
  state.ask ||= newAskView();
  const ask = () => state.ask;

  /** Opens an Ask hash, remembering the page it was opened from (the first `#/ask` step). */
  async function goAsk(target) {
    const here = String(hash() || '');
    if (!here.startsWith('#/ask')) ask().from = here || null;
    await go(target);
  }

  function opened() {
    if (ask().open) return;
    Object.assign(ask(), { open: true, active: -1 });
    render();
  }

  function closed() {
    if (!ask().open) return;
    Object.assign(ask(), { open: false, active: -1 });
    render();
  }

  /** What is typed in the field. Nothing is drawn: the words are kept for the next render. */
  function input(value) {
    const text = String(value ?? '');
    if (text === ask().text) return;
    const hadError = !!ask().error;
    const wasEmpty = !ask().text;
    Object.assign(ask(), { text, error: '', active: -1 });
    // Recent shows only while the field is empty, and a refusal goes once the words change.
    if (hadError || wasEmpty !== !text) render();
  }

  /** The Ask page with its box focused (the field hidden, the rail, the rail's ✦). */
  async function openPage() {
    Object.assign(ask(), { open: false, active: -1 });
    await goAsk('#/ask');
    focus('#ask-follow-up');
  }

  /** ⌘K: the field focused with its words selected; `from` the control focus was on. With the
   *  field not on screen, the Ask page's box. */
  async function focusField({ from = null } = {}) {
    if (from) ask().focusBack = from;
    if (!fieldShown()) return openPage();
    Object.assign(ask(), { open: true, active: -1 });
    render();
    focus('#ask-input', { select: true });
    return undefined;
  }

  function reset() {
    Object.assign(ask(), { text: '', aboutDropped: false, error: '', open: false, active: -1 });
  }

  /** `ask_start` with the window's hidden calendars; a refusal shows under the box (`onRefused`).
   *  Answers `{threadId}` or null. */
  async function start(data, onRefused) {
    try {
      return await withClaudeChoice(() => mutate('ask_start', { ...data, hiddenCalendars: [...hiddenCalendars()] }));
    } catch (err) {
      const code = err?.code || err?.class;
      if (code === 'needs_choice') return null;
      if (code === 'validation' || code === 'busy') onRefused(err.message || String(err));
      else fail(err);
      return null;
    }
  }

  /** Enter in the field: asks once about the record the chip shows now (unless × dropped it). */
  async function submitField() {
    const a = ask();
    const question = a.text.trim();
    if (!question || a.busy) return null;
    if (fieldRunning(snap())) {
      a.error = BUSY;
      render();
      return null;
    }
    const about = a.aboutDropped ? null : aboutOf(state, snap());
    a.busy = true;
    let result;
    try {
      result = await start({ question, ...(about ? { about } : {}) }, message => { ask().error = message; render(); });
    } finally {
      ask().busy = false;
    }
    if (!result?.threadId) return null;
    reset();
    await goAsk(`#/ask/${encodeURIComponent(result.threadId)}`);
    return result;
  }

  /** The Ask page's box: a new question on `#/ask`, a follow-up on `#/ask/<id>`. */
  async function submitPage(text) {
    const question = String(text ?? '').trim();
    if (!question) return null;
    const threadId = ask().threadId;
    if (fieldRunning(snap())) {
      ask().pageError = BUSY;
      render();
      return null;
    }
    ask().pageError = '';
    const result = await start({ question, ...(threadId ? { threadId } : {}) }, message => { ask().pageError = message; render(); });
    if (!result?.threadId) return null;
    await goAsk(`#/ask/${encodeURIComponent(result.threadId)}`);
    return result;
  }

  async function openRecent(threadId) {
    if (!threadId) return;
    reset();
    await goAsk(`#/ask/${encodeURIComponent(threadId)}`);
  }

  /** The field's own keys, from app.js's capture-phase listener for an event in the field.
   *  Enter asks (or opens the Recent row the arrows are on), ⇧Enter does nothing, Esc clears
   *  the words then leaves, ↑ ↓ move through Recent. A key handled here goes no further (the
   *  Inbox's Enter and ⌘↩ never see it). Returns whether it was. */
  function key(ev) {
    if (ev.isComposing || ev.keyCode === 229) return false;
    const stop = () => {
      ev.preventDefault();
      ev.stopPropagation();
      return true;
    };
    if (ev.target?.id === 'ask-follow-up') {
      if (ev.key !== 'Enter' || ev.shiftKey || ev.altKey) return false;
      submitPage(ev.target.value);
      return stop();
    }
    if (ev.target?.id !== 'ask-input') return false;
    const a = ask();
    if (ev.key === 'Enter') {
      if (ev.shiftKey || ev.altKey) return stop();
      const recent = recentShown(state, snap()) ? recentQuestions(snap()) : [];
      if (!a.text.trim() && a.active >= 0 && recent[a.active]) openRecent(recent[a.active].threadId);
      else submitField();
      return stop();
    }
    if (ev.key === 'Escape') {
      if (a.text) {
        Object.assign(a, { text: '', aboutDropped: false, error: '', active: -1 });
        render();
      } else {
        Object.assign(a, { open: false, active: -1, error: '' });
        render();
        focusBack(a.focusBack);
        a.focusBack = null;
      }
      return stop();
    }
    if ((ev.key === 'ArrowDown' || ev.key === 'ArrowUp') && !ev.metaKey && !ev.ctrlKey && !ev.altKey) {
      const n = recentShown(state, snap()) ? recentQuestions(snap()).length : 0;
      if (!n) return false;
      const step = ev.key === 'ArrowDown' ? 1 : -1;
      a.active = a.active < 0 ? (step > 0 ? 0 : n - 1) : (a.active + step + n) % n;
      render();
      return stop();
    }
    return false;
  }

  async function handle(action, el) {
    switch (action) {
      case 'ask-about-drop':
        ask().aboutDropped = true;
        render();
        return focus('#ask-input');
      case 'ask-recent': return openRecent(el?.dataset?.askRecent);
      case 'ask-rail': return openPage();
      case 'ask-page-submit': return submitPage(el?.closest?.('form')?.querySelector?.('#ask-follow-up')?.value);
      default: return undefined;
    }
  }

  // `query`, `toast` and `openCapture` are the page's (its thread, its actions).
  return { focusField, submitField, submitPage, openPage, input, opened, closed, key, handle };
}
