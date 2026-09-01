import assert from 'node:assert/strict';
import test from 'node:test';

import { planFigmaCommand } from '../../src/capability-catalog.js';
import {
  executeGridTrackReorder,
  executeGridTrackReorderPlan,
  gridTrackReorderCode,
  gridTrackReorderPlanRoute,
} from '../src/application/grid-track-reorder-command.js';
import {
  acceptsGridTrackReorderArgv,
  gridTrackReorderArgvFromRequest,
  gridTrackReorderFigmaUrlFileKeyFromArgv,
  gridTrackReorderPlanningArgvFromRequest,
  parseGridTrackReorderRequest,
} from '../src/application/grid-track-reorder-request.js';

function fixture({ mode = 'normal', readFailures = [] } = {}) {
  let reads = 0; let calls = 0;
  const childA = child('2:1', 0, 1, 0, 1);
  const childB = child('2:2', 1, 2, 1, 2);
  const grid = {
    id: '1:1', name: 'Neutral Grid', type: 'FRAME', layoutMode: 'GRID',
    gridRowCount: 3, gridColumnCount: 3, gridRowGap: 8, gridColumnGap: 12,
    gridRowSizes: [track('FIXED', 40), track('FIXED', 80), track('FLEX', 1)],
    gridColumnSizes: [track('FIXED', 50), track('FLEX', 1), track('FIXED', 90)],
    gridAutoTracks: 'NONE', gridItemsPositioning: 'MANUAL', children: [childA, childB],
    reorderRows(options) { return reorder('rows', options); },
    reorderColumns(options) { return reorder('columns', options); },
  };
  childA.parent = grid; childB.parent = grid;
  function track(type, value) { return { type, value }; }
  function child(id, row, rowSpan, column, columnSpan) {
    return {
      id, name: id === '2:1' ? 'A' : 'B', type: 'RECTANGLE', parent: null,
      gridRowAnchorIndex: row, gridRowSpan: rowSpan,
      gridColumnAnchorIndex: column, gridColumnSpan: columnSpan,
      gridChildHorizontalAlign: 'AUTO', gridChildVerticalAlign: 'CENTER',
    };
  }
  function reorder(axis, { fromIndices, insertionIndex }) {
    calls += 1;
    if (mode === 'throw-unchanged') throw new Error('native reorder rejected');
    const count = axis === 'rows' ? grid.gridRowCount : grid.gridColumnCount;
    const selectedSet = new Set(fromIndices); let expanded = true;
    while (expanded) {
      expanded = false;
      for (const item of grid.children) {
        const anchor = axis === 'rows' ? item.gridRowAnchorIndex : item.gridColumnAnchorIndex;
        const span = axis === 'rows' ? item.gridRowSpan : item.gridColumnSpan;
        const occupied = Array.from({ length: span }, (_, offset) => anchor + offset);
        if (occupied.some((index) => selectedSet.has(index))) {
          for (const index of occupied) if (!selectedSet.has(index)) { selectedSet.add(index); expanded = true; }
        }
      }
    }
    const selected = [...selectedSet].sort((a, b) => a - b);
    const remaining = Array.from({ length: count }, (_, index) => index)
      .filter((index) => !selected.includes(index));
    const adjusted = insertionIndex - selected.filter((index) => index < insertionIndex).length;
    const order = [...remaining]; order.splice(adjusted, 0, ...selected);
    if (mode === 'wrong-permutation') order.splice(0, order.length, 0, 2, 1);
    const mapping = new Map(order.map((from, to) => [from, to]));
    const field = axis === 'rows' ? 'gridRowSizes' : 'gridColumnSizes';
    grid[field] = order.map((from) => grid[field][from]);
    for (const item of grid.children) {
      const anchorField = axis === 'rows' ? 'gridRowAnchorIndex' : 'gridColumnAnchorIndex';
      const spanField = axis === 'rows' ? 'gridRowSpan' : 'gridColumnSpan';
      const occupied = Array.from({ length: item[spanField] }, (_, offset) => mapping.get(item[anchorField] + offset)).sort((a, b) => a - b);
      item[anchorField] = occupied[0];
    }
    if (mode === 'wrong-track') grid[field][0] = track('HUG', undefined);
    return order.map((from, to) => ({ from, to })).filter(({ from, to }) => from !== to);
  }
  return {
    grid, childA, childB,
    get calls() { return calls; },
    figma: { async getNodeByIdAsync(id) {
      reads += 1;
      if (readFailures.includes(reads)) throw new Error('injected read failure');
      return id === grid.id ? grid : null;
    } },
  };
}

