import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveInstancePlan } from '../src/lib/instance-plan.js';

test('key + id → key first (cross-file), id fallback (same-file)', () => {
  assert.deepEqual(resolveInstancePlan({ key: 'k', id: '1:2' }),
    [{ via: 'key', key: 'k' }, { via: 'id', id: '1:2' }]);
});
test('id only → id only', () => {
  assert.deepEqual(resolveInstancePlan({ id: '1:2' }), [{ via: 'id', id: '1:2' }]);
});
test('key only → key only', () => {
  assert.deepEqual(resolveInstancePlan({ key: 'k' }), [{ via: 'key', key: 'k' }]);
});
test('empty / null → empty plan', () => {
  assert.deepEqual(resolveInstancePlan(null), []);
  assert.deepEqual(resolveInstancePlan({}), []);
});
