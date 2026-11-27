// The tour seed builder (scripts/tour/seed.mjs, Task 4 of the real-app tour plan): what Node
// builds from the browser run's own fixture builders and contract JSON for
// commands::tour::seed::import (src-tauri/src/commands/tour/seed.rs, Task 3) to write into a
// fresh workspace.sqlite.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { buildSeed, copySkills, SEED_IDS } from '../../scripts/tour/seed.mjs';

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

test('commitments are both Local and Todoist, Local spanning more than one Board column', () => {
  const { seed } = buildSeed(TEST_DIR, NOW);
  const commitments = seed.records.filter(r => r.kind === 'commitment');
  const local = commitments.filter(r => !r.data.provider);
  const todoist = commitments.filter(r => r.data.provider === 'plugin:todoist');
  assert.ok(local.length > 0, 'no Local commitments: the Board, List and By-date "Local" views would be empty');
  assert.ok(todoist.length > 0, 'no Todoist commitments: the provider screens would be empty');
  const localStatuses = new Set(local.map(r => r.data.status));
  assert.ok(localStatuses.size > 1, `Local tasks sit in only one column/status: ${[...localStatuses]}`);
});

test("SEED_IDS all exist in the seed's records", () => {
  const { seed } = buildSeed(TEST_DIR, NOW);
  for (const [name, id] of Object.entries(SEED_IDS)) {
    // The Ask ids name threads, which the seed holds in `ask`.
    const held = name.startsWith('ask') ? seed.ask.threads.some(t => t.id === id) : seed.records.some(r => r.id === id);
    assert.ok(held, `${name} -> "${id}" is missing from the seed`);
  }
});

test('the CLI refuses a non-empty folder', () => {
  const dir = mkdtempSync(join(tmpdir(), 'tour-seed-cli-'));
  writeFileSync(join(dir, 'already-here.txt'), 'x');
  const result = spawnSync(process.execPath, [SCRIPT, dir]);
  assert.equal(result.status, 1);
});

test('the seed installs hello, the Todoist stand-in, Digest and Knowledge, their sheets agreed to, and a task due in 20 days', () => {
  const { seed } = buildSeed('/tmp/connect-tour-x/workspace', NOW);
  assert.deepEqual(seed.plugins.map(p => p.id), ['hello', 'todoist', 'digest', 'knowledge']);
  const [hello, todoist, digest] = seed.plugins;
  assert.deepEqual(todoist.agreed, ['network', 'provides_tasks'], 'Todoist provides tasks');
  const manifest = JSON.parse(todoist.files['echo-plugin.json']);
  assert.deepEqual(manifest.settings.map(x => [x.key, x.type]), [['token', 'secret'], ['project', 'string'], ['label', 'string']]);
  assert.ok(!JSON.stringify(todoist).includes('tk_'), 'no token value in the seed');
  assert.deepEqual(digest.agreed, ['claude'], 'Digest agreed to Claude');
  assert.equal(hello.id, 'hello');
  assert.equal(hello.version, '1.0.0');
  assert.deepEqual(Object.keys(hello.files).sort(), ['client.js', 'echo-plugin.json', 'main.js']);
  assert.deepEqual(hello.agreed, ['network', 'signin']);
  const later = seed.records.find(r => r.id === 'commit-2');
  assert.equal(later.data.provider, 'plugin:todoist');
  assert.equal(later.data.due, new Date(NOW + 20 * 86_400_000).toISOString().slice(0, 10));
});

test('a critical rule makes the seeded critical message Critical in native terms too', () => {
  const { seed } = buildSeed('/tmp/connect-tour-x/workspace', NOW);
  const critical = seed.records.find(r => r.id === SEED_IDS.critical);
  const rules = seed.records.filter(r => r.kind === 'rule');
  assert.equal(rules.length, 1);
  const [rule] = rules;
  assert.equal(rule.workspaceId, 'personal');
  assert.equal(rule.connectionId, null);
  assert.equal(rule.data.lane, 'critical');
  assert.equal(rule.data.enabled, true);
  assert.equal(rule.data.sender, critical.data.fromAddress);
  assert.ok(critical.data.title.toLowerCase().includes(rule.data.keyword.toLowerCase()));
});

