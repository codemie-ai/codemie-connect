// `make tour`'s launcher (scripts/tour/run.sh, Task 8 of the real-app tour plan, design
// docs/superpowers/specs/2026-11-24-real-app-tour-design.md § 9): these drive the real script
// with `--dry-run`, never a real build or a real launch, so they run fast and need no Rust
// build.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync, spawnSync } from 'node:child_process';

const REPO_ROOT = fileURLToPath(new URL('../..', import.meta.url));
const SCRIPT = join(REPO_ROOT, 'scripts/tour/run.sh');

function freshTmp() {
  return mkdtempSync(join(tmpdir(), 'tour-run-test-'));
}

function dryRun(tmp, extraArgs = []) {
  return spawnSync(SCRIPT, ['--dry-run', ...extraArgs], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    env: { ...process.env, TMPDIR: tmp },
  });
}

/** Every `KEY=value` line of the dry run's stdout, as a plain object. */
function parseEnvLines(stdout) {
  const env = {};
  for (const line of stdout.split('\n')) {
    const m = /^([A-Z_][A-Z0-9_]*)=(.*)$/.exec(line);
    if (m) env[m[1]] = m[2];
  }
  return env;
}

function runFolder(stdout) {
  const line = stdout.split('\n').find(l => l.startsWith('Run folder: '));
  assert.ok(line, `no "Run folder: " line in:\n${stdout}`);
  return line.slice('Run folder: '.length).trim();
}

function gitShortSha() {
  return execFileSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: REPO_ROOT, encoding: 'utf8' }).trim();
}

function gitIsDirty() {
  return execFileSync('git', ['status', '--porcelain'], { cwd: REPO_ROOT, encoding: 'utf8' }).trim().length > 0;
}

test("the launch environment is exactly spec § 2's", () => {
  const tmp = freshTmp();
  try {
    const r = dryRun(tmp);
    assert.equal(r.status, 0, r.stderr);
    const folder = runFolder(r.stdout);
    assert.ok(folder.startsWith(`${tmp}/`), folder);
    const sha = gitShortSha() + (gitIsDirty() ? '+dirty' : '');
    const env = parseEnvLines(r.stdout);
    assert.deepEqual(env, {
      HOME: `${folder}/home`,
      CFFIXED_USER_HOME: `${folder}/home`,
      HTTPS_PROXY: 'http://127.0.0.1:9',
      HTTP_PROXY: 'http://127.0.0.1:9',
      ALL_PROXY: 'http://127.0.0.1:9',
      NO_PROXY: '',
      GIT_ALLOW_PROTOCOL: 'file',
      PATH: '/usr/bin:/bin:/usr/sbin:/sbin',
      CODEMIE_WORKSPACE_TEST_DIR: `${folder}/workspace`,
      CODEMIE_TOUR: 'all',
      CODEMIE_TOUR_SHA: sha,
    });
    assert.ok(env.CODEMIE_WORKSPACE_TEST_DIR.startsWith(tmp), 'CODEMIE_WORKSPACE_TEST_DIR must sit under $TMPDIR');
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('--only passes through to CODEMIE_TOUR', () => {
  const tmp = freshTmp();
  try {
    const r = dryRun(tmp, ['--only', 'T05,T21']);
    assert.equal(r.status, 0, r.stderr);
    const env = parseEnvLines(r.stdout);
    assert.equal(env.CODEMIE_TOUR, 'T05,T21');
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('the build uses target/tour and --features tour', () => {
  const tmp = freshTmp();
  try {
    const r = dryRun(tmp);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /CARGO_TARGET_DIR=target\/tour/);
    assert.match(r.stdout, /--features tour/);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('a held lock refuses', () => {
  const tmp = freshTmp();
  try {
    mkdirSync(join(tmp, 'connect-tour.lock'));
    const r = dryRun(tmp);
    assert.equal(r.status, 3);
    assert.match(r.stderr, /Another tour is running\./);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('the script kills only its own PID', () => {
  const src = readFileSync(SCRIPT, 'utf8');
  const lines = src.split('\n').map(l => l.trim()).filter(l => /\bkill\b/.test(l));
  assert.ok(lines.length > 0, 'the script never stops its own process');
  for (const line of lines) {
    assert.ok(
      line === 'kill "$pid"' || line === 'kill -9 "$pid"',
      `unexpected kill usage: ${line}`,
    );
  }
});
