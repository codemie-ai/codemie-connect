// The Analytics page's pure renderers over the contract fixtures: every number shown is the CLI's
// own, formatted. Expected values are read from the fixtures, so a regenerated fixture still holds.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { analyticsView, analyticsCharts } from '../workspace/view-analytics.js';
import {
  newAnalyticsView, usd, tok, dur, n0, pct, pctPoints, modelLabel, projectName, agentLabel, dayKeyIn,
} from '../workspace/analytics-model.js';
import { escapeHtml as e } from '../workspace/store.js';

const fixture = name => JSON.parse(readFileSync(new URL(`fixtures/contract/${name}`, import.meta.url), 'utf8'));
const summary = fixture('analytics-summary.json');
const status = fixture('analytics-status.json');
const running = fixture('analytics-status-running.json');
const ZONE = 'UTC';
const NOW = status.lastFetchAt + 4 * 60_000;

const ui = (over = {}) => ({ ...newAnalyticsView(), ...over });
const data = (over = {}) => ({ status, summary, progress: null, loading: false, error: '', now: NOW, zone: ZONE, ...over });
const count = (html, needle) => html.split(needle).length - 1;

test('overview shows the four KPIs from totals, the trend chart and tools/models/projects cards', () => {
  const t = summary.totals;
  const html = analyticsView(ui(), data());
  for (const label of ['Estimated cost', 'Sessions', 'Active time', 'Code changed']) assert.ok(html.includes(`>${label}`), label);
  assert.ok(html.includes(e(usd(t.costUSD, true))));
  assert.ok(html.includes(`>${n0(t.sessions)}<`));
  assert.ok(html.includes(e(dur(t.durationMs))));
  assert.ok(html.includes(`+${n0(t.netLines)}`));
  assert.ok(html.includes(`${n0(t.filesChanged)} files`));
  // No comparison was sent, so no delta.
  assert.ok(!html.includes('ws-an-delta'));
  // The trend chart: one band per series item, a tooltip on each.
  assert.equal(count(html, 'data-chart="trend"'), 1);
  const svg = analyticsCharts(ui(), data()).trend(800);
  assert.equal(count(svg, 'class="ws-an-band"'), summary.series.length);
  assert.ok(svg.includes(e(e(usd(summary.series[0].costUSD)))));
  // The table view shows the same numbers instead.
  const table = analyticsView(ui({ tables: { trend: true } }), data());
  assert.ok(!table.includes('data-chart="trend"'));
  assert.ok(table.includes(`<td class="ws-an-r">${e(usd(summary.series[0].costUSD))}</td>`));
  // Tools: the first six, with the CLI's own success rate.
  for (const tool of summary.tools.slice(0, 6)) assert.ok(html.includes(`>${e(tool.name)}<`), tool.name);
  assert.ok(html.includes(`${pctPoints(summary.tools[0].successRate)} ok`));
  assert.ok(html.includes(`Show all ${summary.tools.length}`));
  for (const m of summary.models) assert.ok(html.includes(e(modelLabel(m.model))) && html.includes(e(usd(m.costUSD))), m.model);
  // Projects filter the page when clicked.
  for (const p of summary.projects) assert.ok(html.includes(`data-action="analytics-project" data-value="${e(p.project)}"`), p.project);
  // The skills tab of the same card.
  const skills = analyticsView(ui({ inv: 'skills' }), data());
  for (const s of summary.skills) assert.ok(skills.includes(`>${e(s.name)}<`), s.name);
});

test('a delta shows only beside the numbers the CLI compared', () => {
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
  assert.ok(html.includes(`${pct(ef.dead.shareOfCost)} of cost · ${ef.dead.sessions} sessions`));
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
  // No dead session in the fixture: its list says so; the heaviest list has the CLI's rows.
  assert.ok(html.includes(`Changed nothing · ${ef.dead.sessions}`));
  const heavy = analyticsView(ui({ view: 'efficiency', list: 'heavy' }), data());
  for (const r of ef.heavy) assert.ok(heavy.includes(`data-action="analytics-open-session" data-value="${e(r.sessionId)}"`) && heavy.includes(tok(r.contextPerTurn)));
  const dead = { ...summary, efficiency: { ...ef, dead: { ...ef.dead, sessions: 1, top: [summary.sessions[1]] } } };
  const deadHtml = analyticsView(ui({ view: 'efficiency' }), data({ summary: dead }));
  assert.ok(deadHtml.includes(`data-action="analytics-open-session" data-value="${e(summary.sessions[1].sessionId)}"`));
});

