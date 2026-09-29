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
    cli: { installed: '', latest: '1.1.0', updateAvailable: true },
    appRunning: false,
    cliRunning: false,
    cliBusy: false,
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

// CR-003: after a CLI update, About showed the pre-update version.
test('cliUpdated replaces the version About read on its visit', async () => {
  const { about } = setup();
  await about.refresh();
  about.cliUpdated('1.1.0');
  about.renderIfShown();
  assert.ok(cliText().includes('1.1.0'));
  assert.ok(!cliText().includes('1.0.0'));
});

// CR-004: `codemie --version` must not run while the CLI is replaced.
test('refresh does not probe the CLI while it is busy, and keeps the known version', async () => {
  const { about, calls } = setup({ shared: { cliBusy: true, cli: { installed: '0.9.0', latest: '', updateAvailable: false } } });
  await about.refresh();
  assert.equal(calls.probe, 0);
  assert.ok(cliText().includes('0.9.0'));
});

test('startUpdate(cli) waits for an in-flight probe, and its late result is dropped', async () => {
  const probe = deferred();
  const check = deferred();
  const { about } = setup({ probe: () => probe.promise, check: () => check.promise });
  const refreshed = about.refresh();

  let started = false;
  const starting = about.startUpdate('cli').then(() => (started = true));
  await new Promise((r) => setTimeout(r, 5));
  assert.equal(started, false, 'the update waits for `codemie --version` to finish');

  probe.resolve('1.0.0');
  await starting;
  about.cliUpdated('1.1.0');
  check.resolve(null);
  await refreshed;
  assert.ok(cliText().includes('1.1.0'), 'the pre-update probe result does not win');
  assert.ok(!cliText().includes('1.0.0'));
});

// CR-007: About's buttons mirror the banner runs' progress and errors.
test('CLI update progress and failure show on the About button', async () => {
  const { about, s } = setup();
  await about.refresh();
  about.startUpdate('cli');
  about.progress('cli', 'Updating…', true);
  let btn = view._byId('about-cli-update');
  assert.equal(btn.textContent, 'Updating…');
  assert.equal(btn.disabled, true);

  s.cliRunning = false;
  about.fail('cli', 'npm failed');
  btn = view._byId('about-cli-update');
  assert.equal(btn.disabled, false);
  assert.equal(btn.textContent, 'Update to 1.1.0');
  assert.equal(view._byClass('update-error')[0].textContent, 'npm failed');

  await about.startUpdate('cli');
  about.renderIfShown();
  assert.equal(view._byClass('update-error').length, 0, 'a new run clears the old error');
});

test('app update progress and failure show on the About button', async () => {
  const { about, s } = setup({ shared: { app: { latest: '2.2.0', updateAvailable: true } } });
  await about.refresh();
  s.appRunning = true;
  about.progress('app', 'Downloading… 40%', true);
  let btn = view._byId('about-app-update');
  assert.equal(btn.textContent, 'Downloading… 40%');
  assert.equal(btn.disabled, true);

  s.appRunning = false;
  about.fail('app', 'download failed');
  btn = view._byId('about-app-update');
  assert.equal(btn.disabled, false);
  assert.equal(btn.textContent, 'Update to 2.2.0');
  assert.equal(view._byClass('update-error')[0].textContent, 'download failed');
});

test('a hidden About view is not re-rendered', async () => {
  const { about } = setup();
  await about.refresh();
  view.className = 'hidden';
  view.innerHTML = '';
  about.fail('cli', 'npm failed');
  assert.equal(view._children.length, 0);
});
