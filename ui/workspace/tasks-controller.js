// The Tasks controller (spec "Tasks page"): moves (drag and drop, the Move to menu, Accept,
// Dismiss, Restore, done), the drawer's fields, quick add, the New task dialog, delete with Undo
// and Escape. app.js routes the `task-*` and `tasks-*` actions here, the drawer's fields on
// `change`, quick add on submit and the board's drag events. Everything it touches is injected,
// so node:test drives it without a browser; only `attachBoardDrag` and the dialog's form are DOM.
// No optimistic updates: every change is a `task_save` / `task_delete` and the snapshot after it.
import {
  COLUMNS, DEFAULT_FILTERS, columnName, filterTasks, meOf, meetingOf, orderBetween, peopleFor, personName, sortTasks, splitDone, taskOrder, taskStatus, tasksOf,
} from './tasks-model.js';
import { field, select, textArea, textInput } from './ui.js';
import { formatDate } from './format.js';

const plural = (n, one) => `${n} ${n === 1 ? one : `${one}s`}`;
const short = text => (String(text).length > 40 ? `${String(text).slice(0, 40)}…` : String(text));
const quoted = value => String(value).replace(/["\\]/g, '\\$&');

/**
 * `state.tasks` is the page's view state (`newTasksView()`); `snap()` the current snapshot;
 * `mutate(op, data)` a fenced write that re-renders; `render()` a re-render; `openModal` and `toast`
 * (`toast(message, tone, {label, run})`) the dialogs; `openMeeting(id, tab, line)` and
 * `openMessage(id)` navigation; `focus(selector)` moves focus after a render; `setPref` remembers
 * the board/list choice.
 */
export function createTasksController({
  state, snap, mutate, render, openModal = () => null, toast = () => {}, openMeeting = () => {}, openMessage = () => {},
  focus = () => {}, setPref = () => {}, now = () => Date.now(),
}) {
  const ui = () => state.tasks;
  const find = id => tasksOf(snap()).find(r => r.id === id);
  const me = () => meOf(snap());
  const zone = () => snap().settings.timeZone;
  const missing = () => new Error('This task is no longer there. Refresh and try again.');
  const nameOf = key => (key ? personName(snap(), key, me()) : null);

  /** The cards a column shows now, in board order (the filters and Show older apply). */
  function shown(status) {
    const s = snap();
    const list = filterTasks(tasksOf(s), ui().filters, me(), now(), { zone: zone(), meetingTitle: id => meetingOf(s, id)?.title || '' })
      .filter(r => taskStatus(r) === status)
      .sort((a, b) => sortTasks(a, b, now(), zone()));
    if (status !== 'done' || ui().showOlder) return list;
    return splitDone(list, s.settings.meetings?.doneDays ?? 14, now()).shown;
  }

  /** The order that puts a card after every other task of `status`. */
  function endOf(status, except) {
    const orders = tasksOf(snap()).filter(r => r.id !== except && taskStatus(r) === status).map(taskOrder);
    return orderBetween(orders.length ? Math.max(...orders) : null, null);
  }

  const acceptance = (from, to) => (from === 'review' && !['review', 'dismissed'].includes(to) ? 'Accepted from review' : null);

  /** Moves a task to the end of `status` (the Move to menu, Accept, the drawer, the list). */
  async function move(id, status, { log } = {}) {
    const t = find(id);
    if (!t) throw missing();
    const from = taskStatus(t);
    if (from === status || !COLUMNS.concat('dismissed').includes(status)) return null;
    const data = { id, status, order: endOf(status, id) };
    const why = log || acceptance(from, status);
    if (why) data.log = why;
    return mutate('task_save', data);
  }

  /**
   * A card dropped on `column` before the card `beforeId` (null: at the end). Its order goes
   * between its new neighbours as the column shows them; from To review it is an acceptance. A
   * card dropped where it already is, on To review or gone saves nothing.
   */
  async function onDrop(taskId, column, beforeId = null) {
    const t = find(taskId);
    if (!t || !COLUMNS.includes(column) || column === 'review') return null;
    const from = taskStatus(t);
    const cards = shown(column);
    const rest = cards.filter(r => r.id !== taskId);
    let at = beforeId ? rest.findIndex(r => r.id === beforeId) : rest.length;
    if (at < 0) at = rest.length;
    const prev = rest[at - 1] || null;
    const next = rest[at] || null;
    if (from === column) {
      const i = cards.findIndex(r => r.id === taskId);
      if (i >= 0 && (cards[i - 1]?.id ?? null) === (prev?.id ?? null) && (cards[i + 1]?.id ?? null) === (next?.id ?? null)) return null;
    }
    const data = { id: taskId, order: orderBetween(prev && taskOrder(prev), next && taskOrder(next)) };
    if (from !== column) {
      data.status = column;
      const log = acceptance(from, column);
      if (log) data.log = log;
    }
    return mutate('task_save', data);
  }

  async function openDrawer(id) {
    if (!find(id)) throw missing();
    Object.assign(ui(), { drawer: id, quickAdd: null });
    await render();
    focus('.ws-task-drawer-title');
  }

  async function closeDrawer() {
    const id = ui().drawer;
    ui().drawer = null;
    await render();
    if (id) focus(`[data-action="task-open"][data-id="${quoted(id)}"]`);
  }

  async function dismiss(id) {
    const t = find(id);
    if (!t) throw missing();
    const from = taskStatus(t);
    if (ui().drawer === id) ui().drawer = null;
    await move(id, 'dismissed', { log: 'Dismissed — not a task' });
    toast('Dismissed. Dismissed tasks are listed below the board.', 'info', { label: 'Undo', run: () => move(id, from, { log: 'Restored' }) });
  }

  async function acceptAll() {
    const list = shown('review');
    for (const t of list) await move(t.id, 'todo', { log: 'Accepted from review' });
    if (list.length) toast(`${plural(list.length, 'task')} accepted. They’re on your board.`, 'success');
  }

  /** The quick check on a card (with Undo) or the list's checkbox. */
  async function done(id, el) {
    const t = find(id);
    if (!t) throw missing();
    const from = taskStatus(t);
    if (el.type === 'checkbox') return move(id, el.checked ? 'done' : from === 'done' ? 'todo' : from);
    await move(id, 'done');
    toast(`Done: “${short(t.data.text)}”`, 'success', { label: 'Undo', run: () => move(id, from) });
    return undefined;
  }

  async function remove(id) {
    const t = find(id);
    if (!t) throw missing();
    if (ui().drawer === id) ui().drawer = null;
    const result = await mutate('task_delete', { id });
    toast(`Deleted “${short(t.data.text)}”`, 'info', result?.body ? { label: 'Undo', run: () => mutate('task_save', { ...result.body, id }) } : null);
  }

  async function rename(id, value) {
    const t = find(id);
    if (!t) throw missing();
    const text = String(value ?? '').trim();
    // A blank title is not saved: the next render shows the old one again.
    if (!text) return render();
    if (text === t.data.text) return null;
    return mutate('task_save', { id, text });
  }

  async function notes(id, value) {
    const t = find(id);
    if (!t) throw missing();
    if (String(value ?? '') === String(t.data.notes ?? '')) return null;
    return mutate('task_save', { id, notes: value });
  }

  /** Quick add at the foot of a column: stays open for the next task. */
  async function quickAdd(col, { text, owner, due } = {}) {
    const value = String(text ?? '').trim();
    if (!value || !COLUMNS.includes(col) || col === 'review') return null;
    const key = String(owner ?? '').trim();
    const result = await mutate('task_save', { text: value, owner: key || null, ownerName: nameOf(key), due: due || null, status: col });
    focus('[data-form="task-quick"] textarea');
    return result;
  }

  function newTask() {
    const s = snap();
    const m = me();
    const mine = m.address || 'You';
    const others = peopleFor(s, null, m).others.filter(p => !p.me);
    const meetings = s.records.filter(r => r.kind === 'meeting').sort((a, b) => String(b.data.start).localeCompare(String(a.data.start))).slice(0, 30);
    const body = `<div class="ws-task-form">
      ${field('Task', textArea('', { name: 'text', rows: 2, required: true, maxlength: 2000, placeholder: 'What needs doing?' }))}
      <div class="ws-form-row">
        ${field('Owner', select([[mine, 'Me'], ...others.map(p => [p.key, p.name]), ['', 'Nobody yet']], mine, { name: 'owner' }))}
        ${field('Due date', textInput({ name: 'due', type: 'date' }), 'Optional')}
      </div>
      <div class="ws-form-row">
        ${field('Column', select(['todo', 'doing', 'waiting'].map(c => [c, columnName(c, s.settings)]), 'todo', { name: 'status' }))}
        ${meetings.length ? field('From a meeting', select([['', 'None'], ...meetings.map(r => [r.id, `${r.data.title} · ${formatDate(r.data.start, s.settings.timeZone)}`])], '', { name: 'meetingId' }), 'Optional') : ''}
      </div>
    </div>`;
    return openModal({
      title: 'New task', size: 'md', submit: 'Add task', body,
      onSubmit: async f => {
        const text = String(f.get('text') || '').trim();
        if (!text) throw new Error('Write what needs doing.');
        const owner = String(f.get('owner') || '').trim();
        const result = await mutate('task_save', {
          text, owner: owner || null, ownerName: nameOf(owner), due: f.get('due') || null, status: f.get('status') || 'todo', meetingId: f.get('meetingId') || null,
        });
        toast('Task added.', 'success', result?.id ? { label: 'Open', run: () => openDrawer(result.id) } : null);
      },
    });
  }

  /** The `task-*` and `tasks-*` actions; `el` is the control (its dataset, value, checked). */
  async function handle(action, el) {
    const id = el.dataset?.id;
    el.closest?.('details')?.removeAttribute('open');
    const v = ui();
    switch (action) {
      case 'tasks-view':
        v.view = el.dataset.view === 'list' ? 'list' : 'board';
        setPref('codemie.tasks.view', v.view);
        return render();
      case 'tasks-who': v.filters.who = el.dataset.who || 'all'; return render();
      case 'tasks-filter': v.filters[el.dataset.filter] = el.value; return render();
      case 'tasks-clear': v.filters = { ...DEFAULT_FILTERS }; return render();
      case 'tasks-older': v.showOlder = !v.showOlder; return render();
      case 'tasks-dismissed': v.showDismissed = !v.showDismissed; return render();
      case 'task-new': return newTask();
      // The card's title, or Edit… in its menu.
      case 'task-open': case 'task-edit': return openDrawer(id);
      case 'task-close': return closeDrawer();
      case 'task-accept': return move(id, 'todo', { log: 'Accepted from review' });
      case 'task-accept-all': return acceptAll();
      case 'task-dismiss': return dismiss(id);
      case 'task-restore':
        await move(id, 'review', { log: 'Restored' });
        toast(`Restored to ${columnName('review', snap().settings)}.`, 'success');
        return undefined;
      case 'task-move': return move(id, el.dataset.col);
      case 'task-status': return move(id, el.value);
      case 'task-done': return done(id, el);
      case 'task-owner': return mutate('task_save', { id, owner: el.value || null, ownerName: nameOf(el.value) });
      case 'task-due-pick': return mutate('task_save', { id, due: el.dataset.value || null });
      case 'task-due': return mutate('task_save', { id, due: el.value || null });
      case 'task-title': return rename(id, el.value);
      case 'task-notes': return notes(id, el.value);
      case 'task-delete': return remove(id);
      case 'task-quote': {
        const t = find(id);
        if (!t) throw missing();
        return openMeeting(t.data.meetingId, 'transcript', t.data.line ?? null);
      }
      case 'task-open-meeting': return openMeeting(id, 'notes', null);
      case 'task-open-message': return openMessage(id);
      case 'task-quick':
        v.quickAdd = el.dataset.col;
        await render();
        focus('[data-form="task-quick"] textarea');
        return undefined;
      case 'task-quick-cancel': v.quickAdd = null; return render();
      default: return undefined;
    }
  }

  /** Keys on the Tasks page: Escape closes quick add, then the drawer; Enter adds a quick task
   *  and leaves the drawer's title (Shift+Enter is a new line). True when it took the key. */
  async function key(ev) {
    const target = ev.target;
    if (ev.key === 'Enter' && !ev.shiftKey && target?.matches?.('[data-form="task-quick"] textarea, .ws-task-drawer-title')) {
      ev.preventDefault();
      if (target.form) target.form.requestSubmit();
      else target.blur();
      return true;
    }
    if (ev.key !== 'Escape') return false;
    if (ui().quickAdd) {
      ev.preventDefault();
      ui().quickAdd = null;
      await render();
      return true;
    }
    if (ui().drawer) {
      ev.preventDefault();
      await closeDrawer();
      return true;
    }
    return false;
  }

  return { handle, onDrop, quickAdd, key, move, openDrawer, closeDrawer, newTask };
}

/**
 * Drag and drop on the board, over HTML5 drag events on `doc`: the column a card is over lights
 * up and a line shows where it would land; a drop saves through `ctl.onDrop`. `dragging(on)` says
 * when a drag starts and ends (app.js holds re-renders meanwhile); `fail` shows a failed save.
 */
export function attachBoardDrag(doc, ctl, { dragging = () => {}, fail = () => {} } = {}) {
  let dragId = null;
  let marker = null;
  const zoneOf = target => target?.closest?.('.ws-task-board [data-drop]') || null;
  const before = (zone, y) => [...zone.querySelectorAll('[data-task]:not(.ws-dragging)')]
    .find(card => { const r = card.getBoundingClientRect(); return y < r.top + r.height / 2; }) || null;
  const clear = () => {
    doc.querySelectorAll('.ws-task-col.ws-drop-on').forEach(col => col.classList.remove('ws-drop-on'));
    marker?.remove();
  };
  const end = () => {
    doc.querySelectorAll('.ws-task.ws-dragging').forEach(card => card.classList.remove('ws-dragging'));
    clear();
    if (dragId) {
      dragId = null;
      dragging(false);
    }
  };
  doc.addEventListener('dragstart', ev => {
    const card = ev.target.closest?.('.ws-task-board [data-task]');
    if (!card) return;
    dragId = card.dataset.task;
    dragging(true);
    ev.dataTransfer.effectAllowed = 'move';
    ev.dataTransfer.setData('text/plain', dragId);
    requestAnimationFrame(() => card.classList.add('ws-dragging'));
  });
  doc.addEventListener('dragover', ev => {
    if (!dragId) return;
    const zone = zoneOf(ev.target);
    if (!zone) {
      clear();
      return;
    }
    ev.preventDefault();
    ev.dataTransfer.dropEffect = 'move';
    const col = zone.closest('.ws-task-col');
    doc.querySelectorAll('.ws-task-col.ws-drop-on').forEach(x => { if (x !== col) x.classList.remove('ws-drop-on'); });
    col.classList.add('ws-drop-on');
    if (!marker) {
      marker = doc.createElement('div');
      marker.className = 'ws-task-insert';
      marker.setAttribute('aria-hidden', 'true');
    }
    const anchor = before(zone, ev.clientY) || zone.querySelector(':scope > .ws-task-col-empty, :scope > .ws-task-quick, :scope > .ws-task-col-more');
    if (marker.parentNode !== zone || marker.nextSibling !== anchor) zone.insertBefore(marker, anchor);
  });
  doc.addEventListener('drop', ev => {
    const zone = dragId && zoneOf(ev.target);
    if (!zone) return;
    ev.preventDefault();
    const id = dragId;
    const card = before(zone, ev.clientY);
    end();
    ctl.onDrop(id, zone.dataset.drop, card?.dataset.task || null).catch(fail);
  });
  doc.addEventListener('dragend', end);
}
