// The real-app tour's stops, coverage and runner (design
// docs/superpowers/specs/2026-11-24-real-app-tour-design.md §§ 5–7), over a fake document and a
// fake invoke: no window, no Tauri.
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { STOPS, SEED_IDS, WIDTHS } from '../workspace/tour/script.js';
import { FEATURES } from '../workspace/tour/coverage.js';
import { runTour, denied, selectStops, gate } from '../workspace/tour/runner.js';
import { SEED_IDS as SEED_IDS_OF_SEED } from '../../scripts/tour/seed.mjs';

const repo = new URL('../../', import.meta.url);

// ---------------------------------------------------------------- fakes

/** A node the fake document hands out: its text, attributes and whether it was clicked. */
function node({ text = '', attrs = {}, visible = true, order = 0, onClick, rect, value, disabled, children = {}, scrollW, clientW, scrollH, clientH, cs = {} } = {}) {
  const n = {
    textContent: text, clicked: 0, order, attrs: { ...attrs }, value, disabled,
    scrollWidth: scrollW ?? 10, clientWidth: clientW ?? 10, scrollHeight: scrollH ?? 10, clientHeight: clientH ?? 10, cs,
    getBoundingClientRect: () => ({ x: 0, y: 0, width: 0, height: 0, top: 0, left: 0, right: 0, bottom: 0, ...rect }),
    querySelector: sel => children[sel] || null,
    matches: sel => sel in (attrs.matches || {}),
    get dataset() { return Object.fromEntries(Object.entries(n.attrs).filter(([k]) => k.startsWith('data-')).map(([k, v]) => [k.slice(5).replace(/-([a-z])/g, (_, c) => c.toUpperCase()), v])); },
    getAttribute: name => (name in n.attrs ? n.attrs[name] : null),
    hasAttribute: name => name in n.attrs,
    checkVisibility: () => visible,
    compareDocumentPosition: other => (other.order > n.order ? 4 : 2),
    click() { n.clicked += 1; onClick?.(n); },
    dispatchEvent() { return true; },
  };
  return n;
}

/** A document whose `querySelectorAll(sel)` answers `nodes[sel]` (a list, or a function of the
 *  document's own state), with the page `width` wide. */
function fakeDoc(nodes = {}, { scrollWidth = 1440, clientWidth = 1440, innerHeight = 900 } = {}) {
  const doc = {
    nodes,
    documentElement: { scrollWidth, clientWidth },
    defaultView: { innerWidth: clientWidth, innerHeight, getComputedStyle: el => ({ getPropertyValue: () => '', textOverflow: '', ...(el?.cs || {}) }) },
    querySelectorAll: sel => {
      const got = typeof nodes[sel] === 'function' ? nodes[sel](doc) : nodes[sel];
      return got || [];
    },
    querySelector: sel => doc.querySelectorAll(sel)[0] || null,
    getElementById: id => doc.querySelector(`#${id}`),
  };
  return doc;
}

/** An invoke that records every call and answers the tour commands. */
function fakeInvoke({ capture = () => ({ blank: false, sha256: String(Math.random()) }), focus = () => ({ appActive: false, windowKey: false }), menuBar, native = () => [] } = {}) {
  const calls = [];
  const invoke = async (cmd, args) => {
    calls.push([cmd, args]);
    if (cmd === 'tour_window') return { width: args.width, height: args.height };
    if (cmd === 'tour_capture') return { path: `/x/${args.id}.png`, width: 2880, height: 1800, ...capture(args.id, args) };
    if (cmd === 'tour_focus') return focus();
    if (cmd === 'tour_refused') return native();
    if (cmd === 'tour_menu_bar') return menuBar ? menuBar() : { tray: false, applied: { title: '3', amber: true }, computed: { count: 3, label: '3', amber: true }, rowTexts: ['3 messages need a reply'] };
    throw new Error(`unexpected ${cmd}`);
  };
  invoke.calls = calls;
  return invoke;
}

function harness({ stops, doc = fakeDoc(), invoke = fakeInvoke(), only = 'all', ops = [], refused = [] } = {}) {
  const mutations = [];
  const routes = [];
  let settings = { view: 'default', theme: 'light' };
  return {
    invoke, doc, mutations, routes, ops,
    run: () => runTour({
      invoke, doc, only, runId: 'run-1', stops, ops, refused,
      raf: fn => fn(), wait: async () => {},
      goHash: async hash => { routes.push(hash); },
      store: { get: () => ({ snapshot: { settings } }) },
      // Every mutate is a `workspace_request`, which the real `gate` records in `ops` (app.js's
      // own reactive calls go through the same `invoke`, not only a stop's scripted action).
      mutate: async (op, data) => {
        mutations.push([op, data]);
        ops.push(op);
        if (op === 'settings_update') settings = { ...settings, ...data };
        return {};
      },
    }),
  };
}

const stop = (id, extra = {}) => ({
  id, step: [1], title: id, route: '#/inbox', view: 'default', theme: 'light', width: 1440,
  checks: [{ name: 'the list', selector: '.ws-inbox-row' }], covers: ['c1.compact-inbox'], ...extra,
});
const withRows = () => fakeDoc({ '.ws-inbox-row': [node({ text: 'row' })] });
const checkOf = (result, name) => result.checks.find(c => c.name === name);

// ---------------------------------------------------------------- the script and the coverage

test('every built feature has a stop, and every stop covers a known feature', () => {
  const known = new Set(FEATURES.map(f => f.id));
  const covered = new Set(STOPS.flatMap(s => s.covers));
  for (const s of STOPS) {
    assert.ok(s.covers.length > 0, `${s.id} covers nothing`);
    for (const id of s.covers) assert.ok(known.has(id), `${s.id} covers an unknown feature ${id}`);
  }
  for (const f of FEATURES.filter(x => x.status === 'built')) assert.ok(covered.has(f.id), `${f.id} is built but no stop covers it`);
  for (const f of FEATURES.filter(x => x.status !== 'built')) assert.ok(!covered.has(f.id), `${f.id} is ${f.status} but a stop covers it`);
  assert.equal(new Set(FEATURES.map(f => f.id)).size, FEATURES.length, 'feature ids are unique');
});

