// The Ask controller (ask-capture design § 2, § 11): the menu's field (focus with ⌘K, the About
// chip read at Enter, Recent with ↑ ↓, Esc), the rail's button, and the Ask page's box. app.js
// owns the instance, draws the field from `state.ask` (ask-model.js `askField`) whenever this
// calls `render`, and routes the `ask-*` actions, the field's input and its keys (capture phase)
// here. Nothing here touches the DOM, so node:test drives it over fakes.
// Writes: Enter sends one `ask_start` through the store's `mutate` (wrapped in `withClaudeChoice`,
// which opens the first-use chooser on `needs_choice` and asks again); rendering sends nothing.
// The page (`#/ask/<id>`, view-ask.js): the open thread is read with `ask_read` on open and again
// whenever the snapshot's `ask` moves for it; Stop is `job_cancel`, Ask again / Try again /
// follow-ups `ask_start`, Delete `ask_delete` at once, Clear history after a dialog.
// The answer's cites and actions (§ 8) run only on a click and never send: a cite chip and Open
// go to the record (app.js's `openRecord`), Add as task opens quick capture filled in (saved only
// on its Add), Draft a reply opens the message and starts the usual ✦ draft with the action's
// hint as its instructions (Send stays the composer's). Each route change toasts "← Back to Ask".
import { aboutOf, actionControl, actionTarget, BUSY, citeTarget, fieldRunning, newAskView, recentQuestions, recentShown } from './ask-model.js';
import { draftRequest } from './draft-state.js';

/** How long the "← Back to Ask" toast stays (§ 8). */
const BACK_MS = 6000;
/** A draft hint is one line of at most this many characters (native checks it too). */
const HINT_MAX = 200;

/**
 * `state.ask` is the field's view state (made here when missing); `snap()` the snapshot;
 * `mutate(op, data)` a fenced write; `query(op, data)` a read-only request (the page's);
 * `render()` draws again (a promise when it draws later); `go(hash)` opens a Connect hash; `toast(message, tone)`;
 * `withClaudeChoice(run)` runs an AI operation, asking for a profile once on `needs_choice`;
 * `focusBack(selector)` puts focus back where it was before ⌘K (or the page's main region);
 * `focus(selector, {select})` focuses a control; `fieldShown()` whether the menu's field is on
 * screen (not hidden by the setting or the rail); `hash()` the hash open now;
 * `hiddenCalendars()` the calendar ids the window hides (kept out of Ask's context);
 * `openCapture({mode, text, due, source})` app.js's quick capture, for the page's Add as task;
 * `openRecord({hash, select})` app.js opens a cite's record in the window (`citeTarget`);
 * `draftOptions(channel)` the draft options last used for a channel; `startDraft(message, request)`
 * queues that `ai_draft` the composer's way (by default through `withClaudeChoice` and `mutate`);
 * `announce(text)` says a short line in the window's polite live region; `confirm(options)` the
 * window's `confirmModal`; `fail(err)` the window's error path.
 */
