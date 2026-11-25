// Reads by revision: a delta from native's `changes_since` applied to the snapshot the window
// holds (ui/workspace/changes.js), against the contract fixture written by changes.rs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { applyChanges, recordKey } from '../workspace/changes.js';

const fixture = JSON.parse(readFileSync(new URL('./fixtures/contract/changes-since.json', import.meta.url)));
/** Records and jobs in key order: two answers compare whatever order they came in. */
const sorted = answer => ({
  ...answer,
  snapshot: {
    ...answer.snapshot,
    records: [...answer.snapshot.records].sort((a, b) => recordKey(a).localeCompare(recordKey(b))),
    jobs: [...answer.snapshot.jobs].sort((a, b) => String(a.id).localeCompare(String(b.id))),
  },
});

test('applyChanges brings the fixture’s before to its after', () => {
  const next = applyChanges(fixture.before, fixture.delta);
  assert.deepEqual(sorted(next), sorted(fixture.after));
  // The snapshot it came from stays as it was.
  assert.ok(fixture.before.snapshot.records.some(r => r.id === 'task-gone'));
});

test('a reset delta gives null', () => {
  assert.equal(applyChanges(fixture.before, { reset: true }), null);
  assert.equal(applyChanges(null, fixture.delta), null);
});

test('jobs stay newest first and at most 300; a whole list replaces them', () => {
  const job = (id, dueAt) => ({ id, dueAt, kind: 'sync', state: 'queued' });
  const before = { ...fixture.before, snapshot: { ...fixture.before.snapshot, jobs: Array.from({ length: 300 }, (_, i) => job(`j${i}`, i)) } };
  const delta = { ...fixture.delta, jobs: [job('new', 1000)], removedJobs: [], jobsAll: false };
  const jobs = applyChanges(before, delta).snapshot.jobs;
  assert.equal(jobs.length, 300);
  assert.equal(jobs[0].id, 'new');
  assert.ok(!jobs.some(j => j.id === 'j0'), 'the oldest drops out');
  const all = applyChanges(before, { ...delta, jobs: [job('only', 5)], jobsAll: true }).snapshot.jobs;
  assert.deepEqual(all.map(j => j.id), ['only']);
});

test('automation runs come whole when a delta replaces their kind', () => {
  const run = (id, at) => ({ id, kind: 'automation_run', connectionId: null, workspaceId: 'personal', updatedAt: at, data: {} });
  const before = { ...fixture.before, snapshot: { ...fixture.before.snapshot, records: [...fixture.before.snapshot.records, run('old', 1)] } };
  const next = applyChanges(before, { ...fixture.delta, records: [run('newer', 2)], removed: [], replace: ['automation_run'] });
  assert.deepEqual(next.snapshot.records.filter(r => r.kind === 'automation_run').map(r => r.id), ['newer']);
});
