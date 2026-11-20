// The Analytics page's pure model: local-day ranges sent to the CLI, deltas only from the CLI's
// own `previous`/`change`, the formatters, and the preferences kept in localStorage.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  presetRange, viewRequest, delta, usd, tok, dur, pct, pctPoints, n0, loadPrefs, savePrefs, newAnalyticsView, isStale, startedInConnect, failedDays, failedReason, PREFS_KEY, STALE_MS,
} from '../workspace/analytics-model.js';

const fixture = name => JSON.parse(readFileSync(new URL(`fixtures/contract/${name}`, import.meta.url), 'utf8'));
const summary = fixture('analytics-summary.json');
const status = fixture('analytics-status.json');

test('presets give local-day ISO bounds with the zone offset', () => {
  // Kyiv leaves summer time on 25 Oct: the range starts at +03:00 and ends at +02:00.
  const now = Date.parse('2026-11-19T16:40:00+02:00');
  assert.deepEqual(presetRange('30d', now, 'Europe/Kyiv'), { from: '2026-10-21T00:00:00+03:00', to: '2026-11-19T23:59:59.999+02:00', label: 'Last 30 days', days: 30 });
  assert.equal(presetRange('today', now, 'Europe/Kyiv').from, '2026-11-19T00:00:00+02:00');
  assert.equal(presetRange('7d', now, 'Europe/Kyiv').from, '2026-11-13T00:00:00+02:00');
  assert.equal(presetRange('90d', now, 'Europe/Kyiv').from, '2026-08-22T00:00:00+03:00');
  assert.deepEqual(presetRange('month', now, 'Europe/Kyiv'), { from: '2026-11-01T00:00:00+02:00', to: '2026-11-19T23:59:59.999+02:00', label: 'This month', days: 19 });
  // West of UTC, and a local day that is already the next day in UTC.
  const late = Date.parse('2026-11-19T23:30:00-05:00');
  assert.deepEqual(presetRange('today', late, 'America/New_York'), { from: '2026-11-19T00:00:00-05:00', to: '2026-11-19T23:59:59.999-05:00', label: 'Today', days: 1 });
  assert.equal(presetRange('today', now, 'UTC').to, '2026-11-19T23:59:59.999+00:00');
  // An unknown preset is the default 30 days.
  assert.equal(presetRange('nope', now, 'UTC').label, 'Last 30 days');
});

test('the view request carries the range, the filters that are set and asks for the comparison', () => {
  const now = Date.parse('2026-11-19T16:40:00Z');
  const ui = newAnalyticsView();
  const { from, to } = presetRange(ui.range, now, 'UTC');
  assert.deepEqual(viewRequest(ui, now, 'UTC'), { from, to, compare: true });
  assert.deepEqual(viewRequest({ ...ui, agent: 'claude', project: '/Users/taylor/work/orbit-app' }, now, 'UTC'), { from, to, agent: 'claude', project: '/Users/taylor/work/orbit-app', compare: true });
});

test('a delta is shown only when the CLI sent previous and change', () => {
  // Asked without a comparison (or not stored that far back): no previous, no change, no delta.
  const plain = { ...summary, previous: null, change: null };
  assert.equal(delta(plain, 'costUSD'), null);
  const withPrevious = { ...summary, previous: summary.totals, change: { costUSD: 0.25, sessions: -0.5, durationMs: null } };
  assert.deepEqual(delta(withPrevious, 'costUSD'), { up: true, text: '↑ 25%' });
  assert.deepEqual(delta(withPrevious, 'sessions'), { up: false, text: '↓ 50%' });
  // A field whose previous value was 0 has no change.
  assert.equal(delta(withPrevious, 'durationMs'), null);
  assert.deepEqual(delta({ ...withPrevious, change: { costUSD: 0.004 } }, 'costUSD'), { up: true, text: '↑ <1%' });
  // A change without the previous totals isn't shown either.
  assert.equal(delta({ ...plain, change: { costUSD: 0.25 } }, 'costUSD'), null);
});

