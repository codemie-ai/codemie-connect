// The App analytics tab over `analytics_app` (Connect's own records, counted by the backend): the UI
// formats the answer as it is. Expected values come from the fixture; other cases are copies.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { appTab, appCharts } from '../workspace/view-analytics-app.js';
import { createAnalyticsController } from '../workspace/analytics-controller.js';
import { analyticsView, analyticsCharts } from '../workspace/view-analytics.js';
import { newAnalyticsView, presetRange, usd, pct, n0, dur, plural, modelLabel, hm, dayName, PREFS_KEY } from '../workspace/analytics-model.js';
import { escapeHtml as e } from '../workspace/store.js';

const fixture = name => JSON.parse(readFileSync(new URL(`fixtures/contract/${name}`, import.meta.url), 'utf8'));
const app = fixture('analytics-app.json');
const status = fixture('analytics-status.json');
const summary = fixture('analytics-summary.json');
const ZONE = 'UTC';
const NOW = status.lastFetchAt + 60_000;
const copy = value => structuredClone(value);
/** The backend's purpose → feature (analytics/app.rs `feature_of`). */
const FEATURE_OF = { meeting: 'meeting', mail_draft: 'draft', chat_draft: 'draft', summary: 'summary', automation: 'automation', plugin: 'plugin' };
const LABELS = { meeting: 'Meeting notes', draft: 'Reply drafts', summary: 'Summaries', automation: 'Automations', plugin: 'Plugins', terminal: 'Terminal sessions' };

const ui = (over = {}) => ({ ...newAnalyticsView(), mode: 'app', ...over });
const data = (over = {}) => ({ ...app, now: NOW, zone: ZONE, ...over });
const count = (html, needle) => html.split(needle).length - 1;
const runsOf = html => [...html.matchAll(/data-run="([^"]+)"/g)].map(m => m[1]);
const legendOf = html => html.slice(html.indexOf('class="ws-an-legend"'), html.indexOf('</div>', html.indexOf('class="ws-an-legend"')));
const cardOf = (html, id) => {
  const at = html.indexOf(`data-card="${id}"`);
  return at < 0 ? '' : html.slice(at, html.indexOf('</section>', at));
};

test('app tab: background runs by default, terminal only after the switch', () => {
  const background = Object.keys(LABELS).filter(k => k !== 'terminal');
  const html = appTab(data(), ui());
  assert.ok(html.includes('aria-selected="true" data-action="analytics-app-terminal" data-value="off"'));
  for (const k of background) assert.ok(legendOf(html).includes(LABELS[k]), k);
  assert.ok(!legendOf(html).includes(LABELS.terminal));
  const svg = appCharts(data(), ui()).appTrend(800);
  assert.equal(count(svg, 'class="ws-an-band"'), app.series.length);
  assert.ok(!svg.includes(LABELS.terminal));
  // Each bucket's tooltip has its features' costs as the backend counted them; no total is made up.
  for (const b of app.series) {
    for (const k of background) if (b.by[k] > 0) assert.ok(svg.includes(e(`<b>${e(usd(b.by[k]))}</b>`)), `${b.from} ${k}`);
  }
  // With terminal: the terminal sessions join the chart and the legend.
  const on = ui({ appTerm: true });
  const withTerm = appTab(data(), on);
  assert.ok(withTerm.includes('aria-selected="true" data-action="analytics-app-terminal" data-value="on"'));
  assert.ok(legendOf(withTerm).includes(LABELS.terminal));
  const svgOn = appCharts(data(), on).appTrend(800);
  assert.ok(svgOn.includes(LABELS.terminal));
  for (const b of app.series.filter(x => x.by.terminal > 0)) assert.ok(svgOn.includes(e(`<b>${e(usd(b.by.terminal))}</b>`)));
  // By feature keeps the terminal apart, under its own heading, either way.
  for (const u of [ui(), on]) {
    const features = cardOf(appTab(data(), u), 'features');
    const term = app.features.find(f => f.key === 'terminal');
    assert.ok(features.indexOf('Claude Code in Connect') < features.indexOf(`data-feature="terminal"`));
    assert.ok(features.includes(e(usd(term.costUsd))) && features.includes(`${n0(term.runs)} ${plural(term.runs, 'session')}`));
  }
  // The table view shows each bucket's costs instead of the chart.
  const table = appTab(data(), ui({ tables: { appTrend: true } }));
  assert.ok(!table.includes('data-chart="appTrend"'));
  assert.deepEqual(Object.keys(appCharts(data(), ui({ tables: { appTrend: true } }))), []);
  for (const b of app.series) assert.ok(table.includes(`<td class="ws-an-r">${e(usd(b.by.meeting))}</td>`));
});