test('the seed chooses Knowledge with facts and holds a ready copy with no secret', () => {
  const dir = '/tmp/connect-tour-x/workspace';
  const { seed } = buildSeed(dir, NOW);
  assert.deepEqual(seed.settings.voice, { provider: 'plugin:knowledge', facts: true });
  assert.deepEqual(seed.voice.available, [{ id: 'plugin:knowledge', name: 'Knowledge', on: true, ready: true, facts: true }]);
  const { style, rules, people } = seed.voice.copy;
  assert.equal(rules.length, 6);
  assert.equal(people.length, 3);
  assert.ok(style.text.startsWith('Short and direct.') && style.head.source === 'people/me.md', 'the ready style card and its head');
  for (const p of people) assert.ok(p.text, `${p.id} has a profile text`);
  assert.ok(people.find(p => p.id === 'priya-n').about, 'Priya has an about text');
  assert.ok(people.find(p => p.id === 'marek-novak').ids.length === 1 && !people.find(p => p.id === 'marek-novak').addresses.length, 'Marek is Teams only');
  const text = JSON.stringify(seed.voice);
  assert.ok(!/token|secret|password/i.test(text), 'no secret in the voice seed');
  const addresses = text.match(/[\w.+-]+@[\w.-]+/g) || [];
  assert.ok(addresses.length > 0 && addresses.every(a => a.endsWith('@example.test')), `addresses: ${addresses}`);
  // The import stops scan a copy of the invented skills fixture inside the test folder, beside
  // Meetings: runner.js finds it from the meetings root.
  assert.equal(seed.voice.skillsFolder, join(dir, 'voice-skills'));
  assert.equal(seed.voice.skillsFolder, join(dirname(seed.settings.meetings.root), 'voice-skills'));
  const knowledge = seed.plugins.find(p => p.id === 'knowledge');
  assert.deepEqual(knowledge.agreed, ['claude', 'folders', 'provides_reply-context']);
  assert.equal(JSON.parse(knowledge.files['echo-plugin.json']).settings, undefined, 'no settings values');
});

test('Elena\'s mail holds a draft in your voice, and Inbox triage left one from the copy in the group chat', () => {
  const { seed } = buildSeed('/tmp/connect-tour-x/workspace', NOW);
  const mail = seed.records.find(r => r.kind === 'draft' && r.data.sourceId === SEED_IDS.voiceMail);
  assert.equal(mail.id, `ai:${SEED_IDS.voiceMail}`);
  assert.equal(mail.data.draftKey, SEED_IDS.voiceMail);
  assert.equal(mail.data.aiSuggested, true);
  assert.equal(mail.data.provenance.voice.examples, 2);
  assert.deepEqual(mail.data.provenance.voice.facts.map(f => f.title), ['Atlas rollout', 'EPM-1234']);
  const chat = seed.records.find(r => r.kind === 'draft' && r.data.sourceId === SEED_IDS.groupChat);
  assert.equal(chat.data.draftKey, 'chat:chat:chat-group');
  assert.equal(chat.data.provenance.automationId, 'auto-triage');
  assert.ok(seed.records.some(r => r.kind === 'automation' && r.id === 'auto-triage'));
  assert.equal(chat.data.provenance.voice.from, 'copy');
  assert.equal(chat.data.provenance.voice.factsMissed, true);
  assert.ok(chat.data.provenance.voice.at <= chat.data.provenance.at, 'the copy is from before the draft');
  assert.deepEqual(chat.data.provenance.voice.facts, []);
  // The Jordan 1:1 and the Priya mail keep their boxes: T05 checks the "✦ draft with AI" hint,
  // T55's Nudge fills Priya's reply.
  for (const id of [SEED_IDS.teams1to1, SEED_IDS.priyaMail]) assert.ok(!seed.records.some(r => r.kind === 'draft' && r.data.sourceId === id), id);
});

test('the CLI copies the invented skills folder into the test folder', () => {
  const dir = join(mkdtempSync(join(tmpdir(), 'tour-seed-cli-')), 'workspace');
  const result = spawnSync(process.execPath, [SCRIPT, dir]);
  assert.equal(result.status, 0, String(result.stderr));
  for (const skill of ['broken', 'budget-answers', 'deploy-helper', 'long-standard', 'meeting-notes', 'reply-style']) {
    assert.ok(existsSync(join(dir, 'voice-skills', skill, 'SKILL.md')), `${skill} copied`);
  }
});

test('copying the skills folder skips symlinks, so nothing outside it comes along', () => {
  const root = mkdtempSync(join(tmpdir(), 'tour-skills-'));
  const outside = join(root, 'outside');
  mkdirSync(outside);
  writeFileSync(join(outside, 'SKILL.md'), 'outside');
  const from = join(root, 'skills');
  mkdirSync(join(from, 'reply-style'), { recursive: true });
  writeFileSync(join(from, 'reply-style', 'SKILL.md'), 'inside');
  symlinkSync(outside, join(from, 'linked'));
  symlinkSync(join(outside, 'SKILL.md'), join(from, 'reply-style', 'extra.md'));
  const to = join(root, 'copy');
  copySkills(from, to);
  assert.ok(existsSync(join(to, 'reply-style', 'SKILL.md')));
  assert.ok(!existsSync(join(to, 'linked')), 'a linked folder is skipped');
  assert.ok(!existsSync(join(to, 'reply-style', 'extra.md')), 'a linked file is skipped');
});

