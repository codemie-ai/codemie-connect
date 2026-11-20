// The session drawer over the real CLI answer (`codemie.analytics.session/1`): the step tree is the
// CLI's `trace[]` as it is, and every number is the session record's or a dispatch's own field.
// Expected values are read from the fixture; cases it may not hold are built on a copy.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { sessionDrawer, sessionCharts, hms, tlDur } from '../workspace/view-analytics-session.js';
import { createAnalyticsController } from '../workspace/analytics-controller.js';
import { analyticsView, analyticsCharts } from '../workspace/view-analytics.js';
import { usd, tok, n0, pctPoints, agentLabel, modelLabel, projectName } from '../workspace/analytics-model.js';
import { escapeHtml as e } from '../workspace/store.js';

const fixture = name => JSON.parse(readFileSync(new URL(`fixtures/contract/${name}`, import.meta.url), 'utf8'));
const detail = fixture('analytics-session.json');
const summary = fixture('analytics-summary.json');
const status = fixture('analytics-status.json');
const s = detail.session;
const ZONE = 'UTC';
const NOW = s.startTime + 86_400_000;
const copy = value => structuredClone(value);

const ui = (over = {}) => ({ tab: 'trace', selected: 'session', collapsed: new Set(), zone: ZONE, now: NOW, ...over });
/** The tree's rows in order: `[step, level]` (the Session row has no level). */
const rowsOf = html => [...html.matchAll(/data-step="([^"]*)"(?: data-level="(\d+)")?/g)].map(m => [m[1], m[2] === undefined ? null : Number(m[2])]);
/** The side panel's HTML. */
const sideOf = html => html.slice(html.indexOf('class="ws-an-side"'), html.indexOf('</aside>', html.indexOf('class="ws-an-side"')));
/** The value of the KPI labelled `label` (the first one). */
const kpiValue = (html, label) => {
  const v = html.indexOf('class="ws-an-kpi-v">', html.indexOf(`>${label}`));
  return html.slice(v + 20, html.indexOf('</div>', v));
};
/** The drawer's HTML on the page. */
const drawerOf = html => html.slice(Math.max(0, html.indexOf('class="ws-an-drawer"')));
/** The dispatch a trace entry stands for (the fixture's ids are unique). */
const dispatchOf = key => s.dispatches.find(d => String(d.id) === key);
const parent = detail.trace.find(t => t.childKeys.length > 0);

test('trace lists the Session row first, then steps at their CLI level with #n labels', () => {
  const html = sessionDrawer(detail, ui());
  assert.deepEqual(rowsOf(html), [['session', null], ...detail.trace.map(t => [e(t.key), t.level])]);
  for (const t of detail.trace) assert.ok(html.includes(`>${e(t.label)}<`), t.label);
  // The labels are the CLI's: repeats keep its #n numbering and are not counted again here.
  const repeated = copy(detail);
  const [a, b] = repeated.trace.filter(t => t.kind === 'skill');
  Object.assign(a, { name: 'review', label: 'review #2' });
  Object.assign(b, { name: 'review', label: 'review #1' });
  const again = sessionDrawer(repeated, ui());
  assert.ok(again.indexOf('>review #2<') < again.indexOf('>review #1<'));
  assert.ok(!again.includes('>review<'));
  // The level is the CLI's, also where it differs from what the parent links would give.
  const deep = copy(detail);
  deep.trace[0].level = 3;
  assert.deepEqual(rowsOf(sessionDrawer(deep, ui()))[1], [e(deep.trace[0].key), 3]);
  // The summary line counts the tree's own rows by kind.
  const agents = detail.trace.filter(t => t.kind === 'agent').length;
  const skills = detail.trace.filter(t => t.kind === 'skill').length;
  assert.ok(html.includes(`${agents} subagents · ${skills} skills`));
  // A step with children has a chevron that collapses it; a leaf has none.
  assert.ok(html.includes(`data-action="analytics-step-toggle" data-value="${e(parent.key)}"`));
  const leaf = detail.trace.find(t => !t.childKeys.length);
  assert.ok(!html.includes(`data-action="analytics-step-toggle" data-value="${e(leaf.key)}"`));
});

