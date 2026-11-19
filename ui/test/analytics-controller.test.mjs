// The Analytics controller over fakes: which operations each action sends, the refresh and its
// progress events, the refresh on open when the data is old, and the preferences it keeps.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createAnalyticsController } from '../workspace/analytics-controller.js';
import { analyticsView } from '../workspace/view-analytics.js';
import { presetRange, PREFS_KEY, STALE_MS } from '../workspace/analytics-model.js';

const fixture = name => JSON.parse(readFileSync(new URL(`fixtures/contract/${name}`, import.meta.url), 'utf8'));
const status = fixture('analytics-status.json');
const running = fixture('analytics-status-running.json');
const summary = fixture('analytics-summary.json');
const session = fixture('analytics-session.json');
const progress = fixture('analytics-progress.json');
const FRESH = status.lastFetchAt + 60_000;

/** A controller over fakes. `answers` replace an operation's answer (a function gets the data;
 *  an Error is thrown). */
function harness({ answers = {}, now = FRESH, route = 'analytics', saved = null } = {}) {
  const calls = { query: [], render: 0, toasts: [] };
  const handlers = {};
  const store = new Map(saved ? [[PREFS_KEY, JSON.stringify(saved)]] : []);
  const state = { route };
  const defaults = {
    analytics_status: status,
    analytics_view: summary,
    analytics_refresh: { started: true },
    analytics_retry: { started: true },
    analytics_session: session,
    analytics_report: { opened: true },
  };
  const ctl = createAnalyticsController({
    state,
    query: async (op, data) => {
      calls.query.push([op, data]);
      const answer = op in answers ? answers[op] : defaults[op];
      if (answer instanceof Error) throw answer;
      return typeof answer === 'function' ? answer(data) : answer;
    },
    render: async () => { calls.render++; },
    toast: (message, tone) => calls.toasts.push([message, tone]),
    openModal: () => { throw new Error('no dialogs here'); },
    listen: async (name, fn) => { handlers[name] = fn; return () => {}; },
    storage: { getItem: k => store.get(k) ?? null, setItem: (k, v) => store.set(k, v) },
    now: () => now,
    zone: 'UTC',
  });
  const emit = payload => handlers['workspace:analytics']({ event: 'workspace:analytics', payload });
  return { ctl, state, calls, emit, store, html: () => analyticsView(state.analytics, ctl.viewData()) };
}
const control = (value = '', closest = () => null) => ({ dataset: { value }, closest });
const ops = calls => calls.query.map(([op]) => op);
const views = calls => calls.query.filter(([op]) => op === 'analytics_view').map(([, data]) => data);

test('changing the range calls analytics_view with the new from/to once', async () => {
  const { ctl, state, calls, store } = harness();
  await ctl.open();
  assert.deepEqual(ops(calls), ['analytics_status', 'analytics_view']);
  calls.query.length = 0;
  await ctl.handle('analytics-range', control('7d'));
  const { from, to } = presetRange('7d', FRESH, 'UTC');
  assert.deepEqual(views(calls), [{ from, to, compare: true }]);
  assert.equal(calls.query.length, 1);
  assert.equal(state.analytics.range, '7d');
  assert.equal(JSON.parse(store.get(PREFS_KEY)).range, '7d');
  assert.equal(ctl.data.summary, summary);
  // Agent filter: set, then cleared.
  await ctl.handle('analytics-agent', control('claude'));
  await ctl.handle('analytics-agent', control(''));
  assert.deepEqual(views(calls).slice(1), [{ from, to, agent: 'claude', compare: true }, { from, to, compare: true }]);
});

