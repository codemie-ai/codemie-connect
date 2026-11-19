// Page sections (spec "Page sections"): the pure dock model (normalize, resize, move tabs,
// collapse, maximize, storage) and its view.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadDock, moveTab, normalizeDock, resizePair, saveDock, setCollapsed, swapPanes, toggleMax, visibleTabs } from '../workspace/dock-model.js';
import { renderDock } from '../workspace/dock-view.js';

// Shaped like Meetings: a list, then a section of two tabs.
const DEF = {
  tabs: {
    a: { title: 'Alpha', icon: 'list', min: 200, w: 300, pin: 'meetings', pinTitle: 'From your meetings' },
    b: { title: 'Beta', icon: 'note', min: 300, w: 700 },
    c: { title: 'Gamma', icon: 'users', min: 260, w: 400 },
  },
  initial: [['a'], ['b', 'c']],
};
const CAL = {
  tabs: {
    'cal-side': { title: 'Calendars', icon: 'calendar-check', min: 220, w: 260 },
    'cal-main': { title: 'Calendar', icon: 'calendar', min: 480, w: 1000 },
  },
  initial: [['cal-side'], ['cal-main']],
};
const memory = (items = {}) => ({ items, getItem: k => (k in items ? items[k] : null), setItem: (k, v) => { items[k] = String(v); } });
const tabsOf = layout => layout.panes.map(p => p.tabs);
/** [a] [b] [c]: Gamma split out to the right of Beta. */
const three = () => moveTab(normalizeDock(DEF, null), DEF, 'c', { type: 'split', pane: 'p2', side: 'right' }).layout;

test('normalize drops unknown tabs and adds missing ones to the last section', () => {
  const initial = normalizeDock(DEF, null);
  assert.deepEqual(initial, {
    panes: [
      { id: 'p1', tabs: ['a'], active: 'a', w: 300, collapsed: false },
      { id: 'p2', tabs: ['b', 'c'], active: 'b', w: 700, collapsed: false },
    ],
    max: null,
  });
  const saved = {
    panes: [
      { id: 'p1', tabs: ['gone', 'a'], active: 'gone', w: 250, collapsed: false },
      { id: 'p2', tabs: ['b'], active: 'b', w: 600, collapsed: true },
      { id: 'p3', tabs: ['old'], active: 'old', w: 100, collapsed: false },
    ],
    max: null,
  };
  const d = normalizeDock(DEF, saved);
  assert.deepEqual(tabsOf(d), [['a'], ['b', 'c']], 'the unknown tabs and their empty section go; Gamma joins the last section');
  assert.deepEqual(d.panes.map(p => [p.id, p.active, p.w, p.collapsed]), [['p1', 'a', 250, false], ['p2', 'b', 600, true]]);
  // A tab saved twice is kept once; nonsense gives the default layout.
  assert.deepEqual(tabsOf(normalizeDock(DEF, { panes: [{ id: 'p1', tabs: ['a', 'b'], w: 10 }, { id: 'p1', tabs: ['b', 'c'] }] })), [['a', 'b'], ['c']]);
  for (const junk of [undefined, 5, 'x', [], { panes: 'no' }, { panes: [{ tabs: ['zzz'] }] }]) assert.deepEqual(normalizeDock(DEF, junk), initial);
});

test('loadDock ignores unreadable storage', () => {
  const initial = normalizeDock(DEF, null);
  const keys = [];
  assert.deepEqual(loadDock({ getItem: k => { keys.push(k); return null; } }, 'meetings', DEF), initial);
  assert.deepEqual(keys, ['codemie.layout.meetings.v1']);
  assert.deepEqual(loadDock({ getItem: () => '{' }, 'meetings', DEF), initial);
  assert.deepEqual(loadDock({ getItem: () => { throw new Error('denied'); } }, 'meetings', DEF), initial);
  // What saveDock writes, loadDock reads back; a storage that refuses to write is ignored.
  const store = memory();
  const moved = swapPanes(initial, 'p2', -1);
  saveDock(store, 'meetings', moved);
  assert.deepEqual(Object.keys(store.items), ['codemie.layout.meetings.v1']);
  assert.deepEqual(loadDock(store, 'meetings', DEF), moved);
  assert.doesNotThrow(() => saveDock({ setItem: () => { throw new Error('full'); } }, 'meetings', moved));
});

