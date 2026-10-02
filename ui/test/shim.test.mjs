import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const SHIM = 'assets/windows/bin/codemie.cmd';
const shim = readFileSync(SHIM, 'utf8');

test('shim resolves the bundle root relative to its own location', () => {
  assert.match(shim, /%~dp0\.\./, 'must use %~dp0.. so the install root is not hardcoded');
  assert.doesNotMatch(shim, /CodeMie Connect/, 'must not hardcode the product name');
});

test('shim execs the bundled node runtime', () => {
  assert.match(shim, /node[\\/]node\.exe/, 'must invoke the bundled node\\node.exe');
});

// dist/index.js is a library barrel: it exits 0 and prints nothing, so a build
// gated on exit code alone would pass while `codemie --version` produced no output.
test('shim targets bin/codemie.js, never dist/index.js', () => {
  assert.match(shim, /bin[\\/]codemie\.js/, 'must target the package bin entry');
  assert.doesNotMatch(shim, /dist[\\/]index\.js/, 'dist/index.js is a barrel with no CLI bootstrap');
});

// Agent installs and every uninstall shell out to `npm` by name. The bundled npm
// sits beside the bundled node, a directory deliberately kept off the user's own
// PATH, so each shim puts it on PATH for its own process tree only — appended, so
// a user's own npm keeps winning.
test('shim puts the bundled node directory on PATH, appended', () => {
  assert.match(shim, /set "PATH=%PATH%;%BUNDLE_DIR%\\node"/, 'without this, `npm` is not found and every agent install fails on a clean machine');
  assert.match(shim, /if defined PATH/, 'an empty PATH would otherwise gain a leading ";", which is the current directory');
});

test('shim propagates the CLI exit code', () => {
  assert.match(shim, /exit \/b %ERRORLEVEL%/i, 'without this the shim always reports success');
});

test('shim does not reference the removed pkg binary', () => {
  assert.doesNotMatch(shim, /codemie\.exe/i, 'the pkg binary is no longer produced');
});

// ---- macOS ----------------------------------------------------------------

const MAC_SHIM = 'assets/macos/bin/codemie';
const macShim = readFileSync(MAC_SHIM, 'utf8');

test('macOS shim runs whatever the runtime links point at, never a hardcoded version', () => {
  assert.match(macShim, /RT="\$HOME\/Library\/Application Support\/CodeMie\/runtime"/, 'same folder as commands/runtime.rs');
  assert.doesNotMatch(macShim, /\d+\.\d+\.\d+/, 'a version in the shim would pin it past a CLI update');
  assert.doesNotMatch(macShim, /CodeMie Connect\.app/, 'must not hardcode the app path');
});

test('macOS shim refuses a CLI whose install never finished', () => {
  assert.match(macShim, /\[ ! -f "\$RT\/cli\/\.complete" \]/, 'the marker is the last thing install_cli writes');
  assert.match(macShim, /Open CodeMie Connect once/, 'tells the user how to get it');
});

test('macOS shim execs the downloaded node runtime', () => {
  assert.match(macShim, /exec "\$RT\/node\/bin\/node"/, 'must exec node/bin/node so exit code and signals pass through');
});

test('macOS shim puts the runtime node directory on PATH, appended, before the exec', () => {
  assert.match(macShim, /PATH="\$\{PATH:\+\$PATH:\}\$RT\/node\/bin"/, 'without this, `npm` is not found and every agent install fails on a clean machine');
  assert.ok(
    macShim.indexOf('$RT/node/bin"\nexport PATH') < macShim.indexOf('exec "$RT/node/bin/node"'),
    'the export has to happen before the exec replaces the process',
  );
});

test('macOS shim targets bin/codemie.js, never dist/index.js', () => {
  assert.match(macShim, /bin\/codemie\.js/, 'must target the package bin entry');
  assert.doesNotMatch(macShim, /dist\/index\.js/, 'dist/index.js is a barrel with no CLI bootstrap');
});

test('runtime.json pins the darwin-arm64 Node checksum', () => {
  const rt = JSON.parse(readFileSync('runtime.json', 'utf8'));
  assert.match(rt.nodeMacosArm64Sha256 ?? '', /^[0-9a-f]{64}$/, 'nodeMacosArm64Sha256 must be a 64-hex SHA-256');
  assert.match(rt.nodeVersion, /^\d+\.\d+\.\d+$/, 'nodeVersion must be a plain semver');
});

test('tauri.macos.conf.json ships only the shim; Node and the CLI are installed on first launch', () => {
  const conf = JSON.parse(readFileSync('src-tauri/tauri.macos.conf.json', 'utf8'));
  assert.deepEqual(conf.bundle.resources, { '../assets/macos/bin/codemie': 'bin/codemie' });
});

test('the CLI lock file the app installs with pins the CLI runtime.json pins', () => {
  const rt = JSON.parse(readFileSync('runtime.json', 'utf8'));
  const lock = JSON.parse(readFileSync('assets/codemie-cli/package-lock.json', 'utf8'));
  assert.equal(lock.packages['node_modules/@codemieai/code'].version, rt.cliVersion);
});

