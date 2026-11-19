// The Automations controller (DESIGN 6.6): the Run log pages, Run now, the editor dialog,
// duplicate, delete and the links and sources of a run. app.js routes the `automation*` and
// `run-*` actions here. Everything it touches is injected (the store, the app state, render,
// route, the dialogs), so node:test drives it without a browser; only the editor's own form is
// DOM.
import {
  automationEditor, draftFromAutomation, editorDraft, toAutomation, errorTarget, outputText, newAutomationDraft, duplicateDraft, needsSenders, AUTOMATION_TABS, TEMPLATES,
} from './view-automations.js';
import { records } from './selectors.js';
import { controlSelector, soleMatch } from './ui.js';

/** Runs per Run log page (native allows up to 50). */
export const RUNS_PAGE = 20;
/** How long a new automation's row stays highlighted after it is created. */
export const HIGHLIGHT_MS = 3000;

/** What changes when a run starts, ends or is stored: the Run log reads its first page again. */
export const runSignature = s => [
  ...records(s, 'automation_run').map(r => `${r.id}:${r.revision}`),
  ...s.jobs.filter(j => j.kind === 'automation_run').map(j => `${j.id}:${j.state}`),
].sort().join('|');

/** Where a clicked notification about an automation run goes: its run, open, in the Run log. */
export function notificationTarget(payload) {
  if (!payload?.runId) return null;
  return { tab: 'runs', filter: payload.automationId || '', expanded: [payload.runId] };
}

/**
 * `state` is the app state (`state.route`, `state.ai`, `state.automations`); `snap()` the current
 * snapshot; `mutate(op, data)` a fenced write that re-renders; `route(name, tab)` navigation;
 * `render()` a re-render; `openModal`, `confirmModal` and `toast` the dialogs; `ensureClaudeChoice()`
 * asks which Claude writes (null when cancelled); `writeText` copies; `modalOpen()` says whether
 * a dialog is open; `dock.visible()` the page's section tabs in view.
 */
