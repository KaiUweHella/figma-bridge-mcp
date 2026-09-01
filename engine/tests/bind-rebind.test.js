// Write classification shared by the Plan-bound Node Bind and Token Rebind Applications.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { isWrite } from '../../src/server.js';

describe('the write gate sees both commands', () => {
  test('node bind writes; node bindings still reads', () => {
    assert.equal(isWrite(['node', 'bind', '1:2', 'fill', 'brand']), true);
    assert.equal(isWrite(['node', 'bindings', '1:2']), false);
  });

  // Same rule as `tokens sync`: the plan is a read, --apply is the write.
  // Gating the plan would make an agent ask permission to look.
  test('tokens rebind is gated on --apply, not on the subcommand', () => {
    assert.equal(isWrite(['tokens', 'rebind', 'TARGET_COLLECTION', '--node', '1:2']), false);
    assert.equal(isWrite(['tokens', 'rebind', 'TARGET_COLLECTION', '--node', '1:2', '--apply']), true);
  });
});
