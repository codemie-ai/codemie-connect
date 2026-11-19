// The Analytics page's controller (docs/superpowers/specs/2026-11-19-analytics-design.md): it reads
// `analytics_status` and `analytics_view` through `query`, starts and follows a fetch
// (`analytics_refresh`, `analytics_retry` and the `workspace:analytics` progress event) and
// handles the `analytics-*` actions app.js routes here. Everything it touches is injected, so
// node:test drives it without a browser. `attachAnalyticsTips` is the page's tooltip layer.
import {
  MODES, VIEWS, PRESETS, SESSIONS_PAGE, loadPrefs, savePrefs, newAnalyticsView, viewRequest, reportRequest, isStale, isBusy, dayKeyLabel, projectName, plural,
} from './analytics-model.js';

export const PROGRESS_EVENT = 'workspace:analytics';

const localStore = () => {
  try { return globalThis.localStorage ?? null; } catch { return null; }
};
const systemZone = () => {
  try { return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'; } catch { return 'UTC'; }
};
const messageOf = err => err?.message || String(err);

/**
 * `state` is the app state: the page's view state lives in `state.analytics`, and `state.route`
 * says whether the page is open. `query(op, data)` is a read-only workspace request; `render()`
 * redraws; `toast(message, tone)`; `listen(event, fn)` subscribes to a native event. app.js also
 * passes `openModal`, which the session drawer will use. `storage` keeps the preferences (localStorage); `now` and `zone`
 * (the Mac's own, as the CLI's day buckets are) are for tests.
 *
 * `data` holds what the operations answered: `{status, summary, loading, error, progress,
 * refreshing, session}`; `viewData()` adds `now` and `zone` for the renderer.
 */
export function createAnalyticsController({
  state, query, render, toast, listen, storage = localStore(), now = () => Date.now(), zone = systemZone(),
}) {
  state.analytics = newAnalyticsView(loadPrefs(storage));
  const ui = () => state.analytics;
  const onPage = () => state.route === 'analytics';
  const data = { status: null, summary: null, loading: false, error: '', progress: null, refreshing: false, session: null };
  let statusReads = 0;
  let viewReads = 0;
  let subscribed = null;
  // The progress step last read for, the fetch the person asked for (a toast when it ends), and
  // how many fetches have ended (a start answered after its end doesn't count as running).
  let lastDone = null;
  let asked = null;
  let finished = 0;
  let reloading = null;
  let again = false;

  const save = () => savePrefs(storage, ui());
  const redraw = () => (onPage() ? render() : undefined);

  function subscribe() {
    if (subscribed || !listen) return;
    subscribed = Promise.resolve(listen(PROGRESS_EVENT, event => progressed(event?.payload))).catch(() => { subscribed = null; });
  }

  async function readStatus() {
    const read = ++statusReads;
    try {
      const status = await query('analytics_status', {});
      if (read === statusReads) data.status = status;
    } catch (err) {
      if (read === statusReads && !data.status) data.error = messageOf(err);
    }
  }

  /** Reads the summary for the filters; a later read wins over an earlier one still on its way. */
  async function loadView() {
    const read = ++viewReads;
    data.loading = true;
    data.error = '';
    await redraw();
    try {
      const summary = await query('analytics_view', viewRequest(ui(), now(), zone));
      if (read !== viewReads) return;
      data.summary = summary;
    } catch (err) {
      if (read !== viewReads) return;
      if (err?.code === 'needs_cli') data.status = { ...(data.status || {}), state: 'needs_cli' };
      else data.error = messageOf(err);
      data.summary = null;
    }
    data.loading = false;
    await redraw();
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
        if (data.status?.state === 'needs_cli') {
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
   *  refreshed (quietly) before the summary is read. */
  async function open() {
    subscribe();
    data.progress = null;
    lastDone = null;
    await readStatus();
    await redraw();
    const status = data.status;
    if (!status || status.state === 'needs_cli') return;
    if (status.state !== 'running' && isStale(status, now())) await startFetch('analytics_refresh', {}, false);
    if (data.status?.state === 'needs_cli') return;
    if (data.status?.state === 'empty' && !isBusy(data)) return;
    await loadView();
  }

  /** Starts a fetch (or follows the one already running); `told` toasts when it ends. */
  async function startFetch(op, body, told) {
    const before = finished;
    const answer = await query(op, body);
    if (answer?.needsCli) {
      await readStatus();
      return redraw();
    }
    if (finished === before) data.refreshing = true;
    if (told) asked = op === 'analytics_retry' ? { day: body.day } : {};
    return redraw();
  }

  function endedText(progress, told) {
    const failed = Array.isArray(progress.failedDays) ? progress.failedDays : [];
    if (told.day) return failed.includes(told.day) ? `${dayKeyLabel(told.day)} still couldn't be read.` : `${dayKeyLabel(told.day)} read.`;
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
    await redraw();
    try {
      const detail = await query('analytics_session', { id });
      if (data.session?.id === id) data.session = { id, loading: false, detail, error: '' };
    } catch (err) {
      if (data.session?.id === id) data.session = { id, loading: false, detail: null, error: messageOf(err) };
    }
    return redraw();
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
        return redraw();
      case 'analytics-view':
        if (VIEWS.some(([id]) => id === value)) v.view = value;
        v.shown = SESSIONS_PAGE;
        save();
        return redraw();
      case 'analytics-range':
        if (PRESETS.some(p => p.id === value)) v.range = value;
        save();
        return loadView();
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
      case 'analytics-retry': return startFetch('analytics_retry', { day: value }, true);
      case 'analytics-reload': return loadView();
      case 'analytics-report':
        await query('analytics_report', reportRequest(v, now(), zone));
        toast('The CLI report opened in your browser.', 'success');
        return undefined;
      case 'analytics-open-session': return openSession(value);
      default: return undefined;
    }
  }

  return {
    data, open, handle, reload, loadView,
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
