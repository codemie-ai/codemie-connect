// The Analytics page's session drawer (docs/superpowers/specs/2026-11-19-analytics-design.md,
// "Prototype calls carried over"), ported from the prototype's renderDrawer, sessionDetail and
// stepDetail: the header with the session's IDs and log path, five numbers, and three tabs (Trace:
// the step tree with a side panel; Tokens & cost; Tools). Pure: `sessionDrawer(detail, ui)` returns
// HTML and `sessionCharts(detail, ui)` the charts app.js draws once their width is known.
// `detail` is the CLI's `codemie.analytics.session/1` (`{session, trace}`). The tree is its
// `trace[]` as it is (order, level, parent, `#n` labels), and a step's numbers are its dispatch's
// own fields: nothing here adds up or divides the CLI's numbers; times are only placed on the
// timeline. `ui` is `{tab, selected, collapsed: Set, tables, zone, now, inConnect, loading, error,
// id}`; `tables.sessionGrow` shows the cost-over-the-session chart as a table.
import { escapeHtml as e } from './store.js';
import { icon } from './icons.js';
import { spinner } from './ui.js';
import { area, tipHtml } from './analytics-charts.js';
import { usd, tok, n0, pctPoints, plural, hm, dayName, agentLabel, modelLabel, projectName } from './analytics-model.js';

export const SESSION_TABS = [['trace', 'Trace'], ['cost', 'Tokens & cost'], ['tools', 'Tools']];

const slot = i => `var(--ws-an-s${(i % 6) + 1})`;
const KIND = {
  skill: { badge: 'S', color: slot(0), name: 'Skill' },
  agent: { badge: 'A', color: slot(5), name: 'Subagent' },
  command: { badge: '/', color: 'var(--ws-faint)', name: 'Command' },
};
const kindOf = kind => KIND[kind] || { badge: '·', color: 'var(--ws-faint)', name: 'Step' };
const TOKENS = [['input', 'Input', slot(3)], ['output', 'Output', slot(1)], ['cacheRead', 'Cache read', slot(0)], ['cacheCreation', 'Cache write', slot(2)]];
const STATUS = { completed: 'Completed', failed: 'Failed', incomplete: 'Didn’t finish', unknown: 'Unknown' };

const finite = v => typeof v === 'number' && Number.isFinite(v);
const pad = (n, width = 2) => String(n).padStart(width, '0');

/** A duration on the timeline: `840ms`, `12.4s`, `3m 5s`, `9h 38m 5s`. */
export function tlDur(ms) {
  const v = Math.max(0, finite(ms) ? ms : 0);
  if (v < 1000) return `${Math.round(v)}ms`;
  if (v < 60_000) return `${Math.round(v / 100) / 10}s`;
  const x = Math.round(v / 1000);
  if (x < 3600) return `${Math.floor(x / 60)}m ${x % 60}s`;
  return `${Math.floor(x / 3600)}h ${Math.floor((x % 3600) / 60)}m ${x % 60}s`;
}

/** `16:40:05.120` in `zone`. */
export const hms = (ms, zone) => `${hm(ms, zone)}:${pad(Math.floor((((ms % 60_000) + 60_000) % 60_000) / 1000))}.${pad(((ms % 1000) + 1000) % 1000, 3)}`;

const shortId = id => (id.length > 16 ? `${id.slice(0, 8)}…${id.slice(-4)}` : id);
const homePath = p => p.replace(/^\/Users\/[^/]+/, '~');
const midPath = (p, n = 54) => {
  const h = homePath(p);
  return h.length > n ? `${h.slice(0, 24)}…${h.slice(-(n - 25))}` : h;
};

/** The CLI could price the session: it gave no reason why not, and it had a log or a cost. */
const priced = s => !s.usageUnavailableReason && (s.hadLog === true || (finite(s.costUSD) && s.costUSD > 0));
const reasonOf = s => {
  const r = String(s.usageUnavailableReason || '').trim();
  return r ? (/[.!?]$/.test(r) ? r : `${r}.`) : 'This session has no log to price.';
};
/** The session's last observed activity, or its start plus its length. */
const endOf = s => (finite(s.observedEnd) ? s.observedEnd : s.startTime + (finite(s.durationMs) ? s.durationMs : 0));

/** The dispatch behind each trace key, keyed as the CLI keys its steps (view/trace.ts
 *  `buildTrace`): the dispatch id; a repeated id `<id>:duplicate:<index>`, none `legacy:<index>`. */
