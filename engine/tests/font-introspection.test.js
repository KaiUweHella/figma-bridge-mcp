import assert from 'node:assert/strict';
import test from 'node:test';
import {
  FONT_AXIS_METADATA_KEY,
  fontAxesCode,
  fontInspectCode,
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

test('font inspect reads range facts, variables, OpenType features and metadata without inventing axes', async () => {
  const metadata = {
    schemaVersion: 1,
    ranges: [{ start: 0, end: 5, axes: { wght: 357, wdth: 82 } }],
  };
  const text = {
    id: '1:2', type: 'TEXT', name: 'Label', characters: 'Hello',
    getStyledTextSegments: () => [{
      start: 0, end: 5, characters: 'Hello',
      fontName: { family: 'Roboto Flex', style: 'Regular' },
      fontSize: 16, fontWeight: 357,
      openTypeFeatures: { LIGA: true, SS01: false },
      boundVariables: { fontWeight: { id: 'VariableID:1' } },
    }],
    getPluginData: (key) => key === FONT_AXIS_METADATA_KEY ? JSON.stringify(metadata) : '',
  };
  const figma = {
    getNodeByIdAsync: async (id) => id === text.id ? text : null,
    variables: { getVariableByIdAsync: async () => ({ id: 'VariableID:1', name: 'type/weight' }) },
  };
  const code = fontInspectCode({ nodeId: text.id });
  assert.doesNotThrow(() => new Function('figma', `return ${code}`));
  const result = await new Function('figma', `return ${code}`)(figma);
  assert.equal(result.segments[0].fontWeight, 357);
  assert.deepEqual(result.segments[0].enabledOpenTypeFeatures, ['LIGA']);
  assert.deepEqual(result.segments[0].boundVariables.fontWeight, {
    id: 'VariableID:1', name: 'type/weight',
  });
  assert.deepEqual(result.axisMetadata.ranges, metadata.ranges);
  assert.equal(result.axisMetadata.appliedToFont, false);
  assert.equal(result.apiLimits.exactVariationAxes, false);
});

test('all-open-type mode preserves false feature values too', async () => {
  const text = {
    id: '1:2', type: 'TEXT', name: 'Label', characters: 'Hi',
    getStyledTextSegments: () => [{
      start: 0, end: 2, characters: 'Hi',
      fontName: { family: 'Inter', style: 'Regular' }, fontSize: 16, fontWeight: 400,
      openTypeFeatures: { LIGA: true, SS01: false }, boundVariables: {},
    }],
    getPluginData: () => '',
  };
  const figma = { getNodeByIdAsync: async () => text, variables: { getVariableByIdAsync: async () => null } };
  const result = await new Function('figma', `return ${fontInspectCode({ nodeId: text.id, allOpenType: true })}`)(figma);
  assert.deepEqual(result.segments[0].openTypeFeatures, { LIGA: true, SS01: false });
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
