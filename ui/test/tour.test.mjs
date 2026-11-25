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
function node({ text = '', attrs = {}, visible = true, order = 0, onClick } = {}) {
  const n = {
    textContent: text, clicked: 0, order, attrs: { ...attrs },
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
    defaultView: { innerWidth: clientWidth, innerHeight, getComputedStyle: () => ({ getPropertyValue: () => '' }) },
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
function fakeInvoke({ capture = () => ({ blank: false, sha256: String(Math.random()) }), focus = () => ({ appActive: false, windowKey: false }), menuBar } = {}) {
  const calls = [];
  const invoke = async (cmd, args) => {
    calls.push([cmd, args]);
    if (cmd === 'tour_window') return { width: args.width, height: args.height };
    if (cmd === 'tour_capture') return { path: `/x/${args.id}.png`, width: 2880, height: 1800, ...capture(args.id) };
    if (cmd === 'tour_focus') return focus();
    if (cmd === 'tour_menu_bar') return menuBar ? menuBar() : { tray: false, applied: { title: '3', amber: true }, computed: { count: 3, label: '3', amber: true } };
    throw new Error(`unexpected ${cmd}`);
  };
  invoke.calls = calls;
  return invoke;
}

function harness({ stops, doc = fakeDoc(), invoke = fakeInvoke(), only = 'all' } = {}) {
  const mutations = [];
  const routes = [];
  let settings = { view: 'default', theme: 'light' };
  return {
    invoke, doc, mutations, routes,
    run: () => runTour({
      invoke, doc, only, runId: 'run-1', stops,
      raf: fn => fn(), wait: async () => {},
      goHash: async hash => { routes.push(hash); },
      store: { get: () => ({ snapshot: { settings } }) },
      mutate: async (op, data) => {
        mutations.push([op, data]);
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
  assert.deepEqual(browser.map(f => f.id).sort(), ['pm7.plugin-rows', 'r2.mail-confirm', 'tp4.banners']);
  for (const f of browser) {
    const file = new URL(f.browserCheck.file, repo);
    assert.ok(existsSync(file), `${f.id}: ${f.browserCheck.file} is missing`);
    assert.ok(readFileSync(file, 'utf8').includes(f.browserCheck.check), `${f.id}: ${f.browserCheck.file} has no "${f.browserCheck.check}"`);
    assert.ok(f.reason && f.browserCheck.set, `${f.id} says why and names its browser set`);
  }
});

test('stops are T01..T31 in order (T31 the plugin frame), widths in {1000,1440,1680}, views and themes both used for steps 1–5 and 7', () => {
  assert.deepEqual(STOPS.map(s => s.id), Array.from({ length: 31 }, (_, i) => `T${String(i + 1).padStart(2, '0')}`));
  for (const s of STOPS) {
    assert.ok(s.checks.length > 0, `${s.id} has no checks`);
    if (s.capture === false) continue;
    assert.ok(WIDTHS.includes(s.width), `${s.id} width ${s.width}`);
    assert.ok(['default', 'compact'].includes(s.view) && ['light', 'dark'].includes(s.theme), `${s.id} ${s.view} ${s.theme}`);
    assert.match(s.route, /^#\//, `${s.id} route`);
  }
  for (const step of [1, 2, 3, 4, 5, 7]) {
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
    notText: true, ids: true, 'ids wrong': false, noOverflow: true, focus: true, capture: true,
  });
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

  const mismatch = harness({ stops: [t28], invoke: fakeInvoke({ menuBar: () => ({ tray: false, applied: { title: '2', amber: true }, computed: { count: 3, label: '3', amber: true } }) }) });
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