test('loadDock carries the old calendar sidebar choice once', () => {
  const store = memory();
  const first = loadDock(store, 'calendar', CAL, { collapse: ['cal-side'] });
  assert.equal(first.panes[0].collapsed, true, 'the hidden calendar list becomes a collapsed Calendars section');
  assert.equal(first.panes[1].collapsed, false);
  // Once a layout is stored, it is what opens.
  saveDock(store, 'calendar', setCollapsed(first, CAL, 'cal-side', false).layout);
  assert.equal(loadDock(store, 'calendar', CAL, { collapse: ['cal-side'] }).panes[0].collapsed, false);
});

test('pulling a divider past 55% of the minimum collapses that section', () => {
  const d = normalizeDock(DEF, null);
  // Alpha's minimum is 200, so it collapses below 110 px; above that it stops at its minimum.
  const kept = resizePair(d, DEF, 0, 300, 700, -189);
  assert.deepEqual(kept.panes.map(p => [p.w, p.collapsed]), [[200, false], [800, false]]);
  const gone = resizePair(d, DEF, 0, 300, 700, -191);
  assert.deepEqual(gone.panes.map(p => p.collapsed), [true, false]);
  assert.equal(gone.panes[0].w, 300, 'a collapsed section keeps the width it comes back to');
  assert.equal(gone.panes[1].w, 1000 - 42, 'its neighbour takes all but the rail');
  // The section on the right collapses the same way (Beta + Gamma: minimum 300, so below 165 px).
  const right = resizePair(d, DEF, 0, 300, 700, 536);
  assert.deepEqual(right.panes.map(p => p.collapsed), [false, true]);
  assert.equal(right.panes[0].w, 1000 - 42);
  // In between, the two widths add up to what they had.
  assert.deepEqual(resizePair(d, DEF, 0, 300, 700, 120).panes.map(p => p.w), [420, 580]);
  assert.deepEqual(d, normalizeDock(DEF, null), 'the layout passed in is not changed');
});

test('the last open section cannot collapse', () => {
  const d = normalizeDock(DEF, null);
  const one = setCollapsed(d, DEF, 'p1', true);
  assert.equal(one.refused, undefined);
  assert.deepEqual(one.layout.panes.map(p => p.collapsed), [true, false]);
  const last = setCollapsed(one.layout, DEF, 'p2', true);
  assert.equal(last.refused, true);
  assert.deepEqual(last.layout, one.layout);
  // A tab names the section that holds it, and expanding gives back at least the minimum width.
  assert.deepEqual(setCollapsed(d, DEF, 'c', true).layout.panes.map(p => p.collapsed), [false, true]);
  const narrow = { ...one.layout, panes: one.layout.panes.map(p => (p.id === 'p1' ? { ...p, w: 50 } : p)) };
  assert.deepEqual(setCollapsed(narrow, DEF, 'a', false).layout.panes[0], { id: 'p1', tabs: ['a'], active: 'a', w: 200, collapsed: false });
});

test('a tab dropped on a section\'s right side opens a new section beside it with half its width', () => {
  const { layout, message } = moveTab(normalizeDock(DEF, null), DEF, 'c', { type: 'split', pane: 'p2', side: 'right' });
  assert.deepEqual(tabsOf(layout), [['a'], ['b'], ['c']]);
  assert.deepEqual(layout.panes.map(p => [p.id, p.active, p.w]), [['p1', 'a', 300], ['p2', 'b', 350], ['p3', 'c', 350]]);
  assert.equal(message, 'Gamma opened beside Beta');
  // The left side opens it before the section.
  const left = moveTab(normalizeDock(DEF, null), DEF, 'c', { type: 'split', pane: 'p1', side: 'left' });
  assert.deepEqual(tabsOf(left.layout), [['c'], ['a'], ['b']]);
  assert.equal(left.message, 'Gamma opened beside Alpha');
  // Dropped on a divider, it is a new section there.
  const between = moveTab(normalizeDock(DEF, null), DEF, 'c', { type: 'between', index: 1 });
  assert.deepEqual(tabsOf(between.layout), [['a'], ['c'], ['b']]);
  assert.equal(between.message, 'Gamma opened beside Alpha');
});

