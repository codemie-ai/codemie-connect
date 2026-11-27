// The real-app tour's HTML report (design docs/superpowers/specs/2026-11-24-real-app-tour-design.md
// § 8): one self-contained file, `output/tour/<stamp>-<sha>/index.html` — the git SHA and dirty
// flag, the coverage table (§ 7), one section per rollout step with every stop's checks and
// screenshot, and last the ops the tour sent and anything refused. Screenshots are inlined as
// `data:image/png;base64`, the CSS is inline (Connect's light tokens, a `prefers-color-scheme:
// dark` block, system fonts) and there is no external resource and no `<script`.
//
// `renderReport` is pure: everything it needs comes in as arguments, so the JS test drives it
// without a real tour run. The CLI (`node scripts/tour/report.mjs <testDir> <outDir>`) reads
// `<testDir>/tour/results.json` (Rust's own verdict, `src-tauri/src/commands/tour/report.rs`),
// attaches each stop's `covers` from `script.js` (the window's own report has no room for it),
// reads `<testDir>/tour/shots/*.png` and writes `<outDir>/index.html`.
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { escapeHtml } from '../../ui/workspace/store.js';
import { STOPS } from '../../ui/workspace/tour/script.js';
import { FEATURES } from '../../ui/workspace/tour/coverage.js';

const e = escapeHtml;

/** Rollout steps the report's sections cover (design § 6, § 7): every step a stop of
 *  `script.js` belongs to, so a step that adds stops gets its section. */
const STEPS = [...new Set(STOPS.flatMap(s => s.step))].sort((a, b) => a - b);

const COLOUR_LABEL = { green: 'Covered', red: 'Not covered', amber: 'Browser run', grey: 'Planned' };

/**
 * A feature's row in the coverage table (design § 7): green when a passing stop covers it, red
 * with no stop or when every covering stop failed, amber for `browser` (with its reason and the
 * check that covers it), grey for `planned`.
 */
function featureRow(feature, stopsById) {
  if (feature.status === 'planned') {
    return { colour: 'grey', note: 'A later step adds its stops.' };
  }
  if (feature.status === 'browser') {
    const bc = feature.browserCheck || {};
    return {
      colour: 'amber',
      note: `${feature.reason || ''} Covered by ${bc.file || '?'} "${bc.check || '?'}" (set ${bc.set || '?'}).`,
    };
  }
  const covering = (feature.coveredBy || []).map(id => stopsById.get(id)).filter(Boolean);
  if (!covering.length) {
    return { colour: 'red', note: 'No stop covers it.' };
  }
  const passing = covering.filter(s => s.pass);
  if (!passing.length) {
    return { colour: 'red', note: `Failed: ${covering.map(s => s.id).join(', ')}.` };
  }
  return { colour: 'green', note: `Shown by ${passing.map(s => s.id).join(', ')}.` };
}

/** Every stop's `covers` (design § 7: a stop names the feature ids it shows), inverted: each
 *  feature id to the stop ids that name it. Works whether `covers` comes from `script.js` (the
 *  CLI's own attach) or is already on the stop (a test's own fixture). */
function coveredByOf(stops) {
  const out = new Map();
  for (const stop of stops) {
    for (const id of stop.covers || []) {
      if (!out.has(id)) out.set(id, []);
      out.get(id).push(stop.id);
    }
  }
  return out;
}

function renderCoverage(stops, features) {
  const stopsById = new Map(stops.map(s => [s.id, s]));
  const coveredBy = coveredByOf(stops);
  const rows = features.map(f => {
    const row = featureRow({ ...f, coveredBy: coveredBy.get(f.id) || [] }, stopsById);
    return `<tr class="cov-${row.colour}"><td>${e(f.step)}</td><td>${e(f.text)}</td>` +
      `<td>${e(COLOUR_LABEL[row.colour])}</td><td>${e(row.note)}</td></tr>`;
  });
  return `<section><h2>Coverage</h2><table class="cov">` +
    `<thead><tr><th>Step</th><th>Feature</th><th>Status</th><th>Why</th></tr></thead>` +
    `<tbody>${rows.join('')}</tbody></table></section>`;
}

