import { test } from 'node:test';
import assert from 'node:assert/strict';
import { recoveryPage, recoverySentence, firstReport, USE_DEFAULT_WARNING } from '../workspace/recovery.js';

const custom = (status, extra = {}) => ({
  status,
  dataRoot: '/Volumes/Work/CodeMie Connect Data',
  privateRoot: '/Users/qa/Library/Application Support/connect/workspace',
  defaultRoot: '/Users/qa/Library/Application Support/connect/workspace',
  custom: true,
  ...extra,
});

test('recovery_page_offers_retry_and_default', () => {
  const html = recoveryPage(custom('missing'));
  assert.match(html, /data-action="recovery-retry"/);
  assert.match(html, />Retry</);
  assert.match(html, /data-action="recovery-default"/);
  assert.match(html, />Use the default folder</);
  assert.ok(html.includes(USE_DEFAULT_WARNING), 'the default-folder warning is on the page');
  assert.equal(USE_DEFAULT_WARNING, 'Data there may be older or empty.');
  assert.ok(html.includes(recoverySentence(custom('missing'))));
  assert.ok(html.includes('/Volumes/Work/CodeMie Connect Data'), 'the folder path is shown');
  assert.ok(html.includes('/Users/qa/Library/Application Support/connect/workspace'), 'the default folder is named');
  // Choose another folder arrives with Task 13: no dead button meanwhile.
  assert.doesNotMatch(html, /Choose another folder/);
  // The CodeMie tools stay reachable while the workspace is down.
  assert.match(html, /data-action="recovery-tools"/);
});

test('each folder status says what happened in its own sentence', () => {
  const statuses = ['missing', 'no_marker', 'marker_mismatch', 'not_writable', 'pointer_unreadable', 'ready'];
  const sentences = statuses.map(s => recoverySentence(custom(s)));
  assert.equal(new Set(sentences).size, statuses.length, sentences.join(' | '));
  for (const s of sentences) assert.match(s, /^[A-Z][^.]*\.$/, `one sentence: ${s}`);
  assert.equal(recoverySentence(custom('pointer_unreadable')), 'Connect couldn’t read where your data is kept.');
});

test('an unreadable pointer names the location file and offers the default folder', () => {
  const html = recoveryPage(custom('pointer_unreadable', { custom: false, dataRoot: '/Users/qa/Library/Application Support/connect/workspace' }));
  assert.match(html, /Location file/);
  assert.ok(html.includes('/Users/qa/Library/Application Support/connect/workspace/location.json'));
  assert.match(html, /data-action="recovery-default"/);
});

test('a default folder that did not open offers retry only and says why', () => {
  const html = recoveryPage({ ...custom('ready', { custom: false }), dataRoot: '/Users/qa/ws', issue: 'Another Connect process owns this workspace. Return to its window.' });
  assert.match(html, /data-action="recovery-retry"/);
  assert.doesNotMatch(html, /data-action="recovery-default"/);
  assert.doesNotMatch(html, new RegExp(USE_DEFAULT_WARNING));
  assert.match(html, /Another Connect process owns this workspace/);
});

test('a native issue always shows; the failing call\u2019s message only when nothing else explains it', () => {
  // A full disk is more precise than "can't save": it shows under the folder sentence.
  const full = recoveryPage(custom('not_writable', { issue: 'The disk that holds your data folder is full.' }));
  assert.match(full, /The disk that holds your data folder is full\./);
  assert.ok(full.includes(recoverySentence(custom('not_writable'))));
  // The generic message of the call that failed adds nothing under a folder-level sentence.
  const missing = recoveryPage(custom('missing', { cause: 'Workspace storage is unavailable; existing tools are still accessible.' }));
  assert.doesNotMatch(missing, /existing tools are still accessible/);
  // With no folder-level explanation, the failing call's message is the best there is.
  const ready = recoveryPage(custom('ready', { custom: false, cause: 'The disk that holds Connect\u2019s data folder is full.' }));
  assert.match(ready, /data folder is full/);
  // A native issue wins over the cause.
  const both = recoveryPage(custom('ready', { issue: 'Newer schema.', cause: 'Connect lost access to its data folder.' }));
  assert.match(both, /Newer schema\./);
  assert.doesNotMatch(both, /lost access/);
});

test('once a restart is accepted, Retry and Use the default folder stay disabled', () => {
  const html = recoveryPage(custom('missing', { restarting: true }));
  assert.match(html, /<button[^>]*data-action="recovery-retry"[^>]*disabled/);
  assert.match(html, /<button[^>]*data-action="recovery-default"[^>]*disabled/);
  assert.match(html, /Restarting…/);
  assert.doesNotMatch(recoveryPage(custom('missing')), /disabled/);
});

test('one failure reported twice reaches the recovery page once', () => {
  const first = firstReport();
  const err = { code: 'storage_unavailable', message: 'Connect lost access to its data folder.' };
  assert.equal(first(err), true);
  assert.equal(first(err), false, 'the rethrown error is not reported again');
  assert.equal(first({ ...err }), true, 'a new failure is');
  assert.equal(first('plain string'), true);
  assert.equal(first(null), true);
});

test('paths and issues are escaped and a missing status still renders', () => {
  const html = recoveryPage(custom('ready', { dataRoot: '/tmp/<img src=x onerror=alert(1)>', issue: '<b>disk</b>' }));
  assert.doesNotMatch(html, /<img/);
  assert.doesNotMatch(html, /<b>disk/);
  assert.match(html, /&lt;img/);
  const bare = recoveryPage(null);
  assert.match(bare, /data-action="recovery-retry"/);
  assert.doesNotMatch(bare, /data-action="recovery-default"/);
});
