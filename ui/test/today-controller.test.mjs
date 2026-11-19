// The Today controller with its store, toasts and preferences faked: moves and resizes, the
// keyboard, Add and Remove, saved layouts, lock, undo and redo, and what a save keeps.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createTodayController, newTodayView } from '../workspace/today-controller.js';
import { optionsPanel } from '../workspace/today-edit-view.js';
import { PRESETS, layoutChanged } from '../workspace/today-grid.js';
import { today as todayPage, tileDefs } from '../workspace/view-today.js';
import { active } from '../workspace/selectors.js';
import { buildSnapshot } from './fixtures/workspace-fixture.mjs';

const NOW = Date.UTC(2026, 10, 19, 9);
const clone = v => JSON.parse(JSON.stringify(v));
const at = (items, id) => items.find(i => i.id === id);
const box = (items, id) => { const i = at(items, id); return i && [i.x, i.y, i.w, i.h]; };
const overlaps = items => items.some((a, i) => items.slice(i + 1).some(b => a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y));

/** A controller over fakes. `mutate` applies `layout_save` to the active workspace, as the
 *  snapshot after a real save shows it, or rejects with `refuse`. */
function harness({ prefs = {}, refuse = null, edit = () => {} } = {}) {
  const snapshot = buildSnapshot(NOW, { photo: false, zone: 'UTC' });
  const w = active(snapshot);
  edit(w);
  const calls = { mutate: [], render: 0, toasts: [], announced: [], focus: [] };
  const state = { route: 'today', pluginsKnown: false, installedPlugins: [], today: newTodayView() };
  const stored = { ...prefs };
  const ctl = createTodayController({
    state,
    snap: () => snapshot,
    mutate: async (op, data) => {
      calls.mutate.push([op, clone(data)]);
      if (refuse) throw refuse;
      if (op === 'layout_save') {
        w.today = clone(data.today);
        w.layout = [...data.layout];
      }
      return { saved: true };
    },
    render: async () => { calls.render++; },
    toast: (message, tone, action) => calls.toasts.push({ message, tone, action }),
    prefs: { get: (key, fallback) => stored[key] ?? fallback, json: (key, fallback) => fallback, set: (key, value) => { stored[key] = value; } },
    announce: text => calls.announced.push(text),
    focus: selector => calls.focus.push(selector),
    now: () => NOW,
  });
  const saved = () => calls.mutate.filter(([op]) => op === 'layout_save').map(([, d]) => d);
  return { ctl, state, calls, snapshot, w, saved, stored };
}
const el = (dataset = {}, extra = {}) => ({ dataset, closest: () => null, ...extra });
const key = (k, shiftKey = false) => ({ key: k, shiftKey, prevented: false, preventDefault() { this.prevented = true; } });

test('moving a widget saves the grid once with the layout order', async () => {
  const { ctl, saved, calls } = harness();
  const next = ctl.moveTo('focus', 0, 0);
  assert.deepEqual(box(next.items, 'focus'), [0, 0, 4, 4], 'the held widget is where it is dropped');
  assert.equal(await ctl.commit(next), true);
  assert.equal(saved().length, 1);
  const [d] = saved();
  assert.deepEqual(d.layout.slice(0, 2), ['focus', 'brief']);
  assert.equal(d.today.active, 'Default');
  assert.deepEqual(d.today.layouts.Default, d.today.items, 'the layout in use keeps the same items');
  assert.equal(d.widgetWidths, undefined, 'no widths any more');
  assert.equal(overlaps(d.today.items), false);
  assert.equal(calls.announced.at(-1), 'Day at a glance moved to column 1, row 1', 'the drop is announced');
  // A resize by its edge is announced with its size.
  await ctl.commit(ctl.resizeTo('focus', 6, 4));
  assert.deepEqual(box(saved()[1].today.items, 'focus'), [0, 0, 6, 4]);
  assert.equal(calls.announced.at(-1), 'Day at a glance is 6 columns by 4 rows');
  await ctl.undo();
  assert.deepEqual(box(saved()[2].today.items, 'focus'), [0, 0, 4, 4]);
  // The same grid again saves nothing.
  assert.equal(await ctl.commit(ctl.moveTo('focus', 0, 0)), false);
  assert.equal(saved().length, 3);
});

