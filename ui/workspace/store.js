// Native snapshots are authoritative. Mutations are serialized and always followed by a fresh
// snapshot, so the UI never renders optimistic state that native storage rejected.
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

  function mutate(op, data = {}, workspaceId) {
    const run = async () => {
      if (!state) await refresh();
      try {
        return await invoke('workspace_request', {
          request: {
            op,
            data,
            workspaceId: workspaceId ?? state.snapshot.settings.activeWorkspace,
            expectedRevision: state.snapshot.revision,
            operationId: crypto.randomUUID(),
          },
        });
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
