// The Automations controller (DESIGN 6.6) with its store, dialogs and navigation faked: Run log
// paging and reloads, Run now, duplicate, delete, save error routing and notification clicks.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createAutomationsController, notificationTarget, runSignature, RUNS_PAGE } from '../workspace/automations-controller.js';
import { newAutomationDraft, draftFromAutomation } from '../workspace/view-automations.js';
import { buildSnapshot, aiStatus, withAutomations, automationContract } from './fixtures/workspace-fixture.mjs';

const NOW = Date.now();
const snapshotOf = () => withAutomations(buildSnapshot(NOW, { photo: false, zone: 'UTC' }), NOW);
const { runsPage } = automationContract();
const [run3, run2] = runsPage.first.runs;
const [run1] = runsPage.next.runs;

/** A controller over fakes. `pages` answer `store.query` in order (an Error is thrown). */
function harness({ snapshot = snapshotOf(), ai = { status: 'ready', ...aiStatus('both') }, pages = [], ensure = async () => 'claude', onMutate } = {}) {
  const calls = { mutate: [], query: [], render: 0, route: [], toasts: [], confirms: [], copied: [], later: [] };
  const state = { route: 'automations', ai, automations: { tab: 'runs', highlight: null, runs: { items: null, next: null, error: '', filter: '', expanded: [], loadingMore: false } } };
  const store = {
    query: async (op, data) => {
      calls.query.push([op, data]);
      const next = pages.shift();
      if (next instanceof Error) throw next;
      return typeof next === 'function' ? next(data) : next;
    },
  };
  const ctl = createAutomationsController({
    state, store, snap: () => snapshot,
    mutate: async (op, data) => {
      calls.mutate.push([op, data]);
      return onMutate ? onMutate(op, data) : { record: { id: data.id || 'auto-new' }, todayCard: false };
    },
    route: async (name, tab) => {
      calls.route.push([name, tab]);
      state.route = name;
      if (tab) state.automations.tab = tab;
    },
    render: async () => { calls.render++; },
    openModal: () => { throw new Error('no dialogs here'); },
    confirmModal: options => { calls.confirms.push(options); },
    toast: (message, tone) => calls.toasts.push([message, tone]),
    ensureClaudeChoice: ensure,
    writeText: async text => { calls.copied.push(text); },
    later: (fn, ms) => calls.later.push([fn, ms]),
  });
  return { ctl, state, calls, snapshot };
}
const control = (dataset = {}, extra = {}) => ({ dataset, closest: () => null, ...extra });

test('the Run log reads pages, the next page, a filter and says when it cannot', async () => {
  const { ctl, state, calls } = harness({ pages: [
    { runs: [run3, run2], next: '1795000400:run-2' },
    { runs: [run1], next: null },
    { runs: [run2, run1], next: null },
    new Error('Workspace storage could not complete the operation.'),
  ] });
  await ctl.loadRuns();
  assert.deepEqual(calls.query[0], ['automation_runs', { automationId: null, limit: RUNS_PAGE }]);
  assert.deepEqual(state.automations.runs.items.map(r => r.id), ['run-3', 'run-2']);
  assert.equal(state.automations.runs.next, '1795000400:run-2');
  // Load older runs: the page after the last one shown, appended.
  await ctl.handle('automation-runs-more', control());
  assert.deepEqual(calls.query[1], ['automation_runs', { automationId: null, limit: RUNS_PAGE, before: '1795000400:run-2' }]);
  assert.deepEqual(state.automations.runs.items.map(r => r.id), ['run-3', 'run-2', 'run-1']);
  assert.equal(state.automations.runs.next, null);
  await ctl.handle('automation-runs-more', control());
  assert.equal(calls.query.length, 2, 'no older page to read');
  // A filter starts again with that automation's runs.
  await ctl.handle('automation-runs-filter', control({}, { value: 'auto-brief' }));
  assert.deepEqual(calls.query[2], ['automation_runs', { automationId: 'auto-brief', limit: RUNS_PAGE }]);
  assert.deepEqual(state.automations.runs.items.map(r => r.id), ['run-2', 'run-1']);
  // A failure is a sentence in the tab, not a thrown error.
  await ctl.handle('automation-runs-refresh', control());
  assert.equal(state.automations.runs.error, 'Workspace storage could not complete the operation.');
  assert.ok(calls.render > 0);
});