test('undo saves the layout from before the change and redo the one after', async () => {
  const { ctl, saved, state, calls } = harness();
  await ctl.commit(ctl.moveTo('focus', 0, 0));
  assert.equal(state.today.history.length, 1);
  await ctl.undo();
  assert.deepEqual(saved()[1].layout.slice(0, 2), ['brief', 'focus']);
  assert.deepEqual(box(saved()[1].today.items, 'focus'), [8, 0, 4, 4]);
  assert.deepEqual([state.today.history.length, state.today.future.length], [0, 1]);
  assert.equal(calls.announced.at(-1), 'Layout change undone', 'the live region says so');
  await ctl.redo();
  assert.deepEqual(saved()[2].layout.slice(0, 2), ['focus', 'brief']);
  assert.deepEqual([state.today.history.length, state.today.future.length], [1, 0]);
  assert.equal(calls.announced.at(-1), 'Layout change redone');
  // Nothing left to redo.
  await ctl.redo();
  assert.equal(saved().length, 3);
  // ⌘Z and ⇧⌘Z come through handle as well.
  await ctl.handle('today-undo', el());
  assert.deepEqual(saved()[3].layout.slice(0, 2), ['brief', 'focus']);
  await ctl.handle('today-redo', el());
  assert.deepEqual(saved()[4].layout.slice(0, 2), ['focus', 'brief']);
});

test('a drop that changes nothing saves nothing and draws the grid again', async () => {
  const { ctl, calls } = harness();
  // The lowest widget held in the empty rows below the grid: the save packs it back up.
  const next = ctl.moveTo('meetings', 0, 22);
  assert.equal(at(next.items, 'meetings').y, 22, 'held where it is dropped');
  assert.equal(await ctl.commit(next), false);
  assert.equal(calls.mutate.length, 0);
  assert.equal(calls.render, 1, 'the tile moved by hand is drawn back where the grid keeps it');
  // A resize to the same size, and a gallery card's drop that changes nothing, the same.
  assert.equal(await ctl.commit(ctl.resizeTo('focus', 4, 4)), false);
  assert.equal(await ctl.commit(ctl.moveTo('focus', 8, 0), undefined, 'Day at a glance added to Today'), false);
  assert.deepEqual([calls.mutate.length, calls.render, calls.toasts.length], [0, 3, 0]);
  // A keyed change that changes nothing (a title left as it was) still draws nothing.
  await ctl.handle('today-title', el({ id: 'calendar' }, { value: 'Schedule' }));
  assert.equal(calls.render, 3);
});

test('a refused save puts the widgets back and shows the message', async () => {
  const refusal = { code: 'validation', message: 'Invalid Today layout.', field: 'today' };
  const { ctl, calls, w, state } = harness({ refuse: refusal });
  const before = clone(w.today);
  assert.equal(await ctl.commit(ctl.moveTo('focus', 0, 0)), false);
  assert.equal(calls.mutate.length, 1);
  assert.deepEqual(w.today, before, 'today is unchanged');
  assert.ok(calls.render >= 1, 'the page is drawn again from what is stored');
  assert.deepEqual(calls.toasts.map(t => [t.message, t.tone]), [['Invalid Today layout.', 'error']]);
  assert.deepEqual([state.today.history.length, state.today.future.length], [0, 0], 'nothing to undo');
});

test('locked: moving does nothing and the toast offers Unlock', async () => {
  const { ctl, calls, stored } = harness({ prefs: { 'codemie.layout.locked': '1' } });
  assert.equal(ctl.locked(), true);
  await ctl.commit(ctl.moveTo('focus', 0, 0));
  await ctl.commit(ctl.resizeTo('focus', 12, 8));
  const arrow = key('ArrowRight');
  await ctl.handle('today-key', el({ grip: 'brief' }), arrow);
  await ctl.handle('today-width', el({ id: 'brief', w: '12' }));
  await ctl.handle('today-top', el({ id: 'calendar' }));
  assert.equal(calls.mutate.length, 0);
  assert.ok(arrow.prevented, 'the arrow does not scroll the page');
  const nudge = calls.toasts.find(t => t.message === 'Layouts are locked');
  assert.equal(nudge.action.label, 'Unlock');
  await nudge.action.run();
  assert.equal(stored['codemie.layout.locked'], '0');
  assert.equal(ctl.locked(), false);
  // The header's lock button turns it back on.
  await ctl.handle('today-lock', el());
  assert.equal(stored['codemie.layout.locked'], '1');
});

