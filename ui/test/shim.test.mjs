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

test('shim propagates the CLI exit code', () => {
  assert.match(shim, /exit \/b %ERRORLEVEL%/i, 'without this the shim always reports success');
});

test('shim does not reference the removed pkg binary', () => {
  assert.doesNotMatch(shim, /codemie\.exe/i, 'the pkg binary is no longer produced');
});

// lib.rs builds the absolute CLI entry that self_update_direct runs with the bundled
// node.exe. It must point at the same entry as the shim: dist/index.js would make
// `codemie self-update` exit 0 without doing anything.
test('lib.rs cli_entry_path targets bin/codemie.js, never dist/index.js', () => {
  const lib = readFileSync('src-tauri/src/lib.rs', 'utf8');
  assert.match(lib, /\.join\("bin"\)\s*\.join\("codemie\.js"\)/, 'must target the package bin entry');
  assert.doesNotMatch(lib, /\.join\("dist"\)\s*\.join\("index\.js"\)/, 'dist/index.js is a barrel with no CLI bootstrap');
});
