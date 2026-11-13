// ui/test/setup-view.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// Reads a captured CLI screen (an array of lines) straight from
// ui/test/fixtures/setup/<id>.json -- the same fixtures ui/setup-driver.test.mjs
// and ui/setup-parse.test.mjs use. EPMCDME-14588's failure-classification
// tests must never hand-write screen text.
function fixtureLines(id) {
  return JSON.parse(readFileSync(fileURLToPath(new URL(`fixtures/setup/${id}.json`, import.meta.url)), 'utf8'));
}

// ── Minimal DOM stub ─────────────────────────────────────────────────────────
// Adapted from ui/test/steps-ui.test.mjs's hand-rolled stub (makeEl/
// findByClass), extended with a `children` getter (setup-view.js locates a
// row by walking container.children and matching dataset.id -- the real
// DOM's `.children` name, so setup-view.js's lookup works unmodified against
// a real browser DOM too) and a readable `onclick` (real DOM element.onclick
// is both a setter and a getter; this stub only had the setter, which is
// enough for steps-ui.js's own tests since none of them ever click anything,
// but this file's tests need to invoke the handler setup-view.js installs).
function makeEl(tag) {
  const el = {
    _tag: tag,
    _children: [],
    _listeners: {},
    className: '',
    dataset: {},
    textContent: '',
    style: {},
    type: '',
    value: '',
    checked: false,
    name: '',
    get children() { return el._children; },
    get nextSibling() {
      const p = el._parent;
      if (!p) return null;
      const i = p._children.indexOf(el);
      return i >= 0 ? (p._children[i + 1] ?? null) : null;
    },
    get parentNode() { return el._parent ?? null; },
    _attrs: {},
    setAttribute(k, v) { el._attrs[k] = String(v); },
    getAttribute(k) { return k in el._attrs ? el._attrs[k] : null; },
    querySelector(sel) {
      const cls = sel.replace(/^\./, '');
      return findByClass(el, cls);
    },
    appendChild(child) {
      child._parent = el;
      el._children.push(child);
      return child;
    },
    insertBefore(newEl, ref) {
      newEl._parent = el;
      const i = el._children.indexOf(ref);
      if (i >= 0) el._children.splice(i, 0, newEl);
      else el._children.push(newEl);
      return newEl;
    },
    classList: {
      _set: new Set(),
      toggle(cls, force) {
        if (force === true) el.classList._set.add(cls);
        else if (force === false) el.classList._set.delete(cls);
        else if (el.classList._set.has(cls)) el.classList._set.delete(cls);
        else el.classList._set.add(cls);
      },
      add(cls) { el.classList._set.add(cls); },
      remove(cls) { el.classList._set.delete(cls); },
      contains(cls) { return el.classList._set.has(cls); },
    },
    remove() {
      const p = el._parent;
      if (p) p._children = p._children.filter((c) => c !== el);
    },
    replaceChildren() { el._children = []; },
    addEventListener(evt, fn) { el._listeners[evt] = fn; },
    set onclick(fn) { el._listeners.click = fn; },
    get onclick() { return el._listeners.click; },
  };
  Object.defineProperty(el, 'innerHTML', {
    get() { return el._innerHTML ?? ''; },
    set(html) {
      el._innerHTML = html;
      el._children = [];
      const re = /<(?:div|button)[^>]+class="([^"]+)"/g;
      let m;
      while ((m = re.exec(html)) !== null) {
        for (const cls of m[1].split(/\s+/)) {
          const child = makeEl('div');
          child._cls = cls;
          child._parent = el;
          el._children.push(child);
        }
      }
    },
  });
  return el;
}

// Concatenates every textContent in el and its descendants -- used to check
// a notice body (a plain container div wrapping a summary + a <pre>) really
// carries the CLI's own reason text, without depending on which child it's in.
function allText(el) {
  let out = el.textContent || '';
  for (const c of el._children || []) out += allText(c);
  return out;
}

function findByClass(root, cls) {
  for (const c of root._children) {
    if (c._cls === cls || c.className === cls || (c.className ?? '').split(' ').includes(cls)) return c;
    const found = findByClass(c, cls);
    if (found) return found;
  }
  return null;
}

// Recursively collects every descendant (not just direct children) matching
// predicate. Needed because Task 4's option-card markup nests each radio one
// level deeper than the old flat `.prompt-control > input[radio]` shape that
// earlier tests' `._children.filter(...)` relied on.
function collectAll(el, predicate) {
  const out = [];
  for (const c of el._children) {
    if (predicate(c)) out.push(c);
    out.push(...collectAll(c, predicate));
  }
  return out;
}

// EPMCDME-14588's setup-view.js falls back to a real dynamic import of
// ./notice.js whenever a test doesn't inject deps.showNotice -- most of the
// pre-existing tests below don't. getElementById here is what lets that
// fallback module load without throwing (notice.js reads these ids at
// module scope); nothing in this file inspects the resulting stub elements
// directly -- only the tests that inject their own fake showNotice do.
const noticeStubEls = {};
for (const id of ['notice-overlay', 'notice-title', 'notice-message', 'notice-primary', 'notice-secondary', 'notice-close']) {
  noticeStubEls[id] = makeEl('div');
}
globalThis.document = {
  createElement: (tag) => makeEl(tag),
  getElementById: (id) => noticeStubEls[id] ?? makeEl('div'),
};

// steps-ui.js drives its spinners with setInterval. A test that fails mid-flow
// leaves its fake driver waiting forever and that interval alive, which keeps
// the process from exiting and hangs the whole runner instead of reporting
// the failure. Hand out unref'd timers so a live spinner never pins the loop.
const realSetInterval = globalThis.setInterval;
globalThis.setInterval = (fn, ms, ...rest) => {
  const t = realSetInterval(fn, ms, ...rest);
  if (t && typeof t.unref === 'function') t.unref();
  return t;
};

// ── Import module under test (after stub is in place) ───────────────────────
const { createSetupView, deriveRowTitle, stripHint, renderOptionCards, isSecretPrompt, maskSecret } = await import('../setup-view.js');

function findRowById(container, id) {
  for (const child of container.children) {
    if (child.dataset.id === id) return child;
  }
  return null;
}

// The config reader as the happy path sees it: the profile the driver reported
// is the active one. Every existing round-trip test resolves { profileName:
// "default" }, so this one fake serves them all.
const okConfig = async () => ({ state: "valid", profile: "default", model: "", project: "", account: null });

// Spinner glyphs steps-ui.js cycles through while a row is ACTIVE with a spinner.
const SPINNER_GLYPHS = "⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏";
const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));
const findControl = (row) => row.querySelector(".prompt-control");
const clickContinue = (row) => findControl(row)._children.find((c) => c.className === "prompt-submit").onclick();

// ── Tests ────────────────────────────────────────────────────────────────────

test('start() inserts a collapsed/COMPLETE storage row before startSetup runs', async () => {
  const container = makeEl('div');
  let sawStorageRowBeforeStart = false;

  const fakeStartSetup = async ({ onPrompt: _onPrompt, onLog: _onLog } = {}) => {
    const row = findRowById(container, 'storage');
    sawStorageRowBeforeStart = !!row && row.querySelector('.step-icon').textContent === '✓';
    return { profileName: 'default' };
  };

  const runs = [];
  const view = createSetupView(container, { startSetup: fakeStartSetup, readConfig: okConfig, onRun: (p) => runs.push(p) });
  await view.start();
  // The renderer's bookkeeping hangs off onRun, so a retry must report too.
  await view.start();
  assert.equal(runs.length, 2, 'onRun hears about every run, not only the first');

  assert.ok(sawStorageRowBeforeStart, 'storage row exists and is COMPLETE before startSetup is invoked');
  const storageRow = findRowById(container, 'storage');
  assert.ok(storageRow, 'storage row is present');
  assert.equal(storageRow.querySelector('.step-sub').textContent, 'This computer');
});

test('the confirm-kind activate prompt never renders a row', async () => {
  const container = makeEl('div');
  const fakeStartSetup = async ({ onPrompt }) => {
    await onPrompt({ kind: 'confirm', id: 'activate', message: 'Activate this profile now?' });
    return { profileName: 'default' };
  };

  const view = createSetupView(container, { startSetup: fakeStartSetup, readConfig: okConfig });
  await view.start();

  assert.equal(findRowById(container, 'activate-1'), null, 'no activate row ever appears');
});

// The CLI's own first question when profiles exist. The driver passes it on
// without Cancel; the answer is the user's, as in a terminal.
test('add or update: the question is a step, and updating asks which profile and says it was updated', async () => {
  const container = makeEl('div');
  const asked = [];
  const fakeStartSetup = async ({ onPrompt }) => {
    const pending = onPrompt({ kind: 'list', id: 'gate', message: 'What would you like to do?', options: ['Add a new profile', 'Update an existing profile'] });
    await tick();
    const gateRow = findRowById(container, 'gate-1');
    asked.push(gateRow.querySelector('.step-title').textContent);
    // Pick the second card, then Continue.
    const radios = [];
    (function walk(n) { if ((n.className || '').startsWith('setup-option-card')) radios.push(n); (n._children || []).forEach(walk); })(gateRow);
    radios[1].onclick();
    clickContinue(gateRow);
    const gateAnswer = await pending;
    asked.push(gateAnswer);
    const pick = onPrompt({ kind: 'list', id: 'updateProfile', message: 'Select profile to update:', options: ['Mert', 'MertPersonal', 'codemie'] });
    await tick();
    const pickRow = findRowById(container, 'updateProfile-1');
    asked.push(pickRow.querySelector('.step-title').textContent);
    const radios2 = [];
    (function walk(n) { if ((n.className || '').startsWith('setup-option-card')) radios2.push(n); (n._children || []).forEach(walk); })(pickRow);
    radios2[2].onclick();
    clickContinue(pickRow);
    asked.push(await pick);
    return { profileName: 'codemie', updated: true };
  };
  // Updating does not switch profiles: the active one stays what it was.
  const readConfig = async () => ({ state: 'valid', profile: 'Mert', model: '', project: '', account: null });

  const view = createSetupView(container, { startSetup: fakeStartSetup, readConfig });
  const result = await view.start();

  assert.deepEqual(asked, ['Add a new profile or update one?', 1, 'Which profile should be updated?', 2]);
  assert.equal(findRowById(container, 'gate-1').querySelector('.step-sub').textContent, 'Update an existing profile');
  assert.equal(findRowById(container, 'updateProfile-1').querySelector('.step-sub').textContent, 'codemie');
  assert.equal(result.ok, true);
  const status = container._children.find((c) => c.className === 'setup-view-status');
  assert.equal(status.textContent, 'Setup complete. codemie is updated.');
});

test('an update that leaves the configuration unreadable is not reported as done', async () => {
  const container = makeEl('div');
  const fakeStartSetup = async () => ({ profileName: 'codemie', updated: true });
  const readConfig = async () => ({ state: 'broken', profile: null, model: '', project: '', account: null });
  const view = createSetupView(container, { startSetup: fakeStartSetup, readConfig });
  const result = await view.start();
  assert.equal(result.ok, false);
});

test('list prompt: renders radio options, resolves with selected index, marks row COMPLETE', async () => {
  const container = makeEl('div');
  let resolvedAnswer;
  const fakeStartSetup = async ({ onPrompt }) => {
    resolvedAnswer = await onPrompt({
      kind: 'list',
      id: 'provider',
      message: 'Pick a provider',
      options: ['OpenAI', 'Bedrock', 'Anthropic'],
    });
    return { profileName: 'default' };
  };

  const view = createSetupView(container, { startSetup: fakeStartSetup, readConfig: okConfig });
  const startPromise = view.start();

  // Give onPrompt's synchronous body a tick to run and insert the row.
  await Promise.resolve();
  const row = findRowById(container, 'provider-1');
  assert.ok(row, 'provider-1 row was inserted');
  assert.ok(row.classList._set.has('active'), 'row is ACTIVE while awaiting an answer');

  const control = row.querySelector('.prompt-control');
  assert.ok(control, 'a control was rendered');
  // Task 4 nests each radio one level deeper inside a `.setup-option-card`,
  // so this must search descendants, not just direct children.
  const radios = collectAll(control, (c) => c.type === 'radio');
  assert.equal(radios.length, 3, 'one radio per option');

  // A real radio group unchecks its siblings; the stub does not, so select
  // through the card click the way a user does.
  const cardEls = collectAll(control, (c) => (c.className || '').split(' ').includes('setup-option-card'));
  cardEls[1].onclick(); // select "Bedrock" (index 1)
  const submitBtn = control._children.find((c) => c.className === 'prompt-submit');
  assert.ok(submitBtn, 'submit control present');
  submitBtn.onclick();

  await startPromise;

  assert.equal(resolvedAnswer, 1, 'resolved with the selected index');
  assert.ok(!row.classList._set.has('active'), 'row is no longer ACTIVE');
  assert.equal(row.querySelector('.step-icon').textContent, '✓', 'row is COMPLETE');
  assert.equal(row.querySelector('.step-sub').textContent, 'Bedrock', 'subtitle is the human-readable choice');
});

test('input prompt: renders a text field, resolves with the typed string, marks row COMPLETE', async () => {
  const container = makeEl('div');
  let resolvedAnswer;
  const fakeStartSetup = async ({ onPrompt }) => {
    resolvedAnswer = await onPrompt({ kind: 'input', id: 'profileName', message: 'Enter a name for this profile:' });
    // The config fake reports "default" as active; the typed value is what the driver types, not what the config says.
    return { profileName: 'default' };
  };

  const view = createSetupView(container, { startSetup: fakeStartSetup, readConfig: okConfig });
  const startPromise = view.start();

  await Promise.resolve();
  const row = findRowById(container, 'profileName-1');
  assert.ok(row, 'profileName-1 row was inserted');

  const control = row.querySelector('.prompt-control');
  const input = control._children.find((c) => c.type === 'text');
  assert.ok(input, 'text input present');
  input.value = 'my-workspace';
  const submitBtn = control._children.find((c) => c.className === 'prompt-submit');
  submitBtn.onclick();

  await startPromise;

  assert.equal(resolvedAnswer, 'my-workspace', 'resolved with the typed string');
  assert.equal(row.querySelector('.step-icon').textContent, '✓', 'row is COMPLETE');
  assert.equal(row.querySelector('.step-sub').textContent, 'my-workspace', 'subtitle echoes the typed value');
});