function stepDispatches(session) {
  const out = new Map();
  (session?.dispatches || []).forEach((d, i) => {
    if (d?.id == null) {
      out.set(`legacy:${i}`, d);
      return;
    }
    const id = String(d.id);
    out.set(out.has(id) ? `${id}:duplicate:${i}` : id, d);
  });
  return out;
}

/** One colour per model, in the order the record names them. */
function modelColors(s) {
  const order = [];
  for (const m of [...(s.models || []), ...(s.perModelCost || []).map(x => x.model), ...(s.modelTimeline || []).map(x => x.model)]) {
    if (!order.includes(m)) order.push(m);
  }
  return m => slot(Math.max(0, order.indexOf(m)));
}

// ---------------------------------------------------------------- small parts

const act = (action, value) => `data-action="${action}" data-value="${e(value)}"`;
const hint = text => `<span class="ws-an-hint" tabindex="0" role="img" aria-label="${e(text)}" data-an-tip="${e(tipHtml({ text }))}">${icon('info')}</span>`;
const kpi = (label, value, sub, help) => `<div class="ws-an-kpi"><div class="ws-an-kpi-l">${e(label)}${help ? hint(help) : ''}</div><div class="ws-an-kpi-v">${value}</div><div class="ws-an-kpi-d">${sub || ''}</div></div>`;
const stat = (label, value, sub) => `<div><dt>${e(label)}</dt><dd>${value}</dd>${sub ? `<small>${sub}</small>` : ''}</div>`;
const ev = (label, at, zone) => `<div class="ws-an-ev"><span>${label}</span><time>${hms(at, zone)}</time></div>`;
const sec = (label, body) => `<div class="ws-an-sd-sec"><div class="ws-an-sd-label">${label}</div>${body}</div>`;
/** A link to a step in the side panel (`data-where` tells it apart from the tree's own button). */
const stepLink = (t, html) => `<button type="button" class="ws-an-sd-link" ${act('analytics-step', t.key)} data-where="side">${html}</button>`;
const closeButton = `<button type="button" class="ws-btn ws-btn-ghost ws-btn-sm ws-btn-icon ws-an-close" data-action="analytics-close" title="Close" aria-label="Close">${icon('close')}</button>`;

function shell(head, body) {
  return `<div class="ws-an-scrim" data-action="analytics-close" aria-hidden="true"></div><aside class="ws-an-drawer" role="dialog" aria-modal="false" aria-label="Session details">${head}<div class="ws-an-db">${body}</div></aside>`;
}

/** A thin bar of the four token kinds, then their counts. */
function tokenBreak(t, title) {
  if (!t || !finite(t.total)) return '';
  const bar = `<div class="ws-an-thin">${TOKENS.map(([k, , c]) => (t[k] > 0 ? `<span style="flex:${t[k]};background:${c}"></span>` : '')).join('')}</div>`;
  return sec(e(title), `${bar}<dl class="ws-an-sd-grid ws-an-sd-g4">${TOKENS.map(([k, label, c]) => stat(label, `<i class="ws-an-swatch" style="background:${c}"></i>${n0(t[k])}`)).join('')}</dl>`);
}

// ---------------------------------------------------------------- header and the five numbers

function header(s, ui) {
  const zone = ui.zone || 'UTC';
  const title = s.title || 'Untitled session';
  const source = s.sessionSource && s.sessionSource !== 'Pure chat' ? `<span class="ws-an-tag">${e(s.sessionSource)}</span>` : '';
  const connect = ui.inConnect ? `<span class="ws-an-tag ws-an-tag-connect" title="Started in Connect&#39;s terminal">${icon('terminal')}Started in Connect</span>` : '';
  const meta = [
    (s.models || []).map(modelLabel).join(' → '),
    s.project ? projectName(s.project) : '',
    s.branch || '',
  ].filter(Boolean).map((x, i) => `<span>${i ? '<span class="ws-an-sep">·</span>' : ''}${e(x)}</span>`).join('');
  const when = finite(s.startTime) ? `<span class="ws-an-when">${e(`${dayName(s.startTime, ui.now ?? Date.now(), zone)} ${hm(s.startTime, zone)}`)}</span>` : '';
  const ids = `${when}<button type="button" class="ws-an-idbtn" ${act('analytics-copy', s.sessionId)} title="Copy the session ID">ID ${e(shortId(String(s.sessionId ?? '')))}${icon('copy')}</button>${s.agentSessionFile ? `<button type="button" class="ws-an-idbtn" ${act('analytics-copy', s.agentSessionFile)} title="Copy the log path: ${e(s.agentSessionFile)}">Log ${e(midPath(String(s.agentSessionFile)))}${icon('copy')}</button>` : ''}`;
  const report = `<button type="button" class="ws-btn ws-btn-secondary ws-btn-sm ws-an-dreport" data-action="analytics-report" title="The CLI&#39;s own HTML report for the page&#39;s dates and filters">${icon('external')}<span>Open the CLI report</span></button>`;
  return `<header class="ws-an-dh"><div class="ws-an-dh-t"><h2 title="${e(title)}">${e(title)}</h2><div class="ws-an-dh-m"><span class="ws-an-tag">${e(agentLabel(s.agentName))}</span>${source}${connect}${meta}</div><div class="ws-an-ids">${ids}</div></div>${report}${closeButton}</header>`;
}

