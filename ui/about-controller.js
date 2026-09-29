// About screen state (EPMCDME-15342). Installed versions are read on every
// visit (the bundled CLI's never reaches cliVersionState). Update state is the
// banners' own, so the buttons stay after a banner is dismissed; the update runs
// in renderer.js report their progress and errors here so a run from either
// place shows on both.
import { renderAbout } from './about-view.js';

// A throttled, offline or failed re-check returns null or rejects: that says
// nothing about an update already found, so only a found version is recorded.
export function mergeAppUpdateCheck(state, settled) {
  const latest = settled.status === 'fulfilled' ? settled.value : null;
  if (latest) {
    state.latest = latest;
    state.updateAvailable = true;
  }
}

const BUTTON = { app: 'about-app-update', cli: 'about-cli-update' };

// shared() returns { app, cli, appRunning, cliRunning, cliBusy } — renderer
// state read at render time.
export function createAboutController({ view, handlers, invoke, inspector, updater, shared }) {
  const info = { appVersion: '', cliVersion: '', cliBundled: false };
  const errors = { app: '', cli: '' };
  let probes = Promise.resolve(); // every in-flight `codemie --version`
  let cliUpdates = 0; // a probe that straddles a CLI update is stale

  function render() {
    const s = shared();
    renderAbout(
      view,
      {
        appVersion: info.appVersion,
        appLatest: s.app.latest || '',
        appUpdateAvailable: s.app.updateAvailable,
        appRunning: s.appRunning,
        appError: errors.app,
        cliVersion: info.cliVersion || s.cli.installed,
        cliBundled: info.cliBundled,
        cliLatest: s.cli.latest,
        cliUpdateAvailable: s.cli.updateAvailable,
        cliRunning: s.cliRunning,
        cliError: errors.cli,
      },
      handlers,
    );
  }

  function renderIfShown() {
    if (!view.classList.contains('hidden')) render();
  }

  async function refresh() {
    render();
    const gen = cliUpdates;
    // `codemie --version` must not run while self-update or an install replaces the CLI.
    const probeCli = !shared().cliBusy;
    const probe = probeCli ? inspector.checkCodemieVersion() : null;
    if (probe) probes = Promise.allSettled([probes, probe]);
    const [app, bundled, cli, check] = await Promise.allSettled([
      invoke('get_app_version'),
      invoke('cli_is_bundled'),
      probe,
      updater.checkForAppUpdate(true),
    ]);
    if (app.status === 'fulfilled') info.appVersion = app.value || '';
    if (bundled.status === 'fulfilled') info.cliBundled = Boolean(bundled.value);
    if (probeCli && cli.status === 'fulfilled' && gen === cliUpdates) info.cliVersion = cli.value || '';
    mergeAppUpdateCheck(shared().app, check);
    renderIfShown();
  }

  // Called as an update run starts. A CLI run waits for About's probe, so
  // self-update never replaces the CLI while `codemie --version` runs.
  async function startUpdate(kind) {
    errors[kind] = '';
    if (kind === 'cli') {
      cliUpdates += 1;
      await probes;
    }
  }

  function progress(kind, label, disabled) {
    const btn = document.getElementById(BUTTON[kind]);
    if (!btn) return;
    btn.textContent = label;
    btn.disabled = disabled;
  }

  function fail(kind, message) {
    errors[kind] = message;
    renderIfShown();
  }

  function cliUpdated(version) {
    info.cliVersion = version || '';
  }

  return { refresh, renderIfShown, startUpdate, progress, fail, cliUpdated };
}
