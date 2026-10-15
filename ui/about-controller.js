// About screen state (EPMCDME-15342). Installed versions are read on every
// visit. The CLI has no update of its own: it comes with the app update, so
// About offers only that one. App update state is the banner's own, so the
// button stays after the banner is dismissed; runUpdateApp in renderer.js
// reports its progress and errors here so a run from either place shows on both.
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

const APP_BUTTON = 'about-app-update';

// shared() returns { app, appRunning } — renderer state read at render time.
export function createAboutController({ view, handlers, invoke, inspector, updater, shared }) {
  // read: whether the installed versions have been read once, so the cards
  // say "Checking…" before that rather than "Not available".
  const info = { appVersion: '', cliVersion: '', read: false };
  let appError = '';

  function render() {
    const s = shared();
    renderAbout(
      view,
      {
        appVersion: info.appVersion,
        appLatest: s.app.latest || '',
        appUpdateAvailable: s.app.updateAvailable,
        appRunning: s.appRunning,
        appError,
        cliVersion: info.cliVersion,
        versionsRead: info.read,
      },
      handlers,
    );
  }

  function renderIfShown() {
    if (!view.classList.contains('hidden')) render();
  }

  async function refresh() {
    render();
    // The update check goes online; the installed versions show without
    // waiting for it.
    const checked = Promise.allSettled([updater.checkForAppUpdate(true)]);
    const [app, cli] = await Promise.allSettled([invoke('get_app_version'), inspector.checkCodemieVersion()]);
    if (app.status === 'fulfilled') info.appVersion = app.value || '';
    if (cli.status === 'fulfilled') info.cliVersion = cli.value || '';
    info.read = true;
    renderIfShown();
    const [check] = await checked;
    mergeAppUpdateCheck(shared().app, check);
    renderIfShown();
  }

  // Called as an app update run starts.
  function startUpdate() {
    appError = '';
  }

  function progress(label, disabled) {
    const btn = document.getElementById(APP_BUTTON);
    if (!btn) return;
    btn.textContent = label;
    btn.disabled = disabled;
  }

  function fail(message) {
    appError = message;
    renderIfShown();
  }

  return { refresh, renderIfShown, startUpdate, progress, fail };
}
