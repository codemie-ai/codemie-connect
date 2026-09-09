// ui/test/setup-view.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';

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
    },
    remove() {
      const p = el._parent;
      if (p) p._children = p._children.filter((c) => c !== el);
    },
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

globalThis.document = { createElement: (tag) => makeEl(tag) };

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
const { createSetupView, deriveRowTitle, stripHint, renderOptionCards } = await import('../setup-view.js');

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

  const view = createSetupView(container, { startSetup: fakeStartSetup, readConfig: okConfig });
  await view.start();

  assert.ok(sawStorageRowBeforeStart, 'storage row exists and is COMPLETE before startSetup is invoked');
  const storageRow = findRowById(container, 'storage');
  assert.ok(storageRow, 'storage row is present');
  assert.equal(storageRow.querySelector('.step-sub').textContent, 'This computer');
});

test('gate and confirm-kind activate prompts never render a row', async () => {
  const container = makeEl('div');
  const fakeStartSetup = async ({ onPrompt }) => {
    await onPrompt({ kind: 'list', id: 'gate', message: 'Add a new profile?', options: ['create', 'update'] });
    await onPrompt({ kind: 'confirm', id: 'activate', message: 'Activate this profile now?' });
    return { profileName: 'default' };
  };

  const view = createSetupView(container, { startSetup: fakeStartSetup, readConfig: okConfig });
  await view.start();

  assert.equal(findRowById(container, 'gate-1'), null, 'no gate row ever appears');
  assert.equal(findRowById(container, 'activate-1'), null, 'no activate row ever appears');
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
  const input = control._children.find((c) => c.type === 'text');
  input.value = 'sk-test';
  const submitBtn = control._children.find((c) => c.className === 'prompt-submit');
  submitBtn.onclick();

  await startPromise;
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
  let gateAnswer;
  const fakeStartSetup = async ({ onPrompt }) => {
    gateAnswer = await onPrompt({ kind: 'list', id: 'gate', message: 'What would you like to do?', options: ['Add a new profile', 'Cancel'] });
    activateAnswer = await onPrompt({ kind: 'confirm', id: 'activate', message: 'Switch to profile "x" as active?' });
    return { profileName: 'default' };
  };

  const view = createSetupView(container, { startSetup: fakeStartSetup, readConfig: okConfig });
  await view.start();
  assert.equal(activateAnswer, true, 'activate is confirmed, matching setup-driver.js AUTO_CONFIRM');
  assert.equal(gateAnswer, 0);
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
  assert.equal(before.sub, 'Install failed');
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
