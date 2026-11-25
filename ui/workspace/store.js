// Native snapshots are authoritative. Mutations are serialized and followed by a fresh snapshot.
// An operation with a preview (`optimistic`, e.g. task_save) shows its change the moment it is
// asked, laid over the snapshot until a read that has it lands; one native refuses is taken back
// at once. Queued rebase-safe writes share one snapshot read: between them only the revision is
// read (a full snapshot of a real workspace takes about a second).
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
import { applyChanges } from './changes.js';

export const REBASE_SAFE = new Set(['action_prepare', 'action_confirm', 'sync_request', 'job_retry', 'calendar_window', 'notification_test', 'settings_update', 'layout_save', 'local_save', 'local_delete', 'inbox_decision', 'draft_save', 'schedule_save', 'schedule_delete', 'workspace_select', 'ai_settings_save', 'ai_draft', 'ai_summarize', 'job_cancel', 'automation_save', 'automation_delete', 'automation_toggle', 'automation_run_now', 'task_save', 'task_delete', 'meeting_check', 'meeting_download', 'meeting_import', 'meeting_speakers', 'meeting_notes', 'meeting_set', 'meeting_doc', 'meeting_rule_save', 'meeting_rule_delete', 'meeting_rule_order', 'template_save', 'template_delete', 'meeting_text_save']);

/** How many times a rebase-safe operation is sent before a stale view is reported. */
const REBASE_TRIES = 5;

/** `now()` is the clock `refreshAfter` compares with (the caller's `performance.now()`);
 *  `optimistic` maps an operation to its preview, `(snapshot, data, { operationId }) => snapshot`
 *  (null: none). The operation id is the one sent, so a record native names by it (a new task)
 *  is shown under its final id. With `deltas`, a read with a snapshot in hand asks native what
 *  changed since it (`changes_since`, changes.js) and reads the whole snapshot only at first, on
 *  a reset or when that fails. */