function strip(s, zone) {
  const p = priced(s);
  const failed = s.toolCallsFailure || 0;
  const tools = failed ? `${n0(failed)} failed · ${n0(s.toolCallsSuccess)} worked` : s.toolCallsTotal ? 'all worked' : 'none';
  const changed = s.filesChanged ? `<span class="ws-an-plus">+${n0(s.linesAdded)}</span> <span class="ws-an-minus">−${n0(s.linesRemoved)}</span>` : '—';
  return `<div class="ws-an-kpis ws-an-dstats">
    ${kpi('Estimated cost', p ? e(usd(s.costUSD, true)) : '—', p ? `<span>${e(usd(s.cacheReadCostUSD))} on cache reads</span>` : '<span>no log to price</span>', p ? 'An API-equivalent estimate: the session’s tokens priced at standard rates.' : reasonOf(s))}
    ${kpi('Duration', e(tlDur(s.durationMs)), finite(s.startTime) ? `<span>started ${hm(s.startTime, zone)}</span>` : '')}
    ${kpi('Turns', n0(s.turns), `<span>${p && finite(s.tokens?.total) ? `${tok(s.tokens.total)} tokens` : 'tokens unknown'}</span>`)}
    ${kpi('Tool calls', n0(s.toolCallsTotal), `<span>${tools}</span>`)}
    ${kpi('Code changed', changed, `<span>${s.filesChanged ? `${n0(s.filesChanged)} ${plural(s.filesChanged, 'file')}` : 'no files changed'}</span>`)}
  </div>`;
}

// ---------------------------------------------------------------- the side panel

function sessionSide(s, steps, zone) {
  const p = priced(s);
  const { trace, byKey, dispatchOf } = steps;
  const grid = `<dl class="ws-an-sd-grid">${stat('Total cost', p ? e(usd(s.costUSD, true)) : '—', p ? 'API-equivalent estimate' : '')}${stat('Total tokens', p ? n0(s.tokens?.total) : '—')}${stat('Elapsed', e(tlDur(s.durationMs)), finite(s.durationMs) ? `${n0(s.durationMs)} ms` : '')}${stat('Turns', n0(s.turns))}</dl>`;
  let cost = '';
  if (!p) {
    cost = `<p class="ws-an-sd-note">${e(reasonOf(s))}</p>`;
  } else if (finite(s.rootOwnCostUSD)) {
    // Each row is the CLI's own attribution: the session's own usage, the total of every subagent
    // whose nearest subagent above it is the session (its child steps included; a skill or command
    // in between doesn't count) and what no step claimed.
    const row = (label, tokens, usdValue, cls = '') => `<tr${cls ? ` class="${cls}"` : ''}><td>${label}</td><td class="ws-an-r">${finite(tokens) ? tok(tokens) : '—'}</td><td class="ws-an-r">${e(usd(usdValue, true))}</td></tr>`;
    const underSession = t => {
      const seen = new Set();
      for (let up = byKey.get(t.parentKey); up && !seen.has(up.key); up = byKey.get(up.parentKey)) {
        if (up.kind === 'agent') return false;
        seen.add(up.key);
      }
      return true;
    };
    const tops = trace.filter(t => t.kind === 'agent' && underSession(t));
    const agents = tops.map(t => {
      const d = dispatchOf(t.key) || {};
      return row(`↳ ${e(t.label)}`, (d.inclusiveTokens || d.tokens)?.total, finite(d.inclusiveCostUSD) ? d.inclusiveCostUSD : d.costUSD, 'ws-an-where-agent');
    }).join('');
    const unlinked = finite(s.unlinkedCostUSD) && s.unlinkedCostUSD > 0 ? row('Not linked to a step', s.unlinkedTokens?.total, s.unlinkedCostUSD) : '';
    const note = tops.length ? '<p class="ws-an-sd-note ws-an-where-note">A subagent’s row already includes its own child steps; they aren’t listed again.</p>' : '';
    cost = sec('Where the cost went', `<table class="ws-an-where">${row('The session itself', s.rootOwnTokens?.total, s.rootOwnCostUSD)}${agents}${unlinked}${row('Total', s.tokens?.total, s.costUSD, 'ws-an-tot')}</table>${note}`);
  }
  const timing = finite(s.startTime) ? sec('Timing', `${ev('Started', s.startTime, zone)}${finite(s.observedEnd) ? ev('Last activity', s.observedEnd, zone) : ''}`) : '';
  const roots = trace.filter(t => !t.parentKey);
  const list = roots.length ? sec(`Steps (${n0(trace.length)})`, roots.map(t => stepLink(t, `↳ ${e(t.label)}${t.childKeys?.length ? ` <span class="ws-an-faint">+${n0(t.childKeys.length)}</span>` : ''}`)).join('')) : '';
  return `<div class="ws-an-sd-h"><span class="ws-an-sd-dot ws-an-sd-dot-root"></span><b>Session</b></div>${grid}${cost}${timing}${list}`;
}

