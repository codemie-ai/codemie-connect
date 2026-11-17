// Thread summaries (DESIGN 6.5): when Summarize is offered and how the card words its parts.
// Pure, so every decision is unit tested.
import { formatDate, formatDateTime } from './format.js';

/** A conversation is long enough to summarize at this many messages, or more than this much text. */
export const SUMMARY_MIN_MESSAGES = 4;
export const SUMMARY_MIN_CHARS = 2000;

/** Whether `thread` (the conversation's messages) is long enough to offer Summarize. */
export function summaryOffered(thread = []) {
  const chars = thread.reduce((n, m) => n + String(m.data?.text || '').length, 0);
  return thread.length >= SUMMARY_MIN_MESSAGES || chars > SUMMARY_MIN_CHARS;
}

const DATE_ONLY = /^(\d{4})-(\d{2})-(\d{2})$/;

/** A due date as the card shows it: "Fri, Nov 20" for YYYY-MM-DD, a date and time for a full timestamp, else as written. */
export function askDue(due, zone) {
  const text = String(due ?? '').trim();
  if (!text) return '';
  const day = text.match(DATE_ONLY);
  if (day) {
    const [, y, m, d] = day.map(Number);
    const at = new Date(Date.UTC(y, m - 1, d, 12));
    // A calendar date has no zone: it is shown for the day it names.
    if (at.getUTCMonth() === m - 1 && at.getUTCDate() === d) return formatDate(at, 'UTC', { weekday: 'short', month: 'short', day: 'numeric' });
    return text;
  }
  const stamp = /^\d{4}-\d{2}-\d{2}T/.test(text) ? new Date(text) : null;
  return stamp && !Number.isNaN(stamp.getTime()) ? formatDateTime(stamp, zone) : text;
}

/** `due` as a commitment's date (YYYY-MM-DD) when it is one, else none. */
export const askDueDate = due => (DATE_ONLY.test(String(due ?? '').trim()) ? String(due).trim() : null);

/** The id of the commitment made from an ask: the same ask is the same commitment, so it is added once. */
export function askCommitmentId(summaryKey, ask) {
  let h = 5381;
  for (const ch of String(ask?.text || '').trim().toLowerCase()) h = ((h * 33) ^ ch.codePointAt(0)) >>> 0;
  return `ask:${summaryKey}:${h.toString(36)}`;
}

/** The `local_save` request that adds an ask to the commitments. */
export function askCommitment(summaryKey, ask) {
  return { kind: 'commitment', id: askCommitmentId(summaryKey, ask), text: String(ask?.text || '').trim(), owner: 'You', due: askDueDate(ask?.due) };
}

/** Which of a summary's asks are already commitments (`commitments` are the commitment records). */
export function addedAsks(summaryKey, asks = [], commitments = []) {
  const ids = new Set(commitments.map(c => c.id));
  return asks.map(ask => ids.has(askCommitmentId(summaryKey, ask)));
}