export function createStore(invoke, { now = () => performance.now(), optimistic = {}, deltas = false } = {}) {
  // What native last gave, and what is shown: that with the changes on their way laid over it.
  let state = null;
  let shown = null;
  // Changes shown before native has them: `{apply, after}`, `after` the reads asked when its
  // write was answered (null until then). A read asked after that has the change.
  let changes = [];
  // Reads asked so far, and the one whose snapshot `state` holds.
  let asked = 0;
  let applied = 0;
  let askedAt = -Infinity;
  // The state once the read asked last has landed.
  let lastRead = Promise.resolve(null);
  // Writes are on their way (the queue is draining): their tries and their reads.
  let writing = false;
  let drained = Promise.resolve();
  const queue = [];
  const listeners = new Set();
  const lay = (result, change) => {
    try {
      const snapshot = change.apply(result.snapshot);
      return snapshot ? { ...result, snapshot } : result;
    } catch {
      return result;
    }
  };
  const show = () => {
    changes = changes.filter(c => c.after === null || c.after >= applied);
    shown = state && changes.reduce(lay, state);
  };
  const tell = () => {
    show();
    listeners.forEach(fn => fn(shown));
  };

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
    const whole = () => invoke('workspace_request', { request: { op: 'snapshot' } });
    // A delta is applied to the state this read was asked on: whatever lands meanwhile, the
    // result is native's state at the delta's revision.
    const base = deltas && state?.scope ? state : null;
    const answer = base
      ? invoke('workspace_request', { request: { op: 'changes_since', data: { revision: base.snapshot.revision, scope: base.scope } } })
        .then(delta => applyChanges(base, delta) ?? whole(), whole)
      : whole();
    const landed = answer.then(result => {
      if (n <= applied) return false;
      applied = n;
      state = result;
      show();
      return true;
    });
    lastRead = landed.then(() => shown, () => shown);
    return landed;
  }

  async function refresh() {
    if (await read() && !writing) tell();
    return shown;
  }

  /** A workspace:changed heard at `at` (`now()`): read again, unless a read asked since then
   *  already brings that change (a write's own read brings the change the write announced), or
   *  writes are on their way (the queue's last read, asked after them, brings it). */
  function refreshAfter(at) {
    if (writing) return drained.then(() => shown);
    return askedAt >= at ? lastRead : refresh();
  }

  function mutate(op, data = {}, workspaceId, { retry = REBASE_SAFE.has(op) } = {}) {
    const operationId = crypto.randomUUID();
    const preview = state && optimistic[op];
    const change = preview ? { apply: snapshot => preview(snapshot, data, { operationId }), after: null } : null;
    const task = new Promise((resolve, reject) => queue.push({ op, data, workspaceId, retry, operationId, change, resolve, reject }));
    if (change) {
      changes.push(change);
      tell();
    }
    if (!writing) drained = drain();
    return task;
  }

  /** Sends one write on `revision` (null: the shown snapshot's), rebasing a rebase-safe one. */
  async function send(w, revision) {
    const { operationId } = w;
    let expectedRevision = revision ?? state.snapshot.revision;
    // A background sync moved the revision. Rebase onto the fresh snapshot with the same
    // operation ID; a sync writing record after record can move it again in between, so a few
    // times. A refused attempt reserves nothing natively.
    for (let attempt = 1; ; attempt++) {
      try {
        return await invoke('workspace_request', {
          request: { op: w.op, data: w.data, workspaceId: w.workspaceId ?? state.snapshot.settings.activeWorkspace, expectedRevision, operationId },
        });
      } catch (error) {
        if (!w.retry || error?.code !== 'stale_view' || attempt >= REBASE_TRIES) throw error;
        await read();
        expectedRevision = state.snapshot.revision;
      }
    }
  }

  /** Native's revision now, for a rebase-safe write queued behind another; null when it can't
   *  say (the write then waits for a full read, as before). */
  async function currentRevision() {
    try {
      const answer = await invoke('workspace_request', { request: { op: 'revision' } });
      return Number.isInteger(answer?.revision) ? answer.revision : null;
    } catch {
      return null;
    }
  }

  /** Sends the queued writes one by one. Between two, a rebase-safe next write needs only the
   *  revision; anything else, and the end of the queue, reads the whole snapshot. A write with a
   *  preview settles when native answers it; any other once a read asked after it has landed
   *  (its caller may look for the change in the snapshot). A preview is laid over until then. */
  async function drain() {
    writing = true;
    const sent = [];
    try {
      while (queue.length) {
        const w = queue.shift();
        try {
          if (!state) await read();
          w.result = await send(w, w.revision ?? null);
          // A write shown by its preview has done its step once native answers: its caller's
          // toast need not wait for the read (the preview stays until a read has the change).
          if (w.change) w.resolve(w.result);
        } catch (error) {
          w.error = error;
          if (w.change) {
            changes = changes.filter(c => c !== w.change);
            tell();
          }
        }
        if (w.change) w.change.after = asked;
        sent.push(w);
        const next = queue[0];
        const revision = next?.retry ? await currentRevision() : null;
        if (revision !== null && queue[0] === next) {
          next.revision = revision;
          continue;
        }
        let failed = null;
        try {
          await read();
        } catch (error) {
          failed = error;
        }
        // A write asked while this was drawn (still `writing`) is queued here, never in a second drain.
        tell();
        for (const done of sent.splice(0)) {
          const error = done.error ?? failed;
          if (error) done.reject(error);
          else done.resolve(done.result);
        }
      }
    } finally {
      writing = false;
    }
  }

  function query(op, data = {}) {
    return invoke('workspace_request', {
      request: { op, data, workspaceId: state?.snapshot.settings.activeWorkspace },
    });
  }

  return {
    get: () => shown,
    refresh,
    refreshAfter,
    mutate,
    /** Settles with the shown state once no write is queued and the queue's last read landed. */
    idle: () => (writing ? drained : Promise.resolve()).then(() => shown),
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
