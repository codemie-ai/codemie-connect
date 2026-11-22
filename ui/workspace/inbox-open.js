// Compact Inbox: which row has the focus (selected) and which one is shown open, kept apart
// (spec "Compact Inbox"). `sel` is `{ selected, open }`, message ids or null. Pure moves; app.js
// applies them.

/** A click opens the row, or closes it when it is the open one; either way it is selected. */
export const clickRow = (sel, id) => (sel.open === id ? { selected: id, open: null } : { selected: id, open: id });

/** ↵ opens the selected row. */
export const enterRow = sel => ({ selected: sel.selected, open: sel.selected });

/** Esc closes the open row and leaves the selection. */
export const escRow = sel => ({ selected: sel.selected, open: null });

/** The row to select once `goneId` leaves `ids`: the one after it, else the one before, else none. */
export function nextAfter(ids, goneId) {
  const i = ids.indexOf(goneId);
  if (i === -1) return null;
  return ids[i + 1] ?? ids[i - 1] ?? null;
}

/** The open row on the list `items`: still `open`, or the row that now stands for its
 *  conversation (a chat's newest message replaced the id), or none once the conversation left. */
export function followOpen(items, { open, openKey }, keyOf) {
  if (!open) return { open: null, openKey: null };
  const pick = items.find(m => m.id === open) || (openKey ? items.find(m => keyOf(m) === openKey) : null);
  return pick ? { open: pick.id, openKey: keyOf(pick) } : { open: null, openKey: null };
}

/** The message a failed draft's or summary's Retry runs for: the job's own request, else the row
 *  that holds the button, else the open row in Compact and the selected one in Default. */
export const retrySource = ({ sourceId, rowId, compact, selected, open }) => sourceId || rowId || (compact ? open : selected) || null;
