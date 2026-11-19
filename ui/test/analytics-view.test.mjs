// The Analytics page's pure renderers over the contract fixtures: every number shown is the CLI's
// own, formatted. Expected values are read from the fixtures, and every case a fixture may or may
// not contain (a comparison, a session without a log, a failed day) is built on a copy, so a
// regenerated fixture still holds.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { analyticsView, analyticsCharts } from '../workspace/view-analytics.js';
import {
  newAnalyticsView, usd, tok, dur, n0, pct, pctPoints, plural, modelLabel, projectName, agentLabel, dayKeyIn, dayKeyLabel,
} from '../workspace/analytics-model.js';
import { escapeHtml as e } from '../workspace/store.js';

const fixture = name => JSON.parse(readFileSync(new URL(`fixtures/contract/${name}`, import.meta.url), 'utf8'));
const summary = fixture('analytics-summary.json');
const status = fixture('analytics-status.json');
const running = fixture('analytics-status-running.json');
const ZONE = 'UTC';
const NOW = status.lastFetchAt + 4 * 60_000;
const DAY = 86_400_000;

const ui = (over = {}) => ({ ...newAnalyticsView(), ...over });
const data = (over = {}) => ({ status, summary, progress: null, loading: false, error: '', now: NOW, zone: ZONE, ...over });
const count = (html, needle) => html.split(needle).length - 1;
const opened = html => [...html.matchAll(/data-action="analytics-open-session" data-value="([^"]+)"/g)].map(m => m[1]);
/** The HTML of one session row of the list. */
const rowOf = (html, id) => {
  const start = html.indexOf(`data-action="analytics-open-session" data-value="${id}"`);
  return start < 0 ? '' : html.slice(start, html.indexOf('</button>', start));
};

test('overview shows the four KPIs from totals, the trend chart and tools/models/projects cards', () => {
  const t = summary.totals;
  const html = analyticsView(ui(), data());
  for (const label of ['Estimated cost', 'Sessions', 'Active time', 'Code changed']) assert.ok(html.includes(`>${label}`), label);
  assert.ok(html.includes(e(usd(t.costUSD, true))));
  assert.ok(html.includes(`>${n0(t.sessions)}<`));
  assert.ok(html.includes(e(dur(t.durationMs))));
  assert.ok(html.includes(`${t.netLines >= 0 ? '+' : ''}${n0(t.netLines)}`));
  assert.ok(html.includes(`${n0(t.filesChanged)} files`));
  // The trend chart: one band per series item, a tooltip on each.
  assert.equal(count(html, 'data-chart="trend"'), 1);
  const svg = analyticsCharts(ui(), data()).trend(800);
  assert.equal(count(svg, 'class="ws-an-band"'), summary.series.length);
  assert.ok(svg.includes(e(e(usd(summary.series[0].costUSD)))));
  // The table view shows the same numbers instead.
  const table = analyticsView(ui({ tables: { trend: true } }), data());
  assert.ok(!table.includes('data-chart="trend"'));
  assert.ok(table.includes(`<td class="ws-an-r">${e(usd(summary.series[0].costUSD))}</td>`));
  // Tools: the first six, with the CLI's own success rate; "Show all" only past six.
  for (const tool of summary.tools.slice(0, 6)) assert.ok(html.includes(`>${e(tool.name)}<`), tool.name);
  assert.ok(html.includes(`${pctPoints(summary.tools[0].successRate)} ok`));
  assert.equal(html.includes(`Show all ${summary.tools.length}`), summary.tools.length > 6);
  for (const m of summary.models) assert.ok(html.includes(e(modelLabel(m.model))) && html.includes(e(usd(m.costUSD))), m.model);
  // Projects filter the page when clicked.
  for (const p of summary.projects) assert.ok(html.includes(`data-action="analytics-project" data-value="${e(p.project)}"`), p.project);
  // The skills tab of the same card.
  const skills = analyticsView(ui({ inv: 'skills' }), data());
  for (const s of summary.skills) assert.ok(skills.includes(`>${e(s.name)}<`), s.name);
});