test('app tab: KPIs, by feature, by profile and what Connect did come from analytics_app as they are', () => {
  const t = app.totals;
  const o = app.outcomes;
  const html = appTab(data(), ui());
  assert.ok(html.includes(e(usd(t.costUsd, true))));
  assert.ok(html.includes(`${pct(t.shareOfAll)} of all AI cost on this Mac`));
  assert.ok(html.includes(`+ ${n0(t.terminalSessions)} terminal ${plural(t.terminalSessions, 'session')} · ${e(usd(t.terminalCostUsd))}`));
  assert.ok(html.includes(`of ${n0(t.runs)} ${plural(t.runs, 'run')}`));
  assert.ok(html.includes(e(usd(o.perNoteUsd))) && html.includes(`${e(usd(o.perSentUsd))} per sent reply`));
  // By feature: each background feature, a click filters Recent runs.
  const features = cardOf(html, 'features');
  for (const f of app.features.filter(x => x.key !== 'terminal')) {
    assert.ok(features.includes(`data-action="analytics-app-feature" data-value="${f.key}"`), f.key);
    assert.ok(features.includes(LABELS[f.key]) && features.includes(e(usd(f.costUsd))), f.key);
    assert.ok(features.includes(`${n0(f.runs)} ${plural(f.runs, 'run')}${f.runs ? ` · ${e(dur(f.avgMs))} avg` : ''}<`), f.key);
    if (f.failed) assert.ok(features.includes(`${n0(f.failed)} failed`), f.key);
  }
  assert.ok(!features.includes('data-action="analytics-app-feature" data-value="terminal"'));
  // By profile and model: the profile's name when the AI settings know it, its id otherwise.
  const profiles = cardOf(html, 'profiles');
  for (const p of app.profiles) {
    assert.ok(profiles.includes(e(p.profile)) && profiles.includes(e(modelLabel(p.model))) && profiles.includes(e(usd(p.costUsd))) && profiles.includes(`${n0(p.runs)} ${plural(p.runs, 'run')}`), p.profile);
  }
  const named = cardOf(appTab(data({ profileNames: [{ id: app.profiles[0].profile, label: 'Claude Code · your subscription' }] }), ui()), 'profiles');
  assert.ok(named.includes('Claude Code · your subscription'));
  // What Connect did.
  const outcomes = cardOf(html, 'outcomes');
  assert.ok(outcomes.includes(`of ${n0(o.transcribed)} transcribed · ${n0(o.meetings)} meetings`));
  assert.ok(outcomes.includes(`>${n0(o.noted)}<`) && outcomes.includes(`>${n0(o.tasks)}<`) && outcomes.includes(`${n0(o.tasksDone)} done`));
  assert.ok(outcomes.includes(`of ${n0(o.drafts)} drafts prepared`) && outcomes.includes(`>${n0(o.sent)}<`));
  assert.ok(outcomes.includes(`>${n0(o.inboxHandled)}<`));
  assert.ok(outcomes.includes(`of ${n0(o.autoRuns)} finished`) && outcomes.includes(`>${n0(o.autoOk)}<`));
  // Nothing to compare against, or nothing to divide by: the backend's null shows as a dash.
  const unknown = appTab(data({ totals: { ...t, shareOfAll: null }, outcomes: { ...o, perNoteUsd: null, perSentUsd: null } }), ui());
  assert.ok(!unknown.includes('of all AI cost on this Mac'));
  assert.ok(unknown.includes('no replies sent'));
  // Recent runs: when, what, profile and model, time and cost.
  const zero = app.recent[0];
  const recent = cardOf(html, 'recent');
  assert.ok(recent.includes(e(`${dayName(zero.at * 1000, NOW, ZONE)} ${hm(zero.at * 1000, ZONE)}`)));
  assert.ok(recent.includes(e(usd(zero.costUsd))) && recent.includes(e(dur(zero.durationMs))));
});

