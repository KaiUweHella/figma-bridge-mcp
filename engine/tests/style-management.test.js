import assert from 'node:assert/strict';
import test from 'node:test';
import {
  parseStyleProperties, parseStyleType,
} from '../src/lib/style-management.js';

test('style input accepts only current type-specific Figma fields', () => {
  assert.equal(parseStyleType('paint'), 'PAINT');
  assert.deepEqual(parseStyleProperties('{"paints":[]}', 'PAINT'), { paints: [] });
  assert.throws(() => parseStyleProperties('{"effects":[]}', 'PAINT'), /Unsupported PAINT/);
  assert.throws(() => parseStyleProperties('[]', 'TEXT'), /JSON object/);
});