test('locked: ⌘Z, ⇧⌘Z, Undo and Redo change nothing and offer Unlock', async () => {
  const { ctl, calls, saved, state, stored } = harness();
  await ctl.commit(ctl.moveTo('focus', 0, 0));
  await ctl.undo();
  assert.deepEqual([saved().length, state.today.history.length, state.today.future.length], [2, 0, 1]);
  await ctl.commit(ctl.moveTo('focus', 0, 0));
  await ctl.undo();
  await ctl.redo();
  assert.deepEqual([saved().length, state.today.history.length, state.today.future.length], [5, 1, 0]);
  await ctl.handle('today-lock', el());
  const toasts = calls.toasts.length;
  // The keys call undo and redo (app.js chains .catch on them); the edit bar's buttons come
  // through handle.
  const pending = ctl.undo();
  assert.equal(typeof pending.catch, 'function', 'a promise, as when unlocked');
  await pending;
  await ctl.handle('today-undo', el());
  await ctl.redo();
  await ctl.handle('today-redo', el());
  assert.equal(saved().length, 5, 'nothing is saved');
  assert.deepEqual([state.today.history.length, state.today.future.length], [1, 0], 'the history is kept');
  const nudges = calls.toasts.slice(toasts);
  assert.deepEqual(nudges.map(t => [t.message, t.action?.label]), Array(4).fill(['Layouts are locked', 'Unlock']));
  await nudges[0].action.run();
  assert.equal(stored['codemie.layout.locked'], '0');
  await ctl.undo();
  assert.equal(saved().length, 6, 'unlocked, Undo works again');
});

test('Add puts the widget at the top left and pushes the others down', async () => {
  const { ctl, saved, calls } = harness();
  await ctl.handle('today-add', el({ id: 'timer' }));
  const [d] = saved();
  assert.deepEqual(box(d.today.items, 'timer'), [0, 0, 4, 3]);
  assert.equal(at(d.today.items, 'brief').y, 3);
  assert.equal(d.layout[0], 'timer');
  assert.equal(overlaps(d.today.items), false);
  const added = calls.toasts.at(-1);
  assert.equal(added.message, 'Focus timer added to Today');
  assert.equal(added.action.label, 'Undo');
  // A widget already on Today is not added twice.
  await ctl.handle('today-add', el({ id: 'timer' }));
  assert.equal(saved().length, 1);
});

test('removing a widget toasts with Undo, and removing an auto card hides it', async () => {
  const { ctl, saved, calls } = harness();
  await ctl.handle('today-remove', el({ id: 'calendar' }));
  let t = saved()[0].today;
  assert.equal(at(t.items, 'calendar'), undefined);
  assert.deepEqual(t.hidden, [], 'an ordinary widget is just taken off');
  assert.equal(overlaps(t.items), false);
  const removed = calls.toasts.at(-1);
  assert.equal(removed.message, 'Schedule removed from Today');
  assert.equal(removed.action.label, 'Undo');
  await ctl.handle('today-remove', el({ id: 'meetings' }));
  t = saved()[1].today;
  assert.equal(at(t.items, 'meetings'), undefined);
  assert.deepEqual(t.hidden, ['meetings'], 'an auto card stays away');
  // Undo brings it back.
  await calls.toasts.at(-1).action.run();
  t = saved()[2].today;
  assert.ok(at(t.items, 'meetings'));
  assert.deepEqual(t.hidden, []);
  // Adding a hidden auto card from the gallery takes it out of hidden.
  await ctl.handle('today-remove', el({ id: 'meetings' }));
  await ctl.handle('today-add', el({ id: 'meetings' }));
  t = saved().at(-1).today;
  assert.deepEqual(box(t.items, 'meetings'), [0, 0, 6, 5]);
  assert.deepEqual(t.hidden, []);
});

