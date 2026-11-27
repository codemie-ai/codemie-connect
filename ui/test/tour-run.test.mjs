// `make tour`'s launcher (scripts/tour/run.sh, Task 8 of the real-app tour plan, design
// docs/superpowers/specs/2026-11-24-real-app-tour-design.md § 9): most of these drive the real
// script with `--dry-run`, never a real build or a real launch, so they run fast and need no
// Rust build. Two tests (the piping check and the dry-run cleanup check) also use
// CODEMIE_TOUR_FAKE_BIN, a test seam `run.sh` itself documents, to exercise the real
// launch/watchdog/cleanup path against a trivial stand-in binary instead of the real app.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync, spawn, spawnSync } from 'node:child_process';

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
    // A bare lock (no recorded owner) is treated as held, never guessed at.
    mkdirSync(join(tmp, 'connect-tour.lock'));
    const r = dryRun(tmp);
    assert.equal(r.status, 3);
    assert.match(r.stderr, /Another tour is running\./);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('a stale lock (owner process gone) is taken over, not refused', () => {
  const tmp = freshTmp();
  try {
    const lockDir = join(tmp, 'connect-tour.lock');
    mkdirSync(lockDir);
    // A PID this high is never a live process on a normal machine.
    writeFileSync(join(lockDir, 'owner'), '999999 run.sh\n');
    const r = dryRun(tmp);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stderr, /stale lock/);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('a dry run with no live app signals nothing in cleanup', () => {
  const tmp = freshTmp();
  try {
    const r = dryRun(tmp);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stderr, '', 'cleanup must not try to stop anything it never started');
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('the script kills only $pid, $watchdog or its own $s, never anything else', () => {
  const src = readFileSync(SCRIPT, 'utf8');
  const allowed = /kill(?: -9)? "\$(?:pid|watchdog|s)"/g;
  const matches = src.match(allowed) || [];
  assert.ok(matches.length > 0, 'the script never stops its own process or its watchdog');
  const leftover = src.replace(allowed, '');
  assert.doesNotMatch(leftover, /\bkill\b/, 'a kill outside $pid/$watchdog/$s');
});

test('run.sh returns promptly when piped, even with its 660 s watchdog started', async () => {
  const tmp = freshTmp();
  const fakeBin = join(tmp, 'fake-app.sh');
  writeFileSync(fakeBin, '#!/bin/sh\nexit 0\n');
  chmodSync(fakeBin, 0o755);
  const TIMEOUT_MS = 10_000;
  try {
    const started = Date.now();
    const result = await new Promise((resolve, reject) => {
      const child = spawn(SCRIPT, [], {
        cwd: REPO_ROOT,
        env: { ...process.env, TMPDIR: tmp, CODEMIE_TOUR_FAKE_BIN: fakeBin },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let stdout = '';
      let stderr = '';
      child.stdout.on('data', d => { stdout += d; });
      child.stderr.on('data', d => { stderr += d; });
      const timer = setTimeout(() => {
        child.kill('SIGKILL');
        reject(new Error(
          `run.sh (or something it started) kept stdout/stderr open past ${TIMEOUT_MS}ms.\n` +
          `stdout:\n${stdout}\nstderr:\n${stderr}`,
        ));
      }, TIMEOUT_MS);
      // 'close' fires only once the process has exited AND every stdio stream it (or anything
      // it started without redirecting) held open has been closed — exactly what a watchdog
      // left attached to this pipe would delay for up to 660 s.
      child.on('close', (code) => {
        clearTimeout(timer);
        resolve({ code, stdout, stderr });
      });
    });
    assert.ok(Date.now() - started < TIMEOUT_MS, 'took too long to close its pipes');
    assert.equal(result.code, 0, result.stderr);
    assert.match(result.stdout, /Verdict: PASS/);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});