test('a delta shows only beside the numbers the CLI compared', () => {
  // Without `previous` and `change` (no comparison asked, or not stored that far back): none.
  const plain = analyticsView(ui(), data({ summary: { ...summary, previous: null, change: null } }));
  assert.ok(!plain.includes('ws-an-delta'));
  // A `change` without `previous` isn't shown either.
  const half = analyticsView(ui(), data({ summary: { ...summary, previous: null, change: { costUSD: 0.4, sessions: 0.1, durationMs: 0.2 } } }));
  assert.ok(!half.includes('ws-an-delta'));
  // With both: a delta beside each field the CLI compared (a null field has none).
  const compared = { ...summary, previous: summary.totals, change: { costUSD: 0.4, sessions: null, durationMs: -0.1 } };
  const html = analyticsView(ui(), data({ summary: compared }));
  assert.equal(count(html, 'class="ws-an-delta"'), 2);
  assert.ok(html.includes('↑ 40%') && html.includes('↓ 10%') && html.includes('vs previous 30 days'));
});

test('efficiency shows dead sessions, depth buckets with the CLI labels and the token mix', () => {
  const ef = summary.efficiency;
  const html = analyticsView(ui({ view: 'efficiency' }), data());
  assert.ok(html.includes('Spend that changed nothing'));
  assert.ok(html.includes(e(usd(ef.dead.costUSD))));
  assert.ok(html.includes(`${pct(ef.dead.shareOfCost)} of cost · ${n0(ef.dead.sessions)} sessions`));
  assert.ok(html.includes(e(usd(ef.costPerFileUSD))));
  assert.ok(html.includes(pctPoints(ef.toolSuccessRate)));
  assert.ok(html.includes(tok(ef.contextPerTurn)));
  assert.ok(html.includes(`median ${n0(ef.depth.median)} turns · average ${n0(ef.depth.average)}`));
  // The depth chart keeps the CLI's bucket labels, as the table does.
  const svg = analyticsCharts(ui({ view: 'efficiency' }), data()).depth(600);
  assert.equal(count(svg, 'class="ws-an-band"'), ef.depth.buckets.length);
  for (const b of ef.depth.buckets) assert.ok(svg.includes(`>${e(b.label)}</text>`), b.label);
  const table = analyticsView(ui({ view: 'efficiency', tables: { depth: true } }), data());
  for (const b of ef.depth.buckets) assert.ok(table.includes(`<td>${e(b.label)}</td><td class="ws-an-r">${n0(b.sessions)}</td>`), b.label);
  // Where tokens go: the four kinds the CLI counted.
  for (const k of ['cacheRead', 'output', 'cacheCreation', 'input']) assert.ok(html.includes(tok(summary.totals.tokens[k])), k);
  // The two lists: the CLI's dead sessions and its heaviest ones, each row opening its session.
  assert.ok(html.includes(`Changed nothing · ${n0(ef.dead.sessions)}`));
  const heavy = analyticsView(ui({ view: 'efficiency', list: 'heavy' }), data());
  for (const r of ef.heavy) assert.ok(heavy.includes(`data-action="analytics-open-session" data-value="${e(r.sessionId)}"`) && heavy.includes(tok(r.contextPerTurn)));
  const [first] = summary.sessions;
  const none = analyticsView(ui({ view: 'efficiency' }), data({ summary: { ...summary, efficiency: { ...ef, dead: { ...ef.dead, sessions: 0, top: [] } } } }));
  assert.ok(none.includes('Every session in this range changed something.'));
  const dead = analyticsView(ui({ view: 'efficiency' }), data({ summary: { ...summary, efficiency: { ...ef, dead: { ...ef.dead, sessions: 1, top: [first] } } } }));
  assert.ok(dead.includes(`data-action="analytics-open-session" data-value="${e(first.sessionId)}"`));
});

