// The meeting section's pure rules (spec "The strip", "Summary tabs", "The action items column"):
// which summary tabs a meeting shows (its pins, else its own documents, with the fallbacks for a
// deleted template, an off plugin or no document at all), the shown tab, the strip's one primary
// action, the header's "with …" line, an action item's owner line and default ticks, the To
// review / In Tasks split, and the local task target. Checked against the fixture meetings
// (`withMeetings`) through `meetingContext`, as the real page builds it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildSnapshot, withMeetings } from './fixtures/workspace-fixture.mjs';
import { callOfMeeting, meetingItems, rulesOf, tasksByMeeting } from '../workspace/meetings-model.js';
import { meetingContext } from '../workspace/view-meeting-tabs.js';
import { meOf } from '../workspace/tasks-model.js';
import {
  defaultTicks, itemsOf, ownerLine, pinsOf, shortName, shownTab, stripPrimary, summaryTabs, withLine,
} from '../workspace/meeting-view-model.js';
import { activeTaskTarget, addedLine, localTaskTarget, providerTaskTarget } from '../workspace/task-target.js';

const NOW = Date.UTC(2026, 10, 18, 15, 20);
const snapshot = () => withMeetings(buildSnapshot(NOW, { photo: false, zone: 'UTC' }), NOW);

/** One meeting's context, the way the page builds it (`view-meetings.js`'s `pageOf`), without a
 *  DOM: `reads` answers nothing (no transcript read), tasks and rules from the snapshot. */
function mcOf(s, id) {
  const m = meetingItems(s, NOW).find(x => x.id === id);
  return meetingContext({ s, reads: () => ({}), tasksBy: tasksByMeeting(s), rules: rulesOf(s) }, m);
}
const keys = tabs => tabs.map(t => t.key);

test('with nothing pinned the tabs are the documents, main first', () => {
  const s = snapshot();
  const mc = mcOf(s, 'mtg-philips');
  const { tabs, more } = summaryTabs(s, mc);
  assert.deepEqual(keys(tabs), ['doc:meeting-notes', 'doc:short-summary']);
  assert.deepEqual(more, []);
  assert.equal(tabs[0].doc?.id, 'meeting-notes');
  assert.equal(tabs[0].kind, 'doc');
});

test('a meeting without documents gets one tab for the template it would use', () => {
  const s = snapshot();
  const mc = mcOf(s, 'mtg-roadmap');
  const { tabs, more } = summaryTabs(s, mc);
  assert.deepEqual(tabs, [{ key: 'tpl:meeting-notes', label: 'Meeting notes', kind: 'template', templateId: 'meeting-notes', doc: null, pluginId: null, text: null }]);
  assert.deepEqual(more, []);
});

test('pins come first in order, unpinned documents follow, past four under More', () => {
  const s = snapshot();
  s.settings.meetings.summaryTabs = ['short-summary', 'plugin:pod', 'meeting-notes'];
  const meeting = s.records.find(r => r.kind === 'meeting' && r.id === 'mtg-philips');
  const extra = [1, 2, 3, 4, 5].map(n => ({
    id: `extra-${n}`, name: `Extra ${n}`, template: `extra-${n}`, file: `notes.extra-${n}.md`,
    auto: false, createdAt: 0, updatedAt: 0, rev: 1, version: 1, versions: [], wishes: null,
  }));
  meeting.data = { ...meeting.data, docs: [...meeting.data.docs, ...extra] };
  const mc = mcOf(s, 'mtg-philips');
  const plugins = [{ id: 'pod', name: 'Podervianskyi' }];
  const { tabs, more } = summaryTabs(s, mc, { plugins });
  assert.deepEqual(keys(tabs), ['tpl:short-summary', 'plugin:pod', 'tpl:meeting-notes', 'doc:extra-1']);
  assert.ok(more.length > 0, 'the rest sit under More');
  assert.deepEqual(keys(more), ['doc:extra-2', 'doc:extra-3', 'doc:extra-4', 'doc:extra-5']);
});

test('a deleted template or an off plugin is not a tab', () => {
  const s = snapshot();
  s.settings.meetings.summaryTabs = ['deleted-template', 'plugin:off', 'short-summary'];
  const plugins = [{ id: 'on-plugin', name: 'On' }];
  assert.deepEqual(pinsOf(s, plugins), ['short-summary']);
  const mc = mcOf(s, 'mtg-philips');
  const { tabs } = summaryTabs(s, mc, { plugins });
  assert.deepEqual(keys(tabs), ['tpl:short-summary', 'doc:meeting-notes']);
});

