// Reply drafts with Claude (DESIGN 6.4): the send target, the reply box's one primary action,
// the mail confirm's lines and the ⌘↩ gate. Pure, so every decision is unit tested.
import { can, messageTitle } from './selectors.js';

/** "Petrova, Anna" → "Anna"; "Anna Petrova" → "Anna"; "anna.p@x.test" → "anna.p"; "" → "". */
export function firstName(text) {
  const t = String(text || '').trim();
  if (!t) return '';
  if (t.includes('@')) return t.split('@')[0];
  if (t.includes(',')) return (t.split(',')[1] || '').trim().split(/\s+/)[0] || '';
  return t.split(/\s+/)[0];
}

/**
 * Who a reply goes to, for the primary button's label: a one-to-one chat's first name, another
 * Teams chat's title (or "the chat" when Teams gave nothing to call it), an Outlook sender's
 * first name. Empty string when nothing is known.
 */
export function sendTarget(s, m) {
  const d = m.data;
  if (d.channel === 'chat') {
    if (d.chatType === 'oneOnOne') return firstName(d.title || d.from);
    const title = messageTitle(m, s);
    return title === 'Teams chat' ? 'the chat' : title;
  }
  return firstName(d.from || d.fromAddress);
}

/**
 * The reply box's one primary action: `done` for an item that can no longer be replied to (gone
 * from Microsoft 365, or your own Outlook message — its label is "Restore" once archived), `copy`
 * when Connect is not allowed to send for this channel, else `send`, named for its target. `title`
 * is the send tooltip (DESIGN 6.4 Tooltips); empty for `copy` and `done`.
 */
export function primaryAction(s, m) {
  const d = m.data;
  const isChat = d.channel === 'chat';
  const channel = isChat ? 'chat' : 'mail';
  if (d.unavailable || d.deleted || (!isChat && d.isMine)) {
    return { kind: 'done', label: d.lifecycle === 'archived' ? 'Restore' : 'Done', channel, title: '' };
  }
  if (!can(s, isChat ? 'chat_send' : 'mail_send')) {
    return { kind: 'copy', label: 'Copy reply', channel, title: '' };
  }
  const target = sendTarget(s, m);
  if (isChat) {
    return { kind: 'send', label: target ? `Send to ${target}` : 'Send to the chat', channel, title: `Sends to ${target || 'the chat'} now (⌘↩ after you type)` };
  }
  return { kind: 'send', label: target ? `Send to ${target}…` : 'Send reply…', channel, title: 'Shows To and the subject before it goes (⌘↩ after you type)' };
}

const addressOf = r => (typeof r === 'string' ? r : r?.emailAddress?.address || r?.address || '');

/**
 * The mail confirm's lines (DESIGN 6.4): a "To" per recipient, tagging a redirected Reply-To
 * "(new)"; a "Cc" per entry when there is one; the subject; and the signature note.
 */
export function confirmLines(review) {
  const added = new Set(review.newRecipients || []);
  const lines = (review.recipients || []).map(r => {
    const address = addressOf(r);
    return `To: ${address}${added.has(address) ? ' (new)' : ''}`;
  });
  for (const cc of review.cc || []) lines.push(`Cc: ${addressOf(cc)}`);
  lines.push(`Subject: ${review.title}`);
  lines.push('Signature: none — Connect sends your text as written');
  return lines;
}

/**
 * Whether ⌘↩ may act now: the user's own touch on this reply box, no key repeat, nothing open
 * (a confirm, a popover, a sheet, a menu), and the primary action is a send — never Copy or Done.
 */
export function sendKeyAllowed({ touchedKey, key, repeat, blocked, primaryKind }) {
  return touchedKey === key && !repeat && !blocked && primaryKind === 'send';
}
