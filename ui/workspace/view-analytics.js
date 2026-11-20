// The Analytics page (docs/superpowers/specs/2026-11-19-analytics-design.md), ported from the
// prototype in prototypes/analytics/: the header with the AI / App switch, one filter row, the
// local-only notice, the fetch progress, and AI analytics' Overview, Efficiency and Sessions; the
// App tab (view-analytics-app.js) and the session drawer (view-analytics-session.js) are mounted here.
// Pure: `analyticsView(ui, data)` returns HTML and `analyticsCharts(ui, data)` the charts app.js
// draws into the `[data-chart]` boxes once their width is known. Every number is the CLI's
// `codemie.analytics.summary/1`, formatted; every provider text goes through `escapeHtml`.
// `ui` is the view state (analytics-model.js `newAnalyticsView`); `data` is what the operations
// answered: `{status, summary, progress, refreshing, loading, error, errorCode, reporting,
// session, app, now, zone, banners, profileNames}`.
import { escapeHtml as e } from './store.js';
import { icon } from './icons.js';
import { button, emptyState, spinner } from './ui.js';
import { agoLabel } from './format.js';
import { columns, tipHtml } from './analytics-charts.js';
import { sessionDrawer, sessionCharts } from './view-analytics-session.js';
import { appTab, appCharts } from './view-analytics-app.js';
import {
  PRESETS, VIEWS, SORT_LABELS, presetRange, readSoFar, pendingBefore, isBusy, delta, listSessions,
  usd, usdAxis, tok, dur, pct, pctPoints, n0, plural, dShort, dLong, weekday, hm, dayName, dayKeyIn, dayKeyLabel,
  agentLabel, modelLabel, projectName, startedInConnect, failedDays, failedReason,
} from './analytics-model.js';

/** Said when the CLI answers `view` in a shape this Connect wasn't built for (`cli_incompatible`). */
export const INCOMPATIBLE = "This CodeMie CLI answers in a format this Connect doesn't read yet. Update Connect.";

/** Rows a card lists before "Show all". */
const TOP = { tools: 6, skills: 6, agents: 6, commands: 6, projects: 5 };
const INV = [['tools', 'Tools', 'Tool calls'], ['skills', 'Skills', 'Skills used'], ['agents', 'Subagents', 'Subagents run'], ['commands', 'Commands', 'Commands']];
const METRICS = {
  cost: ['Cost', b => b.costUSD, usdAxis, v => usd(v)],
  sessions: ['Sessions', b => b.sessions, n0, n0],
  tokens: ['Tokens', b => b.tokens, tok, tok],
  time: ['Active time', b => b.durationMs / 3_600_000, v => `${Math.round(v * 10) / 10} h`, v => dur(v * 3_600_000)],
};
/** Model and token-kind colours: the validated categorical slots. */
const slot = i => `var(--ws-an-s${(i % 6) + 1})`;
const TOKEN_KINDS = [
  ['cacheRead', 'Cache reads', slot(0), 'Context the model re-reads each turn. Cheap per token, but it adds up in long sessions.'],
  ['output', 'Output', slot(1), 'What the model writes. The most expensive tokens.'],
  ['cacheCreation', 'Cache writes', slot(2), 'New context saved for later turns.'],
  ['input', 'Fresh input', slot(3), 'Tokens sent without caching.'],
];

// ---------------------------------------------------------------- small parts

const act = (action, value) => `data-action="${action}" data-value="${e(value)}"`;
const hint = text => `<span class="ws-an-hint" tabindex="0" role="img" aria-label="${e(text)}" data-an-tip="${e(tipHtml({ text }))}">${icon('info')}</span>`;

function kpi(label, value, sub, help) {
  return `<div class="ws-an-kpi"><div class="ws-an-kpi-l">${e(label)}${help ? hint(help) : ''}</div><div class="ws-an-kpi-v">${value}</div><div class="ws-an-kpi-d">${sub || ''}</div></div>`;
}

/** A card: `title` and `sub` are HTML (escaped by the caller); `opts.table` adds the chart/table switch. */
function card(id, title, sub, right, body, ui, opts = {}) {
  const on = !!ui.tables[id];
  const tableBtn = opts.table ? `<button type="button" class="ws-btn ws-btn-ghost ws-btn-sm ws-btn-icon ws-an-table-btn" ${act('analytics-table', id)} aria-pressed="${on}" title="${on ? 'Show the chart' : 'Show as a table'}" aria-label="${on ? 'Show the chart' : 'Show as a table'}">${icon(on ? 'chart' : 'table')}</button>` : '';
  return `<section class="ws-an-card${opts.cls ? ` ${opts.cls}` : ''}" data-card="${id}"><div class="ws-an-ch"><h3>${title}${sub ? ` <span class="ws-an-sub">${sub}</span>` : ''}</h3><span class="ws-spacer"></span>${right || ''}${tableBtn}</div><div class="ws-an-cb${opts.flush ? ' ws-an-flush' : ''}">${body}</div></section>`;
}

function seg(action, current, items, label) {
  return `<div class="ws-segmented ws-an-seg" role="tablist" aria-label="${e(label)}">${items.map(([v, l]) => `<button type="button" role="tab" ${act(action, v)} aria-selected="${v === current}">${e(l)}</button>`).join('')}</div>`;
}

