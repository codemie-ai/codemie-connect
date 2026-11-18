// CODEMIE_PLUGIN_SMOKE=<marketplace folder> (Task 25), smoke only: the window's side of the
// marketplace smoke. Connect opened a fresh data root for it (commands/plugin_smoke.rs). This adds
// the marketplace, installs every plugin it offers (making each frame at once, before the manager
// has loaded it, as Settings does), waits for the plugin manager, then opens every
// page, Settings section and card each plugin's frame adds, through the app's own routes, so each
// one is drawn by its client half in its real sandboxed frame, and last tells every frame a
// meeting's page shows (Echo's call page), so their `call.*` slots draw for it. What the frames
// reported (their page errors, through the bridge) goes to Rust, which adds what the manager saw,
// decides and quits.
//
// Agreeing to a permission sheet without a person happens only here: every line of the sheet the
// plugin offers, sent with that sheet's hash, as the consent dialog would after every box is ticked.

const message = e => String((e && e.message) || e || 'failed');

/** Waits for `probe()` to give something, asking every `every` ms; null after `timeoutMs`. */
async function until(probe, timeoutMs, wait, every = 250) {
  const started = Date.now();
  for (;;) {
    const got = await probe();
    if (got) return got;
    if (Date.now() - started >= timeoutMs) return null;
    await wait(every);
  }
}

/** The meeting the smoke shows the frames' call slots (a folder no meeting has). */
export const SMOKE_CALL = Object.freeze({
  name: '2026-01-05_090000-smoke-call', stamp: '2026-01-05_090000', title: 'Smoke call', started_at: '2026-01-05T09:00:00Z',
  notes: true, profile: null, memo: false, threads: [], client: null,
});

/** The most host-half commands a smoke run keeps. */
const MAX_CALLS = 400;

/** Connect's invoke for the plugin frames' host, keeping each `plugin_call` a frame made (its
 *  plugin, command, and how it went) in `calls`. */
export function recordCalls(invoke, calls) {
  return async (cmd, args) => {
    if (cmd !== 'plugin_call') return invoke(cmd, args);
    const call = { plugin: String(args?.id || ''), command: String(args?.command || ''), ok: false, error: '' };
    if (calls.length < MAX_CALLS) calls.push(call);
    try {
      const value = await invoke(cmd, args);
      call.ok = true;
      return value;
    } catch (e) {
      call.error = message(e);
      throw e;
    }
  };
}

const visible = el => !!el && !el.hidden && (() => {
  const r = el.getBoundingClientRect();
  return r.width > 0 && r.height > 0;
})();

/**
 * Runs the smoke and returns its report. `invoke` is Connect's own; `host` the plugin frames' host
 * (`status`, `shown`); `refreshInstalled()` reloads the installed list (so the host makes the
 * frames) and returns it; `go(hash)` opens a route; `frameOf(id)` is a plugin's frame element;
 * `calls` what `recordCalls` keeps of the frames' commands.
 */