test('selecting a step shows parent link, own vs total cost, timing evidence, tools and children', () => {
  const child = detail.trace.find(t => t.parentKey === parent.key);
  const childSide = sideOf(sessionDrawer(detail, ui({ selected: child.key })));
  assert.ok(childSide.includes(`Parent: ${e(parent.label)}`));
  assert.ok(childSide.includes(`data-action="analytics-step" data-value="${e(parent.key)}"`));
  assert.ok(childSide.includes(`nesting level ${dispatchOf(child.key).depth}`));
  const html = sessionDrawer(detail, ui({ selected: parent.key }));
  assert.ok(html.includes(`class="ws-an-tl-row ws-an-sel" data-step="${e(parent.key)}"`));
  const side = sideOf(html);
  const d = dispatchOf(parent.key);
  assert.ok(side.includes(`>${e(parent.label)}<`));
  assert.ok(side.includes('Belongs to the session itself.'));
  // Total (children included) and its own share, both the dispatch's fields.
  assert.ok(side.includes(`Total cost</dt><dd>${e(usd(d.inclusiveCostUSD, true))}`));
  assert.ok(side.includes(`Total tokens</dt><dd>${n0(d.inclusiveTokens.total)}`));
  assert.ok(side.includes('This subagent alone'));
  assert.ok(side.includes(`Its own cost</dt><dd>${e(usd(d.costUSD, true))}`));
  assert.ok(side.includes(`Its own tokens</dt><dd>${n0(d.tokens.total)}`));
  assert.ok(side.includes(`${e(tlDur(d.elapsedMs))}`) && side.includes(`${n0(d.elapsedMs)} ms`));
  // Timing evidence: the times the CLI recorded.
  for (const [label, at] of [['Started', d.start], ['Acknowledged', d.acknowledgedAt], ['Last activity', d.observedEnd], ['Completed', d.completedAt]]) {
    assert.ok(side.includes(`<span>${label}</span><time>${hms(at, ZONE)}</time>`), label);
  }
  // Tools it called and its child steps, each child a link.
  for (const tool of d.tools) assert.ok(side.includes(`${e(tool.name)} <b>×${n0(tool.calls)}</b>`), tool.name);
  assert.ok(side.includes(`Child steps (${parent.childKeys.length})`));
  for (const key of parent.childKeys) {
    const c = detail.trace.find(t => t.key === key);
    assert.ok(side.includes(`data-action="analytics-step" data-value="${e(key)}"`) && side.includes(e(c.label)), key);
  }
  // Its ID can be copied.
  assert.ok(side.includes(`data-action="analytics-copy" data-value="${e(d.id)}"`));
  // A skill the CLI estimated says so instead of claiming a cost of its own.
  const skill = detail.trace.find(t => dispatchOf(t.key)?.attributionStatus === 'estimated');
  if (skill) {
    const skillSide = sideOf(sessionDrawer(detail, ui({ selected: skill.key })));
    assert.ok(skillSide.includes(`Estimated cost</dt><dd>${e(usd(dispatchOf(skill.key).costUSD, true))}`));
    assert.ok(skillSide.includes('it isn’t extra'));
  }
});

test('collapsing a parent hides its children but keeps the parent row', () => {
  const open = rowsOf(sessionDrawer(detail, ui())).map(([k]) => k);
  for (const key of parent.childKeys) assert.ok(open.includes(e(key)), key);
  const html = sessionDrawer(detail, ui({ collapsed: new Set([parent.key]) }));
  const shown = rowsOf(html).map(([k]) => k);
  assert.ok(shown.includes(e(parent.key)));
  for (const key of parent.childKeys) assert.ok(!shown.includes(e(key)), key);
  assert.equal(shown.length, open.length - parent.childKeys.length);
  assert.ok(html.includes(`aria-expanded="false" data-action="analytics-step-toggle" data-value="${e(parent.key)}"`));
  // Grandchildren go too: a collapsed step hides everything below it.
  const deep = copy(detail);
  const [first, second] = parent.childKeys;
  const grand = deep.trace.find(t => t.key === second);
  grand.parentKey = first;
  grand.level = 2;
  deep.trace.find(t => t.key === first).childKeys = [second];
  const below = rowsOf(sessionDrawer(deep, ui({ collapsed: new Set([first]) }))).map(([k]) => k);
  assert.ok(below.includes(e(first)) && !below.includes(e(second)));
});

