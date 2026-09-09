// Orchestrates the Health screen's own doctor run: stream 'codemie doctor' ->
// filter to stdout -> join -> parse -> group -> render, plus the open-log
// action's failure path. Split out of renderer.js (where it used to live
// inline as runHealthCheck()) so this wiring is unit-testable without
// stubbing the whole app shell — renderer.js supplies the container, a
// runStream function and an openLog function; this module owns neither Tauri
// nor the rest of the DOM.
import { parseDoctorOutput } from './doctor-parse.js';
import { groupDoctorResults } from './doctor-groups.js';
import { renderHealth, showLoading, showLogError, showRunError } from './health-ui.js';

// container: the #health-view element.
// runStream(cmd, onLine): bridge.runner.runStream, injected so tests can stub it.
// openLog(): invoke('open_log'), injected so tests can stub it.
// onNavigate(view): routes a deep-link action to another view.
// onFailure(): called when a doctor run rejects (CR-006) — the caller uses
// this to reset its own one-shot auto-run guard so a failed run does not
// permanently block a later automatic retry.
export function createHealthController({ container, runStream, openLog, onNavigate, onFailure } = {}) {
  // CR-004: nothing previously stopped "Check everything again" or a
  // per-row "Check again" from firing a second doctor run while an earlier
  // one was still in flight. A second run() call is a no-op until the first
  // settles.
  let running = false;

  async function handleOpenLog() {
    try {
      await openLog();
    } catch (e) {
      // CR-008: this catch must always be reachable and always surface the
      // failure — showLogError itself falls back to recreating the banner
      // (CR-003) if a recheck has wiped the container in the meantime.
      showLogError(container, `Can't read your log: ${(e && e.message) || e}`);
    }
  }

  async function run() {
    if (running) return;
    running = true;
    showLoading(container);
    try {
      const lines = [];
      await runStream('codemie doctor', (t, tag) => {
        if (tag === 'stdout') lines.push(t);
      });
      const records = parseDoctorOutput(lines.join('\n'));
      if (records.length === 0) {
        // CR-005: zero stdout records (doctor wrote nothing, or only to
        // stderr) must not render as "0 of 0 fine" — that is visually
        // indistinguishable from a genuine all-clear.
        showRunError(container, 'Could not determine health — the check produced no output.', run);
        return;
      }
      renderHealth(container, groupDoctorResults(records), {
        onRecheck: run,
        onNavigate,
        onOpenLog: handleOpenLog,
      });
    } catch (e) {
      // CR-006: previously nothing caught a spawn/invoke failure here, so
      // renderHealth() (which draws the recheck button) never ran and the
      // screen was stuck on showLoading()'s "Checking..." forever.
      showRunError(container, `Could not run health checks: ${(e && e.message) || e}`, run);
      onFailure?.();
    } finally {
      running = false;
    }
  }

  return { run };
}