test('confirm prompt: Yes is pre-selected, resolves true, and the row waits on the CLI install instead of completing', async () => {
  const container = makeEl('div');
  let resolvedAnswer;
  let capturedLog;
  let release;
  const gate = new Promise((r) => { release = r; });
  const fakeStartSetup = async ({ onPrompt, onLog }) => {
    capturedLog = onLog;
    resolvedAnswer = await onPrompt({ kind: 'confirm', id: 'installClaude', message: 'Would you like to install Claude Code now?' });
    await gate;
    return { profileName: 'default' };
  };

  const view = createSetupView(container, { startSetup: fakeStartSetup, readConfig: okConfig });
  const startPromise = view.start();

  await Promise.resolve();
  const row = findRowById(container, 'installClaude-1');
  assert.ok(row, 'installClaude-1 row was inserted');
  assert.equal(row.querySelector('.step-title').textContent, 'Would you like to install Claude Code now?', 'heading is the CLI question as asked');

  const control = findControl(row);
  const radios = collectAll(control, (c) => c.type === 'radio');
  assert.equal(radios.length, 2, 'Yes/No radios present');
  assert.ok(radios[0].checked, 'Yes is pre-selected');
  const yesNoCards = collectAll(control, (c) => (c.className || '').split(' ').includes('setup-option-card'));
  assert.equal(yesNoCards.length, 2, 'Yes and No render as cards');
  assert.equal(yesNoCards[0].querySelector('.setup-option-title').textContent, 'Yes');
  assert.ok(yesNoCards[0].classList._set.has('selected'), 'the Yes card starts selected');

  // Accept the default (Yes) without touching anything.
  clickContinue(row);
  await Promise.resolve();

  assert.equal(resolvedAnswer, true, 'resolved with boolean true for the pre-selected Yes');
  assert.equal(findControl(row), null, 'control is removed once answered');
  assert.ok(row.classList._set.has('active'), 'row stays ACTIVE while the CLI installs');
  assert.ok(!row.classList._set.has('collapsed'), 'row is not collapsed yet');
  assert.equal(row.querySelector('.step-sub').textContent, 'Installing…');
  assert.equal(container._children.filter((c) => c.dataset && /^working-/.test(c.dataset.id || '')).length, 0,
    'no transient Working row while the install row carries its own spinner');
  await tick(120);
  assert.ok(SPINNER_GLYPHS.includes(row.querySelector('.step-icon').textContent), 'install row shows a spinner glyph');

  // The CLI's own success line, colour-coded and split across two chunks.
  capturedLog('\x1b[32m✔ Claude Code v1');
  capturedLog('.2.3 installed successfully\x1b[39m\n');
  assert.equal(row.querySelector('.step-icon').textContent, '✓', 'row is COMPLETE once the CLI reports success');
  assert.equal(row.querySelector('.step-sub').textContent, 'v1.2.3', 'subtitle is the installed version');
  assert.equal(row.querySelector('.step-title').textContent, 'Claude Code', 'collapsed label from PROMPT_COPY');
  assert.ok(row.classList._set.has('collapsed'));

  release();
  const outcome = await startPromise;
  assert.deepEqual(outcome, { ok: true, profileName: 'default' });
  assert.equal(row.querySelector('.step-icon').textContent, '✓', 'settling does not disturb a confirmed install');
});

test('confirm prompt: choosing No resolves false and collapses to "Claude Code — Skipped"', async () => {
  const container = makeEl('div');
  let resolvedAnswer;
  const fakeStartSetup = async ({ onPrompt }) => {
    resolvedAnswer = await onPrompt({ kind: 'confirm', id: 'installClaude', message: 'Would you like to install Claude Code now?' });
    return { profileName: 'default' };
  };

  const view = createSetupView(container, { startSetup: fakeStartSetup, readConfig: okConfig });
  const startPromise = view.start();

  await Promise.resolve();
  const row = findRowById(container, 'installClaude-1');
  const control = findControl(row);
  collectAll(control, (c) => (c.className || '').split(' ').includes('setup-option-card'))[1].onclick(); // pick No
  clickContinue(row);

  await startPromise;

  assert.equal(resolvedAnswer, false, 'resolved with boolean false when No is chosen');
  assert.equal(row.querySelector('.step-icon').textContent, '✓', 'row is COMPLETE immediately');
  assert.equal(row.querySelector('.step-sub').textContent, 'Skipped');
  assert.equal(row.querySelector('.step-title').textContent, 'Claude Code');
  assert.equal(findControl(row), null, 'control is removed once answered');
});

// ── deriveRowTitle / stripHint unit tests ────────────────────────────────────

test('deriveRowTitle: strips the default hint and trailing colon, hint becomes defaultValue', () => {
  const result = deriveRowTitle('CodeMie organization URL: (https://codemie.lab.epam.com)');
  assert.deepEqual(result, { title: 'CodeMie organization URL', defaultValue: 'https://codemie.lab.epam.com' });
});

test('deriveRowTitle: a hint-less message strips only the trailing colon, empty defaultValue', () => {
  const result = deriveRowTitle('credential:');
  assert.deepEqual(result, { title: 'credential', defaultValue: '' });
});

test('stripHint: removes the default-hint suffix but leaves the colon intact', () => {
  assert.equal(stripHint('Enter a name for this profile: (sso)'), 'Enter a name for this profile:');
  assert.equal(stripHint('Enter a name for this profile: taken'), 'Enter a name for this profile: taken');
});

// ── Reopen-vs-new-row behavior ───────────────────────────────────────────────

test('reopen: a re-ask whose stripped message starts-with the stored base reopens the same row', async () => {
  const container = makeEl('div');
  const fakeStartSetup = async ({ onPrompt }) => {
    const first = onPrompt({ kind: 'input', id: 'profileName', message: 'Enter a name for this profile: (sso)' });
    await Promise.resolve();
    // Reopen before the first prompt resolves is unrealistic for a real driver
    // (it awaits one prompt at a time), but here we just want to inspect state
    // between the two onPrompt invocations, so resolve the first immediately.
    const row1 = findRowById(container, 'profileName-1');
    const control1 = row1.querySelector('.prompt-control');
    const submitBtn1 = control1._children.find((c) => c.className === 'prompt-submit');
    submitBtn1.onclick();
    await first;

    // Re-ask: inquirer dropped the hint and appended the rejected input.
    const second = onPrompt({ kind: 'input', id: 'profileName', message: 'Enter a name for this profile: taken' });
    await Promise.resolve();
    return { first, second };
  };

  const view = createSetupView(container, { startSetup: fakeStartSetup, readConfig: okConfig });
  const startPromise = view.start();
  await Promise.resolve();
  await Promise.resolve();

  // Exactly one row for this prompt id -- no profileName-2.
  assert.ok(findRowById(container, 'profileName-1'), 'profileName-1 row exists');
  assert.equal(findRowById(container, 'profileName-2'), null, 'no second occurrence row was created');

  const row = findRowById(container, 'profileName-1');
  assert.ok(row.classList._set.has('active'), 'reopened row is ACTIVE again');
  assert.equal(row.querySelector('.step-sub').textContent, '', 'old subtitle was cleared on reopen');

  // Answer the reopened row so start() can finish.
  const control = row.querySelector('.prompt-control');
  const input = control._children.find((c) => c.type === 'text');
  input.value = 'my-profile';
  const submitBtn = control._children.find((c) => c.className === 'prompt-submit');
  submitBtn.onclick();

  await startPromise;
});

test('reopen: the row keeps the original question as its heading, not the re-ask line carrying the rejected value', async () => {
  const container = makeEl('div');
  const fakeStartSetup = async ({ onPrompt }) => {
    const first = onPrompt({ kind: 'input', id: 'codemieUrl', message: 'CodeMie organization URL: (https://codemie.lab.epam.com)' });
    await tick();
    const row1 = findRowById(container, 'codemieUrl-1');
    findControl(row1)._children.find((c) => c.type === 'text').value = 'not-a-url';
    clickContinue(row1);
    await first;

    // inquirer puts the rejected value back on the question line
    // (inquirer/lib/prompts/input.js:88), so the re-ask message arrives as
    // "<question>: <rejected value>".
    return onPrompt({ kind: 'input', id: 'codemieUrl', message: 'CodeMie organization URL: not-a-url' });
  };

  const view = createSetupView(container, { startSetup: fakeStartSetup, readConfig: okConfig });
  const startPromise = view.start();
  await tick();
  await tick();

  const row = findRowById(container, 'codemieUrl-1');
  const heading = row.querySelector('.step-title').textContent;
  assert.equal(heading, 'CodeMie organization URL', 'the reopened row asks the original question again');
  assert.ok(!heading.includes('not-a-url'), 'the rejected value never becomes part of the heading');

  findControl(row)._children.find((c) => c.type === 'text').value = 'https://codemie.lab.epam.com';
  clickContinue(row);
  await startPromise;
});

test('reopen: a byte-identical hint-stripped message (masked-password re-ask) reopens the same row', async () => {
  const container = makeEl('div');
  const fakeStartSetup = async ({ onPrompt }) => {
    await onPrompt({ kind: 'input', id: 'password', message: 'Enter password:' });
    // Second ask is identical after stripHint (no hint to begin with).
    return onPrompt({ kind: 'input', id: 'password', message: 'Enter password:' });
  };

  const view = createSetupView(container, { startSetup: fakeStartSetup, readConfig: okConfig });
  const startPromise = view.start();

  await Promise.resolve();
  let row = findRowById(container, 'password-1');
  assert.ok(row, 'password-1 row inserted');
  let control = row.querySelector('.prompt-control');
  let submitBtn = control._children.find((c) => c.className === 'prompt-submit');
  submitBtn.onclick();

  await Promise.resolve();
  await Promise.resolve();

  assert.equal(findRowById(container, 'password-2'), null, 'identical re-ask reopens, does not create a new row');
  row = findRowById(container, 'password-1');
  assert.ok(row.classList._set.has('active'), 'row is ACTIVE again after reopen');

  control = row.querySelector('.prompt-control');
  submitBtn = control._children.find((c) => c.className === 'prompt-submit');
  submitBtn.onclick();

  await startPromise;
});

test('new occurrence: same id but a different (non-prefix) hint-stripped message inserts a new row', async () => {
  const container = makeEl('div');
  const fakeStartSetup = async ({ onPrompt }) => {
    await onPrompt({ kind: 'input', id: 'freeform', message: 'First question: (default)' });
    return onPrompt({ kind: 'input', id: 'freeform', message: 'Totally different question: (other)' });
  };

  const view = createSetupView(container, { startSetup: fakeStartSetup, readConfig: okConfig });
  const startPromise = view.start();

  await Promise.resolve();
  let row = findRowById(container, 'freeform-1');
  let control = row.querySelector('.prompt-control');
  let submitBtn = control._children.find((c) => c.className === 'prompt-submit');
  submitBtn.onclick();

  await Promise.resolve();
  await Promise.resolve();

  const row2 = findRowById(container, 'freeform-2');
  assert.ok(row2, 'a genuinely different message creates a new occurrence row instead of reopening');

  control = row2.querySelector('.prompt-control');
  submitBtn = control._children.find((c) => c.className === 'prompt-submit');
  submitBtn.onclick();

  await startPromise;
});

test('double-rejection: the stored comparison base never advances past the original ask; exactly one row survives', async () => {
  const container = makeEl('div');
  const fakeStartSetup = async ({ onPrompt }) => {
    await onPrompt({ kind: 'input', id: 'profileName', message: 'Enter a name for this profile: (sso)' });
    await onPrompt({ kind: 'input', id: 'profileName', message: 'Enter a name for this profile: taken' });
    // Deliberately does NOT start with "taken" (the first re-ask's own
    // stripped text): if the stored base were wrongly advanced to that first
    // re-ask (instead of staying pinned to the original "Enter a name for
    // this profile:"), this message would fail the startsWith comparison
    // against it and be mistaken for a new occurrence.
    return onPrompt({ kind: 'input', id: 'profileName', message: 'Enter a name for this profile: still-invalid' });
  };

  const view = createSetupView(container, { startSetup: fakeStartSetup, readConfig: okConfig });
  const startPromise = view.start();

  // First ask.
  await Promise.resolve();
  let row = findRowById(container, 'profileName-1');
  let control = row.querySelector('.prompt-control');
  let submitBtn = control._children.find((c) => c.className === 'prompt-submit');
  submitBtn.onclick();

  // First rejection re-ask ("taken") -- reopens profileName-1.
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(findRowById(container, 'profileName-2'), null, 'first rejection does not create a second row');
  row = findRowById(container, 'profileName-1');
  control = row.querySelector('.prompt-control');
  submitBtn = control._children.find((c) => c.className === 'prompt-submit');
  submitBtn.onclick();

  // Second rejection re-ask ("taken2") -- must still compare against the
  // original stored base ("Enter a name for this profile:"), not against
  // "Enter a name for this profile: taken", and must still reopen the same
  // single row rather than creating a third occurrence.
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(findRowById(container, 'profileName-2'), null, 'second rejection still does not create a new row');
  assert.equal(findRowById(container, 'profileName-3'), null, 'second rejection does not create a third row');
  row = findRowById(container, 'profileName-1');
  assert.ok(row.classList._set.has('active'), 'row is ACTIVE again after the second reopen');

  control = row.querySelector('.prompt-control');
  const input = control._children.find((c) => c.type === 'text');
  input.value = 'final-name';
  submitBtn = control._children.find((c) => c.className === 'prompt-submit');
  submitBtn.onclick();

  await startPromise;
});

// ── renderOptionCards ─────────────────────────────────────────────────────────

test('renderOptionCards: splits an option string at the FIRST " - " into title/description', () => {
  const [card] = renderOptionCards([
    'CodeMie SSO - Enterprise SSO Authentication with centralized model management',
  ]);
  assert.deepEqual(card, {
    title: 'CodeMie SSO',
    description: 'Enterprise SSO Authentication with centralized model management',
    recommended: false,
  });
});

test('renderOptionCards: model fixture -- starred entry strips "⭐ " to title, recommended true', () => {
  // Real parsed strings this module receives, per ui/setup-parse.js's parseOptions
  // applied to ui/test/fixtures/setup/model.json lines 16-17:
  //   "❯ ⭐ claude-sonnet-5 "  -> "⭐ claude-sonnet-5"
  //   "  claude-4-5-sonnet "  -> "claude-4-5-sonnet"
  const [starred, plain] = renderOptionCards(['⭐ claude-sonnet-5', 'claude-4-5-sonnet']);
  assert.deepEqual(starred, { title: 'claude-sonnet-5', description: '', recommended: true });
  assert.deepEqual(plain, { title: 'claude-4-5-sonnet', description: '', recommended: false });
});

