// The guided-setup sheet, the Today card and first launch, driven through the controller with
// the service and setup session faked.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fakeService, controllerHarness } from './codemie-fakes.mjs';

const el = (data = {}, extra = {}) => ({ dataset: data, closest: () => null, ...extra });

function freshService(over = {}) {
  const service = fakeService(over);
  Object.assign(service.state, { profiles: [], config: { state: 'no-configuration', active: null, account: null } });
  service.state.agents = service.state.agents.slice(0, 1);
  return service;
}

function sessionFake() {
  const runs = [];
  let active = false;
  return {
    runs,
    running: () => active,
    cancel: async () => { active = false; return true; },
    run: async (plan, ui) => { runs.push({ plan, ui }); active = true; return new Promise(() => {}); },
  };
}

async function openAtSignin(h) {
  await h.c.handle('cm-setup-open', el());
  await h.c.handle('cm-sheet-go', el({ step: 'signin' }));
}

test('org_address_rejected_before_anything_runs', async () => {
  const checked = [];
  const service = freshService({ checkUrl: async (url) => { checked.push(url); return { verdict: 'codemie' }; } });
  const session = sessionFake();
  const h = controllerHarness({ service, session });
  await openAtSignin(h);
  await h.c.change(el({ key: 'choice' }, { value: 'org', type: 'radio', dataset: { action: 'cm-draft-radio', key: 'choice' } }));
  h.c.input({ dataset: { draft: 'orgUrl' }, value: 'http://codemie.acme.com', closest: () => ({}) });
  await h.c.handle('cm-signin-start', el());
  const html = h.c.sheet();
  assert.match(html, /The address must start with https:\/\//);
  assert.deepEqual(checked, []);
  assert.equal(session.runs.length, 0);
});

test('not_codemie_stops_before_setup', async () => {
  const service = freshService({ checkUrl: async () => ({ verdict: 'not_codemie', status: 404, detail: 'GET … → 404' }) });
  const session = sessionFake();
  const h = controllerHarness({ service, session });
  await openAtSignin(h);
  await h.c.change({ type: 'radio', value: 'org', dataset: { action: 'cm-draft-radio', key: 'choice' }, closest: () => null });
  h.c.input({ dataset: { draft: 'orgUrl' }, value: 'www.example.com', closest: () => ({}) });
  await h.c.handle('cm-signin-start', el());
  assert.match(h.c.sheet(), /www\.example\.com is not a CodeMie address/);
  assert.equal(session.runs.length, 0);
});

test('org_address_check_passes_into_setup', async () => {
  const service = freshService({ checkUrl: async () => ({ verdict: 'codemie', status: 302, detail: '' }) });
  const session = sessionFake();
  const h = controllerHarness({ service, session });
  await openAtSignin(h);
  await h.c.change({ type: 'radio', value: 'org', dataset: { action: 'cm-draft-radio', key: 'choice' }, closest: () => null });
  h.c.input({ dataset: { draft: 'orgUrl' }, value: ' https://CodeMie.Acme-Bank.com/#/assistants ', closest: () => ({}) });
  await h.c.handle('cm-signin-start', el());
  assert.equal(session.runs.length, 1);
  assert.equal(session.runs[0].plan.url, 'https://codemie.acme-bank.com');
  assert.equal(session.runs[0].plan.provider, 'ai-run-sso');
});

test('org_default_is_first_choice', async () => {
  const service = freshService();
  service.state.org = { codemieUrl: 'https://codemie.acme-bank.com', organizationName: 'Acme Bank' };
  const h = controllerHarness({ service, session: sessionFake() });
  await openAtSignin(h);
  const html = h.c.sheet();
  const first = html.split('class="cm-choice-wrap"')[1];
  assert.match(first, /Acme Bank CodeMie/);
  assert.match(first, /Your organization/);
  assert.match(first, /codemie\.acme-bank\.com/);
});

test('project_step_shows_cli_options', async () => {
  const service = freshService();
  const session = sessionFake();
  const h = controllerHarness({ service, session });
  await openAtSignin(h);
  await h.c.handle('cm-signin-start', el());
  const { ui } = session.runs[0];
  const picked = ui.choose({ id: 'codemieProject', message: 'Select your project:', options: ['EPM-CDME', 'taylor.morgan'], recommended: null });
  const html = h.c.sheet();
  assert.equal(html.match(/name="cm-pick"/g)?.length, 2);
  assert.match(html, /value="0" [^>]*checked/);
  assert.match(html, /EPM-CDME/);
  await h.c.change({ type: 'radio', value: '1', dataset: { action: 'cm-pick' }, closest: () => null });
  await h.c.handle('cm-pick-continue', el());
  assert.equal(await picked, 1);
});

test('model_step_marks_the_cli_recommendation', async () => {
  const session = sessionFake();
  const h = controllerHarness({ service: freshService(), session });
  await openAtSignin(h);
  await h.c.handle('cm-signin-start', el());
  session.runs[0].ui.choose({ id: 'model', message: 'Choose a model', options: ['gpt-5', 'claude-sonnet-4-5 ⭐'], recommended: 1 });
  const html = h.c.sheet();
  assert.match(html, /value="1" [^>]*checked/);
  assert.match(html, /Recommended/);
  assert.doesNotMatch(html, /⭐/);
});

test('today_card_snoozes_for_a_day', async () => {
  const now = Date.UTC(2026, 10, 17, 9);
  const h = controllerHarness({ service: freshService(), session: sessionFake() });
  assert.match(h.c.todayCard(now), /Set up your AI coding tools/);
  await h.c.handle('cm-setup-snooze', el());
  const until = Number(h.prefs.get('codemie.setup.snoozedUntil'));
  assert.ok(until >= Date.now() + 23 * 3600e3);
  assert.equal(h.c.todayCard(Date.now()), '');
});

test('auto_open_once', async () => {
  const h = controllerHarness({ service: freshService(), session: sessionFake() });
  await h.c.boot();
  assert.match(h.c.sheet(), /cm-sheet-panel/);
  assert.equal(h.prefs.get('codemie.setup.introduced'), '1');
  const again = controllerHarness({ service: freshService(), session: sessionFake(), prefs: { 'codemie.setup.introduced': '1' } });
  await again.c.boot();
  assert.equal(again.c.sheet(), '');
});

/** A session whose run settles when the test says so (cancel rejects it, as the driver does). */
function controllableSession() {
  const runs = [];
  let active = false;
  let settle = null;
  return {
    runs,
    running: () => active,
    run: (plan, ui) => new Promise((resolve, reject) => {
      runs.push({ plan, ui });
      active = true;
      settle = { resolve: (v) => { active = false; resolve(v); }, reject: (e) => { active = false; reject(e); } };
    }),
    cancel: async () => { settle?.reject(Object.assign(new Error('cancelled'), { cancelled: true })); return true; },
    fail: (err) => settle.reject(err),
  };
}
const tick = () => new Promise((r) => setImmediate(r));

// Review finding 2: the driver reports a stopped Ollama as `ollamaDown` with its own message.
test('ollama_down_notice_is_named', async () => {
  const session = sessionFake();
  const h = controllerHarness({ service: freshService(), session });
  await openAtSignin(h);
  await h.c.handle('cm-signin-start', el());
  session.runs[0].ui.onFailure({ id: 'ollamaDown', message: 'Ollama is not running at http://localhost:11434', line: 3 });
  assert.match(h.c.sheet(), /Ollama is not running/);
  assert.doesNotMatch(h.c.sheet(), /could not check your project/);
  session.runs[0].ui.onFailure({ id: 'authTimeout', message: 'timeout of 30000ms exceeded', line: 5 });
  assert.match(h.c.sheet(), /timeout of 30000ms exceeded/);
});

// Review finding 3: the driver's screen can hold what was typed into a provider's key prompt.
test('setup_screen_never_reaches_the_page', async () => {
  const session = controllableSession();
  const h = controllerHarness({ service: freshService(), session });
  await openAtSignin(h);
  await h.c.handle('cm-signin-start', el());
  session.fail({ step: null, message: 'setup exited with code 1', raw: '? API Key: sk-live-secret\nError: 401' });
  await tick();
  const html = h.c.sheet();
  assert.match(html, /Setup did not finish/);
  assert.doesNotMatch(html, /sk-live-secret/);
});

// Review finding 4a: closing mid-run cancels setup; what the CLI already wrote must still show.
test('closing_mid_run_reloads_once_settled', async () => {
  const session = controllableSession();
  const service = freshService();
  const h = controllerHarness({ service, session });
  await openAtSignin(h);
  await h.c.handle('cm-signin-start', el());
  await h.c.handle('cm-sheet-close', el());
  await tick();
  assert.ok(service.calls.some(([name, opts]) => name === 'load' && opts?.force), 'reloads after the cancelled run');
});

// Review finding 5: Cancel while the subscription's agent installs must stop there.
test('cancel_during_subscription_install_does_not_start_setup', async () => {
  let finishInstall;
  const service = freshService({ installAgent: () => new Promise((r) => { finishInstall = r; }) });
  const session = sessionFake();
  const h = controllerHarness({ service, session });
  await openAtSignin(h);
  await h.c.change({ type: 'radio', value: 'subscription', dataset: { action: 'cm-draft-radio', key: 'choice' }, closest: () => null });
  const started = h.c.handle('cm-signin-start', el());
  await tick();
  assert.match(h.c.sheet(), /Installing Claude Code first/);
  await h.c.handle('cm-signin-cancel', el());
  finishInstall();
  await started;
  assert.equal(session.runs.length, 0);
});

test('closing_a_running_setup_cancels_it_and_says_so', async () => {
  const session = sessionFake();
  const h = controllerHarness({ service: freshService(), session });
  await openAtSignin(h);
  await h.c.handle('cm-signin-start', el());
  assert.equal(session.running(), true);
  await h.c.handle('cm-sheet-close', el());
  assert.equal(session.running(), false);
  assert.equal(h.c.sheet(), '');
  assert.match(h.toasts.at(-1)[0], /Setup paused/);
});