test('sessions list groups by day, newest first, with a Started in Connect tag', () => {
  // Rows made from the fixture's first session: three on its day, one the day before without a
  // log or a cost, and one without a log that the CLI priced anyway.
  const [base] = summary.sessions;
  const T = base.startTime;
  const row = (id, over) => ({ ...base, sessionId: id, title: `${base.title} ${id}`, hadLog: true, costUSD: 1.25, ...over });
  const rows = [row('a', { startTime: T }), row('b', { startTime: T - 1000, hadLog: false, costUSD: 0.5 }), row('c', { startTime: T - 2000 }), row('earlier', { startTime: T - DAY, hadLog: false, costUSD: 0 })];
  const listed = { ...summary, sessions: [rows[3], rows[2], rows[0], rows[1]], connect: { startedInConnect: ['b'] } };
  const html = analyticsView(ui({ view: 'sessions' }), data({ summary: listed }));
  assert.deepEqual(opened(html), [...rows].sort((x, y) => y.startTime - x.startTime).map(r => r.sessionId));
  const days = new Set(rows.map(r => dayKeyIn(r.startTime, ZONE)));
  assert.equal(count(html, 'class="ws-an-sday"'), days.size);
  // A day's numbers are the CLI's series bucket for that day.
  const bucket = summary.series.find(s => s.from <= T && T <= s.to);
  assert.ok(html.includes(`${n0(bucket.sessions)} ${plural(bucket.sessions, 'session')}</span>`) && html.includes(e(usd(bucket.costUSD))));
  for (const r of rows) assert.ok(html.includes(e(r.title)) && html.includes(e(projectName(r.project))) && html.includes(e(agentLabel(r.agentName))));
  // Started in Connect: exactly the row analytics_view's `connect.startedInConnect` names.
  assert.equal(count(html, 'ws-an-tag-connect'), 1);
  assert.ok(rowOf(html, 'b').includes('ws-an-tag-connect') && rowOf(html, 'b').includes('title="Started in Connect&#39;s terminal"'));
  const { connect, ...cliOnly } = listed;
  assert.equal(count(analyticsView(ui({ view: 'sessions' }), data({ summary: cliOnly })), 'ws-an-tag-connect'), 0);
  // No running signal exists in the CLI's export, so no Running tag.
  assert.ok(!html.includes('Running'));
  // A session without a log or a cost shows none; one the CLI priced anyway shows its cost.
  assert.equal(count(html, 'class="ws-an-c ws-an-cost" title="No log to price">—</span>'), 1);
  assert.ok(rowOf(html, 'earlier').includes('title="No log to price">—'));
  assert.ok(rowOf(html, 'b').includes(`<span class="ws-an-c ws-an-cost">${e(usd(0.5))}</span>`));
  // Sorting by cost drops the day groups.
  const byCost = analyticsView(ui({ view: 'sessions', sort: 'cost' }), data());
  assert.deepEqual(opened(byCost), [...summary.sessions].sort((x, y) => y.costUSD - x.costUSD).map(r => r.sessionId));
  assert.ok(!byCost.includes('class="ws-an-sday"'));
  // A search narrows the rows (title, project, branch and models are searched).
  const q = summary.sessions[0].title.slice(0, 8).toLowerCase();
  const searched = analyticsView(ui({ view: 'sessions', q }), data());
  assert.equal(opened(searched).length, summary.sessions.filter(r => [r.title, r.project, r.branch, ...(r.models || [])].join(' ').toLowerCase().includes(q)).length);
});

test('needs_cli renders the update state and no data cards', () => {
  const html = analyticsView(ui(), data({ status: { ...status, state: 'needs_cli' }, summary: null }));
  assert.ok(html.includes('Analytics needs a newer CodeMie CLI.'));
  assert.ok(html.includes('data-action="settings-tab"') && html.includes('data-tab="cm-overview"'));
  for (const card of ['ws-an-kpis', 'data-chart', 'ws-an-card', 'analytics-refresh', 'ws-an-filters']) assert.ok(!html.includes(card), card);
  // The App tab stays reachable.
  assert.ok(html.includes('data-action="analytics-mode" data-value="app"'));
});

test('an empty Mac says where sessions come from, with Refresh on', () => {
  const html = analyticsView(ui(), data({ status: { ...status, state: 'empty', sessions: 0 }, summary: null }));
  assert.ok(html.includes('No coding-agent sessions on this Mac yet'));
  assert.ok(html.includes(e("Sessions from Claude Code, codemie-claude or Connect's terminal show up here after a refresh.")));
  assert.match(html, /<button [^>]*data-action="analytics-refresh"(?![^>]*disabled)/);
  assert.ok(!html.includes('ws-an-kpis'));
});

test('a first open still reading says how many days are in and shades the rest', () => {
  // History stored from two days before today; the fetch still runs.
  const storedFrom = dayKeyIn(NOW - 2 * DAY, ZONE);
  const reading = { ...running, storedFrom };
  const progress = { running: true, ...running.progress, failedDays: [] };
  const html = analyticsView(ui({ range: '7d' }), data({ status: reading, progress }));
  assert.ok(html.includes(`${e(progress.label)} · ${n0(progress.done)} of ${n0(progress.total)} days`));
  assert.ok(html.includes('3 of 7 days read so far'));
  assert.match(html, /<button [^>]*data-action="analytics-refresh"[^>]*disabled/);
  // A bucket that ends before the first stored day is shaded, not drawn as zero.
  const stored = Date.parse(`${storedFrom}T00:00:00Z`);
  const series = [{ ...summary.series[0], from: stored - 2 * DAY, to: stored - DAY - 1 }, { ...summary.series[0], from: stored, to: stored + DAY - 1 }];
  const svg = analyticsCharts(ui({ range: '7d' }), data({ status: reading, progress, summary: { ...summary, series } })).trend(800);
  assert.ok(svg.includes('Still reading…'));
  // Once the history is read, nothing is shaded.
  const done = analyticsCharts(ui({ range: '7d' }), data({ summary: { ...summary, series } })).trend(800);
  assert.ok(!done.includes('Still reading…'));
});