test('renderOptionCards: provider prompt badges index 0 regardless of star', () => {
  const cards = renderOptionCards(['⭐ OpenAI', 'Bedrock', 'Anthropic'], { badgeIndex: 0 });
  assert.equal(cards[0].recommended, true, 'index 0 is recommended even without/with a star');
  assert.equal(cards[1].recommended, false);
  assert.equal(cards[2].recommended, false);
  assert.equal(cards[0].title, 'OpenAI', 'star is still stripped from the title');
});

test('renderOptionCards: model list (no badgeIndex) badges by star only, never by index', () => {
  const cards = renderOptionCards(['claude-4-5-sonnet', '⭐ claude-sonnet-5', 'claude-opus-4-5-20251101']);
  assert.equal(cards[0].recommended, false, 'index 0 is not starred, not recommended');
  assert.equal(cards[1].recommended, true, 'starred entry is recommended regardless of index');
  assert.equal(cards[2].recommended, false);
});

test('renderOptionCards: no " - " separator yields the whole string as title, empty description', () => {
  const [card] = renderOptionCards(['claude-sonnet-5']);
  assert.deepEqual(card, { title: 'claude-sonnet-5', description: '', recommended: false });
});

// ── renderOptionCards wired into the list control ────────────────────────────

test('list prompt: provider options render parsed titles and badge the recommended (index 0) entry', async () => {
  const container = makeEl('div');
  const fakeStartSetup = async ({ onPrompt }) => {
    await onPrompt({
      kind: 'list',
      id: 'provider',
      message: 'Pick a provider',
      options: ['CodeMie SSO - Enterprise SSO Authentication with centralized model management', 'Bedrock - AWS'],
    });
    return { profileName: 'default' };
  };

  const view = createSetupView(container, { startSetup: fakeStartSetup, readConfig: okConfig });
  const startPromise = view.start();

  await Promise.resolve();
  const row = findRowById(container, 'provider-1');
  const control = row.querySelector('.prompt-control');
  // Task 4 replaces the flat `.prompt-option-label` span with real
  // `.setup-option-card` markup (title/description/badge elements); the
  // title now lives in a nested `.setup-option-title` element.
  const titles = collectAll(control, (c) => c.className === 'setup-option-title');
  assert.equal(titles[0].textContent, 'CodeMie SSO', 'card title reflects the parsed title, not the raw option string');

  const radios = collectAll(control, (c) => c.type === 'radio');
  const submitBtn = control._children.find((c) => c.className === 'prompt-submit');
  radios[0].checked = true;
  submitBtn.onclick();

  await startPromise;
});

// ── deriveRowTitle wired into the input control ──────────────────────────────

test('input prompt: row title uses deriveRowTitle, input is pre-filled with the parsed default', async () => {
  const container = makeEl('div');
  const fakeStartSetup = async ({ onPrompt }) => {
    await onPrompt({
      kind: 'input',
      id: 'orgUrl',
      message: 'CodeMie organization URL: (https://codemie.lab.epam.com)',
    });
    return { profileName: 'default' };
  };

  const view = createSetupView(container, { startSetup: fakeStartSetup, readConfig: okConfig });
  const startPromise = view.start();

  await Promise.resolve();
  const row = findRowById(container, 'orgUrl-1');
  assert.ok(row, 'orgUrl-1 row was inserted');
  assert.equal(row.querySelector('.step-title').textContent, 'CodeMie organization URL', 'title strips hint + colon');

  const control = row.querySelector('.prompt-control');
  const input = control._children.find((c) => c.type === 'text');
  assert.equal(input.value, 'https://codemie.lab.epam.com', 'input is pre-filled with the parsed default');

  const submitBtn = control._children.find((c) => c.className === 'prompt-submit');
  submitBtn.onclick();

  await startPromise;
});

// ── Task 4: header, PROMPT_COPY, collapsed rows, option cards, Continue ─────

test('header: "Set up CodeMie" heading renders once at mount, before the storage row', async () => {
  const container = makeEl('div');
  const fakeStartSetup = async () => ({ profileName: 'default' });

  const view = createSetupView(container, { startSetup: fakeStartSetup, readConfig: okConfig });
  await view.start();

  const headers = container._children.filter((c) => c.className === 'setup-view-heading');
  assert.equal(headers.length, 1, 'exactly one header rendered');
  assert.equal(headers[0].textContent, 'Set up CodeMie');
  assert.equal(container._children[0], headers[0], 'header is the first child of the container');

  const storageIndex = container._children.findIndex((c) => c.dataset && c.dataset.id === 'storage');
  assert.ok(storageIndex > 0, 'storage row is inserted after the header');
});

test('PROMPT_COPY: provider row renders its heading/helper while active, collapses to "How to reach a model"', async () => {
  const container = makeEl('div');
  let resolvedAnswer;
  const fakeStartSetup = async ({ onPrompt }) => {
    resolvedAnswer = await onPrompt({
      kind: 'list',
      id: 'provider',
      message: 'Choose your LLM provider:',
      options: ['OpenAI', 'Bedrock'],
    });
    return { profileName: 'default' };
  };

  const view = createSetupView(container, { startSetup: fakeStartSetup, readConfig: okConfig });
  const startPromise = view.start();

  await Promise.resolve();
  const row = findRowById(container, 'provider-1');
  assert.equal(row.querySelector('.step-title').textContent, 'How should CodeMie reach a model?');
  const helperEl = row.querySelector('.step-helper');
  assert.ok(helperEl, 'helper element rendered for the open row');
  assert.equal(helperEl.textContent, 'You can change this later.');

  const control = row.querySelector('.prompt-control');
  const radios = collectAll(control, (c) => c.type === 'radio');
  radios[0].checked = true;
  const submitBtn = control._children.find((c) => c.className === 'prompt-submit');
  submitBtn.onclick();

  await startPromise;

  assert.equal(resolvedAnswer, 0);
  assert.equal(row.querySelector('.step-title').textContent, 'How to reach a model', 'collapsed label overrides the open heading');
  assert.ok(row.classList._set.has('collapsed'), 'row carries the collapsed class once COMPLETE');
});

test('PROMPT_COPY: model row renders its own heading/helper and collapses to "Model", never the provider label', async () => {
  const container = makeEl('div');
  const fakeStartSetup = async ({ onPrompt }) => {
    await onPrompt({
      kind: 'list',
      id: 'model',
      message: 'Choose a model',
      options: ['⭐ claude-sonnet-5', 'claude-4-5-sonnet'],
    });
    return { profileName: 'default' };
  };

  const view = createSetupView(container, { startSetup: fakeStartSetup, readConfig: okConfig });
  const startPromise = view.start();

  await Promise.resolve();
  const row = findRowById(container, 'model-1');
  assert.equal(row.querySelector('.step-title').textContent, 'Which model?');
  assert.equal(row.querySelector('.step-helper').textContent, 'These are the models your account can use.');

  const control = row.querySelector('.prompt-control');
  const radios = collectAll(control, (c) => c.type === 'radio');
  radios[0].checked = true;
  const submitBtn = control._children.find((c) => c.className === 'prompt-submit');
  submitBtn.onclick();

  await startPromise;

  assert.equal(row.querySelector('.step-title').textContent, 'Model');
  assert.notEqual(row.querySelector('.step-title').textContent, 'How to reach a model', 'never swapped with the provider label');
});

test('PROMPT_COPY: a prompt id outside the table (credential) falls back to deriveRowTitle, proving an override not a takeover', async () => {
  const container = makeEl('div');
  const fakeStartSetup = async ({ onPrompt }) => {
    await onPrompt({ kind: 'input', id: 'credential', message: 'API key:' });
    return { profileName: 'default' };
  };

  const view = createSetupView(container, { startSetup: fakeStartSetup, readConfig: okConfig });
  const startPromise = view.start();

  await Promise.resolve();
  const row = findRowById(container, 'credential-1');
  assert.equal(row.querySelector('.step-title').textContent, 'API key', 'deriveRowTitle fallback used, no table entry for this id');
  assert.equal(row.querySelector('.step-helper'), null, 'no helper text rendered when the table has no entry');

  const control = row.querySelector('.prompt-control');
  const input = control._children.find((c) => c.type === 'password');
  assert.ok(input, 'an API key is typed into a masked field');
  input.value = 'sk-test';
  const submitBtn = control._children.find((c) => c.className === 'prompt-submit');
  submitBtn.onclick();

  await startPromise;
  assert.equal(row.querySelector('.step-sub').textContent, '••••', 'a key this short shows none of its characters');
});

test('collapsed class is added only once a row reaches COMPLETE, never while PENDING/ACTIVE', async () => {
  const container = makeEl('div');
  const fakeStartSetup = async ({ onPrompt }) => {
    await onPrompt({ kind: 'input', id: 'profileName', message: 'Enter a name for this profile:' });
    return { profileName: 'default' };
  };

  const view = createSetupView(container, { startSetup: fakeStartSetup, readConfig: okConfig });
  const startPromise = view.start();

  await Promise.resolve();
  const row = findRowById(container, 'profileName-1');
  assert.ok(row.classList._set.has('active'), 'row is ACTIVE');
  assert.ok(!row.classList._set.has('collapsed'), 'ACTIVE row does not carry the collapsed class');

  const control = row.querySelector('.prompt-control');
  const input = control._children.find((c) => c.type === 'text');
  input.value = 'my-profile';
  const submitBtn = control._children.find((c) => c.className === 'prompt-submit');
  submitBtn.onclick();

  await startPromise;

  assert.ok(row.classList._set.has('collapsed'), 'COMPLETE row carries the collapsed class');
});

test('option cards: recommended card gets a badge element and the "recommended" class; markup uses real elements, not dataset text', async () => {
  const container = makeEl('div');
  const fakeStartSetup = async ({ onPrompt }) => {
    await onPrompt({
      kind: 'list',
      id: 'model',
      message: 'Choose a model',
      options: ['⭐ claude-sonnet-5 - Balanced default', 'claude-4-5-sonnet'],
    });
    return { profileName: 'default' };
  };

  const view = createSetupView(container, { startSetup: fakeStartSetup, readConfig: okConfig });
  const startPromise = view.start();

  await Promise.resolve();
  const row = findRowById(container, 'model-1');
  const control = row.querySelector('.prompt-control');
  const cards = control._children.filter((c) => (c.className || '').split(' ').includes('setup-option-card'));
  assert.equal(cards.length, 2, 'one card per option');

  const [recommendedCard, plainCard] = cards;
  assert.ok((recommendedCard.className || '').split(' ').includes('recommended'), 'starred option carries the recommended class');
  const titleEl = recommendedCard._children.find((c) => c.className === 'setup-option-title');
  assert.equal(titleEl.textContent, 'claude-sonnet-5');
  const descEl = recommendedCard._children.find((c) => c.className === 'setup-option-description');
  assert.equal(descEl.textContent, 'Balanced default');
  const badge = recommendedCard._children.find((c) => c.className === 'setup-option-badge');
  assert.ok(badge, 'recommended badge element present');
  assert.equal(badge.textContent, 'Recommended');

  assert.ok(!(plainCard.className || '').split(' ').includes('recommended'), 'non-starred option has no recommended class');
  assert.equal(
    plainCard._children.find((c) => c.className === 'setup-option-description'),
    undefined,
    'no description element when the option has an empty description',
  );

  const submitBtn = control._children.find((c) => c.className === 'prompt-submit');
  submitBtn.onclick();
  await startPromise;
});

test('Continue button (list): clicking Continue with a card selected resolves the prompt with that card\'s index', async () => {
  const container = makeEl('div');
  let resolvedAnswer;
  const fakeStartSetup = async ({ onPrompt }) => {
    resolvedAnswer = await onPrompt({
      kind: 'list',
      id: 'model',
      message: 'Choose a model',
      options: ['claude-sonnet-5', 'claude-opus'],
    });
    return { profileName: 'default' };
  };

  const view = createSetupView(container, { startSetup: fakeStartSetup, readConfig: okConfig });
  const startPromise = view.start();

  await Promise.resolve();
  const row = findRowById(container, 'model-1');
  const control = row.querySelector('.prompt-control');
  const cards = control._children.filter((c) => (c.className || '').split(' ').includes('setup-option-card'));
  assert.equal(cards.length, 2, 'one card per option');

  cards[1].onclick(); // select "claude-opus" (index 1) via the card itself

  const submitBtn = control._children.find((c) => c.className === 'prompt-submit');
  submitBtn.onclick();

  await startPromise;

  assert.equal(resolvedAnswer, 1, 'Continue resolves with the selected card\'s index');
});

test('Continue button (input): clicking Continue with a typed value resolves the prompt with that string', async () => {
  const container = makeEl('div');
  let resolvedAnswer;
  const fakeStartSetup = async ({ onPrompt }) => {
    resolvedAnswer = await onPrompt({ kind: 'input', id: 'profileName', message: 'Enter a name for this profile:' });
    // The config fake reports "default" as active; the typed value is what the driver types, not what the config says.
    return { profileName: 'default' };
  };

  const view = createSetupView(container, { startSetup: fakeStartSetup, readConfig: okConfig });
  const startPromise = view.start();

  await Promise.resolve();
  const row = findRowById(container, 'profileName-1');
  const control = row.querySelector('.prompt-control');
  const input = control._children.find((c) => c.type === 'text');
  input.value = 'my-workspace-2';

  const submitBtn = control._children.find((c) => c.className === 'prompt-submit');
  assert.ok(submitBtn.classList && submitBtn.classList._set.has('setup-continue-btn'), 'Continue button carries the dedicated styling class');
  submitBtn.onclick();

  await startPromise;

  assert.equal(resolvedAnswer, 'my-workspace-2', 'Continue resolves with the typed string');
});

// ── Answered rows: control and helper removed, value is the card title ──────