function stepSide(s, t, steps, zone) {
  const d = steps.dispatchOf(t.key) || {};
  const k = kindOf(t.kind);
  const estimated = d.attributionStatus === 'estimated';
  const hasTotal = finite(d.inclusiveCostUSD);
  const kids = (t.childKeys || []).map(key => steps.byKey.get(key)).filter(Boolean);
  const cost = hasTotal ? d.inclusiveCostUSD : d.costUSD;
  const tokens = (d.inclusiveTokens || d.tokens)?.total;
  const incomplete = d.status === 'incomplete' || d.status === 'unknown';
  const elapsed = finite(d.elapsedMs) ? d.elapsedMs : 0;
  const parent = t.parentKey ? steps.byKey.get(t.parentKey) : null;
  const status = [STATUS[d.status] || 'Not recorded', t.issue, finite(d.depth) ? `nesting level ${d.depth}` : ''].filter(Boolean).join(' · ');
  const where = parent ? stepLink(parent, `↑ Parent: ${e(parent.label)}`) : t.parentKey || t.issue ? '' : '<p class="ws-an-sd-note">Belongs to the session itself.</p>';
  let h = `<div class="ws-an-sd-h"><span class="ws-an-sd-dot" style="background:${k.color}"></span><b>${e(t.label)}</b><span class="ws-an-tag">${k.name}</span></div>
    <div class="ws-an-sd-status${d.status === 'failed' ? ' ws-an-bad' : ''}">${e(status)}</div>
    ${d.id != null ? `<button type="button" class="ws-an-idbtn ws-an-step-id" ${act('analytics-copy', d.id)} title="Copy the step ID">${e(shortId(String(d.id)))}${icon('copy')}</button>` : ''}${where}
    <dl class="ws-an-sd-grid">${stat(estimated ? 'Estimated cost' : hasTotal ? 'Total cost' : 'Cost', finite(cost) ? e(usd(cost, true)) : '—')}${stat(estimated ? 'Estimated tokens' : hasTotal ? 'Total tokens' : 'Tokens', finite(tokens) ? n0(tokens) : '—')}${stat(incomplete ? 'Observed time' : 'Took', e(tlDur(elapsed)), elapsed ? `${n0(elapsed)} ms` : '')}${finite(d.start) && finite(s.startTime) ? stat('Started', `+${e(tlDur(d.start - s.startTime))}`, 'into the session') : ''}</dl>`;
  if (kids.length && hasTotal) h += sec('This subagent alone', `<dl class="ws-an-sd-grid">${stat('Its own cost', e(usd(d.costUSD, true)))}${stat('Its own tokens', n0(d.tokens?.total))}</dl><p class="ws-an-sd-note">The total above includes every child step. Child totals overlap it, so don’t add them together.</p>`);
  if (estimated) h += `<p class="ws-an-sd-note">Estimated from the session’s activity while this ${t.kind === 'skill' ? 'skill was loaded' : 'step ran'}. It overlaps the session’s own cost; it isn’t extra.</p>`;
  else if (d.attributionStatus === 'unavailable') h += '<p class="ws-an-sd-note">Commands have no cost of their own.</p>';
  if (incomplete) h += '<p class="ws-an-sd-note ws-an-warn-text">Completion wasn’t recorded; the bar shows only the activity seen so far.</p>';
  const times = [['Started', d.start], ['Acknowledged', d.acknowledgedAt], ['Last activity', d.observedEnd], ['Completed', d.completedAt]].filter(([, at]) => finite(at));
  if (times.length) {
    const after = finite(d.acknowledgedAt) && finite(d.start) ? `<p class="ws-an-sd-note">Acknowledged after ${e(tlDur(d.acknowledgedAt - d.start))}.</p>` : '';
    h += sec('Timing', `${times.map(([label, at]) => ev(label, at, zone)).join('')}${after}`);
  }
  h += tokenBreak(d.tokens, kids.length ? 'Its own tokens by kind' : 'Tokens');
  if (d.tools?.length) h += sec('Tools it called', `<div class="ws-an-chips">${d.tools.map(x => `<span class="ws-an-tag">${e(x.name)} <b>×${n0(x.calls)}</b></span>`).join('')}</div>`);
  if (kids.length) h += sec(`Child steps (${n0(kids.length)})`, kids.map(c => stepLink(c, `↳ ${e(c.label)}`)).join(''));
  return h;
}