test('switching layouts keeps the changes of the layout left', async () => {
  const { ctl, saved, calls } = harness();
  await ctl.commit(ctl.moveTo('focus', 0, 0));
  await ctl.handle('today-layout-use', el({ name: 'Focus' }));
  let t = saved()[1].today;
  assert.equal(t.active, 'Focus');
  assert.deepEqual(t.items.map(i => [i.id, i.x, i.y, i.w, i.h]).sort(), PRESETS.Focus.map(i => [i.id, i.x, i.y, i.w, i.h]).sort());
  assert.deepEqual(box(t.layouts.Default, 'focus'), [0, 0, 4, 4], 'Default keeps the move');
  const switched = calls.toasts.at(-1);
  assert.equal(switched.message, 'Switched to “Focus”');
  assert.equal(switched.action.label, 'Undo');
  await ctl.handle('today-layout-use', el({ name: 'Default' }));
  t = saved()[2].today;
  assert.equal(t.active, 'Default');
  assert.deepEqual(box(t.items, 'focus'), [0, 0, 4, 4]);
  assert.ok(layoutChanged(t, 'Default'), 'Default shows as changed');
  assert.equal(layoutChanged(t, 'Focus'), false);
});

test('Reset brings a built-in layout back; an own layout can be deleted; an own layout can\'t take a built-in name', async () => {
  const { ctl, saved, calls } = harness();
  await ctl.commit(ctl.moveTo('focus', 0, 0));
  await ctl.handle('today-layout-reset', el({ name: 'Default' }));
  let t = saved()[1].today;
  assert.deepEqual(t.items.map(i => [i.id, i.x, i.y, i.w, i.h]).sort(), PRESETS.Default.map(i => [i.id, i.x, i.y, i.w, i.h]).sort());
  assert.equal(layoutChanged(t, 'Default'), false);
  assert.equal(calls.toasts.at(-1).message, '“Default” is back to the original');
  // An own layout: saved as, then deleted.
  await ctl.handle('today-layout-save', el({ name: '  Deep work  ' }));
  t = saved()[2].today;
  assert.equal(t.active, 'Deep work');
  assert.deepEqual(t.layouts['Deep work'], t.items);
  assert.equal(calls.toasts.at(-1).message, 'Saved as “Deep work” — changes now go to this layout');
  await ctl.handle('today-layout-delete', el({ name: 'Deep work' }));
  t = saved()[3].today;
  assert.equal(Object.hasOwn(t.layouts, 'Deep work'), false);
  assert.equal(t.active, 'Default', 'the deleted layout was in use: Default takes over');
  // Built-in names belong to the built-in layouts.
  await assert.rejects(ctl.handle('today-layout-save', el({ name: 'Focus' })), /That name belongs to a built-in layout\./);
  await assert.rejects(ctl.handle('today-layout-delete', el({ name: 'Focus' })));
  await assert.rejects(ctl.handle('today-layout-save', el({ name: '   ' })));
  assert.equal(saved().length, 4);
});

test('a title is saved on Enter or blur, not per keystroke', async () => {
  const { ctl, saved, state } = harness();
  // The title fields save when they are left (Enter leaves them): no action runs per keystroke.
  const t = { active: 'Default', items: PRESETS.Default, titles: {}, options: {}, hidden: [] };
  const panel = optionsPanel(PRESETS.Default[2], tileDefs().calendar, t, 2);
  const input = panel.match(/<input[^>]*name="title"[^>]*>/)?.[0] || '';
  assert.match(input, /data-commit="today-title"/);
  assert.match(input, /data-id="calendar"/);
  assert.doesNotMatch(input, /data-action/);
  state.today.renaming = 'calendar';
  await ctl.handle('today-title', el({ id: 'calendar' }, { value: '  Agenda ' }));
  assert.equal(saved().length, 1);
  assert.deepEqual(saved()[0].today.titles, { calendar: 'Agenda' });
  assert.equal(state.today.renaming, null, 'renaming ends');
  await ctl.handle('today-title', el({ id: 'calendar' }, { value: 'Agenda' }));
  assert.equal(saved().length, 1, 'the same title saves nothing');
  // Its own name again, or nothing, gives the widget its own title back.
  await ctl.handle('today-title', el({ id: 'calendar' }, { value: 'Schedule' }));
  assert.deepEqual(saved()[1].today.titles, {});
});