const evaluate = (figma) => async (code) => new Function('figma', `return ${code}`)(figma);

test('Grid Track Reorder closes axis, indices, target, and canonical argv', () => {
  assert.deepEqual(parseGridTrackReorderRequest([
    'layout', 'grid', 'reorder-rows', '--to=3', '1-1', '--from', '0,2',
  ]), { axis: 'rows', nodeId: '1:1', fromIndices: [0, 2], insertionIndex: 3 });
  assert.deepEqual(gridTrackReorderArgvFromRequest({
    axis: 'columns', nodeId: '1:1', from: [2, 0], insertionIndex: 1,
  }), ['layout', 'grid', 'reorder-columns', '--from', '2,0', '--to', '1', '--', '1:1']);
  const url = 'https://www.figma.com/design/FILEA/Test?node-id=1-1';
  assert.equal(gridTrackReorderFigmaUrlFileKeyFromArgv([
    'layout', 'grid', 'reorder-columns', url, '--from', '0', '--to', '2',
  ]), 'FILEA');
  for (const args of [
    ['layout', 'grid', 'reorder-rows', '1:1', '--from', '0'],
    ['layout', 'grid', 'reorder-rows', '1:1', '--from', '-1', '--to', '1'],
    ['layout', 'grid', 'reorder-rows', '1:1', '--from', '0,', '--to', '1'],
    ['layout', 'grid', 'reorder-columns', '1:1', '--from', '0', '--to', '-1'],
    ['layout', 'grid', 'reorder-columns', '1:1', '--from', '0', '--to', '1', '--future'],
    ['layout', 'grid', 'reorder-columns', '1:1', '2:1', '--from', '0', '--to', '1'],
  ]) assert.equal(acceptsGridTrackReorderArgv(args), false, args.join(' '));
});

test('row reorder freshly proves the complete permutation, tracks, and spanning children', async () => {
  const live = fixture();
  const result = await executeGridTrackReorder({
    axis: 'rows', nodeId: '1:1', from: '0', insertionIndex: 3,
  }, { evaluate: evaluate(live.figma) });
  assert.equal(result.result.status, 'reordered');
  assert.equal(result.result.outcome, 'verified');
  assert.deepEqual(result.result.moves, [{ from: 0, to: 2 }, { from: 1, to: 0 }, { from: 2, to: 1 }]);
  assert.deepEqual(live.grid.gridRowSizes.map(({ value }) => value), [80, 1, 40]);
  assert.equal(live.childA.gridRowAnchorIndex, 2);
  assert.equal(live.childB.gridRowAnchorIndex, 0);
  assert.equal(live.childB.gridRowSpan, 2);
});

test('column reorder uses the same verified Application semantics', async () => {
  const live = fixture();
  const result = await executeGridTrackReorder({
    axis: 'columns', nodeId: '1:1', from: [0], insertionIndex: 3,
  }, { evaluate: evaluate(live.figma) });
  assert.equal(result.result.action, 'reorder-columns');
  assert.deepEqual(live.grid.gridColumnSizes.map(({ value }) => value), [1, 90, 50]);
  assert.equal(live.childA.gridColumnAnchorIndex, 2);
  assert.equal(live.childB.gridColumnAnchorIndex, 0);
});

test('spanning children expand the requested native track move transitively', async () => {
  const live = fixture();
  const result = await executeGridTrackReorder({
    axis: 'rows', nodeId: '1:1', from: [1], insertionIndex: 0,
  }, { evaluate: evaluate(live.figma) });
  assert.deepEqual(result.result.moves, [
    { from: 0, to: 2 }, { from: 1, to: 0 }, { from: 2, to: 1 },
  ]);
  assert.equal(live.childA.gridRowAnchorIndex, 2);
  assert.equal(live.childB.gridRowAnchorIndex, 0);
});

test('an exact native no-op remains successful but records the one native attempt', async () => {
  const live = fixture();
  const result = await executeGridTrackReorder({
    axis: 'rows', nodeId: '1:1', from: [1], insertionIndex: 1,
  }, { evaluate: evaluate(live.figma) });
  assert.equal(result.result.status, 'unchanged');
  assert.equal(result.result.outcome, 'no-mutation');
  assert.equal(result.result.attempted, 1);
  assert.equal(live.calls, 1);
});

