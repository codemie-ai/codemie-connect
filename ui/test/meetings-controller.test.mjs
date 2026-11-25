// The Meetings controller with its store, dialogs and navigation faked: opening a meeting from
// anywhere, the Make notes dialog, Side by side, editing a document against its version, and the
// page's sections (the list's section and the meeting's: its header, strip and panes).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createMeetingsController } from '../workspace/meetings-controller.js';
import { listModel, listOrder, meetingItems, newMeetingsView } from '../workspace/meetings-model.js';
import { legacyMeetingsLayout, meetings, MEETINGS_DOCK } from '../workspace/view-meetings.js';
import { loadDock, moveTab, normalizeDock, paneOf, saveDock, setCollapsed } from '../workspace/dock-model.js';
import { WIDGETS } from '../workspace/view-today.js';
import { newTasksView } from '../workspace/tasks-model.js';
import { activeTaskTarget, providerTaskTarget } from '../workspace/task-target.js';
import { buildSnapshot, withMeetings, meetingContract, meetingFolders } from './fixtures/workspace-fixture.mjs';

const NOW = Date.UTC(2026, 10, 18, 15, 20);
const snapshot = () => withMeetings(buildSnapshot(NOW, { photo: false, zone: 'UTC' }), NOW);

/** The page's sections as app.js keeps them, over `layout`: `collapse` changes it the way the
 *  section controller does; `calls` lists what was collapsed or expanded. */
function fakeDock(layout = normalizeDock(MEETINGS_DOCK, null)) {
  const calls = [];
  const dock = {
    layout: () => layout,
    collapse: async (id, on) => {
      calls.push([id, on]);
      layout = setCollapsed(layout, MEETINGS_DOCK, id, on).layout;
      return true;
    },
  };
  return { dock, calls, get layout() { return layout; } };
}
/** What the controller has read for a meeting: its transcript and documents, as native answers. */
const FOLDERS = meetingFolders(NOW);
const reads = id => ({ transcript: FOLDERS[id] ? { segments: FOLDERS[id].segments } : undefined, docs: Object.fromEntries(Object.entries(FOLDERS[id]?.docs || {}).map(([doc, text]) => [doc, { text }])) });
/** The Meetings page drawn with `layout` as its sections. */
const page = (s, view, layout) => meetings(s, { state: { meetings: { ...newMeetingsView(), ...view }, tasks: newTasksView() }, now: NOW, banners: '', reads, dock: { layouts: { meetings: layout }, locked: false } });
/** One section of a drawn page, from its tag to the next divider. */
const sectionOf = (html, id) => html.match(new RegExp(`<section class="ws-pane[^"]*" data-pane="${id}"[^]*?(?=<div class="ws-split"|$)`))?.[0] || '';

/** A controller over fakes; `answers` maps an op to what it returns (a function of the data, a
 *  value, or an error to throw). */
function harness({ answers = {}, s = snapshot(), view = {}, dock, timer, taskTarget } = {}) {
  const calls = { mutate: [], query: [], render: 0, toasts: [], modals: [], routes: [], focus: [], copied: [], saved: [], prefs: [] };
  const state = { route: 'meetings', meetings: { ...newMeetingsView(), ...view }, tasks: newTasksView() };
  const answer = (op, data) => {
    const a = answers[op];
    if (a instanceof Error) throw a;
    return typeof a === 'function' ? a(data) : a;
  };
  const ctl = createMeetingsController({
    state,
    snap: () => s,
    store: { query: async (op, data) => { calls.query.push([op, data]); return answer(op, data); } },
    mutate: async (op, data) => { calls.mutate.push([op, data]); return answer(op, data) ?? { queued: true, jobId: 'job-1' }; },
    render: async () => { calls.render++; },
    route: async (name, tab) => { calls.routes.push(tab ? [name, tab] : [name]); state.route = name; },
    openModal: options => { calls.modals.push(options); return { querySelector: () => null, close() {} }; },
    confirmModal: options => { calls.modals.push(options); },
    toast: (message, tone, action) => calls.toasts.push({ message, tone, action }),
    writeText: async text => { calls.copied.push(text); },
    downloadText: (name, text) => calls.saved.push([name, text]),
    focus: (selector, opts) => { calls.focus.push(selector); if (opts) calls.focusOpts = opts; },
    setPref: (key, value) => calls.prefs.push([key, value]),
    now: () => NOW,
    ...(dock ? { dock } : {}),
    ...(timer ? { timer } : {}),
    ...(taskTarget ? { taskTarget } : {}),
  });
  const record = id => s.records.find(r => r.kind === 'meeting' && r.id === id);
  return { ctl, state, calls, s, record };
}
const control = (dataset = {}, extra = {}) => ({ dataset, closest: () => null, ...extra });
const taskRecord = (s, id) => s.records.find(r => r.kind === 'commitment' && r.id === id);
const form = fields => {
  const f = new FormData();
  for (const [k, v] of Object.entries(fields)) f.append(k, v);
  return f;
};
const failure = (code, message = code) => Object.assign(new Error(message), { code });

test('open() with no pane uses Open a meeting on; the same meeting keeps its pane; a line opens Transcript', async () => {
  const { ctl, state, calls, s } = harness({ view: { filter: 'ready', q: 'philips' } });
  await ctl.open('mtg-sprint', 'transcript');
  assert.deepEqual([state.meetings.filter, state.meetings.q, state.meetings.selected, state.meetings.pane], ['all', '', 'mtg-sprint', 'transcript']);
  assert.deepEqual(calls.routes.at(-1), ['meetings']);
  // Another meeting without a pane opens on the setting (Summary by default); a meeting without
  // a transcript turns the switch on.
  await ctl.open('mtg-planning');
  assert.deepEqual([state.meetings.filter, state.meetings.showNone, state.meetings.pane], ['all', true, 'summary']);
  s.settings.meetings = { ...s.settings.meetings, openOn: 'notes' };
  // Upcoming meetings live under Upcoming.
  await ctl.open('ev-next');
  assert.deepEqual([state.meetings.filter, state.meetings.pane], ['upcoming', 'notes']);
  // A lane that already shows the meeting stays.
  state.meetings.filter = 'ready';
  await ctl.open('mtg-philips', 'files');
  assert.deepEqual([state.meetings.filter, state.meetings.pane], ['ready', 'files']);
  // The same meeting again without a pane keeps its pane; a task quote lands on its line.
  await ctl.open('mtg-philips');
  assert.equal(state.meetings.pane, 'files');
  await ctl.open('mtg-philips', 'transcript', 3);
  assert.deepEqual([state.meetings.pane, state.meetings.focusLine], ['transcript', 3]);
  // An unknown pane (an old /people link) is the setting.
  await ctl.open('mtg-roadmap', 'people');
  assert.equal(state.meetings.pane, 'notes');
  // Another meeting picked from the list opens on the setting too.
  state.meetings.pane = 'files';
  s.settings.meetings = { ...s.settings.meetings, openOn: 'transcript' };
  await ctl.handle('meeting-select', control({ id: 'mtg-philips' }));
  assert.deepEqual([state.meetings.selected, state.meetings.pane], ['mtg-philips', 'transcript']);
  // A meeting that is gone says so and leaves the page as it was.
  await ctl.open('gone');
  assert.equal(state.meetings.selected, 'mtg-philips');
  assert.match(calls.toasts.at(-1).message, /no longer/);
});

test('ensureSelection() sends a link arrival at /tasks to the summary, focused on the column, with the column on; keeps the Action items pane with it off', () => {
  const { ctl, state, s } = harness({ view: { selected: 'mtg-philips', pane: 'tasks', tasksLink: true } });
  // The Tasks tab is gone (spec ruling 9): with the column on, a `/tasks` arrival (the boot hash
  // parse or open(), both of which set `tasksLink`) means the summary, focused on the column it
  // already shows beside it, not the dedicated pane it used to open.
  ctl.ensureSelection();
  assert.deepEqual([state.meetings.pane, state.meetings.focusColumn], ['summary', true]);
  // tasksLink is one-shot: a later render with nothing newly arrived never re-raises focus.
  state.meetings.pane = 'tasks';
  ctl.ensureSelection();
  assert.deepEqual([state.meetings.pane, state.meetings.focusColumn], ['summary', false]);
  // With the column off, a link arrival still opens the Action items pane as before.
  state.meetings.pane = 'tasks';
  state.meetings.tasksLink = true;
  s.settings.meetings = { ...s.settings.meetings, actionItems: false };
  ctl.ensureSelection();
  assert.deepEqual([state.meetings.pane, state.meetings.focusColumn], ['tasks', false]);
});

test('ensureSelection() still corrects a stray pane left at tasks with the column on, but never steals focus for it: only a link arrival (tasksLink) may raise focusColumn', () => {
  // Nothing in the app leaves `pane` at `tasks` with the column on any more (the Review button is
  // column-off only, and the people popover's task link no longer navigates there), but the
  // normalization stays a safety net — just one that, without `tasksLink`, never takes focus.
  const { ctl, state } = harness({ view: { selected: 'mtg-philips', pane: 'tasks' } });
  ctl.ensureSelection();
  assert.deepEqual([state.meetings.pane, state.meetings.focusColumn], ['summary', false]);
});

test("open() tags an arrival at /tasks as tasksLink, so the next render's redirect may focus the column; a plain re-render of the same meeting never does", async () => {
  const { ctl, state } = harness();
  await ctl.open('mtg-philips', 'tasks');
  assert.equal(state.meetings.tasksLink, true);
  ctl.ensureSelection();
  assert.deepEqual([state.meetings.pane, state.meetings.focusColumn], ['summary', true]);
});

