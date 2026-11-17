import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  storageCard, changeLocationBody, changeDialogView, canContinue, defaultMode, formatBytes, removeOldBody, useDefaultBody, ACK_LABEL,
} from '../workspace/settings-storage.js';
import { dataLocation, folderCheck, LOCATIONS, CHECKS } from './fixtures/workspace-fixture.mjs';

const DEFAULT_ROOT = '/Users/taylor/Library/Application Support/com.epam.codemie.installer/workspace';
const DRIVE_ROOT = '/Volumes/Work Drive/Projects/CodeMie Connect Data';
const LOGS = '/Users/taylor/Library/Logs/CodeMie';
const count = (html, re) => (html.match(new RegExp(re, 'g')) || []).length;
const radio = (html, mode) => new RegExp(`<input[^>]*name="data-mode"[^>]*value="${mode}"[^>]*>`).exec(html)?.[0] || '';
const submit = footer => /<button[^>]*type="submit"[^>]*>/.exec(footer)?.[0] || '';
const flow = (report, extra = {}) => ({ step: 'check', report, picked: '/Volumes/Work Drive/Projects', mode: defaultMode(report), acknowledged: false, info: dataLocation('default'), ...extra });

test('the contract fixtures are the ones the Rust test writes', () => {
  for (const name of LOCATIONS) assert.ok(dataLocation(name).dataRoot, name);
  for (const name of CHECKS) assert.ok(Array.isArray(folderCheck(name).modes), name);
});

test('sizes read like Finder', () => {
  assert.equal(formatBytes(0), 'Zero KB');
  assert.equal(formatBytes(512), '512 bytes');
  assert.equal(formatBytes(48_234_496), '48.2 MB');
  assert.equal(formatBytes(115_343_360), '115 MB');
  assert.equal(formatBytes(1_099_511_627_776), '1.1 TB');
  assert.equal(formatBytes(2_000_000_000), '2 GB');
});

