// Fixture parity: the mail prepare contract fixture only tags a redirected Reply-To as new.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const contract = name => JSON.parse(readFileSync(new URL(`./fixtures/contract/${name}.json`, import.meta.url), 'utf8'));

test('the mail prepare fixture tags only a redirected Reply-To', () => {
  const { normal, redirected } = contract('action-prepare-mail');
  assert.deepStrictEqual(normal.review.newRecipients, []);
  assert.equal(redirected.review.newRecipients.length, 1);
  const addresses = redirected.review.recipients.map(r => r.emailAddress.address);
  for (const address of redirected.review.newRecipients) assert.ok(addresses.includes(address));
});