test('meeting-items-focus (the people popover\'s task-count link, column on) focuses the column directly, never touching the pane', async () => {
  const { ctl, state, calls } = harness({ view: { selected: 'mtg-philips', pane: 'notes' } });
  await ctl.handle('meeting-items-focus', control({ id: 'mtg-philips' }));
  assert.equal(state.meetings.pane, 'notes', 'the pane never moved');
  assert.equal(calls.focus.at(-1), '.ws-mtg-items [data-action="meeting-item-add-open"]');
  assert.deepEqual(calls.focusOpts, { scroll: true });
});

test('make notes dialog preselects a template without a document when the meeting has some', async () => {
  const s = snapshot();
  const client = meetingContract().rules.noteTemplates.find(t => t.id === 'client');
  s.noteTemplates = [...s.noteTemplates, client];
  // Formal summary (a built-in) already has a document too, so My client recap is still the
  // first template without one.
  const meeting = s.records.find(r => r.kind === 'meeting' && r.id === 'mtg-philips');
  meeting.data = {
    ...meeting.data,
    docs: [...meeting.data.docs, {
      id: 'formal-summary', name: 'Formal summary', template: 'formal-summary', file: 'notes.formal-summary.md',
      auto: false, createdAt: 0, updatedAt: 0, rev: 1, version: 1, versions: [], wishes: null,
    }],
  };
  const { ctl, calls } = harness({ s });
  // The Philips sync has Meeting notes, Short summary and Formal summary: My client recap is
  // offered first.
  await ctl.handle('meeting-make-notes', control({ id: 'mtg-philips' }));
  const another = calls.modals.at(-1);
  assert.equal(another.title, 'Another summary');
  assert.match(another.body, /name="template" value="client" checked/);
  assert.doesNotMatch(another.body, /value="meeting-notes" checked/);
  assert.match(another.body, /Made · adds version 2/);
  assert.match(another.body, /Your 3 documents stay as they are/);
  assert.doesNotMatch(another.body, /name="remember"/, 'no rule offer once there are documents');
  await another.onSubmit(form({ template: 'client', wishes: '  focus on the pilot ', findTasks: 'on' }));
  assert.deepEqual(calls.mutate.at(-1), ['meeting_notes', { meetingId: 'mtg-philips', templateId: 'client', wishes: 'focus on the pilot', findTasks: true, remember: false }]);
  // A first run preselects the template the meeting would use, and can remember it.
  await ctl.handle('meeting-make-notes', control({ id: 'mtg-roadmap' }));
  const first = calls.modals.at(-1);
  assert.equal(first.title, 'Make notes');
  assert.match(first.body, /name="template" value="meeting-notes" checked/);
  assert.match(first.body, /name="remember"/);
  await first.onSubmit(form({ template: 'short-summary', remember: 'on' }));
  assert.deepEqual(calls.mutate.at(-1), ['meeting_notes', { meetingId: 'mtg-roadmap', templateId: 'short-summary', wishes: '', findTasks: false, remember: true }]);
});

test('one header, above the strip, in the meeting section', () => {
  // Two sections: the list (pinned to Today) and the meeting; the layout is kept under v2.
  assert.equal(MEETINGS_DOCK.version, 2);
  assert.deepEqual(MEETINGS_DOCK.initial, [['mtg-list'], ['mtg-meeting']]);
  assert.deepEqual(Object.entries(MEETINGS_DOCK.tabs).map(([id, t]) => [id, t.title, t.icon, t.min, t.w, t.pin]), [
    ['mtg-list', 'Meetings', 'meetings', 260, 340, 'meetings'], ['mtg-meeting', 'Meeting', 'meetings', 420, 900, undefined],
  ]);
  assert.equal(MEETINGS_DOCK.tabs['mtg-list'].pinTitle, WIDGETS.meetings.title);
  const s = snapshot();
  const layout = normalizeDock(MEETINGS_DOCK, null);
  const [list, meeting] = layout.panes;
  const html = page(s, { selected: 'mtg-philips' }, layout);
  assert.equal((html.match(/<header class="ws-mtg-head">/g) || []).length, 1, 'one header');
  assert.match(sectionOf(html, meeting.id), /<div class="ws-pane-body"[^>]*><section class="ws-mtg-meeting-section" data-meeting="mtg-philips" data-pane="summary"><div class="ws-mtg-meeting"[^>]*>\s*<header class="ws-mtg-head">[^]*?<h2>Philips CodeMie conversations syncup<\/h2>[^]*?<div class="ws-mtg-strip">[^]*?<div class="ws-mtg-body"><div class="ws-mtg-pane[^"]*" role="tabpanel"/);
  assert.doesNotMatch(sectionOf(html, list.id), /ws-mtg-head|ws-mtg-strip/);
  assert.doesNotMatch(html, /class="ws-tab-count"/, 'no tab counts');
  // The list collapsed: the header stays in the meeting section.
  const folded = page(s, { selected: 'mtg-philips' }, setCollapsed(layout, MEETINGS_DOCK, 'mtg-list', true).layout);
  assert.match(sectionOf(folded, meeting.id), /<section class="ws-mtg-meeting-section"[^>]*>[^]*?<header class="ws-mtg-head">[^]*?<div class="ws-mtg-strip">/);
  // Banners sit at the top of the meeting section, above the header.
  const banner = meetings(s, { state: { meetings: { ...newMeetingsView(), selected: 'mtg-philips' }, tasks: newTasksView() }, now: NOW, banners: '<div class="ws-banner">Offline</div>', reads, dock: { layouts: { meetings: layout }, locked: false } });
  assert.match(sectionOf(banner, meeting.id), /<section class="ws-mtg-meeting-section"[^>]*><div class="ws-banner">Offline<\/div><div class="ws-mtg-meeting"/);
});

test('before a transcript the meeting section explains why, with the tasks; the strip holds only ⋯', () => {
  const s = snapshot();
  const layout = normalizeDock(MEETINGS_DOCK, null);
  const html = page(s, { selected: 'mtg-northwind', pane: 'notes' }, layout);
  const section = sectionOf(html, layout.panes[1].id);
  assert.match(section, /class="ws-mtg-panel-alone"[^]*doesn’t share this transcript[^]*aria-label="Action items"/);
  const strip = section.match(/<div class="ws-mtg-strip">[^]*?(?=<div class="ws-mtg-body")/)?.[0] || '';
  assert.match(strip, /data-menu="meeting-mtg-northwind"/);
  assert.doesNotMatch(strip, /role="tablist"|meeting-back|meeting-copy-tab|meeting-make-tab/);
  assert.doesNotMatch(html, /class="ws-tab-count"|Review \d/);
});

test('the list toggle collapses and expands the meeting list section', async () => {
  const d = fakeDock();
  const { ctl, s } = harness({ dock: d.dock, view: { selected: 'mtg-philips' } });
  const toggle = html => html.match(/<button [^>]*data-action="meeting-list-toggle"[^>]*>/)?.[0] || '';
  assert.match(toggle(page(s, { selected: 'mtg-philips' }, d.layout)), /title="Hide the meeting list — more room for notes" aria-label="[^"]*" aria-pressed="true"/);
  await ctl.handle('meeting-list-toggle', control());
  assert.deepEqual(d.calls, [['mtg-list', true]]);
  assert.equal(paneOf(d.layout, 'mtg-list').collapsed, true);
  assert.match(toggle(page(s, { selected: 'mtg-philips' }, d.layout)), /title="Show the meeting list" aria-label="[^"]*" aria-pressed="false"/);
  await ctl.handle('meeting-list-toggle', control());
  assert.deepEqual(d.calls.at(-1), ['mtg-list', false]);
  assert.equal(paneOf(d.layout, 'mtg-list').collapsed, false);
});

test('compare mode collapses the list and gives it back afterwards', async () => {
  const d = fakeDock();
  const { ctl, state, calls } = harness({ dock: d.dock, view: { selected: 'mtg-philips', pane: 'notes' } });
  const listCollapsed = () => paneOf(d.layout, 'mtg-list').collapsed;
  await ctl.handle('meeting-compare', control({ v: '1' }));
  assert.deepEqual([state.meetings.compare, listCollapsed()], [true, true]);
  await ctl.handle('meeting-compare', control({ v: '0' }));
  assert.deepEqual([state.meetings.compare, listCollapsed()], [false, false]);
  // A list collapsed before stays collapsed.
  await d.dock.collapse('mtg-list', true);
  await ctl.handle('meeting-compare', control({ v: '1' }));
  await ctl.handle('meeting-compare', control({ v: '0' }));
  assert.deepEqual([state.meetings.compare, listCollapsed()], [false, true]);
  // Showing the list ends Side by side.
  await ctl.handle('meeting-compare', control({ v: '1' }));
  await ctl.handle('meeting-list-toggle', control());
  assert.deepEqual([state.meetings.compare, listCollapsed()], [false, false]);
  // Picking one document ends it too, and the list comes back.
  await ctl.handle('meeting-compare', control({ v: '1' }));
  await ctl.handle('doc-view', control({ id: 'mtg-philips', doc: 'short-summary' }));
  assert.deepEqual([state.meetings.compare, listCollapsed()], [false, false]);
  // The list sharing the Notes section: Side by side leaves that section open.
  const shared = fakeDock(moveTab(normalizeDock(MEETINGS_DOCK, null), MEETINGS_DOCK, 'mtg-list', { type: 'merge', pane: 'p2' }).layout);
  const h = harness({ dock: shared.dock, view: { selected: 'mtg-philips', pane: 'notes' } });
  await h.ctl.handle('meeting-compare', control({ v: '1' }));
  await h.ctl.handle('meeting-compare', control({ v: '0' }));
  assert.deepEqual(shared.calls, []);
  assert.deepEqual(calls.toasts.concat(h.calls.toasts), []);
});