test('answering a list prompt removes its control and helper text and collapses to the card title', async () => {
  const container = makeEl('div');
  const fakeStartSetup = async ({ onPrompt }) => {
    await onPrompt({
      kind: 'list',
      id: 'provider',
      message: 'Choose your LLM provider:',
      options: ['CodeMie SSO - Enterprise SSO Authentication with centralized model management', 'Ollama - Popular open-source local LLM runner - optimized for coding with 16GB RAM'],
    });
    return { profileName: 'default' };
  };

  const view = createSetupView(container, { startSetup: fakeStartSetup, readConfig: okConfig });
  const startPromise = view.start();
  await Promise.resolve();

  const row = findRowById(container, 'provider-1');
  assert.ok(row.querySelector('.step-helper'), 'helper text shown while open');
  clickContinue(row);
  await startPromise;

  assert.equal(findControl(row), null, 'option cards and Continue are gone once answered');
  assert.equal(row.querySelector('.step-helper'), null, 'helper text is gone once answered');
  assert.equal(row.querySelector('.step-sub').textContent, 'CodeMie SSO', 'collapsed value is the card title, not the raw option string');
  assert.equal(row.querySelector('.step-title').textContent, 'How to reach a model');
});

test('list control pre-selects the first card and a card click moves the selection', async () => {
  const container = makeEl('div');
  let resolvedAnswer;
  const fakeStartSetup = async ({ onPrompt }) => {
    resolvedAnswer = await onPrompt({ kind: 'list', id: 'model', message: 'Choose a model (3 available):', options: ['⭐ claude-sonnet-5', 'claude-4-5-sonnet', 'gpt-5'] });
    return { profileName: 'default' };
  };

  const view = createSetupView(container, { startSetup: fakeStartSetup, readConfig: okConfig });
  const startPromise = view.start();
  await Promise.resolve();

  const row = findRowById(container, 'model-1');
  const control = findControl(row);
  const radios = collectAll(control, (c) => c.type === 'radio');
  const cards = collectAll(control, (c) => (c.className || '').split(' ').includes('setup-option-card'));
  assert.ok(radios[0].checked, 'first radio is checked on render');
  assert.ok(cards[0].classList._set.has('selected'), 'first card carries the selected class on render');
  assert.ok(!radios[1].checked && !radios[2].checked);

  cards[2].onclick();
  assert.ok(radios[2].checked && !radios[0].checked, 'clicking a card moves the checked radio');
  assert.ok(cards[2].classList._set.has('selected') && !cards[0].classList._set.has('selected'), 'and the selected class');

  clickContinue(row);
  await startPromise;
  assert.equal(resolvedAnswer, 2);
  assert.equal(row.querySelector('.step-sub').textContent, 'gpt-5');
});

test('list prompt without a copy override: heading is the CLI question without its trailing colon', async () => {
  const container = makeEl('div');
  const fakeStartSetup = async ({ onPrompt }) => {
    await onPrompt({ kind: 'list', id: 'codemieProject', message: 'Select your project:', options: ['EPM-CDME', 'OTHER'] });
    return { profileName: 'default' };
  };

  const view = createSetupView(container, { startSetup: fakeStartSetup, readConfig: okConfig });
  const startPromise = view.start();
  await Promise.resolve();

  const row = findRowById(container, 'codemieProject-1');
  assert.equal(row.querySelector('.step-title').textContent, 'Select your project');
  clickContinue(row);
  await startPromise;
  assert.equal(row.querySelector('.step-title').textContent, 'CodeMie project');
  assert.equal(row.querySelector('.step-sub').textContent, 'EPM-CDME');
});

test('never-rendered activate confirm is answered with the driver\'s own policy (yes)', async () => {
  const container = makeEl('div');
  let activateAnswer;
  const fakeStartSetup = async ({ onPrompt }) => {
    activateAnswer = await onPrompt({ kind: 'confirm', id: 'activate', message: 'Switch to profile "x" as active?' });
    return { profileName: 'default' };
  };

  const view = createSetupView(container, { startSetup: fakeStartSetup, readConfig: okConfig });
  await view.start();
  assert.equal(activateAnswer, true, 'activate is confirmed, matching setup-driver.js AUTO_CONFIRM');
});

// ── Task 5: transient "Working…" row ────────────────────────────────────────

const workingRows = (container) => container._children.filter((c) => c.dataset && /^working-/.test(c.dataset.id || ''));

test('transient spinner: shown right after start, hidden by the first prompt, shown again after an answer, gone on resolve', async () => {
  const container = makeEl('div');
  let release;
  const gate = new Promise((r) => { release = r; });
  const fakeStartSetup = async ({ onPrompt }) => {
    await gate;
    await onPrompt({ kind: 'input', id: 'profileName', message: 'Enter a name for this profile:' });
    return { profileName: 'default' };
  };

  const view = createSetupView(container, { startSetup: fakeStartSetup, readConfig: okConfig });
  const startPromise = view.start();

  let working = workingRows(container);
  assert.equal(working.length, 1, 'one Working row before the first prompt');
  assert.equal(working[0].querySelector('.step-title').textContent, 'Working…');
  assert.ok(working[0].classList._set.has('active'));
  const storageIndex = container._children.findIndex((c) => c.dataset && c.dataset.id === 'storage');
  assert.ok(container._children.indexOf(working[0]) > storageIndex, 'Working row sits below the storage row');
  await tick(120);
  assert.ok(SPINNER_GLYPHS.includes(working[0].querySelector('.step-icon').textContent), 'it spins');

  release();
  await tick();
  assert.equal(workingRows(container).length, 0, 'hidden the moment the prompt arrives');
  const row = findRowById(container, 'profileName-1');
  assert.ok(row, 'prompt row inserted');

  clickContinue(row);
  working = workingRows(container);
  assert.equal(working.length, 1, 'shown again after the answer, while the CLI works');
  assert.equal(working[0].dataset.id, 'working-2', 'a fresh id per gap');
  assert.ok(container._children.indexOf(working[0]) > container._children.indexOf(row), 'below the answered row');

  await startPromise;
  assert.equal(workingRows(container).length, 0, 'gone once the run resolves');
});

test('transient spinner: not inserted after installClaude yes, inserted after installClaude no', async () => {
  const runWith = async (answerYes) => {
    const container = makeEl('div');
    let release;
    const gate = new Promise((r) => { release = r; });
    let capturedLog;
    const fakeStartSetup = async ({ onPrompt, onLog }) => {
      capturedLog = onLog;
      await onPrompt({ kind: 'confirm', id: 'installClaude', message: 'Would you like to install Claude Code now?' });
      await gate;
      return { profileName: 'default' };
    };
    const view = createSetupView(container, { startSetup: fakeStartSetup, readConfig: okConfig });
    const startPromise = view.start();
    await Promise.resolve();
    const row = findRowById(container, 'installClaude-1');
    if (!answerYes) {
      collectAll(findControl(row), (c) => (c.className || '').split(' ').includes('setup-option-card'))[1].onclick(); // pick No
    }
    clickContinue(row);
    const count = workingRows(container).length;
    if (answerYes) capturedLog('Claude Code v1.0.0 installed successfully');
    release();
    await startPromise;
    return count;
  };
  assert.equal(await runWith(true), 0, 'yes: the install row\'s own spinner covers the gap');
  assert.equal(await runWith(false), 1, 'no: the usual Working row covers the gap');
});

// ── Task 6: installClaude driven by onLog ───────────────────────────────────

async function installYesHarness({ feed = [], settle = 'resolve', rejectWith } = {}) {
  const container = makeEl('div');
  let release;
  const gate = new Promise((r) => { release = r; });
  let capturedLog;
  const fakeStartSetup = async ({ onPrompt, onLog }) => {
    capturedLog = onLog;
    await onPrompt({ kind: 'confirm', id: 'installClaude', message: 'Would you like to install Claude Code now?' });
    await gate;
    if (settle === 'reject') throw rejectWith;
    return { profileName: 'default' };
  };
  const view = createSetupView(container, { startSetup: fakeStartSetup, readConfig: okConfig });
  const startPromise = view.start();
  await Promise.resolve();
  const row = findRowById(container, 'installClaude-1');
  clickContinue(row);
  for (const chunk of feed) capturedLog(chunk);
  const before = { icon: row.querySelector('.step-icon').textContent, sub: row.querySelector('.step-sub').textContent };
  release();
  const outcome = await startPromise;
  return { row, before, outcome, container };
}

test('installClaude: success line without a version collapses to "Claude Code — Installed"', async () => {
  const { row, before } = await installYesHarness({ feed: ['\x1b[32m✔ Claude Code installed successfully\x1b[39m\n'] });
  assert.equal(before.icon, '✓');
  assert.equal(before.sub, 'Installed');
  assert.equal(row.querySelector('.step-title').textContent, 'Claude Code');
});

test('installClaude: the CLI\'s failure line marks the row ERROR even though the run resolves normally', async () => {
  const { row, before, outcome } = await installYesHarness({ feed: ['\x1b[31m✖ Failed to install Claude Code\x1b[39m\n', 'You can install it manually later using:\n'] });
  assert.equal(before.icon, '✗', 'ERROR from the log line, before the run settles');
  assert.equal(before.sub, 'Not installed. You can install it from Tools.', 'says what to do next');
  assert.equal(row.querySelector('.step-icon').textContent, '✗', 'resolution does not overwrite it');
  assert.deepEqual(outcome, { ok: true, profileName: 'default' }, 'the profile itself is fine');
});

test('installClaude: safety net marks the row ERROR when the run settles with no install line seen', async () => {
  const { row, before } = await installYesHarness({ feed: ['Installing Claude Code (supported version)...\n'] });
  assert.ok(row.classList._set.has('active') === false, 'row is no longer ACTIVE after settling');
  assert.notEqual(before.icon, '✗', 'it was still pending before the run settled');
  assert.equal(row.querySelector('.step-icon').textContent, '✗');
  assert.equal(row.querySelector('.step-sub').textContent, 'Not confirmed');
});

test('installClaude: safety net also fires on rejection', async () => {
  const { row } = await installYesHarness({ settle: 'reject', rejectWith: { step: null, message: 'setup exited with code 1', raw: '' } });
  assert.equal(row.querySelector('.step-icon').textContent, '✗');
  assert.equal(row.querySelector('.step-sub').textContent, 'Not confirmed');
});

test('installClaude: log lines before the yes answer are ignored', async () => {
  const container = makeEl('div');
  let release;
  const gate = new Promise((r) => { release = r; });
  const fakeStartSetup = async ({ onPrompt, onLog }) => {
    onLog('Claude Code v9.9.9 installed successfully\n'); // noise from an earlier phase
    await onPrompt({ kind: 'confirm', id: 'installClaude', message: 'Would you like to install Claude Code now?' });
    await gate;
    return { profileName: 'default' };
  };
  const view = createSetupView(container, { startSetup: fakeStartSetup, readConfig: okConfig });
  const startPromise = view.start();
  await Promise.resolve();
  const row = findRowById(container, 'installClaude-1');
  clickContinue(row);
  assert.equal(row.querySelector('.step-sub').textContent, 'Installing…', 'still waiting: the earlier line did not count');
  release();
  await startPromise;
  assert.equal(row.querySelector('.step-sub').textContent, 'Not confirmed');
});

// ── Task 7: success and failure mapping ─────────────────────────────────────

async function runProfileFlow({ readConfig, settle, rejectWith, before }) {
  const container = makeEl('div');
  const fakeStartSetup = async ({ onPrompt }) => {
    await onPrompt({ kind: 'list', id: 'provider', message: 'Choose your LLM provider:', options: ['CodeMie SSO - x', 'Ollama - y'] });
    await onPrompt({ kind: 'input', id: 'profileName', message: 'Enter a name for this profile: (sso)' });
    if (before) await before();
    if (settle === 'reject') throw rejectWith;
    return { profileName: 'sso' };
  };
  const view = createSetupView(container, { startSetup: fakeStartSetup, readConfig });
  const startPromise = view.start();
  await Promise.resolve();
  clickContinue(findRowById(container, 'provider-1'));
  await tick();
  clickContinue(findRowById(container, 'profileName-1'));
  const outcome = await startPromise;
  return { container, outcome };
}

test('success: readConfig reports the new profile active; every row stays COMPLETE and start() says ok', async () => {
  let calls = 0;
  const readConfig = async () => { calls += 1; return { state: 'valid', profile: 'sso', model: 'm', project: 'p', account: 'a@b' }; };
  const { container, outcome } = await runProfileFlow({ readConfig });
  assert.equal(calls, 1, 'the config reader is consulted once');
  assert.deepEqual(outcome, { ok: true, profileName: 'sso' });
  assert.equal(findRowById(container, 'profileName-1').querySelector('.step-icon').textContent, '✓');
  assert.equal(findRowById(container, 'provider-1').querySelector('.step-icon').textContent, '✓');
  assert.equal(workingRows(container).length, 0);
});

test('mismatch: a different active profile marks the last row ERROR and start() says not ok', async () => {
  const readConfig = async () => ({ state: 'valid', profile: 'other', model: '', project: '', account: null });
  const { container, outcome } = await runProfileFlow({ readConfig });
  assert.equal(outcome.ok, false);
  assert.equal(outcome.error.step, null);
  assert.equal(findRowById(container, 'profileName-1').querySelector('.step-icon').textContent, '✗', 'last row is ERROR');
  assert.equal(findRowById(container, 'provider-1').querySelector('.step-icon').textContent, '✓', 'earlier rows untouched');
});

test('broken config or a throwing reader is a mismatch too', async () => {
  const broken = await runProfileFlow({ readConfig: async () => ({ state: 'broken', profile: 'sso', model: '', project: '', account: null }) });
  assert.equal(broken.outcome.ok, false);
  const throwing = await runProfileFlow({ readConfig: async () => { throw new Error('ipc down'); } });
  assert.equal(throwing.outcome.ok, false);
  assert.equal(findRowById(throwing.container, 'profileName-1').querySelector('.step-icon').textContent, '✗');
});

test('rejection naming an answered step marks that row ERROR and start() hands the driver error back', async () => {
  const err = { step: 'provider', message: 'invalid provider selection index: 7', raw: '' };
  const { container, outcome } = await runProfileFlow({ readConfig: okConfig, settle: 'reject', rejectWith: err });
  assert.deepEqual(outcome, { ok: false, error: err });
  assert.equal(findRowById(container, 'provider-1').querySelector('.step-icon').textContent, '✗');
  assert.equal(findRowById(container, 'profileName-1').querySelector('.step-icon').textContent, '✓', 'only the named row');
  assert.equal(workingRows(container).length, 0, 'the Working row is not left behind');
});

test('a failed run leaves no live control on the row it marks ERROR', async () => {
  const container = makeEl('div');
  const fakeStartSetup = async ({ onPrompt }) => {
    onPrompt({ kind: 'list', id: 'provider', message: 'Choose your LLM provider:', options: ['CodeMie SSO - x'] });
    await tick();
    throw { step: null, message: 'pty closed', raw: '' };
  };

  const view = createSetupView(container, { startSetup: fakeStartSetup, readConfig: okConfig });
  const result = await view.start();

  assert.equal(result.ok, false);
  const row = findRowById(container, 'provider-1');
  assert.equal(row.querySelector('.step-icon').textContent, '✗', 'the open row is the one marked');
  assert.equal(findControl(row), null, 'its option cards and Continue button are gone');
});

