import assert from 'node:assert/strict';
import test from 'node:test';
import {
  FONT_AXIS_METADATA_KEY,
  fontAxesCode,
  forgetAxesCode,
  parseAxisSpec,
  rememberAxesCode,
} from '../src/lib/font-introspection.js';

test('axis specs accept OpenType tags and finite numeric values', () => {
  assert.deepEqual(parseAxisSpec('wght=357, wdth=82, XTRA=468.5'), {
    wght: 357,
    wdth: 82,
    XTRA: 468.5,
  });
  assert.throws(() => parseAxisSpec('weight=357'), /four characters/);
  assert.throws(() => parseAxisSpec('wght=nope'), /finite number/);
  assert.throws(() => parseAxisSpec('wght=357,wght=400'), /duplicate axis/);
  assert.throws(() => parseAxisSpec(''), /at least one axis/);
});

test('remember/forget commands only mutate plugin metadata, never font rendering', async () => {
  let stored = '';
  const text = {
    id: '1:2', type: 'TEXT', name: 'Label', characters: 'Hello',
    getPluginData: () => stored,
    setPluginData: (key, value) => {
      assert.equal(key, FONT_AXIS_METADATA_KEY);
      stored = value;
    },
  };
  const figma = { getNodeByIdAsync: async () => text };
  const remember = rememberAxesCode({ nodeId: text.id, axes: { wght: 357 }, start: 1, end: 4 });
  assert.doesNotMatch(remember, /setRangeFontName|setRangeBoundVariable|fontName\s*=/);
  const saved = await new Function('figma', `return ${remember}`)(figma);
  assert.equal(saved.appliedToFont, false);
  assert.deepEqual(JSON.parse(stored).ranges, [{ start: 1, end: 4, axes: { wght: 357 } }]);

  const read = await new Function('figma', `return ${fontAxesCode({ nodeId: text.id })}`)(figma);
  assert.deepEqual(read.ranges, [{ start: 1, end: 4, axes: { wght: 357 } }]);

  const forgotten = await new Function('figma', `return ${forgetAxesCode({ nodeId: text.id, start: 1, end: 4 })}`)(figma);
  assert.equal(forgotten.cleared, 1);
  assert.equal(stored, '', 'the plugin-data key is removed when its last range is forgotten');
});

test('range validation happens against the live text length', async () => {
  const text = {
    id: '1:2', type: 'TEXT', characters: 'Hello', getPluginData: () => '', setPluginData: () => {},
  };
  const figma = { getNodeByIdAsync: async () => text };
  const code = rememberAxesCode({ nodeId: text.id, axes: { wght: 357 }, start: 3, end: 9 });
  await assert.rejects(new Function('figma', `return ${code}`)(figma), /outside text length/);
});
