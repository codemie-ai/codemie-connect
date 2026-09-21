import { test } from 'node:test';
import assert from 'node:assert/strict';
import { deriveHome, HOME_ITEMS } from '../home-state.js';
import { StepStatus } from '../models.js';

const valid = { state: 'valid', profile: 'demo7', model: 'claude-sonnet-5', project: 'epm-sdai', account: 'me@epam.com' };
const signedIn = { state: 'signed_in', detail: 'Authenticated (expires in 23h)' };
const agents = [
  { name: 'Claude Code', command: 'claude', installed: true, version: '2.1.269', description: '' },
  { name: 'Gemini CLI', command: 'gemini', installed: false, version: null, description: '' },
];
const healthy = {
  rows: [{ status: 'pass' }, { status: 'warn' }, { status: 'pass' }],
  summary: { passing: 2, total: 3 },
  checkedAt: new Date(2026, 8, 21, 11, 0),
};
const statuses = (s) => s.items.map((i) => `${i.id}:${i.status}`);

test('the four items come in the POC order', () => {
  assert.deepEqual(HOME_ITEMS.map((i) => i.id), ['sign-in', 'model', 'agent', 'health']);
  assert.deepEqual(deriveHome({}).items.map((i) => i.title), HOME_ITEMS.map((i) => i.title));
});

test('first run: nothing configured, every item pending, no cards', () => {
  const s = deriveHome({ config: { state: 'no-configuration' }, auth: { state: 'no_profile' }, agents: [], health: null });
  assert.deepEqual(statuses(s), ['sign-in:PENDING', 'model:PENDING', 'agent:PENDING', 'health:PENDING']);
  assert.equal(s.done, false);
});

test('fully configured with a passing check: everything ticks and the cards take over', () => {
  const s = deriveHome({ config: valid, auth: signedIn, agents, health: healthy });
  assert.deepEqual(statuses(s), ['sign-in:COMPLETE', 'model:COMPLETE', 'agent:COMPLETE', 'health:COMPLETE']);
  assert.equal(s.done, true);
  assert.deepEqual(s.cards.map((c) => `${c.id} ${c.badge.text}`), ['profile active', 'health 2 of 3', 'agents 1 of 2']);
});

test('unknown auth satisfies the sign-in item and is never rendered as not signed in', () => {
  const s = deriveHome({ config: valid, auth: { state: 'unknown', detail: '' }, agents, health: healthy });
  const signIn = s.items[0];
  assert.equal(signIn.status, StepStatus.COMPLETE);
  assert.equal(signIn.subtitle, 'Your provider does not report sign-in status');
  assert.equal(s.done, true);
  const profile = s.cards.find((c) => c.id === 'profile');
  assert.equal(profile.badge.text, 'active');
  assert.equal(profile.note, 'Your provider does not report sign-in status');
  assert.ok(!JSON.stringify(s).includes('not signed in'));
});

test('the signed-in subtitle keeps the CLI sentence without its "Auth Status |" prefix', () => {
  const s = deriveHome({ config: valid, auth: { state: 'signed_in', detail: 'Auth Status | ✓ Authenticated (expires in 22h 9m)' }, agents, health: healthy });
  assert.equal(s.items[0].subtitle, 'Authenticated (expires in 22h 9m)');
  assert.equal(deriveHome({ config: valid, auth: { state: 'signed_in', detail: '' } }).items[0].subtitle, 'Signed in');
});

test('not signed in keeps item 1 open and the profile card says so', () => {
  const s = deriveHome({ config: valid, auth: { state: 'not_signed_in', detail: '' }, agents, health: healthy });
  assert.equal(s.items[0].status, StepStatus.PENDING);
  assert.equal(s.done, false);
  assert.equal(s.cards[0].badge.text, 'not signed in');
});

test('a warning in the health check still counts as passed; a failing row does not', () => {
  const warned = deriveHome({ config: valid, auth: signedIn, agents, health: healthy });
  assert.equal(warned.items[3].status, StepStatus.COMPLETE);
  assert.match(warned.items[3].subtitle, /^2 of 3 fine · checked at /);
  const failing = deriveHome({
    config: valid,
    auth: signedIn,
    agents,
    health: { rows: [{ status: 'fail' }, { status: 'pass' }], summary: { passing: 1, total: 2 }, checkedAt: null },
  });
  assert.equal(failing.items[3].status, StepStatus.WARNING);
  assert.equal(failing.items[3].subtitle, '1 problem to fix');
  assert.equal(failing.done, false);
});

test('sources that are not ready render as unknown, never as a made-up value', () => {
  const s = deriveHome({ config: valid, auth: signedIn, agents: undefined, health: null });
  assert.equal(s.items[2].subtitle, 'Checking…');
  assert.equal(s.items[3].subtitle, 'Not checked yet');
  assert.equal(s.done, false);
  const failed = deriveHome({ config: valid, auth: signedIn, agents: null, health: null });
  assert.equal(failed.items[2].status, StepStatus.PENDING);
  assert.equal(failed.items[2].subtitle, 'Could not read the agent list');
  assert.deepEqual(failed.cards.find((c) => c.id === 'agents').badge, { text: 'unknown', tone: 'muted' });
  assert.deepEqual(failed.cards.find((c) => c.id === 'health').badge, { text: 'unknown', tone: 'muted' });
});

test('no agent installed keeps item 3 open with the count the CLI gave', () => {
  const none = agents.map((a) => ({ ...a, installed: false }));
  const s = deriveHome({ config: valid, auth: signedIn, agents: none, health: healthy });
  assert.equal(s.items[2].status, StepStatus.PENDING);
  assert.equal(s.items[2].subtitle, '2 available');
  assert.equal(s.cards.find((c) => c.id === 'agents').line, 'None installed yet');
});

test('a broken profile is a warning on item 2, not an error and not first run', () => {
  const s = deriveHome({ config: { state: 'broken', profile: 'old', model: '' }, auth: { state: 'not_signed_in' }, agents, health: null });
  assert.equal(s.items[1].status, StepStatus.WARNING);
  assert.equal(s.items[1].subtitle, 'Your profile is no longer working');
  assert.equal(s.cards[0].badge.text, 'needs attention');
});