test('load reads what the pane shows: the summary’s document, the transcript with its glossary, the files', async () => {
  const answers = { meeting_read: data => (data.part === 'transcript' ? { segments: [] } : data.part === 'files' ? { files: [] } : { text: '# Notes' }), meeting_text: { text: '' } };
  const { ctl, calls, state } = harness({ answers, view: { selected: 'mtg-philips', pane: 'summary' } });
  const reads = () => calls.query.filter(([op]) => op === 'meeting_read').map(([, x]) => (x.docId ? `${x.part}:${x.docId}` : x.part));
  await ctl.load();
  assert.deepEqual(reads().sort(), ['doc:meeting-notes', 'transcript'], 'the main document, shown first');
  assert.ok(!calls.query.some(([op]) => op === 'meeting_text'), 'no glossary for the summary');
  assert.ok(calls.render > 0, 'drawn once read');
  // Another summary tab: its document.
  state.meetings.summaryTab = { 'mtg-philips': 'doc:short-summary' };
  await ctl.load();
  assert.deepEqual(reads().sort(), ['doc:meeting-notes', 'doc:short-summary', 'transcript']);
  // The Transcript pane: the glossary; the Files pane: the files.
  state.meetings.pane = 'transcript';
  await ctl.load();
  assert.ok(calls.query.some(([op]) => op === 'meeting_text'), 'the glossary, for the transcript');
  state.meetings.pane = 'files';
  await ctl.load();
  assert.deepEqual(reads().sort(), ['doc:meeting-notes', 'doc:short-summary', 'files', 'transcript']);
});

test('panes: ⋯ opens one, Back and Esc return to the summary, a summary tab shows its document', async () => {
  const answers = { meeting_read: data => ({ text: `# ${data.docId}` }) };
  const timers = [];
  const { ctl, state, calls } = harness({ answers, view: { selected: 'mtg-philips', pane: 'summary' }, timer: (fn, ms) => timers.push([fn, ms]) });
  await ctl.handle('meeting-pane', control({ id: 'mtg-philips', pane: 'transcript' }));
  assert.equal(state.meetings.pane, 'transcript');
  // Esc in a field, or with a menu open, stays; otherwise it goes back to the summary.
  const target = hit => ({ closest: sel => (hit && sel.includes(hit) ? {} : null) });
  assert.equal(await ctl.key({ key: 'Escape', target: target('input') }), false);
  assert.equal(await ctl.key({ key: 'Escape', target: target('details[open]') }), false);
  assert.equal(state.meetings.pane, 'transcript');
  assert.equal(await ctl.key({ key: 'Escape', target: target(null) }), true);
  assert.equal(state.meetings.pane, 'summary');
  assert.equal(await ctl.key({ key: 'Escape', target: target(null) }), false, 'nothing to go back from');
  await ctl.handle('meeting-pane', control({ id: 'mtg-philips', pane: 'files' }));
  await ctl.handle('meeting-back', control({ id: 'mtg-philips' }));
  assert.equal(state.meetings.pane, 'summary');
  // A summary tab: chosen for this meeting, and the summary shows.
  state.meetings.pane = 'notes';
  await ctl.handle('meeting-summary-tab', control({ id: 'mtg-philips', key: 'doc:short-summary' }));
  assert.deepEqual([state.meetings.summaryTab['mtg-philips'], state.meetings.pane], ['doc:short-summary', 'summary']);
  // ←/→ on the tabs move between them.
  const tabs = { closest: sel => (sel.includes('ws-mtg-tabs') ? {} : null) };
  assert.equal(await ctl.key({ key: 'ArrowRight', target: tabs }), true);
  assert.equal(state.meetings.summaryTab['mtg-philips'], 'doc:meeting-notes', 'wraps to the first');
  // Copy: the shown tab's Markdown, "Copied" for 1.5 s.
  await ctl.handle('meeting-copy-tab', control({ id: 'mtg-philips', key: 'doc:short-summary' }));
  assert.deepEqual(calls.copied, ['# short-summary']);
  assert.equal(state.meetings.copied, 'mtg-philips:doc:short-summary');
  assert.equal(timers.at(-1)[1], 1500);
  await timers.at(-1)[0]();
  assert.equal(state.meetings.copied, null);
  // Make: one click, tasks found.
  await ctl.handle('meeting-make-tab', control({ id: 'mtg-philips', template: 'short-summary' }));
  assert.deepEqual(calls.mutate.at(-1), ['meeting_notes', { meetingId: 'mtg-philips', templateId: 'short-summary', wishes: '', findTasks: true, remember: false }]);
  // Edit: the Notes pane with that document in the editor.
  await ctl.handle('meeting-edit-tab', control({ id: 'mtg-philips', doc: 'short-summary' }));
  assert.deepEqual([state.meetings.pane, state.meetings.docView['mtg-philips'], state.meetings.editing?.docId], ['notes', 'short-summary', 'short-summary']);
  assert.equal(calls.focus.at(-1), '#meeting-doc-editor');
});

test('the v1 layout is read once: the list’s width and fold, or the old wide preference', () => {
  const v1 = JSON.stringify({ panes: [{ id: 'p1', tabs: ['mtg-list'], active: 'mtg-list', w: 300, collapsed: false }, { id: 'p2', tabs: ['mtg-notes'], active: 'mtg-notes', w: 760, collapsed: false }, { id: 'p3', tabs: ['mtg-transcript', 'mtg-tasks', 'mtg-files'], active: 'mtg-transcript', w: 520, collapsed: false }], max: null });
  assert.deepEqual(legacyMeetingsLayout(v1, false), { widths: { 'mtg-list': 300 } });
  assert.deepEqual(legacyMeetingsLayout(v1.replace('"collapsed":false', '"collapsed":true'), false), { collapse: ['mtg-list'], widths: { 'mtg-list': 300 } });
  assert.deepEqual(legacyMeetingsLayout(null, true), { collapse: ['mtg-list'] });
  assert.equal(legacyMeetingsLayout(null, false), null);
  assert.equal(legacyMeetingsLayout('{', false), null);
  // Notes beside Transcript, the list at 300 px: two sections, the list at 300 px, nothing written to v1.
  const kept = new Map([['codemie.layout.meetings.v1', v1]]);
  const storage = { getItem: key => (kept.has(key) ? kept.get(key) : null), setItem: (key, value) => kept.set(key, value) };
  const first = loadDock(storage, 'meetings', MEETINGS_DOCK, legacyMeetingsLayout(kept.get('codemie.layout.meetings.v1'), false));
  assert.deepEqual(first.panes.map(p => [p.tabs, p.w, p.collapsed]), [[['mtg-list'], 300, false], [['mtg-meeting'], 900, false]]);
  saveDock(storage, 'meetings', setCollapsed(first, MEETINGS_DOCK, 'mtg-list', true).layout, MEETINGS_DOCK);
  assert.equal(kept.get('codemie.layout.meetings.v1'), v1, 'v1 untouched');
  assert.equal(paneOf(loadDock(storage, 'meetings', MEETINGS_DOCK, { widths: { 'mtg-list': 500 } }), 'mtg-list').collapsed, true, 'v2 wins once kept');
});

test('doc edit saves with the version it was opened on', async () => {
  const answers = { meeting_read: () => ({ text: '# Notes v1' }) };
  const { ctl, state, calls, record } = harness({ answers, view: { selected: 'mtg-philips', pane: 'notes' } });
  const doc = record('mtg-philips').data.docs.find(d => d.id === 'meeting-notes');
  assert.deepEqual([doc.version, doc.rev], [1, 1]);
  await ctl.handle('doc-edit', control({ id: 'mtg-philips', doc: 'meeting-notes' }));
  assert.equal(state.meetings.editing.draft, '# Notes v1');
  assert.deepEqual(calls.focus.at(-1), '#meeting-doc-editor');
  // Meanwhile Claude writes version 2 (another window, a run).
  Object.assign(doc, { version: 2, rev: 2 });
  ctl.input({ id: 'meeting-doc-editor', value: '# Mine' });
  answers.meeting_doc = failure('conflict', 'The notes changed.');
  answers.meeting_read = () => ({ text: '# Newer' });
  await ctl.handle('doc-edit-save', control({ id: 'mtg-philips', doc: 'meeting-notes' }));
  assert.deepEqual(calls.mutate.at(-1), ['meeting_doc', { meetingId: 'mtg-philips', docId: 'meeting-notes', action: 'edit', text: '# Mine', baseVersion: 1, baseRev: 1 }]);
  // Native refused: the newer text is shown, the person's edit stays, nothing is overwritten.
  const { editing } = state.meetings;
  assert.deepEqual([editing.draft, editing.conflict.text, editing.conflict.version, editing.conflict.rev], ['# Mine', '# Newer', 2, 2]);
  assert.equal(calls.mutate.filter(([op]) => op === 'meeting_doc').length, 1);
  // Starting again from the newer text bases the next save on it; the edit is kept to copy from.
  await ctl.handle('doc-edit-rebase', control({ id: 'mtg-philips', doc: 'meeting-notes' }));
  assert.deepEqual([state.meetings.editing.draft, state.meetings.editing.mine, state.meetings.editing.conflict], ['# Newer', '# Mine', null]);
  delete answers.meeting_doc;
  ctl.input({ id: 'meeting-doc-editor', value: '# Newer, with mine' });
  await ctl.handle('doc-edit-save', control({ id: 'mtg-philips', doc: 'meeting-notes' }));
  assert.deepEqual(calls.mutate.at(-1)[1], { meetingId: 'mtg-philips', docId: 'meeting-notes', action: 'edit', text: '# Newer, with mine', baseVersion: 2, baseRev: 2 });
  assert.equal(state.meetings.editing, null);
  assert.match(calls.toasts.at(-1).message, /Saved to notes\.md/);
});