test('an unavailable widget is skipped in the view and kept in the save', async () => {
  const { ctl, saved, snapshot, state } = harness({
    edit: w => {
      w.today = { active: 'Default', items: [{ id: 'plugin:gone:w', x: 0, y: 0, w: 12, h: 2 }, ...PRESETS.Default.map(i => ({ ...i, y: i.y + 2 }))] };
      w.layout = w.today.items.map(i => i.id);
    },
  });
  state.pluginsKnown = true;
  const html = todayPage(snapshot, { auth: {}, hidden: new Set(), banners: '', pluginsKnown: true, plugins: { catalog: [] }, state: {} });
  assert.doesNotMatch(html, /data-tile="plugin:gone:w"/);
  assert.match(html, /data-tile="brief"/);
  await ctl.commit(ctl.moveTo('focus', 0, 0));
  const t = saved()[0].today;
  const gone = at(t.items, 'plugin:gone:w');
  assert.deepEqual([gone.x, gone.w, gone.h], [0, 12, 2], 'kept as it was');
  const shown = t.items.filter(i => i !== gone);
  assert.equal(gone.y, Math.max(...shown.map(i => i.y + i.h)), 'packed below the visible widgets');
  assert.equal(Math.min(...shown.map(i => i.y)), 0, 'the visible widgets float up');
  assert.equal(overlaps(t.items), false);
  assert.ok(saved()[0].layout.includes('plugin:gone:w'));
});

test('a card native put in layout is kept by the first save', async () => {
  const { ctl, saved } = harness({
    edit: w => {
      w.today = { active: 'Default', items: PRESETS.Default.filter(i => i.id !== 'automations') };
      w.layout = [...w.today.items.map(i => i.id), 'automations'];
    },
  });
  await ctl.commit(ctl.moveTo('focus', 0, 0));
  const [d] = saved();
  const auto = at(d.today.items, 'automations');
  assert.ok(auto, 'automations is placed');
  assert.deepEqual([auto.x, auto.w, auto.h], [0, 12, 5], 'full width at its default height');
  assert.equal(auto.y, Math.max(...d.today.items.filter(i => i !== auto).map(i => i.y + i.h)), 'at the bottom');
  assert.ok(d.layout.includes('automations'));
  assert.equal(overlaps(d.today.items), false);
  // Undo brings back the grid as it was shown, the card at the bottom included.
  await ctl.undo();
  assert.deepEqual(box(saved()[1].today.items, 'focus'), [8, 0, 4, 4]);
  assert.deepEqual(box(saved()[1].today.items, 'automations'), [0, 22, 12, 5]);
  assert.ok(saved()[1].layout.includes('automations'));
});

test('a stacked grid ignores moves and resizes', async () => {
  const { ctl, calls, state } = harness();
  state.today.stacked = true;
  assert.equal(ctl.stacked(), true);
  await ctl.commit(ctl.moveTo('focus', 0, 0));
  await ctl.commit(ctl.resizeTo('focus', 12, 8));
  await ctl.handle('today-key', el({ grip: 'brief' }), key('ArrowRight'));
  await ctl.handle('today-width', el({ id: 'brief', w: '12' }));
  await ctl.handle('today-height', el({ id: 'brief', h: '9' }));
  assert.equal(calls.mutate.length, 0);
});

test('keyboard: ArrowRight moves one column, Shift+ArrowDown adds a row, Delete removes', async () => {
  const { ctl, saved, calls } = harness();
  const right = key('ArrowRight');
  await ctl.handle('today-key', el({ grip: 'brief' }), right);
  assert.ok(right.prevented);
  assert.deepEqual(box(saved()[0].today.items, 'brief'), [1, 0, 8, 4]);
  assert.equal(calls.announced.at(-1), 'Up next moved to column 2, row 1');
  await ctl.handle('today-key', el({ grip: 'brief' }), key('ArrowDown', true));
  assert.deepEqual(box(saved()[1].today.items, 'brief'), [1, 0, 8, 5]);
  assert.equal(calls.announced.at(-1), 'Up next is 8 columns by 5 rows');
  await ctl.handle('today-key', el({ grip: 'brief' }), key('Delete'));
  assert.equal(at(saved()[2].today.items, 'brief'), undefined);
  assert.equal(calls.toasts.at(-1).message, 'Up next removed from Today');
  // Other keys stay with the page.
  const other = key('a');
  await ctl.handle('today-key', el({ grip: 'focus' }), other);
  assert.equal(other.prevented, false);
  assert.equal(saved().length, 3);
});

