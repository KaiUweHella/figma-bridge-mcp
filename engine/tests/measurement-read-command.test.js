import assert from 'node:assert/strict';
import test from 'node:test';
import { planFigmaCommand } from '../../src/capability-catalog.js';
import {
  executeMeasurementRead,
  executeMeasurementReadPlan,
  MAX_MEASUREMENT_READ_ITEMS,
  measurementReadCode,
  measurementReadPlanRoute,
  measurementReadPlanningArgvFromRequest,
} from '../src/application/measurement-read-command.js';
import {
  acceptsMeasurementReadArgv,
  parseMeasurementReadRequest,
} from '../src/application/measurement-read-request.js';

const first = { id: '1:2', name: 'First', type: 'RECTANGLE', x: 0 };
const second = { id: '1:3', name: 'Second', type: 'FRAME', x: 20 };
const measurement = {
  id: 'M:1',
  start: { node: first, side: 'RIGHT' },
  end: { node: second, side: 'LEFT' },
  offset: { type: 'OUTER', fixed: 12 },
  freeText: 'Gap',
};
const FACT = {
  id: 'M:1',
  start: { node: { id: '1:2', name: 'First', type: 'RECTANGLE' }, side: 'RIGHT' },
  end: { node: { id: '1:3', name: 'Second', type: 'FRAME' }, side: 'LEFT' },
  offset: { type: 'OUTER', fixed: 12 },
  freeText: 'Gap',
};

function runtime() {
  const values = [measurement];
  return {
    currentPage: {
      type: 'PAGE',
      getMeasurements: () => values,
      getMeasurementsForNode: (node) => values.filter((value) => (
        value.start.node === node || value.end.node === node
      )),
    },
    getNodeByIdAsync: async (id) => new Map([[first.id, first], [second.id, second]]).get(id) || null,
  };
}

test('Measurement Read closes and canonicalizes optional node and URL targets', () => {
  assert.deepEqual(parseMeasurementReadRequest(['measure', 'list']), { nodeId: null, warning: '' });
  assert.deepEqual(parseMeasurementReadRequest(['measure', 'list', '--', '1-2']), {
    nodeId: '1:2', warning: '',
  });
  assert.equal(acceptsMeasurementReadArgv(['measure', 'list', '1:2']), true);
  for (const argv of [
    ['measure', 'list', '1:2', '1:3'],
    ['measure', 'list', '--future'],
    ['measure', 'list', 'not-a-node'],
  ]) assert.equal(acceptsMeasurementReadArgv(argv), false, argv.join(' '));

  const url = 'https://www.figma.com/design/FILEA/Measurement-Lab?node-id=1-2';
  const planning = measurementReadPlanningArgvFromRequest({ nodeId: url });
  const plan = planFigmaCommand(planning, { adapter: 'mcp' });
  assert.equal(plan.target.fileKey, 'FILEA');
  assert.deepEqual(plan.argv, ['measure', 'list', '--', '1:2']);
});

test('Measurement Read returns the existing list shape for page and node scopes', async () => {
  for (const request of [{}, { nodeId: '1:2' }]) {
    const result = await executeMeasurementRead(request, {
      evaluate: async (code) => new Function('figma', `return ${code};`)(runtime()),
    });
    assert.deepEqual(result.result, [FACT]);
    assert.deepEqual(JSON.parse(result.stdout), [FACT]);
  }
  const none = await new Function('figma', `return ${measurementReadCode({ nodeId: '2:9' })};`)({
    ...runtime(), getNodeByIdAsync: async () => ({ id: '2:9', type: 'RECTANGLE', x: 0 }),
  });
  assert.equal(none, '[]');
});

test('Measurement Read refuses missing nodes and malformed or oversized Plugin facts', async () => {
  await assert.rejects(
    () => new Function('figma', `return ${measurementReadCode({ nodeId: '9:9' })};`)(runtime()),
    /not found in the targeted Figma document/,
  );
  for (const value of [
    'not-json',
    JSON.stringify([{ ...FACT, privateField: 'x' }]),
    JSON.stringify([{ ...FACT, start: { ...FACT.start, side: 'CENTER' } }]),
    JSON.stringify(Array(MAX_MEASUREMENT_READ_ITEMS + 1).fill(FACT)),
  ]) {
    await assert.rejects(
      () => executeMeasurementRead({}, { evaluate: async () => value }),
      /invalid (?:JSON|bounded result)/,
    );
  }
});

test('Measurement Read uses one safe-read Application in CLI and MCP Plans', async () => {
  const mcp = planFigmaCommand(['measure', 'list', '1-2'], { adapter: 'mcp' });
  const cli = planFigmaCommand(mcp.argv, { adapter: 'cli' });
  assert.equal(mcp.allowed, true);
  assert.equal(mcp.id, 'measure.list');
  assert.equal(mcp.execution.retry, 'safe-read');
  assert.deepEqual(mcp.effects, cli.effects);
  assert.equal(measurementReadPlanRoute(mcp), 'command-application');
  const result = await executeMeasurementReadPlan(mcp, {
    evaluate: async () => JSON.stringify([FACT]),
  });
  assert.deepEqual(result.result, [FACT]);
  assert.throws(
    () => executeMeasurementReadPlan({ ...mcp }, { evaluate: async () => '[]' }),
    /requires a Command Plan/,
  );
});

test('Measurement Read owns the Plan deadline instead of embedding a private timer', () => {
  const source = measurementReadCode({});
  assert.doesNotMatch(source, /setTimeout|18s/);
  assert.match(source, /getMeasurements\(\)/);
  assert.match(source, /getMeasurementsForNode\(node\)/);
});
