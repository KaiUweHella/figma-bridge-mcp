import assert from 'node:assert/strict';
import test from 'node:test';

import { planFigmaCommand } from '../../src/capability-catalog.js';
import {
  executeGridSet,
  executeGridSetPlan,
  gridSetCode,
  gridSetPlanRoute,
} from '../src/application/grid-set-command.js';
import {
  acceptsGridSetArgv,
  gridSetArgvFromRequest,
  gridSetFigmaUrlFileKeyFromArgv,
  gridSetPlanningArgvFromRequest,
  parseGridSetRequest,
} from '../src/application/grid-set-request.js';

function fixture({ initialMode = 'GRID', behavior = 'normal', readFailures = [] } = {}) {
  let mode = initialMode; let rowGap = initialMode === 'GRID' ? 8 : 0; let columnGap = initialMode === 'GRID' ? 10 : 0;
  let rows = initialMode === 'GRID' ? [track('FIXED', 40), track('FLEX', 1)] : [];
  let columns = initialMode === 'GRID' ? [track('FIXED', 50), track('FLEX', 1)] : [];
  let reads = 0; const writes = [];
  const child = {
    id: '2:1', name: 'Child', type: 'RECTANGLE', x: 12, y: 16, layoutPositioning: 'AUTO',
    gridRowAnchorIndex: initialMode === 'GRID' ? 1 : 0, gridColumnAnchorIndex: 0,
    gridRowSpan: 1, gridColumnSpan: 1,
    gridChildHorizontalAlign: 'AUTO', gridChildVerticalAlign: 'CENTER',
    setGridChildPosition(row, column) { this.gridRowAnchorIndex = row; this.gridColumnAnchorIndex = column; },
  };
  const node = {
    id: '1:1', name: 'Neutral Grid', type: 'FRAME', children: [child],
    gridAutoTracks: 'NONE', gridItemsPositioning: 'MANUAL',
    get layoutMode() { return mode; },
    set layoutMode(value) {
      writes.push(['layoutMode', value]); mode = value;
      if (value === 'GRID') { if (!rows.length) rows = [track('FLEX', 1)]; if (!columns.length) columns = [track('FLEX', 1)]; }
      if (value !== 'GRID' && initialMode !== 'GRID') { rows = []; columns = []; rowGap = 0; columnGap = 0; }
    },
    get gridRowCount() { return rows.length; },
    set gridRowCount(value) {
      writes.push(['rows', value]);
      if (behavior === 'rollback-row-count-fails' && value === 2 && rows.length !== 2) return;
      while (rows.length < value) rows.push(track('FLEX', 1)); rows.length = value;
    },
    get gridColumnCount() { return columns.length; },
    set gridColumnCount(value) { writes.push(['columns', value]); while (columns.length < value) columns.push(track('FLEX', 1)); columns.length = value; },
    get gridRowGap() { return rowGap; },
    set gridRowGap(value) { writes.push(['rowGap', value]); if (['wrong-gap','rollback-row-count-fails'].includes(behavior) && value === 24) return; rowGap = value; },
    get gridColumnGap() { return columnGap; },
    set gridColumnGap(value) { writes.push(['columnGap', value]); columnGap = value; if (behavior === 'throw-after-apply' && value === 20) throw new Error('native setter reported failure'); },
    get gridRowSizes() { return rows; },
    get gridColumnSizes() { return columns; },
  };
  child.parent = node;
  function track(initialType, initialValue) {
    let type = initialType; let value = initialValue;
    return {
      get type() { return type; },
      set type(next) { type = next; if (next === 'HUG') value = undefined; },
      get value() { return value; },
      set value(next) { value = next; },
    };
  }
  return {
    node, child, writes,
    get reads() { return reads; },
    figma: { async getNodeByIdAsync(id) { reads += 1; if (readFailures.includes(reads)) throw new Error('injected read failure'); return id === node.id ? node : null; } },
  };
}

const evaluate = (figma) => async (code) => new Function('figma', `return ${code}`)(figma);

test('Grid Set closes all values, JSON tracks, URL targeting, and canonical argv', () => {
  const url = 'https://www.figma.com/design/FILEA/Test?node-id=1-1';
  assert.deepEqual(parseGridSetRequest([
    'layout', 'grid', 'set', '--row-gap=12', url, '--rows', '2',
    '--row-sizes', '[{"type":"fixed","value":40},{"type":"hug"}]',
  ]), {
    nodeId: '1:1', rows: 2, rowGap: 12,
    rowSizes: [{ type: 'FIXED', value: 40 }, { type: 'HUG' }],
  });
  assert.equal(gridSetFigmaUrlFileKeyFromArgv([
    'layout', 'grid', 'set', url, '--columns', '2',
  ]), 'FILEA');
  assert.deepEqual(gridSetArgvFromRequest({
    nodeId: '1-1', columns: 2, columnGap: 6,
    columnSizes: [{ type: 'fixed', value: 50 }, { type: 'flex', value: 1 }],
  }), [
    'layout', 'grid', 'set', '--columns', '2', '--column-gap', '6',
    '--column-sizes', '[{"type":"FIXED","value":50},{"type":"FLEX","value":1}]', '--', '1:1',
  ]);
  for (const args of [
    ['layout', 'grid', 'set', '1:1'],
    ['layout', 'grid', 'set', '1:1', '--rows', '0'],
    ['layout', 'grid', 'set', '1:1', '--row-gap', '-1'],
    ['layout', 'grid', 'set', '1:1', '--rows', '2', '--row-sizes', '[{"type":"FLEX"}]'],
    ['layout', 'grid', 'set', '1:1', '--row-sizes', '[{"type":"AUTO"}]'],
    ['layout', 'grid', 'set', '1:1', '--columns', '2', '--future'],
    ['layout', 'grid', 'set', '1:1', '2:1', '--columns', '2'],
  ]) assert.equal(acceptsGridSetArgv(args), false, args.join(' '));
});