test('keyboard: ArrowUp jumps above the widget directly over it', async () => {
  const { ctl, saved, calls } = harness();
  await ctl.handle('today-key', el({ grip: 'commitments' }), key('ArrowUp'));
  assert.deepEqual(box(saved()[0].today.items, 'commitments'), [0, 4, 8, 6], 'above Schedule, which starts at row 5');
  assert.equal(calls.announced.at(-1), 'Tasks moved to column 1, row 5');
  assert.equal(overlaps(saved()[0].today.items), false);
});

test('the widget menu sets width, height, collapses and moves to the top', async () => {
  const { ctl, saved, calls } = harness();
  const closed = [];
  const item = data => el(data, { closest: sel => (sel === 'details' ? { removeAttribute: name => closed.push(name) } : null) });
  await ctl.handle('today-width', item({ id: 'inbox', w: '12' }));
  assert.deepEqual(box(saved()[0].today.items, 'inbox'), [0, 4, 12, 7], 'full width moves it to the left edge');
  assert.ok(closed.includes('open'), 'the menu closes');
  await ctl.handle('today-height', item({ id: 'inbox', h: '3' }));
  assert.equal(at(saved()[1].today.items, 'inbox').h, 3);
  await ctl.handle('today-collapse', item({ id: 'inbox' }));
  assert.deepEqual(at(saved()[2].today.items, 'inbox'), { id: 'inbox', x: 0, y: 4, w: 12, h: 1, collapsed: true, prevH: 3 });
  assert.equal(calls.announced.at(-1), 'Needs your reply collapsed');
  await ctl.handle('today-collapse', item({ id: 'inbox' }));
  assert.deepEqual(at(saved()[3].today.items, 'inbox'), { id: 'inbox', x: 0, y: 4, w: 12, h: 3 });
  await ctl.handle('today-top', item({ id: 'notes' }));
  assert.deepEqual(box(saved()[4].today.items, 'notes').slice(0, 2), [0, 0]);
  assert.equal(overlaps(saved()[4].today.items), false);
});

test('locked: the widget menu refuses Collapse and Expand as it does Width and Height; Remove still works', async () => {
  const { ctl, saved, calls } = harness({ prefs: { 'codemie.layout.locked': '1' } });
  const closed = [];
  const item = data => el(data, { closest: sel => (sel === 'details' ? { removeAttribute: name => closed.push(name) } : null) });
  await ctl.handle('today-collapse', item({ id: 'inbox' }));
  assert.equal(saved().length, 0, 'Collapse saves nothing');
  assert.ok(closed.includes('open'), 'the menu closes');
  assert.deepEqual([calls.toasts.at(-1).message, calls.toasts.at(-1).action.label], ['Layouts are locked', 'Unlock']);
  // A widget collapsed before the lock stays collapsed: Expand is refused too.
  await calls.toasts.at(-1).action.run();
  await ctl.handle('today-collapse', item({ id: 'inbox' }));
  assert.equal(at(saved()[0].today.items, 'inbox').collapsed, true);
  await ctl.handle('today-lock', el());
  const toasts = calls.toasts.length;
  await ctl.handle('today-collapse', item({ id: 'inbox' }));
  assert.equal(saved().length, 1, 'Expand saves nothing');
  assert.equal(calls.toasts.at(-1).message, 'Layouts are locked');
  assert.equal(calls.toasts.length, toasts + 1);
  // Remove from Today neither moves nor resizes: it is not refused.
  await ctl.handle('today-remove', item({ id: 'notes' }));
  assert.equal(saved().length, 2);
  assert.equal(at(saved()[1].today.items, 'notes'), undefined);
});