test('refresh calls analytics_refresh and shows progress from workspace:analytics events', async () => {
  // The status says `running` while the fetch runs, as native's does.
  let current = status;
  const { ctl, calls, emit, html } = harness({ answers: { analytics_status: () => current } });
  await ctl.open();
  assert.ok(!ops(calls).includes('analytics_refresh'), 'fresh data is not fetched again on open');
  assert.match(html(), /<button [^>]*data-action="analytics-refresh"(?![^>]*disabled)/);
  await ctl.handle('analytics-refresh', control());
  assert.deepEqual(calls.query.at(-1), ['analytics_refresh', {}]);
  assert.match(html(), /<button [^>]*data-action="analytics-refresh"[^>]*disabled/);
  assert.ok(html().includes('Updating…'));
  current = { ...status, state: 'running', progress: { done: progress.done, total: progress.total, label: progress.label } };
  calls.query.length = 0;
  await emit(progress);
  assert.ok(html().includes(`${progress.done} of ${progress.total} days`));
  // While history is read, the page reads what's stored so far.
  assert.deepEqual(ops(calls), ['analytics_status', 'analytics_view']);
  // The same step again reads nothing more.
  await emit(progress);
  assert.equal(calls.query.length, 2);
  const rendersBefore = calls.render;
  current = status;
  await emit({ ...progress, running: false, done: progress.total });
  assert.ok(calls.render > rendersBefore);
  assert.deepEqual(ops(calls).slice(2), ['analytics_status', 'analytics_view']);
  assert.equal(calls.toasts.length, 1);
  assert.match(html(), /<button [^>]*data-action="analytics-refresh"(?![^>]*disabled)/);
  assert.ok(!html().includes(`${progress.done} of ${progress.total} days`));
  // A refresh already running elsewhere is followed the same way, without a second toast later.
  const other = harness({ answers: { analytics_refresh: { running: true } } });
  await other.ctl.open();
  await other.ctl.handle('analytics-refresh', control());
  assert.match(other.html(), /<button [^>]*data-action="analytics-refresh"[^>]*disabled/);
});

test('a status saying nothing runs ends a refresh whose end event never came', async () => {
  let current = status;
  const refreshOn = /<button [^>]*data-action="analytics-refresh"(?![^>]*disabled)/;
  const refreshOff = /<button [^>]*data-action="analytics-refresh"[^>]*disabled/;
  const { ctl, html } = harness({ answers: { analytics_status: () => current } });
  await ctl.open();
  await ctl.handle('analytics-refresh', control());
  assert.match(html(), refreshOff);
  // The end event is lost; the next status read (the page opened again) says nothing runs.
  await ctl.open();
  assert.match(html(), refreshOn);
  assert.equal(ctl.data.refreshing, false);
  assert.equal(ctl.data.progress, null);
  assert.ok(!html().includes('Checking for new sessions…') && !html().includes('Updating…'));
  // A status read that was on its way before a refresh started can't end that refresh.
  let release;
  current = new Promise(resolve => { release = () => resolve(status); });
  const reopening = ctl.open();
  await ctl.handle('analytics-refresh', control());
  release();
  await reopening;
  assert.equal(ctl.data.refreshing, true);
  assert.match(html(), refreshOff);
});

test('Try again after the status couldn\'t be read reads everything again', async () => {
  let failures = 1;
  const { ctl, calls, html } = harness({
    answers: {
      analytics_status: () => {
        if (failures-- > 0) throw Object.assign(new Error('Workspace storage could not complete the operation.'), { code: 'io' });
        return status;
      },
    },
  });
  await ctl.open();
  assert.equal(ctl.data.status, null);
  assert.ok(html().includes('Workspace storage could not complete the operation.'));
  assert.ok(html().includes('data-action="analytics-reload"'));
  calls.query.length = 0;
  await ctl.handle('analytics-reload', control());
  assert.deepEqual(ops(calls), ['analytics_status', 'analytics_view']);
  assert.equal(ctl.data.status, status);
  assert.equal(ctl.data.error, '');
  assert.ok(html().includes('ws-an-kpis') && !html().includes('analytics-reload'));
});

test('opening the page refreshes on its own when lastFetchAt is older than 15 minutes', async () => {
  const stale = harness({ now: status.lastFetchAt + STALE_MS + 60_000 });
  await stale.ctl.open();
  assert.ok(ops(stale.calls).includes('analytics_refresh'));
  assert.ok(ops(stale.calls).includes('analytics_view'));
  assert.equal(stale.calls.toasts.length, 0, 'a refresh the page started itself says nothing');
  await stale.emit({ ...progress, running: false });
  assert.equal(stale.calls.toasts.length, 0);
  const fresh = harness({ now: status.lastFetchAt + 5 * 60_000 });
  await fresh.ctl.open();
  assert.ok(!ops(fresh.calls).includes('analytics_refresh'));
  // Nothing fetched yet (first open on this Mac): it starts reading.
  const empty = harness({ answers: { analytics_status: { ...status, state: 'empty', sessions: 0, lastFetchAt: null, failedDays: [] } } });
  await empty.ctl.open();
  assert.ok(ops(empty.calls).includes('analytics_refresh'));
  // A fetch already running is followed, not started again.
  const busy = harness({ answers: { analytics_status: running } });
  await busy.ctl.open();
  assert.ok(!ops(busy.calls).includes('analytics_refresh'));
});

