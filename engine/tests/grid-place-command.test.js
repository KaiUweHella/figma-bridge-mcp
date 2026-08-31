import assert from 'node:assert/strict';
import test from 'node:test';

import { planFigmaCommand } from '../../src/capability-catalog.js';
import {
  executeGridPlace,
  executeGridPlacePlan,
  gridPlaceCode,
  gridPlacePlanRoute,
} from '../src/application/grid-place-command.js';
import {
  acceptsGridPlaceArgv,
  gridPlaceArgvFromRequest,
  gridPlaceFigmaUrlFileKeyFromArgv,
  gridPlacePlanningArgvFromRequest,
  parseGridPlaceRequest,
} from '../src/application/grid-place-request.js';

function fixture({
  sameParent = false,
  mutationMode = 'normal',
  rollbackMode = 'normal',
  readFailures = [],
} = {}) {
  let reads = 0;
  let mutations = 0;
  let rollbacks = 0;
  const source = parent('1:1', 'Source');
  const grid = parent('2:1', 'Neutral Grid', true);
  const child = scene('3:1', 'Card');
  const sibling = scene('1:2', 'Sibling');
  const gridSibling = scene('2:2', 'Grid sibling');
  attach(sameParent ? grid : source, child);
  attach(source, sibling);
  attach(grid, gridSibling);
  gridSibling._row = sameParent ? 2 : 0; gridSibling._column = sameParent ? 2 : 0;
  if (sameParent) {
    child._row = 0; child._column = 0;
    child.gridRowSpan = 1; child.gridColumnSpan = 1;
  }

  function parent(id, name, isGrid = false) {
    return {
      id, name, type: 'FRAME', parent: null, children: [],
      layoutMode: isGrid ? 'GRID' : 'NONE',
      ...(isGrid ? {
        gridRowCount: 3, gridColumnCount: 3, gridRowGap: 8, gridColumnGap: 12,
        gridRowSizes: [{ type: 'FIXED', value: 100 }, { type: 'FLEX', value: 1 }, { type: 'HUG' }],
        gridColumnSizes: [{ type: 'FLEX', value: 1 }, { type: 'FLEX', value: 1 }, { type: 'FIXED', value: 80 }],
        gridAutoTracks: 'NONE', gridItemsPositioning: 'MANUAL',
        appendChildAt(node, row, column) {
          mutations += 1;
          attach(this, node);
          node._row = mutationMode === 'wrong-position' ? row + 1 : row;
          node._column = column;
          if (mutationMode === 'throw-after-apply') throw new Error('native acknowledgement failed');
        },
      } : {}),
      appendChild(node) { attach(this, node); },
      insertChild(index, node) {
        const isRollback = node === child && node.parent !== this;
        if (isRollback) rollbacks += 1;
        if (isRollback && rollbackMode === 'no-effect') return;
        attach(this, node, index);
      },
    };
  }
  function scene(id, name) {
    return {
      id, name, type: 'RECTANGLE', parent: null, x: 10, y: 20,
      layoutPositioning: 'AUTO', _row: 0, _column: 0,
      gridRowSpan: 1, gridColumnSpan: 1,
      gridChildHorizontalAlign: 'AUTO', gridChildVerticalAlign: 'AUTO',
      get gridRowAnchorIndex() { return this._row; },
      get gridColumnAnchorIndex() { return this._column; },
      setGridChildPosition(row, column) { this._row = row; this._column = column; },
    };
  }
  function attach(target, node, index = target.children.length) {
    if (node.parent) node.parent.children.splice(node.parent.children.indexOf(node), 1);
    target.children.splice(index, 0, node); node.parent = target;
  }
  const nodes = new Map([[source.id, source], [grid.id, grid], [child.id, child]]);
  return {
    child, grid, source,
    get mutations() { return mutations; },
    get rollbacks() { return rollbacks; },
    figma: { async getNodeByIdAsync(id) {
      reads += 1;
      if (readFailures.includes(reads)) throw new Error('injected read failure');
      return nodes.get(id) || null;
    } },
  };
}

