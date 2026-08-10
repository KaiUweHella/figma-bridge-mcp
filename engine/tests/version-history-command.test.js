import assert from 'node:assert/strict';
import test from 'node:test';
import { normalizeVersionRequest, saveVersionCode } from '../src/lib/version-history.js';

test('version requests trim user text and reject empty titles', () => {
  assert.deepEqual(normalizeVersionRequest({ title: '  Release 1 ', description: '  ready ' }), {
    title: 'Release 1', description: 'ready',
  });
  assert.throws(() => normalizeVersionRequest({ title: '   ' }), /must not be empty/);
});

test('history save uses the Plugin API and returns its version id', async () => {
  let received = null;
  const figma = {
    saveVersionHistoryAsync: async (...args) => { received = args; return { id: 'version-7' }; },
  };
  const result = await new Function('figma', `return ${saveVersionCode({ title: 'Release 1', description: 'Ready' })}`)(figma);
  assert.deepEqual(received, ['Release 1', 'Ready']);
  assert.deepEqual(result, { id: 'version-7', title: 'Release 1', description: 'Ready' });
});
