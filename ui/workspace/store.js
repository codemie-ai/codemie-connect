// Native snapshots are authoritative. Mutations are serialized and always followed by a fresh
// snapshot, so the UI never renders optimistic state that native storage rejected.
// Operations whose outcome does not depend on what the user was looking at, so a
// background sync bumping the revision may safely rebase them onto the fresh snapshot.
// An AI draft or summary reads the conversation when it runs (and fails with `conflict` if it changed), and
// Stop ends whatever is running, so neither depends on the revision the user saw.
// Meetings: `meeting_doc` edit, delete and version are fenced by their own baseVersion/baseRev (the
// document as the person saw it), so native answers `conflict` rather than overwriting or archiving
// text made since; `main` only renames files, and import replaces the transcript the person chose
// to replace. Check, download and notes dedupe natively (a save or notes run already going is
// reused) and act on the meeting as it is when they run; `meeting_set` and `meeting_speakers`
// change only what the person picked. Templates, rules, their order and the glossary and tag list
// are local to this window (Settings › Meetings): a sync never touches them, and the revision
// fence protects nothing about a file's content (`meeting_text_save` refuses to write over a
// glossary it could not read whole).
// Sending: `action_prepare` reads the source as it is when it runs and keeps its revision, and the
// person reviews what will go out; `action_confirm` sends only that reviewed action and refuses
// (`conflict`) when it was used, expired or its source changed since (actions.rs `confirm_action`).
// Sync now, Retry, a calendar range and a test notification act on things as they are when they run.
export const REBASE_SAFE = new Set(['action_prepare', 'action_confirm', 'sync_request', 'job_retry', 'calendar_window', 'notification_test', 'settings_update', 'layout_save', 'local_save', 'local_delete', 'inbox_decision', 'draft_save', 'schedule_save', 'schedule_delete', 'workspace_select', 'ai_settings_save', 'ai_draft', 'ai_summarize', 'job_cancel', 'automation_save', 'automation_delete', 'automation_toggle', 'automation_run_now', 'task_save', 'task_delete', 'meeting_check', 'meeting_download', 'meeting_import', 'meeting_speakers', 'meeting_notes', 'meeting_set', 'meeting_doc', 'meeting_rule_save', 'meeting_rule_delete', 'meeting_rule_order', 'template_save', 'template_delete', 'meeting_text_save']);

/** How many times a rebase-safe operation is sent before a stale view is reported. */
const REBASE_TRIES = 5;

/** `now()` is the clock `refreshAfter` compares with (the caller's `performance.now()`). */
export function createStore(invoke, { now = () => performance.now() } = {}) {
  let state = null;
  // Reads asked so far, and the one whose snapshot `state` holds.
  let asked = 0;
  let applied = 0;
  let askedAt = -Infinity;
  // The state once the read asked last has landed.
  let lastRead = Promise.resolve(null);
  // A write is on its way: its tries and its own read.
  let writing = false;
  let chain = Promise.resolve();
  const listeners = new Set();
  const tell = () => listeners.forEach(fn => fn(state));

  // Reads can land out of order. One asked after the snapshot shown replaces it; an older one is
  // dropped and settles with the newer state, so the view never goes back. A read never waits for
  // a later one: a full snapshot of a real workspace takes about a second, and a write's own read
  // waiting for the workspace:changed read its own change set off took two or more (Accept on the
  // Meeting page looked broken). A read that lands while a write is on its way is kept (a rebase
  // needs its revision) but not shown: it may not have the write yet, and drawing it would put
  // back what the person just moved or switched. The write's own read shows it.
  function read() {
    const n = ++asked;
    askedAt = now();
    const landed = invoke('workspace_request', { request: { op: 'snapshot' } }).then(result => {
      if (n <= applied) return false;
      applied = n;
      state = result;
      return true;
    });
    lastRead = landed.then(() => state, () => state);
    return landed;
  }

  async function refresh() {
    if (await read() && !writing) tell();
    return state;
  }

  /** A workspace:changed heard at `at` (`now()`): read again, unless a read asked since then
   *  already brings that change (a write's own read brings the change the write announced). */
  function refreshAfter(at) {
    return askedAt >= at ? lastRead : refresh();
  }

  function mutate(op, data = {}, workspaceId, { retry = REBASE_SAFE.has(op) } = {}) {
    const run = async () => {
      if (!state) await refresh();
      const operationId = crypto.randomUUID();
      const send = () => invoke('workspace_request', {
        request: {
          op,
          data,
          workspaceId: workspaceId ?? state.snapshot.settings.activeWorkspace,
          expectedRevision: state.snapshot.revision,
          operationId,
        },
      });
      writing = true;
      try {
        // A background sync moved the revision. Rebase onto the fresh snapshot with the same
        // operation ID; a sync writing record after record can move it again in between, so a
        // few times. A refused attempt reserves nothing natively.
        for (let attempt = 1; ; attempt++) {
          try {
            return await send();
          } catch (error) {
            if (!retry || error?.code !== 'stale_view' || attempt >= REBASE_TRIES) throw error;
            await read();
          }
        }
      } finally {
        try {
          await read();
        } finally {
          writing = false;
        }
        tell();
      }
    };
    const task = chain.then(run, run);
    chain = task.catch(() => {});
    return task;
  }

  function query(op, data = {}) {
    return invoke('workspace_request', {
      request: { op, data, workspaceId: state?.snapshot.settings.activeWorkspace },
    });
  }

  return {
    get: () => state,
    refresh,
    refreshAfter,
    mutate,
    query,
    subscribe(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
  };
}

const ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
export const escapeHtml = value => String(value ?? '').replace(/[&<>"']/g, c => ESCAPES[c]);

export { calendarDays, calendarWindow, calendarCoverage } from './calendar-model.js';