/** A table; cells are HTML (escaped by the caller), `right` marks number columns. */
function table(head, rows, right, rowAttrs = null, scroll = true) {
  const cls = i => (right[i] ? ' class="ws-an-r"' : '');
  return `<div class="${scroll ? 'ws-an-tscroll' : 'ws-an-tflat'}"><table class="ws-an-table"><thead><tr>${head.map((h, i) => `<th${cls(i)}>${e(h)}</th>`).join('')}</tr></thead><tbody>${rows.map((r, j) => `<tr${rowAttrs ? ` ${rowAttrs[j]}` : ''}>${r.map((c, i) => `<td${cls(i)}>${c}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`;
}

const chartBox = id => `<div class="ws-an-chart" data-chart="${id}"></div>`;

function menuItem(action, value, label, checked, count) {
  return `<button type="button" class="ws-menu-item ws-an-mi" role="menuitemradio" aria-checked="${!!checked}" ${act(action, value)}><span class="ws-an-mi-l">${e(label)}</span>${count !== undefined ? `<span class="ws-an-cnt">${n0(count)}</span>` : ''}${checked ? icon('check', 'ws-an-ck') : '<span class="ws-an-ck"></span>'}</button>`;
}

// ---------------------------------------------------------------- header, filters, notice

function header(ui, data) {
  const ai = ui.mode !== 'app';
  const st = data.status;
  const mode = (v, iconName, label) => `<button type="button" role="tab" aria-selected="${ui.mode === v}" ${act('analytics-mode', v)}>${icon(iconName)}<span>${label}</span></button>`;
  let right = '';
  if (ai && st && st.state !== 'needs_cli') {
    const busy = isBusy(data);
    right = `${freshMenu(data, busy)}<button type="button" class="ws-btn ws-btn-secondary ws-an-refresh" data-action="analytics-refresh"${busy ? ' disabled' : ''}>${icon('refresh', busy ? 'ws-spin' : '')}<span>Refresh</span></button>`;
  }
  return `<header class="ws-page-heading ws-an-head"><h1>Analytics</h1><div class="ws-an-mode" role="tablist" aria-label="Analytics area">${mode('ai', 'sparkles', 'AI analytics')}${mode('app', 'workspaces', 'App analytics')}</div><span class="ws-spacer"></span>${right}</header>`;
}

/** "Updated 4 min ago": what Connect has stored, and the CLI's own report (busy while the CLI
 *  writes it). */
function freshMenu(data, busy) {
  const st = data.status;
  const ago = st.lastFetchAt ? agoLabel(st.lastFetchAt, data.zone, data.now) : '';
  const label = data.reporting ? 'Opening the report…' : busy ? 'Updating…' : ago ? `Updated ${ago}` : 'Not read yet';
  const report = data.reporting
    ? `<button type="button" class="ws-menu-item" data-action="analytics-report" disabled aria-busy="true">${icon('refresh', 'ws-spin')}<span>Opening the CLI report…</span></button>`
    : `<button type="button" class="ws-menu-item" data-action="analytics-report">${icon('external')}<span>Open the CLI report</span></button>`;
  return `<details class="ws-menu ws-menu-right ws-an-menu" data-menu="analytics-fresh"><summary class="ws-an-fresh${busy || data.reporting ? ' ws-an-busy' : ''}"><span class="ws-an-dot"></span><span>${e(label)}</span></summary><div class="ws-menu-panel ws-an-pop ws-an-pop-wide">
    <div class="ws-an-pop-body"><h4>Stored in Connect</h4>
      <div class="ws-an-pop-row">History<span>${st.storedFrom ? `${e(dayKeyLabel(st.storedFrom))} – today` : 'nothing yet'}</span></div>
      <div class="ws-an-pop-row">Sessions<span>${n0(st.sessions)}</span></div>
      <div class="ws-an-pop-row">Last checked<span>${e(ago || 'never')}</span></div>
      <p>Refresh reads yesterday and today again. Opening Analytics does it on its own when the data is older than 15 minutes.</p></div>
    <hr>${report}
  </div></details>`;
}

function tabs(ui) {
  return `<div class="ws-tabs ws-an-tabs" role="tablist" aria-label="AI analytics">${VIEWS.map(([id, label]) => `<button type="button" role="tab" ${act('analytics-view', id)} aria-selected="${ui.view === id}">${label}</button>`).join('')}</div>`;
}

/** A filter chip with its menu; a set value gets a × that clears it. */
function chip(name, key, value, panel) {
  const set = !!value;
  const clear = set ? `<button type="button" class="ws-an-clear" ${act(`analytics-${name}`, '')} aria-label="Clear the ${name}" title="Clear the ${name}">${icon('close')}</button>` : '';
  return `<span class="ws-an-chip${set ? ' ws-an-set' : ''}"><details class="ws-menu ws-an-menu" data-menu="analytics-${name}"><summary class="ws-an-fbtn${set ? ' ws-an-set' : ''}"><span class="ws-an-k">${key}</span><span class="ws-an-v">${set ? e(value) : 'All'}</span>${set ? '' : icon('chevron-down', 'ws-an-caret')}</summary><div class="ws-menu-panel ws-an-pop">${panel}</div></details>${clear}</span>`;
}

function filters(ui, data) {
  const range = presetRange(ui.range, data.now, data.zone);
  const date = `<details class="ws-menu ws-an-menu" data-menu="analytics-date"><summary class="ws-an-fbtn">${icon('calendar')}<span class="ws-an-v">${e(range.label)}</span>${icon('chevron-down', 'ws-an-caret')}</summary><div class="ws-menu-panel ws-an-pop"><div class="ws-menu-label">Date range</div>${PRESETS.map(p => menuItem('analytics-range', p.id, p.label, ui.range === p.id)).join('')}</div></details>`;
  if (ui.mode === 'app') return `<div class="ws-an-filters">${date}<span class="ws-spacer"></span><span class="ws-an-faint">From Connect's own records on this Mac</span></div>`;
  const s = data.summary;
  const agents = s?.agentsUsed || [];
  const projects = s?.projects || [];
  const agent = chip('agent', 'Agent', ui.agent ? agentLabel(ui.agent) : '', `${menuItem('analytics-agent', '', 'All agents', !ui.agent)}${agents.length ? '<hr>' : ''}${agents.map(a => menuItem('analytics-agent', a.agentName, agentLabel(a.agentName), ui.agent === a.agentName, a.sessions)).join('')}`);
  const project = chip('project', 'Project', ui.project ? projectName(ui.project) : '', `${menuItem('analytics-project', '', 'All projects', !ui.project)}${projects.length ? '<hr>' : ''}${projects.map(p => menuItem('analytics-project', p.project, projectName(p.project), ui.project === p.project, p.sessions)).join('')}`);
  const local = ui.noticeHidden ? counted(ui, data, 'chip') : '';
  const count = s ? `<span class="ws-an-faint">${n0(s.totals.sessions)} ${plural(s.totals.sessions, 'session')}</span>` : '';
  return `<div class="ws-an-filters">${date}${agent}${project}<span class="ws-spacer"></span>${local}${count}</div>`;
}

/** "What's counted": the CLI's coverage per agent; every session on this Mac counts (no toggle). */
function counted(ui, data, where) {
  const st = data.status;
  const range = presetRange(ui.range, data.now, data.zone);
  const opener = where === 'chip'
    ? `<summary class="ws-an-chip-local">${icon('info')}<span>Local sessions only</span></summary>`
    : '<summary class="ws-btn ws-btn-ghost ws-btn-sm">What&#39;s counted</summary>';
  const rows = (data.summary?.coverage || []).map(c => `<div class="ws-an-pop-row">${e(agentLabel(c.agentName))}<span>${n0(c.sessions)} ${plural(c.sessions, 'session')}${c.withLog < c.sessions ? ` · <span class="ws-an-warn-text">${n0(c.withLog)} with a log</span>` : ''}</span></div>`).join('');
  return `<details class="ws-menu ws-menu-right ws-an-menu" data-menu="analytics-counted-${where}">${opener}<div class="ws-menu-panel ws-an-pop ws-an-pop-wide"><div class="ws-an-pop-body"><h4>What&#39;s counted</h4>
    <p>Coding-agent sessions CodeMie finds on this Mac${st?.storedFrom ? ` since ${e(dayKeyLabel(st.storedFrom))}` : ''}, sessions started outside CodeMie (plain claude or codex runs) included.</p>
    ${rows ? `<div class="ws-an-pop-sub">${e(range.label)}</div>${rows}` : ''}
    <p class="ws-an-pop-gap"><b>Not counted:</b> other computers, logs an agent already deleted, and chats in the browser or IDE.</p></div>
    ${ui.noticeHidden ? `<hr><button type="button" class="ws-menu-item" ${act('analytics-notice', 'show')}>${icon('eye')}<span>Show the notice again</span></button>` : ''}
  </div></details>`;
}

function notice(ui, data) {
  if (ui.mode === 'app' || !data.status) return '';
  if (data.status.state === 'needs_cli') {
    return `<div class="ws-an-notice ws-an-warn" role="status"><span class="ws-an-notice-ic">${icon('alert')}</span><div class="ws-an-notice-tx"><b>Analytics needs a newer CodeMie CLI.</b> The CodeMie CLI on this Mac can&#39;t read sessions for Connect. Update it in Settings → CodeMie; your sessions stay where they are.</div><div class="ws-an-notice-acts">${button('Open Settings → CodeMie', { action: 'settings-tab', variant: 'primary', attrs: { 'data-tab': 'cm-overview' } })}</div></div>`;
  }
  if (ui.noticeHidden) return '';
  return `<div class="ws-an-notice" role="note"><span class="ws-an-notice-ic">${icon('info')}</span><div class="ws-an-notice-tx"><b>Based on sessions saved on this Mac.</b> Numbers come from the coding-agent logs CodeMie finds here. Other computers, logs an agent has already deleted, and chats in the browser or IDE aren&#39;t counted, so your real usage can be higher.</div><div class="ws-an-notice-acts">${counted(ui, data, 'notice')}<button type="button" class="ws-btn ws-btn-ghost ws-btn-sm ws-btn-icon" ${act('analytics-notice', 'hide')} title="Hide the notice" aria-label="Hide the notice">${icon('close')}</button></div></div>`;
}

/** The fetch's progress, or the days it couldn't read: their count opens the list of them with
 *  why, and Try again reads them all again. */
function progressLine(data) {
  const p = data.progress?.running ? data.progress : data.status?.state === 'running' ? data.status.progress : null;
  if (p || data.refreshing) {
    const done = p?.done || 0;
    const total = p?.total || 0;
    const width = total ? Math.round((done / total) * 100) : 4;
    const text = p ? `${p.label}${total > 1 ? ` · ${n0(done)} of ${n0(total)} days` : '…'}` : 'Checking for new sessions…';
    return `<div class="ws-an-progress" role="status"><span class="ws-an-prog"><span style="width:${width}%"></span></span><span>${e(text)}</span></div>`;
  }
  const failed = failedDays(data.progress?.failedDays || data.status?.failedDays);
  if (!failed.length) return '';
  const what = `${failed.length} ${plural(failed.length, 'day')} couldn't be read (${dayKeyLabel(failed[0].day)}${failed.length > 1 ? ' and others' : ''}).`;
  const rows = failed.map(f => `<div class="ws-an-pop-row">${e(dayKeyLabel(f.day))}<span>${e(failedReason(f.reason))}</span></div>`).join('');
  const days = `<details class="ws-menu ws-an-menu" data-menu="analytics-failed"><summary class="ws-an-failed-days" title="Which days, and why">${e(what)}</summary><div class="ws-menu-panel ws-an-pop ws-an-pop-wide"><div class="ws-an-pop-body"><h4>Days that couldn&#39;t be read</h4>${rows}<p class="ws-an-pop-gap">Days are UTC days, as the CodeMie CLI reads them. Try again reads them all once more.</p></div></div></details>`;
  return `<div class="ws-an-progress ws-an-failed">${icon('alert')}${days}<span>The rest is up to date.</span><button type="button" class="ws-link" data-action="analytics-retry">Try again</button></div>`;
}

// ---------------------------------------------------------------- states

const loadingState = () => `<div class="ws-an-state">${spinner('Reading analytics')}<span>Reading analytics…</span></div>`;

/** A range with no session yet while its days are still read. */
const readingState = soFar => `<div class="ws-an-state">${spinner('Reading your sessions')}<span>Reading your sessions… ${n0(soFar.done)} of ${n0(soFar.total)} days so far</span></div>`;

function errorState(message) {
  return `<section class="ws-an-card ws-an-error">${emptyState({ iconName: 'alert', title: 'Analytics couldn’t be read', text: message, actions: button('Try again', { action: 'analytics-reload', iconName: 'refresh' }) })}</section>`;
}

/** The CLI answered in a format this Connect doesn't read: no numbers, nothing to try again. */
function incompatibleState() {
  return `<section class="ws-an-card ws-an-incompatible">${emptyState({ iconName: 'info', title: INCOMPATIBLE })}</section>`;
}

function emptyMac() {
  return `<section class="ws-an-card ws-an-empty-mac">${emptyState({ iconName: 'terminal', title: 'No coding-agent sessions on this Mac yet', text: "Sessions from Claude Code, codemie-claude or Connect's terminal show up here after a refresh." })}</section>`;
}

function emptyRange(ui, data) {
  const range = presetRange(ui.range, data.now, data.zone);
  const filtered = ui.agent || ui.project;
  const actions = filtered ? button('Clear filters', { action: 'analytics-clear' })
    : ui.range !== '30d' ? `<button type="button" class="ws-btn ws-btn-secondary" ${act('analytics-range', '30d')}>Show the last 30 days</button>` : '';
  return `<section class="ws-an-card">${emptyState({ iconName: 'chart', title: `No sessions ${range.label === 'Today' ? 'today' : `in ${range.label.toLowerCase()}`}`, text: filtered ? 'The agent or project filter may be hiding them.' : '', actions })}</section>`;
}

// ---------------------------------------------------------------- Overview

function deltaText(summary, key, range) {
  const d = delta(summary, key);
  return d ? `<span class="ws-an-delta">${d.text}</span><span>vs ${range.label === 'Today' ? 'yesterday' : `previous ${range.days} days`}</span>` : '';
}

function overview(ui, data) {
  const s = data.summary;
  const t = s.totals;
  const range = presetRange(ui.range, data.now, data.zone);
  const soFar = readSoFar(ui.range, data.status, isBusy(data), data.now, data.zone);
  const sub = key => (soFar ? `<span>${n0(soFar.done)} of ${n0(soFar.total)} days read so far</span>` : deltaText(s, key, range));
  const unpriced = t.pricedSessions < t.sessions ? ` Only ${n0(t.pricedSessions)} of ${n0(t.sessions)} sessions could be priced; the others have no cost.` : '';
  const kpis = `<div class="ws-an-kpis">
    ${kpi('Estimated cost', e(usd(t.costUSD, true)), sub('costUSD'), `CodeMie prices each session’s tokens at standard API rates. On a Claude subscription this is not what you are charged.${unpriced}`)}
    ${kpi('Sessions', n0(t.sessions), sub('sessions'))}
    ${kpi('Active time', e(dur(t.durationMs)), sub('durationMs'), 'Time from the first to the last message of each session, added up.')}
    ${kpi('Code changed', `${t.netLines >= 0 ? '+' : ''}${n0(t.netLines)}<small>net lines</small>`, `<span>${n0(t.filesChanged)} files · <span class="ws-an-plus">+${n0(t.linesAdded)}</span> <span class="ws-an-minus">−${n0(t.linesRemoved)}</span></span>`, 'Lines written or edited by the agent. Deleted files are not tracked.')}
  </div>`;

  const weekly = s.range?.bucket === 'week';
  const [name] = METRICS[ui.metric] || METRICS.cost;
  const title = `${name} per ${weekly ? 'week' : 'day'}`;
  const trendBody = ui.tables.trend
    ? table([weekly ? 'Week of' : 'Day', 'Cost', 'Sessions', 'Tokens', 'Active time'], s.series.slice().reverse().map(b => [e(weekly ? dShort(b.from, data.zone) : dLong(b.from, data.zone)), e(usd(b.costUSD)), n0(b.sessions), tok(b.tokens), e(dur(b.durationMs))]), [0, 1, 1, 1, 1])
    : chartBox('trend');
  const trend = card('trend', e(title), '', seg('analytics-metric', METRICS[ui.metric] ? ui.metric : 'cost', [['cost', 'Cost'], ['sessions', 'Sessions'], ['tokens', 'Tokens'], ['time', 'Time']], 'Trend'), trendBody, ui, { table: true });

  const [inv, , invTitle] = INV.find(([id]) => id === ui.inv) || INV[0];
  const list = s[inv] || [];
  const top = ui.all[inv] ? list : list.slice(0, TOP[inv]);
  const max = Math.max(1, ...list.map(x => x.calls));
  const invRow = x => {
    const flag = inv === 'tools' && x.successRate < 92 ? `<span class="ws-an-flag" title="${n0(x.failure)} failed calls">${icon('alert')}${pctPoints(x.successRate)} worked</span>` : '';
    const small = inv === 'tools' ? `${pctPoints(x.successRate)} ok` : `${n0(x.sessions)} ${plural(x.sessions, 'session')}`;
    return `<div class="ws-an-row"><div class="ws-an-n"><span class="ws-an-t">${e(x.name)}</span>${flag}</div><div class="ws-an-val">${n0(x.calls)}<small>${small}</small></div><div class="ws-an-track"><span style="width:${((x.calls / max) * 100).toFixed(1)}%"></span></div></div>`;
  };
  const toolsBody = list.length
    ? `<div class="ws-an-rows">${top.map(invRow).join('')}</div>${list.length > TOP[inv] ? `<button type="button" class="ws-link ws-an-more" ${act('analytics-more', inv)}>${ui.all[inv] ? 'Show fewer' : `Show all ${list.length}`}</button>` : ''}`
    : `<div class="ws-an-none">No ${{ skills: 'skills', agents: 'subagents', commands: 'commands' }[inv]} ran in these sessions.</div>`;
  const tools = card('tools', e(invTitle), '', seg('analytics-inv', inv, INV.map(([id, label]) => [id, label]), 'Calls'), toolsBody, ui);

  const models = s.models || [];
  const segbar = `<div class="ws-an-segbar" role="img" aria-label="Cost share by model">${models.filter(m => m.share > 0).map(m => {
    const i = models.indexOf(m);
    const tip = tipHtml({ title: modelLabel(m.model), rows: [{ value: usd(m.costUSD), label: 'cost', color: slot(i) }, { value: pct(m.share), label: 'of cost' }, { value: n0(m.sessions), label: plural(m.sessions, 'session') }] });
    return `<div class="ws-an-ink-${(i % 6) + 1}" style="flex:${m.share};background:${slot(i)}" tabindex="0" data-an-tip="${e(tip)}">${m.share > 0.12 ? pct(m.share, 0) : ''}</div>`;
  }).join('')}</div>`;
  const modelRows = `<div class="ws-an-rows">${models.map((m, i) => `<div class="ws-an-row ws-an-row-2"><div class="ws-an-n"><i class="ws-an-swatch" style="background:${slot(i)}"></i><span class="ws-an-t">${e(modelLabel(m.model))}</span></div><div class="ws-an-val">${e(usd(m.costUSD))}<small>${pct(m.share, 0)} · ${n0(m.sessions)} sess.</small></div></div>`).join('')}</div>`;
  const modelsCard = card('models', 'Models', 'share of cost', '', models.length ? segbar + modelRows : '<div class="ws-an-none">No priced sessions.</div>', ui);

  const projects = s.projects || [];
  const pmax = Math.max(0.01, ...projects.map(p => p.costUSD));
  const ptop = ui.all.projects ? projects : projects.slice(0, TOP.projects);
  const projectRows = `<div class="ws-an-rows">${ptop.map(p => `<button type="button" class="ws-an-row ws-an-row-btn" ${act('analytics-project', p.project)} title="Show only ${e(projectName(p.project))}"><span class="ws-an-n"><span class="ws-an-t">${e(projectName(p.project))}</span></span><span class="ws-an-val">${e(usd(p.costUSD))}<small>${n0(p.sessions)} sess.</small></span><span class="ws-an-track"><span style="width:${((p.costUSD / pmax) * 100).toFixed(1)}%"></span></span></button>`).join('')}</div>${projects.length > TOP.projects ? `<button type="button" class="ws-link ws-an-more" ${act('analytics-more', 'projects')}>${ui.all.projects ? 'Show fewer' : `Show all ${projects.length}`}</button>` : ''}`;
  const projectsCard = card('projects', 'Projects', 'by cost', '', projects.length ? projectRows : '<div class="ws-an-none">No projects.</div>', ui);

  return `${kpis}<div class="ws-an-grid">${trend}</div><div class="ws-an-grid ws-an-g3">${tools}${modelsCard}${projectsCard}</div>`;
}

function trendChart(width, ui, data) {
  const s = data.summary;
  const series = s.series || [];
  const weekly = s.range?.bucket === 'week';
  const [name, value, axis] = METRICS[ui.metric] || METRICS.cost;
  const before = pendingBefore(data);
  const zone = data.zone;
  return columns(width, {
    items: series,
    value: i => value(series[i]),
    fmtAxis: axis,
    whole: ui.metric === 'sessions',
    height: 200,
    aria: `${name} per ${weekly ? 'week' : 'day'}`,
    pending: before === null ? null : i => series[i].to < before,
    label: i => (weekly || series.length > 7 ? dShort(series[i].from, zone) : weekday(series[i].from, zone)),
    tip: i => {
      const b = series[i];
      return { title: weekly ? `Week of ${dShort(b.from, zone)}` : dLong(b.from, zone), rows: [{ value: usd(b.costUSD), label: 'cost' }, { value: n0(b.sessions), label: plural(b.sessions, 'session') }, { value: tok(b.tokens), label: 'tokens' }, { value: dur(b.durationMs), label: 'active' }] };
    },
  });
}

// ---------------------------------------------------------------- Efficiency

/** A session in a table: its title opens it (the whole row does too). */
const sessionCell = r => `<button type="button" class="ws-an-cell-link" ${act('analytics-open-session', r.sessionId)}>${e(r.title || 'Untitled session')}</button>`;
const rowOpens = rows => rows.map(r => `class="ws-an-click" ${act('analytics-open-session', r.sessionId)}`);

function efficiency(ui, data) {
  const s = data.summary;
  const t = s.totals;
  const ef = s.efficiency;
  const kpis = `<div class="ws-an-kpis">
    ${kpi('Cost per changed file', e(usd(ef.costPerFileUSD)), `<span>${n0(t.filesChanged)} files changed</span>`, 'Estimated cost divided by the files the agents wrote or edited.')}
    ${kpi('Tool calls that worked', pctPoints(ef.toolSuccessRate), `<span>${n0(t.toolCalls)} calls</span>`, 'Share of tool calls (Bash, Edit, Read and others) that returned without an error.')}
    ${kpi('Spend that changed nothing', e(usd(ef.dead.costUSD)), `<span>${pct(ef.dead.shareOfCost)} of cost · ${n0(ef.dead.sessions)} sessions</span>`, 'Sessions that cost something but changed no files and no lines. Questions and research land here too, so not all of it is waste.')}
    ${kpi('Context re-read per turn', `${tok(ef.contextPerTurn)}<small>tokens</small>`, `<span>cache reads are ${pct(ef.cacheReadCostShare, 0)} of cost</span>`, 'Cache-read tokens per turn. It grows with long sessions that carry a big context; /compact or a fresh session brings it down.')}
  </div>`;

  const buckets = ef.depth.buckets;
  const depthBody = ui.tables.depth ? table(['Turns', 'Sessions'], buckets.map(b => [e(b.label), n0(b.sessions)]), [0, 1]) : chartBox('depth');
  const depth = card('depth', 'Session length', `median ${n0(ef.depth.median)} turns · average ${n0(ef.depth.average)}`, '', depthBody, ui, { table: true });

  const tokens = t.tokens;
  const mixBar = `<div class="ws-an-segbar" role="img" aria-label="Where tokens go">${TOKEN_KINDS.filter(([k]) => tokens[k] > 0).map(([k, label, color], i) => `<div class="ws-an-ink-${i + 1}" style="flex:${tokens[k]};background:${color}" tabindex="0" data-an-tip="${e(tipHtml({ title: label, rows: [{ value: tok(tokens[k]), label: 'tokens', color }] }))}"></div>`).join('')}</div>`;
  const mixRows = `<div class="ws-an-rows">${TOKEN_KINDS.map(([k, label, color, help]) => `<div class="ws-an-row ws-an-row-2"><div class="ws-an-n"><i class="ws-an-swatch" style="background:${color}"></i><span class="ws-an-t">${label}</span>${hint(help)}</div><div class="ws-an-val">${tok(tokens[k])}</div></div>`).join('')}</div>`;
  const mix = card('mix', 'Where tokens go', `${tok(tokens.total)} tokens`, '', mixBar + mixRows, ui);

  const zone = data.zone;
  const deadRows = ef.dead.top.map(r => [sessionCell(r), e(dayName(r.startTime, data.now, zone)), e(projectName(r.project)), e(modelLabel((r.models || [])[0] || '')), n0(r.turns), e(usd(r.costUSD))]);
  const heavyRows = ef.heavy.map(r => [sessionCell(r), e(dayName(r.startTime, data.now, zone)), e(projectName(r.project)), n0(r.turns), tok(r.contextPerTurn), e(usd(r.costUSD))]);
  const dead = ui.list !== 'heavy';
  const lookBody = dead
    ? (deadRows.length ? table(['Session', 'When', 'Project', 'Model', 'Turns', 'Cost'], deadRows, [0, 0, 0, 0, 1, 1], rowOpens(ef.dead.top), false) : '<div class="ws-an-none">Every session in this range changed something.</div>')
    : (heavyRows.length ? table(['Session', 'When', 'Project', 'Turns', 'Context / turn', 'Cost'], heavyRows, [0, 0, 0, 1, 1, 1], rowOpens(ef.heavy), false) : '<div class="ws-an-none">No session re-read context in this range.</div>');
  const look = card('look', 'Sessions to look at', dead ? 'cost something, changed nothing' : 'biggest context carried per turn', seg('analytics-list', dead ? 'dead' : 'heavy', [['dead', `Changed nothing · ${n0(ef.dead.sessions)}`], ['heavy', 'Heaviest context']], 'Sessions to look at'), lookBody, ui, { flush: true });

  return `${kpis}<div class="ws-an-grid ws-an-g2">${depth}${mix}</div><div class="ws-an-grid">${look}</div>`;
}

function depthChart(width, data) {
  const buckets = data.summary.efficiency.depth.buckets;
  return columns(width, {
    items: buckets,
    value: i => buckets[i].sessions,
    fmtAxis: n0,
    whole: true,
    label: i => buckets[i].label,
    height: 170,
    aria: 'Sessions by number of turns',
    tip: i => ({ title: `${buckets[i].label} turns`, rows: [{ value: n0(buckets[i].sessions), label: plural(buckets[i].sessions, 'session') }] }),
  });
}

// ---------------------------------------------------------------- Sessions

/** "8 subagents · 3 skills": the CLI's step counts of a row. */
function stepsText(r) {
  const st = r.steps || {};
  return [st.agents && `${n0(st.agents)} ${plural(st.agents, 'subagent')}`, st.skills && `${n0(st.skills)} ${plural(st.skills, 'skill')}`].filter(Boolean).join(' · ');
}

/** A session row; `connect` holds the ids Connect's terminal started (`startedInConnect`). */
function sessionRow(r, ui, zone, connect) {
  const tags = `<span class="ws-an-tag">${e(agentLabel(r.agentName))}</span>${connect.has(r.sessionId) ? `<span class="ws-an-tag ws-an-tag-connect" title="Started in Connect&#39;s terminal">${icon('terminal')}Connect</span>` : ''}`;
  const meta = [projectName(r.project), r.branch, (r.models || []).map(modelLabel).join(' → '), stepsText(r)].filter(Boolean).join(' · ');
  const changes = r.filesChanged ? `<span class="ws-an-plus">+${n0(r.linesAdded)}</span> <span class="ws-an-minus">−${n0(r.linesRemoved)}</span>` : '<span class="ws-an-faint">none</span>';
  const cost = !r.hadLog && !r.costUSD ? '<span class="ws-an-c ws-an-cost" title="No log to price">—</span>' : `<span class="ws-an-c ws-an-cost">${e(usd(r.costUSD))}</span>`;
  return `<button type="button" class="ws-an-srow" ${act('analytics-open-session', r.sessionId)}><span class="ws-an-tt"><b>${e(r.title || 'Untitled session')}</b><small>${tags}<span class="ws-an-meta">${e(meta)}</span></small></span><span class="ws-an-c ws-an-hide-n">${ui.sort === 'newest' ? hm(r.startTime, zone) : e(dShort(r.startTime, zone))}</span><span class="ws-an-c">${e(dur(r.durationMs))}</span><span class="ws-an-c ws-an-hide-n">${n0(r.turns)}</span><span class="ws-an-c ws-an-hide-n">${changes}</span>${cost}</button>`;
}

function sessionsList(ui, data) {
  const s = data.summary;
  const zone = data.zone;
  const rows = listSessions(s.sessions, ui.q, ui.sort);
  const shown = rows.slice(0, ui.shown);
  const connect = startedInConnect(s);
  const sortLabel = (SORT_LABELS.find(([v]) => v === ui.sort) || SORT_LABELS[0])[1];
  const sort = `<details class="ws-menu ws-an-menu" data-menu="analytics-sort"><summary class="ws-an-fbtn">${icon('sliders')}<span class="ws-an-v">${e(sortLabel)}</span>${icon('chevron-down', 'ws-an-caret')}</summary><div class="ws-menu-panel ws-an-pop">${SORT_LABELS.map(([v, l]) => menuItem('analytics-sort', v, l, ui.sort === v)).join('')}</div></details>`;
  const total = ui.q.trim() ? `${n0(rows.length)} of ${n0(s.totals.sessions)} sessions` : `${n0(s.totals.sessions)} ${plural(s.totals.sessions, 'session')} · ${e(usd(s.totals.costUSD, true))}`;
  const toolbar = `<div class="ws-an-toolbar"><label class="ws-search ws-an-search">${icon('search')}<input id="analytics-search" type="search" value="${e(ui.q)}" placeholder="Search prompts, projects, branches" aria-label="Search sessions" autocomplete="off"></label>${sort}<span class="ws-spacer"></span><span class="ws-an-faint">${total}</span></div>`;
  if (!rows.length) return `${toolbar}<div class="ws-an-slist">${emptyState({ iconName: 'search', title: `Nothing matches “${ui.q.trim()}”`, text: 'Try a project name, a branch or words from the first prompt.' })}</div>`;
  const sortBtn = (v, label) => `<button type="button" class="${ui.sort === v ? 'ws-on' : ''}" ${act('analytics-sort', v)}>${label}</button>`;
  const head = `<div class="ws-an-sh"><span>Session</span><span class="ws-an-hide-n">Started</span><span>${sortBtn('time', 'Length')}</span><span class="ws-an-hide-n">${sortBtn('turns', 'Turns')}</span><span class="ws-an-hide-n">Changes</span><span>${sortBtn('cost', 'Cost')}</span></div>`;
  let body = '';
  if (ui.sort === 'newest') {
    // Day groups; a day's numbers are the CLI's series bucket for it (days, not weeks, and no search).
    let current = null;
    for (const r of shown) {
      const key = dayKeyIn(r.startTime, zone);
      if (key !== current) {
        current = key;
        const b = s.range?.bucket === 'day' && !ui.q.trim() ? (s.series || []).find(x => x.from <= r.startTime && r.startTime <= x.to) : null;
        body += `<div class="ws-an-sday"><b>${e(dayName(r.startTime, data.now, zone))}</b>${b ? `<span>${n0(b.sessions)} ${plural(b.sessions, 'session')}</span><span class="ws-spacer"></span><span>${e(usd(b.costUSD))}</span>` : ''}</div>`;
      }
      body += sessionRow(r, ui, zone, connect);
    }
  } else {
    body = shown.map(r => sessionRow(r, ui, zone, connect)).join('');
  }
  const more = rows.length > shown.length ? `<div class="ws-an-more-row"><button type="button" class="ws-btn ws-btn-secondary" ${act('analytics-more', 'sessions')}>Show ${n0(Math.min(40, rows.length - shown.length))} more</button></div>` : '';
  return `${toolbar}<div class="ws-an-slist">${head}${body}</div>${more}`;
}

// ---------------------------------------------------------------- the page

function aiBody(ui, data) {
  const s = data.summary;
  if (data.errorCode === 'cli_incompatible') return incompatibleState();
  if (data.error) return errorState(data.error);
  if (!s) return loadingState();
  if (!s.totals?.sessions) {
    // While the range's days are still read, "no sessions" isn't known yet.
    const soFar = readSoFar(ui.range, data.status, isBusy(data), data.now, data.zone);
    return soFar ? readingState(soFar) : emptyRange(ui, data);
  }
  if (ui.view === 'efficiency') return efficiency(ui, data);
  if (ui.view === 'sessions') return sessionsList(ui, data);
  return overview(ui, data);
}

/** App analytics: Connect's own records, read on the App tab (`data.app`). */
function appBody(ui, data) {
  const app = data.app;
  let inner;
  if (app?.answer) inner = `<div class="${app.loading ? 'ws-an-loading' : ''}">${appTab({ ...app.answer, now: data.now, zone: data.zone, profileNames: data.profileNames }, ui)}</div>`;
  else if (app?.error) inner = errorState(app.error);
  else inner = `<div class="ws-an-state">${spinner('Reading App analytics')}<span>Reading App analytics…</span></div>`;
  return `<div class="ws-an-app">${inner}</div>`;
}

/** The session drawer's view of `data.session`, with its tab, step and collapsed steps. */
function drawerOf(ui, data) {
  const open = data.session;
  if (!open) return '';
  const d = ui.drawer || {};
  return sessionDrawer(open.detail, {
    tab: d.tab, selected: d.selected, collapsed: d.collapsed, tables: ui.tables, zone: data.zone, now: data.now,
    inConnect: startedInConnect(data.summary).has(open.id), loading: open.loading, error: open.error, id: open.id, reporting: !!data.reporting,
  });
}

/** The whole page. In App mode the body is the App tab; an open session adds its drawer. */
export function analyticsView(ui, data) {
  const ai = ui.mode !== 'app';
  const st = data.status;
  const needsCli = st?.state === 'needs_cli';
  const empty = st?.state === 'empty' && !isBusy(data);
  let body;
  if (!ai) body = appBody(ui, data);
  else if (!st) body = data.error ? errorState(data.error) : loadingState();
  else if (needsCli) body = '';
  else if (empty) body = emptyMac();
  else body = aiBody(ui, data);
  const live = ai && st && !needsCli && !empty;
  return `<div class="ws-analytics" data-mode="${ai ? 'ai' : 'app'}" data-view="${e(ui.view)}">
    ${header(ui, data)}
    ${data.banners || ''}
    ${live ? tabs(ui) : ''}
    ${!ai || live ? filters(ui, data) : ''}
    ${ai ? notice(ui, data) : ''}
    ${ai && st && !needsCli ? progressLine(data) : ''}
    <div class="ws-an-body${ai && data.loading && data.summary ? ' ws-an-loading' : ''}">${body}</div>
    ${drawerOf(ui, data)}
  </div>`;
}

/** The charts on the page as it is now, by `data-chart` id: `width => svg`. */
export function analyticsCharts(ui, data) {
  const open = data.session?.detail && !data.session.error
    ? sessionCharts(data.session.detail, { ...(ui.drawer || {}), tables: ui.tables, zone: data.zone })
    : {};
  if (ui.mode === 'app') return { ...(data.app?.answer ? appCharts({ ...data.app.answer, zone: data.zone }, ui) : {}), ...open };
  if (!data.summary || data.status?.state === 'needs_cli') return open;
  if (ui.view === 'overview' && !ui.tables.trend) return { trend: width => trendChart(width, ui, data), ...open };
  if (ui.view === 'efficiency' && !ui.tables.depth) return { depth: width => depthChart(width, data), ...open };
  return open;
}