test('needs_choice, blocked transcripts and missing folders lead to the next step', async () => {
  const answers = { meeting_notes: failure('needs_choice', 'Choose which Claude should write for you.') };
  const { ctl, calls } = harness({ answers });
  await ctl.handle('meeting-retry', control({ id: 'mtg-critique' }));
  const toast = calls.toasts.at(-1);
  assert.equal(toast.tone, 'error');
  assert.equal(toast.action.label, 'Open Settings › AI');
  await toast.action.run();
  assert.deepEqual(calls.routes.at(-1), ['settings', 'ai']);
  // Teams blocked the transcript: a ready message for the organizer, copied.
  await ctl.handle('meeting-copy-ask', control({ id: 'mtg-northwind' }));
  assert.match(calls.copied.at(-1), /^Hi Hannah, could you send me the transcript of “Northwind partnership call”/);
  // The folder is gone: Download again.
  await ctl.handle('meeting-download', control({ id: 'mtg-roadmap' }));
  assert.deepEqual(calls.mutate.at(-1), ['meeting_download', { meetingId: 'mtg-roadmap' }]);
});

test('a failed step never ends with a success toast', async () => {
  const successes = calls => calls.toasts.filter(t => t.tone === 'success').map(t => t.message);
  // Make main when the folder is gone: the fix, and no “is now the main notes”.
  let h = harness({ answers: { meeting_doc: failure('folder_missing') } });
  await h.ctl.handle('doc-main', control({ id: 'mtg-philips', doc: 'short-summary' }));
  assert.deepEqual(successes(h.calls), []);
  assert.equal(h.calls.toasts.at(-1).tone, 'error');
  // Check all while Connect may not read transcripts: no “Checking Teams for n transcripts”.
  h = harness({ answers: { meeting_check: failure('permission_required') } });
  await h.ctl.handle('meeting-check-all', control({}));
  assert.deepEqual(successes(h.calls), []);
  assert.equal(h.calls.mutate.filter(([op]) => op === 'meeting_check').length, 1, 'stops at the first failure');
  // Make notes for all with no Claude chosen: no “Making notes for n meetings”, one chooser.
  h = harness({ answers: { meeting_notes: failure('needs_choice') } });
  await h.ctl.handle('meeting-make-all', control({}));
  assert.deepEqual(successes(h.calls), []);
  assert.equal(h.calls.mutate.filter(([op]) => op === 'meeting_notes').length, 1, 'stops at the first failure');
  // The second of three can't be queued: no plain success; the others still are.
  let n = 0;
  h = harness({ answers: { meeting_notes: () => { if (++n === 2) throw failure('folder_missing'); return { queued: true }; } } });
  await h.ctl.handle('meeting-make-all', control({}));
  assert.deepEqual(successes(h.calls), []);
  assert.match(h.calls.toasts.at(-1).message, /^Making notes for 2 of 3 meetings · 1 needs you/);
});

test('a Microsoft sign-in leads to Microsoft and a Claude one to Settings › AI', async () => {
  // needs_login from a meeting operation is the Microsoft account (target()/active_workspace).
  const signedOut = failure('needs_login', 'Connect Microsoft.');
  const connected = [];
  const ms = harnessWithConnect(connected, { meeting_download: signedOut });
  await ms.ctl.handle('meeting-download', control({ id: 'mtg-vendor' }));
  const toast = ms.calls.toasts.at(-1);
  assert.equal(toast.tone, 'error');
  assert.equal(toast.action.label, 'Sign in to Microsoft');
  await toast.action.run();
  assert.deepEqual(connected, [[]], 'Microsoft sign-in, no extra access');
  assert.ok(!ms.calls.routes.some(([, tab]) => tab === 'ai'), 'not Settings › AI');
  // A Claude sign-in (its class says so) is Settings › AI.
  const claude = Object.assign(failure('needs_login', 'Claude is not signed in.'), { class: 'needs_login' });
  const c = harnessWithConnect([], { meeting_notes: claude });
  await c.ctl.handle('meeting-retry', control({ id: 'mtg-critique' }));
  assert.equal(c.calls.toasts.at(-1).action.label, 'Open Settings › AI');
});

test('Cancel on a save says Connect won’t try again by itself; on notes, that nothing changed', async () => {
  const { ctl, calls, s } = harness();
  s.jobs.push({ id: 'job-save', kind: 'transcript_download', state: 'running', payload: { meetingId: 'mtg-release', auto: true } });
  s.jobs.push({ id: 'job-notes', kind: 'meeting_notes', state: 'running', payload: { meetingId: 'mtg-roadmap' } });
  await ctl.handle('meeting-cancel', control({ id: 'job-save' }));
  assert.deepEqual(calls.mutate.at(-1), ['job_cancel', { id: 'job-save' }]);
  assert.match(calls.toasts.at(-1).message, /Stopped saving the transcript\. Connect won’t try again by itself: use Try again when you want it\./);
  await ctl.handle('meeting-cancel', control({ id: 'job-notes' }));
  assert.match(calls.toasts.at(-1).message, /^Stopped\. Nothing in the folder changed\.$/);
});

/** [harness] with a Microsoft sign-in that records what it was asked for. */
function harnessWithConnect(connected, answers) {
  const calls = { mutate: [], toasts: [], routes: [] };
  const state = { route: 'meetings', meetings: { ...newMeetingsView() }, tasks: newTasksView() };
  const s = snapshot();
  const ctl = createMeetingsController({
    state, snap: () => s, store: { query: async () => ({}) },
    mutate: async (op, data) => { calls.mutate.push([op, data]); const a = answers[op]; if (a instanceof Error) throw a; return a ?? { queued: true }; },
    render: async () => {}, route: async (name, tab) => { calls.routes.push([name, tab]); },
    toast: (message, tone, action) => calls.toasts.push({ message, tone, action }),
    connect: async capabilities => { connected.push(capabilities); },
    now: () => NOW,
  });
  return { ctl, calls };
}

test('the Notes tab’s Make notes form keeps what was chosen and typed in the view state until it is sent or the meeting is left', async () => {
  const { ctl, state, calls } = harness({ view: { selected: 'mtg-roadmap', pane: 'notes' } });
  const field = (name, extra) => ({ dataset: { make: 'mtg-roadmap' }, name, closest: () => null, ...extra });
  assert.equal(ctl.input(field('template', { type: 'radio', checked: true, value: 'short-summary' })), true);
  ctl.input(field('wishes', { type: 'textarea', value: 'Only the decisions' }));
  ctl.input(field('findTasks', { type: 'checkbox', checked: false }));
  ctl.input(field('remember', { type: 'checkbox', checked: true }));
  assert.deepEqual(state.meetings.makeForm['mtg-roadmap'], { templateId: 'short-summary', wishes: 'Only the decisions', findTasks: false, remember: true });
  // An unchecked radio (the one left) changes nothing.
  ctl.input(field('template', { type: 'radio', checked: false, value: 'meeting-notes' }));
  assert.equal(state.meetings.makeForm['mtg-roadmap'].templateId, 'short-summary');
  // Sent: queued with those choices, and the form starts afresh next time.
  const f = form({ template: 'short-summary', wishes: 'Only the decisions', remember: 'on' });
  await ctl.submit({ dataset: { form: 'meeting-notes', id: 'mtg-roadmap' } }, f);
  assert.deepEqual(calls.mutate.at(-1), ['meeting_notes', { meetingId: 'mtg-roadmap', templateId: 'short-summary', wishes: 'Only the decisions', findTasks: false, remember: true }]);
  assert.equal(state.meetings.makeForm['mtg-roadmap'], undefined);
  // Left for another meeting: forgotten.
  ctl.input(field('wishes', { type: 'textarea', value: 'Draft' }));
  await ctl.handle('meeting-select', control({ id: 'mtg-release' }));
  assert.equal(state.meetings.makeForm['mtg-roadmap'], undefined);
  // A refused send keeps them to try again.
  const refused = harness({ view: { selected: 'mtg-roadmap', pane: 'notes' }, answers: { meeting_notes: failure('folder_missing') } });
  refused.ctl.input({ dataset: { make: 'mtg-roadmap' }, name: 'wishes', type: 'textarea', value: 'Keep me', closest: () => null });
  await refused.ctl.submit({ dataset: { form: 'meeting-notes', id: 'mtg-roadmap' } }, form({ template: 'meeting-notes', wishes: 'Keep me', findTasks: 'on' }));
  assert.equal(refused.state.meetings.makeForm['mtg-roadmap'].wishes, 'Keep me');
});