test('the shown tab is the chosen one, else the first with a summary', () => {
  const s = snapshot();
  const mc = mcOf(s, 'mtg-philips');
  const { tabs, more } = summaryTabs(s, mc);
  assert.equal(shownTab(tabs, more, 'doc:short-summary').key, 'doc:short-summary');
  assert.equal(shownTab(tabs, more, 'unknown-key').key, 'doc:meeting-notes');
  assert.equal(shownTab(tabs, more, null).key, 'doc:meeting-notes');
});

test('the primary follows the tab', () => {
  const s = snapshot();
  const philips = mcOf(s, 'mtg-philips');
  const docTab = summaryTabs(s, philips).tabs[0];
  assert.deepEqual(stripPrimary(philips, docTab), { kind: 'copy', label: 'Copy' });

  const roadmap = mcOf(s, 'mtg-roadmap');
  const tplTab = summaryTabs(s, roadmap).tabs[0];
  assert.deepEqual(stripPrimary(roadmap, tplTab), { kind: 'make', label: 'Make Meeting notes' });
  assert.deepEqual(stripPrimary(roadmap, tplTab, { runningTemplateId: 'meeting-notes' }), { kind: 'writing', label: 'Writing Meeting notes…' });
  assert.deepEqual(stripPrimary(roadmap, tplTab, { failedTemplateId: 'meeting-notes' }), { kind: 'retry', label: 'Try again' });
  assert.deepEqual(stripPrimary(roadmap, tplTab, { pane: 'transcript' }), { kind: 'none', label: '' });

  // mtg-sprint is still waiting for Teams: no transcript yet, so no "Make" either.
  const sprint = mcOf(s, 'mtg-sprint');
  const sprintTab = summaryTabs(s, sprint).tabs[0];
  assert.deepEqual(stripPrimary(sprint, sprintTab), { kind: 'none', label: '' });

  const pluginTab = { key: 'plugin:pod', label: 'Podervianskyi', kind: 'plugin', templateId: null, doc: null, pluginId: 'pod', text: 'Informal summary' };
  assert.deepEqual(stripPrimary(philips, pluginTab), { kind: 'copy', label: 'Copy' });
  assert.deepEqual(stripPrimary(philips, { ...pluginTab, text: null }), { kind: 'none', label: '' });
});

test('a pinned plugin with minutes is a tab with its text and Copy; without minutes it says so', () => {
  const s = snapshot();
  s.settings.meetings.summaryTabs = ['plugin:pod'];
  const mc = mcOf(s, 'mtg-philips');
  const plugins = [{ id: 'pod', name: 'Podervianskyi' }];
  const call = callOfMeeting(mc.m);
  const withMinutes = [{ plugin: 'pod', pluginName: 'Podervianskyi', call: call.name, header: [], menu: [], minutes: ['Informal summary', 'More'] }];
  const tab = summaryTabs(s, mc, { plugins, slots: withMinutes }).tabs[0];
  assert.equal(tab.key, 'plugin:pod');
  assert.equal(tab.text, 'Informal summary\n\nMore');
  assert.deepEqual(stripPrimary(mc, tab), { kind: 'copy', label: 'Copy' });

  const withoutMinutes = [{ ...withMinutes[0], minutes: [] }];
  const empty = summaryTabs(s, mc, { plugins, slots: withoutMinutes }).tabs[0];
  assert.equal(empty.text, null, 'no minutes: nothing to show or copy');
  assert.deepEqual(stripPrimary(mc, empty), { kind: 'none', label: '' });
});

test('with-line names up to three people, else counts them', () => {
  assert.equal(shortName('Vermeer, Jeroen'), 'Jeroen V.');
  assert.equal(shortName('Anouk de Vries'), 'Anouk V.');
  assert.equal(withLine(['Jeroen Vermeer']), 'with Jeroen V.');
  assert.equal(withLine(['Jeroen Vermeer', 'Anouk de Vries']), 'with Jeroen V. and Anouk V.');
  assert.equal(withLine(['Jeroen Vermeer', 'Anouk de Vries', 'Priya Natarajan']), 'with Jeroen V., Anouk V. and Priya N.');
  assert.equal(withLine(['Jeroen Vermeer', 'Anouk de Vries', 'Priya Natarajan', 'Sam Okafor']), 'with 4 people');
  assert.equal(withLine(['Taylor Morgan', 'Jeroen Vermeer'], 'Taylor Morgan'), 'with Jeroen V.');
  assert.equal(withLine([], 'Taylor Morgan'), '');
});

