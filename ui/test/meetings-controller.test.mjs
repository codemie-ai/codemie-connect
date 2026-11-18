// The Meetings controller with its store, dialogs and navigation faked: opening a meeting from
// anywhere, the Make notes dialog, Side by side and editing a document against its version.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createMeetingsController } from '../workspace/meetings-controller.js';
import { newMeetingsView } from '../workspace/meetings-model.js';
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
    focus: selector => calls.focus.push(selector),
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
  // The second of three fails: the toast counts only the first.
  let n = 0;
  h = harness({ answers: { meeting_notes: () => { if (++n === 2) throw failure('folder_missing'); return { queued: true }; } } });
  await h.ctl.handle('meeting-make-all', control({}));
  assert.match(successes(h.calls).join(), /^Making notes for 1 of 3 meetings/);
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
