import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildManifest } from '../../scripts/generate-release-manifest.mjs';

const BASE = 'https://github.com/codemie-ai/codemie-connect/releases/download/v2.1.1';
const MAC = 'CodeMie-Connect-2.1.1-aarch64.dmg';
const SETUP = 'CodeMie-Connect-2.1.1-x64-setup.exe';
const AMD64 = 'CodeMie-Connect-2.1.1-windows-amd64.exe';

test('mac-only release lists only darwin-aarch64, with the bare version', () => {
  const m = buildManifest({ tag: 'v2.1.1', assetNames: [MAC] });
  assert.deepEqual(m, { version: '2.1.1', platforms: { 'darwin-aarch64': { url: `${BASE}/${MAC}` } } });
});

test('mac plus setup.exe lists both platforms', () => {
  const m = buildManifest({ tag: 'v2.1.1', assetNames: [MAC, SETUP] });
  assert.equal(m.platforms['windows-x86_64'].url, `${BASE}/${SETUP}`);
  assert.equal(m.platforms['darwin-aarch64'].url, `${BASE}/${MAC}`);
});

test('windows-amd64.exe alone is enough for windows-x86_64', () => {
  const m = buildManifest({ tag: 'v2.1.1', assetNames: [AMD64] });
  assert.deepEqual(Object.keys(m.platforms), ['windows-x86_64']);
  assert.equal(m.platforms['windows-x86_64'].url, `${BASE}/${AMD64}`);
});

test('when both windows installers exist the setup.exe wins', () => {
  const m = buildManifest({ tag: 'v2.1.1', assetNames: [AMD64, SETUP] });
  assert.equal(m.platforms['windows-x86_64'].url, `${BASE}/${SETUP}`);
});

test('checksums and unrelated assets are ignored', () => {
  const m = buildManifest({ tag: 'v2.1.1', assetNames: [`${MAC}.sha256`, 'notes.txt', 'manifest.json'] });
  assert.deepEqual(m.platforms, {});
});

test('CLI reads assets through gh and writes the manifest file', () => {
  const dir = mkdtempSync(join(tmpdir(), 'manifest-'));
  const gh = join(dir, 'gh');
  writeFileSync(gh, `#!/bin/sh\necho '{"assets":[{"name":"${MAC}"},{"name":"${MAC}.sha256"}]}'\n`);
  chmodSync(gh, 0o755);
  const out = join(dir, 'out.json');
  const r = spawnSync('node', ['scripts/generate-release-manifest.mjs', 'v2.1.1', out], {
    env: { ...process.env, PATH: `${dir}:${process.env.PATH}` },
    encoding: 'utf8',
  });
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(JSON.parse(readFileSync(out, 'utf8')), {
    version: '2.1.1',
    platforms: { 'darwin-aarch64': { url: `${BASE}/${MAC}` } },
  });
});
