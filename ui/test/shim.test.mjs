import { test } from 'node:test';
import assert from 'node:assert/strict';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const SHIM = 'assets/windows/bin/codemie.cmd';
const shim = readFileSync(SHIM, 'utf8');
const onWindows = process.platform === 'win32';

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
test('shim targets bin/codemie.js, never dist/index.js', () => {
  assert.match(shim, /bin[\\/]codemie\.js/, 'must target the package bin entry');
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

test('tauri.windows.conf.json ships only the shim and its runtime key; Node and the CLI are downloaded', () => {
  const conf = JSON.parse(readFileSync('src-tauri/tauri.windows.conf.json', 'utf8'));
  assert.deepEqual(conf.bundle.resources, {
    '../assets/windows/bin/codemie.cmd': 'bin/codemie.cmd',
    '../assets/windows/bin/runtime-key': 'bin/runtime-key',
  });
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

function execShim(shimPath, localAppData, args = []) {
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
  const r = execShim(shimWithKey(dir, 'k1'), join(dir, 'local'));
  assert.equal(r.status, 1);
  assert.match(r.stderr, /Open CodeMie Connect once/);
});

test('Windows shim does not use a runtime dir without the .complete marker', { skip: !onWindows }, () => {
  const dir = mkdtempSync(join(tmpdir(), 'shim-'));
  const local = join(dir, 'local');
  fakeRuntime(local, 'k1', { complete: false });
  const r = execShim(shimWithKey(dir, 'k1'), local);
  assert.equal(r.status, 1);
  assert.equal(r.stdout, '');
});

test('Windows shim runs the downloaded runtime, passes arguments and exit code, and appends its node dir to PATH', { skip: !onWindows }, () => {
  const dir = mkdtempSync(join(tmpdir(), 'shim-'));
  const local = join(dir, 'local');
  const rt = fakeRuntime(local, 'k1');
  const r = execShim(shimWithKey(dir, 'k1'), local, ['--version']);
  const [first, path] = r.stdout.trim().split(/\r?\n/);
  assert.equal(first, 'fake --version');
  assert.ok(path.endsWith(';' + join(rt, 'node')), 'the runtime node dir is appended, not prepended');
  assert.equal(r.status, 7);
});

// ---- macOS ----------------------------------------------------------------

const MAC_SHIM = 'assets/macos/bin/codemie';
const macShim = readFileSync(MAC_SHIM, 'utf8');

test('macOS shim resolves Contents/Resources with one hop, never two', () => {
  assert.match(macShim, /\$\(dirname "\$0"\)\/\.\."/, 'must resolve $(dirname "$0")/.. (bin -> Resources)');
  assert.doesNotMatch(macShim, /\.\.\/\.\./, '../.. lands on Contents/, not Resources/');
  assert.doesNotMatch(macShim, /CodeMie Connect/, 'must not hardcode the product name');
});

test('macOS shim execs the bundled node runtime', () => {
  assert.match(macShim, /exec "\$RES\/node\/bin\/node"/, 'must exec node/bin/node so exit code and signals pass through');
});

test('macOS shim puts the bundled node directory on PATH, appended, before the exec', () => {
  assert.match(macShim, /PATH="\$\{PATH:\+\$PATH:\}\$RES\/node\/bin"/, 'without this, `npm` is not found and every agent install fails on a clean machine');
  assert.ok(
    macShim.indexOf('$RES/node/bin"\nexport PATH') < macShim.indexOf('exec "$RES/node/bin/node"'),
    'the export has to happen before the exec replaces the process',
  );
});

test('macOS shim targets bin/codemie.js, never dist/index.js', () => {
  assert.match(macShim, /bin\/codemie\.js/, 'must target the package bin entry');
  assert.doesNotMatch(macShim, /dist\/index\.js/, 'dist/index.js is a barrel with no CLI bootstrap');
});

test('macOS shim names the missing artifact before exiting 1', () => {
  assert.match(macShim, /\[ ! -x "\$RES\/node\/bin\/node" \]/, 'node guard');
  assert.match(macShim, /\[ ! -f "\$RES\/cli\/node_modules\/@codemieai\/code\/bin\/codemie\.js" \]/, 'entry guard');
});

test('runtime.json pins the darwin-arm64 Node checksum', () => {
  const rt = JSON.parse(readFileSync('runtime.json', 'utf8'));
  assert.match(rt.nodeMacosArm64Sha256 ?? '', /^[0-9a-f]{64}$/, 'nodeMacosArm64Sha256 must be a 64-hex SHA-256');
  assert.match(rt.nodeVersion, /^\d+\.\d+\.\d+$/, 'nodeVersion must be a plain semver');
});

test('tauri.macos.conf.json ships shim, node and the CLI tree with plain directory keys', () => {
  const conf = JSON.parse(readFileSync('src-tauri/tauri.macos.conf.json', 'utf8'));
  const res = conf.bundle.resources;
  assert.equal(res['../assets/macos/bin/codemie'], 'bin/codemie');
  assert.equal(res['../assets/macos/node/bin/node'], 'node/bin/node');
  assert.equal(res['../assets/codemie-cli/node_modules'], 'cli/node_modules');
  for (const [src, dst] of Object.entries(res)) {
    assert.doesNotMatch(src + dst, /\*/, `glob keys flatten the tree (spec §4): ${src} -> ${dst}`);
    assert.doesNotMatch(dst, /\.exe$/, 'no pkg binary in the macOS bundle');
  }
});

test('the shared tauri.conf.json declares no resources; each platform has its overlay', () => {
  const conf = JSON.parse(readFileSync('src-tauri/tauri.conf.json', 'utf8'));
  assert.equal(conf.bundle.resources, undefined, 'a shared resource forces the other platform to stage it before cargo builds');
});
