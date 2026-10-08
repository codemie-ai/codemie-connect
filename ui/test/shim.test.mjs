import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const SHIM = 'assets/windows/bin/codemie.cmd';
const shim = readFileSync(SHIM, 'utf8');
const onWindows = process.platform === 'win32';

// Every command the pinned CLI declares, from the lock file the app installs with.
const cliBins = JSON.parse(readFileSync('assets/codemie-cli/package-lock.json', 'utf8'))
  .packages['node_modules/@codemieai/code'].bin;

// Node and the CLI are not in the app: commands/runtime.rs downloads them into
// %LOCALAPPDATA%\CodeMie\runtime\<key>, and build-installer.ps1 writes the
// key next to the shim.
test('shim finds the downloaded runtime through runtime-key, never a hardcoded version', () => {
  assert.match(shim, /%~dp0runtime-key/, 'the key is written by build-installer.ps1 next to the shim');
  assert.match(shim, /%LOCALAPPDATA%\\CodeMie\\runtime\\%KEY%/, 'same folder as commands/runtime.rs');
  assert.doesNotMatch(shim, /CodeMie Connect\\/, 'must not hardcode the install path');
  assert.doesNotMatch(shim, /%~dp0\.\./, 'the bundle no longer holds node or the CLI');
});

test('shim refuses a runtime whose download never finished', () => {
  assert.match(shim, /\.complete/, 'the marker is the last thing ensure_runtime writes');
  assert.match(shim, /Open CodeMie Connect once/, 'tells the user how to get it');
});

test('shim execs the downloaded node runtime', () => {
  assert.match(shim, /node[\\/]node\.exe/, 'must invoke the runtime node\\node.exe');
});