test('rejection with step "model" before any model row inserts the model row in ERROR', async () => {
  const err = { step: 'model', message: 'model list did not redraw within 5000ms after an arrow-key step', raw: '' };
  const { container } = await runProfileFlow({ readConfig: okConfig, settle: 'reject', rejectWith: err });
  const modelRow = findRowById(container, 'model-1');
  assert.ok(modelRow, 'model-1 row was inserted for the failure');
  assert.equal(modelRow.querySelector('.step-icon').textContent, '✗');
  assert.equal(modelRow.querySelector('.step-title').textContent, 'Model');
  assert.equal(workingRows(container).length, 0);
});

test('rejection with step null while a prompt is open marks the open row ERROR', async () => {
  const container = makeEl('div');
  const err = { step: null, message: 'setup exited with code 1', raw: '' };
  const fakeStartSetup = async ({ onPrompt }) => {
    void onPrompt({ kind: 'input', id: 'credential', message: 'API key:' }); // left unanswered
    await tick();
    throw err;
  };
  const view = createSetupView(container, { startSetup: fakeStartSetup, readConfig: okConfig });
  const outcome = await view.start();
  assert.equal(outcome.ok, false);
  const row = findRowById(container, 'credential-1');
  assert.equal(row.querySelector('.step-icon').textContent, '✗');
  assert.equal(workingRows(container).length, 0);
});

test('rejection with step null between prompts turns the Working row into the one ERROR row on screen', async () => {
  const err = { step: null, message: 'unrecognized prompt, run stalled', raw: '' };
  const { container, outcome } = await runProfileFlow({ readConfig: okConfig, settle: 'reject', rejectWith: err });
  assert.equal(outcome.ok, false);
  const working = workingRows(container);
  assert.equal(working.length, 1, 'the transient row is kept, not hidden');
  assert.equal(working[0].querySelector('.step-icon').textContent, '✗');
  assert.equal(working[0].querySelector('.step-title').textContent, 'Setup stopped');
  const errorRows = container._children.filter((c) => c.dataset && c.dataset.id && c.querySelector('.step-icon') && c.querySelector('.step-icon').textContent === '✗');
  assert.equal(errorRows.length, 1, 'exactly one ERROR row');
  assert.equal(findRowById(container, 'profileName-1').querySelector('.step-icon').textContent, '✓', 'answered rows untouched');
});

test('rejection naming a repeated catch-all id marks its latest occurrence, not the first', async () => {
  const container = makeEl('div');
  const err = { step: 'credential', message: 'boom', raw: '' };
  const fakeStartSetup = async ({ onPrompt }) => {
    await onPrompt({ kind: 'input', id: 'credential', message: 'AWS Access Key ID:' });
    await onPrompt({ kind: 'input', id: 'credential', message: 'AWS Secret Access Key: [input is hidden]' });
    throw err;
  };
  const view = createSetupView(container, { startSetup: fakeStartSetup, readConfig: okConfig });
  const startPromise = view.start();
  await Promise.resolve();
  clickContinue(findRowById(container, 'credential-1'));
  await tick();
  clickContinue(findRowById(container, 'credential-2'));
  await startPromise;
  assert.equal(findRowById(container, 'credential-2').querySelector('.step-icon').textContent, '✗');
  assert.equal(findRowById(container, 'credential-1').querySelector('.step-icon').textContent, '✓');
});

// ── Final pass: fresh runs and the closing line ─────────────────────────────

test('success appends a closing status line naming the active profile; a mismatch does not', async () => {
  const good = await runProfileFlow({ readConfig: async () => ({ state: 'valid', profile: 'sso', model: '', project: '', account: null }) });
  const status = good.container._children.find((c) => c.className === 'setup-view-status');
  assert.ok(status, 'status line rendered');
  assert.equal(status.textContent, 'Setup complete. sso is now the active profile.');
  assert.equal(good.container._children.indexOf(status), good.container._children.length - 1, 'it sits under the list');

  const bad = await runProfileFlow({ readConfig: async () => ({ state: 'valid', profile: 'other', model: '', project: '', account: null }) });
  assert.equal(bad.container._children.find((c) => c.className === 'setup-view-status'), undefined, 'no status line on a mismatch');
});

test('start() called again on the same view is a fresh run: ids, reopen bases and the closing line all reset', async () => {
  const container = makeEl('div');
  const fakeStartSetup = async ({ onPrompt }) => {
    await onPrompt({ kind: 'list', id: 'provider', message: 'Choose your LLM provider:', options: ['CodeMie SSO - x', 'Ollama - y'] });
    return { profileName: 'default' };
  };
  const view = createSetupView(container, { startSetup: fakeStartSetup, readConfig: okConfig });

  let startPromise = view.start();
  await Promise.resolve();
  clickContinue(findRowById(container, 'provider-1'));
  await startPromise;
  assert.ok(container._children.find((c) => c.className === 'setup-view-status'), 'first run finished with its closing line');

  startPromise = view.start();
  await Promise.resolve();
  const row = findRowById(container, 'provider-1');
  assert.ok(row, 'the second run starts at provider-1 again, not provider-2');
  assert.equal(findRowById(container, 'provider-2'), null);
  assert.ok(row.classList._set.has('active'), 'and it is a live, open row, not a stale reopen');
  assert.ok(findControl(row), 'with its control rendered');
  assert.equal(container._children.filter((c) => c.className === 'setup-view-status').length, 0, 'the old closing line is gone while the run is open');
  clickContinue(row);
  await startPromise;
  assert.equal(container._children.filter((c) => c.className === 'setup-view-heading').length, 1, 'one header, not two');
});

// ── Secrets: masked while typed, never echoed into the row ──────────────────

test('isSecretPrompt: the CLI\'s key/secret/password/token questions and the hidden-input marker, nothing else', () => {
  for (const m of ['API key:', 'API Key (optional, leave empty if not required):', 'AWS Secret Access Key: [input is hidden]', 'AWS Access Key ID:', 'Bearer token:', 'Password:']) {
    assert.ok(isSecretPrompt(m), `${m} is a secret`);
  }
  for (const m of ['Ollama base URL: (http://localhost:11434)', 'LiteLLM Proxy URL:', 'AWS Region: (us-east-1)', 'CodeMie organization URL: (https://codemie.lab.epam.com)', 'Enter a name for this profile: (sso)']) {
    assert.ok(!isSecretPrompt(m), `${m} is not a secret`);
  }
});

test('deriveRowTitle drops inquirer\'s hidden-input marker from an unmasked password question', () => {
  assert.deepEqual(deriveRowTitle('AWS Secret Access Key: [input is hidden]'), { title: 'AWS Secret Access Key', defaultValue: '' });
});

test('maskSecret shows only the last four characters, and none of a short or empty value', () => {
  assert.equal(maskSecret('sk-proj-abcdefgh4f2a'), '••••4f2a');
  assert.equal(maskSecret('12345678'), '••••5678', 'eight characters is long enough');
  assert.equal(maskSecret('1234567'), '••••', 'shorter than eight shows nothing');
  assert.equal(maskSecret(''), '', 'nothing entered, nothing shown');
});

test('a secret credential renders a password field with no pre-fill and collapses to a masked value', async () => {
  const container = makeEl('div');
  let resolvedAnswer;
  const fakeStartSetup = async ({ onPrompt }) => {
    resolvedAnswer = await onPrompt({ kind: 'input', id: 'credential', message: 'AWS Secret Access Key: [input is hidden]' });
    return { profileName: 'default' };
  };
  const view = createSetupView(container, { startSetup: fakeStartSetup, readConfig: okConfig });
  const startPromise = view.start();
  await Promise.resolve();
  const row = findRowById(container, 'credential-1');
  assert.equal(row.querySelector('.step-title').textContent, 'AWS Secret Access Key');
  const input = findControl(row)._children.find((c) => c.type === 'password');
  assert.ok(input, 'masked field');
  assert.equal(input.value, '', 'nothing pre-filled');
  input.value = 'wJalrXUtnFEMI';
  clickContinue(row);
  await startPromise;
  assert.equal(resolvedAnswer, 'wJalrXUtnFEMI', 'the driver still gets the real value');
  assert.equal(row.querySelector('.step-sub').textContent, '••••FEMI', 'only the last four characters, masked');
  const texts = [];
  (function walk(el) { texts.push(el.textContent || '', el.value || ''); for (const c of el._children || []) walk(c); })(container);
  assert.ok(!texts.some((t) => t.includes('wJalrXUtnFEMI')), 'the value is nowhere in the DOM once answered');
});

test('a non-secret credential (a base URL) keeps the plain field, the pre-fill and the value as subtitle', async () => {
  const container = makeEl('div');
  const fakeStartSetup = async ({ onPrompt }) => {
    await onPrompt({ kind: 'input', id: 'credential', message: 'Ollama base URL: (http://localhost:11434)' });
    return { profileName: 'default' };
  };
  const view = createSetupView(container, { startSetup: fakeStartSetup, readConfig: okConfig });
  const startPromise = view.start();
  await Promise.resolve();
  const row = findRowById(container, 'credential-1');
  const input = findControl(row)._children.find((c) => c.type === 'text');
  assert.ok(input, 'plain text field');
  assert.equal(input.value, 'http://localhost:11434', 'pre-filled with the CLI default');
  clickContinue(row);
  await startPromise;
  assert.equal(row.querySelector('.step-sub').textContent, 'http://localhost:11434');
});

// ── One run at a time ───────────────────────────────────────────────────────

test('start() while a run is in flight returns that run instead of resetting it; a later start() is fresh', async () => {
  const container = makeEl('div');
  let calls = 0;
  let release;
  const gate = new Promise((r) => { release = r; });
  const fakeStartSetup = async ({ onPrompt }) => {
    calls += 1;
    await onPrompt({ kind: 'input', id: 'profileName', message: 'Enter a name for this profile:' });
    await gate;
    return { profileName: 'default' };
  };
  const view = createSetupView(container, { startSetup: fakeStartSetup, readConfig: okConfig });

  const first = view.start();
  await Promise.resolve();
  const row = findRowById(container, 'profileName-1');
  const second = view.start();
  assert.equal(second, first, 'the in-flight run is handed back');
  assert.equal(calls, 1, 'the driver is started once');
  assert.equal(findRowById(container, 'profileName-1'), row, 'the open row survived untouched');
  assert.equal(container._children.filter((c) => c.className === 'setup-view-heading').length, 1, 'one header');

  clickContinue(row);
  release();
  const outcome = await first;
  assert.equal(outcome.ok, true);

  const third = view.start();
  assert.notEqual(third, first, 'after settling, start() begins a fresh run');
  await Promise.resolve();
  assert.equal(calls, 2);
  clickContinue(findRowById(container, 'profileName-1'));
  await third;
});

// ── Profile name as the CLI saves it ────────────────────────────────────────

const inputOf = (row) => findControl(row)._children.find((c) => c.className === 'prompt-input');
const configWith = (profile) => async () => ({ state: 'valid', profile, model: '', project: '', account: null });

test('a profile name typed with surrounding spaces is verified as the trimmed name the CLI saves', async () => {
  // setup.js:501 saves newProfileName.trim(); the driver reports the raw answer.
  const container = makeEl('div');
  const view = createSetupView(container, { startSetup: async () => ({ profileName: '  demo ' }), readConfig: configWith('demo') });
  const outcome = await view.start();
  assert.equal(outcome.ok, true, 'a working setup is not reported as failed');
  assert.equal(outcome.profileName, 'demo');
  const status = container._children.find((c) => c.className === 'setup-view-status');
  assert.equal(status.textContent, 'Setup complete. demo is now the active profile.');
});

// macOS offered "Test" for "test" and Continue accepted it, so profile names
// came out capitalised (EPMCDME-15385, seen in QA's recording).
test('a text answer is never capitalised, corrected or spell-checked by the system', async () => {
  const container = makeEl('div');
  const fakeStartSetup = async ({ onPrompt }) => {
    await onPrompt({ kind: 'input', id: 'profileName', message: 'Enter a name for this profile:' });
    return { profileName: 'x' };
  };
  const view = createSetupView(container, { startSetup: fakeStartSetup, readConfig: configWith('x') });
  const p = view.start();
  await tick(0);
  const row = findRowById(container, 'profileName-1');
  const input = inputOf(row);
  assert.equal(input.getAttribute('autocapitalize'), 'off');
  assert.equal(input.getAttribute('autocorrect'), 'off');
  assert.equal(input.spellcheck, false);
  input.value = 'x';
  clickContinue(row);
  await p;
});

test('an input left empty submits the default the CLI would use, not an empty answer', async () => {
  // inquirer's filterInput (input.js:69-71) turns an empty line into the
  // default, so the CLI saves "demo-2". Answering '' made the driver report ''
  // and the view then flagged a working setup as failed.
  const container = makeEl('div');
  let answered;
  const fakeStartSetup = async ({ onPrompt }) => {
    answered = await onPrompt({ kind: 'input', id: 'profileName', message: 'Enter a name for this profile: (demo-2)' });
    return { profileName: String(answered) };
  };
  const view = createSetupView(container, { startSetup: fakeStartSetup, readConfig: configWith('demo-2') });
  const p = view.start();
  await tick(0);
  const row = findRowById(container, 'profileName-1');
  inputOf(row).value = '';
  clickContinue(row);
  const outcome = await p;
  assert.equal(answered, 'demo-2');
  assert.equal(row.querySelector('.step-sub').textContent, 'demo-2');
  assert.equal(outcome.ok, true);
});

test('whitespace is submitted as typed: only a truly empty field falls back to the default', async () => {
  const container = makeEl('div');
  let answered;
  const fakeStartSetup = async ({ onPrompt }) => {
    answered = await onPrompt({ kind: 'input', id: 'profileName', message: 'Enter a name for this profile: (demo-2)' });
    return { profileName: 'demo-2' };
  };
  const view = createSetupView(container, { startSetup: fakeStartSetup, readConfig: configWith('demo-2') });
  const p = view.start();
  await tick(0);
  const row = findRowById(container, 'profileName-1');
  inputOf(row).value = '   ';
  clickContinue(row);
  await p;
  assert.equal(answered, '   ', 'the CLI validates it and re-asks; the view must not hide that');
});

