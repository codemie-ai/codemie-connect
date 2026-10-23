// ui/test/about-controller.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';

// Minimal DOM stub, same shape as ui/test/about-view.test.mjs.
function makeEl(tag) {
  const el = {
    _tag: tag,
    _children: [],
    className: '',
    textContent: '',
    classList: { contains: (c) => (el.className ?? '').split(' ').includes(c) },
    set onclick(fn) {
      el._onclick = fn;
    },
    appendChild(child) {
      el._children.push(child);
      return child;
    },
    append(...children) {
      children.forEach((c) => el.appendChild(c));
    },
    _all() {
      return el._children.flatMap((c) => [c, ...c._all()]);
    },
    _innerText() {
      const own = el._children.length ? '' : el.textContent;
      return [own, ...el._children.map((c) => c._innerText())].join(' ');
    },
    _byId(id) {
      return el._all().find((c) => c.id === id) ?? null;
    },
    _byClass(cls) {
      return el._all().filter((c) => (c.className ?? '').split(' ').includes(cls));
    },
  };
  Object.defineProperty(el, 'innerHTML', {
    get() {
      return '';
    },
    set() {
      el._children = [];
    },
  });
  return el;
}

let view;
globalThis.document = {
  createElement: (tag) => makeEl(tag),
  getElementById: (id) => view._byId(id),
};

const { createAboutController, mergeAppUpdateCheck } = await import('../about-controller.js');

function deferred() {
  let resolve;
  const promise = new Promise((r) => (resolve = r));
  return { promise, resolve };
}

// Builds a controller over a visible About view. `probe` is what
// `codemie --version` returns; `check` what the forced app check returns.
function setup({ probe = async () => '1.0.0', check = async () => null, shared = {} } = {}) {
  view = makeEl('div');
  const s = {
    app: { latest: null, updateAvailable: false },
    appRunning: false,
    ...shared,
  };
  const calls = { probe: 0, check: null };
  const about = createAboutController({
    view,
    handlers: {},
    invoke: async (cmd) => (cmd === 'get_app_version' ? '2.1.0' : false),
    inspector: {
      checkCodemieVersion: () => {
        calls.probe += 1;
        return probe();
      },
    },
    updater: {
      checkForAppUpdate: (...args) => {
        calls.check = args;
        return check();
      },
    },
    shared: () => s,
  });
  return { about, s, calls };
}

const cliText = () => view._innerText();

test('mergeAppUpdateCheck records a found version', () => {
  const state = { latest: null, updateAvailable: false };
  mergeAppUpdateCheck(state, { status: 'fulfilled', value: '2.0.0' });
  assert.deepEqual(state, { latest: '2.0.0', updateAvailable: true });
});

test('mergeAppUpdateCheck: null or a failed re-check keeps a known update', () => {
  for (const settled of [{ status: 'fulfilled', value: null }, { status: 'rejected', reason: new Error('offline') }]) {
    const state = { latest: '2.0.0', updateAvailable: true };
    mergeAppUpdateCheck(state, settled);
    assert.deepEqual(state, { latest: '2.0.0', updateAvailable: true });
  }
});

test('refresh: a throttled re-check keeps the update button a banner already found', async () => {
  const { about, s } = setup({ check: async () => null, shared: { app: { latest: '2.2.0', updateAvailable: true } } });
  await about.refresh();
  assert.deepEqual(s.app, { latest: '2.2.0', updateAvailable: true });
  assert.equal(view._byId('about-app-update').textContent, 'Update to 2.2.0');
});

test('refresh: shows the probed CLI version', async () => {
  const { about, calls } = setup();
  await about.refresh();
  assert.ok(cliText().includes('1.0.0'));
  assert.deepEqual(calls.check, [true], 'About forces the app update check');
});

// CR-007: About's button mirrors the banner run's progress and errors.
test('app update progress and failure show on the About button', async () => {
  const { about, s } = setup({ shared: { app: { latest: '2.2.0', updateAvailable: true } } });
  await about.refresh();
  s.appRunning = true;
  about.progress('Downloading… 40%', true);
  let btn = view._byId('about-app-update');
  assert.equal(btn.textContent, 'Downloading… 40%');
  assert.equal(btn.disabled, true);

  s.appRunning = false;
  about.fail('download failed');
  btn = view._byId('about-app-update');
  assert.equal(btn.disabled, false);
  assert.equal(btn.textContent, 'Update to 2.2.0');
  assert.equal(view._byClass('update-error')[0].textContent, 'download failed');

  about.startUpdate();
  about.renderIfShown();
  assert.equal(view._byClass('update-error').length, 0, 'a new run clears the old error');
});

test('the CLI row shows its version and no update button: it comes with the app update', async () => {
  const { about } = setup();
  await about.refresh();
  assert.ok(cliText().includes('1.0.0'));
  assert.equal(view._byId('about-cli-update'), null);
});

test('an offline visit still shows both installed versions and no update', async () => {
  const { about, s } = setup({ check: async () => { throw new Error('offline'); } });
  await about.refresh();
  assert.ok(cliText().includes('2.1.0') && cliText().includes('1.0.0'));
  assert.equal(s.app.updateAvailable, false);
  assert.equal(view._byId('about-app-update'), null);
});

test('a hidden About view is not re-rendered', async () => {
  const { about } = setup();
  await about.refresh();
  view.className = 'hidden';
  view.innerHTML = '';
  about.fail('download failed');
  assert.equal(view._children.length, 0);
});

// The versions waited for the online update check, so About said "Not
// available" for both until it answered. They show as soon as they are read;
// until then the cards say "Checking…".
test('the installed versions show before the online update check answers', async () => {
  const pending = deferred();
  const { about } = setup({ check: () => pending.promise });
  const done = about.refresh();
  assert.ok(cliText().includes('Checking…'));
  assert.ok(!cliText().includes('Not available'));
  await new Promise((r) => setTimeout(r, 0));
  assert.ok(cliText().includes('2.1.0') && cliText().includes('1.0.0'));
  pending.resolve(null);
  await done;
});
