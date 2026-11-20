// App analytics (docs/superpowers/specs/2026-11-19-analytics-design.md, decision 5): what Connect
// itself spent on AI and what it got done, ported from the prototype's viewApp. The numbers are
// `analytics_app`'s, counted by the backend over Connect's own records (workspace/analytics/app.rs);
// this view formats them as they are and adds nothing up. Pure: `appTab(data, ui)` returns HTML and
// `appCharts(data, ui)` the cost chart app.js draws once its width is known. `data` is the
// `analytics_app` answer plus `now`, `zone` and `profileNames` (the AI profiles' `{id, label}`,
// when the AI settings were read); `ui` is the page's view state (analytics-model.js). A recent
// run's feature is the backend's own (`recent[].feature`).
import { escapeHtml as e } from './store.js';
import { icon } from './icons.js';
import { stackedColumns, tipHtml } from './analytics-charts.js';
import { RUNS_PAGE, presetRange, usd, usdAxis, pct, n0, dur, plural, dShort, dLong, weekday, hm, dayName, dayKeyIn, modelLabel } from './analytics-model.js';

/** The features in the order the backend lists them; the terminal is kept apart. */
const FEATURES = {
  meeting: { label: 'Meeting notes', icon: 'meetings', color: 'var(--ws-an-s1)' },
  draft: { label: 'Reply drafts', icon: 'mail', color: 'var(--ws-an-s2)' },
  summary: { label: 'Summaries', icon: 'note', color: 'var(--ws-an-s3)' },
  automation: { label: 'Automations', icon: 'automations', color: 'var(--ws-an-s4)' },
  plugin: { label: 'Plugins', icon: 'puzzle', color: 'var(--ws-an-s5)' },
  terminal: { label: 'Terminal sessions', icon: 'terminal', color: 'var(--ws-an-s6)' },
};
const BACKGROUND = ['meeting', 'draft', 'summary', 'automation', 'plugin'];
const PURPOSES = { meeting: 'Meeting notes', mail_draft: 'Mail reply', chat_draft: 'Chat reply', summary: 'Summary', automation: 'Automation', plugin: 'Plugin', test: 'Profile test' };
const STATUS = { ok: ['check-circle', 'Done', 'ws-an-ok'], rate_limited: ['alert', 'Usage limit', 'ws-an-amber'], timeout: ['clock', 'Timed out', 'ws-an-amber'], cancelled: ['close', 'Stopped', 'ws-an-muted'] };
const FAILED = ['alert', 'Failed', 'ws-an-bad'];

const finite = v => typeof v === 'number' && Number.isFinite(v);

// ---------------------------------------------------------------- small parts

const act = (action, value) => `data-action="${action}" data-value="${e(value)}"`;
const hint = text => `<span class="ws-an-hint" tabindex="0" role="img" aria-label="${e(text)}" data-an-tip="${e(tipHtml({ text }))}">${icon('info')}</span>`;
const kpi = (label, value, sub, help) => `<div class="ws-an-kpi"><div class="ws-an-kpi-l">${e(label)}${help ? hint(help) : ''}</div><div class="ws-an-kpi-v">${value}</div><div class="ws-an-kpi-d">${sub || ''}</div></div>`;
const seg = (action, current, items, label) => `<div class="ws-segmented ws-an-seg" role="tablist" aria-label="${e(label)}">${items.map(([v, l]) => `<button type="button" role="tab" aria-selected="${v === current}" ${act(action, v)}>${e(l)}</button>`).join('')}</div>`;

/** A card as the AI tabs draw it; `title` and `sub` are HTML; `opts.table` adds the chart/table switch. */
function card(id, title, sub, right, body, ui, opts = {}) {
  const on = !!ui.tables?.[id];
  const tableBtn = opts.table ? `<button type="button" class="ws-btn ws-btn-ghost ws-btn-sm ws-btn-icon ws-an-table-btn" ${act('analytics-table', id)} aria-pressed="${on}" title="${on ? 'Show the chart' : 'Show as a table'}" aria-label="${on ? 'Show the chart' : 'Show as a table'}">${icon(on ? 'chart' : 'table')}</button>` : '';
  return `<section class="ws-an-card" data-card="${id}"><div class="ws-an-ch"><h3>${title}${sub ? ` <span class="ws-an-sub">${sub}</span>` : ''}</h3><span class="ws-spacer"></span>${right || ''}${tableBtn}</div><div class="ws-an-cb${opts.flush ? ' ws-an-flush' : ''}">${body}</div></section>`;
}