// ── Reopened input after a rejected answer ──────────────────────────────────

test('a reopened input is built from the first ask: its default is back and the rejected text does not change the field', async () => {
  // The re-ask message carries the rejected value, not the hint
  // ("CodeMie organization URL: my-token-host"; base.js:157-160 drops the hint
  // once the line was touched). Building the field from it lost the default and,
  // for a value containing "token", turned the URL field into a password field.
  const container = makeEl('div');
  const answers = [];
  const fakeStartSetup = async ({ onPrompt }) => {
    answers.push(await onPrompt({ kind: 'input', id: 'codemieUrl', message: 'CodeMie organization URL: (https://codemie.lab.epam.com)' }));
    answers.push(await onPrompt({ kind: 'input', id: 'codemieUrl', message: 'CodeMie organization URL: my-token-host' }));
    return { profileName: 'default' };
  };
  const view = createSetupView(container, { startSetup: fakeStartSetup, readConfig: okConfig });
  const p = view.start();
  await tick(0);
  let row = findRowById(container, 'codemieUrl-1');
  inputOf(row).value = 'my-token-host';
  clickContinue(row);
  await tick(0);
  row = findRowById(container, 'codemieUrl-1');
  const reopened = inputOf(row);
  assert.equal(reopened.type, 'text', 'still a plain URL field');
  assert.equal(reopened.value, 'https://codemie.lab.epam.com', 'the CLI default is pre-filled again');
  clickContinue(row);
  await p;
  assert.deepEqual(answers, ['my-token-host', 'https://codemie.lab.epam.com']);
  assert.equal(row.querySelector('.step-sub').textContent, 'https://codemie.lab.epam.com', 'collapses to the value, not "Entered"');
});

// ── A row still open when the run settles ───────────────────────────────────

test('a row still open when the run succeeds loses its control and is marked skipped', async () => {
  // The CLI exited 0, so it was not waiting on this row: a Continue left under
  // "Setup complete" would look clickable and do nothing.
  const container = makeEl('div');
  const fakeStartSetup = async ({ onPrompt }) => {
    onPrompt({ kind: 'list', id: 'provider', message: 'Choose your LLM provider:', options: ['A - a', 'B - b'] });
    await tick(0);
    return { profileName: 'default' };
  };
  const view = createSetupView(container, { startSetup: fakeStartSetup, readConfig: okConfig });
  const outcome = await view.start();
  assert.equal(outcome.ok, true);
  const row = findRowById(container, 'provider-1');
  assert.ok(!findControl(row), 'no live control is left behind'); // a boolean: inspecting the stub DOM on failure never finishes
  assert.equal(row.querySelector('.step-icon').textContent, '—', 'marked SKIPPED, not left ACTIVE');
});

// ── EPMCDME-14588: handleReject's cancelled short-circuit + ollamaDown ──────

test('handleReject: cancelSetup()\'s own rejection changes no row and never shows a notice', async () => {
  const container = makeEl('div');
  const noticeCalls = [];
  const fakeStartSetup = async ({ onPrompt }) => {
    await onPrompt({ kind: 'list', id: 'provider', message: 'Choose your LLM provider:', options: ['CodeMie SSO - x'] });
    // submit() leaves a transient "Working…" row on screen right where the
    // cancel arrives -- the strongest witness that handleReject did nothing:
    // without the short-circuit, the transient/lastRowId branches would
    // still convert or mark something.
    throw { step: null, cancelled: true, message: 'setup cancelled', raw: 'whatever' };
  };
  const view = createSetupView(container, {
    startSetup: fakeStartSetup,
    readConfig: okConfig,
    showNotice: (...args) => noticeCalls.push(args),
  });
  const startPromise = view.start();
  await Promise.resolve();
  clickContinue(findRowById(container, 'provider-1'));
  await Promise.resolve();
  const working = workingRows(container);
  assert.equal(working.length, 1, 'the transient row is still on screen when the cancel rejection arrives');
  const workingBefore = { icon: working[0].querySelector('.step-icon').textContent, title: working[0].querySelector('.step-title').textContent };
  const providerBefore = findRowById(container, 'provider-1').querySelector('.step-icon').textContent;
  const outcome = await startPromise;
  assert.equal(providerBefore, '✓', 'row already completed from its own answer, before the cancel rejection arrives');
  assert.equal(findRowById(container, 'provider-1').querySelector('.step-icon').textContent, providerBefore, 'a cancel-for-retry never re-marks a row');
  assert.deepEqual(
    { icon: working[0].querySelector('.step-icon').textContent, title: working[0].querySelector('.step-title').textContent },
    workingBefore,
    'the transient row is untouched -- not converted to "Setup stopped"/ERROR',
  );
  assert.equal(outcome.ok, false);
  assert.equal(failureBlocks(container).length, 0, 'a cancel-for-retry is never rendered as a failure');
});

test('handleReject: an ollamaDown driver rejection marks the open row ERROR with the CLI\'s own words', async () => {
  const container = makeEl('div');
  const raw = fixtureLines('ollamaNotRunning').join('\n');
  const err = { step: null, message: 'setup exited with code 1', raw };
  const fakeStartSetup = async ({ onPrompt }) => {
    void onPrompt({ kind: 'input', id: 'credential', message: 'Ollama base URL: (http://localhost:11434)' });
    await tick(0);
    throw err;
  };
  const view = createSetupView(container, { startSetup: fakeStartSetup, readConfig: okConfig });
  const outcome = await view.start();
  assert.equal(outcome.ok, false);
  const row = findRowById(container, 'credential-1');
  assert.equal(row.querySelector('.step-icon').textContent, '✗', 'the ollamaDown-classified row is ERROR');
  assert.equal(row.querySelector('.step-sub').textContent, 'Ollama is not running', 'subtitle is the fixture\'s own anchor text');
});

// ── EPMCDME-14588 Task 4: the flow-stopping notice + "Try again" ───────────

test('an authTimeout screen draws the failure panel, named, with the CLI\'s own reason under it', async () => {
  const container = makeEl('div');
  let capturedOnScreen;
  const fakeStartSetup = async ({ onScreen }) => {
    capturedOnScreen = onScreen;
    return new Promise(() => {}); // never settles in this test
  };
  const view = createSetupView(container, { startSetup: fakeStartSetup, readConfig: okConfig });
  view.start();
  await Promise.resolve();
  assert.equal(typeof capturedOnScreen, 'function', 'run() passed onScreen through to startSetup');

  capturedOnScreen(fixtureLines('authTimeout'));
  const blocks = failureBlocks(container);
  assert.equal(blocks.length, 1, 'exactly one panel for this occurrence');
  const panel = panelOf(blocks[0]);
  // Named, not generic -- our own sentence about what happened and what to do,
  // with the CLI's own words kept underneath it.
  assert.ok(allText(panel).includes('Could not reach CodeMie'));
  assert.ok(allText(panel).includes('VPN'), 'the panel says what to actually do about it');
  assert.ok(allText(panel).includes('Authentication timeout - no response received'), 'the CLI\'s own reason is kept');
  assert.ok(panelButton(blocks[0], 'Try again'), 'the wireframe\'s primary action');
  assert.ok(panelButton(blocks[0], 'Show details'), 'and its secondary');

  // The transcript is collapsed until asked for, and headed by the command.
  const raw = rawOf(blocks[0]);
  assert.ok(raw.classList.contains('hidden'), 'details start collapsed, as drawn');
  const details = panelButton(blocks[0], 'Show details');
  details.onclick();
  assert.equal(raw.classList.contains('hidden'), false, 'Show details actually reveals it');
  assert.equal(details.textContent, 'Hide details', 'and the button says what the next click does');
  assert.ok(raw.textContent.startsWith('$ codemie setup'), 'headed by the command that produced it');
  // ...and back again.
  details.onclick();
  assert.equal(raw.classList.contains('hidden'), true, 'Hide details collapses it');
  assert.equal(details.textContent, 'Show details');

  // The anchor line stays on screen after the flow moves on.
  capturedOnScreen(fixtureLines('authTimeout'));
  assert.equal(failureBlocks(container).length, 1, 'the panel is drawn at most once per occurrence');
});

test('a generic non-ollamaDown rejection also opens exactly one failure notice via handleReject\'s fallthrough', async () => {
  const container = makeEl('div');
  const noticeCalls = [];
  const err = { step: null, message: 'unrecognized prompt, run stalled', raw: '' };
  const fakeStartSetup = async ({ onPrompt }) => {
    await onPrompt({ kind: 'list', id: 'provider', message: 'Choose your LLM provider:', options: ['CodeMie SSO - x'] });
    throw err;
  };
  const view = createSetupView(container, {
    startSetup: fakeStartSetup,
    readConfig: okConfig,
    showNotice: (opts) => noticeCalls.push(opts),
  });
  const startPromise = view.start();
  await Promise.resolve();
  clickContinue(findRowById(container, 'provider-1'));
  const outcome = await startPromise;
  assert.equal(outcome.ok, false);
  assert.equal(failureBlocks(container).length, 1, 'the fallthrough draws the panel for a non-ollamaDown, non-cancelled rejection');
  assert.ok(allText(failureBlocks(container)[0]).includes(err.message), 'no detectFailure match -- falls back to err.message');
});

test('"Try again" cancels the current run, fully awaited, before starting a fresh one', async () => {
  const container = makeEl('div');
  const order = [];
  const err = { step: null, message: 'unrecognized prompt, run stalled', raw: '' };
  let runCount = 0;
  const innerFakeStartSetup = async ({ onPrompt }) => {
    runCount += 1;
    if (runCount === 1) {
      await onPrompt({ kind: 'list', id: 'provider', message: 'Choose your LLM provider:', options: ['CodeMie SSO - x'] });
      throw err;
    }
    return new Promise(() => {}); // the retried run never settles in this test
  };
  const cancelSetup = async () => {
    order.push('cancel-start');
    await Promise.resolve();
    order.push('cancel-done');
    return true;
  };
  let capturedPrimaryAction;
  const view = createSetupView(container, {
    startSetup: (...args) => { order.push('start'); return innerFakeStartSetup(...args); },
    readConfig: okConfig,
    cancelSetup,
  });
  const startPromise = view.start();
  await Promise.resolve();
  clickContinue(findRowById(container, 'provider-1'));
  await startPromise;

  const tryAgain = panelButton(failureBlocks(container)[0], 'Try again');
  assert.equal(typeof tryAgain?.onclick, 'function');
  await tryAgain.onclick();
  assert.deepEqual(order, ['start', 'cancel-start', 'cancel-done', 'start'], 'cancelSetup() resolves before startSetup() is invoked again');
});

test('handleReject\'s fallthrough never re-adds a notice for a cancel-for-retry', async () => {
  const container = makeEl('div');
  const noticeCalls = [];
  const fakeStartSetup = async ({ onPrompt }) => {
    await onPrompt({ kind: 'list', id: 'provider', message: 'Choose your LLM provider:', options: ['CodeMie SSO - x'] });
    throw { step: null, cancelled: true, message: 'setup cancelled', raw: 'whatever' };
  };
  const view = createSetupView(container, {
    startSetup: fakeStartSetup,
    readConfig: okConfig,
    showNotice: (opts) => noticeCalls.push(opts),
  });
  const startPromise = view.start();
  await Promise.resolve();
  clickContinue(findRowById(container, 'provider-1'));
  const outcome = await startPromise;
  assert.equal(outcome.ok, false);
  assert.equal(failureBlocks(container).length, 0, 'still nothing rendered for a cancel-for-retry');
});

// ── EPMCDME-14588 Task 5: capture each answered value for EPMCDME-14656 ────

test('the answers given in a run reach the next run as its replay list', async () => {
  const container = makeEl('div');
  const starts = [];
  const view = createSetupView(container, {
    startSetup: async (cb) => {
      starts.push(cb);
      if (starts.length > 1) return new Promise(() => {});
      const pending = cb.onPrompt({ kind: 'list', id: 'provider', message: 'Choose your LLM provider:', options: ['CodeMie SSO - x', 'Ollama - y'] });
      await tick();
      clickContinue(findRowById(container, 'provider-1')); // submits index 0
      cb.onAnswer({ id: 'provider', kind: 'list', answer: await pending, label: 'CodeMie SSO - x' });
      const named = cb.onPrompt({ kind: 'input', id: 'profileName', message: 'Enter a name for this profile: (sso)' });
      await tick();
      const row = findRowById(container, 'profileName-1');
      findControl(row)._children.find((c) => c.type === 'text').value = 'my-workspace';
      clickContinue(row);
      cb.onAnswer({ id: 'profileName', kind: 'input', answer: await named });
      throw { step: null, message: 'stopped', raw: '' };
    },
    readConfig: okConfig,
    cancelSetup: async () => true,
  });
  await view.start();
  await panelButton(failureBlocks(container)[0], 'Try again').onclick();
  assert.deepEqual(starts[1].replay, [
    { id: 'provider', kind: 'list', answer: 0, label: 'CodeMie SSO - x' },
    { id: 'profileName', kind: 'input', answer: 'my-workspace' },
  ]);
});

// The failure panel the wireframes draw: a red block inside the card, with the
// command's transcript in its own element under it. Replaces the old modal.
const failureBlocks = (container) => (container._children ?? []).filter((c) => c.className === 'failure-block');
const panelOf = (block) => block.querySelector('.failure-panel');
const panelButton = (block, label) => {
  const actions = block.querySelector('.failure-actions');
  return (actions?._children ?? []).find((b) => b.textContent === label);
};
const rawOf = (block) => block.querySelector('.failure-raw');

// ── EPMCDME-14588 review fixes (CR-001 … CR-005) ───────────────────────────

// Rows appear an indeterminate number of microtasks after start(), so a test
// that clicks one must wait for the row itself, not for a fixed tick count.
async function untilRow(container, id, ticks = 50) {
  for (let i = 0; i < ticks; i += 1) {
    const row = findRowById(container, id);
    if (row) return row;
    await Promise.resolve();
  }
  throw new Error(`row ${id} never rendered`);
}

