// Reads by revision: native's `changes_since` answers what changed after the snapshot the window
// holds (src-tauri/src/workspace/changes.rs); this applies it. Pure: no DOM, no store.

/** A record's key, as native keys its change log: kind, id and scope. */
export const recordKey = r => `${r.kind}|${r.id}|${r.connectionId ?? ''}|${r.workspaceId ?? ''}`;

/** The parts of a snapshot every delta carries whole (the last four filled by native from their
 *  own stores: the task provider, the menu bar's count, the reply voice and Ask's threads). */
const WHOLE = ['settings', 'workspaces', 'connection', 'available', 'meetingsRoot', 'noteTemplates', 'taskProvider', 'menuBar', 'replyVoice', 'ask'];

/** The snapshot's order: local records, then automation runs, then the account's; each newest
 *  first (repository.rs `visible_where`). */
const group = r => (r.connectionId == null ? (r.kind === 'automation_run' ? 1 : 0) : 2);
const snapshotOrder = (a, b) => group(a) - group(b) || (Number(b.updatedAt) || 0) - (Number(a.updatedAt) || 0);

/**
 * The next snapshot answer (`{snapshot, scope, authPending, authError}`) from `result` and a
 * delta, or null when there is nothing to apply it to or native asks for a full read (`reset`).
 * Records are keyed by kind, id and scope: `removed` keys go, a kind in `replace` comes whole,
 * `records` are put. Jobs are keyed by id (`jobsAll`: the delta's are the whole list), newest
 * first and at most 300, as native keeps them.
 */
export function applyChanges(result, delta) {
  if (!result?.snapshot || !delta || delta.reset) return null;
  const snap = result.snapshot;
  const replace = new Set(delta.replace || []);
  const removed = new Set((delta.removed || []).map(recordKey));
  const records = new Map();
  for (const r of snap.records || []) if (!replace.has(r.kind) && !removed.has(recordKey(r))) records.set(recordKey(r), r);
  for (const r of delta.records || []) records.set(recordKey(r), r);
  // The delta's jobs first: of one second, the last written comes first, as native orders them.
  const gone = new Set([...(delta.removedJobs || []), ...(delta.jobs || []).map(j => j.id)]);
  const jobs = new Map((delta.jobs || []).map(j => [j.id, j]));
  if (!delta.jobsAll) for (const j of snap.jobs || []) if (!gone.has(j.id)) jobs.set(j.id, j);
  const next = {
    ...snap,
    revision: delta.revision,
    records: [...records.values()].sort(snapshotOrder),
    jobs: [...jobs.values()].sort((a, b) => (Number(b.dueAt) || 0) - (Number(a.dueAt) || 0)).slice(0, 300),
  };
  for (const field of WHOLE) if (field in delta) next[field] = delta[field];
  return { ...result, snapshot: next, scope: delta.scope, authPending: delta.authPending, authError: delta.authError };
}
