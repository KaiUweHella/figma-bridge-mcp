import assert from 'node:assert/strict';
import test from 'node:test';
import { planFigmaCommand } from '../../src/capability-catalog.js';
import {
  executeLayoutGuideMutation,
  executeLayoutGuideMutationPlan,
  layoutGuideMutationCode,
  layoutGuideMutationPlanRoute,
  layoutGuideMutationPlanningArgvFromRequest,
  MAX_LAYOUT_GUIDE_MUTATION_GRIDS,
} from '../src/application/layout-guide-mutation-command.js';
import {
  acceptsLayoutGuideMutationArgv,
  layoutGuideMutationArgvFromRequest,
  layoutGuideMutationFigmaUrlFileKeyFromArgv,
  parseLayoutGuideMutationRequest,
} from '../src/application/layout-guide-mutation-request.js';

const STYLE_GRIDS = Object.freeze([
  Object.freeze({
    pattern: 'COLUMNS', alignment: 'STRETCH', gutterSize: 24, count: Infinity,
    offset: 32, visible: true, color: Object.freeze({ r: 1, g: 0, b: 0.5, a: 0.08 }),
    boundVariables: Object.freeze({
      gutterSize: Object.freeze({ type: 'VARIABLE_ALIAS', id: 'VariableID:1:2' }),
    }),
  }),
]);

const clone = (value) => structuredClone(value);

function runtime({
  initialGrids = STYLE_GRIDS,
  initialStyleId = 'S:1',
  primaryMode = 'normal',
  rollbackMode = 'normal',
  readFailures = [],
} = {}) {
  const styleGrids = clone(initialGrids);
  let grids = clone(initialGrids);
  let gridStyleId = initialStyleId;
  let reads = 0;
  let writes = 0;
  const apply = (value, mode) => {
    if (mode === 'no-effect') return;
    gridStyleId = '';
    grids = mode === 'partial' && value.length > 0 ? clone(value.slice(0, 1)) : clone(value);
    if (mode === 'throw-after') throw new Error('injected native acknowledgement');
  };
  const node = {
    id: '10:3', name: 'Grid frame', type: 'FRAME',
    get gridStyleId() { return gridStyleId; },
    get layoutGrids() { return clone(grids); },
    set layoutGrids(value) {
      writes += 1;
      apply(value, writes === 1 ? primaryMode : rollbackMode);
    },
    async setGridStyleIdAsync(value) {
      writes += 1;
      if (rollbackMode === 'no-effect') return;
      gridStyleId = value;
      grids = value === initialStyleId ? clone(styleGrids) : [];
    },
  };
  return {
    node,
    writes: () => writes,
    snapshot: () => ({ gridStyleId, layoutGrids: clone(grids) }),
    figma: {
      async getNodeByIdAsync(id) {
        reads += 1;
        if (readFailures.includes(reads)) throw new Error('injected readback failure');
        return id === node.id ? node : null;
      },
    },
  };
}

const evaluate = (figma) => async (code) => new Function('figma', `return ${code};`)(figma);

test('Layout Guide mutation closes set and clear grammar with canonical URL identity', () => {
  assert.deepEqual(parseLayoutGuideMutationRequest([
    'grid', 'set', '-c12', '--rows=8', '-g=16', '-m0', '-a', 'center',
    '--color', 'ff008b', '--opacity=.2', '--append', '10-3',
  ]), {
    action: 'set', nodeId: '10:3', columns: 12, rows: 8, gutter: 16, margin: 0,
    alignment: 'CENTER', color: '#FF008B', opacity: 0.2, append: true, warning: '',
  });
  assert.deepEqual(parseLayoutGuideMutationRequest(['grid', 'clear', '--', '10-3']), {
    action: 'clear', nodeId: '10:3', columns: null, rows: null, gutter: null,
    margin: null, alignment: null, color: null, opacity: null, append: false, warning: '',
  });
  assert.deepEqual(layoutGuideMutationArgvFromRequest({
    action: 'set', nodeId: '10-3', columns: 12, rows: null,
  }), ['grid', 'set', '10:3', '--columns=12']);

  const url = 'https://www.figma.com/design/FILEA/Grid-Lab?node-id=10-3';
  const planning = layoutGuideMutationPlanningArgvFromRequest({
    action: 'set', nodeId: url, columns: 12, rows: null,
  });
  assert.equal(layoutGuideMutationFigmaUrlFileKeyFromArgv(planning), 'FILEA');
  assert.equal(planFigmaCommand(planning, { adapter: 'mcp' }).target.fileKey, 'FILEA');

  for (const argv of [
    ['grid', 'set', '10:3'],
    ['grid', 'set', '10:3', '--columns=0'],
    ['grid', 'set', '10:3', '--rows=1.5'],
    ['grid', 'set', '10:3', '--gutter=-1', '--columns=1'],
    ['grid', 'set', '10:3', '--opacity=1.1', '--columns=1'],
    ['grid', 'set', '10:3', '--color=12345', '--columns=1'],
    ['grid', 'set', '10:3', '--alignment=private', '--columns=1'],
    ['grid', 'set', '10:3', '--columns=1', '--columns=2'],
    ['grid', 'set', '10:3', '--columns=1', '10:4'],
    ['grid', 'clear', '10:3', '--append'],
    ['grid', 'clear', '10:3', '--future'],
  ]) assert.equal(acceptsLayoutGuideMutationArgv(argv), false, argv.join(' '));
});