// CR-004. The driver recovers from an auth timeout by dispatching the CLI's own
// re-ask, so the run is still live under the notice and must not be cancelled.
test('the recoverable authTimeout notice never cancels the live run', async () => {
  const container = makeEl('div');
  let capturedOnScreen;
  let capturedPrimary;
  let cancels = 0;
  const view = createSetupView(container, {
    startSetup: async ({ onScreen }) => { capturedOnScreen = onScreen; return new Promise(() => {}); },
    readConfig: okConfig,
    cancelSetup: async () => { cancels += 1; return true; },
  });
  view.start();
  await Promise.resolve();
  capturedOnScreen(fixtureLines('authTimeout'));
  await panelButton(failureBlocks(container)[0], 'Try again').onclick();
  assert.equal(cancels, 0, 'the step underneath is still waiting for an answer; killing the run would lose it');
});

test('a second, unrelated failure still opens its own notice after the first was dismissed', async () => {
  const container = makeEl('div');
  const noticeCalls = [];
  let capturedOnScreen;
  const err = { step: null, message: 'unrecognized prompt, run stalled', raw: '' };
  const view = createSetupView(container, {
    startSetup: async ({ onPrompt, onScreen }) => {
      capturedOnScreen = onScreen;
      await onPrompt({ kind: 'list', id: 'provider', message: 'Choose your LLM provider:', options: ['CodeMie SSO - x'] });
      throw err;
    },
    readConfig: okConfig,
    showNotice: (opts) => noticeCalls.push(opts),
  });
  const startPromise = view.start();
  // The row is rendered several microtasks deep inside onPrompt, so waiting a
  // fixed number of ticks makes this test a race: wait for the row itself.
  const row = await untilRow(container, 'provider-1');
  capturedOnScreen(fixtureLines('authTimeout')); // first failure, notice shown then dismissed
  clickContinue(row);
  await startPromise;
  // One panel at a time: the later failure replaces the earlier one rather than
  // stacking, and it is the later one's words that survive.
  assert.equal(failureBlocks(container).length, 1, 'the panel is replaced, not stacked');
  assert.ok(allText(failureBlocks(container)[0]).includes(err.message), 'the later rejection is not swallowed by the earlier panel');
});

test('a rejection that is not an object does not crash the run', async () => {
  const container = makeEl('div');
  const noticeCalls = [];
  const view = createSetupView(container, {
    startSetup: async () => { throw null; },
    readConfig: okConfig,
    showNotice: (opts) => noticeCalls.push(opts),
  });
  const outcome = await view.start();
  assert.equal(outcome.ok, false, 'the failure is still reported as a handled outcome');
  assert.equal(failureBlocks(container).length, 1);
  assert.ok(allText(failureBlocks(container)[0]).includes('Setup failed'));
});

test('a plain start() replays nothing', async () => {
  const container = makeEl('div');
  const starts = [];
  const view = createSetupView(container, {
    startSetup: async (cb) => { starts.push(cb); throw { step: null, message: 'stopped', raw: '' }; },
    readConfig: okConfig,
    showNotice: () => {},
  });
  await view.start();
  await view.start();
  assert.deepEqual(starts.map((c) => c.replay), [[], []]);
});

// ── EPMCDME-14656 Task 1: replay on Try again ──────────────────────────────

const PROVIDER_PROMPT = { kind: 'list', id: 'provider', message: 'Choose your LLM provider:', options: ['CodeMie SSO - x', 'Ollama - y'] };
const providerAnswer = { id: 'provider', kind: 'list', answer: 0, label: 'CodeMie SSO - x' };

// Runs one failed run that gave `answers`, then clicks Try again and returns
// the callbacks every startSetup call received.
async function failThenRetry({ answers, step = null, screen, extraSteps }) {
  const container = makeEl('div');
  const starts = [];
  const view = createSetupView(container, {
    startSetup: async (cb) => {
      starts.push(cb);
      if (starts.length > 1) return new Promise(() => {});
      for (const a of answers) cb.onAnswer(a);
      if (screen) cb.onScreen(screen);
      if (extraSteps) await extraSteps(cb, container);
      throw { step, message: 'stopped', raw: '' };
    },
    readConfig: okConfig,
    cancelSetup: async () => true,
  });
  await view.start();
  await panelButton(failureBlocks(container)[0], 'Try again').onclick();
  return { starts, container, view };
}

test('try again replays answers given before the failed step', async () => {
  const { starts } = await failThenRetry({
    answers: [providerAnswer],
    step: 'codemieProject',
    extraSteps: async (cb) => {
      cb.onPrompt({ kind: 'list', id: 'codemieProject', message: 'Select your project:', options: ['a'] });
    },
  });
  assert.deepEqual(starts[1].replay, [providerAnswer]);
});

test('try again with an unknown step replays every answer', async () => {
  const second = { id: 'profileName', kind: 'input', answer: 'n' };
  const { starts } = await failThenRetry({ answers: [providerAnswer, second], step: null });
  assert.deepEqual(starts[1].replay, [providerAnswer, second]);
});

test('try again after the profile was saved starts fresh', async () => {
  const { starts } = await failThenRetry({
    answers: [providerAnswer],
    screen: ['\u2714 Profile "x" saved to global config'],
  });
  assert.deepEqual(starts[1].replay, []);
});

test('replay is cut at installClaude', async () => {
  const install = { id: 'installClaude', kind: 'confirm', answer: true };
  const { starts } = await failThenRetry({ answers: [providerAnswer, install, { id: 'profileName', kind: 'input', answer: 'n' }] });
  assert.deepEqual(starts[1].replay, [providerAnswer]);
});

test('replayed prompt renders an answered row identical to a user-answered one', async () => {
  const userC = makeEl('div');
  const userView = createSetupView(userC, {
    startSetup: async ({ onPrompt }) => {
      const p = onPrompt(PROVIDER_PROMPT);
      await tick();
      const row = findRowById(userC, 'provider-1');
      const radios = collectAll(row, (n) => (n.className || '').startsWith('setup-option-card'));
      radios[1].onclick();
      clickContinue(row);
      await p;
      return new Promise(() => {});
    },
    readConfig: okConfig,
  });
  userView.start();
  await tick(5);

  const replayC = makeEl('div');
  const replayView = createSetupView(replayC, {
    startSetup: async (cb) => {
      cb.onReplayed(PROVIDER_PROMPT, 1);
      cb.onAnswer({ id: 'provider', kind: 'list', answer: 1, label: 'Ollama - y' });
      return new Promise(() => {});
    },
    readConfig: okConfig,
  });
  replayView.start();
  await tick(5);

  const a = findRowById(userC, 'provider-1');
  const b = findRowById(replayC, 'provider-1');
  assert.ok(b, 'the replayed prompt has a row');
  assert.ok(b.classList._set.has('collapsed'));
  assert.equal(b.querySelector('.step-icon').textContent, a.querySelector('.step-icon').textContent);
  assert.equal(b.querySelector('.step-title').textContent, a.querySelector('.step-title').textContent);
  assert.equal(b.querySelector('.step-sub').textContent, a.querySelector('.step-sub').textContent);
  assert.equal(b.querySelector('.step-sub').textContent, 'Ollama');
});

test('old run\'s late callbacks do not touch the new run', async () => {
  const container = makeEl('div');
  const starts = [];
  const view = createSetupView(container, {
    startSetup: (cb) => {
      starts.push(cb);
      if (starts.length === 1) return Promise.reject({ step: null, message: 'stopped', raw: '' });
      if (starts.length === 2) return new Promise((_, reject) => { starts.rejectSecond = reject; });
      return new Promise(() => {});
    },
    readConfig: okConfig,
    cancelSetup: async () => true,
  });
  await view.start();
  await panelButton(failureBlocks(container)[0], 'Try again').onclick();
  const [old] = starts;
  old.onPrompt(PROVIDER_PROMPT);
  old.onAnswer(providerAnswer);
  assert.equal(findRowById(container, 'provider-1'), null, 'a stale prompt adds no row');
  starts.rejectSecond({ step: null, message: 'stopped again', raw: '' });
  await tick(5);
  await panelButton(failureBlocks(container)[0], 'Try again').onclick();
  assert.deepEqual(starts[2].replay, [], 'a stale answer is not recorded');
});
// Measured against the real CLI 2026-09-15: after "✖ Ollama is not running" the
// CLI prints its whole install guide, which scrolls the anchor out of the 30-row
// viewport before it exits 1. Classifying only the rejection's own screen
// therefore missed it and showed a bare "setup exited with code 1" notice.
test('an Ollama failure seen on screen is still reported once the exit screen has scrolled past it', async () => {
  const container = makeEl('div');
  const noticeCalls = [];
  let capturedOnScreen;
  const scrolledPast = ['## Documentation', '  - Official website: https://ollama.com', ...Array(28).fill('')];
  const view = createSetupView(container, {
    startSetup: async ({ onPrompt, onScreen }) => {
      capturedOnScreen = onScreen;
      await onPrompt({ kind: 'input', id: 'credential', message: 'Ollama base URL:' });
      capturedOnScreen(fixtureLines('ollamaNotRunning'));
      throw { step: null, message: 'setup exited with code 1', raw: scrolledPast.join('\n') };
    },
    readConfig: okConfig,
    showNotice: (opts) => noticeCalls.push(opts),
  });
  const startPromise = view.start();
  const row = await untilRow(container, 'credential-1');
  inputOf(row).value = 'http://localhost:11434';
  clickContinue(row);
  await startPromise;
  // The notice is the only place the command's raw output is shown, so a
  // run-ending failure opens it even though the step already carries the error.
  const block = failureBlocks(container)[0];
  assert.ok(block, 'the run ended, so the panel offers the raw output and a way back');
  assert.ok(allText(panelOf(block)).includes('Ollama is not running'), 'the CLI\'s own words, not the exit code');
  assert.ok(
    rawOf(block).textContent.includes('ollama serve'),
    'the transcript is the screen that actually showed the failure, not the scrolled-past exit screen',
  );
  // The failure lands on whichever row was in flight -- here the "Working…" row
  // the flow shows after an answer -- not necessarily the answered one.
  const subtitles = (container._children ?? [])
    .filter((el) => el.dataset && el.dataset.id)
    .map((row) => row.querySelector('.step-sub')?.textContent ?? '');
  assert.ok(
    subtitles.includes('Ollama is not running'),
    `a step carries the CLI's own words, not the exit code; saw ${JSON.stringify(subtitles)}`,
  );
});

// The anchor line stays on screen while the CLI keeps printing, and a 30-row
// viewport with no scrollback renumbers every row each time it does. Acting on
// the screen rather than on the transition reopened the notice on top of the
// live prompt, once per row of scroll.
test('the authTimeout notice does not reopen as the screen scrolls under it', async () => {
  const container = makeEl('div');
  const noticeCalls = [];
  let capturedOnScreen;
  const view = createSetupView(container, {
    startSetup: async ({ onScreen }) => { capturedOnScreen = onScreen; return new Promise(() => {}); },
    readConfig: okConfig,
    showNotice: (opts) => noticeCalls.push(opts),
  });
  view.start();
  await Promise.resolve();

  const base = fixtureLines('authTimeout');
  let redrawCount = 0;
  const countPanels = () => { redrawCount += 1; };
  capturedOnScreen(base);
  countPanels();
  assert.equal(failureBlocks(container).length, 1, 'the first sighting draws it');
  // the CLI prints another line: every row shifts up by one, same failure
  capturedOnScreen([...base.slice(1), '']);
  capturedOnScreen([...base.slice(2), '', '']);
  assert.equal(failureBlocks(container).length, 1, 'scrolling is not a new occurrence');

  // the anchor finally leaves the screen, then a later timeout brings it back
  capturedOnScreen(Array(30).fill(''));
  const before = failureBlocks(container)[0];
  capturedOnScreen(base);
  if (failureBlocks(container)[0] !== before) countPanels();
  assert.equal(redrawCount, 2, 'a genuinely new occurrence is reported again');
});

// The authTimeout warning stays on screen after the CLI recovers from it, so a
// later, unrelated rejection carries it in `raw`. Classifying that would title
// the new failure with the old one's words.
test('a recovered authTimeout does not relabel a later, unrelated failure', async () => {
  const container = makeEl('div');
  const noticeCalls = [];
  let capturedOnScreen;
  const view = createSetupView(container, {
    startSetup: async ({ onPrompt, onScreen }) => {
      capturedOnScreen = onScreen;
      capturedOnScreen(fixtureLines('authTimeout')); // reported, and the run carries on
      await onPrompt({ kind: 'list', id: 'provider', message: 'Choose your LLM provider:', options: ['CodeMie SSO - x'] });
      // it later fails for a different reason, with the old warning still on screen
      throw { step: null, message: 'unrecognized prompt, run stalled', raw: fixtureLines('authTimeout').join('\n') };
    },
    readConfig: okConfig,
    showNotice: (opts) => noticeCalls.push(opts),
  });
  const startPromise = view.start();
  const row = await untilRow(container, 'provider-1');
  clickContinue(row);
  await startPromise;
  // The transcript legitimately still shows the old warning; it is the panel's
  // own CLI line that must name the new failure.
  const cli = failureBlocks(container)[0].querySelector('.failure-detail');
  assert.equal(cli.textContent, 'unrecognized prompt, run stalled', 'reported in its own words');
  assert.ok(!cli.textContent.includes('Authentication timeout'), 'not the recovered warning still sitting on the screen');
});

// The CLI's own sentence sits under our title, but only when it says something
// our title does not -- for Ollama the two are word-for-word the same.
test('the panel does not repeat itself when the CLI\'s words match the title', async () => {
  const container = makeEl('div');
  let capturedOnScreen;
  const view = createSetupView(container, {
    startSetup: async ({ onPrompt, onScreen }) => {
      capturedOnScreen = onScreen;
      await onPrompt({ kind: 'input', id: 'credential', message: 'Ollama base URL:' });
      capturedOnScreen(fixtureLines('ollamaNotRunning'));
      throw { step: null, message: 'setup exited with code 1', raw: '' };
    },
    readConfig: okConfig,
  });
  const startPromise = view.start();
  const row = await untilRow(container, 'credential-1');
  inputOf(row).value = 'http://localhost:11434';
  clickContinue(row);
  await startPromise;
  const block = failureBlocks(container)[0];
  assert.equal(panelOf(block).querySelector('.failure-detail'), null, 'no line repeating the title');
  assert.ok(allText(panelOf(block)).includes('Ollama is not running'), 'the title still says it');
});