test('owner lines and default ticks', () => {
  const s = snapshot();
  const mc = mcOf(s, 'mtg-philips');
  const me = meOf(s);
  const endpoint = mc.tasks.find(t => t.id === 'task-endpoint');
  const pilotList = mc.tasks.find(t => t.id === 'task-pilot-list');
  assert.deepEqual(defaultTicks(mc.review, me), ['task-endpoint']);
  assert.equal(ownerLine(endpoint, me, 'UTC'), 'you · no date');
  assert.equal(ownerLine(pilotList, me, 'UTC'), 'Sam O. · not sure of the owner');
});

test('itemsOf splits To review (by transcript line) from the board', () => {
  const s = snapshot();
  const mc = mcOf(s, 'mtg-philips');
  const { toAdd, inTasks } = itemsOf(mc);
  assert.deepEqual(toAdd.map(t => t.id), ['task-endpoint', 'task-pilot-list']);
  assert.deepEqual(inTasks.map(t => t.id), ['task-legal-req']);
});

test('the local task target moves to todo, undoes through one task_withdraw, and reports a failure per task', async () => {
  const calls = [];
  const withdrawn = [];
  const target = localTaskTarget({
    moveTask: async (id, status, opts) => {
      calls.push([id, status, opts]);
      if (id === 'bad') throw new Error('nope');
    },
    withdraw: async ids => { withdrawn.push(ids); return { done: ids.length, failed: 0 }; },
  });
  assert.equal(target.label, 'Tasks');
  const added = await target.add(['task-endpoint', 'bad']);
  assert.deepEqual(added, { done: ['task-endpoint'], failed: [{ id: 'bad', message: 'nope' }] });
  assert.deepEqual(calls[0], ['task-endpoint', 'todo', { log: 'Accepted from review' }]);
  const undone = await target.undo(['task-endpoint']);
  assert.deepEqual(undone, { done: ['task-endpoint'], failed: [] });
  assert.deepEqual(withdrawn, [['task-endpoint']]);
  assert.equal(calls.length, 2, 'Undo moves nothing itself');
});

test('providerTaskTarget labels the column with the provider and undoes with one task_withdraw', async () => {
  const moved = [];
  const withdrawn = [];
  let answer = ids => ({ done: ids.length, failed: 0 });
  const target = providerTaskTarget({
    label: 'Todoist',
    moveTask: async (id, status, opts) => { moved.push([id, status, opts]); },
    withdraw: async ids => { withdrawn.push(ids); return answer(ids); },
  });
  assert.equal(target.label, 'Todoist');
  assert.deepEqual(await target.add(['a', 'b']), { done: ['a', 'b'], failed: [] });
  assert.deepEqual(moved, [['a', 'todo', { log: 'Accepted from review' }], ['b', 'todo', { log: 'Accepted from review' }]]);
  assert.deepEqual(await target.undo(['a', 'b']), { done: ['a', 'b'], failed: [] });
  assert.deepEqual(withdrawn, [['a', 'b']], 'one task_withdraw for the whole add');
  // Native answers counts: with a failure, the snapshot after the call says which went back
  // (in review) and which stayed sent, so exactly those keep Undo.
  answer = () => ({ done: 1, failed: 1 });
  const statuses = { a: 'review', b: 'todo' };
  const sorted = providerTaskTarget({ label: 'Todoist', moveTask: async () => {}, withdraw: async ids => answer(ids), statusOf: id => statuses[id] ?? null });
  const partial = await sorted.undo(['a', 'b']);
  assert.deepEqual(partial.done, ['a']);
  assert.deepEqual(partial.failed, [{ id: 'b', message: '1 of 2 couldn’t go back to review. Try again.' }]);
  // Nothing to undo calls nothing.
  assert.deepEqual(await target.undo([]), { done: [], failed: [] });
  assert.equal(withdrawn.length, 1);
});

test('the active task target follows taskProvider.active, and the add toasts name it', async () => {
  const s = { taskProvider: { active: 'local', name: 'Connect' }, records: [] };
  const withdrawn = [];
  const target = activeTaskTarget({ snap: () => s, moveTask: async () => {}, withdraw: async ids => { withdrawn.push(ids); return { done: ids.length, failed: 0 }; } });
  assert.equal(target.label, 'Tasks');
  assert.equal(addedLine(s, 'Task added to To do.'), 'Task added to To do.');
  s.taskProvider = { active: 'plugin:todoist', name: 'Todoist' };
  assert.equal(target.label, 'Todoist');
  assert.equal(addedLine(s, 'Task added to To do.'), 'Added to Todoist');
  await target.undo(['x']);
  assert.deepEqual(withdrawn, [['x']]);
  s.taskProvider = { active: 'local', name: 'Connect' };
  assert.equal(target.label, 'Tasks', 'back to Local');
});
