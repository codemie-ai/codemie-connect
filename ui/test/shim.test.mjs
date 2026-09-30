import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

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