test('needs_cli reads nothing else and fetches nothing', async () => {
  const { ctl, calls, html } = harness({ answers: { analytics_status: { ...status, state: 'needs_cli' } }, now: status.lastFetchAt + STALE_MS * 4 });
  await ctl.open();
  assert.deepEqual(ops(calls), ['analytics_status']);
  assert.ok(html().includes('Analytics needs a newer CodeMie CLI.'));
  // A refresh the backend refused for the same reason reads the status again.
  const refused = harness({ answers: { analytics_refresh: { needsCli: true } } });
  await refused.ctl.open();
  refused.calls.query.length = 0;
  await refused.ctl.handle('analytics-refresh', control());
  assert.deepEqual(ops(refused.calls), ['analytics_refresh', 'analytics_status']);
});

test('a click on a project filters by it', async () => {
  const { ctl, calls, state } = harness();
  await ctl.open();
  const project = summary.projects[0].project;
  await ctl.handle('analytics-project', control(project));
  assert.equal(state.analytics.project, project);
  assert.equal(views(calls).at(-1).project, project);
  assert.equal(calls.toasts.length, 1);
  // Picked from the Project menu: the menu closes, nothing is announced.
  let closed = false;
  const menu = { removeAttribute: name => { closed = name === 'open'; } };
  await ctl.handle('analytics-project', control('', sel => (sel === 'details' ? menu : null)));
  assert.ok(closed);
  assert.equal(views(calls).at(-1).project, undefined);
  assert.equal(calls.toasts.length, 1);
});

test('opening a session loads its trace into the controller', async () => {
  const { ctl, calls } = harness();
  await ctl.open();
  const id = summary.sessions[0].sessionId;
  await ctl.handle('analytics-open-session', control(id));
  assert.deepEqual(calls.query.at(-1), ['analytics_session', { id }]);
  assert.deepEqual(ctl.data.session, { id, loading: false, detail: session, error: '' });
  const failing = harness({ answers: { analytics_session: Object.assign(new Error('The CodeMie CLI stopped with exit code 1.'), { code: 'cli_failed' }) } });
  await failing.ctl.handle('analytics-open-session', control(id));
  assert.deepEqual(failing.ctl.data.session, { id, loading: false, detail: null, error: 'The CodeMie CLI stopped with exit code 1.' });
});

test('retry, the CLI report and a failed view', async () => {
  const { ctl, calls, emit } = harness();
  await ctl.open();
  await ctl.handle('analytics-retry', control(status.failedDays[0]));
  assert.deepEqual(calls.query.at(-1), ['analytics_retry', { day: status.failedDays[0] }]);
  await emit({ ...progress, running: false, failedDays: [] });
  assert.equal(calls.toasts.length, 1);
  await ctl.handle('analytics-report', control());
  const { from, to } = presetRange('30d', FRESH, 'UTC');
  assert.deepEqual(calls.query.at(-1), ['analytics_report', { from, to }]);
  // A view the CLI couldn't answer is said on the page, and Try again reads it again.
  const broken = harness({ answers: { analytics_view: Object.assign(new Error('The CodeMie CLI took too long to answer. Try again.'), { code: 'timeout' }) } });
  await broken.ctl.open();
  assert.equal(broken.ctl.data.error, 'The CodeMie CLI took too long to answer. Try again.');
  assert.ok(broken.html().includes('The CodeMie CLI took too long to answer. Try again.'));
  broken.calls.query.length = 0;
  await broken.ctl.handle('analytics-reload', control());
  assert.deepEqual(ops(broken.calls), ['analytics_view']);
});

test('tabs, the notice and tables are kept; progress off the page renders nothing', async () => {
  const { ctl, state, calls, store, emit } = harness({ saved: { view: 'efficiency', tables: { depth: true } } });
  assert.equal(state.analytics.view, 'efficiency');
  await ctl.open();
  calls.query.length = 0;
  await ctl.handle('analytics-view', control('sessions'));
  await ctl.handle('analytics-mode', control('app'));
  await ctl.handle('analytics-table', control('trend'));
  await ctl.handle('analytics-notice', control('hide'));
  assert.deepEqual(calls.query, [], 'one summary feeds every tab');
  assert.deepEqual(JSON.parse(store.get(PREFS_KEY)), { mode: 'app', view: 'sessions', range: '30d', noticeHidden: true, tables: { depth: true, trend: true } });
  assert.equal(calls.toasts.length, 1);
  await ctl.handle('analytics-notice', control('show'));
  assert.equal(state.analytics.noticeHidden, false);
  state.route = 'today';
  const renders = calls.render;
  await emit(progress);
  assert.equal(calls.render, renders);
  assert.deepEqual(calls.query, []);
  assert.equal(ctl.data.progress.done, progress.done);
});