// ---------------------------------------------------------------- the tabs

function traceTab(s, steps, ui) {
  const zone = ui.zone || 'UTC';
  const { trace, byKey, dispatchOf } = steps;
  const p = priced(s);
  const start = s.startTime;
  const end = endOf(s);
  const span = Math.max(60_000, end - start);
  const counts = { agent: 0, skill: 0, command: 0 };
  for (const t of trace) if (t.kind in counts) counts[t.kind]++;
  const summary = trace.length
    ? [[counts.agent, 'subagent'], [counts.skill, 'skill'], [counts.command, 'command']].filter(([n]) => n).map(([n, w]) => `${n0(n)} ${plural(n, w)}`).join(' · ')
    : 'The agent worked on its own: no skills, subagents or commands';

  const stepMin = [1, 2, 5, 10, 15, 30, 60, 120, 240, 480, 720, 1440].find(m => span / (m * 60_000) <= 5) || Math.ceil(span / 300_000);
  let ticks = '';
  for (let m = 0; m * 60_000 <= span; m += stepMin) ticks += `<span style="left:${((m * 60_000) / span) * 100}%">${m === 0 ? hm(start, zone) : `+${m >= 60 ? `${m / 60}h` : `${m}m`}`}</span>`;

  // The model lane: one segment per run of turns on the same model.
  const color = modelColors(s);
  const segs = [];
  for (const point of s.modelTimeline || []) if (segs.at(-1)?.model !== point.model) segs.push({ model: point.model, t: point.t });
  segs.forEach((g, i) => { g.end = segs[i + 1] ? segs[i + 1].t : end; });
  const lane = segs.length
    ? segs.map(g => `<span style="flex:${Math.max(1, g.end - g.t)};background:${color(g.model)}" data-an-tip="${e(tipHtml({ title: modelLabel(g.model), rows: [{ value: `${hm(g.t, zone)}–${hm(g.end, zone)}`, label: '', color: color(g.model) }] }))}"></span>`).join('')
    : '<span class="ws-an-mlane-none"></span>';
  const costLane = s.costSeries?.length ? '<div class="ws-an-chart" data-chart="session-cost"></div>' : '<span class="ws-an-faint">No per-turn data in this log.</span>';

  const sel = ui.selected || 'session';
  const collapsed = ui.collapsed instanceof Set ? ui.collapsed : new Set(ui.collapsed || []);
  const hidden = t => {
    const seen = new Set();
    for (let up = byKey.get(t.parentKey); up && !seen.has(up.key); up = byKey.get(up.parentKey)) {
      if (collapsed.has(up.key)) return true;
      seen.add(up.key);
    }
    return false;
  };
  const pick = (key, inner) => `<button type="button" class="ws-an-tl-pick" ${act('analytics-step', key)} data-where="tree" aria-pressed="${sel === key}">${inner}</button>`;
  const root = `<div class="ws-an-tl-row ws-an-tl-root${sel === 'session' ? ' ws-an-sel' : ''}" data-step="session" ${act('analytics-step', 'session')}><span class="ws-an-tl-lab"><span class="ws-an-chev-sp"></span>${pick('session', `<span class="ws-an-kind ws-an-kind-root">${icon('terminal')}</span><span class="ws-an-nm"><b>Session</b></span>`)}</span><span class="ws-an-lane"><span class="ws-an-tbar ws-an-tbar-sess" style="left:0;width:100%">${p ? e(usd(s.costUSD)) : ''}</span></span><span class="ws-an-r">${e(tlDur(s.durationMs))}</span></div>`;
  const rows = trace.filter(t => !hidden(t)).map(t => {
    const d = dispatchOf(t.key) || {};
    const k = kindOf(t.kind);
    const level = Number.isInteger(t.level) && t.level > 0 ? t.level : 0;
    const left = finite(d.start) ? Math.max(0, Math.min(99.4, ((d.start - start) / span) * 100)) : 0;
    const elapsed = finite(d.elapsedMs) ? d.elapsedMs : 0;
    const width = Math.max(0.6, Math.min(100 - left, (elapsed / span) * 100));
    const cost = finite(d.inclusiveCostUSD) ? d.inclusiveCostUSD : d.costUSD;
    const mark = t.kind === 'command'
      ? `<span class="ws-an-pt" style="left:${left}%"></span>`
      : `<span class="ws-an-tbar" style="left:${left}%;width:${width}%;background-color:${k.color}">${finite(cost) && width > 11 ? e(usd(cost)) : ''}</span>`;
    const closed = collapsed.has(t.key);
    const chev = t.childKeys?.length
      ? `<button type="button" class="ws-an-chev${closed ? ' ws-an-closed' : ''}" aria-label="${closed ? 'Show' : 'Hide'} its steps" aria-expanded="${!closed}" ${act('analytics-step-toggle', t.key)}>${icon('chevron-down')}</button>`
      : '<span class="ws-an-chev-sp"></span>';
    const flag = d.status === 'failed' ? `<span class="ws-an-flag ws-an-bad" title="Failed">${icon('alert')}</span>`
      : d.status === 'incomplete' ? `<span class="ws-an-flag" title="Didn’t finish">${icon('clock')}</span>`
        : t.issue ? `<span class="ws-an-flag" title="${e(t.issue)}">${icon('alert')}</span>` : '';
    return `<div class="ws-an-tl-row${sel === t.key ? ' ws-an-sel' : ''}${d.status === 'failed' ? ' ws-an-failed' : ''}" data-step="${e(t.key)}" data-level="${level}" ${act('analytics-step', t.key)} title="${e(`${k.name} · ${t.label}`)}"><span class="ws-an-tl-lab" style="padding-left:${4 + level * 16}px">${chev}${pick(t.key, `<span class="ws-an-kind" style="background:${k.color}">${k.badge}</span><span class="ws-an-nm">${e(t.label)}</span>`)}${flag}</span><span class="ws-an-lane">${mark}</span><span class="ws-an-r">${t.kind === 'command' ? '' : e(tlDur(elapsed))}</span></div>`;
  }).join('');
  const legend = trace.length ? `<div class="ws-an-kind-legend"><span><i class="ws-an-lg-sq" style="background:${KIND.skill.color}"></i>Skill</span><span><i class="ws-an-lg-sq" style="background:${KIND.agent.color}"></i>Subagent</span><span><i class="ws-an-lg-dm"></i>Command</span><span><i class="ws-an-lg-sq ws-an-hatch" style="background-color:${KIND.agent.color}"></i>Failed</span></div>` : '';
  const chosen = sel === 'session' ? null : byKey.get(sel);
  return `<div class="ws-an-tl-sum"><b>${e(summary)}</b><span class="ws-spacer"></span><span>${hm(start, zone)} – ${hm(end, zone)}</span></div>
    <div class="ws-an-trace-grid"><div class="ws-an-trace">
      <div class="ws-an-tl-axis"><span></span><div class="ws-an-ticks">${ticks}</div><span></span></div>
      <div class="ws-an-tl-lane"><span class="ws-an-lab">${icon('cpu')}Model</span><div class="ws-an-mlane">${lane}</div><span class="ws-an-r"></span></div>
      <div class="ws-an-tl-lane ws-an-tl-cost"><span class="ws-an-lab">${icon('chart')}Cost so far</span><div class="ws-an-tl-track">${costLane}</div><span class="ws-an-r">${p ? e(usd(s.costUSD)) : '—'}</span></div>
      <div class="ws-an-tl-rows">${root}${rows}</div>${legend}
    </div><aside class="ws-an-side" aria-label="Step details">${chosen ? stepSide(s, chosen, steps, zone) : sessionSide(s, steps, zone)}</aside></div>`;
}