const evaluate = (figma) => async (code) => new Function('figma', `return ${code}`)(figma);
const request = (overrides = {}) => ({
  gridId: '2:1', childId: '3:1', row: 1, column: 2,
  rowSpan: 2, columnSpan: 1, horizontalAlign: 'center', verticalAlign: 'max',
  ...overrides,
});

test('Grid Place closes numeric, alignment, arity, and dual-URL targeting', () => {
  assert.deepEqual(parseGridPlaceRequest([
    'layout', 'grid', 'place', '--column=2', '2-1', '--row', '1', '3:1',
    '--row-span', '2', '--horizontal-align', 'center', '--vertical-align=max',
  ]), {
    gridId: '2:1', childId: '3:1', row: 1, column: 2,
    rowSpan: 2, columnSpan: null, horizontalAlign: 'CENTER', verticalAlign: 'MAX',
  });
  assert.deepEqual(gridPlaceArgvFromRequest(request()), [
    'layout', 'grid', 'place', '--row', '1', '--column', '2', '--row-span', '2',
    '--column-span', '1', '--horizontal-align', 'center', '--vertical-align', 'max',
    '--', '2:1', '3:1',
  ]);
  const gridUrl = 'https://www.figma.com/design/FILEA/Test?node-id=2-1';
  const childUrl = 'https://www.figma.com/design/FILEA/Test?node-id=3-1';
  assert.equal(gridPlaceFigmaUrlFileKeyFromArgv([
    'layout', 'grid', 'place', gridUrl, childUrl, '--row', '0', '--column', '0',
  ]), 'FILEA');
  assert.throws(() => gridPlacePlanningArgvFromRequest({
    ...request(), gridId: gridUrl,
    childId: 'https://www.figma.com/design/FILEB/Test?node-id=3-1',
  }), /multiple Figma files/);
  for (const args of [
    ['layout', 'grid', 'place', '2:1', '3:1', '--row', '0'],
    ['layout', 'grid', 'place', '2:1', '3:1', '--row', '-1', '--column', '0'],
    ['layout', 'grid', 'place', '2:1', '3:1', '--row', '0', '--column', '0', '--row-span', '0'],
    ['layout', 'grid', 'place', '2:1', '3:1', '--row', '0', '--column', '0', '--horizontal-align', 'stretch'],
    ['layout', 'grid', 'place', '2:1', '3:1', '--row', '0', '--column', '0', '--future'],
    ['layout', 'grid', 'place', '2:1', '3:1', '4:1', '--row', '0', '--column', '0'],
  ]) assert.equal(acceptsGridPlaceArgv(args), false, args.join(' '));
});

test('Grid Place mutates once and freshly proves hierarchy, cell, span, and alignment', async () => {
  const live = fixture();
  const result = await executeGridPlace(request(), { evaluate: evaluate(live.figma) });
  assert.equal(result.result.status, 'placed');
  assert.equal(result.result.outcome, 'verified');
  assert.equal(result.result.attempted, 1);
  assert.equal(live.mutations, 1);
  assert.equal(live.child.parent, live.grid);
  assert.deepEqual(result.result.child, {
    id: '3:1', name: 'Card', type: 'RECTANGLE', parentId: '2:1', index: 1,
    row: 1, column: 2, rowSpan: 2, columnSpan: 1,
    horizontalAlign: 'CENTER', verticalAlign: 'MAX',
  });
  assert.deepEqual(live.source.children.map(({ id }) => id), ['1:2']);
});

test('Grid Place avoids native dispatch for an exact same-grid no-op', async () => {
  const live = fixture({ sameParent: true });
  const result = await executeGridPlace(request({
    row: 0, column: 0, rowSpan: 1, horizontalAlign: 'auto', verticalAlign: 'auto',
  }), { evaluate: evaluate(live.figma) });
  assert.equal(result.result.status, 'unchanged');
  assert.equal(result.result.outcome, 'no-mutation');
  assert.equal(result.result.attempted, 0);
  assert.equal(live.mutations, 0);
});

