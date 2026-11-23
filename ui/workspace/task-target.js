// The action items column's one swap point (spec "The task target"): where "Add N to Tasks"
// sends the ticked To review tasks. `localTaskTarget` is Connect's own board, through
// `moveTask`; step 4 of the rollout swaps in the provider's target (Todoist) with no other change
// to the column.

/** The local Tasks board as a task target: `add` moves each id to To do, `undo` moves it back to
 *  To review. Neither throws for one task's failure; both resolve `{done, failed}` with every id
 *  sorted into one or the other. */
export function localTaskTarget({ moveTask }) {
  async function move(ids, status, log) {
    const done = [];
    const failed = [];
    for (const id of ids || []) {
      try {
        await moveTask(id, status, { log });
        done.push(id);
      } catch (e) {
        failed.push({ id, message: e?.message || String(e) });
      }
    }
    return { done, failed };
  }
  return {
    label: 'Tasks',
    add: ids => move(ids, 'todo', 'Accepted from review'),
    undo: ids => move(ids, 'review', 'Moved back to review'),
  };
}