function costTab(s, ui) {
  const zone = ui.zone || 'UTC';
  if (!priced(s)) return `<div class="ws-an-none">${e(reasonOf(s))}</div>`;
  const t = s.tokens || {};
  const color = modelColors(s);
  const models = s.perModelCost || [];
  const max = Math.max(0.01, ...models.map(m => (finite(m.costUSD) ? m.costUSD : 0)));
  const end = endOf(s);
  const tokens = `<dl class="ws-an-sd-grid ws-an-sd-g5">${TOKENS.map(([k, label, c]) => stat(label, `<i class="ws-an-swatch" style="background:${c}"></i>${tok(t[k])}`)).join('')}${stat('Total', tok(t.total))}</dl><div class="ws-an-thin ws-an-thin-l">${TOKENS.map(([k, , c]) => (t[k] > 0 ? `<span style="flex:${t[k]};background:${c}"></span>` : '')).join('')}</div>`;
  const byModel = `<div class="ws-an-rows">${models.map(m => `<div class="ws-an-row"><div class="ws-an-n"><i class="ws-an-swatch" style="background:${color(m.model)}"></i><span class="ws-an-t">${e(modelLabel(m.model))}</span></div><div class="ws-an-val">${e(usd(m.costUSD, true))}<small>${tok(m.tokens?.total)} tokens</small></div><div class="ws-an-track"><span style="width:${(((finite(m.costUSD) ? m.costUSD : 0) / max) * 100).toFixed(1)}%;background:${color(m.model)}"></span></div></div>`).join('')}</div>`;
  // The CLI's own points, as a chart or (the page's table switch) as a table.
  const points = Array.isArray(s.costSeries) ? s.costSeries : [];
  const asTable = !!ui.tables?.sessionGrow;
  const toggle = points.length ? `<button type="button" class="ws-btn ws-btn-ghost ws-btn-sm ws-btn-icon ws-an-table-btn" aria-pressed="${asTable}" ${act('analytics-table', 'sessionGrow')} title="${asTable ? 'Show the chart' : 'Show as a table'}" aria-label="${asTable ? 'Show the chart' : 'Show as a table'}">${icon(asTable ? 'chart' : 'table')}</button>` : '';
  const withTokens = points.some(x => finite(x.tokens));
  const growTable = `<div class="ws-an-tscroll ws-an-grow-table"><table class="ws-an-table"><thead><tr><th>Time</th><th class="ws-an-r">Cost so far</th>${withTokens ? '<th class="ws-an-r">Tokens so far</th>' : ''}</tr></thead><tbody>${points.map(x => `<tr><td>${finite(x.t) ? hms(x.t, zone) : '—'}</td><td class="ws-an-r">${e(usd(x.cost, true))}</td>${withTokens ? `<td class="ws-an-r">${tok(x.tokens)}</td>` : ''}</tr>`).join('')}</tbody></table></div>`;
  const growth = !points.length ? '<p class="ws-an-sd-note">No per-turn data in this log.</p>'
    : asTable ? growTable
      : `<div class="ws-an-chart" data-chart="session-grow"></div><div class="ws-an-axis-ends"><span>${hm(s.startTime, zone)}</span><span>${hm(end, zone)}</span></div>`;
  return `<div class="ws-an-dsec"><div class="ws-an-sd-label">Tokens</div>${tokens}</div>
    <div class="ws-an-dsec"><div class="ws-an-sd-label">Cost by model</div>${models.length ? byModel : '<p class="ws-an-sd-note">No model was priced.</p>'}</div>
    <div class="ws-an-dsec"><div class="ws-an-sd-label ws-an-grow-h"><span>Cost over the session <span class="ws-an-faint">· ${e(usd(s.costUSD, true))} by ${hm(end, zone)}</span></span><span class="ws-spacer"></span>${toggle}</div>${growth}</div>
    <p class="ws-an-sd-note">Estimated from the agent’s own log at standard API token rates. Cache reads cost ${e(usd(s.cacheReadCostUSD, true))} of it.</p>`;
}

