import assert from 'node:assert/strict';
import test from 'node:test';
import { executeInspect, formatInspection, inspectNodeCode } from '../src/application/inspect-command.js';

const RESULT = {
  id: '1:2', name: 'Card', type: 'FRAME', width: 320, height: 180,
  absolutePositioning: {
    position: 'ABSOLUTE', start: 16, end: null, top: 24, bottom: null,
    centerHorizontalOffset: null, centerVerticalOffset: null,
    width: 320, height: 180, layoutSizingHorizontal: null, layoutSizingVertical: null,
  },
  style: { fills: ['#ffffff'], cornerRadius: 16, clipsContent: true },
  raw: { x: 16, y: 24, constraints: { horizontal: 'MIN', vertical: 'MIN' } },
};

test('inspect Command Application returns values through one evaluate adapter', async () => {
  let code = '';
  const result = await executeInspect({ nodeId: '1-2', format: 'yaml' }, {
    evaluate: async (value) => { code = value; return RESULT; },
  });
  assert.match(code, /getNodeByIdAsync\("1:2"\)/);
  assert.match(result.stdout, /name: Card/);
  assert.match(result.stdout, /cornerRadius: 16/);
  assert.equal(result.result, RESULT);
});

test('inspect formats share one captured result without losing facts', () => {
  const json = JSON.parse(formatInspection(RESULT, 'json'));
  assert.deepEqual(json, RESULT);
  assert.deepEqual(JSON.parse(formatInspection(RESULT, 'spec')), RESULT.absolutePositioning);
  assert.match(formatInspection(RESULT, 'text'), /Absolute Positioning spec/);
  assert.match(formatInspection(RESULT, 'yaml'), /clipsContent: true/);
});

test('inspect validates before evaluating and generated plugin code parses', async () => {
  await assert.rejects(() => executeInspect({ nodeId: '', format: 'yaml' }, { evaluate: async () => RESULT }), /non-empty nodeId/);
  await assert.rejects(() => executeInspect({ nodeId: '1:2', format: 'toml' }, { evaluate: async () => RESULT }), /Unknown inspect format/);
  assert.doesNotThrow(() => new Function(`return ${inspectNodeCode('1:2')};`));
});