test('Make notes for all and Check all go on past one meeting’s problem and stop at one that would repeat', async () => {
  const tried = (calls, op) => calls.mutate.filter(([o]) => o === op).map(([, d]) => d.meetingId);
  // A missing folder: the others are still queued, and the summary says which one needs you.
  let h = harness({ answers: { meeting_notes: d => { if (d.meetingId === 'mtg-roadmap') throw failure('folder_missing', 'The meeting folder was moved or deleted.'); return { queued: true }; } } });
  await h.ctl.handle('meeting-make-all', control({}));
  assert.equal(tried(h.calls, 'meeting_notes').length, 3, 'every meeting was tried');
  let summary = h.calls.toasts.at(-1);
  assert.equal(summary.message, 'Making notes for 2 of 3 meetings · 1 needs you: “Roadmap review” (its folder is gone).');
  assert.equal(summary.tone, 'info');
  assert.equal(summary.action.label, 'Open it');
  await summary.action.run();
  assert.equal(h.state.meetings.selected, 'mtg-roadmap');
  // None could be queued: an error, still naming them, the first one opens.
  h = harness({ answers: { meeting_notes: failure('transcript_missing', 'Teams no longer has this transcript.') } });
  await h.ctl.handle('meeting-make-all', control({}));
  assert.equal(tried(h.calls, 'meeting_notes').length, 3);
  summary = h.calls.toasts.at(-1);
  assert.match(summary.message, /^No notes were started · 3 meetings need you: “[^”]+”, “[^”]+”, “[^”]+” \(Teams no longer has the transcript\)\.$/);
  assert.equal(summary.tone, 'error');
  assert.equal(summary.action.label, 'Open the first');
  // Signed out would repeat for every meeting: one try and its fix, with what was queued before.
  let n = 0;
  h = harness({ answers: { meeting_notes: () => { if (++n === 2) throw failure('needs_login', 'Connect Microsoft.'); return { queued: true }; } } });
  await h.ctl.handle('meeting-make-all', control({}));
  assert.equal(tried(h.calls, 'meeting_notes').length, 2);
  assert.ok(h.calls.toasts.some(t => t.action?.label === 'Sign in to Microsoft'), 'its fix');
  assert.equal(h.calls.toasts.at(-1).message, 'Making notes for 1 of 3 meetings. The others wait until that’s fixed.');
  // Check all: the same rules.
  const s = snapshot();
  s.records.find(r => r.kind === 'meeting' && r.id === 'mtg-release').data.state = 'pending';
  h = harness({ s, answers: { meeting_check: d => { if (d.meetingId === 'mtg-release') throw failure('transcript_blocked', 'Teams didn’t return this meeting.'); return { queued: true }; } } });
  await h.ctl.handle('meeting-check-all', control({}));
  const checked = tried(h.calls, 'meeting_check');
  const waiting = meetingItems(s, NOW).filter(m => m.state === 'pending' && !m.run).map(m => m.id);
  assert.deepEqual(checked, waiting, 'every waiting meeting was checked');
  assert.ok(checked.indexOf('mtg-release') < checked.length - 1, `it went on past the blocked one: ${checked.join()}`);
  assert.equal(h.calls.toasts.at(-1).message, `Checking Teams for ${checked.length - 1} of ${checked.length} transcripts · 1 needs you: “Release 2.4 go/no-go” (its organizer’s Teams doesn’t share it).`);
  h = harness({ s, answers: { meeting_check: failure('offline', 'Microsoft can’t be reached.') } });
  await h.ctl.handle('meeting-check-all', control({}));
  assert.equal(tried(h.calls, 'meeting_check').length, 1, 'offline would repeat');
});

test('naming a speaker says who the voice was, by the name the transcript shows', async () => {
  const { ctl, calls } = harness();
  await ctl.handle('meeting-speaker', control({ id: 'mtg-philips', voice: '@1', name: 'Speaker 1' }, { value: 'jordan.lee@example.test', selectedOptions: [{ textContent: 'Jordan Lee' }] }));
  assert.deepEqual(calls.mutate.at(-1), ['meeting_speakers', { meetingId: 'mtg-philips', voice: '@1', address: 'jordan.lee@example.test' }]);
  assert.equal(calls.toasts.at(-1).message, 'Speaker 1 is Jordan Lee');
  // Without the shown name, a Teams voice id still reads as a speaker.
  await ctl.handle('meeting-speaker', control({ id: 'mtg-philips', voice: '@2' }, { value: 'sam@example.test', selectedOptions: [{ textContent: 'Sam Okafor' }] }));
  assert.equal(calls.toasts.at(-1).message, 'Speaker 2 is Sam Okafor');
});

test('Delete and Use this version say which version was shown, so a newer one is never lost', async () => {
  const { ctl, calls, record } = harness();
  const shown = id => record('mtg-philips').data.docs.find(d => d.id === id);
  const summary = { ...shown('short-summary') };
  await ctl.handle('doc-delete', control({ id: 'mtg-philips', doc: 'short-summary' }));
  // A run made a new version while the dialog was open: the delete still names the one shown.
  shown('short-summary').version += 1;
  shown('short-summary').rev += 1;
  await calls.modals.at(-1).onConfirm();
  assert.deepEqual(calls.mutate.at(-1), ['meeting_doc', { meetingId: 'mtg-philips', docId: 'short-summary', action: 'delete', baseVersion: summary.version, baseRev: summary.rev }]);
  const notes = shown('meeting-notes');
  await ctl.handle('doc-use-version', control({ id: 'mtg-philips', doc: 'meeting-notes', version: '1' }));
  assert.deepEqual(calls.mutate.at(-1), ['meeting_doc', { meetingId: 'mtg-philips', docId: 'meeting-notes', action: 'version', version: 1, baseVersion: notes.version, baseRev: notes.rev }]);
});

// ---------------------------------------------------------------- the calmer list: hiding and folding

const HIDDEN_KEY = 'codemie.meetings.hidden';
const lastPref = calls => JSON.parse(calls.prefs.filter(([k]) => k === HIDDEN_KEY).at(-1)?.[1] || 'null');
const withSeries = (s, ids, series = 'series-review') => {
  for (const id of ids) s.records.find(r => r.kind === 'event' && r.id === id).data.seriesId = series;
  return s;
};

test('hide saves the preference and Undo brings it back', async () => {
  const { ctl, state, calls } = harness({ view: { selected: 'mtg-philips' } });
  await ctl.handle('meeting-hide', control({ id: 'mtg-roadmap' }));
  assert.deepEqual(lastPref(calls), { ids: ['mtg-roadmap'], series: [] });
  assert.deepEqual(state.meetings.hidden.ids, ['mtg-roadmap']);
  const t = calls.toasts.at(-1);
  assert.match(t.message, /Roadmap review/);
  assert.equal(t.action?.label, 'Undo');
  await t.action.run();
  assert.deepEqual(lastPref(calls), { ids: [], series: [] });
  assert.deepEqual(state.meetings.hidden.ids, []);
});

test('hide every in a series, and show again takes the id and its series', async () => {
  const s = withSeries(snapshot(), ['mtg-roadmap', 'mtg-critique']);
  const { ctl, state, calls } = harness({ s, view: { selected: 'mtg-philips' } });
  await ctl.handle('meeting-hide-series', control({ id: 'mtg-roadmap' }));
  assert.deepEqual(lastPref(calls), { ids: [], series: ['series-review'] });
  assert.match(calls.toasts.at(-1).message, /Every “Roadmap review” is hidden/);
  await ctl.handle('meeting-hide', control({ id: 'mtg-critique' }));
  await ctl.handle('meeting-unhide', control({ id: 'mtg-critique' }));
  assert.deepEqual(state.meetings.hidden, { ids: [], series: [] }, 'both the id and its series');
  assert.deepEqual(lastPref(calls), { ids: [], series: [] });
});

test('hiding the selected meeting opens the next visible one', async () => {
  const { ctl, state, s } = harness({ view: { selected: 'mtg-release' } });
  const order = listOrder(listModel(s, state.meetings, { now: NOW, zone: 'UTC' }), state.meetings);
  const at = order.indexOf('mtg-release');
  await ctl.handle('meeting-hide', control({ id: 'mtg-release' }));
  assert.equal(state.meetings.selected, order[at + 1]);
  // The last one: the one before it.
  const last = listOrder(listModel(s, state.meetings, { now: NOW, zone: 'UTC' }), state.meetings);
  state.meetings.selected = last.at(-1);
  await ctl.handle('meeting-hide', control({ id: last.at(-1) }));
  assert.equal(state.meetings.selected, last.at(-2));
  // Shown greyed: the selection stays.
  state.meetings.showHidden = true;
  const keep = state.meetings.selected;
  await ctl.handle('meeting-hide', control({ id: keep }));
  assert.equal(state.meetings.selected, keep);
});

test('a day folds; alt keeps only that day open; fold all and unfold all', async () => {
  const { ctl, state, s } = harness({ view: { selected: 'mtg-philips' } });
  const keys = listModel(s, state.meetings, { now: NOW, zone: 'UTC' }).days.map(d => d.key);
  assert.ok(keys.length >= 2, keys.join());
  await ctl.handle('meeting-day-fold', control({ day: keys[0] }));
  assert.deepEqual(state.meetings.folded, { [keys[0]]: true });
  await ctl.handle('meeting-day-fold', control({ day: keys[0] }));
  assert.deepEqual(state.meetings.folded, {});
  await ctl.handle('meeting-day-fold', control({ day: keys[1] }), { alt: true });
  assert.deepEqual(Object.keys(state.meetings.folded).sort(), keys.filter(k => k !== keys[1]).sort());
  await ctl.handle('meeting-unfold-all', control());
  assert.deepEqual(state.meetings.folded, {});
  await ctl.handle('meeting-fold-all', control());
  assert.deepEqual(Object.keys(state.meetings.folded).sort(), [...keys].sort());
  await ctl.handle('meeting-needs-fold', control());
  assert.equal(state.meetings.needsFolded, true);
});

