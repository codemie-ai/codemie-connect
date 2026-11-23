// The Tasks controller (spec "Tasks page"): moves (drag and drop, the Move to menu, Accept,
// Dismiss, Restore, done), the drawer's fields, quick add, the New task dialog, delete with Undo
// and Escape. app.js routes the `task-*` and `tasks-*` actions here, the drawer's fields on
// `change`, quick add on submit and the board's drag events. Everything it touches is injected,
// so node:test drives it without a browser; only `attachBoardDrag` and the dialog's form are DOM.
// No optimistic updates: every change is a `task_save` / `task_delete` and the snapshot after it.
import {
  COLUMNS, DEFAULT_FILTERS, activeProvider, columnName, dueInfo, filterTasks, meOf, meetingOf, orderBetween, peopleFor, personName, sortTasks, splitDone, taskOrder, taskStatus, tasksOf,
} from './tasks-model.js';
import { button, field, select, textArea, textInput } from './ui.js';
import { dateFromKey, formatDate } from './format.js';
import { dateGroups, datesTasks, dayFor, rowOf, shownView } from './tasks-dates-model.js';
import { escapeHtml } from './store.js';
import { copyDialog } from './settings-tasks.js';

const plural = (n, one) => `${n} ${n === 1 ? one : `${one}s`}`;
const short = text => (String(text).length > 40 ? `${String(text).slice(0, 40)}…` : String(text));
/** A value inside a CSS attribute selector's quotes. */
export const quoted = value => String(value).replace(/["\\]/g, '\\$&');
/** Below this gap between two neighbours a dropped card gets no order of its own (orders near
 *  1.8e9 have about 2^-21 of room), so the column is renumbered first. */
const MIN_GAP = 1e-3;
/** Native's `task_bulk` takes at most this many tasks a write. */
const BULK_MAX = 200;

/**
 * `state.tasks` is the page's view state (`newTasksView()`); `snap()` the current snapshot;
 * `mutate(op, data)` a fenced write that re-renders; `render()` a re-render; `openModal` and `toast`
 * (`toast(message, tone, {label, run})`) the dialogs; `openMeeting(id, tab, line)` and
 * `openMessage(id)` navigation; `focus(selectors)` moves focus after a render to the first of the
 * selectors (a string or a list) that finds a control; `setPref` remembers Local's view choice.
 * By date: `openReply(messageId, text)` opens a conversation in Inbox with its reply box filled
 * (nothing is sent), `openLink(url, providerName, pluginId)` opens a provider's link through
 * Connect's link confirmation (Settings › Tasks's token link), `query(op, data)` a read-only
 * native request (Sync now, and `open_source` for Open in Todoist ↗).
 * Settings › Tasks: `pluginRequest(op, data)` is `plugins_request` (`set_setting`, `set_enabled`);
 * `refreshInstalled()` re-reads the installed list after one, so the token's "set" state and the
 * string settings' values follow; `installed()` is that list (Task 2's `installed[].settings`).
 */
export function createTasksController({
  state, snap, mutate, render, openModal = () => null, toast = () => {}, openMeeting = () => {}, openMessage = () => {},
  focus = () => {}, setPref = () => {}, now = () => Date.now(),
  openReply = () => {}, openLink = () => {}, query = async () => null,
  pluginRequest = async () => null, refreshInstalled = async () => {}, installed = () => [],
}) {
  const ui = () => state.tasks;
  const find = id => tasksOf(snap()).find(r => r.id === id);
  const me = () => meOf(snap());
  const zone = () => snap().settings.timeZone;
  const missing = () => new Error('This task is no longer there. Refresh and try again.');
  const nameOf = key => (key ? personName(snap(), key, me()) : null);
  /** Overdue cards show first in a column whatever their order (not in Done). */
  const late = (r, status) => status !== 'done' && dueInfo(r.data.due, now(), zone())?.tone === 'overdue';
  const titleOf = id => `[data-task="${quoted(id)}"] .ws-task-title`;

  /** Where keyboard focus goes when a card leaves its column (deleted, dismissed): the next card,
   *  else the one above, else the column's Add a task, else New task. */
  function landingAfter(id) {
    const t = find(id);
    if (!t) return ['[data-action="task-new"]'];
    const status = taskStatus(t);
    const list = shown(status);
    const i = list.findIndex(r => r.id === id);
    const near = i < 0 ? [] : [list[i + 1], list[i - 1]].filter(Boolean);
    return [...near.map(r => titleOf(r.id)), `.ws-task-col[data-col="${status}"] .ws-task-col-add`, '[data-action="task-new"]'];
  }

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
   * A card dropped on `column` before the card `beforeId` (null: at the end). Overdue cards show
   * first whatever their order, so the card is placed among the cards of its own kind (overdue or
   * not) as the column shows them: dropped above the overdue ones it goes to the top of the rest,
   * an overdue card dropped below them to their end. Its order goes between those neighbours; when
   * they leave no room, that run of cards is renumbered first. From To review it is an acceptance.
   * A card dropped where it already is, on To review or gone saves nothing.
   */
  async function onDrop(taskId, column, beforeId = null) {
    const t = find(taskId);
    if (!t || !COLUMNS.includes(column) || column === 'review') return null;
    const from = taskStatus(t);
    const overdue = late(t, column);
    const cards = shown(column);
    const rest = cards.filter(r => r.id !== taskId);
    let at = beforeId ? rest.findIndex(r => r.id === beforeId) : rest.length;
    if (at < 0) at = rest.length;
    const kin = r => late(r, column) === overdue;
    const group = rest.filter(kin);
    const index = rest.slice(0, at).filter(kin).length;
    const prev = group[index - 1] || null;
    const next = group[index] || null;
    if (from === column) {
      const own = cards.filter(kin);
      const i = own.findIndex(r => r.id === taskId);
      if (i >= 0 && (own[i - 1]?.id ?? null) === (prev?.id ?? null) && (own[i + 1]?.id ?? null) === (next?.id ?? null)) return null;
    }
    let order = orderBetween(prev && taskOrder(prev), next && taskOrder(next));
    if (prev && next && !(taskOrder(next) - taskOrder(prev) >= MIN_GAP)) order = await renumber(group, index);
    const data = { id: taskId, order };
    if (from !== column) {
      data.status = column;
      const log = acceptance(from, column);
      if (log) data.log = log;
    }
    return mutate('task_save', data);
  }

  /** Gives `group` (one column's cards of one kind, as shown) orders one apart, leaving room at
   *  `index` for the card being dropped, and returns that card's order. Only orders change. */
  async function renumber(group, index) {
    const base = Math.floor(taskOrder(group[0]));
    const place = k => base + (k < index ? k : k + 1);
    for (const [k, r] of group.entries()) {
      if (taskOrder(r) !== place(k)) await mutate('task_save', { id: r.id, order: place(k) });
    }
    return base + index;
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
    const landing = landingAfter(id);
    if (ui().drawer === id) ui().drawer = null;
    await move(id, 'dismissed', { log: 'Dismissed — not a task' });
    focus(landing);
    toast('Dismissed. Dismissed tasks are listed below the board.', 'info', { label: 'Undo', run: () => move(id, from, { log: 'Restored' }) });
  }

  async function acceptAll() {
    // By date shows every task to review (it has no filters).
    const list = shownView(ui(), snap()) === 'dates' ? groups().review : shown('review');
    for (const t of list) await move(t.id, 'todo', { log: 'Accepted from review' });
    if (list.length) toast(`${plural(list.length, 'task')} accepted. They’re on your board.`, 'success');
  }

  /** The quick check on a card (with Undo) or the list's checkbox. */
  async function done(id, el) {
    const t = find(id);
    if (!t) throw missing();
    const from = taskStatus(t);
    // By date's done box finishes as every By date completion does.
    if (el.type === 'checkbox' && el.checked && el.closest?.('.ws-tdate')) return finish(id, () => move(id, 'done'));
    if (el.type === 'checkbox') return move(id, el.checked ? 'done' : from === 'done' ? 'todo' : from);
    await move(id, 'done');
    toast(`Done: “${short(t.data.text)}”`, 'success', { label: 'Undo', run: () => move(id, from) });
    return undefined;
  }

  /** Delete, with Undo saving the body back. With a provider it asks first (ruling 17): the
   *  delete reaches the provider, and Undo makes the task there again as a new one. */
  function remove(id) {
    const t = find(id);
    if (!t) throw missing();
    const s = snap();
    if (activeProvider(s) === 'local') return removeNow(id);
    const name = s.taskProvider?.name || 'your task app';
    return openModal({
      title: 'Delete this task?', size: 'sm', submit: 'Delete', variant: 'danger', initialFocus: 'cancel',
      body: `<p class="ws-modal-text">Delete “${escapeHtml(t.data.text)}” in ${escapeHtml(name)} too? Undo makes it again as a new task.</p>`,
      onSubmit: () => removeNow(id),
    });
  }

  async function removeNow(id) {
    const t = find(id);
    if (!t) throw missing();
    const landing = landingAfter(id);
    if (ui().drawer === id) ui().drawer = null;
    const result = await mutate('task_delete', { id });
    focus(landing);
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

  // ---------------------------------------------------------------- By date (design §9)

  /** By date's groups over the tasks it shows: one meeting's while its chip is on. */
  const groups = () => dateGroups(datesTasks(tasksOf(snap()), ui().filters), { now: now(), zone: zone(), me: me() });
  const dayLabel = key => formatDate(dateFromKey(key), undefined, { month: 'short', day: 'numeric' });

  /** Asks for a day (Pick date…), then runs `save(day)`. */
  function pickDate(title, save) {
    return openModal({
      title, size: 'sm', submit: 'Move',
      body: field('Date', textInput({ name: 'due', type: 'date', required: true })),
      onSubmit: async f => {
        const day = String(f.get('due') || '');
        if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) throw new Error('Choose a date.');
        await save(day);
      },
    });
  }

  /** By date's footer: the last action, with Undo sending `undo` back (the active provider's). */
  const setFooter = (text, undo) => { ui().footer = { text, undo, provider: activeProvider(snap()) }; };

  /** `task_bulk` over `items`, at most 200 a write (native's limit): `{done, failed, before}`. */
  async function bulk(items) {
    const all = { done: 0, failed: 0, before: [] };
    for (let i = 0; i < items.length; i += BULK_MAX) {
      const answer = await mutate('task_bulk', { items: items.slice(i, i + BULK_MAX) });
      all.done += Number(answer?.done) || 0;
      all.failed += Number(answer?.failed) || 0;
      if (Array.isArray(answer?.before)) all.before.push(...answer.before);
    }
    return all;
  }

  /** A By date completion (the done box, Looks handled › Done): the row leaves and the footer
   *  says "Marked 1 done · Undo", Undo putting back its date and status. */
  async function finish(id, write) {
    const t = find(id);
    if (!t) throw missing();
    const before = { id, due: t.data.due ?? null, status: taskStatus(t) };
    if (ui().rowOpen === id) ui().rowOpen = null;
    await write();
    setFooter('Marked 1 done', [before]);
    return render();
  }

  /** The Late tasks the screen showed (the menu item's `data-ids`), else the Late tasks now. */
  function shownLate(el) {
    try {
      const ids = JSON.parse(el.dataset?.ids || 'null');
      if (Array.isArray(ids)) return ids.map(String);
    } catch { /* drawn without ids */ }
    return groups().late.map(r => r.id);
  }

  /** One Late ⋯ action over the tasks shown; the footer says what happened, with Undo. */
  async function bulkLate(ids, item, say) {
    if (!ids.length) return null;
    const answer = await bulk(ids.map(id => ({ id, ...item })));
    if (answer.done) setFooter(say(answer.done), answer.before);
    else ui().footer = null;
    if (answer.failed) toast(`${plural(answer.failed, 'task')} couldn’t be changed.`, 'error');
    return render();
  }

  function moveLate(el) {
    const ids = shownLate(el);
    const to = el.dataset?.to;
    if (to === 'pick') return pickDate('Move late tasks to', day => bulkLate(ids, { due: day }, n => `Moved ${n} to ${dayLabel(day)}`));
    // The day the menu was drawn with: a page left open past midnight moves what it said.
    const day = el.dataset?.day || dayFor(to, now(), zone());
    if (!day || !['tomorrow', 'monday'].includes(to)) return null;
    return bulkLate(ids, { due: day }, n => `Moved ${n} to ${to === 'monday' ? 'Monday' : 'Tomorrow'}`);
  }

  /** The footer's Undo; it stays (to try again) until the write went through. */
  async function undoLast() {
    const f = ui().footer;
    if (!f?.undo?.length) return null;
    await bulk(f.undo);
    ui().footer = null;
    return render();
  }

  /** Nudge: the source conversation in Inbox, its reply box holding a plain line. Only for a
   *  check-in row whose source is a synced mail thread or Teams chat; nothing is sent. */
  function nudge(id) {
    const t = find(id);
    if (!t) throw missing();
    const row = rowOf(t, { me: me(), s: snap(), now: now(), zone: zone() });
    if (!row.nudge || !row.checkWith) return null;
    const what = row.text.trim().replace(/[.!?]+$/, '');
    return openReply(row.source.id, `Hi ${row.checkWith.first}, any news on ${what}?`);
  }

  /** Open in Todoist ↗: the task's own link, opened by Connect (`open_source`, which reads it
   *  from the stored task and checks its host again), not a plugin's link confirmation. */
  function openRemote(id) {
    const t = find(id);
    if (!t) throw missing();
    const row = rowOf(t, { me: me(), s: snap(), now: now(), zone: zone() });
    if (!row.url) return null;
    return query('open_source', { kind: 'task', id });
  }

  // ---------------------------------------------------------------- Settings › Tasks (design §11)

  /** To do, In progress or Waiting (not To review, done or dismissed): what a copy sends
   *  (`tasks.rs`'s own `is_open`, narrower than the "Whose tasks" filter's `OPEN`). */
  const COPYABLE = ['todo', 'doing', 'waiting'];
  /** The open Local tasks (whatever the active provider is): the copy dialog's count. */
  const localOpenCount = () => tasksOf({ ...snap(), taskProvider: undefined }).filter(r => COPYABLE.includes(taskStatus(r))).length;
  const providerOf = id => snap().taskProvider?.available?.find(a => a.id === id);
  const pluginIdOf = id => String(id).replace(/^plugin:/, '');
  const settingOf = (pluginId, key) => (installed().find(x => x.id === pluginId)?.settings || []).find(s => s.key === key);

  /** A stale Check answer belongs to the provider and the token it was asked of; a switch or a
   *  token change starts the card without one again. */
  const clearCheck = () => { ui().provider.check = null; };

  /** The copy dialog (ruling 16): shown once, the first time `id` is chosen while Local has open
   *  tasks (`settings.tasks.copyOffered` names every provider already offered, design §13). Its
   *  own two buttons send the one `task_provider_set` that switches, with `copy` either way. */
  function copyThenSwitch(id, count) {
    const name = providerOf(id)?.name || 'it';
    const project = settingOf(pluginIdOf(id), 'project')?.value || name;
    const decide = (label, decision, variant) => button(label, { type: 'submit', variant, attrs: { name: 'decision', value: decision } });
    return openModal({
      title: `Copy your open tasks to ${name}?`, size: 'sm', submit: '', cancel: '',
      body: `${copyDialog({ count, project })}<div class="ws-modal-footer" style="padding:0"><span class="ws-spacer"></span>${decide('Not now', 'skip', 'secondary')}${decide(`Copy ${plural(count, 'task')}`, 'copy', 'primary')}</div>`,
      onSubmit: f => {
        clearCheck();
        return mutate('task_provider_set', { provider: id, copy: f.get('decision') === 'copy' });
      },
    });
  }

  /** `tasks-provider-choose`: switches at once, unless this is the first time `id` is chosen
   *  while Local has open tasks, which asks first (`copyThenSwitch`). Choosing Local again, or a
   *  provider already offered, needs no dialog (ruling 16). */
  function chooseProvider(id) {
    const s = snap();
    if (id === activeProvider(s)) return null;
    if (id !== 'local') {
      const offered = (s.settings?.tasks?.copyOffered || []).includes(id);
      const count = localOpenCount();
      if (!offered && count > 0) return copyThenSwitch(id, count);
    }
    clearCheck();
    return mutate('task_provider_set', { provider: id });
  }

  /** `tasks-provider-turn-on`: `set_enabled` for the plugin behind the radio that reads "Turned
   *  off in Settings › Plugins". A sheet that changed is left to Settings › Plugins to review. */
  async function turnOnProvider(id) {
    const v = ui().provider;
    v.busy = { ...v.busy, [id]: true };
    await render();
    try {
      const answer = await pluginRequest('set_enabled', { id: pluginIdOf(id), enabled: true });
      if (answer?.status === 'needs_consent') toast('Its permissions changed. Turn it on from Settings › Plugins to review them.', 'info');
      else await refreshInstalled();
    } finally {
      delete v.busy[id];
      await render();
    }
  }

  /** `tasks-provider-check`: the active plugin's `status` (design §11 "Check"). */
  async function checkProvider() {
    const v = ui().provider;
    v.checking = true;
    await render();
    try {
      const answer = await query('task_provider_check', {});
      v.check = { ok: true, account: answer?.account, project: answer?.project };
    } catch (err) {
      v.check = { ok: false, message: err?.message || String(err) };
    } finally {
      v.checking = false;
      await render();
    }
  }

  /** The secret field's wrapper an action button sits in (its password input is a sibling). */
  const secretWrapOf = el => el.closest('[data-provider-secret]');

  /** `tasks-provider-secret-save`: reads the field, sends `set_setting`, and clears it at once
   *  (ruling 2: the token is never kept in the window). */
  async function saveSecret(el) {
    const pluginId = pluginIdOf(activeProvider(snap()));
    const input = secretWrapOf(el)?.querySelector('input[type=password]');
    const value = input?.value ?? '';
    if (input) input.value = '';
    const v = ui().provider;
    v.savingSecret = true;
    await render();
    try {
      await pluginRequest('set_setting', { id: pluginId, key: el.dataset.key, value });
      clearCheck();
      await refreshInstalled();
    } finally {
      v.savingSecret = false;
      await render();
    }
  }

  /** `tasks-provider-secret-remove`: the same `set_setting`, with an empty value. */
  async function removeSecret(el) {
    const pluginId = pluginIdOf(activeProvider(snap()));
    await pluginRequest('set_setting', { id: pluginId, key: el.dataset.key, value: '' });
    clearCheck();
    return refreshInstalled().then(render);
  }

  /** `tasks-provider-setting`: a string setting (Project, App label), on change. */
  async function saveProviderSetting(el) {
    const pluginId = pluginIdOf(activeProvider(snap()));
    await pluginRequest('set_setting', { id: pluginId, key: el.dataset.key, value: el.value });
    return refreshInstalled().then(render);
  }

  /** The quiet "Copy open tasks from Connect…" link (ruling 16): no dialog, a key already copied
   *  makes nothing new. */
  async function copyQuietly() {
    const id = activeProvider(snap());
    const name = providerOf(id)?.name || 'it';
    const answer = await mutate('task_provider_set', { provider: id, copy: true });
    const n = Number(answer?.copied) || 0;
    return toast(n ? `Copied ${plural(n, 'task')} to ${name}.` : `Nothing new to copy to ${name}.`, 'success');
  }

  /** The `task-*` and `tasks-*` actions; `el` is the control (its dataset, value, checked). */
  async function handle(action, el) {
    const id = el.dataset?.id;
    el.closest?.('details')?.removeAttribute('open');
    const v = ui();
    // The footer's Undo belongs to the provider it was made with.
    if (v.footer && v.footer.provider !== activeProvider(snap())) v.footer = null;
    switch (action) {
      case 'tasks-view': {
        // Local remembers its choice; a provider's lasts this session (By date first, no Board).
        const view = ['board', 'list', 'dates'].includes(el.dataset.view) ? el.dataset.view : 'board';
        if (activeProvider(snap()) === 'local') {
          v.view = view;
          setPref('codemie.tasks.view', v.view);
        } else if (view !== 'board') v.providerView = view;
        return render();
      }
      case 'tasks-fold': v.folds = { ...v.folds, [el.dataset.fold]: !v.folds?.[el.dataset.fold] }; return render();
      case 'task-row-open': v.rowOpen = v.rowOpen === id ? null : id; return render();
      case 'task-snooze': return mutate('task_save', { id, due: el.dataset.value || null });
      case 'task-pick-date': {
        const t = find(id);
        if (!t) throw missing();
        return pickDate(`Move “${short(t.data.text)}” to`, day => mutate('task_save', { id, due: day }));
      }
      case 'tasks-late-move': return moveLate(el);
      case 'tasks-late-done': return bulkLate(shownLate(el), { status: 'done' }, n => `Marked ${n} done`);
      case 'tasks-undo': return undoLast();
      case 'task-handled':
        if (el.dataset.act === 'done') return finish(id, () => mutate('task_handled', { id, action: 'done' }));
        return mutate('task_handled', { id, action: 'keep' });
      case 'task-parked': return mutate('task_parked', { id, action: el.dataset.act === 'discard' ? 'discard' : 'retry' });
      case 'task-nudge': return nudge(id);
      case 'task-open-remote': return openRemote(id);
      case 'tasks-sync': return query('task_sync_now', {});
      case 'tasks-meeting-clear': v.filters = { ...v.filters, meeting: '' }; return render();
      // Settings › Tasks (design §11).
      case 'tasks-provider-choose': return chooseProvider(el.dataset.provider);
      case 'tasks-provider-turn-on': return turnOnProvider(el.dataset.provider);
      case 'tasks-provider-check': return checkProvider();
      case 'tasks-provider-sync': return query('task_sync_now', {});
      case 'tasks-provider-copy': return copyQuietly();
      case 'tasks-provider-secret-save': return saveSecret(el);
      case 'tasks-provider-secret-remove': return removeSecret(el);
      case 'tasks-provider-setting': return saveProviderSetting(el);
      case 'tasks-provider-token-link': return openLink(el.dataset.url, el.dataset.name, el.dataset.pluginId);
      case 'tasks-who': v.filters.who = el.dataset.who || 'all'; return render();
      case 'tasks-filter': v.filters[el.dataset.filter] = el.value; return render();
      case 'tasks-clear': v.filters = { ...DEFAULT_FILTERS }; return render();
      case 'tasks-older': v.showOlder = !v.showOlder; return render();
      case 'tasks-dismissed': v.showDismissed = !v.showDismissed; return render();
      case 'task-new': return newTask();
      // The card's title, or Edit… in its menu.
      case 'task-open': case 'task-edit': return openDrawer(id);
      case 'task-close': return closeDrawer();
      case 'task-accept':
        await move(id, 'todo', { log: 'Accepted from review' });
        // Unless it was accepted in the drawer, focus goes to the card in its new column.
        if (!el.closest?.('.ws-task-drawer')) focus([titleOf(id)]);
        return undefined;
      case 'task-accept-all': return acceptAll();
      case 'task-dismiss': return dismiss(id);
      case 'task-restore':
        await move(id, 'review', { log: 'Restored' });
        toast(`Restored to ${columnName('review', snap().settings)}.`, 'success');
        return undefined;
      case 'task-move':
        await move(id, el.dataset.col);
        // From a card's menu, focus follows the card to its new column (the drawer keeps its own).
        if (!el.closest?.('.ws-task-drawer')) focus([`[data-menu-trigger="${quoted(id)}"]`, titleOf(id)]);
        return undefined;
      case 'task-status': return move(id, el.value);
      case 'task-done': return done(id, el);
      case 'task-owner': return mutate('task_save', { id, owner: el.value || null, ownerName: nameOf(el.value) });
      case 'task-due-pick': return mutate('task_save', { id, due: el.dataset.value || null });
      case 'task-due': {
        // A typed date is saved when it is left (blur or Enter), once, and only when it changed.
        const t = find(id);
        if (!t) throw missing();
        // A date typed only in part reads "" (`validity.badInput`): the due date stays.
        if (el.validity?.badInput) return null;
        if ((el.value || null) === (t.data.due || null)) return null;
        return mutate('task_save', { id, due: el.value || null });
      }
      case 'task-title': return rename(id, el.value);
      case 'task-notes': return notes(id, el.value);
      case 'task-delete': return remove(id);
      case 'task-quote': {
        const t = find(id);
        if (!t) throw missing();
        return openMeeting(t.data.meetingId, 'transcript', t.data.line ?? null);
      }
      case 'task-open-meeting': return openMeeting(id);
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
    // Enter or Escape that an input method (Chinese, Japanese, …) is still composing is its own.
    if (ev.isComposing || ev.keyCode === 229) return false;
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