test('the Session row shows where the cost went and hides the subagent row when there are none', () => {
  const side = sideOf(sessionDrawer(detail, ui()));
  assert.ok(side.includes(`Total cost</dt><dd>${e(usd(s.costUSD, true))}`));
  assert.ok(side.includes(`Turns</dt><dd>${n0(s.turns)}`));
  assert.ok(side.includes('Where the cost went'));
  assert.ok(side.includes(`<td>The session itself</td><td class="ws-an-r">${tok(s.rootOwnTokens.total)}</td><td class="ws-an-r">${e(usd(s.rootOwnCostUSD, true))}</td>`));
  // One row per top-level subagent: its total, children included, as the CLI attributed it.
  const tops = detail.trace.filter(t => t.kind === 'agent' && !t.parentKey);
  assert.equal((side.match(/class="ws-an-where-agent"/g) || []).length, tops.length);
  assert.ok(side.includes('ws-an-where-note'));
  for (const t of tops) {
    const d = dispatchOf(t.key);
    assert.ok(side.includes(`${e(t.label)}</td><td class="ws-an-r">${tok((d.inclusiveTokens || d.tokens).total)}</td><td class="ws-an-r">${e(usd(d.inclusiveCostUSD ?? d.costUSD, true))}</td>`), t.label);
  }
  assert.ok(side.includes(`<td>Total</td><td class="ws-an-r">${tok(s.tokens.total)}</td><td class="ws-an-r">${e(usd(s.costUSD, true))}</td>`));
  assert.equal(side.includes('Not linked to a step'), (s.unlinkedCostUSD || 0) > 0);
  // Timing: the CLI's start and its last observed activity.
  assert.ok(side.includes(`<span>Started</span><time>${hms(s.startTime, ZONE)}</time>`));
  assert.ok(side.includes(`<span>Last activity</span><time>${hms(s.observedEnd, ZONE)}</time>`));
  // The top-level steps link to themselves.
  const roots = detail.trace.filter(t => !t.parentKey);
  assert.ok(side.includes(`Steps (${detail.trace.length})`));
  for (const t of roots) assert.ok(side.includes(`data-action="analytics-step" data-value="${e(t.key)}"`), t.key);
  // Usage no step claimed shows as its own row.
  const unlinked = copy(detail);
  unlinked.session.unlinkedCostUSD = 0.5;
  unlinked.session.unlinkedTokens = { ...s.unlinkedTokens, total: 1234 };
  assert.ok(sideOf(sessionDrawer(unlinked, ui())).includes(`<td>Not linked to a step</td><td class="ws-an-r">${tok(1234)}</td><td class="ws-an-r">${e(usd(0.5, true))}</td>`));
  // No subagents: no subagent row, and no note about adding them up.
  const solo = copy(detail);
  solo.trace = solo.trace.filter(t => t.kind !== 'agent').map(t => ({ ...t, parentKey: null, childKeys: [], level: 0 }));
  solo.session.dispatches = solo.session.dispatches.filter(d => d.kind !== 'agent');
  const soloSide = sideOf(sessionDrawer(solo, ui()));
  assert.ok(soloSide.includes('<td>The session itself</td>'));
  assert.ok(!soloSide.includes('ws-an-where-agent'));
  assert.ok(!soloSide.includes('ws-an-where-note'));
  // No steps at all: the agent worked on its own.
  const alone = copy(detail);
  alone.trace = [];
  alone.session.dispatches = [];
  assert.ok(sessionDrawer(alone, ui()).includes('The agent worked on its own'));
});