test('Grid Place accepts a thrown acknowledgement only after exact fresh readback', async () => {
  const live = fixture({ mutationMode: 'throw-after-apply' });
  const result = await executeGridPlace(request(), { evaluate: evaluate(live.figma) });
  assert.equal(result.result.outcome, 'verified-after-error');
  assert.equal(result.result.warnings.length, 1);
  assert.equal(live.child.parent, live.grid);
});

test('Grid Place restores the complete prior parent state after a failed postcondition', async () => {
  const live = fixture({ mutationMode: 'wrong-position' });
  await assert.rejects(() => executeGridPlace(request(), { evaluate: evaluate(live.figma) }),
    (error) => error.mutationOutcome === 'rolled-back'
      && error.mutationReport.attempted === 1
      && error.mutationReport.restored === 1
      && error.mutationReport.residueCount === 0);
  assert.equal(live.child.parent, live.source);
  assert.deepEqual(live.source.children.map(({ id }) => id), ['3:1', '1:2']);
  assert.deepEqual([live.child.x, live.child.y, live.child.layoutPositioning], [10, 20, 'AUTO']);
  assert.equal(live.rollbacks, 1);
});

test('Grid Place keeps partial residue and unavailable verification distinct', async () => {
  const residue = fixture({ mutationMode: 'wrong-position', rollbackMode: 'no-effect' });
  await assert.rejects(() => executeGridPlace(request(), { evaluate: evaluate(residue.figma) }),
    (error) => error.mutationOutcome === 'partial-residue'
      && error.mutationReport.residueCount > 0);

  const unavailable = fixture({ mutationMode: 'wrong-position', readFailures: [7] });
  await assert.rejects(() => executeGridPlace(request(), { evaluate: evaluate(unavailable.figma) }),
    (error) => error.mutationOutcome === 'verification-unavailable');
});

test('Grid Place preflights bounds before mutation', async () => {
  for (const invalid of [
    request({ row: 3 }), request({ column: 3 }), request({ row: 2, rowSpan: 2 }),
    request({ gridId: '9:9' }), request({ childId: '9:9' }),
  ]) {
    const live = fixture();
    await assert.rejects(() => executeGridPlace(invalid, { evaluate: evaluate(live.figma) }),
      (error) => error.mutationOutcome === 'no-mutation');
    assert.equal(live.mutations, 0);
  }
});

test('Grid Place uses one authentic non-retrying Plan in both Adapters', async () => {
  const gridUrl = 'https://www.figma.com/design/FILEA/Test?node-id=2-1';
  const childUrl = 'https://www.figma.com/design/FILEA/Test?node-id=3-1';
  const mcp = planFigmaCommand(gridPlacePlanningArgvFromRequest({
    ...request(), gridId: gridUrl, childId: childUrl,
  }), { adapter: 'mcp' });
  const cli = planFigmaCommand(mcp.argv, { adapter: 'cli', fileKey: mcp.target.fileKey });
  assert.equal(mcp.allowed, true); assert.equal(cli.allowed, true);
  assert.equal(mcp.id, 'layout.grid.place'); assert.deepEqual(cli.effects, mcp.effects);
  assert.equal(mcp.execution.retry, 'never'); assert.equal(mcp.target.fileKey, 'FILEA');
  assert.equal(gridPlacePlanRoute(mcp), 'command-application');
  const live = fixture(); let evaluations = 0;
  await executeGridPlacePlan(mcp, {
    evaluate: async (code) => { evaluations += 1; return evaluate(live.figma)(code); },
  });
  assert.equal(evaluations, 1);
});

test('Grid Place rejects malformed or forged Plugin results after dispatch', async () => {
  for (const payload of [
    null, {}, 'not-json', JSON.stringify({ status: 'placed' }),
    JSON.stringify({
      schemaVersion: 1, status: 'placed', outcome: 'verified', attempted: 1,
      grid: { id: '2:1' }, child: { id: 'different' }, residue: [], warnings: [],
    }),
  ]) {
    await assert.rejects(() => executeGridPlace(request(), { evaluate: async () => payload }), /invalid/i);
  }
  assert.doesNotThrow(() => new Function('figma', `return ${gridPlaceCode(request())}`));
});