test('sessions list groups by day, newest first, with Running and Started in Connect tags', () => {
  // One row moved to the day before (without a log or a cost), one still running, one started in
  // Connect's terminal.
  const [a, b, c] = summary.sessions;
  const earlier = { ...c, sessionId: 'earlier', startTime: c.startTime - 86_400_000, hadLog: false, costUSD: 0 };
  const rows = [{ ...a, open: true }, { ...b, launchedBy: 'connect-terminal' }, c, earlier];
  const html = analyticsView(ui({ view: 'sessions' }), data({ summary: { ...summary, sessions: [earlier, c, rows[1], rows[0]] } }));
  const order = [...html.matchAll(/data-action="analytics-open-session" data-value="([^"]+)"/g)].map(m => m[1]);
  assert.deepEqual(order, [...rows].sort((x, y) => y.startTime - x.startTime).map(r => r.sessionId));
  const days = new Set(rows.map(r => dayKeyIn(r.startTime, ZONE)));
  assert.equal(count(html, 'class="ws-an-sday"'), days.size);
  // A day's numbers are the CLI's series bucket for that day.
  const bucket = summary.series.find(s => s.from <= a.startTime && a.startTime <= s.to);
  assert.ok(html.includes(`${n0(bucket.sessions)} sessions</span>`) && html.includes(e(usd(bucket.costUSD))));
  assert.equal(count(html, 'ws-an-tag-live'), 1);
  assert.equal(count(html, 'ws-an-tag-connect'), 1);
  assert.ok(html.includes('title="Started in Connect&#39;s terminal"'));
  for (const r of rows) assert.ok(html.includes(e(r.title)) && html.includes(e(projectName(r.project))) && html.includes(e(agentLabel(r.agentName))));
  // A session without a log or a cost shows none; one the CLI priced anyway shows its cost.
  assert.equal(count(html, 'class="ws-an-c ws-an-cost" title="No log to price">—</span>'), 1);
  assert.ok(!b.hadLog && html.includes(`<span class="ws-an-c ws-an-cost">${e(usd(b.costUSD))}</span>`));
  // Sorting by cost drops the day groups.
  const byCost = analyticsView(ui({ view: 'sessions', sort: 'cost' }), data());
  const costOrder = [...byCost.matchAll(/data-action="analytics-open-session" data-value="([^"]+)"/g)].map(m => m[1]);
  assert.deepEqual(costOrder, [...summary.sessions].sort((x, y) => y.costUSD - x.costUSD).map(r => r.sessionId));
  assert.ok(!byCost.includes('class="ws-an-sday"'));
  // A search narrows the rows.
  const searched = analyticsView(ui({ view: 'sessions', q: a.title.slice(0, 8) }), data());
  assert.equal(count(searched, 'data-action="analytics-open-session"'), summary.sessions.filter(r => r.title.toLowerCase().includes(a.title.slice(0, 8).toLowerCase())).length);
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
  const progress = { running: true, ...running.progress, failedDays: [] };
  const html = analyticsView(ui({ range: '7d' }), data({ status: running, progress }));
  assert.ok(html.includes(`${e(running.progress.label)} · ${running.progress.done} of ${running.progress.total} days`));
  assert.match(html, /of 7 days read so far/);
  assert.match(html, /<button [^>]*data-action="analytics-refresh"[^>]*disabled/);
  // A bucket that ends before the first stored day is shaded, not drawn as zero.
  const day = 86_400_000;
  const storedFrom = Date.parse(`${running.storedFrom}T00:00:00Z`);
  const series = [{ ...summary.series[0], from: storedFrom - 2 * day, to: storedFrom - day - 1 }, { ...summary.series[0], from: storedFrom, to: storedFrom + day - 1 }];
  const svg = analyticsCharts(ui({ range: '7d' }), data({ status: running, progress, summary: { ...summary, series } })).trend(800);
  assert.ok(svg.includes('Still reading…'));
  // Once the history is read, nothing is shaded.
  const done = analyticsCharts(ui({ range: '7d' }), data({ summary: { ...summary, series } })).trend(800);
  assert.ok(!done.includes('Still reading…'));
});

test('a day that could not be read is named with a Try again', () => {
  const html = analyticsView(ui(), data());
  assert.ok(html.includes(`1 day couldn&#39;t be read (Sun 15 Nov)`));
  assert.ok(html.includes(`data-action="analytics-retry" data-value="${status.failedDays[0]}"`));
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
  for (const c of summary.coverage) assert.ok(hidden.includes(e(agentLabel(c.agentName))) && hidden.includes(`${n0(c.sessions)} sessions`));
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