test('a thrown native reorder becomes no-mutation only after exact fresh proof', async () => {
  const live = fixture({ mode: 'throw-unchanged' });
  await assert.rejects(() => executeGridTrackReorder({
    axis: 'rows', nodeId: '1:1', from: [0], insertionIndex: 3,
  }, { evaluate: evaluate(live.figma) }), (error) => error.mutationOutcome === 'no-mutation'
    && error.mutationReport.attempted === 0 && error.mutationReport.residueCount === 0);
  assert.equal(live.calls, 1);
});

test('a mismatched irreversible reorder reports bounded residue and never retries', async () => {
  for (const mode of ['wrong-track', 'wrong-permutation']) {
    const live = fixture({ mode });
    await assert.rejects(() => executeGridTrackReorder({
      axis: 'rows', nodeId: '1:1', from: [0], insertionIndex: 3,
    }, { evaluate: evaluate(live.figma) }), (error) => error.mutationOutcome === 'partial-residue'
      && error.mutationReport.attempted === 1 && error.mutationReport.restored === 0
      && error.mutationReport.residueCount > 0);
    assert.equal(live.calls, 1);
  }
});

test('unavailable post-dispatch verification remains distinct', async () => {
  const live = fixture({ readFailures: [2] });
  await assert.rejects(() => executeGridTrackReorder({
    axis: 'columns', nodeId: '1:1', from: [0], insertionIndex: 3,
  }, { evaluate: evaluate(live.figma) }),
  (error) => error.mutationOutcome === 'verification-unavailable');
  assert.equal(live.calls, 1);
});

test('invalid bounds refuse before native dispatch', async () => {
  for (const request of [
    { axis: 'rows', nodeId: '1:1', from: [3], insertionIndex: 1 },
    { axis: 'columns', nodeId: '1:1', from: [0], insertionIndex: 4 },
    { axis: 'rows', nodeId: '9:9', from: [0], insertionIndex: 1 },
  ]) {
    const live = fixture();
    await assert.rejects(() => executeGridTrackReorder(request, { evaluate: evaluate(live.figma) }),
      (error) => error.mutationOutcome === 'no-mutation');
    assert.equal(live.calls, 0);
  }
});

test('rows and columns use authentic non-retrying Plans in both Adapters', async () => {
  const url = 'https://www.figma.com/design/FILEA/Test?node-id=1-1';
  for (const axis of ['rows', 'columns']) {
    const mcp = planFigmaCommand(gridTrackReorderPlanningArgvFromRequest({
      axis, nodeId: url, from: [0], insertionIndex: 3,
    }), { adapter: 'mcp' });
    const cli = planFigmaCommand(mcp.argv, { adapter: 'cli', fileKey: mcp.target.fileKey });
    assert.equal(mcp.allowed, true); assert.equal(cli.allowed, true);
    assert.equal(mcp.id, `layout.grid.reorder-${axis}`); assert.deepEqual(cli.effects, mcp.effects);
    assert.equal(mcp.execution.retry, 'never'); assert.equal(mcp.target.fileKey, 'FILEA');
    assert.equal(gridTrackReorderPlanRoute(mcp), 'command-application');
    const live = fixture(); let evaluations = 0;
    await executeGridTrackReorderPlan(mcp, {
      evaluate: async (code) => { evaluations += 1; return evaluate(live.figma)(code); },
    });
    assert.equal(evaluations, 1);
  }
});

test('forged moves and malformed Plugin results cannot become success', async () => {
  for (const payload of [
    null, {}, 'not-json', JSON.stringify({ status: 'reordered' }),
    JSON.stringify({
      schemaVersion: 1, status: 'reordered', action: 'reorder-rows', outcome: 'verified',
      attempted: 1, grid: { id: '1:1' }, moves: [{ from: 0, to: 0 }], residueCount: 0,
    }),
  ]) await assert.rejects(() => executeGridTrackReorder({
    axis: 'rows', nodeId: '1:1', from: [0], insertionIndex: 3,
  }, { evaluate: async () => payload }), /invalid/i);
  const live = fixture();
  const valid = JSON.parse(await evaluate(live.figma)(gridTrackReorderCode({
    axis: 'rows', nodeId: '1:1', from: [0], insertionIndex: 3,
  })));
  valid.moves = [{ from: 0, to: 2 }];
  await assert.rejects(() => executeGridTrackReorder({
    axis: 'rows', nodeId: '1:1', from: [0], insertionIndex: 3,
  }, { evaluate: async () => JSON.stringify(valid) }), /invalid/i);
  assert.doesNotThrow(() => new Function('figma', `return ${gridTrackReorderCode({
    axis: 'rows', nodeId: '1:1', from: [0], insertionIndex: 3,
  })}`));
});
