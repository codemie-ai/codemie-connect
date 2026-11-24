// The action items column's one swap point (spec "The task target"; task provider design §10):
// where "Add N to …" sends the ticked To review tasks, and how its Undo takes them back.
// `localTaskTarget` is Connect's own board, `providerTaskTarget` the active provider (Todoist);
// both add through `moveTask` and undo through one `task_withdraw`. `activeTaskTarget` is the one
// app.js hands the meetings controller: the target of whichever provider is active now.
import { activeProvider, taskStatus } from './tasks-model.js';

/** `add(ids)`: moves each id to To do, as accepting it from review does. Never throws for one
 *  task's failure; resolves `{done, failed}` with every id sorted into one or the other. */
async function accept(moveTask, ids) {
  const done = [];
  const failed = [];
  for (const id of ids || []) {
    try {
      await moveTask(id, 'todo', { log: 'Accepted from review' });
      done.push(id);
    } catch (e) {
      failed.push({ id, message: e?.message || String(e) });
    }
  }
  return { done, failed };
}

/** `undo(ids)`: one `withdraw(ids)` (`task_withdraw`, which answers counts). Each task goes back
 *  To review; a provider drops a create not sent yet, or deletes one already there (ruling 8).
 *  When any fails, `statusOf(id)` (the task's status in the snapshot after the call) says which
 *  went back (`review`) and which stayed sent; only those keep Undo, with why. Without
 *  `statusOf` every id keeps it (withdrawing one already back changes nothing). A rejection is
 *  left to the caller. */
async function withdrawAll(withdraw, statusOf, ids) {
  const list = [...(ids || [])];
  if (!list.length) return { done: [], failed: [] };
  const answer = await withdraw(list);
  const failed = Number(answer?.failed) || 0;
  if (!failed) return { done: list, failed: [] };
  const message = failed >= list.length ? 'Couldn’t go back to review. Try again.' : `${failed} of ${list.length} couldn’t go back to review. Try again.`;
  const back = statusOf ? list.filter(id => statusOf(id) === 'review') : [];
  return { done: back, failed: list.filter(id => !back.includes(id)).map(id => ({ id, message })) };
}

/** A provider as a task target: the column reads "Add N to <label>", "In <label>". */
export function providerTaskTarget({ label, moveTask, withdraw, statusOf = null }) {
  return {
    label,
    add: ids => accept(moveTask, ids),
    undo: ids => withdrawAll(withdraw, statusOf, ids),
  };
}

/** The local Tasks board as a task target (`task_withdraw` for Local is the move back to
 *  review, "Moved back to review"). */
export function localTaskTarget({ moveTask, withdraw, statusOf = null }) {
  return providerTaskTarget({ label: 'Tasks', moveTask, withdraw, statusOf });
}

/** The target of the provider active in `snap()`, made again when `taskProvider.active` (or its
 *  name) changes; its `label` is read at each draw. */
export function activeTaskTarget({ snap, moveTask, withdraw }) {
  let made = null;
  // Read after `withdraw` resolves: the store has refreshed the snapshot by then.
  const statusOf = id => {
    const r = snap().records.find(x => x.kind === 'commitment' && x.id === id);
    return r ? taskStatus(r) : null;
  };
  const current = () => {
    const s = snap();
    const id = activeProvider(s);
    const name = s.taskProvider?.name || 'your task app';
    if (made?.id !== id || made.name !== name) {
      made = {
        id, name,
        target: id === 'local' ? localTaskTarget({ moveTask, withdraw, statusOf }) : providerTaskTarget({ label: name, moveTask, withdraw, statusOf }),
      };
    }
    return made.target;
  };
  return {
    get label() { return current().label; },
    add: ids => current().add(ids),
    undo: ids => current().undo(ids),
  };
}

/** An Inbox add's toast: `local` as before with Local, "Added to <provider>" with a provider. */
export const addedLine = (s, local) => (activeProvider(s) === 'local' ? local : `Added to ${s.taskProvider?.name || 'your task app'}`);