export function createAskController({ state, snap, mutate, query = async () => null, render = () => {}, go = async () => {}, toast = () => {}, withClaudeChoice = run => run(), focusBack = () => {}, focus = () => {}, fieldShown = () => true, hash = () => '', hiddenCalendars = () => [], openCapture = () => {}, openRecord = async () => {}, draftOptions = () => ({}), startDraft = null, announce = () => {}, confirm = () => {}, fail = () => {} }) {
  state.ask ||= newAskView();
  const ask = () => state.ask;
  // The thread the page shows: `{id, key, thread, missing}`, `key` the snapshot's summary of it
  // when it was read. `reading` is the `id|key` asked for now; `focusTurn` a heading to focus once
  // the open thread is drawn.
  let loaded = { id: null, key: null, thread: null, missing: false };
  let reading = null;
  let focusTurn = false;
  let stopping = false;

  /** Opens an Ask hash, remembering the page it was opened from and where focus was before ⌘K
   *  (`back`, taken before the field forgets it) on the first `#/ask` step. */
  async function goAsk(target, back = ask().focusBack) {
    const here = String(hash() || '');
    if (!here.startsWith('#/ask')) Object.assign(ask(), { from: here || null, backFocus: back || ask().backFocus || null });
    await go(target);
  }

  /** Focus came into the field (a click, Tab): it opens with its words selected, as ⌘K does. */
  function opened() {
    if (ask().open) return;
    Object.assign(ask(), { open: true, active: -1 });
    render();
    focus('#ask-input', { select: true });
  }

  /** Focus or a press went elsewhere: closed, and where focus came from is forgotten. */
  function closed() {
    if (!ask().open) return;
    Object.assign(ask(), { open: false, active: -1, focusBack: null });
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
    // The page's own copy: a close while the field is drawn (or a click away) forgets `focusBack`,
    // never this; Esc giving focus back, a press elsewhere and another page drop it.
    ask().backFocus = from || null;
    if (!fieldShown()) return openPage();
    Object.assign(ask(), { open: true, active: -1 });
    render();
    focus('#ask-input', { select: true });
    return undefined;
  }

  function reset() {
    Object.assign(ask(), { text: '', aboutDropped: false, error: '', open: false, active: -1, focusBack: null });
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
    const back = ask().focusBack;
    reset();
    await goAsk(`#/ask/${encodeURIComponent(result.threadId)}`, back);
    return result;
  }

  /** The Ask page's box: a new question on `#/ask` (or on a thread that is gone), a follow-up on
   *  `#/ask/<id>`. The box's words go once it is asked. */
  async function submitPage(text) {
    const question = String(text ?? '').trim();
    if (!question) return null;
    const open = ask().threadId;
    const threadId = open && !(loaded.id === open && loaded.missing) ? open : null;
    if (fieldRunning(snap())) {
      ask().pageError = BUSY;
      render();
      return null;
    }
    ask().pageError = '';
    const result = await start({ question, ...(threadId ? { threadId } : {}) }, message => { ask().pageError = message; render(); });
    if (!result?.threadId) return null;
    ask().pageText = '';
    await goAsk(`#/ask/${encodeURIComponent(result.threadId)}`);
    return result;
  }

  /** Ask again / Try again: the turn's question as a new turn of its thread. */
  async function again(turnId) {
    const turn = thread()?.turns?.find(t => t.id === turnId);
    if (!turn) return null;
    ask().pageError = '';
    const result = await start({ threadId: loaded.id, question: turn.question }, message => { ask().pageError = message; render(); });
    if (result?.threadId) render();
    return result;
  }

  /** The thread the page shows now (`{id, missing: true}` when it is gone), or null. */
  function thread() {
    const id = ask().threadId;
    if (!id || loaded.id !== id) return null;
    return loaded.missing ? { id, missing: true } : loaded.thread;
  }

  /** What the snapshot says of a thread: it changes whenever a turn is added, settles or starts. */
  function keyOf(id) {
    const s = snap();
    const t = (s?.ask?.threads || []).find(x => x.id === id);
    const run = s?.ask?.running?.threadId === id ? s.ask.running : null;
    return JSON.stringify(t ? [t.updatedAt, t.turns, t.last, run?.turnId || null] : null);
  }

  const settledOf = (prev, next) => {
    const was = new Map((prev?.turns || []).map(t => [t.id, t.state]));
    return (next?.turns || []).filter(t => ['queued', 'running'].includes(was.get(t.id)) && ['done', 'failed'].includes(t.state));
  };

  /** Reads the open thread when the snapshot moved for it (or `force`), draws it, says a finished
   *  answer once, and focuses the newest turn's heading after an open (only once the read thread
   *  is drawn: a refresh asked during a render focuses nothing). */
  async function refresh({ force = false } = {}) {
    const id = ask().threadId;
    if (state.route !== 'ask' || !id) return;
    const key = keyOf(id);
    if (!force && loaded.id === id && loaded.key === key) return undefined;
    const want = `${id}|${key}`;
    if (reading === want) return undefined;
    reading = want;
    const prev = loaded.id === id ? loaded.thread : null;
    let next = { id, key, thread: null, missing: false };
    try {
      next.thread = await query('ask_read', { threadId: id });
    } catch (err) {
      if (err?.code !== 'not_found') {
        if (reading === want) reading = null;
        // Not read again until the snapshot moves (no loop of failing reads on each render).
        if (ask().threadId === id) loaded = { id, key, thread: prev, missing: false };
        return fail(err);
      }
      next = { id, key, thread: null, missing: true };
    }
    if (reading === want) reading = null;
    if (ask().threadId !== id) return undefined;
    loaded = next;
    for (const t of settledOf(prev, next.thread)) announce(t.state === 'done' ? 'Answer ready' : 'Couldn’t answer');
    // The heading is focused once it is drawn.
    await render();
    finishOpen();
    // The snapshot moved on while the thread was read: read it again.
    if (keyOf(id) !== key) return refresh();
    return undefined;
  }

  function finishOpen() {
    if (!focusTurn || loaded.id !== ask().threadId) return;
    focusTurn = false;
    const last = loaded.thread?.turns?.at(-1);
    if (last) focus(`[data-ask-turn="${last.id}"] .ws-ask-q`);
  }

  /** The page opened on a thread (app.js, after the route drew it): read it, then focus its newest
   *  turn's heading. */
  async function openThread() {
    const id = ask().threadId;
    if (!id) return undefined;
    focusTurn = true;
    // Drawn already (the route's render had it): focus now; else once it is read and drawn.
    if (loaded.id === id && loaded.key === keyOf(id) && !reading) return finishOpen();
    return refresh();
  }

  /** ⌘. or Stop: cancels the running answer's job, once. */
  async function stop(jobId) {
    const id = jobId || snap()?.ask?.running?.jobId;
    if (!id || stopping || !fieldRunning(snap())) return;
    stopping = true;
    try {
      await mutate('job_cancel', { id });
    } catch (err) {
      fail(err);
    } finally {
      stopping = false;
    }
  }

  /** Back (and Esc on the page): the page Ask was opened from, focus where it was before ⌘K. */
  async function back() {
    const target = ask().from || '#/today';
    const sel = ask().backFocus;
    ask().backFocus = null;
    await go(target);
    focusBack(sel);
  }

  async function remove(threadId) {
    if (!threadId) return;
    await mutate('ask_delete', { threadId });
    if (loaded.id === threadId) loaded = { id: null, key: null, thread: null, missing: false };
    if (ask().threadId === threadId) await go('#/ask');
  }

  function clearHistory() {
    return confirm({
      title: 'Clear Ask history?',
      text: 'Connect deletes every question and answer kept on this Mac. Your mail, tasks and notes are not touched.',
      confirm: 'Clear history', variant: 'danger', initialFocus: 'cancel', guard: true, returnCancels: true,
      onConfirm: async () => {
        await mutate('ask_delete', { all: true });
        loaded = { id: null, key: null, thread: null, missing: false };
        if (ask().threadId) await go('#/ask');
        else render();
      },
    });
  }

  /** What is typed in the page's box, kept through a redraw. */
  function pageInput(value) {
    ask().pageText = String(value ?? '');
  }

  async function openRecent(threadId) {
    if (!threadId) return;
    const back = ask().focusBack;
    reset();
    await goAsk(`#/ask/${encodeURIComponent(threadId)}`, back);
  }

  /** The field's own keys, from app.js's capture-phase listener for an event in the field.
   *  Enter asks (or opens the Recent row the arrows are on), ⇧Enter does nothing, Esc clears
   *  the words then leaves, ↑ ↓ move through Recent. A key handled here goes no further (the
   *  Inbox's Enter and ⌘↩ never see it). Returns whether it was. */
  function key(ev) {
    if (ev.isComposing || ev.keyCode === 229) return false;
    const handled = () => {
      ev.preventDefault();
      ev.stopPropagation();
      return true;
    };
    if (ev.target?.id === 'ask-follow-up') {
      if (ev.key === 'Escape') {
        if (ev.target.value) {
          ev.target.value = '';
          ask().pageText = '';
        } else {
          back().catch(fail);
        }
        return handled();
      }
      if (ev.key !== 'Enter' || ev.shiftKey || ev.altKey) return false;
      submitPage(ev.target.value);
      return handled();
    }
    if (ev.target?.id !== 'ask-input') return false;
    const a = ask();
    if (ev.key === 'Enter') {
      if (ev.shiftKey || ev.altKey) return handled();
      const recent = recentShown(state, snap()) ? recentQuestions(snap()) : [];
      if (!a.text.trim() && a.active >= 0 && recent[a.active]) openRecent(recent[a.active].threadId);
      else submitField();
      return handled();
    }
    if (ev.key === 'Escape') {
      if (a.text) {
        Object.assign(a, { text: '', aboutDropped: false, error: '', active: -1 });
        render();
      } else {
        Object.assign(a, { open: false, active: -1, error: '' });
        render();
        focusBack(a.focusBack);
        Object.assign(a, { focusBack: null, backFocus: null });
      }
      return handled();
    }
    if ((ev.key === 'ArrowDown' || ev.key === 'ArrowUp') && !ev.metaKey && !ev.ctrlKey && !ev.altKey) {
      const n = recentShown(state, snap()) ? recentQuestions(snap()).length : 0;
      if (!n) return false;
      const step = ev.key === 'ArrowDown' ? 1 : -1;
      a.active = a.active < 0 ? (step > 0 ? 0 : n - 1) : (a.active + step + n) % n;
      render();
      return handled();
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
      case 'ask-follow-up': return submitPage(el?.closest?.('form')?.querySelector?.('#ask-follow-up')?.value ?? ask().pageText);
      case 'ask-stop': return stop(el?.dataset?.job);
      case 'ask-again':
      case 'ask-retry': return again(el?.dataset?.askTurn);
      case 'ask-settings': return go('#/settings/ai');
      case 'ask-history': return goAsk(`#/ask/${encodeURIComponent(el?.dataset?.askThread || '')}`);
      case 'ask-new':
        ask().pageError = '';
        await goAsk('#/ask');
        return focus('#ask-follow-up');
      case 'ask-delete': return remove(el?.dataset?.askThread);
      case 'ask-clear': return clearHistory();
      case 'ask-example':
        ask().pageText = el?.dataset?.text || '';
        render();
        return focus('#ask-follow-up');
      case 'ask-back': return back();
      case 'ask-mark': return el?.dataset?.askMark ? focus(`#${el.dataset.askMark}`) : undefined;
      case 'ask-cite': return openCite(el);
      case 'ask-go': return openAction(el);
      case 'ask-task': return addAsTask(el);
      case 'ask-reply': return draftReply(el);
      default: return undefined;
    }
  }

  /** The turn of the open thread a cite or an action button belongs to. */
  const turnOf = id => thread()?.turns?.find(t => t.id === id) || null;

  /** Goes to a record, then offers the way back to this thread for 6 s. */
  async function goRecord(target) {
    const threadId = ask().threadId;
    await openRecord(target);
    if (threadId) toast('', 'info', { label: '← Back to Ask', run: () => go(`#/ask/${encodeURIComponent(threadId)}`) }, { life: BACK_MS });
  }

  async function openCite(el) {
    const turn = turnOf(el?.dataset?.askTurn);
    const target = citeTarget(turn?.cites?.find(c => c.id === el?.dataset?.askCite), snap());
    if (target) await goRecord(target);
  }

  /** The action a button stands for, when it can still run as `kind` (null otherwise). */
  function actionOf(el, kind) {
    const turn = turnOf(el?.dataset?.askTurn);
    const action = turn?.actions?.[Number(el?.dataset?.askIndex)];
    return action && actionControl(action, turn, snap())?.kind === kind ? { turn, action } : null;
  }

  /** + Add as task: quick capture with the action's words, its due and the turn's About (a
   *  message or a meeting) as the source; `task_save` only on the bar's Add. */
  function addAsTask(el) {
    const found = actionOf(el, 'task');
    if (!found) return;
    const about = found.turn.about;
    const source = about && !about.gone && (about.kind === 'message' || about.kind === 'meeting') ? { kind: about.kind, id: about.recordId } : null;
    openCapture({ mode: 'task', text: found.action.text, due: found.action.due || null, source });
  }

  async function openAction(el) {
    const found = actionOf(el, 'go');
    if (found) await goRecord(actionTarget(found.action, found.turn, snap()));
  }

  /** ✦ Draft a reply: the message opened as its chip opens it, then one `ai_draft` whose
   *  instructions are the hint (one line, ≤ 200). Nothing is sent. */
  async function draftReply(el) {
    const found = actionOf(el, 'reply');
    if (!found) return;
    const target = actionTarget(found.action, found.turn, snap());
    const message = (snap()?.records || []).find(r => r.kind === 'message' && r.id === target.select.id);
    await goRecord(target);
    const hint = [...String(found.action.hint ?? '').replace(/\s+/g, ' ').trim()].slice(0, HINT_MAX).join('');
    const request = draftRequest(message, draftOptions(message.data.channel), hint);
    try {
      await (startDraft ? startDraft(message, request) : withClaudeChoice(() => mutate('ai_draft', request)));
    } catch (err) {
      // Closing the chooser is an answer, not an error.
      if (err?.code !== 'needs_choice' && err?.class !== 'needs_choice') throw err;
    }
  }

  return { focusField, submitField, submitPage, openPage, input, opened, closed, key, handle, thread, refresh, openThread, stop, back, pageInput };
}