test('a later Run log load wins over an earlier one still on its way', async () => {
  const answers = [];
  const { ctl, state } = harness({ pages: [() => new Promise(resolve => answers.push(resolve)), () => new Promise(resolve => answers.push(resolve))] });
  const first = ctl.loadRuns();
  const second = ctl.loadRuns();
  await new Promise(resolve => setTimeout(resolve, 0));
  answers[1]({ runs: [run1], next: null });
  answers[0]({ runs: [run3, run2], next: 'x' });
  await Promise.all([first, second]);
  assert.deepEqual(state.automations.runs.items.map(r => r.id), ['run-1']);
});

test('a new snapshot reloads the Run log only when its runs changed', async () => {
  const { ctl, state, calls, snapshot } = harness({ pages: [{ runs: [run3], next: null }, { runs: [run3, run2], next: null }] });
  await ctl.loadRuns();
  assert.equal(ctl.snapshotChanged(snapshot), undefined, 'same runs, no reload');
  const changed = { ...snapshot, jobs: [...snapshot.jobs, { id: 'job-1', kind: 'automation_run', state: 'running', payload: { automationId: 'auto-brief' } }] };
  assert.notEqual(runSignature(changed), runSignature(snapshot));
  await ctl.snapshotChanged(changed);
  assert.equal(calls.query.length, 2);
  assert.equal(ctl.snapshotChanged(changed), undefined, 'the reload took the new signature');
  state.automations.tab = 'automations';
  assert.equal(ctl.snapshotChanged({ ...changed, jobs: [] }), undefined, 'not on the Run log');
});

test('Run now asks which Claude first when nothing would choose one', async () => {
  const unchosen = { status: 'ready', ...aiStatus('both', { defaultProfile: null }) };
  unchosen.settings.routes = {};
  // Ann's automation has no profile of its own.
  const cancelled = harness({ ai: unchosen, ensure: async () => null });
  assert.equal(await cancelled.ctl.handle('automation-run', control({ id: 'auto-reply' })), false);
  assert.equal(cancelled.calls.mutate.length, 0, 'closing the chooser runs nothing');
  const chosen = harness({ ai: unchosen, ensure: async () => 'claude' });
  await chosen.ctl.handle('automation-run', control({ id: 'auto-reply' }));
  assert.deepEqual(chosen.calls.mutate, [['automation_run_now', { id: 'auto-reply' }]]);
  assert.match(chosen.calls.toasts[0][0], /“Draft replies to Ann” is running\. Its result appears in the Run log and on Today\./);
  // With a default Claude nothing is asked.
  let asked = false;
  const ready = harness({ ensure: async () => { asked = true; return null; } });
  await ready.ctl.handle('automation-run', control({ id: 'auto-reply' }));
  assert.equal(asked, false);
  assert.equal(ready.calls.mutate.length, 1);
  // A failed run's "Choose Claude" asks, then runs again.
  const choose = harness({ ai: unchosen, ensure: async () => 'claude' });
  await choose.ctl.handle('automation-choose', control({ id: 'auto-reply' }));
  assert.deepEqual(choose.calls.mutate, [['automation_run_now', { id: 'auto-reply' }]]);
});

test('Duplicate saves a copy that stays off', async () => {
  const { ctl, calls } = harness();
  await ctl.handle('automation-duplicate', control({ id: 'auto-brief' }));
  const [[op, copy]] = calls.mutate;
  assert.equal(op, 'automation_save');
  assert.equal(copy.id, '');
  assert.equal(copy.name, 'Copy of Morning brief');
  assert.equal(copy.enabled, false);
  assert.deepEqual(copy.trigger, { kind: 'schedule', days: [1, 2, 3, 4, 5], time: '08:45' });
  assert.match(calls.toasts[0][0], /stays off until you turn it on/);
});

