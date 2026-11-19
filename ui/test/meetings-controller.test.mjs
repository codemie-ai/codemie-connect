// The Meetings controller with its store, dialogs and navigation faked: opening a meeting from
// anywhere, the Make notes dialog, Side by side and editing a document against its version.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createMeetingsController } from '../workspace/meetings-controller.js';
import { listModel, listOrder, meetingItems, newMeetingsView } from '../workspace/meetings-model.js';
import { newTasksView } from '../workspace/tasks-model.js';
import { buildSnapshot, withMeetings, meetingContract } from './fixtures/workspace-fixture.mjs';

const NOW = Date.UTC(2026, 10, 18, 15, 20);
const snapshot = () => withMeetings(buildSnapshot(NOW, { photo: false, zone: 'UTC' }), NOW);

/** A controller over fakes; `answers` maps an op to what it returns (a function of the data, a
 *  value, or an error to throw). */
function harness({ answers = {}, s = snapshot(), view = {} } = {}) {
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
  });
  const record = id => s.records.find(r => r.kind === 'meeting' && r.id === id);
  return { ctl, state, calls, s, record };
}
const control = (dataset = {}, extra = {}) => ({ dataset, closest: () => null, ...extra });
const form = fields => {
  const f = new FormData();
  for (const [k, v] of Object.entries(fields)) f.append(k, v);
  return f;
};
const failure = (code, message = code) => Object.assign(new Error(message), { code });

test('open() switches the filter so the meeting is visible and sets the tab', async () => {
  const { ctl, state, calls } = harness({ view: { filter: 'ready', q: 'philips' } });
  await ctl.open('mtg-sprint', 'transcript');
  assert.deepEqual([state.meetings.filter, state.meetings.q, state.meetings.selected, state.meetings.tab], ['all', '', 'mtg-sprint', 'transcript']);
  assert.deepEqual(calls.routes.at(-1), ['meetings']);
  // Another meeting without a tab opens on Notes; a meeting without a transcript turns the switch on.
  await ctl.open('mtg-planning');
  assert.deepEqual([state.meetings.filter, state.meetings.showNone, state.meetings.tab], ['all', true, 'notes']);
  // Upcoming meetings live under Upcoming.
  await ctl.open('ev-next');
  assert.equal(state.meetings.filter, 'upcoming');
  // A lane that already shows the meeting stays.
  state.meetings.filter = 'ready';
  await ctl.open('mtg-philips', 'files');
  assert.deepEqual([state.meetings.filter, state.meetings.tab], ['ready', 'files']);
  // The same meeting again without a tab keeps its tab; a task quote lands on its line.
  await ctl.open('mtg-philips');
  assert.equal(state.meetings.tab, 'files');
  await ctl.open('mtg-philips', 'transcript', 3);
  assert.deepEqual([state.meetings.tab, state.meetings.focusLine], ['transcript', 3]);
  // A meeting that is gone says so and leaves the page as it was.
  await ctl.open('gone');
  assert.equal(state.meetings.selected, 'mtg-philips');
  assert.match(calls.toasts.at(-1).message, /no longer/);
});

test('make notes dialog preselects a template without a document when the meeting has some', async () => {
  const s = snapshot();
  const client = meetingContract().rules.noteTemplates.find(t => t.id === 'client');
  s.noteTemplates = [...s.noteTemplates, client];
  const { ctl, calls } = harness({ s });
  // The Philips sync has Meeting notes and Short summary: My client recap is offered first.
  await ctl.handle('meeting-make-notes', control({ id: 'mtg-philips' }));
  const another = calls.modals.at(-1);
  assert.equal(another.title, 'Another summary');
  assert.match(another.body, /name="template" value="client" checked/);
  assert.doesNotMatch(another.body, /value="meeting-notes" checked/);
  assert.match(another.body, /Made · adds version 2/);
  assert.match(another.body, /Your 2 documents stay as they are/);
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

test('side by side hides the list and turning it off restores it', async () => {
  const { ctl, state, calls } = harness({ view: { selected: 'mtg-philips', tab: 'notes', wide: false } });
  await ctl.handle('meeting-compare', control({ v: '1' }));
  assert.deepEqual([state.meetings.compare, state.meetings.wide], [true, true]);
  await ctl.handle('meeting-compare', control({ v: '0' }));
  assert.deepEqual([state.meetings.compare, state.meetings.wide], [false, false]);
  // A list hidden before stays hidden.
  state.meetings.wide = true;
  await ctl.handle('meeting-compare', control({ v: '1' }));
  await ctl.handle('meeting-compare', control({ v: '0' }));
  assert.deepEqual([state.meetings.compare, state.meetings.wide], [false, true]);
  // The list toggle is remembered.
  await ctl.handle('meeting-list-toggle', control());
  assert.equal(state.meetings.wide, false);
  assert.deepEqual(calls.prefs.at(-1), ['codemie.meetings.wide', 'false']);
});

test('doc edit saves with the version it was opened on', async () => {
  const answers = { meeting_read: () => ({ text: '# Notes v1' }) };
  const { ctl, state, calls, record } = harness({ answers, view: { selected: 'mtg-philips', tab: 'notes' } });
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
  assert.equal(toast.action.label, 'Open Settings › Claude');
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

test('a Microsoft sign-in leads to Microsoft and a Claude one to Settings › Claude', async () => {
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
  assert.ok(!ms.calls.routes.some(([, tab]) => tab === 'ai'), 'not Settings › Claude');
  // A Claude sign-in (its class says so) is Settings › Claude.
  const claude = Object.assign(failure('needs_login', 'Claude is not signed in.'), { class: 'needs_login' });
  const c = harnessWithConnect([], { meeting_notes: claude });
  await c.ctl.handle('meeting-retry', control({ id: 'mtg-critique' }));
  assert.equal(c.calls.toasts.at(-1).action.label, 'Open Settings › Claude');
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
  const { ctl, state, calls } = harness({ view: { selected: 'mtg-roadmap', tab: 'notes' } });
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
  const refused = harness({ view: { selected: 'mtg-roadmap', tab: 'notes' }, answers: { meeting_notes: failure('folder_missing') } });
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
  const { ctl, calls } = harness({ view: { selected: 'mtg-philips', tab: 'transcript' } });
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
  const { ctl, calls } = harness({ view: { selected: 'mtg-philips', tab: 'transcript' } });
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
