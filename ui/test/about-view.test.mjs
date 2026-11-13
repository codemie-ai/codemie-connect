// ui/test/about-view.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';

// Minimal DOM stub, same shape as ui/test/health-ui.test.mjs.
function makeEl(tag) {
  const el = {
    _tag: tag,
    _children: [],
    className: '',
    textContent: '',
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
    _click() {
      if (el._onclick) el._onclick();
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

globalThis.document = { createElement: (tag) => makeEl(tag) };

const { renderAbout, GITHUB_URL, SUPPORT_MAILTO } = await import('../about-view.js');

const base = {
  appVersion: '1.4.0',
  appLatest: '',
  appUpdateAvailable: false,
  appRunning: false,
  appError: '',
  cliVersion: '0.9.1',
};

function render(model = {}, handlers = {}) {
  const c = makeEl('div');
  renderAbout(c, { ...base, ...model }, handlers);
  return c;
}

test('title and the three section headings', () => {
  const c = render();
  assert.equal(c._byClass('health-title')[0].textContent, 'About CodeMie Connect');
  assert.deepEqual(
    c._byClass('health-group-heading').map((h) => h.textContent),
    ['Version information', 'Resources', 'Support'],
  );
});

test('both installed versions are shown, empty ones as "Not available"', () => {
  let text = render()._innerText();
  assert.ok(text.includes('CodeMie Connect') && text.includes('1.4.0'));
  assert.ok(text.includes('CodeMie CLI') && text.includes('0.9.1'));
  text = render({ appVersion: '', cliVersion: '' })._innerText();
  assert.equal(text.split('Not available').length - 1, 2);
});

test('the app update button exists only when an update is known, and runs it', () => {
  assert.equal(render()._byId('about-app-update'), null);
  let ran = 0;
  const c = render({ appUpdateAvailable: true, appLatest: '1.5.0' }, { onUpdateApp: () => (ran += 1) });
  const btn = c._byId('about-app-update');
  assert.equal(btn.textContent, 'Update to 1.5.0');
  btn._click();
  assert.equal(ran, 1);
});

test('the CLI row has no update button: the CLI comes with the app update', () => {
  const c = render({ appUpdateAvailable: true, appLatest: '1.5.0' });
  assert.equal(c._byId('about-cli-update'), null);
  assert.equal(c._all().filter((e) => e._tag === 'button' && /Update/.test(e.textContent)).length, 1);
});

test('a running update shows a disabled "Updating…" button', () => {
  const btn = render({ appUpdateAvailable: true, appLatest: '1.5.0', appRunning: true })._byId('about-app-update');
  assert.equal(btn.textContent, 'Updating…');
  assert.equal(btn.disabled, true);
});

test('an update error is shown in its row', () => {
  const c = render({ appUpdateAvailable: true, appLatest: '1.5.0', appError: 'download failed' });
  assert.equal(c._byClass('update-error')[0].textContent, 'download failed');
});

test('each link is a card with a friendly title, description and button, opening the exact URL', () => {
  const opened = [];
  const c = render({}, { onOpenLink: (u) => opened.push(u) });
  const cards = c._byClass('about-card').filter((k) => k._byClass('about-link').length);
  assert.deepEqual(cards.map((k) => k._byClass('about-card-title')[0].textContent), ['GitHub Repository', 'Request Help']);
  const buttons = cards.map((k) => k._byClass('about-link')[0]);
  assert.deepEqual(buttons.map((b) => b._innerText().trim()), ['Explore', 'Email us']);
  for (const k of cards) {
    assert.ok(k._byClass('about-card-desc')[0].textContent.length > 0, 'every card says what the link is for');
    assert.ok(!/http|@/.test(k._innerText()), 'no raw URL or email as a label');
  }
  buttons.forEach((b) => b._click());
  assert.deepEqual(opened, [GITHUB_URL, SUPPORT_MAILTO]);
  assert.equal(GITHUB_URL, 'https://github.com/codemie-ai/codemie-code#native-bootstrap-installers');
  assert.equal(SUPPORT_MAILTO, 'mailto:AskCodeMie@epam.com');
});

test('the update button sits on the CodeMie Connect card, and its error under that card', () => {
  const c = render({ appUpdateAvailable: true, appLatest: '1.5.0', appError: 'download failed' });
  const app = c._byClass('about-card')[0];
  assert.ok(app._innerText().includes('CodeMie Connect'));
  assert.ok(app._byId('about-app-update'));
  assert.equal(app._byClass('update-error')[0].textContent, 'download failed');
  assert.ok(app._innerText().includes('Version 1.5.0 is available'));
});

test('no documentation link', () => {
  assert.ok(!render({ appUpdateAvailable: true, cliUpdateAvailable: true })._innerText().includes('Documentation'));
});