test('the shared tauri.conf.json declares no resources; each platform has its overlay', () => {
  const conf = JSON.parse(readFileSync('src-tauri/tauri.conf.json', 'utf8'));
  assert.equal(conf.bundle.resources, undefined, 'a shared resource forces the other platform to stage it before cargo builds');
});

// ---- macOS shim, executed ------------------------------------------------------

function shimIn(dir) {
  const bin = join(dir, 'bin');
  mkdirSync(bin, { recursive: true });
  writeFileSync(join(bin, 'codemie'), macShim);
  return join(bin, 'codemie');
}

function execShim(shim, home, args = []) {
  return spawnSync('/bin/sh', [shim, ...args], {
    env: { HOME: home, PATH: '/usr/bin:/bin' },
    encoding: 'utf8',
  });
}

// Lays the runtime out the way runtime.rs does: versioned dirs plus the
// `node` and `cli` links the shim follows.
function runtime(home, { cliComplete = true } = {}) {
  const rt = join(home, 'Library/Application Support/CodeMie/runtime');
  mkdirSync(join(rt, 'node-1/bin'), { recursive: true });
  mkdirSync(join(rt, 'cli-1/node_modules/@codemieai/code/bin'), { recursive: true });
  writeFileSync(join(rt, 'node-1/.complete'), '1');
  if (cliComplete) writeFileSync(join(rt, 'cli-1/.complete'), '1');
  writeFileSync(join(rt, 'node-1/bin/node'), '#!/bin/sh\necho "fake-node $2 $3"\nexit 7\n');
  chmodSync(join(rt, 'node-1/bin/node'), 0o755);
  writeFileSync(join(rt, 'cli-1/node_modules/@codemieai/code/bin/codemie.js'), '');
  symlinkSync('node-1', join(rt, 'node'));
  symlinkSync('cli-1', join(rt, 'cli'));
}

test('macOS shim with no runtime in HOME says to open CodeMie Connect once and exits 1', () => {
  const dir = mkdtempSync(join(tmpdir(), 'shim-'));
  const r = execShim(shimIn(dir), join(dir, 'home'));
  assert.equal(r.status, 1);
  assert.match(r.stderr, /Open CodeMie Connect once/);
});

test('macOS shim runs the linked runtime and passes arguments and exit code through', () => {
  const dir = mkdtempSync(join(tmpdir(), 'shim-'));
  const home = join(dir, 'home');
  runtime(home);
  const r = execShim(shimIn(dir), home, ['--version']);
  assert.equal(r.stdout.trim(), 'fake-node --version');
  assert.equal(r.status, 7);
});

test('macOS shim does not use a CLI dir without the .complete marker', () => {
  const dir = mkdtempSync(join(tmpdir(), 'shim-'));
  const home = join(dir, 'home');
  runtime(home, { cliComplete: false });
  const r = execShim(shimIn(dir), home);
  assert.equal(r.status, 1);
  assert.equal(r.stdout, '');
});

// ---- first-launch gate in the renderer ------------------------------------------

const renderer = readFileSync('ui/renderer.js', 'utf8');
const html = readFileSync('ui/index.html', 'utf8');

test('boot() waits for the runtime before anything else, smoke mode included', () => {
  const boot = renderer.slice(renderer.indexOf('async function boot()'));
  assert.ok(boot.indexOf('await ensureRuntime()') > -1, 'boot must call ensureRuntime');
  assert.ok(
    boot.indexOf('await ensureRuntime()') < boot.indexOf("invoke('smoke_mode')"),
    'the runtime has to be there before any step runs the CLI',
  );
});

test('the runtime overlay says Preparing CodeMie, shows progress and offers Try again that re-runs ensure_runtime', () => {
  assert.match(html, /id="runtime-overlay"/);
  assert.match(html, /Preparing CodeMie…/);
  assert.match(html, /id="runtime-bar"/);
  assert.match(html, /id="runtime-retry"[^>]*>Try again</);
  const fn = renderer.slice(renderer.indexOf('async function ensureRuntime()'), renderer.indexOf('async function boot()'));
  assert.match(fn, /listen\('runtime:progress'/);
  assert.match(fn, /for \(;;\)[\s\S]*invoke\('ensure_runtime'\)[\s\S]*retry\.addEventListener\('click'/, 'a failure waits for the retry click and loops back to ensure_runtime');
});

test('boot() checks for a newer CLI in the background, after Home is wired', () => {
  const boot = renderer.slice(renderer.indexOf('async function boot()'));
  assert.ok(boot.indexOf("invoke('update_cli')") > boot.indexOf('refreshAgents();'), 'the update must not hold up boot');
  assert.doesNotMatch(boot, /await invoke\('update_cli'\)/, 'never awaited: a slow npm must not block the app');
});
