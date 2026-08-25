import assert from 'node:assert/strict';
import test from 'node:test';
import { planFigmaCommand } from '../../src/capability-catalog.js';
import {
  executeLayoutGridFacts,
  executeLayoutGridFactsPlan,
  layoutGridFactsCode,
  layoutGridFactsPlanRoute,
  layoutGridFactsPlanningArgvFromRequest,
  MAX_LAYOUT_GRID_FACTS_GRIDS,
} from '../src/application/layout-grid-facts-command.js';
import {
  acceptsLayoutGridFactsArgv,
  layoutGridFactsArgvFromRequest,
  layoutGridFactsFigmaUrlFileKeyFromArgv,
  parseLayoutGridFactsRequest,
} from '../src/application/layout-grid-facts-request.js';
import { isFigmaPositiveInfinity } from '../src/application/figma-scalar.js';

const AUTO_GRID = {
  pattern: 'COLUMNS',
  alignment: 'STRETCH',
  gutterSize: 16,
  count: { $figmaScalar: 'Infinity' },
  offset: 24,
  visible: true,
  color: { r: 1, g: 0, b: 0.5, a: 0.1 },
  boundVariables: {
    gutterSize: { type: 'VARIABLE_ALIAS', id: 'VariableID:1:2' },
  },
};

const PAYLOAD = {
  schemaVersion: 1,
  source: 'node',
  node: { id: '10:3', name: 'Grid frame', type: 'FRAME' },
  gridStyleId: '',
  layoutGrids: [
    AUTO_GRID,
    { pattern: 'GRID', sectionSize: 8 },
  ],
};

test('Layout Grid Facts request closes optional node and JSON forms', () => {
  assert.deepEqual(parseLayoutGridFactsRequest(['grid', 'list', '--json', '10-3']), {
    nodeId: '10:3', json: true, warning: '',
  });
  assert.deepEqual(parseLayoutGridFactsRequest(['grid', 'list']), {
    nodeId: null, json: false, warning: '',
  });
  assert.deepEqual(layoutGridFactsArgvFromRequest({ nodeId: '10-3', json: true }),
    ['grid', 'list', '10:3', '--json']);
  for (const argv of [
    ['grid', 'list', '10:3', '10:4'],
    ['grid', 'list', '--future', 'private-value'],
    ['grid', 'list', '--json', '--json'],
    ['grid', 'list', 'not-a-node'],
  ]) assert.equal(acceptsLayoutGridFactsArgv(argv), false, argv.join(' '));
});

test('Layout Grid Facts preserves Auto as one versioned scalar and formats exact JSON', async () => {
  const node = {
    id: '10:3',
    name: 'Grid frame',
    type: 'FRAME',
    gridStyleId: '',
    layoutGrids: [
      { ...AUTO_GRID, count: Infinity },
      { pattern: 'GRID', sectionSize: 8 },
    ],
  };
  const serialized = await new Function(
    'figma',
    `return ${layoutGridFactsCode({ nodeId: '10:3' })}`,
  )({ getNodeByIdAsync: async () => node });
  const projected = JSON.parse(serialized);
  assert.deepEqual(projected, PAYLOAD);
  assert.equal(isFigmaPositiveInfinity(projected.layoutGrids[0].count), true);

  const text = await executeLayoutGridFacts({ nodeId: '10:3' }, {
    evaluate: async () => serialized,
  });
  assert.match(text.stdout, /^Grid frame \(10:3, FRAME\)$/m);
  assert.match(text.stdout, /count=Auto/);
  assert.match(text.stdout, /bindings=gutterSize→VariableID:1:2/);
  assert.doesNotMatch(text.stdout, /count=null|\[object Object\]/);

  const json = await executeLayoutGridFacts({ nodeId: '10:3', json: true }, {
    evaluate: async () => serialized,
  });
  assert.equal(Object.hasOwn(JSON.parse(json.stdout), 'schemaVersion'), false);
  assert.deepEqual(JSON.parse(json.stdout).layoutGrids[0].count, {
    $figmaScalar: 'Infinity',
  });
});