test('the seed holds three Ask threads, one queued ask job, askInMenu true and Ask on Claude Code', () => {
  // Thu 26 Nov 2026: the seed's Friday is the next day.
  const { seed } = buildSeed('/tmp/connect-tour-x/workspace', Date.parse('2026-11-26T10:00:00Z'));
  assert.equal(seed.settings.askInMenu, true);
  assert.deepEqual(seed.settings.ai.routes.ask, { profile: 'claude', model: null, fallback: null });
  const { threads, jobs } = seed.ask;
  assert.deepEqual(threads.map(t => t.id), [SEED_IDS.askDone, SEED_IDS.askFailed, SEED_IDS.askQueued]);
  assert.deepEqual(threads.map(t => t.turns.map(u => u.state)), [['done', 'done'], ['failed', 'stopped'], ['queued']]);
  assert.deepEqual(threads.map(t => t.turns[0].question), ['What did I promise Priya this week?', 'When is the QBR?', 'Who is Marek Novak?']);
  // The done thread: cites on the seeded Priya mail, a meeting and a Todoist task, three actions.
  const [done] = threads;
  const first = done.turns[0];
  const record = (id, kind) => seed.records.find(r => r.id === id && (!kind || r.kind === kind));
  const KIND = { message: 'message', task: 'commitment', meeting: 'meeting' };
  assert.deepEqual(first.cites.map(c => c.kind), ['message', 'task', 'meeting']);
  for (const c of first.cites) assert.ok(record(c.recordId, KIND[c.kind]), `${c.id} names a seeded ${KIND[c.kind]}`);
  assert.equal(first.cites[0].recordId, SEED_IDS.priyaMail);
  assert.equal(record(first.cites[1].recordId).data.provider, 'plugin:todoist');
  for (const c of first.cites) assert.ok(first.answer.includes(`[${c.id}]`), `the answer marks ${c.id}`);
  assert.deepEqual(first.actions.map(a => a.kind), ['task', 'open', 'draft']);
  assert.equal(first.actions[0].due, '2026-11-27');
  assert.equal(first.actions[2].recordId, SEED_IDS.priyaMail);
  assert.equal(first.about.recordId, SEED_IDS.priyaMail);
  assert.ok(first.about.label.startsWith('Priya N. · mail · '));
  assert.equal(done.turns[1].cites.length, 0);
  assert.ok(done.nextRef > first.cites.length);
  // Priya's mail is the one the spec's mock-ups name.
  assert.equal(record(SEED_IDS.priyaMail).data.from, 'Priya N.');
  assert.equal(record(SEED_IDS.priyaMail).data.title, 'Atlas budget');
  const [failed, stopped] = threads[1].turns;
  assert.equal(failed.error.code, 'needs_login');
  assert.equal(stopped.answer, null);
  // The queued turn and its job, which the tour's stopped background loop never claims.
  assert.equal(jobs.length, 1);
  const [job] = jobs;
  const queued = threads[2].turns[0];
  assert.deepEqual({ kind: job.kind, state: job.state, key: job.key, attempts: job.attempts }, { kind: 'ask', state: 'queued', key: `ask:${SEED_IDS.askQueued}`, attempts: 0 });
  assert.equal(queued.jobId, job.id);
  assert.deepEqual({ threadId: job.payload.threadId, turnId: job.payload.turnId, purpose: job.payload.purpose, profile: job.payload.profile }, { threadId: SEED_IDS.askQueued, turnId: queued.id, purpose: 'ask', profile: 'claude' });
  const payload = JSON.stringify(job.payload);
  for (const words of ['Marek', 'answer', 'question']) assert.ok(!payload.includes(words), `the job payload holds "${words}"`);
  const text = JSON.stringify(seed.ask);
  assert.ok(!/token|secret|password/i.test(text), 'no secret in the ask seed');
  const addresses = text.match(/[\w.+-]+@[\w.-]+/g) || [];
  assert.ok(addresses.every(a => a.endsWith('@example.test')), `addresses: ${addresses}`);
});

test('the seed’s Friday is the next one after today, a week on when today is Friday', () => {
  const due = now => buildSeed('/tmp/connect-tour-x/workspace', Date.parse(now)).seed.ask.threads[0].turns[0].actions[0].due;
  assert.equal(due('2026-11-26T10:00:00Z'), '2026-11-27');
  assert.equal(due('2026-11-27T10:00:00Z'), '2026-12-04');
  assert.equal(due('2026-11-29T10:00:00Z'), '2026-12-04');
});

test('Priya has one name across the seed, and Nudge Marek fills a box other than her mail’s', () => {
  const { seed, folders } = buildSeed('/tmp/connect-tour-x/workspace', NOW);
  const all = JSON.stringify(seed) + JSON.stringify(folders);
  assert.ok(!all.includes('Natarajan'), 'the fixture’s full name is left somewhere');
  const sender = id => seed.records.find(r => r.kind === 'message' && r.id === id).data.from;
  assert.equal(sender(SEED_IDS.priyaMail), 'Priya N.');
  assert.equal(sender(SEED_IDS.groupChat), 'Priya N.');
  const marek = seed.records.find(r => r.kind === 'commitment' && r.id === SEED_IDS.checkWithTask);
  assert.notEqual(marek.data.sourceId, SEED_IDS.priyaMail);
  assert.ok(seed.records.some(r => r.kind === 'message' && r.id === marek.data.sourceId), 'its source is a seeded message');
});
