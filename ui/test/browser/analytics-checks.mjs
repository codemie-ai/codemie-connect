// Browser checks of the Analytics page (docs/superpowers/plans/2026-11-19-analytics-connect.md,
// Task 6, scenarios A1–A10), run by workspace-e2e.mjs with its MOCKED native bridge: the
// `analytics_*` operations answer from the contract fixtures (ui/test/fixtures/contract/analytics-*.json,
// written by Rust tests), and a Refresh or Try again is acted out with three `workspace:analytics`
// events. Both themes; 1000, 1440 and 1680 px for the looks. It proves the window's side, never the
// CodeMie CLI, the stored sessions or the Mac's logs.
import { readFileSync } from 'node:fs';
import { usd, n0, dur, agentLabel, projectName, presetRange } from '../../workspace/analytics-model.js';

const FIXTURES = new URL('../fixtures/contract/', import.meta.url);
const fx = name => JSON.parse(readFileSync(new URL(name, FIXTURES), 'utf8'));
const DAY = 86_400_000;

export async function analyticsChecks({ open, check, assert, shot, settled, OUT }) {
  const summary = fx('analytics-summary.json');
  const session = fx('analytics-session.json');
  const app = fx('analytics-app.json');
  const statusFx = fx('analytics-status.json');
  const runningFx = fx('analytics-status-running.json');
  const refreshRunning = fx('analytics-refresh-running.json');
  const refreshNeedsCli = fx('analytics-refresh-needs-cli.json');

  /** What the mocked operations answer. The status is the fixture's, as the CLI read it a minute
   *  ago (an older one would make the page refresh by itself on opening) and with no failed day
   *  unless a check says so. */
  const answers = (over = {}) => ({
    status: { ...statusFx, failedDays: [], lastFetchAt: Date.now() - 60_000, ...(over.status || {}) },
    summary: over.summary || summary,
    session,
    app,
    refreshRunning,
    refreshNeedsCli,
  });
  const openAnalytics = async (theme, width, height, over = {}) => {
    const n = await open({ theme, width, height, hash: '#/analytics', analytics: answers(over) });
    await n.page.waitForSelector('.ws-analytics');
    return n;
  };
  const ready = async page => {
    await page.waitForSelector('.ws-an-kpis');
    await settled(page);
  };

  const calls = async (page, op) => (await page.evaluate(() => window.__bridgeCalls)).filter(([o]) => o === op).map(([, d]) => d);
  const zoneOf = page => page.evaluate(() => Intl.DateTimeFormat().resolvedOptions().timeZone);
  const toasts = page => page.locator('.ws-toast').allInnerTexts();
  /** No horizontal scroll on the page or inside the Analytics page's own boxes. */
  const noOverflow = async (page, what) => {
    const over = await page.evaluate(() => Math.max(
      document.documentElement.scrollWidth - window.innerWidth,
      ...[...document.querySelectorAll('.ws-main, .ws-analytics, .ws-an-body, .ws-an-drawer')].filter(el => el.clientWidth > 0).map(el => el.scrollWidth - el.clientWidth),
    ));
    assert(over <= 0, `${what} scrolls sideways by ${over}px`);
  };
  /** No text clipped in a KPI value, its note (`notes`) or a filter, and no two KPIs or filters on top of each other. */
  const noOverlap = async (page, what, notes = true) => {
    const bad = await page.evaluate(notes => {
      const found = [];
      const boxes = (sel, parent) => [...document.querySelectorAll(sel)].filter(el => el.getBoundingClientRect().width > 0).map(el => ({ el, r: el.getBoundingClientRect() }));
      for (const sel of ['.ws-an-kpis > .ws-an-kpi', '.ws-an-filters > *', '.ws-an-head > *']) {
        const list = boxes(sel);
        for (let i = 0; i < list.length; i++) {
          for (let j = i + 1; j < list.length; j++) {
            const a = list[i].r;
            const b = list[j].r;
            if (a.left < b.right - 1 && b.left < a.right - 1 && a.top < b.bottom - 1 && b.top < a.bottom - 1) found.push(`${sel}: boxes ${i} and ${j} overlap`);
          }
        }
      }
      for (const el of document.querySelectorAll(notes ? '.ws-an-kpi-v, .ws-an-kpi-d, .ws-an-fbtn' : '.ws-an-kpi-v, .ws-an-fbtn')) {
        if (el.clientWidth > 0 && el.scrollWidth > el.clientWidth + 1) found.push(`${el.className}: "${el.textContent.trim().slice(0, 30)}" is cut`);
      }
      return found;
    }, notes);
    assert(!bad.length, `${what}: ${bad.join('; ')}`);
  };
  const clean = (errors, what) => assert(errors.length === 0, `${what}: console errors: ${errors.join(' | ')}`);

  for (const theme of ['dark', 'light']) {
    // ---------------------------------------------------------------- A1–A4, A8, A9: one page
    const { page, context, errors } = await openAnalytics(theme, 1440, 900);
    const zone = await zoneOf(page);
    await ready(page);
    const t = summary.totals;

    await check(`A1 ${theme}: Overview shows the summary's four KPIs, the trend, Tools, Models and Projects, a tooltip and the table`, async () => {
      const values = await page.locator('.ws-an-kpis .ws-an-kpi-v').allInnerTexts();
      assert(values.length === 4, `four KPIs: ${values}`);
      assert(values[0].includes(usd(t.costUSD, true)), `cost ${values[0]} vs ${usd(t.costUSD, true)}`);
      assert(values[1].trim() === n0(t.sessions), `sessions ${values[1]} vs ${n0(t.sessions)}`);
      assert(values[2].includes(dur(t.durationMs)), `active time ${values[2]} vs ${dur(t.durationMs)}`);
      assert(values[3].includes(`+${n0(t.netLines)}`), `code changed ${values[3]} vs +${n0(t.netLines)}`);
      const bands = await page.locator('.ws-an-chart[data-chart=trend] .ws-an-band').count();
      assert(bands === summary.series.length, `${bands} trend bars for ${summary.series.length} series items`);
      const tools = await page.locator('[data-card=tools] .ws-an-row').count();
      assert(tools === Math.min(6, summary.tools.length), `${tools} tool rows`);
      const models = await page.locator('[data-card=models] .ws-an-row').count();
      assert(models === summary.models.length, `${models} model rows`);
      const projects = await page.locator('[data-card=projects] .ws-an-row-btn').count();
      assert(projects === Math.min(5, summary.projects.length), `${projects} project rows`);
      // A bar's tooltip says its day's numbers.
      await page.locator('.ws-an-chart[data-chart=trend] .ws-an-band').first().hover();
      await page.waitForFunction(() => getComputedStyle(document.querySelector('.ws-an-tip') || document.body).display === 'block' && document.querySelector('.ws-an-tip')?.textContent.trim());
      const tip = await page.locator('.ws-an-tip').innerText();
      assert(tip.includes(usd(summary.series[0].costUSD)), `tooltip ${JSON.stringify(tip)} lacks ${usd(summary.series[0].costUSD)}`);
      await shot(page, `analytics-${theme}-a1-overview`);
      // The table says the same numbers, newest day first.
      await page.click('[data-action="analytics-table"][data-value="trend"]');
      await settled(page);
      const rows = await page.locator('[data-card=trend] tbody tr').allInnerTexts();
      assert(rows.length === summary.series.length, `${rows.length} table rows`);
      const last = summary.series.at(-1);
      assert(rows[0].includes(usd(last.costUSD)) && rows[0].includes(n0(last.sessions)), `first table row ${JSON.stringify(rows[0])}`);
      await page.click('[data-action="analytics-table"][data-value="trend"]');
      await settled(page);
      assert(await page.locator('.ws-an-chart[data-chart=trend] .ws-an-band').count() === summary.series.length, 'the chart is back');
    });

    await check(`A2 ${theme}: filters send one analytics_view each with the range, agent and project; × clears`, async () => {
      const views = () => calls(page, 'analytics_view');
      const change = async (open, pick) => {
        const before = (await views()).length;
        await page.click(`[data-menu="${open}"] > summary`);
        await page.click(pick);
        await page.waitForFunction(n => window.__bridgeCalls.filter(([o]) => o === 'analytics_view').length > n, before);
        await settled(page);
        const after = await views();
        assert(after.length === before + 1, `${after.length - before} analytics_view calls for one change`);
        return after.at(-1);
      };
      const range = await change('analytics-date', '.ws-an-mi[data-action="analytics-range"][data-value="7d"]');
      const want = presetRange('7d', Date.now(), zone);
      assert(range.from === want.from && range.to === want.to, `range ${range.from} – ${range.to}, wanted ${want.from} – ${want.to}`);
      assert(!('agent' in range) && !('project' in range), `no filters yet: ${JSON.stringify(range)}`);
      const agent = await change('analytics-agent', '.ws-an-mi[data-action="analytics-agent"][data-value="claude"]');
      assert(agent.agent === 'claude' && agent.from === want.from, `agent call ${JSON.stringify(agent)}`);
      const project = summary.projects[0].project;
      const both = await change('analytics-project', `.ws-an-mi[data-action="analytics-project"][data-value="${project}"]`);
      assert(both.agent === 'claude' && both.project === project, `project call ${JSON.stringify(both)}`);
      const chips = await page.locator('.ws-an-filters .ws-an-chip.ws-an-set').allInnerTexts();
      assert(chips.some(c => c.includes(agentLabel('claude'))) && chips.some(c => c.includes(projectName(project))), `chips ${JSON.stringify(chips)}`);
      assert(await page.locator('.ws-an-filters .ws-an-fbtn .ws-an-v').first().innerText() === 'Last 7 days', 'the date chip says Last 7 days');
      // × on the project: one more call, without the project and still with the agent.
      const before = (await views()).length;
      await page.click('.ws-an-clear[data-action="analytics-project"]');
      await page.waitForFunction(n => window.__bridgeCalls.filter(([o]) => o === 'analytics_view').length > n, before);
      await settled(page);
      const cleared = (await views()).at(-1);
      assert((await views()).length === before + 1 && !('project' in cleared) && cleared.agent === 'claude', `cleared call ${JSON.stringify(cleared)}`);
      assert(await page.locator('.ws-an-filters .ws-an-chip.ws-an-set').count() === 1, 'one chip left');
      await page.click('.ws-an-clear[data-action="analytics-agent"]');
      await settled(page);
      assert(await page.locator('.ws-an-filters .ws-an-chip.ws-an-set').count() === 0, 'no chip left');
      await change('analytics-date', '.ws-an-mi[data-action="analytics-range"][data-value="30d"]');
    });

    await check(`A3 ${theme}: the notice hides, survives a reload as a chip, "What's counted" lists coverage, and it comes back`, async () => {
      assert(/Based on sessions saved on this Mac/.test(await page.locator('.ws-an-notice').innerText()), 'the notice shows first');
      await page.click('.ws-an-notice [data-action="analytics-notice"][data-value="hide"]');
      await settled(page);
      assert(await page.locator('.ws-an-notice').count() === 0, 'the notice is hidden');
      assert(await page.locator('.ws-an-chip-local').count() === 1, 'the Local sessions only chip is there');
      await page.reload();
      await page.waitForSelector('.ws-an-filters');
      await ready(page);
      assert(await page.locator('.ws-an-notice').count() === 0 && await page.locator('.ws-an-chip-local').count() === 1, 'the chip survives a reload');
      await page.click('.ws-an-chip-local');
      const pop = await page.locator('[data-menu="analytics-counted-chip"] .ws-menu-panel').innerText();
      for (const c of summary.coverage) {
        assert(pop.includes(agentLabel(c.agentName)) && pop.includes(`${n0(c.sessions)} session`), `coverage row for ${c.agentName} in ${JSON.stringify(pop)}`);
        if (c.withLog < c.sessions) assert(pop.includes(`${n0(c.withLog)} with a log`), 'the sessions without a log are said');
      }
      await shot(page, `analytics-${theme}-a3-counted`);
      await page.click('[data-action="analytics-notice"][data-value="show"]');
      await settled(page);
      assert(await page.locator('.ws-an-notice').count() === 1 && await page.locator('.ws-an-chip-local').count() === 0, 'the notice is back and the chip gone');
    });

    await check(`A4 ${theme}: Refresh disables the button, follows three progress events, says Updated just now and toasts once`, async () => {
      const button = page.locator('.ws-an-refresh');
      assert(await button.isEnabled(), 'Refresh is enabled to begin with');
      assert(!(await page.locator('.ws-an-fresh').innerText()).includes('just now'), 'the data was not just updated');
      await button.click();
      await page.waitForSelector('.ws-an-refresh[disabled]');
      await page.waitForFunction(() => /1 of 3 days/.test(document.querySelector('.ws-an-progress')?.textContent || ''));
      await page.waitForFunction(() => /2 of 3 days/.test(document.querySelector('.ws-an-progress')?.textContent || ''));
      assert(await page.locator('.ws-an-refresh[disabled]').count() === 1, 'the button stays disabled while it reads');
      await page.waitForFunction(() => !document.querySelector('.ws-an-refresh[disabled]'));
      await page.waitForFunction(() => /Updated just now/.test(document.querySelector('.ws-an-fresh')?.textContent || ''));
      assert(await page.locator('.ws-an-progress').count() === 0, 'the progress line is gone');
      const toast = (await toasts(page)).filter(x => x.includes('Analytics updated'));
      assert(toast.length === 1, `${toast.length} "Analytics updated" toasts: ${JSON.stringify(await toasts(page))}`);
      assert((await calls(page, 'analytics_refresh')).length === 1, 'one analytics_refresh');
    });

    // ---------------------------------------------------------------- A8: Sessions and the drawer
    await check(`A8 ${theme}: search, sort by cost, the drawer's trace, a nested subagent, collapse, tabs and Escape`, async () => {
      await page.click('[data-action="analytics-view"][data-value="sessions"]');
      await page.waitForSelector('.ws-an-srow');
      assert(await page.locator('.ws-an-srow').count() === summary.sessions.length, 'every session is listed');
      // The brief's "webhook" is not in the regenerated fixture's invented titles: a word from a real one.
      const word = 'release';
      const wanted = summary.sessions.filter(s => s.title.toLowerCase().includes(word));
      assert(wanted.length >= 1 && wanted.length < summary.sessions.length, `"${word}" must match some titles, not all`);
      await page.fill('#analytics-search', word);
      await page.waitForFunction(n => document.querySelectorAll('.ws-an-srow').length === n, wanted.length);
      const titles = await page.locator('.ws-an-srow b').allInnerTexts();
      assert(JSON.stringify(titles.sort()) === JSON.stringify(wanted.map(s => s.title).sort()), `search shows ${JSON.stringify(titles)}`);
      await page.fill('#analytics-search', '');
      await page.waitForFunction(n => document.querySelectorAll('.ws-an-srow').length === n, summary.sessions.length);
      await page.click('.ws-an-sh [data-action="analytics-sort"][data-value="cost"]');
      await settled(page);
      const order = await page.locator('.ws-an-srow b').allInnerTexts();
      const byCost = summary.sessions.slice().sort((a, b) => b.costUSD - a.costUSD).map(s => s.title);
      assert(JSON.stringify(order) === JSON.stringify(byCost), `by cost: ${JSON.stringify(order)} vs ${JSON.stringify(byCost)}`);
      await shot(page, `analytics-${theme}-a8-sessions`);

      await page.locator('.ws-an-srow').first().click();
      await page.waitForSelector('.ws-an-drawer h2');
      await page.waitForFunction(t => document.querySelector('.ws-an-drawer h2')?.textContent === t, session.session.title);
      const steps = await page.locator('.ws-an-tl-row[data-step]').count();
      assert(steps === session.trace.length + 1, `${steps} trace rows for ${session.trace.length} entries and the session`);
      const parent = session.trace.find(x => x.childKeys.length);
      const child = session.trace.find(x => x.parentKey === parent.key);
      await page.click(`.ws-an-tl-row[data-step="${child.key}"] .ws-an-tl-pick`);
      await settled(page);
      const side = await page.locator('.ws-an-side').innerText();
      assert(side.includes(`Parent: ${parent.label}`), `the side panel links the parent: ${JSON.stringify(side.slice(0, 200))}`);
      assert(side.includes('Timing') && side.includes('Started'), 'the side panel has the timing');
      await shot(page, `analytics-${theme}-a8-drawer`);
      await page.click(`.ws-an-tl-row[data-step="${parent.key}"] .ws-an-chev`);
      await settled(page);
      assert(await page.locator(`.ws-an-tl-row[data-step="${child.key}"]`).count() === 0, 'collapsing the parent hides its children');
      await page.click('[data-action="analytics-session-tab"][data-value="cost"]');
      await page.waitForSelector('.ws-an-chart[data-chart="session-grow"] svg');
      await page.click('[data-action="analytics-session-tab"][data-value="tools"]');
      await settled(page);
      assert(await page.locator('.ws-an-dbody[data-tab=tools] .ws-an-row').count() === session.session.tools.length, 'one row per tool');
      await page.click('[data-action="analytics-session-tab"][data-value="trace"]');
      await settled(page);
      assert(await page.locator(`.ws-an-tl-row[data-step="${child.key}"]`).count() === 0, 'the parent is still collapsed after the tabs');
      await page.keyboard.press('Escape');
      await page.waitForFunction(() => !document.querySelector('.ws-an-drawer'));
    });

    // ---------------------------------------------------------------- A9: App analytics
    await check(`A9 ${theme}: the App tab matches the fixture, terminal appears on the switch, Meeting notes and Failed filter Recent runs`, async () => {
      await page.click('[data-action="analytics-mode"][data-value="app"]');
      await page.waitForSelector('.ws-an-app .ws-an-kpis');
      await settled(page);
      const at = app.totals;
      const values = await page.locator('.ws-an-app .ws-an-kpi-v').allInnerTexts();
      assert(values[0].includes(usd(at.costUsd, true)), `AI spent ${values[0]} vs ${usd(at.costUsd, true)}`);
      assert(values[1].trim() === n0(at.runs), `runs ${values[1]} vs ${n0(at.runs)}`);
      assert(values[2].trim() === n0(at.failed), `failed ${values[2]} vs ${n0(at.failed)}`);
      assert(await page.locator('.ws-an-chart[data-chart=appTrend] .ws-an-band').count() === app.series.length, 'one bar per series item');
      assert(!(await page.locator('.ws-an-legend').innerText()).includes('Terminal sessions'), 'no terminal series before the switch');
      await page.click('[data-action="analytics-app-terminal"][data-value="on"]');
      await settled(page);
      assert((await page.locator('.ws-an-legend').innerText()).includes('Terminal sessions'), 'the terminal series appears with the switch');
      await shot(page, `analytics-${theme}-a9-app`);
      await page.click('.ws-an-feat[data-feature="meeting"]');
      await settled(page);
      const meeting = app.recent.filter(r => r.feature === 'meeting').length;
      assert(await page.locator('.ws-an-run').count() === meeting, `${await page.locator('.ws-an-run').count()} runs for Meeting notes, wanted ${meeting}`);
      await page.click('[data-card="recent"] .ws-an-clear');
      await page.click('[data-action="analytics-app-list"][data-value="failed"]');
      await settled(page);
      const failed = app.recent.filter(r => r.status !== 'ok').length;
      assert(await page.locator('.ws-an-run').count() === failed, `${await page.locator('.ws-an-run').count()} failed runs, wanted ${failed}`);
      await shot(page, `analytics-${theme}-a9-failed`);
    });

    await check(`A1–A9 ${theme}: no console errors`, async () => clean(errors, theme));
    await context.close().catch(() => {});

    // ---------------------------------------------------------------- A5: first open
    {
      const unread = 4;
      const first = summary.series[0];
      // The CLI's day buckets for the days not read yet are empty; the page must shade them.
      const earlier = Array.from({ length: unread }, (_, i) => ({ costUSD: 0, durationMs: 0, sessions: 0, tokens: 0, from: first.from - (unread - i) * DAY, to: first.from - (unread - i - 1) * DAY - 1 }));
      // The first day read is the UTC day the fixture's first bucket ends in, so the added buckets end before it.
      const storedFrom = new Date(first.to).toISOString().slice(0, 10);
      const growing = { ...summary, series: [...earlier, ...summary.series] };
      const n = await openAnalytics(theme, 1440, 900, { status: { ...runningFx, storedFrom }, summary: growing });
      await n.page.waitForSelector('.ws-an-kpis');
      await settled(n.page);
      await check(`A5 ${theme}: a first open still reading says "n of N days read so far" and shades unread days instead of drawing $0`, async () => {
        const notes = await n.page.locator('.ws-an-kpis .ws-an-kpi-d').allInnerTexts();
        // Cost, Sessions and Active time say it; Code changed keeps its own files line.
        assert(notes.length === 4 && notes.slice(0, 3).every(x => /\d+ of 30 days read so far/.test(x)), `KPI notes ${JSON.stringify(notes)}`);
        // The stored days: from storedFrom to today, counted on the page's own calendar.
        const expected = await n.page.evaluate(stored => {
          const key = ms => new Intl.DateTimeFormat('en-CA', { timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone }).format(ms);
          const days = (a, b) => Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86_400_000) + 1;
          return days(stored, key(Date.now()));
        }, storedFrom);
        assert(notes[0].includes(`${expected} of 30 days`), `expected ${expected} of 30 days in ${JSON.stringify(notes[0])}`);
        assert(await n.page.locator('.ws-an-chart[data-chart=trend] .ws-an-wash').count() === 1, 'one shaded stretch');
        assert((await n.page.locator('.ws-an-chart[data-chart=trend] .ws-an-wash-label').textContent()) === 'Still reading…', 'the stretch says Still reading…');
        assert(await n.page.locator('.ws-an-chart[data-chart=trend] .ws-an-band').count() === growing.series.length, 'every day has its tooltip band');
        assert(/of 90 days/.test(await n.page.locator('.ws-an-progress').innerText()), 'the progress line says 90 days');
        assert(await n.page.locator('.ws-an-refresh[disabled]').count() === 1, 'Refresh is disabled while it reads');
        await shot(n.page, `analytics-${theme}-a5-first-open`);
        clean(n.errors, 'A5');
      });
      await n.context.close().catch(() => {});
    }

    // ---------------------------------------------------------------- A6: a failed day
    {
      const n = await openAnalytics(theme, 1440, 900, { status: { failedDays: ['2026-10-13'] } });
      await ready(n.page);
      await check(`A6 ${theme}: a failed day is named, and Try again sends analytics_retry for it`, async () => {
        const line = await n.page.locator('.ws-an-failed').innerText();
        assert(line.includes("1 day couldn't be read (Tue 13 Oct)"), `failed line ${JSON.stringify(line)}`);
        await shot(n.page, `analytics-${theme}-a6-failed-day`);
        await n.page.click('.ws-an-failed [data-action="analytics-retry"]');
        await n.page.waitForFunction(() => window.__bridgeCalls.some(([o]) => o === 'analytics_retry'));
        const retry = await calls(n.page, 'analytics_retry');
        assert(retry.length === 1 && retry[0].day === '2026-10-13', `retry ${JSON.stringify(retry)}`);
        await n.page.waitForFunction(() => !document.querySelector('.ws-an-failed') && !document.querySelector('.ws-an-progress'));
        assert((await toasts(n.page)).some(x => x.includes('Tue 13 Oct read.')), `toasts ${JSON.stringify(await toasts(n.page))}`);
        clean(n.errors, 'A6');
      });
      await n.context.close().catch(() => {});
    }

    // ---------------------------------------------------------------- A7: old CLI, empty Mac
    {
      const n = await openAnalytics(theme, 1440, 900, { status: { state: 'needs_cli', sessions: 0, lastFetchAt: null, storedFrom: null } });
      await n.page.waitForSelector('.ws-an-notice.ws-an-warn');
      await settled(n.page);
      await check(`A7 ${theme}: an old CLI shows the warning, no data, no fetch, and the button opens Settings → CodeMie`, async () => {
        assert((await n.page.locator('.ws-an-notice.ws-an-warn').innerText()).includes('Analytics needs a newer CodeMie CLI.'), 'the warning copy');
        assert(await n.page.locator('.ws-an-kpis, .ws-an-card, .ws-an-tabs').count() === 0, 'no data cards');
        assert((await calls(n.page, 'analytics_view')).length === 0 && (await calls(n.page, 'analytics_refresh')).length === 0, 'no view or fetch is asked for');
        await shot(n.page, `analytics-${theme}-a7-needs-cli`);
        await n.page.click('.ws-an-notice [data-action="settings-tab"][data-tab="cm-overview"]');
        await n.page.waitForFunction(() => location.hash.startsWith('#/settings'));
        assert(await n.page.evaluate(() => location.hash) === '#/settings/cm-overview', `settings route ${await n.page.evaluate(() => location.hash)}`);
        clean(n.errors, 'A7 needs_cli');
      });
      await n.context.close().catch(() => {});
      const e = await openAnalytics(theme, 1440, 900, { status: { state: 'empty', sessions: 0, storedFrom: null } });
      await e.page.waitForSelector('.ws-an-empty-mac');
      await settled(e.page);
      await check(`A7 ${theme}: an empty Mac shows the empty copy, Refresh works, and the App tab still shows Connect's data`, async () => {
        const text = await e.page.locator('.ws-an-empty-mac').innerText();
        assert(text.includes('No coding-agent sessions on this Mac yet') && text.includes("Sessions from Claude Code, codemie-claude or Connect's terminal show up here after a refresh."), `empty copy ${JSON.stringify(text)}`);
        assert(await e.page.locator('.ws-an-refresh').isEnabled(), 'Refresh is enabled');
        await shot(e.page, `analytics-${theme}-a7-empty`);
        await e.page.click('[data-action="analytics-mode"][data-value="app"]');
        await e.page.waitForSelector('.ws-an-app .ws-an-kpis');
        const values = await e.page.locator('.ws-an-app .ws-an-kpi-v').allInnerTexts();
        assert(values[1].trim() === n0(app.totals.runs), `App runs ${values[1]}`);
        clean(e.errors, 'A7 empty');
      });
      await e.context.close().catch(() => {});
    }
  }

  // ---------------------------------------------------------------- A10: looks
  for (const theme of ['dark', 'light']) {
    for (const [width, height] of [[1440, 900], [1000, 760], [1680, 960]]) {
      const { page, context, errors } = await openAnalytics(theme, width, height);
      await ready(page);
      await check(`A10 ${theme} ${width}px: Overview, Efficiency, Sessions, the drawer and App analytics fit, with no overlap or console errors`, async () => {
        const tag = `${theme}-${width}`;
        await noOverflow(page, 'Overview');
        await noOverlap(page, 'Overview');
        await shot(page, `analytics-overview-${tag}`);
        await page.click('[data-action="analytics-view"][data-value="efficiency"]');
        await page.waitForSelector('.ws-an-chart[data-chart=depth] svg');
        await settled(page);
        await noOverflow(page, 'Efficiency');
        await noOverlap(page, 'Efficiency');
        await shot(page, `analytics-efficiency-${tag}`);
        await page.click('[data-action="analytics-view"][data-value="sessions"]');
        await page.waitForSelector('.ws-an-srow');
        await settled(page);
        await noOverflow(page, 'Sessions');
        await noOverlap(page, 'Sessions');
        await shot(page, `analytics-sessions-${tag}`);
        await page.locator('.ws-an-srow').first().click();
        await page.waitForSelector('.ws-an-drawer h2');
        await page.waitForSelector('.ws-an-tl-row[data-step]');
        await settled(page);
        await noOverflow(page, 'the drawer');
        await shot(page, `analytics-drawer-${tag}`);
        await page.keyboard.press('Escape');
        await page.waitForFunction(() => !document.querySelector('.ws-an-drawer'));
        await page.click('[data-action="analytics-mode"][data-value="app"]');
        await page.waitForSelector('.ws-an-app .ws-an-kpis');
        await page.waitForSelector('.ws-an-chart[data-chart=appTrend] svg');
        await settled(page);
        await noOverflow(page, 'App analytics');
        await noOverlap(page, 'App analytics', false);
        await shot(page, `analytics-app-${tag}`);
        clean(errors, tag);
      });
      // The App tab's KPI notes (apart: they are cut at 1000 px, see the Task 6 report).
      await check(`A10 ${theme} ${width}px: App analytics KPI notes are not cut`, async () => {
        const cut = await page.evaluate(() => [...document.querySelectorAll('.ws-an-app .ws-an-kpi-d')].filter(el => el.scrollWidth > el.clientWidth + 1).map(el => el.textContent.trim()));
        assert(!cut.length, `cut: ${JSON.stringify(cut)}`);
      });
      await context.close().catch(() => {});
    }
  }
}
