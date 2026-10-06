import test from 'node:test';
import assert from 'node:assert/strict';
import {
  checkInstallSupported, interpretInstallResult, quoteForShell, openDownloadPage,
  createRowStateStore, INSTALL_NOTES,
} from '../install-client.js';

const fake = (res) => async () => res;
const HELP = 'Options:\n  --install-client   install the app first\n';

test('checkInstallSupported passes when the flag is on stdout', async () => {
  assert.deepEqual(await checkInstallSupported(fake({ stdout: HELP, stderr: '' })), { ok: true });
});

test('checkInstallSupported passes when the flag is on stderr only', async () => {
  assert.deepEqual(await checkInstallSupported(fake({ stdout: '', stderr: HELP })), { ok: true });
});

test('checkInstallSupported reports needs-newer-cli for help without the flag', async () => {
  const r = await checkInstallSupported(fake({ stdout: 'Options:\n  --vscode\n', stderr: '' }));
  assert.deepEqual(r, { ok: false, reason: 'needs-newer-cli' });
});

test('checkInstallSupported fails closed on a rejected or empty probe', async () => {
  const rejected = await checkInstallSupported(async () => { throw new Error('ipc'); });
  assert.deepEqual(rejected, { ok: false, reason: 'probe-failed' });
  assert.deepEqual(await checkInstallSupported(fake({ stdout: '', stderr: '' })), { ok: false, reason: 'probe-failed' });
});

test('checkInstallSupported runs the help command exactly once', async () => {
  const calls = [];
  await checkInstallSupported(async (c) => { calls.push(c); return { stdout: HELP }; });
  assert.deepEqual(calls, ['codemie proxy connect --help']);
});

test('interpretInstallResult: exit 0 with Install cancelled shows no error', () => {
  assert.deepEqual(interpretInstallResult({ code: 0, errorLine: null, downloadUrl: null, rawBuffer: 'Install cancelled' }),
    { error: null, downloadUrl: null });
});

test('interpretInstallResult: exit 0 with a ✗ line shows that line', () => {
  assert.equal(interpretInstallResult({ code: 0, errorLine: '✗ connect failed', downloadUrl: null }).error, '✗ connect failed');
});

test('interpretInstallResult: non-zero without ✗ line gives a generic reason', () => {
  assert.equal(interpretInstallResult({ code: 2, errorLine: null, downloadUrl: null }).error, 'Install failed (exit 2).');
});

test('interpretInstallResult keeps the download url only with an error', () => {
  assert.equal(interpretInstallResult({ code: 1, errorLine: '✗ x', downloadUrl: 'https://a/' }).downloadUrl, 'https://a/');
  assert.equal(interpretInstallResult({ code: 0, errorLine: null, downloadUrl: 'https://a/' }).downloadUrl, null);
});

test('quoteForShell escapes single quotes', () => {
  assert.equal(quoteForShell("https://a/b'c"), `'https://a/b'\\''c'`);
});

test('openDownloadPage opens an https url once through runCapture, quoted', async () => {
  const calls = [];
  const ok = await openDownloadPage("https://a/b'c;$(x)", async (c) => { calls.push(c); });
  assert.equal(ok, true);
  assert.deepEqual(calls, [`open ${quoteForShell(new URL("https://a/b'c;$(x)").href)}`]);
  assert.match(calls[0], /^open '.*'$/);
});

test('openDownloadPage never opens http, javascript, garbage or non-strings', async () => {
  const calls = [];
  const rc = async (c) => { calls.push(c); };
  for (const bad of ['http://a/', 'javascript:alert(1)', 'garbage', '', null, undefined, 42, {}]) {
    assert.equal(await openDownloadPage(bad, rc), false);
  }
  assert.equal(calls.length, 0);
});

test('row state store sets, gets, clears per app and replaces old errors', () => {
  const s = createRowStateStore();
  s.set('a', { error: 'one' });
  s.set('b', { note: 'n' });
  s.set('a', { error: 'two' });
  assert.equal(s.get('a').error, 'two');
  s.clear('a');
  assert.equal(s.get('a'), undefined);
  assert.equal(s.get('b').note, 'n');
});

test('INSTALL_NOTES carries the two row messages', () => {
  assert.equal(INSTALL_NOTES['needs-newer-cli'], 'Needs a newer CodeMie CLI');
  assert.equal(INSTALL_NOTES['probe-failed'], 'Could not check the CodeMie CLI version');
});