function toolsTab(s) {
  const tools = (s.tools || []).slice().sort((a, b) => (b.totalCalls || 0) - (a.totalCalls || 0));
  const max = Math.max(1, ...tools.map(t => t.totalCalls || 0));
  const failed = s.toolCallsFailure || 0;
  const rows = tools.map(t => `<div class="ws-an-row"><div class="ws-an-n"><span class="ws-an-t">${e(t.toolName)}</span>${t.failureCount ? `<span class="ws-an-flag">${icon('alert')}${n0(t.failureCount)} failed</span>` : ''}</div><div class="ws-an-val">${n0(t.totalCalls)}<small>${pctPoints(t.successRate)} worked</small></div><div class="ws-an-track"><span style="width:${(((t.totalCalls || 0) / max) * 100).toFixed(1)}%${t.successRate < 80 ? ';background:var(--ws-red)' : ''}"></span></div></div>`).join('');
  const chips = (title, list, prefix = '') => `<div class="ws-an-dsec"><div class="ws-an-sd-label">${title}</div>${list?.length
    ? `<div class="ws-an-chips">${list.slice().sort((a, b) => (b.totalCalls || 0) - (a.totalCalls || 0)).map(x => `<span class="ws-an-tag">${prefix && !String(x.name).startsWith(prefix) ? prefix : ''}${e(x.name)} <b>×${n0(x.totalCalls)}</b></span>`).join('')}</div>`
    : '<p class="ws-an-sd-note">None in this session.</p>'}</div>`;
  return `<div class="ws-an-dsec"><div class="ws-an-sd-label">Tool calls <span class="ws-an-faint">· ${n0(s.toolCallsTotal)} calls, ${failed ? `${n0(failed)} failed` : 'all worked'}</span></div>${tools.length ? `<div class="ws-an-rows">${rows}</div>` : '<p class="ws-an-sd-note">No tool calls.</p>'}</div>
    <div class="ws-an-dgrid3">${chips('Skills', s.skillInvocations)}${chips('Subagents', s.agentInvocations)}${chips('Commands', s.commandInvocations, '/')}</div>`;
}