test('a tab dropped on another strip joins that section at the drop index', () => {
  const { layout, message } = moveTab(normalizeDock(DEF, null), DEF, 'c', { type: 'tab', pane: 'p1', index: 0 });
  assert.deepEqual(tabsOf(layout), [['c', 'a'], ['b']]);
  assert.equal(layout.panes[0].active, 'c');
  assert.equal(layout.panes[1].active, 'b');
  assert.equal(message, 'Gamma joined the Alpha section');
  // Dropped on a rail, it joins at the end and the section opens.
  const railed = setCollapsed(normalizeDock(DEF, null), DEF, 'p1', true).layout;
  const merged = moveTab(railed, DEF, 'c', { type: 'merge', pane: 'p1' }).layout;
  assert.deepEqual(merged.panes[0], { id: 'p1', tabs: ['a', 'c'], active: 'c', w: 300, collapsed: false });
});

test('a section left without tabs is removed and its width goes to its neighbour', () => {
  const { layout, message } = moveTab(three(), DEF, 'c', { type: 'merge', pane: 'p1' });
  assert.deepEqual(tabsOf(layout), [['a', 'c'], ['b']]);
  assert.deepEqual(layout.panes.map(p => [p.id, p.w]), [['p1', 300], ['p2', 700]]);
  assert.equal(message, 'Gamma joined the Alpha section');
});

test('reordering inside one strip keeps the section', () => {
  const d = normalizeDock(DEF, null);
  const first = moveTab(d, DEF, 'c', { type: 'tab', pane: 'p2', index: 0 });
  assert.deepEqual(tabsOf(first.layout), [['a'], ['c', 'b']]);
  assert.deepEqual(first.layout.panes.map(p => [p.id, p.active, p.w]), [['p1', 'a', 300], ['p2', 'c', 700]]);
  assert.equal(first.message, '');
  assert.deepEqual(tabsOf(moveTab(d, DEF, 'b', { type: 'tab', pane: 'p2', index: 2 }).layout), [['a'], ['c', 'b']], 'past the end');
  // Its own section is no place to drop a tab that is alone in it.
  assert.deepEqual(moveTab(three(), DEF, 'c', { type: 'split', pane: 'p3', side: 'left' }), { layout: three(), message: '' });
});

test('swapPanes moves a section left', () => {
  const d = normalizeDock(DEF, null);
  assert.deepEqual(swapPanes(d, 'p2', -1).panes.map(p => p.id), ['p2', 'p1']);
  assert.deepEqual(swapPanes(three(), 'p3', -1).panes.map(p => p.id), ['p1', 'p3', 'p2']);
  assert.deepEqual(swapPanes(d, 'p1', -1), d, 'the first section stays');
  assert.deepEqual(swapPanes(d, 'p2', 1), d, 'and so does the last');
});

test('toggleMax collapses the others and restores them', () => {
  const start = setCollapsed(three(), DEF, 'p3', true).layout;
  const max = toggleMax(start, 'p2');
  assert.deepEqual(max.panes.map(p => p.collapsed), [true, false, true]);
  assert.deepEqual(max.max, { p1: false, p2: false, p3: true });
  const back = toggleMax(max, 'p2');
  assert.deepEqual(back.panes.map(p => p.collapsed), [false, false, true]);
  assert.equal(back.max, null);
});

test('visibleTabs lists the active tab of each open section', () => {
  assert.deepEqual(visibleTabs(normalizeDock(DEF, null)), ['a', 'b']);
  assert.deepEqual(visibleTabs(setCollapsed(three(), DEF, 'p1', true).layout), ['b', 'c']);
});

