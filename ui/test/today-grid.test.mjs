// The Today grid engine: packing, moving and resizing, the built-in layouts, and how a workspace
// without a saved grid gets one.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  GRID, PRESETS, compact, moveItem, resizeItem, placeAtTop, removeItem, fromLegacy, todayOf, autoCards,
  layoutChanged, payloadOf, sizeName, optionsOf,
} from '../workspace/today-grid.js';
import { tileDefs } from '../workspace/view-today.js';

const defs = tileDefs([]);
const at = (items, id) => items.find(i => i.id === id);
const box = it => [it.x, it.y, it.w, it.h];
const fresh = name => PRESETS[name].map(i => ({ ...i }));

test('the grid has 12 columns of 56 px rows and the three built-in layouts', () => {
  assert.deepEqual(GRID, { cols: 12, rowHeight: 56, gap: 16, stackBelow: 640, maxItems: 16, maxLayouts: 15, maxOwnLayouts: 12 });
  assert.deepEqual(Object.keys(PRESETS), ['Default', 'Focus', 'Meeting day']);
  assert.deepEqual(PRESETS.Default.map(i => [i.id, ...box(i)]), [
    ['brief', 0, 0, 8, 4], ['focus', 8, 0, 4, 4], ['calendar', 0, 4, 6, 7], ['inbox', 6, 4, 6, 7],
    ['commitments', 0, 11, 8, 6], ['notes', 8, 11, 4, 6], ['meetings', 0, 17, 6, 5], ['automations', 6, 17, 6, 5],
  ]);
  assert.deepEqual(PRESETS.Focus.map(i => [i.id, ...box(i)]), [
    ['brief', 0, 0, 8, 3], ['timer', 8, 0, 4, 3], ['commitments', 0, 3, 8, 7], ['notes', 8, 3, 4, 7], ['inbox', 0, 10, 6, 5], ['calendar', 6, 10, 6, 5],
  ]);
  assert.deepEqual(PRESETS['Meeting day'].map(i => [i.id, ...box(i)]), [
    ['brief', 0, 0, 6, 4], ['calendar', 6, 0, 6, 9], ['meetings', 0, 4, 6, 5], ['inbox', 0, 9, 6, 6], ['commitments', 6, 9, 6, 6],
  ]);
});

test('a held widget swaps places with the one beside it', () => {
  const orig = fresh('Default');
  const next = moveItem(orig, 'focus', 0, 0, orig);
  assert.deepEqual(box(at(next, 'focus')), [0, 0, 4, 4]);
  assert.ok(at(next, 'brief').x === 4 && at(next, 'brief').y === 0, JSON.stringify(at(next, 'brief')));
  assert.deepEqual(orig, PRESETS.Default, 'a new array: the layout before the drag is left alone');
  // Everyone else starts from where they were before the drag, so wiggling leaves no holes.
  const wiggled = moveItem(moveItem(orig, 'focus', 0, 6, orig), 'focus', 8, 0, orig);
  assert.deepEqual(wiggled.map(box), orig.map(box));
});

test('a widget that cannot slide drops below the held one', () => {
  const orig = fresh('Default');
  const next = resizeItem(orig, 'brief', 12, 4, orig, defs.brief);
  assert.deepEqual(box(at(next, 'brief')), [0, 0, 12, 4]);
  assert.equal(at(next, 'focus').y, 4);
});

test('compact floats widgets up and keeps x', () => {
  const items = [{ id: 'notes', x: 8, y: 9, w: 4, h: 2 }, { id: 'inbox', x: 0, y: 5, w: 6, h: 3 }, { id: 'brief', x: 0, y: 0, w: 6, h: 2 }];
  const same = compact(items);
  assert.equal(same, items, 'it packs the array it is given');
  assert.deepEqual(items.map(i => [i.id, ...box(i)]), [['notes', 8, 0, 4, 2], ['inbox', 0, 2, 6, 3], ['brief', 0, 0, 6, 2]]);
});

test('resize clamps to the widget minimum and to the right edge', () => {
  const orig = fresh('Meeting day');
  assert.equal(at(orig, 'calendar').x, 6);
  assert.equal(at(resizeItem(orig, 'calendar', 9, 9, orig, defs.calendar), 'calendar').w, 6);
  assert.equal(at(resizeItem(orig, 'calendar', 1, 9, orig, defs.calendar), 'calendar').w, 2);
  assert.equal(at(resizeItem(orig, 'calendar', 6, 1, orig, defs.calendar), 'calendar').h, 3, 'Schedule is at least 3 rows');
  assert.equal(at(resizeItem(orig, 'calendar', 6, 40, orig, defs.calendar), 'calendar').h, 24);
  assert.equal(at(moveItem(orig, 'calendar', 11, 0, orig), 'calendar').x, 6, 'never past the right edge');
});

test('Add puts a widget at the top left and pushes the others down; Remove packs the rest up', () => {
  const added = placeAtTop(fresh('Default'), { id: 'timer', w: 4, h: 3 });
  assert.deepEqual(box(at(added, 'timer')), [0, 0, 4, 3]);
  assert.equal(at(added, 'brief').y, 3);
  const removed = removeItem(fresh('Default'), 'brief');
  assert.equal(at(removed, 'brief'), undefined);
  assert.deepEqual(box(at(removed, 'calendar')), [0, 0, 6, 7]);
});

test('todayOf gives Default to a never-customized workspace', () => {
  // The layout native code seeds (repository.rs) and no widths: the old dialog never saved.
  const w = { layout: ['brief', 'focus', 'calendar', 'inbox', 'commitments', 'automations'], widgetWidths: {}, today: {} };
  const t = todayOf(w, defs);
  assert.equal(t.active, 'Default');
  assert.deepEqual(t.items, PRESETS.Default);
  assert.notEqual(t.items[0], PRESETS.Default[0], 'a copy, never the preset itself');
  assert.deepEqual([t.layouts, t.titles, t.options, t.hidden], [{}, {}, {}, []]);
});