test('where the cost went has every subagent whose nearest agent ancestor is the session, under a skill too', () => {
  // The fixture's top-level subagents, then one of them moved under a top-level skill.
  const expected = detail.trace.filter(t => t.kind === 'agent' && !t.parentKey);
  const moved = copy(detail);
  const skill = moved.trace.find(t => t.kind === 'skill' && !t.parentKey);
  const agent = moved.trace.find(t => t.kind === 'agent' && !t.parentKey && !t.childKeys.length);
  Object.assign(agent, { parentKey: skill.key, level: 1 });
  skill.childKeys = [agent.key];
  const side = sideOf(sessionDrawer(moved, ui()));
  assert.equal((side.match(/class="ws-an-where-agent"/g) || []).length, expected.length);
  assert.ok(side.includes(`↳ ${e(agent.label)}</td>`));
  // The rows are the record's own fields and still make up its total.
  const own = expected.map(t => dispatchOf(t.key)).reduce((sum, d) => sum + (d.inclusiveCostUSD ?? d.costUSD), 0);
  assert.ok(Math.abs(s.rootOwnCostUSD + own + (s.unlinkedCostUSD || 0) - s.costUSD) < 1e-6);
  for (const t of expected) {
    const d = dispatchOf(t.key);
    assert.ok(side.includes(`<td class="ws-an-r">${e(usd(d.inclusiveCostUSD ?? d.costUSD, true))}</td></tr>`), t.label);
  }
  // A subagent under a skill under a subagent stays inside that subagent's row.
  const deeper = copy(detail);
  const inner = deeper.trace.find(t => t.key === parent.childKeys[0]);
  const step = deeper.trace.find(t => t.kind === 'skill' && !t.parentKey);
  Object.assign(step, { parentKey: parent.key, level: 1 });
  Object.assign(inner, { parentKey: step.key, level: 2 });
  assert.equal((sideOf(sessionDrawer(deeper, ui())).match(/class="ws-an-where-agent"/g) || []).length, expected.length);
});

test('the cost-over-the-session chart switches to a table of the CLI\'s own points', () => {
  const chart = sessionDrawer(detail, ui({ tab: 'cost' }));
  assert.ok(chart.includes('aria-pressed="false" data-action="analytics-table" data-value="sessionGrow"'));
  assert.ok(chart.includes('data-chart="session-grow"'));
  const on = ui({ tab: 'cost', tables: { sessionGrow: true } });
  const html = sessionDrawer(detail, on);
  assert.ok(html.includes('aria-pressed="true" data-action="analytics-table" data-value="sessionGrow"'));
  assert.ok(!html.includes('data-chart="session-grow"'));
  assert.deepEqual(Object.keys(sessionCharts(detail, on)), []);
  const table = html.slice(html.indexOf('class="ws-an-tscroll ws-an-grow-table"'), html.indexOf('</table>', html.indexOf('ws-an-grow-table')));
  const body = table.slice(table.indexOf('<tbody>'));
  assert.equal((body.match(/<tr>/g) || []).length, s.costSeries.length);
  for (const point of s.costSeries) assert.ok(body.includes(`<tr><td>${hms(point.t, ZONE)}</td><td class="ws-an-r">${e(usd(point.cost, true))}</td><td class="ws-an-r">${tok(point.tokens)}</td></tr>`), String(point.t));
  // Points without tokens: no tokens column.
  const bare = copy(detail);
  bare.session.costSeries = bare.session.costSeries.map(({ t: at, cost }) => ({ t: at, cost }));
  assert.ok(!sessionDrawer(bare, on).includes('Tokens so far'));
  // The Trace tab's thin cost lane has no table switch.
  assert.ok(!sessionDrawer(detail, ui()).includes('data-value="sessionGrow"'));
});

test('a session without a log shows the CLI reason instead of costs', () => {
  const reason = 'GitHub Copilot CLI <logs> keep no token usage';
  const nolog = copy(detail);
  Object.assign(nolog.session, { hadLog: false, costUSD: 0, usageUnavailableReason: reason });
  for (const tab of ['trace', 'cost']) {
    const html = sessionDrawer(nolog, ui({ tab }));
    assert.ok(html.includes(e(reason)), tab);
    assert.ok(!html.includes('<logs>'), tab);
    assert.ok(!html.includes('Where the cost went'), tab);
    assert.ok(!html.includes(e(usd(s.costUSD, true))), tab);
  }
  assert.equal(kpiValue(sessionDrawer(nolog, ui()), 'Estimated cost'), '—');
  // No reason given: still no cost, with Connect's own sentence.
  const bare = copy(nolog);
  delete bare.session.usageUnavailableReason;
  assert.ok(sessionDrawer(bare, ui()).includes('This session has no log to price.'));
  // The CLI priced a session without a log anyway: its cost shows.
  const priced = copy(detail);
  priced.session.hadLog = false;
  assert.equal(kpiValue(sessionDrawer(priced, ui()), 'Estimated cost'), e(usd(s.costUSD, true)));
});

