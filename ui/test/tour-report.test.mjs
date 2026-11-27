// The real-app tour's HTML report (design docs/superpowers/specs/2026-11-24-real-app-tour-design.md
// § 8): `renderReport` is pure, so these drive it directly over small fixtures, never a real run.
import test from 'node:test';
import assert from 'node:assert/strict';
import { renderReport } from '../../scripts/tour/report.mjs';

const PASS_CHECK = { name: 'a check', pass: true, detail: '' };
const FAIL_CHECK = { name: 'a check', pass: false, detail: 'it failed' };

function stop(id, { step = [1], pass = true, covers = [], menuBar, next, checks } = {}) {
  return {
    id, step, title: `Stop ${id}`, route: '#/x', view: 'default', theme: 'light', width: 1440,
    checks: checks ?? [pass ? PASS_CHECK : FAIL_CHECK],
    capture: { blank: false }, error: null, pass, covers, menuBar, next,
  };
}

function results(stops, extra = {}) {
  return {
    runId: 'run-1', sha: 'abc1234', startedAt: '2026-11-24T00:00:00Z', finishedAt: '2026-11-24T00:05:00Z',
    binary: { path: '/tmp/app', mtime: '2026-11-24T00:00:00Z' },
    stops, ops: ['snapshot'], refused: [], pass: stops.every(s => s.pass),
    failed: stops.filter(s => !s.pass).map(s => `${s.id}: failed`),
    ...extra,
  };
}

const BUILT = { id: 'f.built', step: 1, text: 'A built feature', spec: 'spec.md', status: 'built' };
const BROWSER = {
  id: 'f.browser', step: 2, text: 'A browser feature', spec: 'spec.md', status: 'browser',
  reason: 'It is a real send.', browserCheck: { file: 'ui/test/browser/x-checks.mjs', check: 'x R1', set: 'x' },
};
const PLANNED = { id: 'f.planned', step: 8, text: 'A planned feature', spec: 'spec.md', status: 'planned' };

test('coverage rows are green, red, amber and grey by status and stop results', () => {
  const passing = stop('T01', { pass: true, covers: ['f.built'] });
  const failing = stop('T02', { step: [1], pass: false, covers: ['f.built'] });
  const html = renderReport(results([passing]), {}, [BUILT, BROWSER, PLANNED]);
  assert.match(html, /<tr class="cov-green"/);
  assert.match(html, /<tr class="cov-amber"/);
  assert.match(html, /<tr class="cov-grey"/);
  // A built feature whose only stop failed is red, not green.
  const htmlFailed = renderReport(results([failing]), {}, [BUILT]);
  assert.match(htmlFailed, /<tr class="cov-red"/);
  assert.doesNotMatch(htmlFailed, /<tr class="cov-green"/);
});

test('screenshots are inline data URIs and the file has no <script and no http', () => {
  const s = stop('T01', { covers: ['f.built'] });
  const png = Buffer.from([1, 2, 3]).toString('base64');
  const html = renderReport(results([s]), { T01: png }, [BUILT]);
  assert.match(html, new RegExp(`data:image/png;base64,${png}`));
  assert.doesNotMatch(html, /<script/i);
  assert.doesNotMatch(html, /http/i);
});

test('text is escaped', () => {
  const s = stop('T01', {
    covers: ['f.built'],
    checks: [{ name: 'a check', pass: false, detail: '<img onerror=alert(1)>' }],
  });
  const html = renderReport(results([s]), {}, [BUILT]);
  assert.doesNotMatch(html, /<img onerror/);
  assert.match(html, /&lt;img onerror=alert\(1\)&gt;/);
});

test('sections are grouped by rollout step 0..7 in order', () => {
  const s0 = stop('T01', { step: [0] });
  const s7 = stop('T02', { step: [7] });
  const html = renderReport(results([s0, s7]), {}, []);
  const at0 = html.indexOf('Step 0');
  const at7 = html.indexOf('Step 7');
  assert.ok(at0 >= 0 && at7 >= 0, html);
  assert.ok(at0 < at7, 'step 0 must come before step 7');
  const i0 = html.indexOf('T01');
  const i7 = html.indexOf('T02');
  assert.ok(at0 < i0 && i0 < at7, 'T01 is under its own step 0 section');
  assert.ok(at7 < i7, 'T02 is under its own step 7 section');
});

test('the menu bar section says Computed state, not a screenshot', () => {
  const mb = stop('T28', {
    step: [6],
    menuBar: {
      tray: false,
      applied: { title: '2', amber: true, tooltipLength: 10, rows: 1 },
      computed: { count: 2, label: '2', amber: true },
      rowTexts: ['Replies: 2'],
    },
  });
  const html = renderReport(results([mb]), {}, []);
  assert.match(html, /Computed state, not a screenshot: the tray can't be captured without the desktop\./);
  assert.match(html, /Replies: 2/);
});

test('the header shows the sha with +dirty', () => {
  const s = stop('T01');
  const html = renderReport(results([s], { sha: 'abc1234+dirty' }), {}, []);
  assert.match(html, /CodeMie Connect · real-app tour · abc1234\+dirty/);
});

test('refusals show by stop in the Refused list and on their stop, expected ones marked', () => {
  const s = stop('T27', { covers: ['f.built'] });
  const refused = [
    { stop: 'T27', kind: 'native', name: 'graph_connect', message: 'The tour opens nothing.', expected: true },
    { stop: null, kind: 'native', name: 'relaunch', message: 'The tour opens nothing.' },
  ];
  const html = renderReport(results([s], { refused }), {}, [BUILT]);
  const list = html.slice(html.indexOf('<h3>Refused</h3>'));
  assert.match(list, /<li class="pass">T27 · native graph_connect — The tour opens nothing\. \(expected\)<\/li>/);
  assert.match(list, /<li class="fail">between stops · native relaunch — The tour opens nothing\.<\/li>/);
  assert.doesNotMatch(list, /\(none\)/);
  const article = html.slice(html.indexOf('<article'), html.indexOf('</article>'));
  assert.match(article, /Refused: native graph_connect — The tour opens nothing\. \(expected\)/);
});

test('every step present in STOPS gets a report section with its stops', async () => {
  const { STOPS } = await import('../workspace/tour/script.js');
  const steps = [...new Set(STOPS.flatMap(s => s.step))].sort((a, b) => a - b);
  assert.ok(steps.includes(8), 'step 8 has stops');
  const html = renderReport(results(STOPS.map(s => stop(s.id, { step: s.step }))), {}, []);
  for (const step of steps) assert.match(html, new RegExp(`<h2>Step ${step}</h2>`), `step ${step}`);
  for (const id of ['T62', 'T70']) assert.ok(html.includes(id), id);
});