test('Grid Set applies coupled dimensions, gaps, and exact track intent with fresh proof', async () => {
  const live = fixture();
  const result = await executeGridSet({
    nodeId: '1:1', rows: 3, rowGap: 12,
    rowSizes: [{ type: 'fixed', value: 48 }, { type: 'hug' }, { type: 'flex', value: 2 }],
  }, { evaluate: evaluate(live.figma) });
  assert.equal(result.result.status, 'applied'); assert.equal(result.result.outcome, 'verified');
  assert.equal(result.result.after.rows, 3); assert.equal(result.result.after.rowGap, 12);
  assert.deepEqual(result.result.after.rowSizes, [
    { type: 'FIXED', value: 48 }, { type: 'HUG' }, { type: 'FLEX', value: 2 },
  ]);
  assert.equal(live.child.gridRowAnchorIndex, 1);
  assert.equal(live.reads, 2);
});

test('Grid Set preserves the established conversion from a non-Grid layout', async () => {
  const live = fixture({ initialMode: 'NONE' });
  const result = await executeGridSet({
    nodeId: '1:1', rows: 2, columns: 2, rowGap: 6,
  }, { evaluate: evaluate(live.figma) });
  assert.equal(result.result.before.layoutMode, 'NONE');
  assert.equal(result.result.after.layoutMode, 'GRID');
  assert.equal(result.result.after.rows, 2); assert.equal(result.result.after.columns, 2);
  assert.equal(live.child.parent, live.node);
});

test('Grid Set skips an exact effective no-op', async () => {
  const live = fixture();
  const result = await executeGridSet({ nodeId: '1:1', rows: 2, rowGap: 8 }, { evaluate: evaluate(live.figma) });
  assert.equal(result.result.status, 'unchanged'); assert.equal(result.result.attempted, 0);
  assert.deepEqual(live.writes, []); assert.equal(live.reads, 1);
});

test('Grid Set accepts a thrown acknowledgement only after complete fresh proof', async () => {
  const live = fixture({ behavior: 'throw-after-apply' });
  const result = await executeGridSet({ nodeId: '1:1', columnGap: 20 }, { evaluate: evaluate(live.figma) });
  assert.equal(result.result.outcome, 'verified-after-error');
  assert.equal(result.result.warnings.length, 1);
});

test('Grid Set restores its complete journal or reports exact remaining residue', async () => {
  for (const [behavior, outcome, residue] of [
    ['wrong-gap', 'rolled-back', 0],
    ['rollback-row-count-fails', 'partial-residue', 1],
  ]) {
    const live = fixture({ behavior });
    await assert.rejects(() => executeGridSet({
      nodeId: '1:1', rows: 3, rowGap: 24,
    }, { evaluate: evaluate(live.figma) }), (error) => error.mutationOutcome === outcome
      && error.mutationReport.attempted === 1 && error.mutationReport.residueCount === residue);
    assert.equal(live.node.gridRowGap, 8);
    assert.equal(live.node.gridRowCount, outcome === 'rolled-back' ? 2 : 3);
  }
});

test('Grid Set refuses an occupied manual shrink before dispatch', async () => {
  const live = fixture();
  await assert.rejects(() => executeGridSet({ nodeId: '1:1', rows: 1 }, {
    evaluate: evaluate(live.figma),
  }), (error) => error.mutationOutcome === 'no-mutation' && error.mutationReport.attempted === 0);
  assert.deepEqual(live.writes, []); assert.equal(live.reads, 1);
});

test('Grid Set uses one authentic non-retrying Plan in CLI and MCP', async () => {
  const url = 'https://www.figma.com/design/FILEA/Test?node-id=1-1';
  const mcp = planFigmaCommand(gridSetPlanningArgvFromRequest({
    nodeId: url, rows: 3, rowGap: 12,
  }), { adapter: 'mcp' });
  const cli = planFigmaCommand(mcp.argv, { adapter: 'cli', fileKey: mcp.target.fileKey });
  assert.equal(mcp.allowed, true); assert.equal(cli.allowed, true);
  assert.equal(mcp.id, 'layout.grid.set'); assert.deepEqual(cli.effects, mcp.effects);
  assert.equal(mcp.execution.retry, 'never'); assert.equal(mcp.target.fileKey, 'FILEA');
  assert.equal(gridSetPlanRoute(mcp), 'command-application');
  const live = fixture(); let evaluations = 0;
  await executeGridSetPlan(mcp, { evaluate: async (code) => { evaluations += 1; return evaluate(live.figma)(code); } });
  assert.equal(evaluations, 1);
});

test('Grid Set rejects malformed and forged Plugin results', async () => {
  for (const payload of [null, {}, 'not-json', JSON.stringify({ status: 'applied' }), JSON.stringify({
    schemaVersion: 1, status: 'applied', action: 'set', outcome: 'verified', attempted: 1,
    node: { id: '1:1', name: 'Neutral Grid', type: 'FRAME' }, before: {}, after: {}, residueCount: 0, warnings: [],
  })]) await assert.rejects(() => executeGridSet({ nodeId: '1:1', rows: 3 }, { evaluate: async () => payload }), /invalid/i);
  assert.doesNotThrow(() => new Function('figma', `return ${gridSetCode({ nodeId: '1:1', rows: 3 })}`));
});
