// Reply drafts with Claude (DESIGN 6.4): the send target, the primary action, the mail confirm's
// lines and the ⌘↩ gate. Pure, so every decision is unit tested. Also the fixture-parity check
// that the mail prepare contract fixture only tags a redirected Reply-To as new.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { firstName, primaryAction, confirmLines, sendKeyAllowed } from '../workspace/reply-model.js';
import { buildSnapshot } from './fixtures/workspace-fixture.mjs';

const contract = name => JSON.parse(readFileSync(new URL(`./fixtures/contract/${name}.json`, import.meta.url), 'utf8'));
const message = (s, id) => s.records.find(r => r.kind === 'message' && r.id === id);

test('the mail prepare fixture tags only a redirected Reply-To', () => {
  const { normal, redirected } = contract('action-prepare-mail');
  assert.deepStrictEqual(normal.review.newRecipients, []);
  assert.equal(redirected.review.newRecipients.length, 1);
  const addresses = redirected.review.recipients.map(r => r.emailAddress.address);
  for (const address of redirected.review.newRecipients) assert.ok(addresses.includes(address));
});

test('firstName reads Last, First, a full name and an address', () => {
  assert.equal(firstName('Petrova, Anna'), 'Anna');
  assert.equal(firstName('Anna Petrova'), 'Anna');
  assert.equal(firstName('anna.p@x.test'), 'anna.p');
  assert.equal(firstName(''), '');
});

test('the primary action is named for its target', () => {
  const s = buildSnapshot(Date.now(), { photo: false });
  s.connection.enabled.push('chat_send', 'mail_send');
  const oneOnOne = primaryAction(s, message(s, 'c-reply-1'));
  assert.equal(oneOnOne.kind, 'send');
  assert.equal(oneOnOne.label, 'Send to Jordan');
  assert.equal(oneOnOne.channel, 'chat');
  assert.match(oneOnOne.title, /Jordan/);
  assert.equal(primaryAction(s, message(s, 'c-reply-2')).label, 'Send to Release crew');
  assert.equal(primaryAction(s, message(s, 'm-reply-1')).label, 'Send to Priya…');
  assert.deepEqual(primaryAction(s, message(s, 'm-thread-mine')), { kind: 'done', label: 'Done', channel: 'mail', title: '' });
  const goneAway = { ...message(s, 'm-reply-1'), data: { ...message(s, 'm-reply-1').data, unavailable: true } };
  assert.equal(primaryAction(s, goneAway).kind, 'done');
});

test('without permission the primary is Copy reply', () => {
  const s = buildSnapshot(Date.now(), { photo: false });
  assert.deepEqual(primaryAction(s, message(s, 'c-reply-1')), { kind: 'copy', label: 'Copy reply', channel: 'chat', title: '' });
});

test('confirm lines tag new addresses and name the signature', () => {
  const { redirected } = contract('action-prepare-mail');
  const lines = confirmLines(redirected.review);
  assert.ok(lines.includes(`To: ${redirected.review.recipients[0].emailAddress.address} (new)`));
  assert.ok(lines.includes(`Subject: ${redirected.review.title}`));
  assert.ok(lines.includes('Signature: none — Connect sends your text as written'));
  assert.ok(!lines.some(l => l.startsWith('Cc:')));
});

test('the send key needs the user’s touch on this box, no repeat and nothing open', () => {
  const base = { touchedKey: 'k', key: 'k', repeat: false, blocked: false, primaryKind: 'send' };
  assert.equal(sendKeyAllowed(base), true);
  assert.equal(sendKeyAllowed({ ...base, touchedKey: 'other' }), false);
  assert.equal(sendKeyAllowed({ ...base, repeat: true }), false);
  assert.equal(sendKeyAllowed({ ...base, blocked: true }), false);
  assert.equal(sendKeyAllowed({ ...base, primaryKind: 'copy' }), false);
  assert.equal(sendKeyAllowed({ ...base, primaryKind: 'done' }), false);
});
