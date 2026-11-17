// The change-data-folder dialog (DESIGN.md section 8): pick a folder, read the check, choose
// what to do, confirm, then Connect works and restarts. One guarded dialog whose steps
// `changeDialogView` renders from the flow; app.js routes the `data-*` actions here and opens it
// from Settings or the recovery page. Touches the DOM only when a dialog opens.
import { openModal, toast } from './ui.js';
import { changeDialogView, canContinue, defaultMode } from './settings-storage.js';

/** After this long on "Restarting Connect…", the dialog offers to quit so Connect opens again. */
export const SLOW_RESTART_MS = 20_000;

const errorOf = err => ({ code: err?.code || '', message: err?.message || String(err) });

/**
 * `invoke` runs native commands. `onRestarting(flow)` tells the page that the pointer names the
 * new folder and Connect is restarting (or must be restarted).
 */
export function createDataLocationFlow({ invoke, onRestarting = () => {}, slowRestartMs = SLOW_RESTART_MS }) {
  let flow = null;
  let dialog = null;

  function paint({ body = true } = {}) {
    if (!dialog || !flow) return;
    const view = changeDialogView(flow);
    dialog.querySelector('.ws-modal-header h2').textContent = view.title;
    const subtitle = dialog.querySelector('.ws-modal-header p');
    subtitle.textContent = view.subtitle;
    subtitle.hidden = !view.subtitle;
    const footer = dialog.querySelector('.ws-modal-footer');
    footer.innerHTML = view.footer;
    footer.hidden = !view.footer;
    dialog.classList.toggle('ws-modal-busy', view.busy);
    if (!body) return;
    dialog.querySelector('.ws-modal-body').innerHTML = view.body;
    dialog.querySelector('.ws-modal-error').textContent = '';
    // A new step: a click or Enter meant for the last one doesn't act on this one.
    dialog.arm();
    for (const selector of view.focus) {
      const el = dialog.querySelector(selector);
      if (el) {
        el.focus({ preventScroll: true });
        break;
      }
    }
  }

  function step(next) {
    if (!flow) return;
    Object.assign(flow, next);
    paint();
  }

  /** Opens the dialog at its first step. `info` is where the data is now (`dataRoot`, `sizeBytes`). */
  function open({ recovery = false, info = null } = {}) {
    const f = { step: 'pick', recovery, info, report: null, picked: null, mode: null, acknowledged: false, error: null };
    flow = f;
    // The steps draw their own footer; Enter or the primary button moves to the next one.
    const opened = openModal({
      title: ' ', subtitle: ' ', submit: null, cancel: null, size: 'md', guard: true,
      onSubmit: async () => { await next(); return false; },
      onClose: () => {
        if (flow === f) flow = null;
        if (dialog === opened) dialog = null;
      },
    });
    dialog = opened;
    opened.classList.add('ws-dl-dialog');
    const footer = document.createElement('footer');
    footer.className = 'ws-modal-footer';
    opened.querySelector('form').append(footer);
    // While Connect copies or restarts, the dialog stays: Esc, the scrim and × do nothing.
    opened.beforeClose = () => !changeDialogView(f).busy;
    opened.addEventListener('change', ev => {
      if (ev.target.name === 'data-mode') f.mode = ev.target.value;
      else if (ev.target.name === 'data-ack') f.acknowledged = ev.target.checked;
      else return;
      paint({ body: false });
    });
    paint();
    return opened;
  }

  /** Continue (check → confirm) or commit (confirm → working → restarting). */
  async function next() {
    const f = flow;
    if (!f || !canContinue(f.report, f)) return;
    if (f.step === 'check') return step({ step: 'confirm', error: null });
    if (f.step !== 'confirm') return;
    step({ step: 'working', error: null });
    try {
      await invoke('data_location_change', { path: f.picked, mode: f.mode, acceptNoPermissions: !!f.acknowledged });
    } catch (err) {
      return settle(f, err);
    }
    return settle(f, null);
  }

  /**
   * The change finished: Connect restarts, or the folder changed but Connect couldn't restart, or
   * it failed and nothing changed. A dialog that was closed meanwhile says so in a toast.
   */
  function settle(f, err) {
    const attached = flow === f;
    if (!err || err.code === 'restart_failed') onRestarting(f);
    if (!err) {
      if (attached) restarting(f);
      else toast('Your data folder was changed. Connect is restarting.', 'success');
    } else if (err.code === 'restart_failed') {
      if (attached) step({ step: 'stuck', error: errorOf(err) });
      else toast(err.message, 'error');
    } else if (attached) {
      step({ step: 'confirm', error: errorOf(err) });
    } else {
      toast(err.message || String(err), 'error');
    }
  }

  function restarting(f) {
    step({ step: 'restarting', slow: false, error: null });
    setTimeout(() => {
      if (flow === f && f.step === 'restarting') step({ slow: true });
    }, slowRestartMs);
  }

  /** The system folder picker, then the check of the folder picked. Cancelling changes nothing. */
  async function choose() {
    const f = flow;
    if (!f || f.picking) return;
    const before = { step: f.step, picked: f.picked };
    f.picking = true;
    try {
      const picked = await invoke('data_location_pick');
      if (flow !== f || !picked) return;
      step({ step: 'checking', picked, error: null });
      const report = await invoke('data_location_check', { path: picked });
      if (flow === f) step({ step: 'check', report, mode: defaultMode(report), acknowledged: false });
    } catch (err) {
      if (flow === f) step({ ...before, error: errorOf(err) });
    } finally {
      f.picking = false;
    }
  }

  /** The folder changed but Connect didn't restart: try again. */
  async function restart() {
    const f = flow;
    try {
      await invoke('app_relaunch');
    } catch (err) {
      if (flow === f) step({ error: errorOf(err) });
      return;
    }
    if (flow === f) restarting(f);
  }

  return {
    open,
    choose,
    restart,
    back: () => step({ step: 'check', error: null }),
    cancel: () => dialog?.close(),
    // The relaunch helper (or the next start) opens Connect with the new folder.
    quit: () => invoke('close_app'),
  };
}
