import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readOnboarded, rememberOnboarded, ONBOARDED_KEY } from '../onboarding-memory.js';

function memoryStorage() {
  const m = new Map();
  return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), m };
}

test('nothing remembered reads as not onboarded', () => {
  assert.equal(readOnboarded(memoryStorage()), false);
});

test('a finished setup is remembered and read back', () => {
  const store = memoryStorage();
  rememberOnboarded(store);
  assert.equal(store.m.get(ONBOARDED_KEY), '1');
  assert.equal(readOnboarded(store), true);
});

// localStorage can be missing or throw (private mode, cleared site data); the
// app must then behave as a first run rather than fail to draw Home.
test('storage that throws or is missing reads as not onboarded and never throws', () => {
  const broken = { getItem() { throw new Error('denied'); }, setItem() { throw new Error('denied'); } };
  assert.equal(readOnboarded(broken), false);
  assert.doesNotThrow(() => rememberOnboarded(broken));
  assert.equal(readOnboarded(undefined), false);
  assert.doesNotThrow(() => rememberOnboarded(undefined));
});