/** One check's row: its name, pass or fail, and its detail when it failed. */
function renderCheck(check) {
  const detail = check.pass || !check.detail ? '' : ` — ${e(check.detail)}`;
  return `<li class="${check.pass ? 'pass' : 'fail'}">${check.pass ? '✓' : '✗'} ${e(check.name)}${detail}</li>`;
}

/** The menu bar stop's own table (design § 5, § 8): no screenshot, the computed tray facts. */
function renderMenuBar(stop) {
  const facts = stop.menuBar || {};
  const applied = facts.applied || {};
  const computed = facts.computed || {};
  const rows = (facts.rowTexts || []).map(t => `<li>${e(t)}</li>`).join('') || '<li class="faint">(none)</li>';
  return `<p class="menubar-note">Computed state, not a screenshot: the tray can't be captured without the desktop.</p>` +
    `<table class="facts"><tbody>` +
    `<tr><th>tray exists</th><td>${e(String(!!facts.tray))}</td></tr>` +
    `<tr><th>applied title</th><td>${e(String(applied.title ?? ''))}</td></tr>` +
    `<tr><th>applied amber</th><td>${e(String(!!applied.amber))}</td></tr>` +
    `<tr><th>computed label</th><td>${e(String(computed.label ?? ''))}</td></tr>` +
    `<tr><th>computed amber</th><td>${e(String(!!computed.amber))}</td></tr>` +
    `<tr><th>computed count</th><td>${e(String(computed.count ?? ''))}</td></tr>` +
    `</tbody></table><p>Row texts</p><ul class="rows">${rows}</ul>`;
}

/** A stop's screenshot as a `data:` URI, or nothing when none was taken (the menu bar stop, or a
 *  blank/missing capture — shown with the reason instead of a broken image). */
function renderShot(id, shots) {
  const png = shots[id];
  if (!png) return '<p class="faint">(no screenshot)</p>';
  return `<img class="shot" alt="${e(id)}" src="data:image/png;base64,${png}">`;
}

/** A refusal's text: `<kind> <name> — <message>`, `(expected)` when its stop declared it. */
function refusalText(r) {
  if (typeof r === 'string') return r;
  return `${r.kind ?? '?'} ${r.name ?? '?'}${r.message ? ` — ${r.message}` : ''}${r.expected ? ' (expected)' : ''}`;
}

function renderStop(stop, shots, refused = []) {
  const title = `${e(stop.id)} — ${e(stop.title || '')}`;
  const meta = [stop.route, stop.view, stop.theme, stop.width ? `${stop.width}px` : null]
    .filter(Boolean).map(e).join(' · ');
  const checks = (stop.checks || []).map(renderCheck).join('') || '<li class="fail">no checks ran</li>';
  const body = stop.menuBar ? renderMenuBar(stop) : renderShot(stop.id, shots);
  const next = stop.next
    ? `<h4>${e(stop.next.title || `${stop.id}-next`)}</h4>${renderShot(`${stop.id}-next`, shots)}`
    : '';
  return `<article class="stop ${stop.pass ? 'pass' : 'fail'}">` +
    `<h3>${title}</h3><p class="meta">${meta}</p>` +
    `<ul class="checks">${checks}</ul>` +
    refused.map(r => `<p class="${r.expected ? 'faint' : 'fail'}">Refused: ${e(refusalText(r))}</p>`).join('') +
    `${body}${next}` +
    (stop.error ? `<p class="fail">${e(stop.error)}</p>` : '') +
    `</article>`;
}

function renderSection(step, stops, shots, refused) {
  const inStep = stops.filter(s => (s.step || []).includes(step));
  if (!inStep.length) return '';
  const of = id => refused.filter(r => r?.stop === id);
  return `<section><h2>Step ${step}</h2>${inStep.map(s => renderStop(s, shots, of(s.id))).join('')}</section>`;
}