test('the filter menu keeps the selection visible; the switches toggle', async () => {
  const { ctl, state } = harness({ view: { selected: 'mtg-roadmap' } });
  await ctl.handle('meeting-filter', control({ filter: 'ready' }));
  assert.equal(state.meetings.filter, 'ready');
  assert.equal(state.meetings.selected, 'mtg-philips');
  await ctl.handle('meeting-filter', control({ filter: 'needs' }));
  assert.ok(['mtg-release', 'mtg-vendor', 'mtg-northwind', 'mtg-roadmap', 'mtg-critique'].includes(state.meetings.selected));
  await ctl.handle('meeting-show-none', control());
  assert.equal(state.meetings.showNone, true);
  await ctl.handle('meeting-show-none', control());
  assert.equal(state.meetings.showNone, false);
  await ctl.handle('meeting-show-hidden', control());
  assert.equal(state.meetings.showHidden, true);
  await ctl.handle('meeting-search-open', control());
  assert.equal(state.meetings.searchOpen, true);
});

test('contextMenu opens the row menu and Escape closes it', async () => {
  const { ctl, state, calls } = harness({ view: { selected: 'mtg-philips' } });
  await ctl.contextMenu('mtg-roadmap', 40, 120);
  assert.deepEqual(state.meetings.rowMenu, { id: 'mtg-roadmap', x: 40, y: 120 });
  assert.ok(calls.render > 0);
  assert.equal(await ctl.key({ key: 'Escape', target: { closest: () => null } }), true);
  assert.equal(state.meetings.rowMenu, null);
  await ctl.contextMenu('mtg-roadmap', 40, 120);
  await ctl.handle('meeting-hide', control({ id: 'mtg-roadmap' }));
  assert.equal(state.meetings.rowMenu, null, 'any menu action closes it');
});

test('↑/↓ skips folded days and hidden meetings', async () => {
  const { ctl, state, s } = harness({ view: { selected: null } });
  const model = listModel(s, state.meetings, { now: NOW, zone: 'UTC' });
  const lastNeed = model.needs.at(-1).id;
  state.meetings.selected = lastNeed;
  state.meetings.folded = { [model.days[0].key]: true };
  await ctl.key({ key: 'ArrowDown', target: { closest: () => null } });
  assert.equal(state.meetings.selected, model.days[1].items[0].id, 'past the folded day');
  state.meetings.hidden = { ids: [model.days[1].items[0].id], series: [] };
  state.meetings.selected = lastNeed;
  await ctl.key({ key: 'ArrowDown', target: { closest: () => null } });
  assert.notEqual(state.meetings.selected, model.days[1].items[0].id, 'past the hidden one');
});

test('Make notes for all leaves hidden meetings alone', async () => {
  const { ctl, calls } = harness({ view: { selected: 'mtg-philips', hidden: { ids: ['mtg-roadmap'], series: [] } } });
  await ctl.handle('meeting-make-all', control());
  const made = calls.mutate.filter(([op]) => op === 'meeting_notes').map(([, d]) => d.meetingId).sort();
  assert.deepEqual(made, ['mtg-release', 'mtg-vendor']);
});

test('/ opens the search field, not while typing', async () => {
  const { ctl, state, calls } = harness({ view: { selected: 'mtg-philips' } });
  assert.equal(await ctl.key({ key: '/', target: { closest: sel => (sel.includes('input') ? { tagName: 'INPUT' } : null) } }), false);
  assert.equal(state.meetings.searchOpen, false);
  assert.equal(await ctl.key({ key: '/', target: { closest: () => null } }), true);
  assert.equal(state.meetings.searchOpen, true);
  assert.deepEqual(calls.focus.at(-1), '#meetings-search');
});

test('"Who is this?" on an unnamed line goes to that voice in the transcript\'s speaker list', async () => {
  const { ctl, calls } = harness({ view: { selected: 'mtg-philips', pane: 'transcript' } });
  await ctl.handle('meeting-name-speaker', control({ voice: '@1' }));
  assert.equal(calls.focus.at(-1), 'select[data-action="meeting-speaker"][data-voice="@1"]');
});

test('Make notes for all takes the card’s meetings: a search narrows both the label and the run', async () => {
  const { ctl, calls } = harness({ view: { selected: 'mtg-philips', q: 're' } });
  await ctl.handle('meeting-make-all', control());
  const made = calls.mutate.filter(([op]) => op === 'meeting_notes').map(([, d]) => d.meetingId).sort();
  assert.deepEqual(made, ['mtg-release', 'mtg-roadmap'], 'Vendor onboarding is not on screen');
});

test('"Who is this?" scrolls the speaker list into view', async () => {
  const { ctl, calls } = harness({ view: { selected: 'mtg-philips', pane: 'transcript' } });
  await ctl.handle('meeting-name-speaker', control({ voice: '@1' }));
  assert.deepEqual(calls.focusOpts, { scroll: true });
});

// ---------------------------------------------------------------- polish after the review

test('hiding the open meeting clears its transcript filters for the next one, and Undo too', async () => {
  const filters = { tq: 'pilot', speaker: 'sam@example.test', focusLine: 3, peopleAll: 'mtg-release' };
  const { ctl, state, calls } = harness({ view: { selected: 'mtg-release', ...filters } });
  await ctl.handle('meeting-hide', control({ id: 'mtg-release' }));
  assert.notEqual(state.meetings.selected, 'mtg-release');
  assert.deepEqual([state.meetings.tq, state.meetings.speaker, state.meetings.focusLine, state.meetings.peopleAll], ['', '', null, null]);
  Object.assign(state.meetings, filters);
  await calls.toasts.at(-1).action.run();
  assert.equal(state.meetings.selected, 'mtg-release');
  assert.deepEqual([state.meetings.tq, state.meetings.speaker, state.meetings.focusLine, state.meetings.peopleAll], ['', '', null, null]);
});

test('Undo on an earlier hide keeps the later ones', async () => {
  const s = withSeries(snapshot(), ['mtg-roadmap', 'mtg-critique']);
  const { ctl, state, calls } = harness({ s, view: { selected: 'mtg-philips' } });
  await ctl.handle('meeting-hide', control({ id: 'mtg-vendor' }));
  const undoVendor = calls.toasts.at(-1).action;
  await ctl.handle('meeting-hide-series', control({ id: 'mtg-roadmap' }));
  const undoSeries = calls.toasts.at(-1).action;
  await ctl.handle('meeting-hide', control({ id: 'mtg-northwind' }));
  await undoVendor.run();
  assert.deepEqual(state.meetings.hidden, { ids: ['mtg-northwind'], series: ['series-review'] });
  await undoSeries.run();
  assert.deepEqual(state.meetings.hidden, { ids: ['mtg-northwind'], series: [] });
  assert.deepEqual(lastPref(calls), { ids: ['mtg-northwind'], series: [] });
});

test('↑/↓ from a meeting inside a folded day goes on from where it sits', async () => {
  const { ctl, state, s } = harness({ view: { selected: null } });
  const model = listModel(s, state.meetings, { now: NOW, zone: 'UTC' });
  const [first, second] = model.days;
  state.meetings.selected = first.items[0].id;
  state.meetings.folded = { [first.key]: true };
  await ctl.key({ key: 'ArrowDown', target: { closest: () => null } });
  assert.equal(state.meetings.selected, second.items[0].id, 'the next row after the folded day');
  state.meetings.selected = first.items[0].id;
  await ctl.key({ key: 'ArrowUp', target: { closest: () => null } });
  assert.equal(state.meetings.selected, model.needs.at(-1).id, 'the row above the folded day');
});

test('opening a meeting unfolds the day or the card that holds it', async () => {
  const { ctl, state, s } = harness({ view: { selected: 'mtg-roadmap' } });
  const day = listModel(s, state.meetings, { now: NOW, zone: 'UTC' }).days.find(d => d.items.some(m => m.id === 'mtg-philips')).key;
  state.meetings.folded = { [day]: true, other: true };
  await ctl.open('mtg-philips');
  assert.deepEqual(state.meetings.folded, { other: true });
  state.meetings.needsFolded = true;
  await ctl.open('mtg-critique');
  assert.equal(state.meetings.needsFolded, false);
});

test('"+n more" keeps the people list open', async () => {
  const { ctl, state } = harness({ view: { selected: 'mtg-philips' } });
  let closed = false;
  await ctl.handle('meeting-people-all', control({ id: 'mtg-philips' }, { closest: () => ({ removeAttribute: () => { closed = true; } }) }));
  assert.equal(state.meetings.peopleAll, 'mtg-philips');
  assert.equal(closed, false);
});

// ---------------------------------------------------------------- the action items column

test('Add moves the ticked tasks once, even on a double click; Undo moves only those back', async () => {
  const calls = [];
  const taskTarget = {
    label: 'Tasks',
    add: async ids => { calls.push(['add', ids]); return { done: [...ids], failed: [] }; },
    undo: async ids => { calls.push(['undo', ids]); return { done: [...ids], failed: [] }; },
  };
  const { ctl, state, s } = harness({ taskTarget });
  // mtg-philips: task-endpoint (mine, sure) ticks itself; task-pilot-list (Sam's) doesn't.
  const [p1, p2] = [ctl.handle('meeting-items-add', control({ id: 'mtg-philips' })), ctl.handle('meeting-items-add', control({ id: 'mtg-philips' }))];
  await Promise.all([p1, p2]);
  assert.deepEqual(calls.filter(c => c[0] === 'add'), [['add', ['task-endpoint']]], 'one add, even from a double click');
  assert.deepEqual(state.meetings.added, { meetingId: 'mtg-philips', ids: ['task-endpoint'] });
  taskRecord(s, 'task-endpoint').data.status = 'todo'; // where the add put it
  await ctl.handle('meeting-items-undo', control({ id: 'mtg-philips' }));
  assert.deepEqual(calls.filter(c => c[0] === 'undo'), [['undo', ['task-endpoint']]]);
  assert.equal(state.meetings.added, null);
  assert.deepEqual(state.meetings.ticked['mtg-philips'], ['task-endpoint'], 'the tick comes back');
});