test('provider text on the App tab is escaped', () => {
  const bad = '<script>alert(1)</script>';
  const evil = copy(app);
  evil.profiles = evil.profiles.map(p => ({ ...p, profile: bad, model: bad }));
  evil.recent = evil.recent.map(r => ({ ...r, profile: bad, model: bad, purpose: bad, status: bad, id: bad }));
  for (const over of [{}, { appList: 'failed' }, { appTerm: true }, { tables: { appTrend: true } }]) {
    const html = appTab({ ...evil, now: NOW, zone: ZONE, profileNames: [{ id: bad, label: bad }] }, ui(over));
    assert.ok(!/<script/i.test(html), JSON.stringify(over));
    assert.ok(html.includes('&lt;script&gt;'), JSON.stringify(over));
  }
});

// ---------------------------------------------------------------- the controller

function harness({ answers = {}, saved = null } = {}) {
  const calls = { query: [], render: 0, toasts: [] };
  const store = new Map(saved ? [[PREFS_KEY, JSON.stringify(saved)]] : []);
  const state = { route: 'analytics' };
  const defaults = { analytics_status: status, analytics_view: summary, analytics_app: app };
  const ctl = createAnalyticsController({
    state,
    query: async (op, body) => {
      calls.query.push([op, body]);
      const answer = op in answers ? answers[op] : defaults[op];
      if (answer instanceof Error) throw answer;
      return typeof answer === 'function' ? answer(body) : answer;
    },
    render: async () => { calls.render++; },
    toast: (message, tone) => calls.toasts.push([message, tone]),
    listen: async () => () => {},
    storage: { getItem: k => store.get(k) ?? null, setItem: (k, v) => store.set(k, v) },
    now: () => NOW,
    zone: ZONE,
  });
  return { ctl, state, calls, html: () => analyticsView(state.analytics, ctl.viewData()) };
}
const control = (value = '') => ({ dataset: { value }, closest: () => null });
const ops = calls => calls.query.map(([op]) => op);

test('app tab: a feature click filters Recent runs; Failed shows only failed runs', async () => {
  const { ctl, state, html } = harness({ saved: { mode: 'app' } });
  await ctl.open();
  assert.deepEqual(runsOf(html()), app.recent.map(r => r.id));
  const feature = FEATURE_OF[app.recent.find(r => FEATURE_OF[r.purpose]).purpose];
  await ctl.handle('analytics-app-feature', control(feature));
  assert.equal(state.analytics.appFeature, feature);
  assert.deepEqual(runsOf(html()), app.recent.filter(r => FEATURE_OF[r.purpose] === feature).map(r => r.id));
  // The filter shows as a chip that clears it; the same feature clicked again clears it too.
  assert.ok(cardOf(html(), 'recent').includes(`data-action="analytics-app-feature" data-value=""`));
  assert.ok(cardOf(html(), 'features').includes(`aria-pressed="true" data-action="analytics-app-feature" data-value="${feature}"`));
  await ctl.handle('analytics-app-feature', control(feature));
  assert.equal(state.analytics.appFeature, '');
  assert.deepEqual(runsOf(html()), app.recent.map(r => r.id));
  // Failed: only the runs that didn't end ok; with a feature, both apply.
  await ctl.handle('analytics-app-list', control('failed'));
  assert.deepEqual(runsOf(html()), app.recent.filter(r => r.status !== 'ok').map(r => r.id));
  const failed = app.recent.find(r => r.status !== 'ok' && FEATURE_OF[r.purpose]);
  await ctl.handle('analytics-app-feature', control(FEATURE_OF[failed.purpose]));
  assert.deepEqual(runsOf(html()), app.recent.filter(r => r.status !== 'ok' && FEATURE_OF[r.purpose] === FEATURE_OF[failed.purpose]).map(r => r.id));
  await ctl.handle('analytics-app-list', control('all'));
  // A feature without runs.
  await ctl.handle('analytics-app-feature', control('plugin'));
  if (!app.recent.some(r => FEATURE_OF[r.purpose] === 'plugin')) assert.ok(html().includes('No runs match.'));
  // Show more: ten at a time.
  await ctl.handle('analytics-app-feature', control(''));
  const many = copy(app);
  many.recent = Array.from({ length: 25 }, (_, i) => ({ ...app.recent[0], id: `r${i}` }));
  const big = harness({ saved: { mode: 'app' }, answers: { analytics_app: many } });
  await big.ctl.open();
  assert.equal(runsOf(big.html()).length, 10);
  assert.ok(big.html().includes('data-action="analytics-more" data-value="runs"'));
  await big.ctl.handle('analytics-more', control('runs'));
  assert.equal(runsOf(big.html()).length, 20);
  await big.ctl.handle('analytics-app-list', control('failed'));
  await big.ctl.handle('analytics-app-list', control('all'));
  assert.equal(runsOf(big.html()).length, 10, 'a new filter starts at ten again');
  // The terminal switch.
  await ctl.handle('analytics-app-terminal', control('on'));
  assert.equal(state.analytics.appTerm, true);
  assert.ok('appTrend' in analyticsCharts(state.analytics, ctl.viewData()));
  await ctl.handle('analytics-app-terminal', control('off'));
  assert.equal(state.analytics.appTerm, false);
});