test('set replaces guides, detaches a linked style, and verifies the complete exact state', async () => {
  const live = runtime();
  const result = await executeLayoutGuideMutation({
    action: 'set', nodeId: '10:3', columns: 12, rows: 8,
    gutter: 20, margin: 32, alignment: 'CENTER', color: '#336699', opacity: 0.2,
  }, { evaluate: evaluate(live.figma) });
  assert.equal(live.writes(), 1);
  assert.equal(result.result.outcome, 'verified');
  assert.equal(result.result.actual.gridStyleId, '');
  assert.deepEqual(result.result.actual.layoutGrids.map((grid) => grid.pattern), ['COLUMNS', 'ROWS']);
  assert.deepEqual(result.result.actual.layoutGrids[0], {
    pattern: 'COLUMNS', alignment: 'CENTER', gutterSize: 20, count: 12, offset: 32,
    visible: true, color: { r: 0.2, g: 0.4, b: 0.6, a: 0.2 },
  });
  assert.equal(result.stdout, '✓ Set grid on Grid frame (10:3)\n  Total grids: 2');
});

test('append preserves exact existing guides including Auto and Variable bindings', async () => {
  const live = runtime({ initialStyleId: '' });
  const result = await executeLayoutGuideMutation({
    action: 'set', nodeId: '10:3', columns: 6, rows: null, append: true,
  }, { evaluate: evaluate(live.figma) });
  assert.equal(result.result.actual.layoutGrids.length, 2);
  assert.deepEqual(result.result.actual.layoutGrids[0], {
    ...STYLE_GRIDS[0], count: { $figmaScalar: 'Infinity' },
  });
  assert.deepEqual(result.result.actual.layoutGrids[0].boundVariables,
    STYLE_GRIDS[0].boundVariables);
  assert.equal(result.result.actual.layoutGrids[1].count, 6);
});

test('clear and already-clear no-op report the requested action accurately', async () => {
  const live = runtime();
  const cleared = await executeLayoutGuideMutation({ action: 'clear', nodeId: '10:3' }, {
    evaluate: evaluate(live.figma),
  });
  assert.equal(cleared.result.status, 'cleared');
  assert.equal(cleared.stdout, '✓ Cleared grids on Grid frame (10:3)\n  Total grids: 0');

  const empty = runtime({ initialGrids: [], initialStyleId: '' });
  const unchanged = await executeLayoutGuideMutation({ action: 'clear', nodeId: '10:3' }, {
    evaluate: evaluate(empty.figma),
  });
  assert.equal(unchanged.result.status, 'unchanged');
  assert.equal(unchanged.result.outcome, 'no-mutation');
  assert.equal(empty.writes(), 0);
  assert.equal(unchanged.stdout, '✓ Cleared grids on Grid frame (10:3)\n  Total grids: 0');
});

test('a thrown native acknowledgement succeeds only after exact fresh readback', async () => {
  const live = runtime({ primaryMode: 'throw-after' });
  const result = await executeLayoutGuideMutation({
    action: 'set', nodeId: '10:3', columns: 12, rows: null,
  }, { evaluate: evaluate(live.figma) });
  assert.equal(result.result.outcome, 'verified-after-error');
  assert.equal(result.result.warnings.length, 1);
  assert.match(result.stderr, /injected native acknowledgement/);
});

