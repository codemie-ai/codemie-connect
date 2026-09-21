import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parseUpdateStatus } from '../agents-update-parse.js';

// update-check.txt: a real capture from a live run (stdout only; stderr was
// the spinner text "- Checking for updates...", confirming a stdout-only
// read is clean of it). All three agents report up to date.
const upToDate = readFileSync(fileURLToPath(new URL('fixtures/agents/update-check.txt', import.meta.url)), 'utf8');
// update-check-available.txt: synthetic per its own header comment; Claude
// Code is authored with an available update.
const available = readFileSync(fileURLToPath(new URL('fixtures/agents/update-check-available.txt', import.meta.url)), 'utf8');

test('parses one record per agent from a real up-to-date capture, none updateAvailable', () => {
  const records = parseUpdateStatus(upToDate);
  assert.deepEqual(records, [
    { displayName: 'CodeMie Code', updateAvailable: false },
    { displayName: 'Claude Code', updateAvailable: false },
    { displayName: 'OpenCode CLI', updateAvailable: false },
  ]);
});

test('does not emit a record for the trailing "All agents are up to date!" summary line', () => {
  const records = parseUpdateStatus(upToDate);
  assert.equal(records.some((r) => /up to date/i.test(r.displayName)), false);
});

test('flags the agent whose Latest line says "(update available)"', () => {
  const records = parseUpdateStatus(available);
  assert.deepEqual(records, [
    { displayName: 'CodeMie Code', updateAvailable: false },
    { displayName: 'Claude Code', updateAvailable: true },
    { displayName: 'OpenCode CLI', updateAvailable: false },
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
    .replace('1.18.31 (up to date)', '1.19.0 (update available)')
    .replace('1 update available', '3 updates available');
  assert.deepEqual(
    parseUpdateStatus(everyoneOutdated).map((r) => r.updateAvailable),
    [true, true, true],
  );
});