function renderHeader(results) {
  const sha = e(results.sha ?? '?');
  const counts = (results.stops || []).reduce((c, s) => (s.pass ? c.passed++ : c.failed++, c), { passed: 0, failed: 0 });
  return `<header>` +
    `<h1>CodeMie Connect · real-app tour · ${sha}</h1>` +
    `<p class="verdict ${results.pass ? 'pass' : 'fail'}">${results.pass ? 'PASS' : 'FAIL'}</p>` +
    `<dl class="meta">` +
    `<dt>Run</dt><dd>${e(results.runId ?? '?')}</dd>` +
    `<dt>Built</dt><dd>${e(results.binary?.path ?? '?')} (${e(results.binary?.mtime ?? '?')})</dd>` +
    `<dt>Started</dt><dd>${e(results.startedAt ?? '?')}</dd>` +
    `<dt>Finished</dt><dd>${e(results.finishedAt ?? '?')}</dd>` +
    `<dt>Stops</dt><dd>${counts.passed} passed, ${counts.failed} failed</dd>` +
    `</dl></header>`;
}

function renderOps(results) {
  const ops = (results.ops || []).map(e).join(', ') || '(none)';
  const refused = (results.refused || []);
  const where = r => (typeof r === 'string' ? '' : `${r.stop ?? 'between stops'} · `);
  const refusedList = refused.length
    ? `<ul class="checks">${refused.map(r => `<li class="${r?.expected ? 'pass' : 'fail'}">${e(where(r) + refusalText(r))}</li>`).join('')}</ul>`
    : '<p>(none)</p>';
  const failed = (results.failed || []).map(f => `<li>${e(f)}</li>`).join('');
  return `<section><h2>Ops and refusals</h2>` +
    (failed ? `<h3>Why the tour failed</h3><ul class="checks">${failed}</ul>` : '') +
    `<h3>Operations sent</h3><p>${ops}</p>` +
    `<h3>Refused</h3>${refusedList}</section>`;
}

const CSS = `
:root{--bg:#F9F9F9;--card:#FFFFFF;--card-2:#FBFBFB;--border:#E5E5E5;--text:#333333;--muted:#666666;
--faint:#999999;--accent:#007AFF;--green:#1E8E41;--green-bg:#E6F7E6;--red:#E5293A;--red-bg:#FBE9EA;
--amber:#9A5B00;--amber-bg:#FAF2E7;--grey:#666666;--grey-bg:#EEEEEE}
@media (prefers-color-scheme:dark){:root{--bg:#1A1A1A;--card:#212224;--card-2:#1C1D1F;--border:#333436;
--text:#FFFFFF;--muted:#BBBBBB;--faint:#8A8A8A;--accent:#4F9CF9;--green:#259F4C;--green-bg:#1B271F;
--red:#FE3B4C;--red-bg:#2C1F21;--amber:#F5A534;--amber-bg:#3A2A0E;--grey:#BBBBBB;--grey-bg:#2A2B2E}}
*{box-sizing:border-box}
body{margin:0;padding:24px;background:var(--bg);color:var(--text);
font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",system-ui,sans-serif;font-size:14px;line-height:1.45}
h1{font-size:20px;margin:0 0 8px}
h2{font-size:16px;margin:28px 0 10px;border-bottom:1px solid var(--border);padding-bottom:6px}
h3{font-size:13px;margin:16px 0 6px;color:var(--muted)}
h4{font-size:12px;margin:10px 0 4px;color:var(--muted)}
header{padding:16px;border:1px solid var(--border);border-radius:8px;background:var(--card)}
.verdict{display:inline-block;padding:2px 10px;border-radius:12px;font-weight:600}
.verdict.pass{color:var(--green);background:var(--green-bg)}
.verdict.fail{color:var(--red);background:var(--red-bg)}
dl.meta{display:grid;grid-template-columns:max-content 1fr;gap:2px 12px;margin:12px 0 0;font-size:12px}
dl.meta dt{color:var(--muted)}
dl.meta dd{margin:0;word-break:break-all}
table.cov{width:100%;border-collapse:collapse;font-size:13px}
table.cov th,table.cov td{text-align:left;padding:6px 8px;border-bottom:1px solid var(--border);vertical-align:top}
table.cov tr.cov-green td:nth-child(3){color:var(--green)}
table.cov tr.cov-red td:nth-child(3){color:var(--red)}
table.cov tr.cov-amber td:nth-child(3){color:var(--amber)}
table.cov tr.cov-grey td:nth-child(3){color:var(--grey)}
table.cov tr.cov-green{background:var(--green-bg)}
table.cov tr.cov-red{background:var(--red-bg)}
table.cov tr.cov-amber{background:var(--amber-bg)}
table.cov tr.cov-grey{background:var(--grey-bg)}
article.stop{border:1px solid var(--border);border-radius:8px;background:var(--card);padding:12px 16px;margin:0 0 14px}
article.stop.fail{border-color:var(--red)}
p.meta{color:var(--muted);font-size:12px;margin:0 0 8px}
ul.checks{list-style:none;margin:0 0 10px;padding:0;font-size:13px}
ul.checks li.pass{color:var(--green)}
ul.checks li.fail{color:var(--red)}
ul.rows{margin:4px 0 0;padding-left:18px;font-size:13px}
img.shot{max-width:100%;border:1px solid var(--border);border-radius:6px;display:block}
p.faint{color:var(--faint);font-style:italic}
p.menubar-note{color:var(--muted);font-size:12px}
table.facts{border-collapse:collapse;font-size:13px;margin:6px 0}
table.facts th,table.facts td{text-align:left;padding:3px 10px;border-bottom:1px solid var(--border)}
table.facts th{color:var(--muted);font-weight:400}
`;