test('formatters: usd under a cent, tokens in K/M, durations', () => {
  assert.equal(usd(0.004), '<$0.01');
  assert.equal(usd(0.004, true), '<$0.01');
  assert.equal(usd(0), '$0.00');
  assert.equal(usd(null), '—');
  assert.equal(usd(104.788, true), '$104.79');
  assert.equal(usd(19.4096), '$19.41');
  assert.equal(usd(104.788), '$105');
  assert.equal(usd(1234.5), '$1.2K');
  assert.equal(usd(1234.5, true), '$1,234.50');
  assert.equal(tok(1852), '2K');
  assert.equal(tok(999), '999');
  assert.equal(tok(991029), '991K');
  assert.equal(tok(314986692), '315.0M');
  assert.equal(tok(1.25e9), '1.3B');
  assert.equal(dur(41618), '42 s');
  assert.equal(dur(600000), '10 min');
  assert.equal(dur(34685392), '9 h 38 m');
  assert.equal(dur(46551887), '12 h');
  assert.equal(dur(46551887, true), '12 h 56 m');
  // Shares are fractions; the CLI's rates are already percents.
  assert.equal(pct(0.5922), '59%');
  assert.equal(pct(0.0071), '0.7%');
  assert.equal(pct(null), '—');
  assert.equal(pctPoints(94.8), '94.8%');
  assert.equal(pctPoints(92), '92%');
  assert.equal(pctPoints(null), '—');
  assert.equal(n0(7652), '7,652');
});

test('preferences: the five keys are kept, every read and write survives a broken storage', () => {
  const store = new Map();
  const storage = { getItem: k => store.get(k) ?? null, setItem: (k, v) => store.set(k, v) };
  assert.deepEqual(loadPrefs(storage), { mode: 'ai', view: 'overview', range: '30d', noticeHidden: false, tables: {} });
  savePrefs(storage, { ...newAnalyticsView(), mode: 'app', view: 'sessions', range: '7d', noticeHidden: true, tables: { trend: true }, agent: 'claude', q: 'x' });
  assert.deepEqual(JSON.parse(store.get(PREFS_KEY)), { mode: 'app', view: 'sessions', range: '7d', noticeHidden: true, tables: { trend: true } });
  assert.deepEqual(loadPrefs(storage), { mode: 'app', view: 'sessions', range: '7d', noticeHidden: true, tables: { trend: true } });
  // Values that aren't ours fall back to the defaults.
  store.set(PREFS_KEY, JSON.stringify({ mode: 'x', view: 'y', range: 'z', noticeHidden: 'yes', tables: { trend: 'on', depth: true } }));
  assert.deepEqual(loadPrefs(storage), { mode: 'ai', view: 'overview', range: '30d', noticeHidden: false, tables: { depth: true } });
  store.set(PREFS_KEY, '{not json');
  assert.equal(loadPrefs(storage).range, '30d');
  const broken = { getItem: () => { throw new Error('denied'); }, setItem: () => { throw new Error('denied'); } };
  assert.equal(loadPrefs(broken).mode, 'ai');
  assert.doesNotThrow(() => savePrefs(broken, newAnalyticsView()));
  assert.equal(loadPrefs(null).view, 'overview');
});

test('the data is stale 15 minutes after the last fetch, or when nothing was fetched', () => {
  assert.equal(isStale(status, status.lastFetchAt + STALE_MS - 1), false);
  assert.equal(isStale(status, status.lastFetchAt + STALE_MS + 1), true);
  assert.equal(isStale({ ...status, lastFetchAt: null }, status.lastFetchAt), true);
});

test('sessions started in Connect come from analytics_view\'s connect key, guarded', () => {
  const id = summary.sessions[0].sessionId;
  assert.deepEqual([...startedInConnect({ ...summary, connect: { startedInConnect: [id] } })], [id]);
  const { connect, ...cliOnly } = summary;
  assert.equal(startedInConnect(cliOnly).size, 0);
  assert.equal(startedInConnect({ ...summary, connect: { startedInConnect: 'not a list' } }).size, 0);
  assert.deepEqual([...startedInConnect({ connect: { startedInConnect: [id, 7, null] } })], [id]);
  assert.equal(startedInConnect(null).size, 0);
});

test('failed days come as {day, reason}, and every reason native sends reads as words', () => {
  // The contract fixture's list is in the shape native sends.
  assert.deepEqual(failedDays(status.failedDays), status.failedDays);
  assert.ok(status.failedDays.every(f => typeof f.day === 'string' && typeof f.reason === 'string'));
  assert.deepEqual(failedDays(null), []);
  assert.deepEqual(failedDays([{ day: '2026-11-15', reason: 'timeout' }, null, '2026-11-14', { reason: 'x' }]), [{ day: '2026-11-15', reason: 'timeout' }]);
  assert.equal(failedReason('timeout'), 'took too long');
  assert.equal(failedReason('out_of_memory'), 'ran out of memory');
  assert.equal(failedReason('not_found'), 'no CodeMie CLI found');
  assert.equal(failedReason('bad_output'), 'its answer couldn’t be read');
  assert.equal(failedReason('exit 3'), 'stopped with exit code 3');
  assert.equal(failedReason('exit -1'), 'stopped with exit code -1');
  // Anything else is shown as it came (the view escapes it).
  assert.equal(failedReason('toString'), 'toString');
  assert.equal(failedReason(undefined), '');
});
