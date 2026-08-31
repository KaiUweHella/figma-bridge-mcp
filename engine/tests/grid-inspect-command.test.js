import assert from 'node:assert/strict';
import test from 'node:test';

import { planFigmaCommand } from '../../src/capability-catalog.js';
import {
  executeGridInspect,
  executeGridInspectPlan,
  gridInspectCode,
  gridInspectPlanRoute,
  gridInspectPlanningArgvFromRequest,
  MAX_GRID_INSPECT_RESULT_CODE_UNITS,
} from '../src/application/grid-inspect-command.js';
import {
  acceptsGridInspectArgv,
  gridInspectArgvFromRequest,
  gridInspectFigmaUrlFileKeyFromArgv,
  parseGridInspectRequest,
} from '../src/application/grid-inspect-request.js';

const GRID_FACT = {
  id: '1:1', name: 'Neutral Grid', type: 'FRAME', layoutMode: 'GRID',
  rows: 2, columns: 2, rowGap: 8, columnGap: 10,
  rowSizes: [{ type: 'FIXED', value: 40 }, { type: 'HUG' }],
  columnSizes: [{ type: 'FLEX', value: 1 }, { type: 'FIXED', value: 80 }],
  autoTracks: 'NONE', itemsPositioning: 'MANUAL',
};

function fixture(overrides = {}) {
  const node = {
    id: GRID_FACT.id,
    name: GRID_FACT.name,
    type: GRID_FACT.type,
    layoutMode: GRID_FACT.layoutMode,
    gridRowCount: GRID_FACT.rows,
    gridColumnCount: GRID_FACT.columns,
    gridRowGap: GRID_FACT.rowGap,
    gridColumnGap: GRID_FACT.columnGap,
    gridRowSizes: GRID_FACT.rowSizes,
    gridColumnSizes: GRID_FACT.columnSizes,
    gridAutoTracks: GRID_FACT.autoTracks,
    gridItemsPositioning: GRID_FACT.itemsPositioning,
    ...overrides,
  };
  return {
    node,
    figma: { getNodeByIdAsync: async (id) => id === node.id ? node : null },
  };
}
const evaluate = (figma) => async (code) => new Function('figma', `return ${code}`)(figma);

test('Grid Inspect closes its grammar and canonicalizes URL targeting', () => {
  const url = 'https://www.figma.com/design/FILEA/Grid-Lab?node-id=1-1';
  assert.deepEqual(parseGridInspectRequest(['layout', 'grid', 'inspect', '1-1']), {
    nodeId: '1:1', warning: '',
  });
  assert.equal(gridInspectFigmaUrlFileKeyFromArgv(['layout', 'grid', 'inspect', url]), 'FILEA');
  assert.deepEqual(gridInspectArgvFromRequest({ nodeId: '1-1' }), [
    'layout', 'grid', 'inspect', '--', '1:1',
  ]);
  for (const args of [
    ['layout', 'grid', 'inspect'],
    ['layout', 'grid', 'inspect', '1:1', '2:1'],
    ['layout', 'grid', 'inspect', '--future', 'private-value'],
    ['layout', 'grid', 'inspect', 'not-a-node'],
  ]) assert.equal(acceptsGridInspectArgv(args), false, args.join(' '));

  const plan = planFigmaCommand(gridInspectPlanningArgvFromRequest({ nodeId: url }), {
    adapter: 'mcp',
  });
  assert.equal(plan.target.fileKey, 'FILEA');
  assert.deepEqual(plan.argv, ['layout', 'grid', 'inspect', '--', '1:1']);
});

test('Grid Inspect preserves the established bounded native Grid report', async () => {
  const live = fixture();
  const result = await executeGridInspect({ nodeId: '1:1' }, {
    evaluate: evaluate(live.figma),
  });
  assert.deepEqual(result.result, GRID_FACT);
  assert.deepEqual(JSON.parse(result.stdout), GRID_FACT);
});

test('Grid Inspect rejects non-Grid, inconsistent, malformed, and oversized facts', async () => {
  await assert.rejects(() => executeGridInspect({ nodeId: '1:1' }, {
    evaluate: evaluate(fixture({ layoutMode: 'HORIZONTAL' }).figma),
  }), /not an Auto Layout Grid container/);
  await assert.rejects(() => executeGridInspect({ nodeId: '1:1' }, {
    evaluate: evaluate(fixture({ gridRowCount: 3 }).figma),
  }), /invalid bounded Grid facts/);

  for (const value of [
    'not-json',
    JSON.stringify({ ...GRID_FACT, privateField: true }),
    JSON.stringify({ ...GRID_FACT, id: '2:2' }),
    JSON.stringify({ ...GRID_FACT, rowSizes: [{ type: 'AUTO' }, GRID_FACT.rowSizes[1]] }),
    'x'.repeat(MAX_GRID_INSPECT_RESULT_CODE_UNITS + 1),
  ]) {
    await assert.rejects(
      () => executeGridInspect({ nodeId: '1:1' }, { evaluate: async () => value }),
      /invalid (?:JSON|bounded result)/,
    );
  }
});

test('Grid Inspect owns one authentic cross-Adapter safe-read Plan', async () => {
  const url = 'https://www.figma.com/design/FILEA/Grid-Lab?node-id=1-1';
  const mcp = planFigmaCommand(gridInspectPlanningArgvFromRequest({ nodeId: url }), {
    adapter: 'mcp',
  });
  const cli = planFigmaCommand(mcp.argv, { adapter: 'cli', fileKey: mcp.target.fileKey });
  assert.equal(mcp.allowed, true); assert.equal(cli.allowed, true);
  assert.equal(mcp.id, 'layout.grid.inspect'); assert.deepEqual(cli.effects, mcp.effects);
  assert.equal(mcp.execution.retry, 'safe-read'); assert.equal(mcp.target.fileKey, 'FILEA');
  assert.equal(gridInspectPlanRoute(mcp), 'command-application');
  let evaluations = 0;
  const result = await executeGridInspectPlan(mcp, {
    evaluate: async () => { evaluations += 1; return JSON.stringify(GRID_FACT); },
  });
  assert.equal(evaluations, 1); assert.deepEqual(result.result, GRID_FACT);
});

test('Grid Inspect owns its Plan deadline and performs no mutation', () => {
  const source = gridInspectCode({ nodeId: '1:1' });
  assert.doesNotMatch(source, /setTimeout|gridRowCount\s*=|gridColumnCount\s*=|layoutMode\s*=/);
  assert.doesNotThrow(() => new Function('figma', `return ${source}`));
});