test('the header, the five numbers and the Tokens & cost and Tools tabs show the record as it is', () => {
  const html = sessionDrawer(detail, ui({ inConnect: true }));
  assert.ok(html.includes(`>${e(s.title)}</h2>`));
  assert.ok(html.includes(e(agentLabel(s.agentName))));
  assert.ok(html.includes(e(s.sessionSource)));
  assert.ok(html.includes('Started in Connect'));
  assert.ok(!sessionDrawer(detail, ui()).includes('Started in Connect'));
  assert.ok(!html.includes('Running'));
  assert.ok(html.includes(e(s.models.map(modelLabel).join(' → '))));
  assert.ok(html.includes(e(projectName(s.project))) && html.includes(e(s.branch)));
  assert.ok(html.includes(`data-action="analytics-copy" data-value="${e(s.sessionId)}"`));
  assert.ok(html.includes(`data-action="analytics-copy" data-value="${e(s.agentSessionFile)}"`));
  assert.ok(html.includes('data-action="analytics-report"') && html.includes('Open the CLI report'));
  assert.ok(html.includes('data-action="analytics-close"'));
  // The five numbers.
  for (const label of ['Estimated cost', 'Duration', 'Turns', 'Tool calls', 'Code changed']) assert.ok(html.includes(`>${label}<`), label);
  assert.ok(html.includes(`${e(usd(s.cacheReadCostUSD))} on cache reads`));
  assert.ok(html.includes(`${n0(s.toolCallsFailure)} failed · ${n0(s.toolCallsSuccess)} worked`));
  assert.ok(html.includes(`+${n0(s.linesAdded)}`) && html.includes(`−${n0(s.linesRemoved)}`) && html.includes(`${n0(s.filesChanged)} files`));
  // Tokens & cost: the record's tokens and its cost per model.
  const cost = sessionDrawer(detail, ui({ tab: 'cost' }));
  for (const k of ['input', 'output', 'cacheRead', 'cacheCreation', 'total']) assert.ok(cost.includes(tok(s.tokens[k])), k);
  for (const m of s.perModelCost) assert.ok(cost.includes(e(modelLabel(m.model))) && cost.includes(e(usd(m.costUSD, true))), m.model);
  assert.ok(cost.includes('data-chart="session-grow"'));
  assert.ok(cost.includes(`Cache reads cost ${e(usd(s.cacheReadCostUSD, true))} of it.`));
  // Tools: every tool with the CLI's own success rate, then skills, subagents and commands.
  const tools = sessionDrawer(detail, ui({ tab: 'tools' }));
  for (const t of s.tools) assert.ok(tools.includes(`>${e(t.toolName)}<`) && tools.includes(`${pctPoints(t.successRate)} worked`), t.toolName);
  for (const x of s.skillInvocations) assert.ok(tools.includes(`${e(x.name)} <b>×${n0(x.totalCalls)}</b>`), x.name);
  for (const x of s.agentInvocations) assert.ok(tools.includes(`${e(x.name)} <b>×${n0(x.totalCalls)}</b>`), x.name);
  assert.equal(tools.includes('None in this session.'), !s.skillInvocations.length || !s.agentInvocations.length || !s.commandInvocations.length);
  // The tabs: the one shown is selected.
  assert.ok(tools.includes('aria-selected="true" data-action="analytics-session-tab" data-value="tools"'));
});

test('the drawer\'s charts are the CLI\'s cost series, drawn for the tab shown', () => {
  const trace = sessionCharts(detail, ui());
  assert.deepEqual(Object.keys(trace), ['session-cost']);
  const svg = trace['session-cost'](600);
  const last = s.costSeries.at(-1);
  assert.ok(svg.includes(e(e(usd(last.cost)))));
  assert.deepEqual(Object.keys(sessionCharts(detail, ui({ tab: 'cost' }))), ['session-grow']);
  assert.deepEqual(Object.keys(sessionCharts(detail, ui({ tab: 'tools' }))), []);
  const flat = copy(detail);
  flat.session.costSeries = [];
  assert.deepEqual(Object.keys(sessionCharts(flat, ui())), []);
  assert.ok(sessionDrawer(flat, ui()).includes('No per-turn data in this log.'));
  // The model lane: one segment per run of the same model, each with its tooltip.
  assert.ok(sessionDrawer(detail, ui()).includes('class="ws-an-mlane"'));
});