test('a re-render keeps ticks; a task that left review leaves the ticks', async () => {
  const s = snapshot();
  // A third review task ("Review Focus 3"), Sam's: it starts unticked, like task-pilot-list.
  s.records.push({
    id: 'task-focus-3', kind: 'commitment', source: 'claude',
    data: { text: 'Review Focus 3', owner: 'sam.okafor@example.test', ownerName: 'Sam Okafor', status: 'review', meetingId: 'mtg-philips', line: 10 },
    connectionId: 'fixture-account', workspaceId: null, revision: 'r-task-focus-3', updatedAt: NOW - 100,
  });
  const { ctl, state } = harness({ s });
  await ctl.handle('meeting-item-tick', control({ id: 'mtg-philips', task: 'task-focus-3' }, { checked: true }));
  assert.deepEqual(state.meetings.ticked['mtg-philips'].sort(), ['task-endpoint', 'task-focus-3']);
  // A re-render (another action touching the column) keeps both ticks.
  await ctl.handle('meeting-item-open', control({ id: 'mtg-philips', task: 'task-endpoint' }));
  assert.deepEqual(state.meetings.ticked['mtg-philips'].sort(), ['task-endpoint', 'task-focus-3']);
  // task-focus-3 leaves To review: the next time the column's ticks are read, it drops out.
  s.records.find(r => r.id === 'task-focus-3').data.status = 'todo';
  await ctl.handle('meeting-item-tick', control({ id: 'mtg-philips', task: 'task-pilot-list' }, { checked: true }));
  assert.deepEqual(state.meetings.ticked['mtg-philips'].sort(), ['task-endpoint', 'task-pilot-list']);
});

test('a failed add keeps the row ticked and shows why', async () => {
  const taskTarget = {
    label: 'Tasks',
    add: async ids => ({ done: [], failed: ids.map(id => ({ id, message: 'Todoist is unreachable.' })) }),
    undo: async () => ({ done: [], failed: [] }),
  };
  const { ctl, state } = harness({ taskTarget });
  await ctl.handle('meeting-items-add', control({ id: 'mtg-philips' }));
  assert.deepEqual(state.meetings.ticked['mtg-philips'], ['task-endpoint']);
  assert.deepEqual(state.meetings.addError, { meetingId: 'mtg-philips', message: 'Todoist is unreachable.' });
  assert.deepEqual(state.meetings.added, { meetingId: 'mtg-philips', ids: [] });
});

test('a tick made on another task while Add is in flight survives the merge (fix round 1, Review Focus 3)', async () => {
  let resolveAdd;
  const taskTarget = {
    label: 'Tasks',
    add: async ids => new Promise(resolve => { resolveAdd = () => resolve({ done: [...ids], failed: [] }); }),
    undo: async () => ({ done: [], failed: [] }),
  };
  const { ctl, state } = harness({ taskTarget });
  const adding = ctl.handle('meeting-items-add', control({ id: 'mtg-philips' }));
  // While task-endpoint's add is in flight, Sam's row is ticked too.
  await ctl.handle('meeting-item-tick', control({ id: 'mtg-philips', task: 'task-pilot-list' }, { checked: true }));
  assert.deepEqual(state.meetings.ticked['mtg-philips'].sort(), ['task-endpoint', 'task-pilot-list']);
  resolveAdd();
  await adding;
  // task-endpoint is gone (this add moved it); the interleaved tick on task-pilot-list survives.
  assert.deepEqual(state.meetings.ticked['mtg-philips'], ['task-pilot-list']);
  assert.deepEqual(state.meetings.added, { meetingId: 'mtg-philips', ids: ['task-endpoint'] });
});

test('a rejecting task target keeps the ticks, shows the error, and never throws unhandled', async () => {
  const taskTarget = {
    label: 'Tasks',
    add: async () => { throw new Error('Todoist timed out.'); },
    undo: async () => ({ done: [], failed: [] }),
  };
  const { ctl, state } = harness({ taskTarget });
  await assert.doesNotReject(ctl.handle('meeting-items-add', control({ id: 'mtg-philips' })));
  assert.deepEqual(state.meetings.ticked['mtg-philips'], ['task-endpoint']);
  assert.deepEqual(state.meetings.addError, { meetingId: 'mtg-philips', message: 'Todoist timed out.' });
  assert.deepEqual(state.meetings.added, { meetingId: 'mtg-philips', ids: [] });
  // The in-flight guard was released: a retry can run.
  const calls = [];
  taskTarget.add = async ids => { calls.push(ids); return { done: ids, failed: [] }; };
  await ctl.handle('meeting-items-add', control({ id: 'mtg-philips' }));
  assert.deepEqual(calls, [['task-endpoint']]);
});

test('a rejecting Undo keeps "Added · Undo" so it can be tried again, and toasts rather than throwing', async () => {
  const taskTarget = { label: 'Tasks', add: async ids => ({ done: ids, failed: [] }), undo: async () => { throw new Error('Todoist timed out.'); } };
  const { ctl, state, calls, s } = harness({ taskTarget });
  await ctl.handle('meeting-items-add', control({ id: 'mtg-philips' }));
  taskRecord(s, 'task-endpoint').data.status = 'todo';
  const added = state.meetings.added;
  await assert.doesNotReject(ctl.handle('meeting-items-undo', control({ id: 'mtg-philips' })));
  assert.deepEqual(state.meetings.added, added, 'kept, so Undo is still there to retry');
  assert.match(calls.toasts.at(-1).message, /Todoist timed out\./);
});

test('"+ Add" and an open row close when the person leaves the meeting (fix round 1)', async () => {
  const { ctl, state } = harness();
  await ctl.handle('meeting-item-add-open', control({ id: 'mtg-philips' }));
  await ctl.handle('meeting-item-open', control({ id: 'mtg-philips', task: 'task-endpoint' }));
  assert.equal(state.meetings.addOpen, true);
  assert.equal(state.meetings.itemOpen, 'task-endpoint');
  await ctl.handle('meeting-select', control({ id: 'mtg-roadmap' }));
  assert.equal(state.meetings.addOpen, false, 'the next meeting does not inherit the open form');
  assert.equal(state.meetings.itemOpen, null);
  // Opening a meeting from elsewhere (not just the list's selection) resets them too.
  await ctl.handle('meeting-item-add-open', control({ id: 'mtg-roadmap' }));
  assert.equal(state.meetings.addOpen, true);
  await ctl.open('mtg-philips');
  assert.equal(state.meetings.addOpen, false);
});

test('the add error and "Added · Undo" belong to their meeting: leaving it clears them', async () => {
  const taskTarget = {
    label: 'Tasks',
    add: async ids => ({ done: [], failed: ids.map(id => ({ id, message: 'Todoist is unreachable.' })) }),
    undo: async () => ({ done: [], failed: [] }),
  };
  const { ctl, state } = harness({ taskTarget, view: { selected: 'mtg-philips' } });
  await ctl.handle('meeting-items-add', control({ id: 'mtg-philips' }));
  assert.equal(state.meetings.addError?.meetingId, 'mtg-philips');
  await ctl.handle('meeting-select', control({ id: 'mtg-roadmap' }));
  assert.equal(state.meetings.addError, null, 'the next meeting does not show it');
  assert.equal(state.meetings.added, null);
  // A successful add, then leaving: no Undo waits on the way back.
  taskTarget.add = async ids => ({ done: ids, failed: [] });
  await ctl.open('mtg-philips');
  await ctl.handle('meeting-items-add', control({ id: 'mtg-philips' }));
  assert.equal(state.meetings.added?.meetingId, 'mtg-philips');
  await ctl.handle('meeting-select', control({ id: 'mtg-roadmap' }));
  assert.equal(state.meetings.added, null);
});

test('Undo never moves back a task changed since the add (finished on the Tasks page): only those still in To do', async () => {
  const calls = [];
  const taskTarget = {
    label: 'Tasks',
    add: async ids => ({ done: ids, failed: [] }),
    undo: async ids => { calls.push(ids); return { done: ids, failed: [] }; },
  };
  const { ctl, state, s } = harness({ taskTarget });
  await ctl.handle('meeting-item-tick', control({ id: 'mtg-philips', task: 'task-pilot-list' }, { checked: true }));
  await ctl.handle('meeting-items-add', control({ id: 'mtg-philips' }));
  assert.deepEqual([...state.meetings.added.ids].sort(), ['task-endpoint', 'task-pilot-list']);
  taskRecord(s, 'task-endpoint').data.status = 'todo';
  taskRecord(s, 'task-pilot-list').data.status = 'done'; // finished since
  await ctl.handle('meeting-items-undo', control({ id: 'mtg-philips' }));
  assert.deepEqual(calls, [['task-endpoint']], 'the finished task stays done');
  // Nothing left to undo: no undo call at all.
  calls.length = 0;
  state.meetings.added = { meetingId: 'mtg-philips', ids: ['task-pilot-list'] };
  await ctl.handle('meeting-items-undo', control({ id: 'mtg-philips' }));
  assert.deepEqual(calls, []);
  assert.equal(state.meetings.added, null);
});