test('renderDock draws separators with aria-valuenow, rails for collapsed sections and no grips when locked', () => {
  const tagOf = (html, attr) => html.match(new RegExp(`<[^>]*${attr}[^>]*>`))?.[0] || '';
  const drawn = [];
  const def = { ...DEF, tabs: { ...DEF.tabs, b: { ...DEF.tabs.b, title: 'Beta <b>' } } };
  const html = renderDock('meetings', def, normalizeDock(DEF, null), id => { drawn.push(id); return `<p>${id} body</p>`; }, { before: (p, i) => (i === 1 ? '<header class="head">Head</header>' : '') });
  assert.deepEqual(drawn, ['a', 'b'], 'only the active tab of each section draws');
  assert.match(html, /^<div class="ws-dock" data-page="meetings">/);
  const pane = tagOf(html, 'data-pane="p1"');
  assert.match(pane, /^<section class="ws-pane"/);
  assert.match(pane, /style="flex: 300 1 0px; min-width: 200px"/);
  const split = tagOf(html, 'data-split="0"');
  for (const part of ['class="ws-split"', 'role="separator"', 'aria-orientation="vertical"', 'tabindex="0"', 'aria-valuenow="300"', 'data-page="meetings"']) assert.ok(split.includes(part), `${part} in ${split}`);
  assert.equal(html.match(/role="separator"/g).length, 1, 'one divider between two sections');
  const tab = tagOf(html, 'data-tab="c"');
  for (const part of ['class="ws-dock-tab"', 'role="tab"', 'data-action="dock-tab"', 'data-page="meetings"', 'aria-selected="false"', 'tabindex="-1"']) assert.ok(tab.includes(part), `${part} in ${tab}`);
  assert.ok(tagOf(html, 'data-tab="b"').includes('tabindex="0"'), 'roving tabindex: the active tab is reached by Tab');
  assert.match(html, /role="tablist"/);
  assert.match(html, /Beta &lt;b&gt;/);
  assert.doesNotMatch(html, /Beta <b>/);
  assert.match(html, /<header class="head">Head<\/header><div class="ws-pane-strip">/, 'before() goes above the strip');
  assert.match(html, /ws-dock-grip/);
  // The section menu: move, open beside, maximize, collapse, pin to Today and reset.
  for (const action of ['dock-move', 'dock-beside', 'dock-max', 'dock-collapse', 'dock-pin', 'dock-reset']) assert.match(html, new RegExp(`data-action="${action}"`));
  assert.match(html, /Pin “From your meetings” to Today/);
  // Collapsed: a rail with the section's tabs and no body; locked: no grips.
  const railed = setCollapsed(normalizeDock(DEF, null), DEF, 'p2', true).layout;
  drawn.length = 0;
  const rail = renderDock('meetings', DEF, railed, id => { drawn.push(id); return id; }, { locked: true });
  assert.deepEqual(drawn, ['a']);
  assert.match(rail, /<section class="ws-pane ws-pane-collapsed" data-pane="p2"[^>]*>\s*<div class="ws-pane-rail"/);
  assert.match(rail, /data-action="dock-expand"[^>]*data-tab="c"/);
  assert.ok(tagOf(rail, 'data-split="0"').includes('aria-valuenow="300"'));
  assert.doesNotMatch(rail, /ws-dock-grip/);
});

test('renderDock shows a count on a tab when the page gives one', () => {
  const tabOf = (html, id) => html.match(new RegExp(`<button [^>]*data-tab="${id}"[^]*?</button>`))?.[0] || '';
  const counts = { a: 12, b: 0, c: null };
  const html = renderDock('meetings', DEF, normalizeDock(DEF, null), id => id, { count: id => counts[id] });
  assert.match(tabOf(html, 'a'), /<span>Alpha<\/span><span class="ws-tab-count">12<\/span><\/button>$/);
  assert.doesNotMatch(tabOf(html, 'b'), /ws-tab-count/, 'no count for 0');
  assert.doesNotMatch(tabOf(html, 'c'), /ws-tab-count/, 'no count for none');
  // Without the option, as Inbox and Calendar draw: no counts.
  assert.doesNotMatch(renderDock('meetings', DEF, normalizeDock(DEF, null), id => id), /ws-tab-count/);
});