/** A table; cells are HTML (escaped by the caller), `right` marks number columns. */
function table(head, rows, right, rowAttrs = null, scroll = true) {
  const cls = i => (right[i] ? ' class="ws-an-r"' : '');
  return `<div class="${scroll ? 'ws-an-tscroll' : 'ws-an-tflat'}"><table class="ws-an-table"><thead><tr>${head.map((h, i) => `<th${cls(i)}>${e(h)}</th>`).join('')}</tr></thead><tbody>${rows.map((r, j) => `<tr${rowAttrs ? ` ${rowAttrs[j]}` : ''}>${r.map((c, i) => `<td${cls(i)}>${c}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`;
}

/** The features the cost chart stacks: background runs, and the terminal once switched on. */
const trendKeys = ui => (ui.appTerm ? [...BACKGROUND, 'terminal'] : BACKGROUND);
/** A bucket as a day (`Wed 18 Nov`) or, when it spans days, `16 Nov – 22 Nov`. */
const bucketLabel = (b, zone) => (dayKeyIn(b.from, zone) === dayKeyIn(b.to, zone) ? dLong(b.from, zone) : `${dShort(b.from, zone)} – ${dShort(b.to, zone)}`);
const cost = (b, k) => (finite(b.by?.[k]) ? b.by[k] : 0);

// ---------------------------------------------------------------- the cards

function kpis(d) {
  const t = d.totals || {};
  const o = d.outcomes || {};
  // The headline and its share are Connect's background runs; the share with the terminal sessions
  // counted in is said apart, in the hint.
  const share = finite(t.backgroundShareOfAll) ? `<span>${pct(t.backgroundShareOfAll)} of all AI cost on this Mac</span>` : '<span>share of all AI cost unknown</span>';
  const withTerminal = finite(t.shareOfAll) ? ` Counting the Claude Code sessions started in Connect’s terminal as well, Connect’s share is ${pct(t.shareOfAll)} of all AI cost on this Mac.` : '';
  return `<div class="ws-an-kpis">
    ${kpi('AI spent from Connect', e(usd(t.costUsd, true)), share, `What Connect’s own background runs cost: meeting notes, drafts, summaries, automations and plugins, from its run log.${withTerminal}`)}
    ${kpi('Runs', n0(t.runs), `<span>+ ${n0(t.terminalSessions)} terminal ${plural(t.terminalSessions, 'session')} · ${e(usd(t.terminalCostUsd))}</span>`, 'Each time Connect asked Claude for something in the background. Terminal sessions are Claude Code sessions started in Connect’s terminal, found in CodeMie analytics.')}
    ${kpi('Runs that failed', n0(t.failed), `<span>${t.runs ? `of ${n0(t.runs)} ${plural(t.runs, 'run')}` : 'no runs'}</span>`, 'Runs that ended with an error. Failed runs that still used tokens keep their cost.')}
    ${kpi('Cost per meeting note', e(usd(o.perNoteUsd)), `<span>${finite(o.perSentUsd) ? `${e(usd(o.perSentUsd))} per sent reply` : 'no replies sent'}</span>`, 'Meeting-note cost divided by the notes made; reply-draft cost divided by the replies you sent.')}
  </div>`;
}

function trendCard(d, ui, zone) {
  const keys = trendKeys(ui);
  const series = Array.isArray(d.series) ? d.series : [];
  const body = ui.tables?.appTrend
    ? table(['Period', ...keys.map(k => FEATURES[k].label)], series.slice().reverse().map(b => [e(bucketLabel(b, zone)), ...keys.map(k => e(usd(cost(b, k))))]), [0, ...keys.map(() => 1)])
    : `<div class="ws-an-chart" data-chart="appTrend"></div><div class="ws-an-legend">${keys.map(k => `<span><i class="ws-an-swatch" style="background:${FEATURES[k].color}"></i>${FEATURES[k].label}</span>`).join('')}</div>`;
  const right = seg('analytics-app-terminal', ui.appTerm ? 'on' : 'off', [['off', 'Background runs'], ['on', 'With terminal']], 'Runs in the chart');
  return card('appTrend', 'AI cost by feature', ui.appTerm ? 'with terminal sessions' : 'background runs', right, body, ui, { table: true });
}

function featuresCard(d, ui) {
  const all = Array.isArray(d.features) ? d.features : [];
  const background = all.filter(f => f.key !== 'terminal' && FEATURES[f.key]);
  const terminal = all.find(f => f.key === 'terminal');
  const max = Math.max(0.01, ...background.map(f => (finite(f.costUsd) ? f.costUsd : 0)));
  const row = f => {
    const meta = FEATURES[f.key];
    const on = ui.appFeature === f.key;
    const width = (((finite(f.costUsd) ? f.costUsd : 0) / max) * 100).toFixed(1);
    return `<button type="button" class="ws-an-row ws-an-row-btn ws-an-feat${on ? ' ws-an-on' : ''}" data-feature="${f.key}" aria-pressed="${on}" ${act('analytics-app-feature', f.key)} title="Show these runs in Recent runs"><span class="ws-an-n"><i class="ws-an-swatch" style="background:${meta.color}"></i><span class="ws-an-t">${meta.label}</span>${f.failed ? `<span class="ws-an-flag">${icon('alert')}${n0(f.failed)} failed</span>` : ''}</span><span class="ws-an-val">${e(usd(f.costUsd))}<small>${n0(f.runs)} ${plural(f.runs, 'run')}${f.runs ? ` · ${e(dur(f.avgMs))} avg` : ''}</small></span><span class="ws-an-track"><span style="width:${width}%;background:${meta.color}"></span></span></button>`;
  };
  const term = terminal ? `<div class="ws-an-row ws-an-feat ws-an-feat-term" data-feature="terminal"><span class="ws-an-n"><i class="ws-an-swatch" style="background:${FEATURES.terminal.color}"></i><span class="ws-an-t">${FEATURES.terminal.label}</span></span><span class="ws-an-val">${e(usd(terminal.costUsd))}<small>${n0(terminal.runs)} ${plural(terminal.runs, 'session')}${terminal.runs ? ` · ${e(dur(terminal.avgMs))} avg` : ''}</small></span></div>` : '';
  const body = `<div class="ws-an-rows">${background.map(row).join('')}</div><div class="ws-an-fgroup">Claude Code in Connect’s terminal<span class="ws-spacer"></span><span>also in AI analytics</span></div><div class="ws-an-rows">${term}</div>`;
  return card('features', 'By feature', '', '', body, ui);
}

/** A profile's name from the AI settings, or its id. */
const profileName = (d, id) => (Array.isArray(d.profileNames) ? d.profileNames.find(p => p.id === id)?.label : '') || id || 'Unknown profile';

function profilesCard(d, ui) {
  const list = Array.isArray(d.profiles) ? d.profiles : [];
  const rows = list.map(p => `<div class="ws-an-row ws-an-row-2"><div class="ws-an-n"><span class="ws-an-t">${e(profileName(d, p.profile))}</span>${p.model ? `<span class="ws-an-tag">${e(modelLabel(p.model))}</span>` : ''}</div><div class="ws-an-val">${e(usd(p.costUsd))}<small>${n0(p.runs)} ${plural(p.runs, 'run')}</small></div></div>`).join('');
  const body = `${list.length ? `<div class="ws-an-rows">${rows}</div>` : '<div class="ws-an-none">No runs in this range.</div>'}<p class="ws-an-note">On a Claude subscription the cost is Claude Code’s own estimate, not a charge. CodeMie profiles show the cost CodeMie reports.</p>`;
  return card('profiles', 'By profile and model', '', '', body, ui);
}

function outcomesCard(d, ui, range) {
  const o = d.outcomes || {};
  const v = x => (finite(x) ? x : 0);
  // The bar shows the counts side by side; it says nothing the numbers below it don't.
  const tile = (iconName, label, big, sub, parts) => `<div class="ws-an-tile"><div class="ws-an-kpi-l">${icon(iconName)}${e(label)}</div><div class="ws-an-tile-v">${big}</div><div class="ws-an-thin">${parts.map(([n, cls]) => (n > 0 ? `<span class="${cls}" style="flex:${n}"></span>` : '')).join('')}</div><div class="ws-an-kpi-d">${sub}</div></div>`;
  const body = `<div class="ws-an-tiles">
    ${tile('meetings', 'Meeting notes', n0(o.noted), `of ${n0(o.transcribed)} transcribed · ${n0(o.meetings)} meetings`, [[v(o.noted), 'ws-an-p1'], [v(o.transcribed) - v(o.noted), 'ws-an-p2'], [v(o.meetings) - v(o.transcribed), 'ws-an-p3']])}
    ${tile('tasks', 'Tasks from meetings', n0(o.tasks), `${n0(o.tasksDone)} done`, [[v(o.tasksDone), 'ws-an-p1'], [v(o.tasks) - v(o.tasksDone), 'ws-an-p2']])}
    ${tile('mail', 'Replies sent', n0(o.sent), `of ${n0(o.drafts)} drafts prepared`, [[v(o.sent), 'ws-an-p1'], [v(o.drafts) - v(o.sent), 'ws-an-p2']])}
    ${tile('inbox', 'Inbox items handled', n0(o.inboxHandled), 'acknowledged or archived', [[v(o.inboxHandled), 'ws-an-p1']])}
    ${tile('automations', 'Automation runs', n0(o.autoOk), `of ${n0(o.autoRuns)} finished`, [[v(o.autoOk), 'ws-an-p1'], [v(o.autoRuns) - v(o.autoOk), 'ws-an-pbad']])}
  </div>`;
  return card('outcomes', 'What Connect did for you', e(range.label.toLowerCase()), '', body, ui);
}

function recentCard(d, ui, now, zone) {
  const feature = BACKGROUND.includes(ui.appFeature) ? ui.appFeature : '';
  let runs = Array.isArray(d.recent) ? d.recent : [];
  if (feature) runs = runs.filter(r => r.feature === feature);
  if (ui.appList === 'failed') runs = runs.filter(r => r.status !== 'ok');
  const shown = runs.slice(0, ui.appShown || RUNS_PAGE);
  const rows = shown.map(r => {
    const at = finite(r.at) ? r.at * 1000 : null;
    const [ic, label, cls] = STATUS[r.status] || FAILED;
    const f = FEATURES[r.feature] && r.feature !== 'terminal' ? r.feature : '';
    return [
      at === null ? '—' : e(`${dayName(at, now, zone)} ${hm(at, zone)}`),
      `<span class="ws-an-runf">${icon(f ? FEATURES[f].icon : 'sparkles')}<span>${e(PURPOSES[r.purpose] || r.purpose || 'Run')}</span></span>`,
      e([profileName(d, r.profile), r.model ? modelLabel(r.model) : ''].filter(Boolean).join(' · ')),
      e(dur(r.durationMs)),
      e(usd(r.costUsd)),
      `<span class="ws-an-runst ${cls}" title="${label}">${icon(ic)}${r.status === 'ok' ? '' : `<span>${label}</span>`}</span>`,
    ];
  });
  const chip = feature ? `<span class="ws-an-chip ws-an-set"><span class="ws-an-fbtn ws-an-set"><span class="ws-an-k">Feature</span><span class="ws-an-v">${FEATURES[feature].label}</span></span><button type="button" class="ws-an-clear" ${act('analytics-app-feature', '')} aria-label="Show every feature" title="Show every feature">${icon('close')}</button></span>` : '';
  const right = `${chip}${seg('analytics-app-list', ui.appList === 'failed' ? 'failed' : 'all', [['all', 'All'], ['failed', 'Failed']], 'Runs')}`;
  const more = runs.length > shown.length ? `<div class="ws-an-more-row"><button type="button" class="ws-btn ws-btn-secondary ws-btn-sm" ${act('analytics-more', 'runs')}>Show ${n0(Math.min(RUNS_PAGE, runs.length - shown.length))} more</button></div>` : '';
  const body = rows.length
    ? `${table(['When', 'Feature', 'Profile · model', 'Time', 'Cost', ''], rows, [0, 0, 0, 1, 1, 1], shown.map(r => `class="ws-an-run" data-run="${e(r.id)}"`), false)}${more}`
    : '<div class="ws-an-none">No runs match.</div>';
  return card('recent', 'Recent runs', '', right, body, ui, { flush: true });
}

// ---------------------------------------------------------------- the tab

/** The App tab: KPIs, the cost chart, by feature, by profile and model, outcomes and recent runs. */
export function appTab(data, ui) {
  const zone = data.zone || 'UTC';
  const now = data.now ?? Date.now();
  const range = presetRange(ui.range, now, zone);
  return `${kpis(data)}<div class="ws-an-grid">${trendCard(data, ui, zone)}</div><div class="ws-an-grid ws-an-g2">${featuresCard(data, ui)}${profilesCard(data, ui)}</div><div class="ws-an-grid">${outcomesCard(data, ui, range)}</div><div class="ws-an-grid">${recentCard(data, ui, now, zone)}</div>`;
}

/** The App tab's chart, by `data-chart` id: AI cost per bucket, stacked by feature. */
export function appCharts(data, ui) {
  if (!data || ui.tables?.appTrend) return {};
  const zone = data.zone || 'UTC';
  const series = Array.isArray(data.series) ? data.series : [];
  const keys = trendKeys(ui);
  const days = series.every(b => dayKeyIn(b.from, zone) === dayKeyIn(b.to, zone));
  return {
    appTrend: width => stackedColumns(width, {
      items: series,
      keys,
      colors: Object.fromEntries(keys.map(k => [k, FEATURES[k].color])),
      part: (i, k) => cost(series[i], k),
      fmtAxis: usdAxis,
      height: 200,
      aria: 'AI cost by feature',
      label: i => (days && series.length <= 7 ? weekday(series[i].from, zone) : dShort(series[i].from, zone)),
      tip: i => {
        const b = series[i];
        return { title: bucketLabel(b, zone), rows: keys.slice().reverse().filter(k => cost(b, k) > 0).map(k => ({ value: usd(cost(b, k)), label: FEATURES[k].label, color: FEATURES[k].color })) };
      },
    }),
  };
}