export function createAutomationsController({
  state, store, snap, mutate, route, render, openModal, confirmModal, toast, ensureClaudeChoice, writeText,
  modalOpen = () => false, later = (fn, ms) => setTimeout(fn, ms), dock = { visible: () => [] },
}) {
  const ui = () => state.automations;
  /** The Run log is in view, in whichever section holds it. */
  const runLogOpen = () => state.route === 'automations' && dock.visible().includes('auto-runs');
  const automation = id => snap().records.find(r => r.kind === 'automation' && r.id === id);
  const missing = () => new Error('This automation no longer exists. Refresh and try again.');
  let runLoads = 0;
  let lastSignature = '';

  /**
   * Reads the Run log: the newest page (keeping as many runs as were shown, up to 50), or with
   * `more` the page after the last one shown. Pages come from `automation_runs`, not the
   * snapshot. A later load wins over an earlier one still on its way.
   */
  async function loadRuns({ more = false, snapshot = snap() } = {}) {
    const runs = ui().runs;
    if (more && !runs.next) return;
    const load = ++runLoads;
    // Taken before asking, so a snapshot that arrives meanwhile doesn't start a second load.
    lastSignature = runSignature(snapshot);
    const request = { automationId: runs.filter || null, limit: more ? RUNS_PAGE : Math.min(50, Math.max(RUNS_PAGE, runs.items?.length || 0)) };
    if (more) {
      request.before = runs.next;
      runs.loadingMore = true;
      if (runLogOpen() && !modalOpen()) await render();
    }
    try {
      const page = await store.query('automation_runs', request);
      if (load !== runLoads) return;
      Object.assign(runs, { items: more ? [...(runs.items || []), ...page.runs] : page.runs, next: page.next, error: '', loadingMore: false });
    } catch (err) {
      if (load !== runLoads) return;
      Object.assign(runs, { error: err?.message || String(err), loadingMore: false });
    }
    // The filter select keeps focus after a choice; render keeps it there.
    if (runLogOpen() && !modalOpen()) await render();
  }

  /**
   * The page's sections changed: the tab the hash names is the one `fresh` brought into view (a
   * tab chosen, moved or expanded there), or, when the one chosen last is out of view, the first
   * in view; the Run log reads its newest page when it came into view.
   */
  function follow(fresh = []) {
    const shown = dock.visible();
    const nameOf = id => AUTOMATION_TABS.find(([, tab]) => tab === id)?.[0];
    const came = fresh.filter(id => shown.includes(id));
    const current = AUTOMATION_TABS.find(([id]) => id === ui().tab)?.[1];
    if (came.length === 1) ui().tab = nameOf(came[0]);
    else if (shown.length && !shown.includes(current)) ui().tab = nameOf(shown[0]);
    return came.includes('auto-runs') && runLogOpen() ? loadRuns() : undefined;
  }

  /** A new snapshot: the Run log reloads when a run started, ended or was stored. */
  function snapshotChanged(snapshot) {
    if (!runLogOpen() || !ui().runs.items || runSignature(snapshot) === lastSignature) return undefined;
    return loadRuns({ snapshot });
  }

  /** Asks once which Claude runs automations when nothing would choose one; false when cancelled. */
  async function claudeReadyFor(a) {
    const ai = state.ai || {};
    if (ai.status !== 'ready' || a.ai?.profile || ai.settings?.routes?.automation?.profile || ai.settings?.defaultProfile) return true;
    return !!(await ensureClaudeChoice());
  }

  async function runNow(id) {
    const rec = automation(id);
    if (!rec) throw missing();
    if (!(await claudeReadyFor(rec.data))) return false;
    await mutate('automation_run_now', { id });
    toast(`“${rec.data.name}” is running. Its result appears in the Run log${rec.data.deliver?.today ? ' and on Today' : ''}.`, 'success');
    return true;
  }

  async function duplicate(id) {
    const rec = automation(id);
    if (!rec) throw missing();
    const copy = toAutomation(duplicateDraft(rec));
    await mutate('automation_save', copy);
    toast(`Duplicated as “${copy.name}”. The copy stays off until you turn it on.`, 'success');
  }

  function confirmDelete(id) {
    const rec = automation(id);
    if (!rec) return undefined;
    return confirmModal({
      title: `Delete “${rec.data.name}”?`,
      text: 'Its run log is deleted with it, and a run in progress stops. Reply drafts it prepared stay in your Inbox.',
      confirm: 'Delete automation', variant: 'danger', initialFocus: 'cancel', guard: true,
      onConfirm: async () => {
        await mutate('automation_delete', { id });
        const runs = ui().runs;
        runs.items = runs.items?.filter(r => r.data.automationId !== id) || null;
        toast('Automation deleted.', 'success');
      },
    });
  }

  /**
   * Saves the editor's draft. `{record, todayCard}` when saved; `{error: {field, message}}` for
   * a sentence the editor shows at a visible field; anything else is thrown for the dialog.
   */
  async function save(draft) {
    let data;
    try {
      data = toAutomation(draft);
      const result = await mutate('automation_save', data);
      return { record: result?.record, todayCard: !!result?.todayCard, data };
    } catch (err) {
      const error = errorTarget(err, draft, state.ai);
      if (error) return { error };
      throw err;
    }
  }

  /** Shows a new automation in the list for a moment. */
  async function showCreated(id) {
    ui().highlight = id;
    await route('automations', 'automations');
    later(() => {
      if (ui().highlight !== id) return;
      ui().highlight = null;
      if (state.route === 'automations' && !modalOpen()) render();
    }, HIGHLIGHT_MS);
  }

  /** Opens a run in the Run log, filtered to its automation (Today's card, a notification). */
  async function openRun(runId, automationId = '') {
    Object.assign(ui().runs, { filter: automationId || '', items: null, next: null, expanded: [runId] });
    return route('automations', 'runs');
  }

  const editorCtx = (error = null) => ({ zone: snap().settings.timeZone, ai: state.ai, error });

  /** Renders the editor again from its own form (a trigger, event, profile or reply-draft change, or an error). */
  function refreshEditor(form, change = {}, error = null) {
    const body = form?.querySelector('#automation-editor');
    if (!body) return null;
    const draft = { ...editorDraft(new FormData(form)), ...change };
    const focused = form.ownerDocument.activeElement;
    const selector = focused && body.contains(focused) ? controlSelector(focused) : null;
    const scroller = body.closest('.ws-modal-body');
    const scroll = scroller?.scrollTop;
    body.innerHTML = automationEditor(draft, editorCtx(error));
    if (scroller) scroller.scrollTop = scroll;
    if (selector) soleMatch(body, selector)?.focus({ preventScroll: true });
    return body;
  }

  /** The editor for a new or saved automation (`draft` from `draftFromAutomation`). */
  async function openEditor(draft, { title } = {}) {
    // Profiles and models for the AI choice; a failure leaves "Default" to choose.
    if (state.ai?.status !== 'ready') {
      await store.query('ai_status', {}).then(status => Object.assign(state.ai, { status: 'ready', profiles: status.profiles, settings: status.settings })).catch(() => {});
    }
    const creating = !draft.id;
    const dialog = openModal({
      title: title || (creating ? 'New automation' : `Edit “${draft.name}”`),
      subtitle: 'Claude prepares, you decide. Automations never send anything.',
      body: `<div class="ws-auto-editor" id="automation-editor">${automationEditor(draft, editorCtx())}</div>`,
      submit: creating ? 'Create automation' : 'Save changes',
      size: 'lg',
      onSubmit: async form => {
        const current = editorDraft(form);
        const result = await save(current);
        if (result.error) {
          const body = refreshEditor(dialog.querySelector('form'), {}, result.error);
          const target = body?.querySelector(`#${result.error.field}`);
          target?.scrollIntoView({ block: 'center' });
          (target?.matches('input,select,textarea') ? target : target?.querySelector('input:not([type=hidden]),select,textarea'))?.focus({ preventScroll: true });
          return false;
        }
        const name = result.data.name.trim();
        toast(creating
          ? `“${name}” is ready${result.data.enabled ? '' : '. It stays off until you turn it on'}.${result.todayCard ? ' Its results appear in Automation results on Today.' : ''}`
          : 'Automation saved.', 'success');
        if (creating && result.record?.id) {
          dialog.close();
          await showCreated(result.record.id);
          return false;
        }
        return undefined;
      },
    });
    dialog.classList.add('ws-auto-modal');
    // The Draft replies template needs its senders first.
    if (needsSenders(draft)) dialog.querySelector('#auto-senders')?.focus({ preventScroll: true });
    return dialog;
  }

  /** The `automation*` and `run-*` actions. `el` is the control (its dataset, value, checked). */
  async function handle(action, el) {
    const id = el.dataset?.id;
    el.closest?.('details')?.removeAttribute('open');
    const runs = ui().runs;
    switch (action) {
      // The section tab of that page tab (`runs` is `auto-runs` …), wherever it sits.
      case 'automations-tab': return route('automations', el.dataset.tab);
      case 'automation-new': return openEditor(newAutomationDraft());
      case 'automation-template': {
        const template = TEMPLATES.find(t => t.id === id);
        return template ? openEditor(draftFromAutomation(template.automation), { title: `New automation: ${template.name}` }) : undefined;
      }
      case 'automation-edit': {
        const rec = automation(id);
        if (!rec) throw missing();
        return openEditor(draftFromAutomation({ ...rec.data, id: rec.id }));
      }
      case 'automation-duplicate': return duplicate(id);
      case 'automation-delete': return confirmDelete(id);
      case 'automation-toggle':
        return mutate('automation_toggle', { id, enabled: el.checked }).catch(err => { el.checked = !el.checked; throw err; });
      case 'automation-run': return runNow(id);
      case 'automation-choose':
        if (!(await ensureClaudeChoice())) return undefined;
        return runNow(id);
      case 'automation-runs-of':
        Object.assign(runs, { filter: id || '', items: null, next: null, expanded: [] });
        return route('automations', 'runs');
      case 'automation-open-run': return openRun(id, el.dataset.automation);
      case 'automation-runs-filter':
        Object.assign(runs, { filter: el.value, items: null, next: null, expanded: [] });
        await render();
        return loadRuns();
      case 'automation-runs-refresh': return loadRuns();
      case 'automation-runs-more': return loadRuns({ more: true });
      case 'run-toggle':
        runs.expanded = runs.expanded.includes(id) ? runs.expanded.filter(x => x !== id) : [...runs.expanded, id];
        return render();
      case 'run-copy': {
        const run = runs.items?.find(r => r.id === id) || snap().records.find(r => r.kind === 'automation_run' && r.id === id);
        try {
          await writeText(outputText(run));
          return toast('Output copied.', 'success');
        } catch {
          return toast('Could not copy. Select the text and copy it.', 'error');
        }
      }
      case 'run-link': return store.query('open_source', { kind: 'automation_run', id, link: Number(el.dataset.link) });
      // Inside the editor: the trigger kind, the event, the profile or the reply draft changed.
      case 'automation-kind': {
        const form = el.closest('form');
        refreshEditor(form, { kind: el.dataset.kind });
        return form?.querySelector(`[data-action="automation-kind"][data-kind="${el.dataset.kind}"]`)?.focus();
      }
      case 'automation-form': return refreshEditor(el.closest('form'));
      default: return undefined;
    }
  }

  return { loadRuns, snapshotChanged, follow, runNow, duplicate, confirmDelete, save, openEditor, openRun, handle, runLogOpen };
}