test('provider text in the drawer is escaped', () => {
  const bad = '<script>alert(1)</script>';
  const evil = copy(detail);
  Object.assign(evil.session, { title: bad, project: `/Users/x/${bad}`, branch: bad, models: [bad], agentSessionFile: `/Users/x/${bad}.jsonl`, sessionSource: bad, agentName: bad });
  evil.session.tools = evil.session.tools.map(t => ({ ...t, toolName: bad }));
  evil.session.skillInvocations = evil.session.skillInvocations.map(x => ({ ...x, name: bad }));
  evil.session.perModelCost = evil.session.perModelCost.map(m => ({ ...m, model: bad }));
  evil.session.modelTimeline = evil.session.modelTimeline.map(m => ({ ...m, model: bad }));
  evil.session.dispatches = evil.session.dispatches.map(d => ({ ...d, tools: (d.tools || []).map(t => ({ ...t, name: bad })) }));
  evil.trace = evil.trace.map(t => ({ ...t, label: bad, issue: bad }));
  for (const over of [{}, { tab: 'cost' }, { tab: 'tools' }, { selected: parent.key }, { selected: parent.childKeys[0] }, { error: bad }]) {
    const html = sessionDrawer(evil, ui(over));
    assert.ok(!/<script/i.test(html), JSON.stringify(over));
    assert.ok(html.includes('&lt;script&gt;'), JSON.stringify(over));
    for (const draw of Object.values(sessionCharts(evil, ui(over)))) assert.ok(!/<script/i.test(draw(600)));
  }
});

// ---------------------------------------------------------------- the controller

function harness({ answers = {} } = {}) {
  const calls = { query: [], render: 0, toasts: [], copied: [], focus: [] };
  const state = { route: 'analytics' };
  const defaults = { analytics_status: status, analytics_view: summary, analytics_session: detail, analytics_report: { opened: true } };
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
    listen: async () => () => {},
    writeText: async text => { calls.copied.push(text); },
    focus: selectors => calls.focus.push(selectors),
    storage: { getItem: () => null, setItem: () => {} },
    now: () => status.lastFetchAt + 60_000,
    zone: ZONE,
  });
  return { ctl, state, calls, html: () => analyticsView(state.analytics, ctl.viewData()) };
}
const control = (value = '') => ({ dataset: { value }, closest: () => null });
const key = name => {
  const ev = { key: name, prevented: false, isComposing: false, target: null };
  ev.preventDefault = () => { ev.prevented = true; };
  return ev;
};

test('the drawer\'s actions: tabs, steps, collapse, copy, the CLI report and close with focus back on the row', async () => {
  const { ctl, state, calls, html } = harness();
  await ctl.open();
  const id = s.sessionId;
  await ctl.handle('analytics-open-session', control(id));
  assert.deepEqual(state.analytics.drawer, { tab: 'trace', selected: 'session', collapsed: new Set() });
  assert.ok(html().includes('class="ws-an-drawer"'));
  assert.ok(html().includes(`>${e(s.title)}</h2>`));
  assert.ok(calls.focus.flat().some(sel => sel.includes('ws-an-close')), 'focus moves into the drawer');
  // The drawer's chart is drawn with the page's.
  assert.ok('session-cost' in analyticsCharts(state.analytics, ctl.viewData()));
  await ctl.handle('analytics-session-tab', control('tools'));
  assert.equal(state.analytics.drawer.tab, 'tools');
  await ctl.handle('analytics-session-tab', control('nonsense'));
  assert.equal(state.analytics.drawer.tab, 'tools');
  // Tokens & cost: the chart shown as a table, through the page's own table switch.
  await ctl.handle('analytics-session-tab', control('cost'));
  await ctl.handle('analytics-table', control('sessionGrow'));
  assert.ok(html().includes('ws-an-grow-table') && !('session-grow' in analyticsCharts(state.analytics, ctl.viewData())));
  await ctl.handle('analytics-table', control('sessionGrow'));
  assert.ok('session-grow' in analyticsCharts(state.analytics, ctl.viewData()));
  await ctl.handle('analytics-session-tab', control('trace'));
  await ctl.handle('analytics-step', control(parent.key));
  assert.equal(state.analytics.drawer.selected, parent.key);
  assert.ok(html().includes(`class="ws-an-tl-row ws-an-sel" data-step="${e(parent.key)}"`));
  await ctl.handle('analytics-step-toggle', control(parent.key));
  assert.ok(state.analytics.drawer.collapsed.has(parent.key));
  assert.ok(!html().includes(`data-step="${e(parent.childKeys[0])}"`));
  await ctl.handle('analytics-step-toggle', control(parent.key));
  assert.ok(!state.analytics.drawer.collapsed.has(parent.key));
  await ctl.handle('analytics-copy', control(s.agentSessionFile));
  assert.deepEqual(calls.copied, [s.agentSessionFile]);
  assert.deepEqual(calls.toasts.at(-1), ['Copied.', 'success']);
  // Open the CLI report: the page's range and filters (the CLI renders no single session).
  await ctl.handle('analytics-report', control());
  assert.equal(calls.query.at(-1)[0], 'analytics_report');
  assert.ok(!('id' in calls.query.at(-1)[1]));
  calls.focus.length = 0;
  await ctl.handle('analytics-close', control());
  assert.equal(ctl.data.session, null);
  assert.equal(state.analytics.drawer, null);
  assert.ok(!html().includes('ws-an-drawer'));
  assert.deepEqual(calls.focus, [`button[data-action="analytics-open-session"][data-value="${id}"]`]);
});