test('a day that could not be read is named with a Try again', () => {
  const day = status.failedDays[0] ?? '2026-11-15';
  const one = analyticsView(ui(), data({ status: { ...status, failedDays: [day] } }));
  assert.ok(one.includes(`1 day couldn&#39;t be read (${e(dayKeyLabel(day))})`));
  assert.ok(one.includes(`data-action="analytics-retry" data-value="${day}"`));
  const two = analyticsView(ui(), data({ status: { ...status, failedDays: [day, '2026-11-01'] } }));
  assert.ok(two.includes(`2 days couldn&#39;t be read (${e(dayKeyLabel(day))} and others)`));
  assert.ok(!analyticsView(ui(), data({ status: { ...status, failedDays: [] } })).includes('analytics-retry'));
});

test('the notice hides into a "Local sessions only" chip', () => {
  const shown = analyticsView(ui(), data());
  assert.ok(shown.includes('Based on sessions saved on this Mac.'));
  assert.ok(shown.includes('data-action="analytics-notice" data-value="hide"'));
  assert.ok(!shown.includes('Local sessions only'));
  const hidden = analyticsView(ui({ noticeHidden: true }), data());
  assert.ok(!hidden.includes('Based on sessions saved on this Mac.'));
  assert.ok(hidden.includes('Local sessions only'));
  assert.ok(hidden.includes('data-action="analytics-notice" data-value="show"'));
  // What's counted: coverage per agent, sessions started outside CodeMie included, no toggle.
  for (const c of summary.coverage) assert.ok(hidden.includes(e(agentLabel(c.agentName))) && hidden.includes(`${n0(c.sessions)} ${plural(c.sessions, 'session')}`));
  assert.ok(hidden.includes('started outside CodeMie'));
  assert.ok(!hidden.includes('role="switch"'));
});

test('the App tab leaves a container for its own view', () => {
  const html = analyticsView(ui({ mode: 'app' }), data());
  assert.ok(html.includes('class="ws-an-app"'));
  assert.ok(!html.includes('ws-an-kpis') && !html.includes('analytics-refresh'));
});

test('provider text is escaped', () => {
  const bad = '<script>alert(1)</script>';
  const evil = {
    ...summary,
    sessions: summary.sessions.map(s => ({ ...s, title: bad, project: `/Users/x/${bad}`, branch: bad, models: [bad] })),
    tools: summary.tools.map(t => ({ ...t, name: bad })),
    skills: summary.skills.map(t => ({ ...t, name: bad })),
    models: summary.models.map(m => ({ ...m, model: bad })),
    projects: summary.projects.map(p => ({ ...p, project: `/Users/x/${bad}` })),
    agentsUsed: summary.agentsUsed.map(a => ({ ...a, agentName: bad })),
    coverage: summary.coverage.map(c => ({ ...c, agentName: bad })),
    connect: { startedInConnect: [bad] },
    efficiency: { ...summary.efficiency, heavy: summary.efficiency.heavy.map(h => ({ ...h, title: bad })), depth: { ...summary.efficiency.depth, buckets: summary.efficiency.depth.buckets.map(b => ({ ...b, label: bad })) } },
  };
  for (const over of [{}, { inv: 'skills' }, { view: 'efficiency', list: 'heavy' }, { view: 'sessions' }, { agent: bad, project: `/Users/x/${bad}` }]) {
    const u = ui(over);
    const html = analyticsView(u, data({ summary: evil }));
    assert.ok(!/<script|<img/i.test(html), JSON.stringify(over));
    assert.ok(html.includes('&lt;script&gt;'), JSON.stringify(over));
    for (const draw of Object.values(analyticsCharts(u, data({ summary: evil })))) assert.ok(!/<script/i.test(draw(700)));
  }
});
