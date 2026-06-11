// Ported from the Electron app's test/steps.test.js (STATUS_META + makeStep half) to ESM.
import test from 'node:test';
import assert from 'node:assert';
import { StepStatus, STATUS_META, makeStep } from '../models.js';

test('STATUS_META covers every status with icon + hex color', () => {
  for (const s of Object.values(StepStatus)) {
    assert.ok(STATUS_META[s], `missing meta for ${s}`);
    assert.match(STATUS_META[s].color, /^#[0-9a-f]{6}$/i);
    assert.ok(STATUS_META[s].icon);
  }
});

test('makeStep applies defaults and normalizes types', () => {
  const s = makeStep({ id: 1.1, title: 'X', requires_approval: true, parent_id: 1.0 });
  assert.strictEqual(s.id, '1.1');
  assert.strictEqual(s.status, StepStatus.PENDING);
  assert.strictEqual(s.requires_approval, true);
  assert.strictEqual(s.is_sub_step, false);
  assert.strictEqual(s.parent_id, '1');
  assert.strictEqual(s.description, '');
});