// The CLI opens the browser and then waits on the user, up to its own 120s
// timeout. A bare spinner for two minutes reads as a hang, so the row says what
// it is waiting for the moment the CLI prints its browser lines.
test('the waiting row says it is waiting on the browser sign-in', async () => {
  const container = makeEl('div');
  let capturedOnScreen;
  const view = createSetupView(container, {
    startSetup: async ({ onScreen }) => { capturedOnScreen = onScreen; return new Promise(() => {}); },
    readConfig: okConfig,
  });
  view.start();
  await Promise.resolve();

  const waitingRow = () => (container._children ?? []).find((c) => c.dataset?.id?.startsWith('working-'));
  assert.equal(waitingRow().querySelector('.step-title').textContent, 'Working…', 'before the browser opens it is a plain gap');

  const screen = Array(30).fill('');
  screen[10] = 'Opening browser for authentication...';
  screen[11] = '  If browser does not open, visit: https://codemie.lab.epam.com/code-assistant-api/v1/auth/login/61575';
  capturedOnScreen(screen);

  const row = waitingRow();
  assert.equal(row.querySelector('.step-title').textContent, 'Waiting for you to finish signing in');
  assert.match(row.querySelector('.step-sub').textContent, /browser tab should have opened/i);
  // Not a countdown: the wait is the user's own, so nothing implies a deadline.
  assert.ok(!/\d+\s*(s|sec|second)/i.test(row.querySelector('.step-sub').textContent), 'no timer in the copy');
});

// Measured in a first run on 2026-09-23: the CLI's "Opening browser" line stays
// on its screen after the sign-in is done, and every later gap (fetching the
// project list, saving) was titled "Waiting for you to finish signing in"
// again. The line counts once, when it first appears.
test('a later gap is not titled as the sign-in wait just because the old line is still on screen', async () => {
  const container = makeEl('div');
  let capturedOnScreen;
  let onPromptFn;
  const view = createSetupView(container, {
    startSetup: async ({ onScreen, onPrompt }) => { capturedOnScreen = onScreen; onPromptFn = onPrompt; return new Promise(() => {}); },
    readConfig: okConfig,
  });
  view.start();
  await Promise.resolve();
  const screen = Array(30).fill('');
  screen[10] = 'Opening browser for authentication...';
  capturedOnScreen(screen);
  // The sign-in is done: the next question arrives, and is answered.
  const pending = onPromptFn({ kind: 'list', id: 'codemieProject', message: 'Select your project:', options: ['a', 'b'] });
  await tick();
  clickContinue(findRowById(container, 'codemieProject-1'));
  await pending;
  // A new gap opens while the old browser line is still on the CLI's screen.
  capturedOnScreen(screen);
  const gaps = (container._children ?? []).filter((c) => c.dataset?.id?.startsWith('working-'));
  const last = gaps[gaps.length - 1];
  assert.equal(last.querySelector('.step-title').textContent, 'Working…');
});

// A 41-model list made the setup screen a long page with Continue at its
// bottom. A long list scrolls inside its own box; Continue stays under it.
test('a long list scrolls in its own box with Continue outside it; a short one does not', async () => {
  for (const [count, boxed] of [[12, true], [3, false]]) {
    const container = makeEl('div');
    const options = Array.from({ length: count }, (_, i) => `model-${i}`);
    let control = null;
    const fakeStartSetup = async ({ onPrompt }) => {
      const pending = onPrompt({ kind: 'list', id: 'model', message: 'Choose a model', options });
      await tick();
      control = findControl(findRowById(container, 'model-1'));
      clickContinue(findRowById(container, 'model-1'));
      await pending;
      return { profileName: 'default' };
    };
    const view = createSetupView(container, { startSetup: fakeStartSetup, readConfig: okConfig });
    await view.start();
    const box = control._children.find((c) => c.className === 'setup-option-scroll');
    assert.equal(!!box, boxed, `${count} options`);
    if (boxed) {
      assert.equal(collectAll(box, (c) => (c.className || '').split(' ').includes('setup-option-card')).length, count);
      assert.ok(control._children.some((c) => c.className === 'prompt-submit'), 'Continue is outside the box');
    }
  }
});

// Setup is opened from Home's checklist or its Profile card, and the next step
// is back there: a verified run returns to Home by itself, a failed one stays
// on its Try again.
test('a finished setup goes back to Home by itself; a failed one stays', async () => {
  let doneCalls = 0;
  const container = makeEl('div');
  const view = createSetupView(container, { startSetup: async () => ({ profileName: 'default' }), readConfig: okConfig, onDone: () => { doneCalls += 1; }, doneDelayMs: 0 });
  await view.start();
  const going = container._children.find((c) => c.className === 'setup-view-redirect');
  assert.ok(going, 'it says where it is going');
  assert.ok(going._children.some((c) => c.textContent === 'Taking you back to Home…'));
  await tick(5);
  assert.equal(doneCalls, 1);

  let failedDone = 0;
  const failed = makeEl('div');
  const view2 = createSetupView(failed, { startSetup: async () => ({ profileName: 'other' }), readConfig: okConfig, onDone: () => { failedDone += 1; }, doneDelayMs: 0 });
  await view2.start();
  await tick(5);
  assert.equal(failedDone, 0);
  assert.equal(failed._children.find((c) => c.className === 'setup-view-redirect'), undefined);
});

// A question lower down the page (the model step, under five answered rows)
// opened with its Continue below the window. Opening a question scrolls just
// far enough for its Continue to show.
test('opening a question scrolls its Continue into view', async () => {
  const scrolled = [];
  const realCreate = globalThis.document.createElement;
  globalThis.document.createElement = (tag) => {
    const el = realCreate(tag);
    el.scrollIntoView = (opts) => scrolled.push({ className: el.className, opts });
    return el;
  };
  try {
    const container = makeEl('div');
    const fakeStartSetup = async ({ onPrompt }) => {
      const pending = onPrompt({ kind: 'list', id: 'model', message: 'Choose a model', options: ['a', 'b'] });
      await tick();
      clickContinue(findRowById(container, 'model-1'));
      await pending;
      return { profileName: 'default' };
    };
    const view = createSetupView(container, { startSetup: fakeStartSetup, readConfig: okConfig });
    await view.start();
  } finally {
    globalThis.document.createElement = realCreate;
  }
  const cont = scrolled.find((s) => s.className === 'prompt-submit setup-continue-btn' || s.className.includes('prompt-submit'));
  assert.ok(cont, 'Continue was scrolled into view');
  assert.equal(cont.opts.block, 'nearest');
});

// ── EPMCDME-14656 Task 2: clickable answered rows ──────────────────────────

const URL_PROMPT = { kind: 'input', id: 'codemieUrl', message: 'CodeMie organization URL:' };
const PROJECT_PROMPT = { kind: 'list', id: 'codemieProject', message: 'Select your project:', options: ['alpha', 'beta'] };
const MODEL_PROMPT = { kind: 'list', id: 'model', message: 'Select a model:', options: ['m1', 'm2'] };
const SAVED_SCREEN = ['✔ Profile "x" saved to global config'];

const lastRowOf = (container, id) => [...container.children].reverse().find((c) => (c.dataset.id || '').startsWith(`${id}-`));

// Plays the user and the driver for one prompt: asks it, submits through the
// real control, and reports the answer the way the driver does.
async function userAnswers(cb, container, prompt, typed) {
  const pending = cb.onPrompt(prompt);
  await tick();
  const row = lastRowOf(container, prompt.id);
  if (prompt.kind === 'input') findControl(row)._children.find((c) => c.type === 'text').value = typed;
  clickContinue(row);
  const answer = await pending;
  cb.onAnswer({ id: prompt.id, kind: prompt.kind, answer, ...(prompt.kind === 'list' && { label: prompt.options[answer] }) });
}

// A first run that has answered provider, the org URL (rejected once, then
// accepted), and the project, and now waits on the model question. Later runs
// never settle. The first run settles only through `starts.rejectFirst`.
function revisitHarness({ script, cancelSetup } = {}) {
  const container = makeEl('div');
  const starts = [];
  const order = [];
  const view = createSetupView(container, {
    startSetup: (cb) => {
      order.push('start');
      starts.push(cb);
      if (starts.length > 1) return new Promise(() => {});
      return new Promise((resolve, reject) => {
        starts.rejectFirst = reject;
        (script ?? (async () => {
          await userAnswers(cb, container, PROVIDER_PROMPT);
          await userAnswers(cb, container, URL_PROMPT, 'bad');
          await userAnswers(cb, container, { ...URL_PROMPT, message: 'CodeMie organization URL: bad' }, 'good');
          await userAnswers(cb, container, PROJECT_PROMPT);
          cb.onPrompt(MODEL_PROMPT);
        }))(cb, container, reject);
      });
    },
    readConfig: okConfig,
    cancelSetup: cancelSetup ?? (async () => { order.push('cancel'); return true; }),
  });
  return { container, starts, order, view };
}

test('clicking an answered row restarts with the answers before it', async () => {
  const h = revisitHarness();
  h.view.start();
  await tick(20);
  findRowById(h.container, 'codemieProject-1').onclick();
  await tick(5);
  assert.deepEqual(h.order, ['start', 'cancel', 'start']);
  assert.deepEqual(h.starts[1].replay.map((a) => `${a.id}:${a.answer}`), ['provider:0', 'codemieUrl:bad', 'codemieUrl:good']);
});

test('the storage row has no click handler', async () => {
  const h = revisitHarness();
  h.view.start();
  await tick(20);
  const storage = findRowById(h.container, 'storage');
  assert.equal(storage.onclick, undefined);
  assert.ok(!storage.classList._set.has('revisit'));
});

test('rows are not clickable while the install spinner or Working gap shows', async () => {
  const h = revisitHarness({ script: async (cb, container) => { await userAnswers(cb, container, PROVIDER_PROMPT); } });
  h.view.start();
  await tick(20);
  findRowById(h.container, 'provider-1').onclick?.();
  await tick(5);
  assert.deepEqual(h.order, ['start'], 'no cancel, no restart in the Working gap');
});

test('row Enter and Space activate the row like a click', async () => {
  const h = revisitHarness();
  h.view.start();
  await tick(20);
  const row = findRowById(h.container, 'provider-1');
  assert.equal(row.tabIndex, 0);
  const keydown = row._listeners.keydown;
  assert.equal(typeof keydown, 'function');
  let prevented = 0;
  keydown({ key: 'x', preventDefault: () => { prevented += 1; } });
  await tick(2);
  assert.deepEqual(h.order, ['start'], 'other keys do nothing');
  keydown({ key: 'Enter', preventDefault: () => { prevented += 1; } });
  await tick(5);
  assert.deepEqual(h.order, ['start', 'cancel', 'start']);
  assert.equal(prevented, 1);
  assert.equal(h.starts[1].replay.length, 0);
});

test('Space also activates a row', async () => {
  const h = revisitHarness();
  h.view.start();
  await tick(20);
  findRowById(h.container, 'codemieProject-1')._listeners.keydown({ key: ' ', preventDefault() {} });
  await tick(5);
  assert.deepEqual(h.order, ['start', 'cancel', 'start']);
});

test('the profile saved line turns rows off for the rest of the run', async () => {
  const h = revisitHarness();
  h.view.start();
  await tick(20);
  h.starts[0].onScreen(SAVED_SCREEN);
  h.starts[0].onScreen(['something else']);
  findRowById(h.container, 'codemieProject-1').onclick?.();
  await tick(5);
  assert.deepEqual(h.order, ['start']);
});

test('a click during a restart is ignored', async () => {
  let release;
  const held = new Promise((r) => { release = r; });
  const order = [];
  const h = revisitHarness({ cancelSetup: async () => { order.push('cancel'); await held; return true; } });
  h.view.start();
  await tick(20);
  const row = findRowById(h.container, 'codemieProject-1');
  row.onclick();
  row.onclick();
  findRowById(h.container, 'provider-1').onclick();
  await tick(2);
  release();
  await tick(5);
  assert.deepEqual(order, ['cancel']);
  assert.equal(h.starts.length, 2, 'one new run, not three');
});

test('rows before the failed step stay clickable after a failure', async () => {
  const h = revisitHarness({
    script: async (cb, container, reject) => {
      await userAnswers(cb, container, PROVIDER_PROMPT);
      await userAnswers(cb, container, PROJECT_PROMPT);
      cb.onPrompt(MODEL_PROMPT);
      reject({ step: 'model', message: 'stopped', raw: '' });
    },
  });
  await h.view.start();
  findRowById(h.container, 'provider-1').onclick();
  await tick(5);
  assert.deepEqual(h.order, ['start', 'cancel', 'start']);
  assert.deepEqual(h.starts[1].replay, []);
});

test('a cancelled run settling late does not free the slot for a third run', async () => {
  const h = revisitHarness();
  h.view.start();
  await tick(20);
  findRowById(h.container, 'codemieProject-1').onclick();
  await tick(5);
  h.starts.rejectFirst({ step: null, cancelled: true, message: 'setup cancelled', raw: '' });
  await tick(5);
  h.view.start();
  assert.equal(h.starts.length, 2, 'start() joins the new run instead of launching another');
});

test('a reopened input takes clicks, Enter and Space without restarting the run', async () => {
  const h = revisitHarness({
    script: async (cb, container) => {
      await userAnswers(cb, container, PROVIDER_PROMPT);
      await userAnswers(cb, container, URL_PROMPT, 'bad');
      cb.onPrompt({ ...URL_PROMPT, message: 'CodeMie organization URL: bad' });
    },
  });
  h.view.start();
  await tick(20);
  const row = findRowById(h.container, 'codemieUrl-1');
  assert.ok(!row.classList._set.has('collapsed'), 'the row is open again');
  const inside = { closest: (sel) => (sel === '.prompt-control' ? {} : null) };
  const keydown = row._listeners.keydown;
  let prevented = 0;
  const key = (k, target) => keydown({ key: k, target, preventDefault: () => { prevented += 1; } });
  row.onclick({ target: inside });
  key('Enter', inside);
  key(' ', inside);
  row.onclick({});
  key('Enter', {});
  key(' ', {});
  await tick(5);
  assert.deepEqual(h.order, ['start'], 'no cancel, no restart');
  assert.equal(prevented, 0, 'a space can still be typed into the field');
});

test('a row answered twice binds its revisit listeners once', async () => {
  const h = revisitHarness();
  h.view.start();
  await tick(20);
  const row = findRowById(h.container, 'codemieUrl-1');
  let adds = 0;
  const add = row.addEventListener;
  row.addEventListener = (...a) => { adds += 1; return add(...a); };
  h.starts[0].onPrompt({ ...URL_PROMPT, message: 'CodeMie organization URL: good' });
  await tick(2);
  clickContinue(row);
  await tick(5);
  assert.equal(adds, 0, 'no second keydown listener on the same row');
});