test('unchanged writes, style-safe rollback, residue, and unavailable verification stay distinct', async () => {
  const request = { action: 'set', nodeId: '10:3', columns: 12, rows: 8 };
  const unchanged = runtime({ primaryMode: 'no-effect' });
  await assert.rejects(() => executeLayoutGuideMutation(request, {
    evaluate: evaluate(unchanged.figma),
  }), (error) => error.mutationOutcome === 'unchanged'
    && error.mutationReport.residueCount === 1);
  assert.equal(unchanged.writes(), 1);

  const rolledBack = runtime({ primaryMode: 'partial' });
  await assert.rejects(() => executeLayoutGuideMutation(request, {
    evaluate: evaluate(rolledBack.figma),
  }), (error) => error.mutationOutcome === 'rolled-back'
    && error.mutationReport.restored === 1);
  assert.deepEqual(rolledBack.snapshot(), {
    gridStyleId: 'S:1', layoutGrids: STYLE_GRIDS,
  });
  assert.equal(rolledBack.writes(), 2);

  const residue = runtime({ primaryMode: 'partial', rollbackMode: 'no-effect' });
  await assert.rejects(() => executeLayoutGuideMutation(request, {
    evaluate: evaluate(residue.figma),
  }), (error) => error.mutationOutcome === 'partial-residue'
    && error.mutationReport.residueCount > 0);
  assert.equal(residue.snapshot().gridStyleId, '');

  const unavailable = runtime({ primaryMode: 'partial', readFailures: [5] });
  await assert.rejects(() => executeLayoutGuideMutation(request, {
    evaluate: evaluate(unavailable.figma),
  }), (error) => error.mutationOutcome === 'verification-unavailable'
    && error.mutationReport.residueCount === 1);
});

test('invalid or excessive native grid facts refuse before mutation', async () => {
  for (const live of [
    runtime({ initialGrids: [{ pattern: 'GRID', sectionSize: NaN }] }),
    runtime({ initialGrids: Array(MAX_LAYOUT_GUIDE_MUTATION_GRIDS + 1)
      .fill({ pattern: 'GRID', sectionSize: 8 }) }),
  ]) {
    await assert.rejects(() => executeLayoutGuideMutation({
      action: 'clear', nodeId: '10:3',
    }, { evaluate: evaluate(live.figma) }), (error) => error.mutationOutcome === 'no-mutation');
    assert.equal(live.writes(), 0);
  }
});

test('CLI and MCP share one non-retrying write Plan and Application route', async () => {
  for (const [cliArgv, mcpArgv, action] of [
    [
      ['grid', 'set', '10-3', '--columns=12', '--gutter=20'],
      ['grid', 'set', '--gutter', '20', '-c', '12', '--', '10:3'],
      'grid.set',
    ],
    [['grid', 'clear', '10-3'], ['grid', 'clear', '--', '10:3'], 'grid.clear'],
  ]) {
    const cli = planFigmaCommand(cliArgv, { adapter: 'cli' });
    const mcp = planFigmaCommand(mcpArgv, { adapter: 'mcp' });
    assert.equal(cli.allowed, true);
    assert.equal(mcp.allowed, true);
    assert.deepEqual(cli.argv, mcp.argv);
    assert.deepEqual(cli.effects, mcp.effects);
    assert.deepEqual(cli.execution, mcp.execution);
    assert.equal(cli.effects.figma, 'write');
    assert.equal(cli.execution.retry, 'never');
    assert.equal(cli.audit.capability, action);
    assert.equal(layoutGuideMutationPlanRoute(cli), 'command-application');
  }
  assert.throws(() => layoutGuideMutationPlanRoute({
    ...planFigmaCommand(['grid', 'clear', '10:3'], { adapter: 'mcp' }),
  }), /requires a Command Plan/);
  const live = runtime();
  const plan = planFigmaCommand(['grid', 'clear', '10:3'], { adapter: 'mcp' });
  assert.equal((await executeLayoutGuideMutationPlan(plan, {
    evaluate: evaluate(live.figma),
  })).result.status, 'cleared');
  assert.equal(layoutGuideMutationPlanRoute(
    planFigmaCommand(['grid', 'list', '10:3'], { adapter: 'mcp' }),
  ), 'not-layout-guide-mutation');
});

test('forged Plugin results cannot claim successful guide mutations', async () => {
  const request = { action: 'set', nodeId: '10:3', columns: 12, rows: null };
  const live = runtime();
  const serialized = await evaluate(live.figma)(layoutGuideMutationCode(request));
  const payload = JSON.parse(serialized);
  for (const forged of [
    { ...payload, actual: { ...payload.actual, gridStyleId: 'S:forged' } },
    { ...payload, actual: { ...payload.actual, layoutGrids: [] } },
    { ...payload, request: { ...payload.request, columns: 24 } },
    { ...payload, outcome: 'verified-after-error', warnings: [] },
    { ...payload, futureField: 'private' },
  ]) {
    await assert.rejects(() => executeLayoutGuideMutation(request, {
      evaluate: async () => JSON.stringify(forged),
    }), /invalid bounded result/);
  }
  for (const malformed of [null, '{', JSON.stringify({ status: 'set' })]) {
    await assert.rejects(() => executeLayoutGuideMutation(request, {
      evaluate: async () => malformed,
    }), /invalid/i);
  }
});

test('Layout Guide mutation generated Plugin code parses', () => {
  assert.doesNotThrow(() => new Function(
    `return ${layoutGuideMutationCode({
      action: 'set', nodeId: '10:3', columns: 12, rows: null,
    })}`));
});
