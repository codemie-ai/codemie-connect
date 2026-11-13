import { test } from 'node:test';
import assert from 'node:assert/strict';
import { analyticsCommand } from '../analytics-command.js';

// Option lines as `codemie analytics --help` prints them, from the two CLIs.
const OLD_HELP = `  --export <format>         Export to file (json or csv)
  --report                  Generate a self-contained HTML dashboard
  --open                    Open the generated HTML report in the default browser
  --report-output <path>    HTML report output path`;
const NEW_HELP = `  --export [format]         Write report: html (default), json, or both
  -o, --output <path>       Output file or directory
  --open                    Open the generated HTML report in the default browser`;

test('a CLI that still has --report gets the --report command', () => {
  assert.equal(analyticsCommand(OLD_HELP), 'codemie analytics --report --open --report-output "$HOME/codemie-analytics.html"');
});

test('a CLI without --report gets --export html with -o', () => {
  assert.equal(analyticsCommand(NEW_HELP), 'codemie analytics --export html --open -o "$HOME/codemie-analytics.html"');
});

// 0.15.5 and later: --export writes html, --report is still listed but deprecated.
const DEPRECATED_REPORT_HELP = `  --export [format]         Write report: html (default), json, or both
  -o, --output <path>       Output file or directory
  --open                    Open the generated HTML report in the default browser
  --report                  Deprecated: use --export instead (removal planned for 2026-11-01)
  --report-output <path>    Deprecated: use -o/--output instead (removal planned for 2026-11-01)`;

test('a CLI that lists --report only as deprecated gets --export, so no deprecation warning shows', () => {
  assert.equal(analyticsCommand(DEPRECATED_REPORT_HELP), 'codemie analytics --export html --open -o "$HOME/codemie-analytics.html"');
});

test('no help text falls back to the current option names', () => {
  assert.match(analyticsCommand(undefined), /--export html/);
});
