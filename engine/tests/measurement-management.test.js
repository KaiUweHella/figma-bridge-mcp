import assert from 'node:assert/strict';
import test from 'node:test';
import {
  measurementAddCode, measurementDeleteCode, measurementEditCode, measurementListCode,
  parseMeasurementEndpoint, parseMeasurementOffset,
} from '../src/lib/measurement-management.js';

const execute = (code, figma) => new Function('figma', `return ${code}`)(figma);

function fixture(editorType = 'dev') {
  const a = { id: '1:2', name: 'A', type: 'FRAME', x: 0 };
  const b = { id: '3:4', name: 'B', type: 'FRAME', x: 100 };
  const measurements = [];
  const page = {
    getMeasurements: () => measurements,
    getMeasurementsForNode: (node) => measurements.filter((m) => m.start.node === node || m.end.node === node),
    addMeasurement(start, end, options = {}) { const m = { id: 'M:1', start, end, offset: options.offset || { type: 'INNER', relative: 0 }, freeText: options.freeText || '' }; measurements.push(m); return m; },
    editMeasurement(id, values) { const m = measurements.find((value) => value.id === id); Object.assign(m, values); return m; },
    deleteMeasurement(id) { measurements.splice(measurements.findIndex((m) => m.id === id), 1); },
  };
  return { measurements, figma: { editorType, currentPage: page, getNodeByIdAsync: async (id) => id === a.id ? a : id === b.id ? b : null } };
}

test('measurement endpoints retain colon node IDs and offsets are strict', () => {
  assert.deepEqual(parseMeasurementEndpoint('1:2:right'), { nodeId: '1:2', side: 'RIGHT' });
  assert.deepEqual(parseMeasurementOffset({ offset: '12' }), { type: 'OUTER', fixed: 12 });
  assert.throws(() => parseMeasurementOffset({ relative: 2 }), /between 0 and 1/);
});

test('measurement commands round-trip PageNode measurement facts and enforce Dev Mode writes', async () => {
  const { measurements, figma } = fixture();
  const added = await execute(measurementAddCode({ from: '1:2:right', to: '3:4:left', offset: 8, text: 'gap' }), figma);
  assert.equal(added.freeText, 'gap');
  assert.equal((await execute(measurementListCode({}), figma)).length, 1);
  assert.equal((await execute(measurementEditCode({ id: 'M:1', text: 'space' }), figma)).freeText, 'space');
  await execute(measurementDeleteCode({ id: 'M:1' }), figma);
  assert.equal(measurements.length, 0);
  const design = fixture('figma');
  await assert.rejects(() => execute(measurementAddCode({ from: '1:2:right', to: '3:4:left' }), design.figma), /Dev Mode/);
});