// dist/index.js is a library barrel: it exits 0 and prints nothing, so a build
// gated on exit code alone would pass while `codemie --version` produced no output.
test('shim targets the package bin entries, never dist/index.js', () => {
  assert.match(shim, /"%NAME%"=="codemie" set "ENTRY=codemie\.js"/, 'codemie runs bin/codemie.js');
  assert.match(shim, /"%NAME%"=="codemie-code" set "ENTRY=agent-executor\.js"/, 'codemie-code is the one bin not named after itself');
  assert.match(shim, /code\\bin\\%ENTRY%"/, 'entries live in the package bin dir');
  assert.doesNotMatch(shim, /dist[\\/]index\.js/, 'dist/index.js is a barrel with no CLI bootstrap');
});

// Agent installs and every uninstall shell out to `npm` by name. The runtime's npm
// sits beside its node, a directory deliberately kept off the user's own PATH, so
// each shim puts it on PATH for its own process tree only, appended, so a user's
// own npm keeps winning.
test('shim puts the runtime node directory on PATH, appended', () => {
  assert.match(shim, /set "PATH=%PATH%;%RT%\\node"/, 'without this, `npm` is not found and every agent install fails on a clean machine');
  assert.match(shim, /if defined PATH/, 'an empty PATH would otherwise gain a leading ";", which is the current directory');
});

test('shim propagates the CLI exit code', () => {
  assert.match(shim, /exit \/b %ERRORLEVEL%/i, 'without this the shim always reports success');
});

test('shim does not reference the removed pkg binary', () => {
  assert.doesNotMatch(shim, /codemie\.exe/i, 'the pkg binary is no longer produced');
});

test('tauri.windows.conf.json ships the shim under every CLI command name and the runtime key; Node and the CLI are downloaded', () => {
  const conf = JSON.parse(readFileSync('src-tauri/tauri.windows.conf.json', 'utf8'));
  const want = Object.fromEntries(Object.keys(cliBins).map((n) => [`../assets/windows/bin/${n}.cmd`, `bin/${n}.cmd`]));
  want['../assets/windows/bin/runtime-key'] = 'bin/runtime-key';
  assert.deepEqual(conf.bundle.resources, want);
  for (const n of Object.keys(cliBins)) {
    assert.equal(readFileSync(`assets/windows/bin/${n}.cmd`, 'utf8'), shim, `assets/windows/bin/${n}.cmd must be the shim`);
  }
});

test('the uninstaller removes the downloaded runtime but never ~/.codemie', () => {
  const nsi = readFileSync('src-tauri/installer-hooks.nsi', 'utf8');
  assert.match(nsi, /rmdir \/s \/q "\$LOCALAPPDATA\\CodeMie\\runtime"/);
  assert.doesNotMatch(nsi, /\.codemie/);
});

// ---- Windows shim, executed ------------------------------------------------------

// The shim reads runtime-key next to itself; stand in for the generated one.
function shimWithKey(dir, key) {
  const bin = join(dir, 'bin');
  mkdirSync(bin, { recursive: true });
  writeFileSync(join(bin, 'codemie.cmd'), shim);
  writeFileSync(join(bin, 'runtime-key'), key + '\r\n');
  return join(bin, 'codemie.cmd');
}

function execWinShim(shimPath, localAppData, args = []) {
  const sys = process.env.SystemRoot;
  return spawnSync('cmd.exe', ['/d', '/c', shimPath, ...args], {
    env: { LOCALAPPDATA: localAppData, SystemRoot: sys, PATH: sys + '\\System32' },
    encoding: 'utf8',
  });
}

// A real node.exe (this one) stands in for the downloaded runtime, so the shim is
// run end to end.
function fakeRuntime(localAppData, key, { complete = true } = {}) {
  const rt = join(localAppData, 'CodeMie', 'runtime', key);
  mkdirSync(join(rt, 'node'), { recursive: true });
  mkdirSync(join(rt, 'cli', 'node_modules', '@codemieai', 'code', 'bin'), { recursive: true });
  copyFileSync(process.execPath, join(rt, 'node', 'node.exe'));
  writeFileSync(
    join(rt, 'cli', 'node_modules', '@codemieai', 'code', 'bin', 'codemie.js'),
    "console.log('fake ' + process.argv.slice(2).join(' ')); console.log(process.env.PATH); process.exit(7);",
  );
  if (complete) writeFileSync(join(rt, '.complete'), key);
  return rt;
}

test('Windows shim with no runtime says to open CodeMie Connect once and exits 1', { skip: !onWindows }, () => {
  const dir = mkdtempSync(join(tmpdir(), 'shim-'));
  const r = execWinShim(shimWithKey(dir, 'k1'), join(dir, 'local'));
  assert.equal(r.status, 1);
  assert.match(r.stderr, /Open CodeMie Connect once/);
});

test('Windows shim does not use a runtime dir without the .complete marker', { skip: !onWindows }, () => {
  const dir = mkdtempSync(join(tmpdir(), 'shim-'));
  const local = join(dir, 'local');
  fakeRuntime(local, 'k1', { complete: false });
  const r = execWinShim(shimWithKey(dir, 'k1'), local);
  assert.equal(r.status, 1);
  assert.equal(r.stdout, '');
});

test('Windows shim runs the downloaded runtime, passes arguments and exit code, and appends its node dir to PATH', { skip: !onWindows }, () => {
  const dir = mkdtempSync(join(tmpdir(), 'shim-'));
  const local = join(dir, 'local');
  const rt = fakeRuntime(local, 'k1');
  const r = execWinShim(shimWithKey(dir, 'k1'), local, ['--version']);
  const [first, path] = r.stdout.trim().split(/\r?\n/);
  assert.equal(first, 'fake --version');
  assert.ok(path.endsWith(';' + join(rt, 'node')), 'the runtime node dir is appended, not prepended');
  assert.equal(r.status, 7);
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

test('macOS shim targets the package bin entries, never dist/index.js', () => {
  assert.match(macShim, /codemie\) ENTRY=codemie\.js/, 'codemie runs bin/codemie.js');
  assert.match(macShim, /codemie-code\) ENTRY=agent-executor\.js/, 'codemie-code is the one bin not named after itself');
  assert.match(macShim, /code\/bin\/\$ENTRY"/, 'entries live in the package bin dir');
  assert.doesNotMatch(macShim, /dist\/index\.js/, 'dist/index.js is a barrel with no CLI bootstrap');
});

test('runtime.json pins the darwin-arm64 Node checksum', () => {
  const rt = JSON.parse(readFileSync('runtime.json', 'utf8'));
  assert.match(rt.nodeMacosArm64Sha256 ?? '', /^[0-9a-f]{64}$/, 'nodeMacosArm64Sha256 must be a 64-hex SHA-256');
  assert.match(rt.nodeVersion, /^\d+\.\d+\.\d+$/, 'nodeVersion must be a plain semver');
});

test('tauri.macos.conf.json ships the shim under every CLI command name, nothing else', () => {
  // npm puts all of these on PATH; without one, e.g. `codemie-claude`, the
  // command a user runs a tool with is "command not found" in a terminal.
  const conf = JSON.parse(readFileSync('src-tauri/tauri.macos.conf.json', 'utf8'));
  const want = Object.fromEntries(Object.keys(cliBins).map((n) => [`../assets/macos/bin/${n}`, `bin/${n}`]));
  assert.deepEqual(conf.bundle.resources, want);
  for (const n of Object.keys(cliBins)) {
    assert.equal(readFileSync(`assets/macos/bin/${n}`, 'utf8'), macShim, `assets/macos/bin/${n} must be the shim`);
  }
});

test('the shim maps every CLI command to the entry the CLI declares for it', () => {
  for (const [name, entry] of Object.entries(cliBins)) {
    const mapped = name === 'codemie' ? 'codemie.js' : name === 'codemie-code' ? 'agent-executor.js' : `${name}.js`;
    assert.equal(`bin/${mapped}`, entry, `${name}: the shim would run bin/${mapped}`);
  }
});

test('the CLI lock file the app installs with pins the CLI runtime.json pins', () => {
  const rt = JSON.parse(readFileSync('runtime.json', 'utf8'));
  const lock = JSON.parse(readFileSync('assets/codemie-cli/package-lock.json', 'utf8'));
  assert.equal(lock.packages['node_modules/@codemieai/code'].version, rt.cliVersion);
});

// Below 0.15.7 the CLI asks "Would you like to update now?" on its first run.
// The app cannot answer it, so every CLI call hangs. From 0.15.7 the
// codemie-connect.json marker the app writes makes it skip that (codemie-code #598).
test('runtime.json pins a CLI that skips its own update prompt inside the app (0.15.7 or later)', () => {
  const rt = JSON.parse(readFileSync('runtime.json', 'utf8'));
  const [maj, min, patch] = rt.cliVersion.split('.').map(Number);
  assert.ok(maj > 0 || min > 15 || (min === 15 && patch >= 7), `cliVersion ${rt.cliVersion} is below 0.15.7`);
});

test('the shared tauri.conf.json declares no resources; each platform has its overlay', () => {
  const conf = JSON.parse(readFileSync('src-tauri/tauri.conf.json', 'utf8'));
  assert.equal(conf.bundle.resources, undefined, 'a shared resource forces the other platform to stage it before cargo builds');
});

// ---- macOS shim, executed ------------------------------------------------------

function shimIn(dir, name = 'codemie') {
  const bin = join(dir, 'bin');
  mkdirSync(bin, { recursive: true });
  writeFileSync(join(bin, 'codemie'), macShim);
  if (name !== 'codemie') symlinkSync('codemie', join(bin, name));
  return join(bin, name);
}

function execShim(shim, home, args = []) {
  return spawnSync('/bin/sh', [shim, ...args], {
    env: { HOME: home, PATH: '/usr/bin:/bin' },
    encoding: 'utf8',
  });
}

// Lays the runtime out the way runtime.rs does: versioned dirs plus the
// `node` and `cli` links the shim follows.
function runtime(home, { cliComplete = true, entries = ['codemie.js'] } = {}) {
  const rt = join(home, 'Library/Application Support/CodeMie/runtime');
  mkdirSync(join(rt, 'node-1/bin'), { recursive: true });
  mkdirSync(join(rt, 'cli-1/node_modules/@codemieai/code/bin'), { recursive: true });
  writeFileSync(join(rt, 'node-1/.complete'), '1');
  if (cliComplete) writeFileSync(join(rt, 'cli-1/.complete'), '1');
  writeFileSync(join(rt, 'node-1/bin/node'), '#!/bin/sh\necho "fake-node $(basename "$1") $2 $3"\nexit 7\n');
  chmodSync(join(rt, 'node-1/bin/node'), 0o755);
  for (const e of entries) writeFileSync(join(rt, 'cli-1/node_modules/@codemieai/code/bin', e), '');
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
  assert.equal(r.stdout.trim(), 'fake-node codemie.js --version');
  assert.equal(r.status, 7);
});

test('macOS shim run as another command name runs that command', () => {
  const dir = mkdtempSync(join(tmpdir(), 'shim-'));
  const home = join(dir, 'home');
  runtime(home, { entries: ['codemie.js', 'codemie-claude.js', 'agent-executor.js'] });
  assert.equal(execShim(shimIn(dir, 'codemie-claude'), home, ['--task', 'x']).stdout.trim(), 'fake-node codemie-claude.js --task x');
  assert.equal(execShim(shimIn(dir, 'codemie-code'), home).stdout.trim(), 'fake-node agent-executor.js');
});

test('macOS shim run as a command this CLI does not have says so and exits 127', () => {
  const dir = mkdtempSync(join(tmpdir(), 'shim-'));
  const home = join(dir, 'home');
  runtime(home);
  const r = execShim(shimIn(dir, 'codemie-gone'), home);
  assert.equal(r.status, 127);
  assert.match(r.stderr, /codemie-gone: this CodeMie CLI has no such command/);
  assert.equal(r.stdout, '');
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