test('Layout Grid Facts supports bounded current-selection reads', async () => {
  const selectionPayload = {
    ...PAYLOAD,
    source: 'selection',
  };
  const result = await executeLayoutGridFacts({ nodeId: null }, {
    evaluate: async () => JSON.stringify(selectionPayload),
  });
  assert.equal(result.result.source, 'selection');
  const selected = await new Function(
    'figma',
    `return ${layoutGridFactsCode({ nodeId: null })}`,
  )({ currentPage: { selection: [{
    id: '10:3', name: 'Grid frame', type: 'FRAME', gridStyleId: '', layoutGrids: [],
  }] } });
  assert.equal(JSON.parse(selected).source, 'selection');
});

test('Layout Grid Facts fails closed on silent JSON loss, union drift, and unbounded output', async () => {
  for (const malformed of [
    { ...PAYLOAD, layoutGrids: [{ ...AUTO_GRID, count: null }] },
    { ...PAYLOAD, layoutGrids: [{ ...AUTO_GRID, count: { $figmaScalar: '-Infinity' } }] },
    { ...PAYLOAD, layoutGrids: [{ ...AUTO_GRID, futureField: 'private' }] },
    { ...PAYLOAD, node: { ...PAYLOAD.node, id: '10:4' } },
    { ...PAYLOAD, layoutGrids: Array(MAX_LAYOUT_GRID_FACTS_GRIDS + 1).fill({
      pattern: 'GRID', sectionSize: 8,
    }) },
  ]) {
    await assert.rejects(
      () => executeLayoutGridFacts({ nodeId: '10:3' }, {
        evaluate: async () => JSON.stringify(malformed),
      }),
      /invalid bounded result/,
    );
  }
  const nanNode = {
    id: '10:3', name: 'Grid frame', type: 'FRAME', gridStyleId: '',
    layoutGrids: [{ pattern: 'GRID', sectionSize: NaN }],
  };
  await assert.rejects(
    () => new Function('figma', `return ${layoutGridFactsCode({ nodeId: '10:3' })}`)({
      getNodeByIdAsync: async () => nanNode,
    }),
    /unsupported non-finite number/,
  );
});

test('Layout Grid Facts Plan is one policy-identical safe-read route', async () => {
  const plan = planFigmaCommand(['grid', 'list', '10-3', '--json'], { adapter: 'cli' });
  assert.equal(plan.allowed, true);
  assert.equal(plan.execution.retry, 'safe-read');
  assert.equal(plan.effects.figma, 'read');
  assert.equal(layoutGridFactsPlanRoute(plan), 'command-application');
  assert.deepEqual(plan.argv, ['grid', 'list', '10:3', '--json']);
  assert.deepEqual(
    (await executeLayoutGridFactsPlan(plan, {
      evaluate: async () => JSON.stringify(PAYLOAD),
    })).result,
    PAYLOAD,
  );
  await assert.rejects(
    () => executeLayoutGridFactsPlan({ ...plan }, {
      evaluate: async () => JSON.stringify(PAYLOAD),
    }),
    /requires a Command Plan created by the Capability Catalog/,
  );
  assert.equal(layoutGridFactsPlanRoute(
    planFigmaCommand(['grid', 'clear', '10:3'], { adapter: 'mcp' }),
  ), 'not-layout-grid-facts');
});

test('Layout Grid Facts owns option-first URL targeting and canonical dispatch', () => {
  const url = 'https://www.figma.com/design/FILEA/Grid-Lab?node-id=10-3';
  const planningArgv = layoutGridFactsPlanningArgvFromRequest({ nodeId: url, json: true });
  assert.equal(layoutGridFactsFigmaUrlFileKeyFromArgv(planningArgv), 'FILEA');
  const typed = planFigmaCommand(planningArgv, { adapter: 'mcp' });
  const optionFirst = planFigmaCommand(['grid', 'list', '--json', url], { adapter: 'mcp' });
  assert.equal(typed.target.fileKey, 'FILEA');
  assert.equal(optionFirst.target.fileKey, 'FILEA');
  assert.deepEqual(optionFirst.argv, ['grid', 'list', '10:3', '--json']);
});

test('Layout Grid Facts generated Plugin code parses', () => {
  assert.doesNotThrow(() => new Function(`return ${layoutGridFactsCode({ nodeId: '10:3' })}`));
  assert.doesNotThrow(() => new Function(`return ${layoutGridFactsCode({ nodeId: null })}`));
});