test('Delete asks first, then deletes the automation and its runs from the log', async () => {
  const { ctl, state, calls } = harness();
  state.automations.runs.items = [run3, run2, run1];
  await ctl.handle('automation-delete', control({ id: 'auto-brief' }));
  assert.equal(calls.mutate.length, 0, 'nothing is deleted before the answer');
  const [ask] = calls.confirms;
  assert.equal(ask.title, 'Delete “Morning brief”?');
  assert.equal(ask.variant, 'danger');
  assert.equal(ask.initialFocus, 'cancel');
  assert.equal(ask.guard, true);
  await ask.onConfirm();
  assert.deepEqual(calls.mutate, [['automation_delete', { id: 'auto-brief' }]]);
  assert.deepEqual(state.automations.runs.items.map(r => r.id), ['run-3']);
});

test('saving routes a sentence to the field it is about, when that field is shown', async () => {
  const sentence = { code: 'validation', field: 'senders', message: 'Add at least one sender or domain for this trigger.' };
  const fails = err => harness({ onMutate: () => { throw err; } });
  const event = draftFromAutomation(automationContract().automation.event.data);
  assert.deepEqual(await fails(sentence).ctl.save({ ...event, senders: '' }), { error: { field: 'auto-senders', message: sentence.message } });
  // The same sentence about a field the schedule doesn't show goes to the dialog's error line.
  await assert.rejects(fails(sentence).ctl.save(newAutomationDraft()), err => err === sentence);
  const stale = { code: 'stale_view', message: 'Your inbox or calendar updated while this was open.' };
  await assert.rejects(fails(stale).ctl.save(event), err => err === stale);
  // A cap that isn't a number never reaches native.
  const capped = harness();
  assert.deepEqual(await capped.ctl.save({ ...event, profile: 'codemie:prod', cap: 'a lot' }), { error: { field: 'auto-cap', message: 'Enter the cost cap in US dollars, for example 0.50.' } });
  assert.equal(capped.calls.mutate.length, 0);
  // Saved: the record and whether native put the card on Today.
  const saved = harness({ onMutate: (_op, data) => ({ record: { id: 'auto-7', data }, todayCard: true }) });
  const result = await saved.ctl.save(newAutomationDraft());
  assert.equal(result.record.id, 'auto-7');
  assert.equal(result.todayCard, true);
});

test('a notification about a run opens that run in the Run log', async () => {
  assert.deepEqual(notificationTarget({ runId: 'run-2', automationId: 'auto-brief', workspaceId: 'personal' }), { tab: 'runs', filter: 'auto-brief', expanded: ['run-2'] });
  assert.equal(notificationTarget({ itemId: 'm-1' }), null);
  assert.equal(notificationTarget(null), null);
  const { ctl, state, calls } = harness();
  state.route = 'today';
  await ctl.openRun('run-2', 'auto-brief');
  assert.deepEqual(calls.route, [['automations', 'runs']]);
  assert.equal(state.automations.runs.filter, 'auto-brief');
  assert.deepEqual(state.automations.runs.expanded, ['run-2']);
  assert.equal(state.automations.runs.items, null, 'read again for that automation');
});

test('run links open through native by index, and Copy takes the output as text', async () => {
  const { ctl, state, calls } = harness({ pages: [{ opened: true }] });
  state.automations.runs.items = [run1];
  await ctl.handle('run-link', control({ id: 'run-1', link: '0' }));
  assert.deepEqual(calls.query, [['open_source', { kind: 'automation_run', id: 'run-1', link: 0 }]]);
  await ctl.handle('run-copy', control({ id: 'run-1' }));
  assert.match(calls.copied[0], /^2 replies owed\n\n### Replies/);
  await ctl.handle('run-toggle', control({ id: 'run-1' }));
  assert.deepEqual(state.automations.runs.expanded, ['run-1']);
  await ctl.handle('run-toggle', control({ id: 'run-1' }));
  assert.deepEqual(state.automations.runs.expanded, []);
});
