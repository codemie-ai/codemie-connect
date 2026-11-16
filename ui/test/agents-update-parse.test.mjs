import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parseUpdateStatus } from '../agents-update-parse.js';

// update-check.txt: a real capture from a live run (stdout only; stderr was
// the spinner text "- Checking for updates...", confirming a stdout-only
// read is clean of it). All three agents report up to date.
const upToDate = readFileSync(fileURLToPath(new URL('fixtures/agents/update-check.txt', import.meta.url)), 'utf8');
// update-check-available.txt: a real capture too (stdout only, 2026-09-23),
// taken the day OpenCode CLI 1.18.32 was out and 1.18.31 installed.
const available = readFileSync(fileURLToPath(new URL('fixtures/agents/update-check-available.txt', import.meta.url)), 'utf8');

test('parses one record per agent from a real up-to-date capture, none updateAvailable', () => {
  const records = parseUpdateStatus(upToDate);
  assert.deepEqual(records, [
    { displayName: 'CodeMie Code', updateAvailable: false, current: '0.15.2', latest: '0.15.2' },
    { displayName: 'Claude Code', updateAvailable: false, current: '2.1.269', latest: '2.1.269' },
    { displayName: 'OpenCode CLI', updateAvailable: false, current: '1.18.31', latest: '1.18.31' },
  ]);
});

test('does not emit a record for the trailing "All agents are up to date!" summary line', () => {
  const records = parseUpdateStatus(upToDate);
  assert.equal(records.some((r) => /up to date/i.test(r.displayName)), false);
});

test('flags the agent whose Latest line says "(update available)", with the version it offers', () => {
  const records = parseUpdateStatus(available);
  assert.deepEqual(records, [
    { displayName: 'CodeMie Code', updateAvailable: false, current: '0.15.2', latest: '0.15.2' },
    { displayName: 'Claude Code', updateAvailable: false, current: '2.1.269', latest: '2.1.269' },
    { displayName: 'OpenCode CLI', updateAvailable: true, current: '1.18.31', latest: '1.18.32' },
  ]);
});

test('does not emit a record for the trailing summary / tip lines', () => {
  const records = parseUpdateStatus(available);
  assert.equal(records.length, 3);
  assert.equal(records.some((r) => /available/i.test(r.displayName)), false);
  assert.equal(records.some((r) => /Run 'codemie update'/i.test(r.displayName)), false);
});

// The CLI writes "1 update available" and "2 updates available" (its
// update.js builds the plural with `update${n > 1 ? 's' : ''}`), never the
// literal "update(s)". A stop pattern that only matched the latter would
// never fire on real output; one that matched the words anywhere would fire
// on a record's own "(update available)" line and drop every agent after the
// first one with an update.
test('stops at the real summary wording, singular and plural, and not at a record line', () => {
  const twoUpdates = available.replace('1 update available', '2 updates available');
  assert.equal(parseUpdateStatus(twoUpdates).length, 3);

  const everyoneOutdated = available
    .replace('0.15.2 (up to date)', '0.16.0 (update available)')
    .replace('2.1.269 (up to date)', '2.2.0 (update available)')
    .replace('1 update available', '3 updates available');
  assert.deepEqual(
    parseUpdateStatus(everyoneOutdated).map((r) => r.updateAvailable),
    [true, true, true],
  );
});

// update-check-newer.txt is synthetic: the real update-check.txt capture with
// only Claude's versions changed (Current 2.1.290 above Latest 2.1.281, still
// "(up to date)"), the state where the user runs a newer Claude than CodeMie supports.
test('reads Current next to Latest, so an installed version above the supported one is visible', () => {
  const newer = readFileSync(fileURLToPath(new URL('fixtures/agents/update-check-newer.txt', import.meta.url)), 'utf8');
  const claude = parseUpdateStatus(newer).find((r) => r.displayName === 'Claude Code');
  assert.equal(claude.current, '2.1.290');
  assert.equal(claude.latest, '2.1.281');
  assert.equal(claude.updateAvailable, false);
});
