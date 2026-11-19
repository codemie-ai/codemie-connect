// Connect's skin for Knowledge (ui/plugins/frame/skins/obsidian.css): it restyles only, it is
// loaded for the versions it was checked against, and every class it names is still in the
// installed knowledge.css. The plugin is read from CONNECT_ECHO_PLUGINS_DIR (a marketplace folder
// or its plugins/; default $HOME/AI/projects/other/echo-plugins/plugins), never copied here.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { skinFor } from '../plugins/frame/shim.js';

const SKIN = readFileSync(new URL('../plugins/frame/skins/obsidian.css', import.meta.url), 'utf8');
const rules = css => css.replace(/\/\*[\s\S]*?\*\//g, '').split('}').map(r => r.split('{')).filter(r => r.length === 2);

function knowledgeCss() {
  const base = process.env.CONNECT_ECHO_PLUGINS_DIR || join(process.env.HOME || '', 'AI/projects/other/echo-plugins/plugins');
  for (const dir of [join(base, 'obsidian'), join(base, 'plugins/obsidian')]) {
    const f = join(dir, 'knowledge.css');
    if (existsSync(f)) return { css: readFileSync(f, 'utf8'), version: JSON.parse(readFileSync(join(dir, 'echo-plugin.json'), 'utf8')).version };
  }
  return null;
}

test('the skin is for Knowledge 1.0.x and 1.1.x only (its knowledge.css is the same)', () => {
  for (const v of ['1.0.1', '1.0.17', '1.1.0', '1.1.4']) assert.equal(skinFor('obsidian', v), 'skins/obsidian.css', v);
  for (const [id, v] of [['obsidian', '1.2.0'], ['obsidian', '2.0.0'], ['obsidian', ''], ['github', '1.0.1'], ['obsidian', '1.0.1-beta']]) {
    assert.equal(skinFor(id, v), null, `${id} ${v}`);
  }
});

test('the skin only restyles: nothing hidden, moved or reordered', () => {
  for (const [selector, body] of rules(SKIN)) {
    for (const banned of [/display\s*:\s*none/, /visibility\s*:/, /(^|;|\s)order\s*:/, /content\s*:/, /position\s*:/]) {
      assert.doesNotMatch(body, banned, `${selector.trim()}: ${banned}`);
    }
  }
});

test('every class the skin names is in the installed knowledge.css', t => {
  const k = knowledgeCss();
  if (!k) return t.skip('skipped: knowledge.css not found (set CONNECT_ECHO_PLUGINS_DIR)');
  const theirs = new Set(k.css.match(/\.[a-z][a-z0-9-]*/gi));
  const ours = new Set(rules(SKIN).flatMap(([selector]) => selector.match(/\.[a-z][a-z0-9-]*/gi) || []));
  const missing = [...ours].filter(c => !theirs.has(c));
  assert.deepEqual(missing, [], `classes gone from Knowledge ${k.version}`);
  assert.ok(skinFor('obsidian', k.version), `the skin isn't loaded for the installed Knowledge ${k.version}: check it and widen SKINS`);
});