test('Escape closes the drawer and puts focus back on the session that opened it', async () => {
  const { ctl, calls } = harness();
  await ctl.open();
  assert.equal(await ctl.key(key('Escape')), false, 'nothing open, nothing taken');
  const id = summary.sessions[0].sessionId;
  await ctl.handle('analytics-open-session', control(id));
  assert.equal(await ctl.key(key('Enter')), false);
  calls.focus.length = 0;
  const esc = key('Escape');
  assert.equal(await ctl.key(esc), true);
  assert.ok(esc.prevented);
  assert.equal(ctl.data.session, null);
  assert.deepEqual(calls.focus, [`button[data-action="analytics-open-session"][data-value="${id}"]`]);
  // An input method still composing keeps its Escape.
  await ctl.handle('analytics-open-session', control(id));
  assert.equal(await ctl.key({ ...key('Escape'), isComposing: true }), false);
  assert.ok(ctl.data.session);
});

test('the drawer while the session loads, when it fails, and Started in Connect from analytics_view', async () => {
  let release;
  const slow = harness({ answers: { analytics_session: () => new Promise(resolve => { release = () => resolve(detail); }) } });
  await slow.ctl.open();
  const opening = slow.ctl.handle('analytics-open-session', control(s.sessionId));
  await Promise.resolve();
  assert.ok(slow.html().includes('class="ws-an-drawer"'));
  assert.ok(slow.html().includes('Reading the session'));
  release();
  await opening;
  assert.ok(slow.html().includes(`>${e(s.title)}</h2>`));
  // A session the CLI couldn't read says why, with Try again.
  const failing = harness({ answers: { analytics_session: Object.assign(new Error('The CodeMie CLI stopped with exit code 1.'), { code: 'cli_failed' }) } });
  await failing.ctl.open();
  await failing.ctl.handle('analytics-open-session', control(s.sessionId));
  const failed = drawerOf(failing.html());
  assert.ok(failed.includes('The CodeMie CLI stopped with exit code 1.'));
  assert.ok(failed.includes(`data-action="analytics-open-session" data-value="${e(s.sessionId)}"`));
  // Started in Connect: the id is in analytics_view's connect.startedInConnect.
  const tagged = harness({ answers: { analytics_view: { ...summary, connect: { startedInConnect: [s.sessionId] } } } });
  await tagged.ctl.open();
  await tagged.ctl.handle('analytics-open-session', control(s.sessionId));
  assert.ok(drawerOf(tagged.html()).includes('Started in Connect'));
  const plain = harness();
  await plain.ctl.open();
  await plain.ctl.handle('analytics-open-session', control(s.sessionId));
  assert.ok(!drawerOf(plain.html()).includes('Started in Connect'));
});