test('Undo reads the target’s failures: says why, keeps Undo for those, re-ticks only the ones moved back', async () => {
  const taskTarget = {
    label: 'Tasks',
    add: async ids => ({ done: ids, failed: [] }),
    undo: async ids => ({ done: ids.filter(id => id !== 'task-pilot-list'), failed: [{ id: 'task-pilot-list', message: 'This task is no longer there.' }] }),
  };
  const { ctl, state, s } = harness({ taskTarget });
  await ctl.handle('meeting-item-tick', control({ id: 'mtg-philips', task: 'task-pilot-list' }, { checked: true }));
  await ctl.handle('meeting-items-add', control({ id: 'mtg-philips' }));
  taskRecord(s, 'task-endpoint').data.status = 'todo';
  taskRecord(s, 'task-pilot-list').data.status = 'todo';
  state.meetings.ticked['mtg-philips'] = [];
  await ctl.handle('meeting-items-undo', control({ id: 'mtg-philips' }));
  assert.deepEqual(state.meetings.ticked['mtg-philips'], ['task-endpoint'], 'only the moved-back one is ticked again');
  assert.deepEqual(state.meetings.added, { meetingId: 'mtg-philips', ids: ['task-pilot-list'] }, 'Undo stays for the one that failed');
  assert.deepEqual(state.meetings.addError, { meetingId: 'mtg-philips', message: 'This task is no longer there.' });
});

test('the task target’s label is the one the page draws', () => {
  const { ctl } = harness({ taskTarget: { label: 'Todoist', add: async () => ({ done: [], failed: [] }), undo: async () => ({ done: [], failed: [] }) } });
  assert.equal(ctl.taskLabel(), 'Todoist');
  assert.equal(harness().ctl.taskLabel(), 'Tasks');
});

test('a double click on "Add 2 to Todoist" saves each task once; Undo is one task_withdraw', async () => {
  const saves = [];
  const withdrawn = [];
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const taskTarget = providerTaskTarget({
    label: 'Todoist',
    moveTask: async (id, status, opts) => { await gate; saves.push([id, status, opts]); },
    withdraw: async ids => { withdrawn.push(ids); return { done: ids.length, failed: 0 }; },
  });
  const { ctl, state, s } = harness({ taskTarget });
  await ctl.handle('meeting-item-tick', control({ id: 'mtg-philips', task: 'task-pilot-list' }, { checked: true }));
  assert.equal(ctl.taskLabel(), 'Todoist');
  const first = ctl.handle('meeting-items-add', control({ id: 'mtg-philips' }));
  const second = ctl.handle('meeting-items-add', control({ id: 'mtg-philips' }));
  release();
  await Promise.all([first, second]);
  assert.deepEqual(saves.map(([id]) => id).sort(), ['task-endpoint', 'task-pilot-list'], 'each saved once');
  assert.ok(saves.every(([, status, opts]) => status === 'todo' && opts.log === 'Accepted from review'));
  for (const id of ['task-endpoint', 'task-pilot-list']) taskRecord(s, id).data.status = 'todo';
  await ctl.handle('meeting-items-undo', control({ id: 'mtg-philips' }));
  assert.equal(withdrawn.length, 1, 'one task_withdraw');
  assert.deepEqual(withdrawn[0].sort(), ['task-endpoint', 'task-pilot-list']);
  assert.equal(state.meetings.added, null);
});

test('a partial task_withdraw re-ticks exactly the tasks that went back; the one still sent keeps Undo', async () => {
  const s = snapshot();
  s.taskProvider = { active: 'plugin:todoist', name: 'Todoist' };
  for (const r of s.records.filter(x => x.kind === 'commitment')) r.data.provider = 'plugin:todoist';
  const taskTarget = activeTaskTarget({
    snap: () => s,
    moveTask: async id => { taskRecord(s, id).data.status = 'todo'; },
    // Native moved task-endpoint back; task-pilot-list failed and is still in Todoist.
    withdraw: async () => { taskRecord(s, 'task-endpoint').data.status = 'review'; return { done: 1, failed: 1 }; },
  });
  const { ctl, state } = harness({ s, taskTarget });
  await ctl.handle('meeting-item-tick', control({ id: 'mtg-philips', task: 'task-pilot-list' }, { checked: true }));
  await ctl.handle('meeting-items-add', control({ id: 'mtg-philips' }));
  state.meetings.ticked['mtg-philips'] = [];
  await ctl.handle('meeting-items-undo', control({ id: 'mtg-philips' }));
  assert.deepEqual(state.meetings.ticked['mtg-philips'], ['task-endpoint'], 'the one that went back is ticked again');
  assert.deepEqual(state.meetings.added, { meetingId: 'mtg-philips', ids: ['task-pilot-list'] }, 'Undo stays for the one still sent');
  assert.match(state.meetings.addError.message, /1 of 2 couldn’t go back to review/);
});

/** mtg-philips with three more documents: five tabs, the fifth (doc:extra-3) under More ▾. */
function fiveTabs(s) {
  const meeting = s.records.find(r => r.kind === 'meeting' && r.id === 'mtg-philips');
  const extra = [1, 2, 3].map(n => ({
    id: `extra-${n}`, name: `Extra ${n}`, template: `extra-${n}`, file: `notes.extra-${n}.md`,
    auto: false, createdAt: 0, updatedAt: 0, rev: 1, version: 1, versions: [], wishes: null,
  }));
  meeting.data = { ...meeting.data, docs: [...meeting.data.docs, ...extra] };
  return s;
}

test('Esc back from a pane focuses the shown summary tab, or More ▾ when the shown tab sits under it (ruling 18)', async () => {
  const { ctl, state, calls } = harness({ s: fiveTabs(snapshot()), view: { selected: 'mtg-philips', pane: 'transcript' } });
  const outside = { closest: () => null };
  assert.equal(await ctl.key({ key: 'Escape', target: outside }), true);
  assert.equal(state.meetings.pane, 'summary');
  assert.equal(calls.focus.at(-1), '.ws-mtg-tabs [aria-selected="true"]');
  state.meetings.summaryTab = { 'mtg-philips': 'doc:extra-3' };
  state.meetings.pane = 'files';
  await ctl.key({ key: 'Escape', target: outside });
  assert.equal(calls.focus.at(-1), '.ws-mtg-tabs .ws-mtg-more');
  state.meetings.pane = 'files';
  await ctl.handle('meeting-back', control({ id: 'mtg-philips' }));
  assert.equal(calls.focus.at(-1), '.ws-mtg-tabs .ws-mtg-more', 'Back does the same');
});

test('←/→ onto a More tab focuses More ▾ (visible), and ←/→ from More ▾ goes on', async () => {
  const { ctl, state, calls } = harness({ s: fiveTabs(snapshot()), view: { selected: 'mtg-philips', pane: 'summary', summaryTab: { 'mtg-philips': 'doc:extra-2' } } });
  const tab = { closest: sel => (sel.includes('ws-mtg-tabs') && !sel.includes('details') ? {} : null) };
  assert.equal(await ctl.key({ key: 'ArrowRight', target: tab }), true);
  assert.equal(state.meetings.summaryTab['mtg-philips'], 'doc:extra-3');
  assert.equal(calls.focus.at(-1), '.ws-mtg-tabs .ws-mtg-more', 'never the hidden menu item');
  // From More ▾ itself (not a role=tab), the arrows still move.
  const more = { closest: sel => (sel.includes('ws-mtg-more') ? {} : null) };
  assert.equal(await ctl.key({ key: 'ArrowLeft', target: more }), true);
  assert.equal(state.meetings.summaryTab['mtg-philips'], 'doc:extra-2');
  assert.equal(calls.focus.at(-1), '.ws-mtg-tabs [aria-selected="true"]');
  // With the More menu open, the arrows are the menu's.
  const open = { closest: sel => (sel.includes('ws-mtg-more') || sel.includes('details[open]') ? {} : null) };
  assert.equal(await ctl.key({ key: 'ArrowLeft', target: open }), false);
});

test('while a More tab is shown, the first visible tab stays the tablist’s Tab stop', () => {
  const s = fiveTabs(snapshot());
  const html = page(s, { selected: 'mtg-philips', pane: 'summary', summaryTab: { 'mtg-philips': 'doc:extra-3' } }, normalizeDock(MEETINGS_DOCK, null));
  const tabs = [...html.matchAll(/<button type="button" class="ws-mtg-tab" role="tab"[^>]*>/g)].map(m => m[0]);
  assert.equal(tabs.length, 4);
  assert.match(tabs[0], /tabindex="0"/, 'reachable with Tab');
  for (const t of tabs.slice(1)) assert.match(t, /tabindex="-1"/);
  assert.match(html, /<summary class="ws-mtg-tab ws-mtg-more ws-mtg-more-on"/);
  // With a visible tab shown, that tab is the stop, as before.
  const plain = page(s, { selected: 'mtg-philips', pane: 'summary', summaryTab: { 'mtg-philips': 'doc:extra-1' } }, normalizeDock(MEETINGS_DOCK, null));
  const stops = [...plain.matchAll(/<button type="button" class="ws-mtg-tab" role="tab"[^>]*tabindex="0"[^>]*>/g)].map(m => m[0]);
  assert.equal(stops.length, 1);
  assert.match(stops[0], /data-key="doc:extra-1"/);
});
