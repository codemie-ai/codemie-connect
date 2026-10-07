import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

// The CLI looks for codemie-connect.json next to its package.json to know it
// is the copy inside CodeMie Connect, which updates with the app instead of
// running npm (EPMCDME-15433). Both build scripts write it and refuse to
// finish without it.
for (const [script, sep] of [['scripts/stage-runtime.sh', '/'], ['scripts/stage-runtime.ps1', '\\']]) {
  test(`${script} writes and requires the CodeMie Connect marker`, () => {
    const src = readFileSync(script, 'utf8');
    const marker = `${sep}codemie-connect.json`;
    const writes = src.split('\n').filter((l) => l.includes(marker) && /printf|Set-Content/.test(l));
    assert.equal(writes.length, 1, 'the marker is written once');
    assert.match(writes[0], /"managedBy": "CodeMie Connect"/);
    const verify = src.slice(src.indexOf('4. Verify'));
    assert.ok(verify.includes(`codemie-connect.json`), 'the verify step requires the marker');
  });
}