test('every browser feature names a check file that exists', () => {
  const browser = FEATURES.filter(f => f.status === 'browser');
  // Ruling 12: amber only for what needs a real send or the desktop (or a provider state the seed
  // doesn't hold), each naming its browser check.
  assert.deepEqual(browser.map(f => f.id).sort(), ['mb6.row-click', 'mb6.seen-marks', 'pm7.chooser-ollama', 'r2.cmd-enter', 'r2.mail-confirm', 'r2.teams-send', 'tp4.banners',
    'v8.import-distil', 'v8.import-pick', 'v8.import-save', 'v8.refresh', 'v8.save-through-provider', 'v8.sheet-line']);
  for (const f of browser) {
    const file = new URL(f.browserCheck.file, repo);
    assert.ok(existsSync(file), `${f.id}: ${f.browserCheck.file} is missing`);
    assert.ok(readFileSync(file, 'utf8').includes(f.browserCheck.check), `${f.id}: ${f.browserCheck.file} has no "${f.browserCheck.check}"`);
    assert.ok(f.reason && f.browserCheck.set, `${f.id} says why and names its browser set`);
  }
});

test('stops are T01..T70 in order, widths in {1000,1440,1680}, views and themes both used for steps 1–5, 7 and 8', () => {
  assert.deepEqual(STOPS.map(s => s.id), Array.from({ length: 70 }, (_, i) => `T${String(i + 1).padStart(2, '0')}`));
  for (const s of STOPS) {
    assert.ok(s.checks.length > 0, `${s.id} has no checks`);
    if (s.capture === false) continue;
    assert.ok(WIDTHS.includes(s.width), `${s.id} width ${s.width}`);
    assert.ok(['default', 'compact'].includes(s.view) && ['light', 'dark'].includes(s.theme), `${s.id} ${s.view} ${s.theme}`);
    assert.match(s.route, /^#\//, `${s.id} route`);
  }
  for (const step of [1, 2, 3, 4, 5, 7, 8]) {
    const of = STOPS.filter(s => s.step.includes(step) && s.capture !== false);
    assert.deepEqual([...new Set(of.map(s => s.view))].sort(), ['compact', 'default'], `step ${step} views`);
    assert.deepEqual([...new Set(of.map(s => s.theme))].sort(), ['dark', 'light'], `step ${step} themes`);
  }
  assert.deepEqual([...new Set(STOPS.filter(s => s.width).map(s => s.width))].sort(), [1000, 1440, 1680]);
  const t28 = STOPS.find(s => s.id === 'T28');
  assert.equal(t28.capture, false, 'the menu bar is evidenced by its computed state');
  assert.ok(t28.checks.some(c => c.fact === 'tray' && c.equals === false), 'no tray is the correct tour state');
});

test('SEED_IDS in script.js equal those of scripts/tour/seed.mjs', () => {
  assert.deepEqual(SEED_IDS, SEED_IDS_OF_SEED);
});

// ---------------------------------------------------------------- the deny-list

test('the deny-list refuses send, confirm, fetch and install', () => {
  assert.equal(denied('op', 'action_confirm'), true);
  assert.equal(denied('op', 'action_prepare'), true);
  assert.equal(denied('action', 'reply-send'), true);
  assert.equal(denied('action', 'market-fetch'), true);
  assert.equal(denied('action', 'market-refresh'), true);
  assert.equal(denied('invoke', 'plugins_request:install'), true);
  assert.equal(denied('op', 'launchAtLogin'), true, 'launch at login, beside the sends (Task 1 review)');
  assert.equal(denied('op', 'settings_update'), false);
  assert.equal(denied('op', 'task_provider_set'), false);
  assert.equal(denied('action', 'select-message'), false);
  for (const ok of ['workspace_request', 'plugins_request:markets', 'plugins_request:installed', 'smoke_mode', 'get_app_version', 'tour_capture', 'tour_menu_bar']) {
    assert.equal(denied('invoke', ok), false, ok);
  }
  for (const no of ['check_for_update', 'log_line', 'plugins_request:market_refresh', 'plugins_request']) {
    assert.equal(denied('invoke', no), true, no);
  }
});

test('the window gate records every workspace op and refuses a denied one before it is sent', async () => {
  const ops = [];
  const refused = [];
  const sent = [];
  const guarded = gate(async (cmd, args) => { sent.push([cmd, args?.request?.op]); return 'ok'; }, { ops, refused });
  assert.equal(await guarded('workspace_request', { request: { op: 'settings_update', data: {} } }), 'ok');
  await assert.rejects(guarded('workspace_request', { request: { op: 'action_confirm', data: {} } }), /The tour sends nothing/);
  await assert.rejects(guarded('workspace_request', { request: { op: 'settings_update', data: { launchAtLogin: true } } }), /The tour sends nothing/);
  assert.equal(await guarded('plugins_request', { op: 'installed' }), 'ok');
  assert.deepEqual(ops, ['settings_update', 'action_confirm', 'settings_update']);
  assert.deepEqual(refused, [{ kind: 'op', name: 'action_confirm' }, { kind: 'op', name: 'launchAtLogin' }]);
  assert.deepEqual(sent, [['workspace_request', 'settings_update'], ['plugins_request', undefined]]);
});

// ---------------------------------------------------------------- the runner

test('a stop whose action is denied fails and dispatches nothing', async () => {
  const send = node({ attrs: { 'data-action': 'reply-send' } });
  const doc = fakeDoc({ '.ws-inbox-row': [node({ text: 'row' })], '.ws-inbox-row[data-id="x"]': [send] });
  const h = harness({ doc, stops: [stop('T05', { action: { name: 'selectRow', arg: 'x' } }), stop('T06', { route: '#/today' })] });
  const out = await h.run();
  assert.equal(send.clicked, 0, 'the denied control was never clicked');
  assert.equal(out.stops[0].pass, false);
  assert.match(out.stops[0].error, /reply-send/);
  assert.deepEqual(out.refused, [{ stop: 'T05', kind: 'action', name: 'reply-send' }]);
  assert.ok(!h.invoke.calls.some(([cmd, args]) => cmd === 'tour_capture' && args.id === 'T05'), 'a refused stop is not captured');
  assert.equal(out.stops[1].pass, true, 'the tour goes on');
});

test('a stop whose action would mutate a denied op fails and mutates nothing', async () => {
  const h = harness({ doc: withRows(), stops: [stop('T23', { action: { name: 'setProvider', arg: 'x' } })] });
  const { ACTIONS } = await import('../workspace/tour/runner.js');
  const original = ACTIONS.setProvider;
  ACTIONS.setProvider = (ctx, p) => ctx.mutate('action_confirm', { provider: p });
  try {
    const out = await h.run();
    assert.equal(out.stops[0].pass, false);
    assert.deepEqual(h.mutations, []);
    assert.deepEqual(out.refused, [{ stop: 'T23', kind: 'op', name: 'action_confirm' }]);
  } finally {
    ACTIONS.setProvider = original;
  }
});

// Final review I2: every refusal, the window gate's and Rust's, is recorded against its stop and
// fails it, unless the stop expects it (`expectRefused`).

test('a refusal the window gate makes during a stop is that stop\'s, and fails it', async () => {
  const refused = [];
  // The app's own click reaches the gate, which refuses it (as `gate` pushes into `refused`).
  const reveal = node({ attrs: { 'data-action': 'storage-show' }, onClick: () => refused.push({ kind: 'window', name: 'data_location_reveal' }) });
  const doc = fakeDoc({ '.ws-inbox-row': [node({ text: 'row' })], '.reveal': [reveal] });
  const h = harness({ doc, refused, stops: [stop('T05', { action: { name: 'click', arg: '.reveal' } }), stop('T06')] });
  const out = await h.run();
  assert.deepEqual(out.refused, [{ stop: 'T05', kind: 'window', name: 'data_location_reveal' }]);
  assert.equal(out.stops[0].pass, false);
  assert.match(checkOf(out.stops[0], 'refused').detail, /window data_location_reveal/);
  assert.equal(out.stops[1].pass, true, 'the next stop is not blamed');
});

test('a refusal Rust made during a stop is asked for after it, and fails it', async () => {
  let n = 0;
  const invoke = fakeInvoke({ native: () => (n++ === 0 ? [{ kind: 'native', name: 'graph_connect', message: 'The tour opens nothing.' }] : []) });
  const h = harness({ doc: withRows(), invoke, stops: [stop('T27'), stop('T29')] });
  const out = await h.run();
  assert.deepEqual(out.refused, [{ stop: 'T27', kind: 'native', name: 'graph_connect', message: 'The tour opens nothing.' }]);
  assert.equal(out.stops[0].pass, false);
  assert.match(checkOf(out.stops[0], 'refused').detail, /native graph_connect \(The tour opens nothing\.\)/);
  assert.equal(out.stops[1].pass, true);
  assert.equal(checkOf(out.stops[1], 'refused'), undefined, 'a stop with nothing refused or expected has no refused check');
});

test('a refusal the stop expects passes it, and is still reported', async () => {
  const invoke = fakeInvoke({ native: () => [{ kind: 'native', name: 'graph_connect', message: 'The tour opens nothing.' }] });
  const h = harness({ doc: withRows(), invoke, stops: [stop('T27', { expectRefused: ['graph_connect'] })] });
  const out = await h.run();
  assert.equal(out.stops[0].pass, true, JSON.stringify(out.stops[0].checks));
  assert.deepEqual(out.refused, [{ stop: 'T27', kind: 'native', name: 'graph_connect', message: 'The tour opens nothing.', expected: true }]);
  assert.equal(checkOf(out.stops[0], 'refused').pass, true);
});

test('an expected refusal that never happened fails its stop', async () => {
  const h = harness({ doc: withRows(), stops: [stop('T27', { expectRefused: ['graph_connect'] })] });
  const out = await h.run();
  assert.equal(out.stops[0].pass, false);
  assert.match(checkOf(out.stops[0], 'refused').detail, /graph_connect was expected but not refused/);
});

test('a thrown check fails only its stop', async () => {
  const doc = fakeDoc({
    '.ws-inbox-row': [node({ text: 'row' })],
    '.boom': () => { throw new Error('the selector blew up'); },
  });
  const h = harness({ doc, stops: [stop('T03', { checks: [{ name: 'boom', selector: '.boom' }] }), stop('T04')] });
  const out = await h.run();
  assert.equal(out.stops[0].pass, false);
  assert.match(checkOf(out.stops[0], 'boom').detail, /the selector blew up/);
  assert.equal(out.stops[1].pass, true);
  assert.ok(h.invoke.calls.some(([cmd, args]) => cmd === 'tour_capture' && args.id === 'T03'), 'a stop with a failed check is still captured');
});

test('checks: text, order, exact, count, absent, before, notText and ids', async () => {
  const a = node({ text: 'codemie Built-in Not fetched yet', order: 1 });
  const b = node({ text: 'onetest Built-in', order: 2 });
  const doc = fakeDoc({
    '.a': [a], '.b': [b], '.both': [a, b], '.none': [], '.hidden': [node({ visible: false })],
    '.menu': [node({ text: 'Done  Draft options… Summarize' })],
    '.tpl': [node({ attrs: { 'data-id': 'one' } }), node({ attrs: { 'data-id': 'two' } })],
  });
  const checks = [
    { name: 'text', selector: '.a', text: 'Not fetched yet' },
    { name: 'order', selector: '.menu', text: ['Done', 'Summarize'], order: true },
    { name: 'order wrong', selector: '.menu', text: ['Summarize', 'Done'], order: true },
    { name: 'exact', selector: '.menu', exact: 'Done Draft options… Summarize' },
    { name: 'count', selector: '.both', count: 2 },
    { name: 'count wrong', selector: '.both', count: 3 },
    { name: 'absent', selector: '.hidden', absent: true },
    { name: 'absent wrong', selector: '.a', absent: true },
    { name: 'before', selector: '.a', before: '.b' },
    { name: 'before wrong', selector: '.b', before: '.a' },
    { name: 'missing', selector: '.none' },
    { name: 'notText', selector: '.a', notText: ['Good morning'] },
    { name: 'ids', selector: '.tpl', ids: ['one', 'two'] },
    { name: 'ids wrong', selector: '.tpl', ids: ['two', 'one'] },
  ];
  const h = harness({ doc, stops: [stop('T01', { checks })] });
  const [result] = (await h.run()).stops;
  const passed = Object.fromEntries(result.checks.map(c => [c.name, c.pass]));
  assert.deepEqual(passed, {
    text: true, order: true, 'order wrong': false, exact: true, count: true, 'count wrong': false,
    absent: true, 'absent wrong': false, before: true, 'before wrong': false, missing: false,
    notText: true, ids: true, 'ids wrong': false, noOverflow: true, noClip: true, focus: true, capture: true,
  });
});

test('an `op`/`count` check counts sends made during that stop only (task-provider design §11 ruling 16: "switches once")', async () => {
  // T60-alike (an earlier stop) sends `task_provider_set` once of its own; it must not count
  // against the next stop's check — this is what caught T61 joining every toast's text instead of
  // requiring exactly one `task_provider_set`.
  const earlier = stop('T60', { action: { name: 'mutate', arg: { op: 'task_provider_set', data: { provider: 'plugin:todoist' } } } });
  const once = stop('T61a', {
    action: { name: 'mutate', arg: { op: 'task_provider_set', data: { provider: 'local' } } },
    checks: [{ name: 'exactly one task_provider_set', op: 'task_provider_set', count: 1 }],
  });
  const thrice = stop('T61b', {
    action: [
      { name: 'mutate', arg: { op: 'task_provider_set', data: { provider: 'local' } } },
      { name: 'mutate', arg: { op: 'task_provider_set', data: { provider: 'local' } } },
      { name: 'mutate', arg: { op: 'task_provider_set', data: { provider: 'local' } } },
    ],
    checks: [{ name: 'exactly one task_provider_set', op: 'task_provider_set', count: 1 }],
  });
  const h = harness({ doc: withRows(), stops: [earlier, once, thrice] });
  const out = await h.run();
  assert.deepEqual(out.stops.map(s => checkOf(s, 'exactly one task_provider_set')?.pass), [undefined, true, false]);
  assert.match(checkOf(out.stops[2], 'exactly one task_provider_set').detail, /task_provider_set sent 3 times, expected 1/);
});

test('every captured stop checks for horizontal overflow', async () => {
  const h = harness({ doc: fakeDoc({ '.ws-inbox-row': [node()] }, { scrollWidth: 1500, clientWidth: 1440 }), stops: [stop('T03')] });
  const [result] = (await h.run()).stops;
  assert.equal(checkOf(result, 'noOverflow').pass, false);
  assert.match(checkOf(result, 'noOverflow').detail, /60/);
  assert.equal(result.pass, false);
});

test('a blank capture fails its stop', async () => {
  const invoke = fakeInvoke({ capture: () => ({ blank: true, sha256: 'b' }) });
  const h = harness({ doc: withRows(), invoke, stops: [stop('T03')] });
  const [result] = (await h.run()).stops;
  assert.equal(result.pass, false);
  assert.equal(checkOf(result, 'capture').pass, false);
  assert.match(checkOf(result, 'capture').detail, /blank/);
});

test('two stops on different routes with identical PNG hashes fail the later one', async () => {
  const invoke = fakeInvoke({ capture: () => ({ blank: false, sha256: 'same' }) });
  const h = harness({
    doc: withRows(), invoke,
    stops: [stop('T14', { route: '#/meetings/m/summary' }), stop('T15', { route: '#/meetings/m/summary' }), stop('T17', { route: '#/meetings/m/transcript' })],
  });
  const out = await h.run();
  assert.equal(out.stops[0].pass, true);
  assert.equal(out.stops[1].pass, true, 'the same scene may give the same picture');
  assert.equal(out.stops[2].pass, false);
  assert.match(checkOf(out.stops[2], 'capture').detail, /T14/);
});

test('a stop with `tour_focus` reporting appActive fails, and the tour goes on', async () => {
  let n = 0;
  const invoke = fakeInvoke({ focus: () => ({ appActive: n++ === 0, windowKey: false }) });
  const h = harness({ doc: withRows(), invoke, stops: [stop('T03'), stop('T04', { route: '#/today' })] });
  const out = await h.run();
  assert.equal(out.stops[0].pass, false);
  assert.equal(checkOf(out.stops[0], 'focus').pass, false);
  assert.equal(out.stops[1].pass, true);
});

test('only=Steps([3]) runs only stops whose step includes 3', async () => {
  const stops = [stop('T13', { step: [1] }), stop('T14', { step: [3, 4] }), stop('T19', { step: [3, 5] }), stop('T20', { step: [4] })];
  assert.deepEqual(selectStops(stops, '3').map(s => s.id), ['T14', 'T19']);
  assert.deepEqual(selectStops(stops, '0, 4').map(s => s.id), ['T14', 'T20']);
  assert.deepEqual(selectStops(stops, 'T20,T13').map(s => s.id), ['T13', 'T20']);
  assert.deepEqual(selectStops(stops, 'all').map(s => s.id), ['T13', 'T14', 'T19', 'T20']);
  const h = harness({ doc: withRows(), only: '3', stops });
  const out = await h.run();
  assert.deepEqual(out.stops.map(s => s.id), ['T14', 'T19']);
  assert.equal(out.runId, 'run-1');
});

test('a stop sets the view and theme through settings_update, sizes the window and opens its route', async () => {
  const h = harness({ doc: withRows(), stops: [stop('T04', { view: 'compact', theme: 'dark', width: 1000 }), stop('T05', { view: 'compact', theme: 'dark', width: 1000 })] });
  await h.run();
  assert.deepEqual(h.mutations, [['settings_update', { view: 'compact', theme: 'dark' }]], 'set once, only when it differs');
  assert.deepEqual(h.invoke.calls.filter(([c]) => c === 'tour_window').map(([, a]) => a), [{ width: 1000, height: 900 }, { width: 1000, height: 900 }]);
  assert.deepEqual(h.routes, ['#/inbox', '#/inbox']);
});

test('the menu bar stop checks the computed facts and takes no picture', async () => {
  const t28 = STOPS.find(s => s.id === 'T28');
  const h = harness({ stops: [t28] });
  const [result] = (await h.run()).stops;
  assert.equal(result.pass, true, JSON.stringify(result.checks));
  assert.equal(result.capture, null);
  assert.ok(!h.invoke.calls.some(([cmd]) => cmd === 'tour_capture' || cmd === 'tour_window'));
  assert.equal(result.menuBar.tray, false);

  const mismatch = harness({ stops: [t28], invoke: fakeInvoke({ menuBar: () => ({ tray: false, applied: { title: '2', amber: true }, computed: { count: 3, label: '3', amber: true }, rowTexts: ['x'] }) }) });
  const [bad] = (await mismatch.run()).stops;
  assert.equal(bad.pass, false);
  assert.equal(checkOf(bad, 'the applied view equals the recount').pass, false);
});

test('an after action runs once the stop is captured', async () => {
  const order = [];
  const sw = node({ attrs: { 'data-action': 'menu-page', 'data-page': 'calendar' }, onClick: n => { n.checked = !n.checked; order.push('click'); } });
  sw.checked = true;
  const doc = fakeDoc({ '.ws-inbox-row': [node()], 'input[data-action="menu-page"][data-page="calendar"]': [sw] });
  const invoke = fakeInvoke({ capture: () => { order.push('capture'); return { blank: false, sha256: 'x' }; } });
  const h = harness({ doc, invoke, stops: [stop('T13', { action: { name: 'hidePage', arg: 'calendar' }, after: { name: 'showPage', arg: 'calendar' } })] });
  const [result] = (await h.run()).stops;
  assert.equal(result.pass, true, JSON.stringify(result));
  assert.deepEqual(order, ['click', 'capture', 'click']);
});

test('the viewport is recorded at each captured stop', async () => {
  const h = harness({ doc: fakeDoc({ '.ws-inbox-row': [node()] }, { innerHeight: 869 }), stops: [stop('T03')] });
  const [result] = (await h.run()).stops;
  assert.deepEqual(result.viewport, { innerWidth: 1440, innerHeight: 869, window: { width: 1440, height: 900 } });
});

test('a menu a stop before left open is closed before the next stop opens its route', async () => {
  const menu = node();
  menu.open = true;
  const doc = fakeDoc({ '.ws-inbox-row': [node()], 'details[data-menu][open], details.ws-menu[open]': d => (menu.open ? [menu] : []) });
  const h = harness({ doc, stops: [stop('T12', { route: '#/today' })] });
  h.routes.push = function push(hash) { assert.equal(menu.open, false, `the menu was still open when ${hash} opened`); return Array.prototype.push.call(this, hash); };
  const [result] = (await h.run()).stops;
  assert.equal(result.pass, true);
  assert.equal(menu.open, false);
});

test('a conversation native put in another lane is found there and opened', async () => {
  let lane = 'reply';
  const tab = name => node({ attrs: { 'data-lane': name, 'aria-selected': 'false' }, onClick: () => { lane = name; } });
  const tabs = { critical: tab('critical'), reply: tab('reply') };
  const row = node({ attrs: { 'data-action': 'select-message', 'data-id': 'm-critical' }, onClick: () => { lane = 'open'; } });
  const doc = fakeDoc({
    '.ws-inbox-row': [node()],
    '.ws-lane[data-lane]': [tabs.critical, tabs.reply],
    '.ws-lane[data-lane="critical"]': [tabs.critical],
    '.ws-lane[data-lane="reply"]': [tabs.reply],
    '.ws-inbox-row[data-id="m-critical"]': () => (lane === 'reply' || lane === 'open' ? [row] : []),
    '.ws-crow-body[data-message-id="m-critical"] .ws-reply-bar, .ws-read[data-message-id="m-critical"] .ws-reply-bar': () => (lane === 'open' ? [node()] : []),
  });
  // Native has it on Needs reply, but the list shows Critical when the stop starts.
  lane = 'critical';
  const h = harness({ doc, stops: [stop('T09', { action: { name: 'selectRow', arg: 'm-critical' } })] });
  const [result] = (await h.run()).stops;
  assert.equal(result.error, null);
  assert.equal(tabs.reply.clicked, 1);
  assert.equal(row.clicked, 1);
});

test('a stop with `scroll` brings that part into view before the capture', async () => {
  const order = [];
  const part = node();
  part.scrollIntoView = opts => order.push(['scroll', opts]);
  const doc = fakeDoc({ '.ws-inbox-row': [node()], '.ws-mb-fixes': [part] });
  const invoke = fakeInvoke({ capture: () => { order.push(['capture']); return { blank: false, sha256: 'x' }; } });
  const h = harness({ doc, invoke, stops: [stop('T27', { scroll: '.ws-mb-fixes' })] });
  const [result] = (await h.run()).stops;
  assert.equal(result.pass, true);
  assert.deepEqual(order, [['scroll', { block: 'start' }], ['capture']]);
});


// ---------------------------------------------------------------- fix round 1

test('the deny-list refuses what opens Finder, Terminal, a browser, a picker or a download', () => {
  for (const name of ['data-reveal', 'open-external', 'plugin-open-link', 'meetings-settings-root-pick', 'cm-open-terminal', 'cm-open-download', 'tasks-provider-token-link', 'terminal-toggle', 'meeting-download', 'market-pick']) {
    assert.equal(denied('action', name), true, name);
  }
  for (const name of ['task-row-open', 'select-message', 'meeting-summary-tab', 'meeting-pane']) assert.equal(denied('action', name), false, name);
  for (const name of ['data_location_reveal', 'plugins_request:open_link', 'terminal_open_link', 'open_agent_in_terminal', 'open_app_download', 'meetings_root_pick', 'data_location_pick', 'pick_project_folder', 'plugins_request:pick_folder', 'plugins_request:frame_reveal', 'app_relaunch', 'check_for_update', 'update_cli']) {
    assert.equal(denied('window', name), true, name);
  }
  for (const name of ['workspace_request', 'plugin_call', 'plugins_request:installed', 'plugins_request:frame_session', 'plugins_request:host_phrases', 'plugins_request:client_storage', 'terminal_list', 'terminal_resize', 'get_app_version', 'smoke_mode', 'data_location_get', 'tour_capture']) {
    assert.equal(denied('window', name), false, name);
  }
});

test('the window gate refuses an opening command before it reaches native, and records it', async () => {
  const ops = [];
  const refused = [];
  const sent = [];
  const guarded = gate(async (cmd, args) => { sent.push(cmd); return 'ok'; }, { ops, refused });
  for (const [cmd, args] of [['data_location_reveal', { which: 'data' }], ['plugins_request', { op: 'open_link', data: {} }], ['open_app_download', { appId: 'x' }], ['meetings_root_pick', {}], ['terminal_open_link', { url: 'https://x' }]]) {
    await assert.rejects(guarded(cmd, args), /The tour opens nothing/, cmd);
  }
  assert.equal(await guarded('terminal_list', {}), 'ok');
  assert.equal(await guarded('plugins_request', { op: 'installed' }), 'ok');
  assert.deepEqual(sent, ['terminal_list', 'plugins_request']);
  assert.deepEqual(refused.map(r => r.name), ['data_location_reveal', 'plugins_request:open_link', 'open_app_download', 'meetings_root_pick', 'terminal_open_link']);
});

test('a stop may allow a named control, never a send', async () => {
  const allow = new Set();
  const refused = [];
  const guarded = gate(async () => 'ok', { ops: [], refused, allow });
  allow.add('plugins_request:remove');
  allow.add('action_confirm');
  assert.equal(await guarded('plugins_request', { op: 'remove', data: { id: 'todoist' } }), 'ok');
  await assert.rejects(guarded('workspace_request', { request: { op: 'action_confirm', data: {} } }), /sends nothing/);

  const removeBtn = node({ attrs: { 'data-action': 'plugin-remove' } });
  const sendBtn = node({ attrs: { 'data-action': 'reply-send' } });
  const doc = fakeDoc({ '.ws-inbox-row': [node()], '.remove': [removeBtn], '.send': [sendBtn] });
  const h = harness({ doc, stops: [
    stop('T60', { allow: ['plugin-remove'], action: [{ name: 'click', arg: '.remove' }] }),
    stop('T61', { action: [{ name: 'click', arg: '.remove' }] }),
    stop('T62', { allow: ['reply-send'], action: [{ name: 'click', arg: '.send' }] }),
  ] });
  const out = await h.run();
  assert.equal(removeBtn.clicked, 1, 'allowed in T60 only');
  assert.equal(out.stops[0].pass, true, JSON.stringify(out.stops[0]));
  assert.equal(out.stops[1].pass, false);
  assert.equal(out.stops[2].pass, false, 'a send is never allowed');
  assert.equal(sendBtn.clicked, 0);
});

test('a stop runs a list of actions in order, and a generic click, mutate and go', async () => {
  const order = [];
  const a = node({ attrs: { 'data-action': 'meeting-pane' }, onClick: () => order.push('click') });
  const doc = fakeDoc({ '.ws-inbox-row': [node()], '.a': [a] });
  const h = harness({ doc, stops: [stop('T40', { action: [{ name: 'mutate', arg: { op: 'settings_update', data: { hiddenPages: ['calendar'] } } }, { name: 'go', arg: '#/calendar' }, { name: 'click', arg: '.a' }], after: [{ name: 'mutate', arg: { op: 'settings_update', data: { hiddenPages: [] } } }] })] });
  const [result] = (await h.run()).stops;
  assert.equal(result.pass, true, JSON.stringify(result));
  assert.deepEqual(h.mutations, [['settings_update', { hiddenPages: ['calendar'] }], ['settings_update', { hiddenPages: [] }]]);
  assert.deepEqual(h.routes, ['#/inbox', '#/calendar']);
  assert.deepEqual(order, ['click']);
});

test('a frame stop fails when the frame’s own area of the capture is blank', async () => {
  const frame = node({ rect: { x: 300, y: 60, width: 900, height: 700 } });
  const doc = fakeDoc({ '.ws-inbox-row': [node()], 'iframe.f': [frame] });
  const regions = [];
  let blank = true;
  const invoke = fakeInvoke({ capture: (id, args) => { regions.push(args.region); return { blank: false, sha256: id, regionBlank: blank }; } });
  const h = harness({ doc, invoke, stops: [stop('T31', { frame: 'iframe.f' })] });
  const [bad] = (await h.run()).stops;
  assert.deepEqual(regions[0], { x: 300, y: 60, width: 900, height: 700, viewWidth: 1440 });
  assert.equal(bad.pass, false);
  assert.match(checkOf(bad, 'frame area').detail, /blank/);
  blank = false;
  const [good] = (await harness({ doc, invoke, stops: [stop('T31', { frame: 'iframe.f' })] }).run()).stops;
  assert.equal(checkOf(good, 'frame area').pass, true);
});

test('every captured stop checks that nothing the user sees is clipped', async () => {
  const clipped = node({ text: 'Send to Jordan Lee and a very long name', scrollW: 140, clientW: 100, attrs: { matches: { '.ws-btn': 1 } } });
  const ellipsis = node({ text: 'ok', scrollW: 140, clientW: 100, cs: { textOverflow: 'ellipsis' }, attrs: { matches: { '.ws-btn': 1 } } });
  const doc = fakeDoc({ '.ws-inbox-row': [node()] });
  const clip = 'CLIP';
  doc.nodes[clip] = [clipped, ellipsis];
  const { CLIP_SELECTORS } = await import('../workspace/tour/runner.js');
  doc.nodes[CLIP_SELECTORS.join(',')] = [clipped, ellipsis];
  const [result] = (await harness({ doc, stops: [stop('T30')] }).run()).stops;
  assert.equal(checkOf(result, 'noClip').pass, false);
  assert.match(checkOf(result, 'noClip').detail, /Send to Jordan/);
  assert.doesNotMatch(checkOf(result, 'noClip').detail, /"ok"/);
});

test('checks: value, valueStarts, any (hidden too), disabled, attr, below, over and stacked', async () => {
  const box = node({ value: 'Sure, at 14:30.' });
  const hidden = node({ text: 'Default · Inbox triage (Claude Code)', visible: false });
  const off = node({ disabled: true, attrs: { title: 'Keep one page in the menu.' } });
  const pane = node({ rect: { top: 100, bottom: 400, left: 0, right: 600, x: 0, y: 100, width: 600, height: 300 } });
  const items = node({ rect: { top: 410, bottom: 600, left: 0, right: 600, x: 0, y: 410, width: 600, height: 190 } });
  const frame = node({ rect: { x: 300, y: 60, width: 900, height: 700 } });
  const slot = node({ rect: { x: 300.4, y: 60, width: 900, height: 700 } });
  const row = node({ children: { th: node({ rect: { top: 0, bottom: 30 } }), td: node({ rect: { top: 34, bottom: 60 } }) } });
  const flat = node({ children: { th: node({ rect: { top: 0, bottom: 30 } }), td: node({ rect: { top: 0, bottom: 30 } }) } });
  const doc = fakeDoc({ '.ws-inbox-row': [node()], '#box': [box], '.opt': [hidden], '.off': [off], '.items': [items], '.pane': [pane], '.frame': [frame], '.slot': [slot], '.row': [row], '.flat': [flat] });
  const checks = [
    { name: 'value', selector: '#box', value: 'Sure, at 14:30.' },
    { name: 'value wrong', selector: '#box', value: 'x' },
    { name: 'valueStarts', selector: '#box', valueStarts: 'Sure' },
    { name: 'hidden unseen', selector: '.opt', text: 'Default' },
    { name: 'any', selector: '.opt', any: true, text: 'Default · Inbox triage (' },
    { name: 'disabled', selector: '.off', disabled: true },
    { name: 'attr', selector: '.off', attr: ['title', 'Keep one page in the menu.'] },
    { name: 'below', selector: '.items', below: '.pane' },
    { name: 'below wrong', selector: '.pane', below: '.items' },
    { name: 'over', selector: '.frame', over: '.slot' },
    { name: 'stacked', selector: '.row', stacked: ['th', 'td'] },
    { name: 'stacked wrong', selector: '.flat', stacked: ['th', 'td'] },
  ];
  const [result] = (await harness({ doc, stops: [stop('T01', { checks })] }).run()).stops;
  const got = Object.fromEntries(result.checks.filter(c => checks.some(k => k.name === c.name)).map(c => [c.name, c.pass]));
  assert.deepEqual(got, { value: true, 'value wrong': false, valueStarts: true, 'hidden unseen': false, any: true, disabled: true, attr: true, below: true, 'below wrong': false, over: true, stacked: true, 'stacked wrong': false });
});

test('an open menu’s panel is not a clip, and old toasts are cleared before a stop', async () => {
  const barWithMenu = node({ text: 'Send to Jordan Snooze', scrollH: 300, clientH: 40, attrs: { matches: { '.ws-reply-bar': 1 } }, children: { 'details[open]': node() } });
  const toastEl = node({ text: 'Added to Todoist' });
  toastEl.remove = () => { toastEl.gone = true; };
  const { CLIP_SELECTORS } = await import('../workspace/tour/runner.js');
  const doc = fakeDoc({ '.ws-inbox-row': [node()], [CLIP_SELECTORS.join(',')]: [barWithMenu], '.ws-toast': () => (toastEl.gone ? [] : [toastEl]) });
  const [result] = (await harness({ doc, stops: [stop('T06')] }).run()).stops;
  assert.equal(checkOf(result, 'noClip').pass, true, checkOf(result, 'noClip').detail);
  assert.equal(toastEl.gone, true);
});

test('unfoldTask leaves an open row open, and untilText waits for the words', async () => {
  const main = node({ attrs: { 'data-action': 'task-row-open' } });
  const toastEl = node({ text: '' });
  let n = 0;
  const doc = fakeDoc({
    '.ws-inbox-row': [node()],
    '.ws-tdate-row[data-task="t"].ws-tdate-open': [node()],
    '.ws-tdate-row[data-task="t"] .ws-tdate-main': [main],
    '.t': () => { n += 1; toastEl.textContent = n > 2 ? 'Todoist was removed' : 'Added'; return [toastEl]; },
  });
  const h = harness({ doc, stops: [stop('T56', { action: [{ name: 'unfoldTask', arg: 't' }, { name: 'untilText', arg: { selector: '.t', text: 'was removed' } }] })] });
  const [result] = (await h.run()).stops;
  assert.equal(result.error, null);
  assert.equal(main.clicked, 0, 'already open');
  assert.ok(n >= 3);
});

test('a stop’s `next` phase is checked and captured on its own, before the after action', async () => {
  const order = [];
  const doc = fakeDoc({ '.ws-inbox-row': [node()], '.dialog': [node({ text: 'Copy your open tasks to Todoist?' })] });
  const invoke = fakeInvoke({ capture: id => { order.push(`capture ${id}`); return { blank: false, sha256: id }; } });
  const h = harness({ doc, invoke, stops: [stop('T23', {
    next: { title: 'the copy dialog', action: { name: 'wait', arg: 1 }, checks: [{ name: 'the dialog', selector: '.dialog', text: 'Copy your open tasks' }] },
    after: { name: 'mutate', arg: { op: 'task_provider_set', data: { provider: 'plugin:todoist' } } },
  })] });
  const [result] = (await h.run()).stops;
  assert.equal(result.pass, true, JSON.stringify(result));
  assert.deepEqual(order, ['capture T23', 'capture T23-next']);
  assert.equal(result.next.capture.path, '/x/T23-next.png');
  assert.ok(result.checks.some(c => c.name === 'next: the dialog' && c.pass));
  assert.deepEqual(h.mutations.at(-1), ['task_provider_set', { provider: 'plugin:todoist' }]);
});

test('allowing the Delete control opens its ask but never lets task_delete through', async () => {
  const allow = new Set(['task-delete']);
  const refused = [];
  const guarded = gate(async () => 'ok', { ops: [], refused, allow });
  await assert.rejects(guarded('workspace_request', { request: { op: 'task_delete', data: { id: 'task-legal' } } }), /sends nothing/);
  assert.deepEqual(refused, [{ kind: 'op', name: 'task_delete' }]);
  const stop60 = STOPS.find(s => s.covers.includes('tp4.delete-ask'));
  assert.deepEqual(stop60.allow, ['task-delete']);
  // Removing the Todoist plugin stays the last stop that needs Todoist: only step 8's voice stops
  // come after it.
  const removing = STOPS.findIndex(s => s.covers.includes('tp4.removed-local'));
  assert.ok(STOPS.slice(removing + 1).every(s => s.step.every(n => n === 8)), 'only voice stops come after removing the plugin');
});

test('the seed’s AI settings are the ones the chooser stop saves back', async () => {
  const { SEED_AI } = await import('../workspace/tour/script.js');
  const { buildSeed } = await import('../../scripts/tour/seed.mjs');
  assert.deepEqual(buildSeed('/tmp/connect-tour-x/workspace', Date.now()).seed.settings.ai, SEED_AI);
});

test('voiceImport scans the skills folder beside the meetings root and hands the preview to the voice controller', async () => {
  const preview = { folder: 'voice-skills', found: 6, items: [], skipped: [] };
  const queried = [];
  const opened = [];
  const doc = fakeDoc({ '.ws-voice-import': () => (opened.length ? [node({ text: 'Import from skills · voice-skills' })] : []) });
  const ops = [];
  const stops = [stop('T69', { action: { name: 'voiceImport', arg: 'voice-skills' }, checks: [{ name: 'the preview', selector: '.ws-voice-import' }, { name: 'one scan', op: 'voice_import_scan', count: 1 }] })];
  const result = await runTour({
    invoke: fakeInvoke(), doc, stops, ops, raf: fn => fn(), wait: async () => {}, goHash: async () => {},
    store: {
      get: () => ({ snapshot: { settings: { view: 'default', theme: 'light', meetings: { root: '/tmp/connect-tour-x/workspace/Meetings' } } } }),
      // The window's own query goes through the gate, which records the op.
      query: async (op, data) => { queried.push([op, data]); ops.push(op); return preview; },
    },
    voice: { openImport: async (p, path) => { opened.push([p, path]); } },
    mutate: async () => ({}),
  });
  const [r] = result.stops;
  assert.equal(r.pass, true, JSON.stringify(r));
  assert.deepEqual(queried, [['voice_import_scan', { path: '/tmp/connect-tour-x/workspace/voice-skills' }]]);
  assert.deepEqual(opened, [[preview, '/tmp/connect-tour-x/workspace/voice-skills']]);
});

test('checks: focused', async () => {
  const cancel = node({ text: 'Cancel' });
  const doc = fakeDoc({ '.ws-inbox-row': [node()], '.cancel': [cancel], '.other': [node()] });
  doc.activeElement = cancel;
  const h = harness({ doc, stops: [stop('T68', { checks: [{ name: 'yes', selector: '.cancel', focused: true }, { name: 'no', selector: '.other', focused: true }] })] });
  const [r] = (await h.run()).stops;
  assert.equal(checkOf(r, 'yes').pass, true);
  assert.equal(checkOf(r, 'no').pass, false);
});

test('the deny-list refuses Shorten with AI (an AI run) up front, and still lets the import scan through', () => {
  assert.equal(denied('action', 'voice-import-distil'), true);
  assert.equal(denied('op', 'voice_import_distil'), true);
  assert.equal(denied('op', 'voice_import_scan'), false);
  assert.equal(denied('action', 'voice-import-cancel'), false);
});
