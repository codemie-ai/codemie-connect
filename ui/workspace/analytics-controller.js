// The Analytics page's controller (docs/superpowers/specs/2026-11-19-analytics-design.md): it reads
// `analytics_status` and `analytics_view` through `query`, starts and follows a fetch
// (`analytics_refresh`, `analytics_retry` and the `workspace:analytics` progress event), reads one
// session for the drawer (`analytics_session`) and App analytics (`analytics_app`), and handles the
// `analytics-*` actions app.js routes here. Everything it touches is injected, so node:test drives
// it without a browser. `attachAnalyticsTips` is the page's tooltip layer.
import {
  MODES, VIEWS, PRESETS, SESSIONS_PAGE, RUNS_PAGE, loadPrefs, savePrefs, newAnalyticsView, presetRange, viewRequest, reportRequest, isStale, isBusy, dayKeyLabel, projectName, plural,
  failedDays,
} from './analytics-model.js';
import { SESSION_TABS } from './view-analytics-session.js';

export const PROGRESS_EVENT = 'workspace:analytics';

const localStore = () => {
  try { return globalThis.localStorage ?? null; } catch { return null; }
};
const systemZone = () => {
  try { return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'; } catch { return 'UTC'; }
};
const messageOf = err => err?.message || String(err);
const quoted = value => String(value).replace(/["\\]/g, '\\$&');

/**
 * `state` is the app state: the page's view state lives in `state.analytics`, and `state.route`
 * says whether the page is open. `query(op, data)` is a read-only workspace request; `render()`
 * redraws; `toast(message, tone)`; `listen(event, fn)` subscribes to a native event;
 * `writeText(text)` copies to the clipboard; `focus(selectors)` moves focus after a render (into
 * the drawer, and back to the session that opened it). `storage` keeps the preferences
 * (localStorage); `now` and `zone` (the Mac's own, as the CLI's day buckets are) are for tests.
 *
 * `data` holds what the operations answered: `{status, summary, loading, error, errorCode,
 * progress, refreshing, reporting, session, app}`, `errorCode` the code of the error shown (the
 * page has a state of its own for `cli_incompatible`), `reporting` while the CLI writes its
 * report, `session` as `{id, loading, detail, error}` and `app` as `{loading, answer, error}`;
 * `viewData()` adds `now` and `zone` for the renderer.
 */
export function createAnalyticsController({
  state, query, render, toast, listen, writeText = null, focus = () => {}, storage = localStore(), now = () => Date.now(), zone = systemZone(),
}) {
  state.analytics = newAnalyticsView(loadPrefs(storage));
  const ui = () => state.analytics;
  const onPage = () => state.route === 'analytics';
  const data = { status: null, summary: null, loading: false, error: '', errorCode: '', progress: null, refreshing: false, reporting: false, session: null, app: null };
  let statusReads = 0;
  let viewReads = 0;
  let appReads = 0;
  let subscribed = null;
  // The progress step last read for, the fetch the person asked for (a toast when it ends), how
  // many fetches have ended (a start answered after its end doesn't count as running) and how many
  // were asked to start (a status read before a start can't end it).
  let lastDone = null;
  let asked = null;
  let finished = 0;
  let starts = 0;
  let reloading = null;
  let again = false;

  const save = () => savePrefs(storage, ui());
  const redraw = () => (onPage() ? render() : undefined);

  function subscribe() {
    if (subscribed || !listen) return;
    subscribed = Promise.resolve(listen(PROGRESS_EVENT, event => progressed(event?.payload))).catch(() => { subscribed = null; });
  }

  /** Reads the status. A status with no fetch running ends the one this page follows, should its
   *  end event never have come; one read before a fetch started can't. */
  async function readStatus() {
    const read = ++statusReads;
    const startsBefore = starts;
    try {
      const status = await query('analytics_status', {});
      if (read !== statusReads) return;
      data.status = status;
      data.error = '';
      data.errorCode = '';
      if (status?.state !== 'running' && starts === startsBefore) {
        data.refreshing = false;
        data.progress = null;
        lastDone = null;
      }
    } catch (err) {
      if (read === statusReads && !data.status) {
        data.error = messageOf(err);
        data.errorCode = err?.code || '';
      }
    }
  }

  /** Reads the summary for the filters; a later read wins over an earlier one still on its way. */
  async function loadView() {
    const read = ++viewReads;
    data.loading = true;
    data.error = '';
    data.errorCode = '';
    await redraw();
    try {
      const summary = await query('analytics_view', viewRequest(ui(), now(), zone));
      if (read !== viewReads) return;
      data.summary = summary;
    } catch (err) {
      if (read !== viewReads) return;
      if (err?.code === 'needs_cli') data.status = { ...(data.status || {}), state: 'needs_cli' };
      else {
        data.error = messageOf(err);
        data.errorCode = err?.code || '';
      }
      data.summary = null;
    }
    data.loading = false;
    await redraw();
  }

  /** App analytics for the range: Connect's own records, read whatever the CLI can do. What was
   *  shown stays (dimmed) until the new answer comes; a later read wins. */
  async function loadApp() {
    const read = ++appReads;
    data.app = { loading: true, answer: data.app?.answer ?? null, error: '' };
    await redraw();
    const { from, to } = presetRange(ui().range, now(), zone);
    try {
      const answer = await query('analytics_app', { from, to });
      if (read !== appReads) return undefined;
      data.app = { loading: false, answer, error: '' };
    } catch (err) {
      if (read !== appReads) return undefined;
      data.app = { loading: false, answer: null, error: messageOf(err) };
    }
    return redraw();
  }

  /** Status, then the summary; reads asked for while one runs are folded into one more. */
  async function reload() {
    if (reloading) {
      again = true;
      return reloading;
    }
    reloading = (async () => {
      do {
        again = false;
        await readStatus();
        if (!data.status || data.status.state === 'needs_cli') {
          await redraw();
          return;
        }
        await loadView();
      } while (again);
    })();
    try {
      await reloading;
    } finally {
      reloading = null;
    }
    return undefined;
  }

  /** The page opened: status first; a CLI too old stops there. Data older than 15 minutes is
   *  refreshed (quietly) before the summary is read. On the App tab, App analytics is read too. */
  async function open() {
    subscribe();
    data.progress = null;
    lastDone = null;
    const app = ui().mode === 'app' ? loadApp() : null;
    await openAi();
    await app;
  }

  async function openAi() {
    await readStatus();
    await redraw();
    const status = data.status;
    if (!status || status.state === 'needs_cli') return;
    if (status.state !== 'running' && isStale(status, now())) await startFetch('analytics_refresh', {}, false);
    if (data.status?.state === 'needs_cli') return;
    if (data.status?.state === 'empty' && !isBusy(data)) return;
    await loadView();
  }

  /** Starts a fetch (or follows the one already running); `told` toasts when it ends. A retry
   *  remembers the days it reads again, for its toast. */
  async function startFetch(op, body, told) {
    const before = finished;
    starts++;
    const days = op === 'analytics_retry' ? failedDays(data.progress?.failedDays || data.status?.failedDays).map(f => f.day) : null;
    const answer = await query(op, body);
    if (answer?.needsCli) {
      await readStatus();
      return redraw();
    }
    if (finished === before) data.refreshing = true;
    if (told) asked = days ? { days } : {};
    return redraw();
  }

  function endedText(progress, told) {
    const failed = failedDays(progress.failedDays).map(f => f.day);
    if (told.days) {
      const named = days => (days.length === 1 ? dayKeyLabel(days[0]) : `${days.length} days`);
      const still = told.days.filter(day => failed.includes(day));
      if (still.length) return `${named(still)} still couldn't be read.`;
      return told.days.length ? `${named(told.days)} read.` : 'Analytics updated.';
    }
    return failed.length ? `Analytics updated. ${failed.length} ${plural(failed.length, 'day')} couldn't be read.` : 'Analytics updated.';
  }

  /** `workspace:analytics`: `{running, done, total, label, failedDays}`. While history is read,
   *  each new step reads the stored sessions again; the end reads them once more. */
  function progressed(progress) {
    if (!progress || typeof progress !== 'object') return undefined;
    data.progress = progress;
    if (!progress.running) {
      finished++;
      data.refreshing = false;
      lastDone = null;
      const told = asked;
      asked = null;
      if (told) toast(endedText(progress, told), progress.failedDays?.length ? 'info' : 'success');
      return onPage() ? reload() : undefined;
    }
    if (!onPage()) return undefined;
    if (progress.done === lastDone) return redraw();
    lastDone = progress.done;
    return reload();
  }

  async function openSession(id) {
    if (!id) return undefined;
    data.session = { id, loading: true, detail: null, error: '' };
    ui().drawer = { tab: 'trace', selected: 'session', collapsed: new Set() };
    await redraw();
    focus(['.ws-an-drawer .ws-an-close']);
    try {
      const detail = await query('analytics_session', { id });
      if (data.session?.id === id) data.session = { id, loading: false, detail, error: '' };
    } catch (err) {
      if (data.session?.id === id) data.session = { id, loading: false, detail: null, error: messageOf(err) };
    }
    return redraw();
  }

  /** Closes the drawer; focus goes back to the session that opened it. */
  async function closeSession() {
    const id = data.session?.id;
    data.session = null;
    ui().drawer = null;
    await redraw();
    if (id) focus(`button[data-action="analytics-open-session"][data-value="${quoted(id)}"]`);
  }

  /** The drawer's own state, changed and redrawn. */
  function drawer(change) {
    const d = ui().drawer;
    if (!d || !data.session) return undefined;
    change(d);
    return redraw();
  }

  /** Keys on the Analytics page: Escape closes the session drawer (an open menu closes first, in
   *  app.js). True when it took the key. */
  async function key(ev) {
    if (ev.key !== 'Escape' || ev.isComposing || ev.keyCode === 229 || ev.target?.closest?.('.ws-term')) return false;
    if (!data.session) return false;
    ev.preventDefault();
    await closeSession();
    return true;
  }

  /** The `analytics-*` actions; `el` is the control (its `data-value`). */
  async function handle(action, el) {
    const value = el?.dataset?.value ?? '';
    const menu = el?.closest?.('details');
    menu?.removeAttribute('open');
    const v = ui();
    switch (action) {
      case 'analytics-mode':
        if (MODES.includes(value)) v.mode = value;
        save();
        if (v.mode === 'app') return loadApp();
        // Back on the AI tabs: a range changed meanwhile is read now.
        return data.summary || !data.status ? redraw() : reload();
      case 'analytics-view':
        if (VIEWS.some(([id]) => id === value)) v.view = value;
        v.shown = SESSIONS_PAGE;
        save();
        return redraw();
      case 'analytics-range':
        if (PRESETS.some(p => p.id === value)) v.range = value;
        save();
        if (v.mode !== 'app') return loadView();
        // The AI summary is read again when its tabs are back; one still on its way is dropped.
        data.summary = null;
        viewReads++;
        data.loading = false;
        return loadApp();
      case 'analytics-agent':
        v.agent = value;
        return loadView();
      case 'analytics-project':
        v.project = value;
        // A project row clicked on the page says what happened; the menu shows it already.
        if (value && !menu) toast(`Showing ${projectName(value)} only.`);
        return loadView();
      case 'analytics-clear':
        v.agent = '';
        v.project = '';
        return loadView();
      case 'analytics-metric': v.metric = value; return redraw();
      case 'analytics-inv': v.inv = value; return redraw();
      case 'analytics-list': v.list = value; return redraw();
      case 'analytics-sort':
        v.sort = value;
        v.shown = SESSIONS_PAGE;
        return redraw();
      case 'analytics-more':
        if (value === 'sessions') v.shown += SESSIONS_PAGE;
        else if (value === 'runs') v.appShown += RUNS_PAGE;
        else v.all = { ...v.all, [value]: !v.all[value] };
        return redraw();
      case 'analytics-table':
        v.tables = { ...v.tables };
        if (v.tables[value]) delete v.tables[value];
        else v.tables[value] = true;
        save();
        return redraw();
      case 'analytics-notice':
        v.noticeHidden = value === 'hide';
        save();
        if (v.noticeHidden) toast('Notice hidden. “Local sessions only” next to the filters brings it back.');
        return redraw();
      case 'analytics-refresh': return startFetch('analytics_refresh', {}, true);
      // Try again reads every failed day again.
      case 'analytics-retry': return startFetch('analytics_retry', {}, true);
      // Try again: App analytics on its tab; the summary, or everything from the status when that
      // couldn't be read.
      case 'analytics-reload':
        if (v.mode === 'app') return loadApp();
        return data.status ? loadView() : open();
      // The CLI writes the report first, which can take a while: busy until then, once at a time.
      case 'analytics-report':
        if (data.reporting) return undefined;
        data.reporting = true;
        await redraw();
        try {
          await query('analytics_report', reportRequest(v, now(), zone));
          toast('The CLI report opened in your browser.', 'success');
        } finally {
          data.reporting = false;
          await redraw();
        }
        return undefined;
      case 'analytics-open-session': return openSession(value);
      // The session drawer.
      case 'analytics-close': return closeSession();
      case 'analytics-session-tab':
        return drawer(d => { if (SESSION_TABS.some(([id]) => id === value)) d.tab = value; });
      case 'analytics-step': return drawer(d => { d.selected = value || 'session'; });
      case 'analytics-step-toggle':
        return drawer(d => {
          d.collapsed = new Set(d.collapsed);
          if (d.collapsed.has(value)) d.collapsed.delete(value);
          else d.collapsed.add(value);
        });
      case 'analytics-copy':
        if (!value || !writeText) return undefined;
        try {
          await writeText(value);
          toast('Copied.', 'success');
        } catch {
          toast('Couldn’t copy. Select the text and copy it instead.', 'error');
        }
        return undefined;
      // App analytics: a feature filters Recent runs (again: all of them), All or Failed, the
      // terminal sessions in the cost chart.
      case 'analytics-app-feature':
        v.appFeature = value && value !== v.appFeature ? value : '';
        v.appShown = RUNS_PAGE;
        return redraw();
      case 'analytics-app-list':
        v.appList = value === 'failed' ? 'failed' : 'all';
        v.appShown = RUNS_PAGE;
        return redraw();
      case 'analytics-app-terminal':
        v.appTerm = value === 'on';
        return redraw();
      default: return undefined;
    }
  }

  return {
    data, open, handle, key, reload, loadView,
    viewData: () => ({ ...data, now: now(), zone }),
  };
}

/**
 * The page's tooltip layer: a mark with `data-an-tip` (a chart band, a bar segment, an info hint)
 * shows its HTML on hover or focus; an area line (`data-an-xtip`) follows the pointer to its
 * nearest point. The HTML was escaped when the page was drawn. Attached once, by app.js.
 */
export function attachAnalyticsTips(doc, win = globalThis) {
  let tip = null;
  const layer = () => {
    if (!tip) {
      tip = doc.createElement('div');
      tip.className = 'ws-an-tip';
      tip.setAttribute('role', 'tooltip');
      doc.body.append(tip);
    }
    return tip;
  };
  const hide = () => {
    if (tip) tip.style.display = 'none';
    doc.querySelectorAll('.ws-an-xh[visibility="visible"]').forEach(line => line.setAttribute('visibility', 'hidden'));
  };
  const show = (html, x, y) => {
    const el = layer();
    el.innerHTML = html;
    el.style.display = 'block';
    const r = el.getBoundingClientRect();
    let left = x + 14;
    let top = y - r.height - 10;
    if (left + r.width > win.innerWidth - 8) left = x - r.width - 14;
    if (top < 8) top = y + 16;
    el.style.left = `${Math.max(8, left)}px`;
    el.style.top = `${top}px`;
  };
  doc.addEventListener('pointermove', ev => {
    const mark = ev.target?.closest?.('[data-an-tip]');
    if (mark) return show(mark.dataset.anTip, ev.clientX, ev.clientY);
    const line = ev.target?.closest?.('[data-an-xtip]');
    if (line) {
      let points = [];
      try { points = JSON.parse(line.dataset.anXtip); } catch { points = []; }
      const box = line.getBoundingClientRect();
      const x = ev.clientX - box.left;
      const best = points.reduce((a, p) => (!a || Math.abs(p.x - x) < Math.abs(a.x - x) ? p : a), null);
      if (!best) return hide();
      const xh = line.querySelector('.ws-an-xh');
      xh?.setAttribute('x1', best.x);
      xh?.setAttribute('x2', best.x);
      xh?.setAttribute('visibility', 'visible');
      return show(best.html, box.left + best.x, ev.clientY);
    }
    return hide();
  });
  doc.addEventListener('focusin', ev => {
    const mark = ev.target?.closest?.('[data-an-tip]');
    if (!mark) return;
    const b = mark.getBoundingClientRect();
    show(mark.dataset.anTip, b.left + b.width / 2, b.top + 20);
  });
  doc.addEventListener('focusout', hide);
  doc.addEventListener('scroll', hide, true);
}