export async function runMarketSmoke({
  invoke, market, runId, host, refreshInstalled, go, frameOf, calls = [],
  wait = ms => new Promise(resolve => setTimeout(resolve, ms)),
  settleMs = 2500, loadTimeoutMs = 60000, frameTimeoutMs = 20000,
}) {
  const report = { runId: runId || null, market: null, plugins: [], error: null };
  try {
    const m = await invoke('plugins_request', { op: 'market_add', data: { source: market } });
    report.market = { name: m.name, source: m.source };
    const catalog = await invoke('plugins_request', { op: 'catalog', data: { market: m.name } });
    for (const offer of catalog.plugins || []) {
      const entry = { id: offer.id, version: offer.version || '', install: '', framedBeforeLoad: false, loadError: null, frame: null, views: [] };
      report.plugins.push(entry);
      if (offer.refusal) {
        entry.install = `refused: ${offer.refusal}`;
        continue;
      }
      try {
        const d = await invoke('plugins_request', { op: 'inspect', data: { market: m.name, id: offer.id } });
        await invoke('plugins_request', {
          op: 'install',
          data: { market: m.name, id: offer.id, agreed: (d.sheet || []).map(l => l.key), sheetHash: d.sheetHash },
        });
        entry.install = 'installed';
      } catch (e) {
        entry.install = `failed: ${message(e)}`;
        continue;
      }
      // As Settings does after an install: the installed list is read at once, so the host makes
      // the frame while the manager is still loading (it detects Claude first). Its first calls
      // must wait for the host half (review C-I1); a refused one fails the run.
      await refreshInstalled();
      const s = await invoke('smoke_plugins_state');
      entry.framedBeforeLoad = !!host.status(offer.id) && !s.loaded.includes(offer.id);
    }

    // The manager loads them in the background: each one loaded, or why it didn't.
    const ids = report.plugins.filter(p => p.install === 'installed').map(p => p.id);
    const state = await until(async () => {
      const s = await invoke('smoke_plugins_state');
      return ids.every(id => s.loaded.includes(id) || s.problems[id]) ? s : null;
    }, loadTimeoutMs, wait);
    if (!state) throw new Error(`the plugin manager didn’t load them within ${Math.round(loadTimeoutMs / 1000)} s`);
    const installed = await refreshInstalled();

    for (const entry of report.plugins) {
      if (state.problems[entry.id]) entry.loadError = state.problems[entry.id];
      const p = (installed || []).find(x => x.id === entry.id);
      if (!state.loaded.includes(entry.id) || !p?.client) continue;
      const status = await until(() => {
        const st = host.status(entry.id);
        return st && (st.ready || st.error) ? st : null;
      }, frameTimeoutMs, wait) || host.status(entry.id);
      const callsOf = from => calls.slice(from).filter(c => c.plugin === entry.id).map(({ command, ok, error }) => ({ command, ok, error }));
      entry.frame = { ready: !!status?.ready, error: status?.error || '', errors: [...(status?.errors || [])], calls: callsOf(0) };
      if (!status?.ready) continue;
      const views = [
        ...status.activities.map(a => ({ view: 'activity', id: a.id, hash: `#/p/${entry.id}/${a.id}` })),
        ...status.sections.map(s => ({ view: 'section', id: s.id, hash: `#/settings/plugins/${entry.id}/${s.id}` })),
        ...(status.card ? [{ view: 'card', id: '', hash: `#/settings/plugins/${entry.id}` }] : []),
      ];
      for (const v of views) {
        const before = host.status(entry.id)?.errors.length || 0;
        const callsBefore = calls.length;
        await go(v.hash);
        await wait(settleMs);
        const after = host.status(entry.id);
        entry.views.push({
          ...v,
          shown: host.shown()?.id === entry.id && visible(frameOf(entry.id)),
          ready: !!after?.ready,
          height: after?.height || 0,
          errors: (after?.errors || []).slice(before),
          calls: callsOf(callsBefore),
        });
      }
    }

    // A meeting's page: every ready frame is told one shows, as Meetings tells them; each plugin's
    // slots draw for it (the commands they ask for, the errors they report, the text they give).
    const framed = report.plugins.filter(p => p.frame?.ready);
    if (framed.length && typeof host.setCall === 'function') {
      const before = new Map(framed.map(p => [p.id, host.status(p.id)?.errors.length || 0]));
      const callsBefore = calls.length;
      host.setCall(SMOKE_CALL);
      await wait(settleMs);
      const slots = host.callSlots();
      for (const entry of framed) {
        const { header = [], menu = [], minutes = [] } = slots.find(x => x.plugin === entry.id) || {};
        entry.call = {
          errors: (host.status(entry.id)?.errors || []).slice(before.get(entry.id)),
          calls: calls.slice(callsBefore).filter(c => c.plugin === entry.id).map(({ command, ok, error }) => ({ command, ok, error })),
          header, menu, minutes,
        };
      }
      host.setCall(null);
    }
  } catch (e) {
    report.error = message(e);
  }
  return report;
}