test('the options panel saves options as they change and Reset widget clears them', async () => {
  const { ctl, saved, state, calls } = harness();
  await ctl.handle('today-options', el({ id: 'inbox' }));
  assert.equal(state.today.options, 'inbox');
  assert.equal(calls.mutate.length, 0, 'opening the panel saves nothing');
  await ctl.handle('today-option', el({ id: 'inbox', key: 'max' }, { tagName: 'SELECT', value: '3' }));
  assert.deepEqual(saved()[0].today.options, { inbox: { max: '3' } });
  await ctl.handle('today-option', el({ id: 'inbox', key: 'sources' }, { type: 'checkbox', value: 'chat', checked: false }));
  assert.deepEqual(saved()[1].today.options, { inbox: { max: '3', sources: ['mail'] } });
  await ctl.handle('today-option', el({ id: 'brief', key: 'later' }, { type: 'checkbox', checked: false }));
  assert.deepEqual(saved()[2].today.options.brief, { later: false });
  await ctl.handle('today-reset', el({ id: 'inbox' }));
  assert.equal(Object.hasOwn(saved()[3].today.options, 'inbox'), false);
  // The panel closes from its own button (no id) and when the widget goes.
  await ctl.handle('today-options', el());
  assert.equal(state.today.options, null);
});

test('Customize mode draws the edit bar, an × on each widget, the add tile, the gallery and the options panel', () => {
  const snapshot = buildSnapshot(NOW, { photo: false, zone: 'UTC' });
  const ctx = today => ({ auth: {}, hidden: new Set(), banners: '', plugins: { catalog: [] }, state: {}, today });
  const plain = todayPage(snapshot, ctx({ ...newTodayView(), locked: true }));
  assert.match(plain, /data-action="today-lock"[^>]*aria-pressed="true"/);
  assert.match(plain, /data-action="today-customize" data-focus="gallery"[^>]*>[^]*?Add widget/);
  assert.match(plain, /<details class="ws-menu ws-menu-right ws-today-layouts" data-menu="today-layouts">[^]*?<span>Default<\/span>/);
  assert.match(plain, /data-form="today-layout-save"/);
  assert.doesNotMatch(plain, /ws-today-editbar|ws-tile-remove|ws-gallery/);
  const html = todayPage(snapshot, ctx({ ...newTodayView(), editing: true, history: [{}], options: 'calendar', locked: false }));
  assert.match(html, /class="ws-today ws-today-page ws-today-editing"/);
  assert.match(html, /<strong>Customizing Today<\/strong><span>Drag a header to move · pull an edge or corner to resize · drag cards in from the right<\/span>/);
  assert.match(html, /data-action="today-undo"(?![^>]*disabled)/, 'something to undo');
  assert.match(html, /data-action="today-redo"[^>]*disabled/, 'nothing to redo');
  assert.equal([...html.matchAll(/class="ws-tile-remove" data-action="today-remove"/g)].length, 8, 'every widget has an ×');
  assert.match(html, /Add a widget here — or drag one in/);
  assert.match(html, /<div class="ws-tiles" data-today-grid style="--rows:25">/, 'room under the widgets');
  assert.match(html, /<div class="ws-gallery-group">Add to Today<\/div>[^]*?data-gid="timer"/);
  assert.match(html, /<div class="ws-gallery-group">On Today · 8<\/div>/);
  assert.match(html, /<div class="ws-today-options ws-today-options-right" role="dialog" aria-label="Customize Schedule" style="--x:0;--y:4;--w:6;--h:7;--order:2">/);
  assert.match(html, /data-action="today-reset" data-id="calendar"/);
  assert.match(html, /<div class="ws-actions ws-today-actions"><\/div>/, 'the header buttons give way to the edit bar');
});

test('Customize opens the gallery and Done closes it', async () => {
  const { ctl, state, calls, stored } = harness({ prefs: { 'codemie.layout.locked': '1' } });
  await ctl.handle('today-customize', el({ focus: 'gallery' }));
  assert.equal(state.today.editing, true);
  assert.equal(stored['codemie.layout.locked'], '0', 'customizing unlocks the layouts');
  assert.deepEqual(calls.focus.at(-1), '#today-gallery-search');
  await ctl.handle('today-gallery-search', el({}, { value: 'focus' }));
  assert.equal(state.today.gallery, 'focus');
  await ctl.handle('today-done', el());
  assert.deepEqual([state.today.editing, state.today.gallery, state.today.options], [false, '', null]);
  assert.equal(calls.toasts.at(-1).message, 'Today is saved — every change is kept as you make it');
  assert.equal(calls.mutate.length, 0);
});
