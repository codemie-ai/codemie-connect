// The tour seed builder (scripts/tour/seed.mjs, Task 4 of the real-app tour plan): what Node
// builds from the browser run's own fixture builders and contract JSON for
// commands::tour::seed::import (src-tauri/src/commands/tour/seed.rs, Task 3) to write into a
// fresh workspace.sqlite.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { buildSeed, SEED_IDS } from '../../scripts/tour/seed.mjs';

const NOW = Date.now();
// A plausible absolute test folder: `buildSeed` is pure (touches no file), so this never needs
// to exist on disk for the tests below other than the CLI one.
const TEST_DIR = '/tmp/codemie-tour-seed-test';
const SCRIPT = fileURLToPath(new URL('../../scripts/tour/seed.mjs', import.meta.url));

/** Calls `visit` with every leaf value (not an array or a plain object) reachable from `value`. */
function walkValues(value, visit) {
  if (Array.isArray(value)) {
    value.forEach(v => walkValues(v, visit));
    return;
  }
  if (value && typeof value === 'object') {
    Object.values(value).forEach(v => walkValues(v, visit));
    return;
  }
  visit(value);
}

/** Calls `visit(key, value)` for every key/value pair of every plain object reachable from `value`. */
function walkEntries(value, visit) {
  if (Array.isArray(value)) {
    value.forEach(v => walkEntries(v, visit));
    return;
  }
  if (value && typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) {
      visit(k, v);
      walkEntries(v, visit);
    }
  }
}

test('every path in the seed is inside the test folder', () => {
  const { seed } = buildSeed(TEST_DIR, NOW);
  const offenders = [];
  walkValues(seed, v => {
    if (typeof v === 'string' && v.startsWith('/Users/') && !v.startsWith(TEST_DIR)) offenders.push(v);
  });
  assert.deepEqual(offenders, []);
});

test('no secret, every address on a .test domain', () => {
  const { seed } = buildSeed(TEST_DIR, NOW);
  const secretKeys = [];
  walkEntries(seed, (k) => {
    if (/token|secret|password/i.test(k)) secretKeys.push(k);
  });
  assert.deepEqual(secretKeys, []);
  // Every value shaped exactly like a bare email address (never a sentence that merely mentions
  // one, e.g. a chat's "@Taylor can you...") is on a reserved, synthetic domain — the RFC 2606
  // example domains, or a `.test` TLD — the same invented-domain convention workspace-fixture.mjs
  // and its contract fixtures already use throughout (taylor.morgan@example.test,
  // jeroen.devries@philips.test, ann@example.org), never a real one.
  const SAFE_DOMAIN = /(^|\.)example\.(com|net|org|test)$|\.test$/i;
  const badAddresses = [];
  walkValues(seed, v => {
    if (typeof v !== 'string' || !/^[^\s@]+@[^\s@]+$/.test(v)) return;
    if (!SAFE_DOMAIN.test(v.slice(v.indexOf('@') + 1))) badAddresses.push(v);
  });
  assert.deepEqual(badAddresses, []);
});

test('the seed matches spec § 4', () => {
  const { seed } = buildSeed(TEST_DIR, NOW);
  assert.equal(seed.settings.tasks.provider, 'plugin:todoist');
  assert.deepEqual(seed.settings.menuBar, { replies: true, tasks: true, meetings: true, automations: true });
  assert.equal(seed.seen.since, Math.floor(NOW / 1000) - 86_400);
  assert.deepEqual(seed.settings.meetings.summaryTabs, ['formal-summary', 'short-summary']);
  assert.ok(seed.connections[0].enabled.includes('mail_send'));
  assert.ok(seed.connections[0].enabled.includes('chat_send'));
  assert.deepEqual(seed.provider.available[0], { id: 'plugin:todoist', name: 'Todoist', on: true, ready: true });
  assert.ok(seed.records.some(r => r.kind === 'automation_run' && r.data.status === 'failed'));
  assert.ok(seed.records.some(r => r.kind === 'automation_run' && r.data.fallbackFrom));
});

test("SEED_IDS all exist in the seed's records", () => {
  const { seed } = buildSeed(TEST_DIR, NOW);
  for (const [name, id] of Object.entries(SEED_IDS)) {
    assert.ok(seed.records.some(r => r.id === id), `${name} -> "${id}" is missing from the seed's records`);
  }
});

test('the CLI refuses a non-empty folder', () => {
  const dir = mkdtempSync(join(tmpdir(), 'tour-seed-cli-'));
  writeFileSync(join(dir, 'already-here.txt'), 'x');
  const result = spawnSync(process.execPath, [SCRIPT, dir]);
  assert.equal(result.status, 1);
});
