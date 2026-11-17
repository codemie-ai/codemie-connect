// Native snapshots are authoritative. Mutations are serialized and always followed by a fresh
// snapshot, so the UI never renders optimistic state that native storage rejected.
// Operations whose outcome does not depend on what the user was looking at, so a
// background sync bumping the revision may safely rebase them onto the fresh snapshot.
// An AI draft or summary reads the conversation when it runs (and fails with `conflict` if it changed), and
// Stop ends whatever is running, so neither depends on the revision the user saw.
export const REBASE_SAFE = new Set(['settings_update', 'layout_save', 'local_save', 'local_delete', 'inbox_decision', 'draft_save', 'schedule_save', 'schedule_delete', 'workspace_select', 'ai_settings_save', 'ai_draft', 'ai_summarize', 'job_cancel', 'automation_save', 'automation_delete', 'automation_toggle', 'automation_run_now']);

export function createStore(invoke) {
  let state = null;
  let latestRead = 0;
  let chain = Promise.resolve();
  const listeners = new Set();

  async function refresh() {
    const read = ++latestRead;
    const result = await invoke('workspace_request', { request: { op: 'snapshot' } });
    if (read === latestRead) {
      state = result;
      listeners.forEach(fn => fn(result));
    }
    return state;
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
      try {
        try {
          return await send();
        } catch (error) {
          if (!retry || error?.code !== 'stale_view') throw error;
          // A background sync moved the revision. Rebase onto the fresh snapshot, once, with the same operation ID.
          await refresh();
          return await send();
        }
      } finally {
        await refresh();
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