// ---------------------------------------------------------------- the drawer

/** The steps of `detail`: the CLI's trace, each entry by key, and the dispatch behind a key. */
function stepsOf(detail) {
  const trace = Array.isArray(detail.trace) ? detail.trace : [];
  const dispatches = stepDispatches(detail.session);
  return { trace, byKey: new Map(trace.map(t => [t.key, t])), dispatchOf: key => dispatches.get(key) || null };
}

/** The drawer for one session: reading it, why it couldn't be read, or the session. */
export function sessionDrawer(detail, ui = {}) {
  const zone = ui.zone || 'UTC';
  if (ui.error) {
    const retry = ui.id ? `<div class="ws-actions"><button type="button" class="ws-btn ws-btn-secondary" ${act('analytics-open-session', ui.id)}>${icon('refresh')}<span>Try again</span></button></div>` : '';
    return shell(`<header class="ws-an-dh"><div class="ws-an-dh-t"><h2>Session</h2></div>${closeButton}</header>`, `<div class="ws-empty"><span class="ws-empty-icon">${icon('alert')}</span><strong>This session couldn’t be read</strong><p>${e(ui.error)}</p>${retry}</div>`);
  }
  const s = detail?.session;
  if (!s) return shell(`<header class="ws-an-dh"><div class="ws-an-dh-t"><h2>Session</h2></div>${closeButton}</header>`, `<div class="ws-an-state">${spinner('Reading the session')}<span>Reading the session…</span></div>`);
  const steps = stepsOf(detail);
  const tab = SESSION_TABS.some(([id]) => id === ui.tab) ? ui.tab : 'trace';
  const tabs = `<div class="ws-tabs ws-an-dtabs" role="tablist" aria-label="Session">${SESSION_TABS.map(([id, label]) => `<button type="button" role="tab" aria-selected="${tab === id}" ${act('analytics-session-tab', id)}>${e(label)}</button>`).join('')}</div>`;
  const body = tab === 'cost' ? costTab(s, ui) : tab === 'tools' ? toolsTab(s) : traceTab(s, steps, ui);
  return shell(header(s, ui), `${strip(s, zone)}${tabs}<div class="ws-an-dbody" data-tab="${tab}">${body}</div>`);
}

/** The drawer's charts for the tab shown, by `data-chart` id: the CLI's cost so far over the session. */
export function sessionCharts(detail, ui = {}) {
  const s = detail?.session;
  if (!s || ui.error || !Array.isArray(s.costSeries) || !s.costSeries.length || !finite(s.startTime)) return {};
  const zone = ui.zone || 'UTC';
  const end = endOf(s);
  const points = [{ t: s.startTime, v: 0, tokens: 0 }, ...s.costSeries.map(x => ({ t: x.t, v: x.cost, tokens: x.tokens }))];
  const rows = x => [{ value: usd(x.v), label: 'spent so far', color: slot(0) }, { value: tok(x.tokens), label: 'tokens so far' }];
  const tab = ui.tab || 'trace';
  if (tab === 'trace') {
    const span = Math.max(60_000, end - s.startTime);
    return { 'session-cost': width => area(width, { points, t0: s.startTime, t1: s.startTime + span, color: slot(0), height: 48, aria: 'Cost over the session', tipTitle: x => hm(x.t, zone), tipRows: rows }) };
  }
  if (tab === 'cost' && priced(s) && !ui.tables?.sessionGrow) {
    return { 'session-grow': width => area(width, { points, t0: s.startTime, t1: end, color: slot(0), height: 110, aria: 'Cost over the session', tipTitle: x => `${hm(x.t, zone)} · +${tlDur(x.t - s.startTime)}`, tipRows: rows }) };
  }
  return {};
}