test('App analytics reads analytics_app for the range: on open, on the switch, on a new range, and Try again', async () => {
  const { ctl, state, calls, html } = harness();
  await ctl.open();
  assert.ok(!ops(calls).includes('analytics_app'), 'the AI tab reads no App analytics');
  calls.query.length = 0;
  await ctl.handle('analytics-mode', control('app'));
  const { from, to } = presetRange('30d', NOW, ZONE);
  assert.deepEqual(calls.query, [['analytics_app', { from, to }]]);
  assert.ok(html().includes('class="ws-an-app"') && html().includes(e(usd(app.totals.costUsd, true))));
  // A new range in App mode reads App analytics again, and the AI tab once it is back.
  calls.query.length = 0;
  await ctl.handle('analytics-range', control('7d'));
  const week = presetRange('7d', NOW, ZONE);
  assert.deepEqual(calls.query, [['analytics_app', { from: week.from, to: week.to }]]);
  calls.query.length = 0;
  await ctl.handle('analytics-mode', control('ai'));
  assert.deepEqual(ops(calls).filter(op => op === 'analytics_view'), ['analytics_view']);
  assert.equal(calls.query.find(([op]) => op === 'analytics_view')[1].from, week.from);
  assert.equal(state.analytics.mode, 'ai');
  // Opened on the App tab: App analytics is read whatever the CLI can do.
  const old = harness({ saved: { mode: 'app' }, answers: { analytics_status: { ...status, state: 'needs_cli' } } });
  await old.ctl.open();
  assert.ok(ops(old.calls).includes('analytics_app'));
  assert.ok(old.html().includes(e(usd(app.totals.costUsd, true))));
  // A summary still on its way for the old range is dropped: back on the AI tabs, the new range is read.
  let releaseView;
  const racing = harness({ saved: { mode: 'app' }, answers: { analytics_view: () => new Promise(resolve => { releaseView = () => resolve(summary); }) } });
  const opening = racing.ctl.open();
  while (!releaseView) await new Promise(resolve => setImmediate(resolve));
  await racing.ctl.handle('analytics-range', control('7d'));
  releaseView();
  await opening;
  racing.calls.query.length = 0;
  releaseView = null;
  const back = racing.ctl.handle('analytics-mode', control('ai'));
  for (let i = 0; i < 50 && !releaseView; i++) await new Promise(resolve => setImmediate(resolve));
  releaseView?.();
  await back;
  assert.deepEqual(racing.calls.query.filter(([op]) => op === 'analytics_view').map(([, body]) => body.from), [week.from]);
  // A read that fails says so, with Try again.
  let fail = true;
  const broken = harness({
    saved: { mode: 'app' },
    answers: { analytics_app: () => { if (fail) throw Object.assign(new Error('Workspace storage could not complete the operation.'), { code: 'io' }); return app; } },
  });
  await broken.ctl.open();
  assert.ok(broken.html().includes('Workspace storage could not complete the operation.'));
  assert.ok(broken.html().includes('data-action="analytics-reload"'));
  fail = false;
  broken.calls.query.length = 0;
  await broken.ctl.handle('analytics-reload', control());
  assert.deepEqual(ops(broken.calls), ['analytics_app']);
  assert.ok(broken.html().includes(e(usd(app.totals.costUsd, true))));
  // While it loads: the App container with a spinner.
  let release;
  const slow = harness({ answers: { analytics_app: () => new Promise(resolve => { release = () => resolve(app); }) } });
  await slow.ctl.open();
  const switching = slow.ctl.handle('analytics-mode', control('app'));
  assert.ok(slow.html().includes('class="ws-an-app"') && slow.html().includes('Reading App analytics'));
  while (!release) await new Promise(resolve => setImmediate(resolve));
  release();
  await switching;
});
