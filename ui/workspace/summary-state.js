// Thread summaries (DESIGN 6.5): when Summarize is offered and how the card words its parts.
// Pure, so every decision is unit tested.
import { formatDate, formatDateTime, zonedParts } from './format.js';

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
  const stamp = /^\d{4}-\d{2}-\d{2}T/.test(text) ? instantOf(text, zone) : null;
  return stamp && !Number.isNaN(stamp.getTime()) ? formatDateTime(stamp, zone) : text;
}

const NO_ZONE = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?(?:\.\d+)?$/;

/** The instant of a timestamp; one without a zone or offset is wall-clock time in `zone`. */
function instantOf(text, zone) {
  const m = text.match(NO_ZONE);
  if (!m) return new Date(text);
  const [y, mo, d, h, mi, s] = m.slice(1).map(x => Number(x || 0));
  const wanted = Date.UTC(y, mo - 1, d, h, mi, s);
  let guess = wanted;
  // Two passes settle the zone's offset, also across a daylight-saving change.
  for (let i = 0; i < 2; i++) {
    const p = zonedParts(new Date(guess), zone);
    guess += wanted - Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, s);
  }
  return new Date(guess);
}

/** `due` as a commitment's date (YYYY-MM-DD) when it is one, else none. */
export const askDueDate = due => (DATE_ONLY.test(String(due ?? '').trim()) ? String(due).trim() : null);

/** The id of the commitment made from an ask: the same ask is the same commitment, so it is added once. */
export function askCommitmentId(summaryKey, ask) {
  return `ask:${hash(summaryKey)}${hash(String(ask?.text || '').trim().toLowerCase())}`;
}

// Two 32-bit hashes (different seeds) keep ids short however long a conversation id is.
function hash(text) {
  let a = 5381;
  let b = 52711;
  for (const ch of text) {
    a = ((a * 33) ^ ch.codePointAt(0)) >>> 0;
    b = ((b * 31 + ch.codePointAt(0)) ^ (b >>> 15)) >>> 0;
  }
  return `${a.toString(36)}${b.toString(36)}-`;
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