test('todayOf turns a customized layout into My layout with Notes after Tasks', () => {
  const w = { layout: ['brief', 'commitments', 'inbox'], widgetWidths: { brief: 8, commitments: 8, inbox: 6 }, today: {} };
  const t = todayOf(w, defs);
  assert.equal(t.active, 'My layout');
  assert.deepEqual(t.items.map(i => [i.id, ...box(i)]), [['brief', 0, 0, 8, 4], ['commitments', 0, 4, 8, 6], ['notes', 8, 4, 4, 6], ['inbox', 0, 10, 6, 7]]);
  assert.deepEqual(t.layouts, { 'My layout': t.items });
  // A width that isn't a whole number of columns falls back to the widget's default.
  assert.deepEqual(box(fromLegacy(['calendar'], { calendar: 5.5 }, defs)[0]), [0, 0, 6, 7]);
  // Unknown ids are dropped; a plugin widget keeps its saved width at 4 rows.
  assert.deepEqual(fromLegacy(['weather', 'plugin:github:ci'], { 'plugin:github:ci': 4 }, defs), [{ id: 'plugin:github:ci', x: 0, y: 0, w: 4, h: 4 }]);
});

test('todayOf hides an auto card the old layout hid', () => {
  const t = todayOf({ layout: ['brief'], widgetWidths: { brief: 8, meetings: 6 }, today: {} }, defs);
  assert.deepEqual(t.hidden, ['meetings']);
  assert.deepEqual(todayOf({ layout: ['brief', 'meetings'], widgetWidths: { brief: 8, meetings: 6 }, today: {} }, defs).hidden, []);
});

test('todayOf reads the native fixture', () => {
  const native = JSON.parse(readFileSync(new URL('./fixtures/contract/today-layout.json', import.meta.url), 'utf8'));
  const t = todayOf(native, defs);
  assert.deepEqual(t, native.today);
  assert.notEqual(t.items, native.today.items, 'a copy the caller may change');
  assert.deepEqual(payloadOf(t).layout, native.layout);
});

test('autoCards shows an id in layout that the grid lacks, unless hidden', () => {
  const t = { items: [{ id: 'brief', x: 0, y: 0, w: 8, h: 4 }], hidden: ['plugins'] };
  assert.deepEqual(autoCards({ layout: ['brief', 'automations'] }, t, ['meetings', 'plugins']), ['automations', 'meetings']);
  assert.deepEqual(autoCards({ layout: ['brief'] }, t, ['brief']), [], 'a placed card is not drawn twice');
});

test('payloadOf orders layout ids by row then column and mirrors items into layouts[active]', () => {
  const items = [{ id: 'inbox', x: 6, y: 4, w: 6, h: 7 }, { id: 'focus', x: 8, y: 0, w: 4, h: 4 }, { id: 'calendar', x: 0, y: 4, w: 6, h: 7 }, { id: 'brief', x: 0, y: 0, w: 8, h: 4 }];
  const t = { active: 'Mine', items, layouts: { Focus: PRESETS.Focus }, titles: {}, options: {}, hidden: [] };
  const p = payloadOf(t);
  assert.deepEqual(p.layout, ['brief', 'focus', 'calendar', 'inbox']);
  assert.deepEqual(p.today.layouts, { Focus: PRESETS.Focus, Mine: items });
  assert.notEqual(p.today.layouts.Mine, p.today.items, 'two copies, not one array saved twice');
  assert.equal(t.layouts.Mine, undefined, 'the input is left alone');
});

test('layoutChanged ignores item order and own layouts', () => {
  const reordered = fresh('Default').reverse();
  assert.equal(layoutChanged({ layouts: { Default: reordered } }, 'Default'), false);
  assert.equal(layoutChanged({ layouts: { Default: reordered.map(i => (i.id === 'brief' ? { ...i, collapsed: false } : i)) } }, 'Default'), false);
  assert.equal(layoutChanged({ layouts: { Default: reordered.map(i => (i.id === 'brief' ? { ...i, h: 5 } : i)) } }, 'Default'), true);
  assert.equal(layoutChanged({ layouts: { Default: reordered.map(i => (i.id === 'brief' ? { ...i, collapsed: true } : i)) } }, 'Default'), true);
  assert.equal(layoutChanged({ layouts: {} }, 'Focus'), false, 'no copy, nothing changed');
  assert.equal(layoutChanged({ layouts: { Mine: [] } }, 'Mine'), false, 'only built-ins can be changed');
});

test('sizeName names the common widths and optionsOf puts saved options over the defaults', () => {
  assert.deepEqual([3, 4, 6, 8, 12, 5].map(sizeName), ['quarter', 'third', 'half', 'two thirds', 'full width', '5 columns']);
  assert.deepEqual(optionsOf({}, 'inbox', defs.inbox), { max: '6', sources: ['mail', 'chat'] });
  assert.deepEqual(optionsOf({ options: { inbox: { max: '3', sources: ['mail'] } } }, 'inbox', defs.inbox), { max: '3', sources: ['mail'] });
  // A value of the wrong type or outside the choices keeps the default.
  assert.deepEqual(optionsOf({ options: { inbox: { max: '7', sources: 'mail' } } }, 'inbox', defs.inbox), { max: '6', sources: ['mail', 'chat'] });
  assert.deepEqual(optionsOf({}, 'plugins', defs.plugins), {});
});