test('storage_card_shows_paths_size_and_chip', () => {
  const html = storageCard(dataLocation('default'));
  assert.match(html, /id="data-location-path"/);
  assert.ok(html.includes(`id="data-location-path">${DEFAULT_ROOT}<`), 'the data folder path');
  assert.match(html, /48\.2 MB/);
  assert.match(html, /ws-badge[^"]*"[^>]*>Default</);
  assert.doesNotMatch(html, />Custom</);
  // Private sign-in data and logs, each with its path and Show in Finder.
  assert.match(html, /Private sign-in data/);
  assert.match(html, /never moves/);
  assert.ok(html.includes(LOGS), 'the logs path');
  for (const which of ['data', 'private', 'logs']) assert.match(html, new RegExp(`data-action="data-reveal"[^>]*data-which="${which}"`), which);
  assert.match(html, /data-action="data-copy-path"/);
  assert.match(html, /data-action="data-change"/);
  // The default folder offers no switch back to itself and has no old copy.
  assert.doesNotMatch(html, /data-action="data-default"/);
  assert.doesNotMatch(html, /data-action="data-remove-old"/);
  assert.doesNotMatch(html, /data-which="previous"/);

  const custom = storageCard(dataLocation('custom'));
  assert.ok(custom.includes(`id="data-location-path">${DRIVE_ROOT}<`));
  assert.match(custom, /ws-badge[^"]*"[^>]*>Custom</);
  assert.match(custom, /data-action="data-default"/);
  assert.doesNotMatch(custom, /data-action="data-remove-old"/);
  assert.doesNotMatch(custom, /previous data folder/);
});

test('the old copy a move left can be removed; any other previous folder is only shown', () => {
  const copied = storageCard(dataLocation('custom-copied'));
  assert.match(copied, /data-action="data-remove-old"/);
  assert.match(copied, /Old copy/);
  assert.ok(copied.includes(DEFAULT_ROOT));
  assert.match(copied, /data-which="previous"/);

  // Ruling R20: after "Use the default folder", adopting or starting empty, the previous folder
  // may hold newer data: it is named, never offered for removal.
  for (const name of ['custom-adopted', 'default-previous']) {
    const html = storageCard(dataLocation(name));
    assert.doesNotMatch(html, /data-action="data-remove-old"/, name);
    assert.match(html, /Your previous data folder is still at/, name);
    assert.match(html, /data-which="previous"/, name);
    assert.ok(html.includes(dataLocation(name).previous), name);
  }
  // A copy that is gone is not mentioned.
  const gone = storageCard({ ...dataLocation('custom-copied'), previousExists: false });
  assert.doesNotMatch(gone, /data-remove-old|Old copy|previous data folder/);
});

test('the card says when it is loading, failed or restarting, and escapes paths', () => {
  assert.match(storageCard(null), /ws-spinner/);
  const failed = storageCard(null, { error: 'Connect is removing the old copy of your data. Try again in a moment.' });
  assert.match(failed, /removing the old copy/);
  assert.match(failed, /data-action="data-refresh"/);
  const restarting = storageCard(dataLocation('custom'), { restarting: true });
  assert.match(restarting, /Restarting/);
  assert.match(restarting, /<button[^>]*data-action="data-change"[^>]*disabled/);
  const odd = storageCard({ ...dataLocation('default'), dataRoot: '/Users/<b>x</b>' });
  assert.ok(odd.includes('/Users/&lt;b&gt;x&lt;/b&gt;'));
  assert.doesNotMatch(odd, /<b>x/);
});

test('change_dialog_lists_issues_and_disables_continue', () => {
  const cloud = folderCheck('cloud');
  const body = changeLocationBody(cloud, { mode: defaultMode(cloud) });
  assert.ok(body.includes(cloud.issues[0].message), 'the native sentence');
  assert.match(body, /iCloud Drive syncs that folder, and syncing can damage the workspace database\./);
  assert.match(body, /isn’t synced/, 'what to do instead');
  assert.equal(count(body, 'name="data-mode"'), 0, 'no choices for an unusable folder');
  assert.equal(defaultMode(cloud), null);
  assert.equal(canContinue(cloud, { mode: null }), false);
  const view = changeDialogView(flow(cloud));
  assert.match(submit(view.footer), /disabled/);
  assert.match(view.footer, /Continue/);
  assert.match(view.body, /data-action="data-choose"/, 'choose another folder from here');

  const network = changeLocationBody(folderCheck('network'), {});
  assert.match(network, /network drive \(SMB\)/);
  assert.match(network, /SMB/);

  // Too little room for a move: the numbers, Move off, and nothing chosen for the user.
  const tight = folderCheck('tight');
  const short = changeLocationBody(tight, { mode: defaultMode(tight) });
  assert.match(short, /There isn’t enough free space on that disk to move your data\./);
  assert.match(short, /72 MB free/);
  assert.match(short, /115 MB/);
  assert.match(radio(short, 'move'), /disabled/);
  assert.doesNotMatch(radio(short, 'fresh'), /disabled/);
  assert.equal(defaultMode(tight), null, 'starting empty is never chosen for the user');
  assert.match(submit(changeDialogView(flow(tight)).footer), /disabled/);
  assert.doesNotMatch(submit(changeDialogView(flow(tight, { mode: 'fresh' })).footer), /disabled/);
  // A mode the folder doesn't allow never continues.
  assert.equal(canContinue(tight, { mode: 'move' }), false);
});

test('change_dialog_offers_adopt_only_with_marker', () => {
  const ok = folderCheck('ok');
  const plain = changeLocationBody(ok, { mode: defaultMode(ok) });
  assert.ok(radio(plain, 'move'));
  assert.ok(radio(plain, 'fresh'));
  assert.equal(radio(plain, 'adopt'), '');
  assert.equal(defaultMode(ok), 'move', 'Move my data is the default');
  assert.match(radio(plain, 'move'), /checked/);
  assert.match(plain, /Move my data/);
  assert.match(plain, /keeps the old copy until you remove it/);
  assert.match(plain, /Start empty there/);
  assert.ok(plain.includes(DRIVE_ROOT), 'where the data would live');
  assert.match(plain, /APFS · 1\.1 TB free/);
  assert.match(plain, /48\.2 MB/);
  assert.doesNotMatch(submit(changeDialogView(flow(ok)).footer), /disabled/);

  for (const name of ['existing', 'existing-data']) {
    const report = folderCheck(name);
    const html = changeLocationBody(report, { mode: defaultMode(report) });
    assert.ok(radio(html, 'adopt'), name);
    assert.match(radio(html, 'adopt'), /checked/, name);
    assert.equal(radio(html, 'move'), '', name);
    assert.equal(radio(html, 'fresh'), '', name);
    assert.match(html, /Use the Connect data already there/, name);
    assert.match(html, /Nothing is copied or overwritten/, name);
    assert.match(html, /2026/, `${name}: when that data was created`);
    assert.ok(html.includes('/Volumes/Work Drive/Archive/CodeMie Connect Data'), name);
  }
});

test('exfat_requires_acknowledgement_checkbox', () => {
  const exfat = folderCheck('exfat');
  const html = changeLocationBody(exfat, { mode: 'move' });
  assert.ok(html.includes(ACK_LABEL));
  assert.equal(ACK_LABEL, 'I understand others with access to this drive can read my workspace');
  assert.match(html, /<input[^>]*type="checkbox"[^>]*name="data-ack"/);
  assert.match(html, /This exFAT drive has no file permissions/);
  assert.equal(canContinue(exfat, { mode: 'move', acknowledged: false }), false);
  assert.equal(canContinue(exfat, { mode: 'move', acknowledged: true }), true);
  assert.match(submit(changeDialogView(flow(exfat)).footer), /disabled/);
  assert.doesNotMatch(submit(changeDialogView(flow(exfat, { acknowledged: true })).footer), /disabled/);
  // The tick survives a re-render.
  assert.match(changeLocationBody(exfat, { mode: 'move', acknowledged: true }), /name="data-ack"[^>]*checked/);
  // No checkbox where it isn't needed.
  assert.doesNotMatch(changeLocationBody(folderCheck('ok'), { mode: 'move' }), /data-ack/);
});

test('from the recovery page the dialog says moving needs the workspace, and offers the rest', () => {
  const pick = changeDialogView({ step: 'pick', recovery: true });
  assert.match(pick.body, /can’t copy your data from here/);
  assert.match(pick.body, /data-action="data-choose"/);
  const report = folderCheck('recovery');
  const html = changeLocationBody(report, { recovery: true, mode: defaultMode(report) });
  assert.match(radio(html, 'move'), /disabled/);
  assert.match(html, /your workspace isn’t open/i);
  assert.doesNotMatch(radio(html, 'fresh'), /disabled|checked/);
  assert.doesNotMatch(html, /your data 0/);
  const view = changeDialogView({ step: 'check', recovery: true, report, mode: null });
  assert.match(submit(view.footer), /disabled/);
});

test('each step of the change dialog says where it is and what happens next', () => {
  const ok = folderCheck('ok');
  const pick = changeDialogView({ step: 'pick', info: dataLocation('default') });
  assert.match(pick.subtitle, /Step 1 of 3/);
  assert.match(pick.body, /CodeMie Connect Data/);
  assert.match(pick.body, /sign-in data/);
  assert.doesNotMatch(pick.footer, /type="submit"/, 'the folder button is the next step');
  assert.match(changeDialogView({ step: 'checking' }).body, /ws-spinner/);
  assert.match(changeDialogView(flow(ok)).subtitle, /Step 2 of 3/);

  const confirm = changeDialogView(flow(ok, { step: 'confirm' }));
  assert.match(confirm.subtitle, /Step 3 of 3/);
  assert.match(confirm.body, /Connect will restart/);
  assert.ok(confirm.body.includes(DRIVE_ROOT));
  assert.ok(confirm.body.includes(DEFAULT_ROOT), 'where the old copy stays');
  assert.match(confirm.footer, /Move and restart/);
  assert.match(confirm.footer, /data-action="data-back"/);
  for (const [mode, label] of [['adopt', 'Use it and restart'], ['fresh', 'Start empty and restart']]) {
    const report = mode === 'adopt' ? folderCheck('existing') : ok;
    const view = changeDialogView(flow(report, { step: 'confirm', mode }));
    assert.match(view.footer, new RegExp(label), mode);
    assert.match(view.body, /Connect will restart/, mode);
  }

  const working = changeDialogView(flow(ok, { step: 'working' }));
  assert.match(working.body, /Copying your data…/);
  assert.equal(working.busy, true);
  assert.equal(working.footer, '', 'nothing to press while it runs');
  assert.match(changeDialogView(flow(ok, { step: 'restarting' })).body, /Restarting Connect…/);

  // The native sentence comes back inline; a busy guard reads as "not now", not as a failure.
  const failed = changeDialogView(flow(ok, { step: 'confirm', error: { code: 'io', message: 'Connect couldn’t copy your plugins: disk full.' } }));
  assert.match(failed.body, /ws-error[^>]*role="alert"[^]*couldn’t copy your plugins/);
  const busy = changeDialogView(flow(ok, { step: 'confirm', error: { code: 'busy', message: 'Connect is removing the old copy of your data. Try again in a moment.' } }));
  assert.match(busy.body, /ws-warning[^>]*role="alert"[^]*removing the old copy/);
  assert.doesNotMatch(busy.body, /ws-error/);
});

test('remove and switch-back confirmations name the folder and what they do', () => {
  const copied = dataLocation('custom-copied');
  const remove = removeOldBody(copied);
  assert.ok(remove.includes(DEFAULT_ROOT));
  assert.match(remove, /48\.2 MB/);
  assert.match(remove, /This can’t be undone\./);
  assert.match(remove, /sign-in data/, 'what stays');
  const back = useDefaultBody(dataLocation('custom'));
  assert.ok(back.includes(DEFAULT_ROOT));
  assert.ok(back.includes(DRIVE_ROOT));
  assert.match(back, /Data there may be older or empty\./);
  assert.match(back, /Nothing is moved or copied/);
});
