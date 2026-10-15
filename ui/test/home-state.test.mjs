import { test } from 'node:test';
import assert from 'node:assert/strict';
import { deriveHome, HOME_ITEMS, signInAction, autoHealthCheck, signedInDetail, connectionFromStatus } from '../home-state.js';
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
  assert.deepEqual(s.cards.map((c) => `${c.id} ${c.badge.text}`), ['profile active', 'health 2 of 3', 'agents 1 of 2', 'connections checking']);
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
  // The CLI draws the bar as U+2502; an ASCII bar is accepted too.
  const s = deriveHome({ config: valid, auth: { state: 'signed_in', detail: 'Auth Status │ ✓ Authenticated (expires in 22h 9m)' }, agents, health: healthy });
  assert.equal(s.items[0].subtitle, 'Authenticated (expires in 22h 9m)');
  assert.equal(deriveHome({ config: valid, auth: { state: 'signed_in', detail: 'Auth Status | ✓ Authenticated' } }).items[0].subtitle, 'Authenticated');
  assert.equal(deriveHome({ config: valid, auth: { state: 'signed_in', detail: '' } }).items[0].subtitle, 'Signed in');
});

// EPMCDME-15296: the identity bar needs this same cleaning function the
// checklist already uses, so it must be importable directly.
test('signedInDetail is exported for reuse outside deriveHome', () => {
  assert.equal(signedInDetail('Auth Status │ ✓ Authenticated (expires in 23h 51m)'), 'Authenticated (expires in 23h 51m)');
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
  assert.equal(failed.items[2].subtitle, 'Could not read the tool list');
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

// Once setup has finished on this machine, Home stays on its cards. Health is
// read fresh each time the app opens, so without this a user who finished
// setup yesterday was back on the checklist, and a returning user must not see a locked sidebar, every
// morning until they ran the check again.
test('after setup has finished once, Home opens on the cards before any read comes back', () => {
  const s = deriveHome({ config: null, auth: null, agents: undefined, health: null, onboarded: true });
  assert.equal(s.done, true);
  assert.equal(s.unlocked, true);
});

test('after setup has finished once, an unchecked health or a missing agent does not bring the checklist back', () => {
  const builtinOnly = [{ name: 'CodeMie Code', command: 'codemie-code', installed: true, version: '0.0.47', description: '' }];
  const s = deriveHome({ config: valid, auth: signedIn, agents: builtinOnly, health: null, onboarded: true });
  assert.equal(s.done, true);
});

// The checklist's Sign in button is the only one Home has until the
// broken-profile panel lands (EPMCDME-14658), so a lapsed sign-in still shows
// it. The sidebar stays open all the same.
test('after setup has finished once, a lapsed sign-in shows the checklist again but keeps the sidebar open', () => {
  const s = deriveHome({ config: valid, auth: { state: 'not_signed_in' }, agents, health: null, onboarded: true });
  assert.equal(s.done, false);
  assert.equal(s.unlocked, true);
});

test('before setup has ever finished, the sidebar unlocks once sign-in and model are set, whatever tools and health show', () => {
  const failing = { rows: [{ status: 'fail' }], summary: { passing: 0, total: 1 } };
  assert.equal(deriveHome({ config: valid, auth: signedIn, agents, health: null }).unlocked, true);
  assert.equal(deriveHome({ config: valid, auth: signedIn, agents, health: null }).done, false);
  assert.equal(deriveHome({ config: valid, auth: signedIn, agents, health: healthy }).unlocked, true);
  assert.equal(deriveHome({ config: valid, auth: signedIn, agents, health: failing }).unlocked, true);
  assert.equal(deriveHome({ config: valid, auth: signedIn, agents, health: null, healthFailed: true }).unlocked, true);
  assert.equal(deriveHome({ config: valid, auth: signedIn, agents: [], health: null }).unlocked, true);
  assert.equal(deriveHome({ config: valid, auth: { state: 'unknown' }, agents, health: null }).unlocked, true);
});

test('before setup has ever finished, the sidebar stays locked without sign-in or a model', () => {
  assert.equal(deriveHome({ config: valid, auth: null, agents, health: healthy }).unlocked, false);
  assert.equal(deriveHome({ config: valid, auth: { state: 'not_signed_in' }, agents, health: healthy }).unlocked, false);
  assert.equal(deriveHome({ config: { state: 'no-configuration' }, auth: signedIn, agents, health: healthy }).unlocked, false);
  assert.equal(deriveHome({ config: { state: 'broken', profile: 'old', model: '' }, auth: signedIn, agents, health: healthy }).unlocked, false);
});

// A returning user now sees the cards before the auth read has come back, so
// the Profile card must not claim they are signed out in the meantime.
test('the Profile card does not say "not signed in" before the auth read comes back', () => {
  const s = deriveHome({ config: valid, auth: null, agents: undefined, health: null, onboarded: true });
  const profile = s.cards.find((c) => c.id === 'profile');
  assert.notEqual(profile.badge.text, 'not signed in');
  assert.equal(profile.badge.tone, 'muted');
});

// `codemie profile login` needs a profile to know which CodeMie to open; with
// none it refuses (measured: "No AI/Run CodeMie URL configured"). Guided setup
// signs the user in in the browser as one of its own steps, so that is where
// Sign in goes until there is a profile to sign in to.
test('Sign in opens guided setup when there is no profile, and signs in when there is', () => {
  assert.equal(signInAction({ config: { state: 'no-configuration' }, auth: { state: 'no_profile' } }), 'setup');
  assert.equal(signInAction({ config: null, auth: { state: 'no_profile' } }), 'setup');
  assert.equal(signInAction({ config: valid, auth: { state: 'not_signed_in' } }), 'login');
  assert.equal(signInAction({ config: { state: 'broken', profile: 'x' }, auth: { state: 'not_signed_in' } }), 'login');
});

// Finishing setup returned the user to a checklist that just sat there, the
// last step waiting on a click nothing pointed at. Once the steps before it
// are done, the health check runs by itself; while it runs the step says so.
test('the health check starts by itself once the steps before it are done', () => {
  const ready = deriveHome({ config: valid, auth: signedIn, agents, health: null });
  assert.equal(autoHealthCheck(ready), true);
  const notReady = deriveHome({ config: valid, auth: { state: 'not_signed_in' }, agents, health: null });
  assert.equal(autoHealthCheck(notReady), false);
  const alreadyChecked = deriveHome({ config: valid, auth: signedIn, agents, health: healthy });
  assert.equal(autoHealthCheck(alreadyChecked), false);
  const running = deriveHome({ config: valid, auth: signedIn, agents, health: null, healthRunning: true });
  assert.equal(autoHealthCheck(running), false);
});

// The result is not kept between launches, so after a restart the status cards
// run the check themselves instead of saying "unknown" (EPMCDME-15388).
test('on the status cards the health check starts by itself when it has not run this session', () => {
  const cards = deriveHome({ config: valid, auth: signedIn, agents, health: null, onboarded: true });
  assert.equal(cards.done, true);
  assert.equal(autoHealthCheck(cards), true);
  const signedOut = deriveHome({ config: valid, auth: { state: 'not_signed_in' }, agents, health: null, onboarded: true });
  assert.equal(signedOut.done, false, 'a lapsed sign-in brings the checklist back');
  assert.equal(autoHealthCheck(signedOut), false, 'and the checklist waits for sign-in, as before');
  assert.equal(autoHealthCheck(deriveHome({ config: valid, auth: signedIn, agents, health: healthy, onboarded: true })), false);
  assert.equal(autoHealthCheck(deriveHome({ config: valid, auth: signedIn, agents, health: null, healthRunning: true, onboarded: true })), false);
  assert.equal(autoHealthCheck(deriveHome({ config: valid, auth: signedIn, agents, health: null, healthFailed: true, onboarded: true })), false);
});

// At launch the sign-in status is not read yet, so a returning user briefly
// counts as done. Starting the check then left a result on the checklist a
// lapsed sign-in brought back, before its earlier steps were done.
test('on the status cards the check waits until the sign-in status is known', () => {
  const booting = deriveHome({ config: valid, agents, health: null, onboarded: true });
  assert.equal(booting.done, true);
  assert.equal(autoHealthCheck(booting), false);
  assert.equal(autoHealthCheck(deriveHome({ config: valid, auth: signedIn, agents, health: null, onboarded: true })), true);
});

test('the Health card says checking while the check runs, not unknown', () => {
  const card = deriveHome({ config: valid, auth: signedIn, agents, health: null, healthRunning: true, onboarded: true }).cards.find((c) => c.id === 'health');
  assert.equal(card.badge.text, 'checking');
  assert.equal(card.line, 'Checking…');
});

// A check that could not finish must not leave the step on "Not checked yet"
// with nothing to click: the row's Open Health is the way to the error.
test('a health check that could not finish is an error on its step, and does not start again', () => {
  const s = deriveHome({ config: valid, auth: signedIn, agents, health: null, healthFailed: true });
  const h = s.items.find((i) => i.id === 'health');
  assert.equal(h.status, StepStatus.ERROR);
  assert.equal(h.subtitle, 'The check did not finish');
  assert.equal(autoHealthCheck(s), false);
});

test('a running health check shows on its step', () => {
  const s = deriveHome({ config: valid, auth: signedIn, agents, health: null, healthRunning: true });
  const h = s.items.find((i) => i.id === 'health');
  assert.equal(h.status, StepStatus.ACTIVE);
  assert.equal(h.subtitle, 'Checking…');
});

// A bare list of names under a ticked step did not say why it was ticked.
test('a ticked "Install an agent" says the agents are already installed', () => {
  const two = [
    { name: 'Claude Code', command: 'claude', installed: true },
    { name: 'OpenCode CLI', command: 'opencode', installed: true },
  ];
  const s = deriveHome({ config: valid, auth: signedIn, agents: two, health: null });
  assert.equal(s.items[2].subtitle, 'Already installed: Claude Code · OpenCode CLI');
});

// Measured at launch: until the sign-in read came back, item 1 showed its Sign
// in button to a user who was signed in all along.
test('before the sign-in read comes back, item 1 says it is checking', () => {
  const s = deriveHome({ config: valid, auth: null, agents, health: null });
  assert.equal(s.items[0].status, StepStatus.ACTIVE);
  assert.equal(s.items[0].subtitle, 'Checking…');
});

// 01-home.png draws a fourth card: Connections, read from the CLI's own proxy
// status, never assumed.
test('the Connections card says whether Claude Desktop is connected, as the proxy status reports', () => {
  const card = (connection) => deriveHome({ connection }).cards.find((c) => c.id === 'connections');
  assert.deepEqual(card({ running: true }).badge, { text: '1 connected', tone: 'good' });
  assert.equal(card({ running: true }).line, 'Claude Desktop');
  assert.deepEqual(card({ running: false }).badge, { text: 'not connected', tone: 'muted' });
  assert.deepEqual(card(null).badge, { text: 'unknown', tone: 'muted' });
  assert.equal(card(null).line, 'Could not read the connection');
  assert.deepEqual(card(undefined).badge, { text: 'checking', tone: 'muted' });
});

// Measured with the bundled CLI 0.15.2: a running proxy reports "healthy", never
// "running", so a check for "running" left the card on "not connected" for good.
test('the proxy status the CLI really prints maps to the Connections card', () => {
  const card = (stdout) => deriveHome({ connection: connectionFromStatus(stdout) }).cards.find((c) => c.id === 'connections');
  const running = '{\n  "status": "healthy",\n  "url": "http://127.0.0.1:4001",\n  "port": 4001\n}';
  assert.deepEqual(card(running).badge, { text: '1 connected', tone: 'good' });
  assert.deepEqual(card('Migrating…\n' + running).badge, { text: '1 connected', tone: 'good' });
  assert.deepEqual(card('{ "status": "unhealthy", "port": 4001 }').badge, { text: 'not responding', tone: 'warn' });
  assert.deepEqual(card('{\n  "status": "stopped"\n}').badge, { text: 'not connected', tone: 'muted' });
  assert.deepEqual(card('').badge, { text: 'unknown', tone: 'muted' });
});