/**
 * The tour's HTML report (design § 8): the header, the coverage table, one section per rollout
 * step (design's `STEPS`) and last the ops and refusals. `results` is Rust's own verdict
 * (`commands::tour::report::verdict`) plus each stop's `covers` (the CLI attaches it from
 * `script.js`; a test may supply it directly). `shots` is `{id: base64}`, without the `data:`
 * prefix. `features` is `coverage.js`'s `FEATURES`. Pure: no script, no external resource, every
 * string escaped.
 */
export function renderReport(results, shots, features) {
  const stops = results.stops || [];
  const sections = STEPS.map(step => renderSection(step, stops, shots, results.refused || [])).join('');
  return `<!doctype html><html><head><meta charset="utf-8">` +
    `<title>CodeMie Connect · real-app tour · ${e(results.sha ?? '?')}</title>` +
    `<style>${CSS}</style></head><body>` +
    renderHeader(results) +
    renderCoverage(stops, features) +
    sections +
    renderOps(results) +
    `</body></html>`;
}

// ---------------------------------------------------------------- CLI

function readShots(testDir) {
  const dir = path.join(testDir, 'tour', 'shots');
  const shots = {};
  if (!existsSync(dir)) return shots;
  for (const file of readdirSync(dir)) {
    if (file.endsWith('.png')) shots[file.slice(0, -4)] = readFileSync(path.join(dir, file)).toString('base64');
  }
  return shots;
}

function main() {
  const [testDirArg, outDirArg] = process.argv.slice(2);
  if (!testDirArg || !outDirArg) {
    console.error('Usage: node scripts/tour/report.mjs <testDir> <outDir>');
    process.exit(1);
  }
  const testDir = path.resolve(testDirArg);
  const outDir = path.resolve(outDirArg);
  const resultsPath = path.join(testDir, 'tour', 'results.json');
  let results;
  try {
    results = JSON.parse(readFileSync(resultsPath, 'utf8'));
  } catch (e2) {
    console.error(`Can't read ${resultsPath}: ${e2.message}`);
    process.exit(1);
  }
  const coversById = new Map(STOPS.map(s => [s.id, s.covers || []]));
  for (const stop of results.stops || []) stop.covers = coversById.get(stop.id) || [];
  const html = renderReport(results, readShots(testDir), FEATURES);
  mkdirSync(outDir, { recursive: true });
  const outPath = path.join(outDir, 'index.html');
  writeFileSync(outPath, html, 'utf8');
  console.log(outPath);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main();
}
