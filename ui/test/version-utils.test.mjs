// Tests for semverLt — copy the function here for isolated testing.
// The implementation lives in renderer.js; keep this in sync.
import test from 'node:test';
import assert from 'node:assert/strict';

function semverLt(a, b) {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const na = pa[i] ?? 0;
    const nb = pb[i] ?? 0;
    if (na < nb) return true;
    if (na > nb) return false;
  }
  return false;
}

test('lower minor is less than', () => {
  assert.strictEqual(semverLt('0.3.9', '0.4.1'), true);
});

test('equal versions are not less than', () => {
  assert.strictEqual(semverLt('0.4.1', '0.4.1'), false);
});

test('higher version is not less than', () => {
  assert.strictEqual(semverLt('0.5.0', '0.4.1'), false);
});

test('major boundary: 0.9.9 < 1.0.0', () => {
  assert.strictEqual(semverLt('0.9.9', '1.0.0'), true);
});

test('analytics threshold: 0.4.0 < 0.4.1', () => {
  assert.strictEqual(semverLt('0.4.0', '0.4.1'), true);
});

test('analytics threshold: 0.4.1 is not < 0.4.1', () => {
  assert.strictEqual(semverLt('0.4.1', '0.4.1'), false);
});

test('analytics threshold: 0.4.2 is not < 0.4.1', () => {
  assert.strictEqual(semverLt('0.4.2', '0.4.1'), false);
});
