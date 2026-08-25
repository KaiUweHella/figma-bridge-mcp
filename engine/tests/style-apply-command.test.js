import assert from 'node:assert/strict';
import test from 'node:test';
import { planFigmaCommand } from '../../src/capability-catalog.js';
import {
  executeStyleApply,
  executeStyleApplyPlan,
  styleApplyCommandCode,
  styleApplyPlanRoute,
  styleApplyPlanningArgvFromRequest,
} from '../src/application/style-apply-command.js';
import {
  acceptsStyleApplyArgv,
  parseStyleApplyRequest,
  styleApplyArgvFromRequest,
  styleApplyFigmaUrlFileKeyFromArgv,
} from '../src/application/style-apply-request.js';

function style(overrides = {}) {
  return {
    id: 'S:1', key: 'STYLE_KEY', name: 'Columns/Auto', type: 'GRID', remote: false,
    layoutGrids: [{ pattern: 'COLUMNS', count: Infinity }],
    ...overrides,
  };
}

function node(id, calls, overrides = {}) {
  return {
    id, name: `Frame ${id}`, type: 'FRAME', gridStyleId: 'S:old',
    setGridStyleIdAsync: async (styleId) => { calls.push([id, styleId]); },
    ...overrides,
  };
}

function figmaFor(targetStyle, nodes, styleCalls = []) {
  return {
    getStyleByIdAsync: async (query) => query === targetStyle.id ? targetStyle : null,
    getLocalPaintStylesAsync: async () => [],
    getLocalTextStylesAsync: async () => [],
    getLocalEffectStylesAsync: async () => [],
    getLocalGridStylesAsync: async () => { styleCalls.push('GRID'); return [targetStyle]; },
    getNodeByIdAsync: async (id) => nodes.get(id) || null,
  };
}

async function pluginResult(request, figma) {
  return new Function('figma', `return ${styleApplyCommandCode(request)}`)(figma);
}

test('Style Apply request closes field, style, node list, and URL target identity', () => {
  const url = 'https://www.figma.com/design/FILEA/Test?node-id=10-2';
  assert.deepEqual(parseStyleApplyRequest([
    'style', 'apply', '--field=grid', '--', 'Columns/Auto', `${url},10:3`,
  ]), { style: 'Columns/Auto', field: 'grid', nodeIds: ['10:2', '10:3'] });
  assert.equal(styleApplyFigmaUrlFileKeyFromArgv([
    'style', 'apply', 'Columns/Auto', url, '--field', 'grid',
  ]), 'FILEA');
  assert.deepEqual(styleApplyArgvFromRequest({
    style: 'Columns/Auto', field: 'layout-guide', nodeIds: ['10-2', '10:3'],
  }), ['style', 'apply', '--field', 'grid', '--', 'Columns/Auto', '10:2,10:3']);
  for (const argv of [
    ['style', 'apply', 'Columns/Auto', '10:2'],
    ['style', 'apply', 'Columns/Auto', '10:2,10:2', '--field', 'grid'],
    ['style', 'apply', 'Columns/Auto', 'bad', '--field', 'grid'],
    ['style', 'apply', 'Columns/Auto', '10:2', '--field', 'future'],
    ['style', 'apply', 'Columns/Auto', '10:2', '--future', 'grid'],
  ]) assert.equal(acceptsStyleApplyArgv(argv), false, argv.join(' '));
});

test('Style Apply preflights every node before the first mutation', async () => {
  const calls = [];
  const first = node('10:1', calls);
  const unsupported = { id: '10:2', name: 'Text', type: 'TEXT' };
  const figma = figmaFor(style(), new Map([[first.id, first], [unsupported.id, unsupported]]));
  await assert.rejects(
    () => pluginResult({ style: 'S:1', field: 'grid', nodeIds: ['10:1', '10:2'] }, figma),
    /does not support grid styles/,
  );
  assert.deepEqual(calls, []);
});

test('Style Apply success returns compact identity without lossy raw GRID values', async () => {
  const calls = [];
  const nodes = new Map(['10:1', '10:2'].map((id) => [id, node(id, calls)]));
  const request = { style: 'Columns/Auto', field: 'grid', nodeIds: ['10:1', '10:2'] };
  const serialized = await pluginResult(request, figmaFor(style(), nodes));
  const result = await executeStyleApply(request, { evaluate: async () => serialized });
  assert.deepEqual(calls, [['10:1', 'S:1'], ['10:2', 'S:1']]);
  assert.equal(result.result.status, 'applied');
  assert.equal(result.result.total, 2);
  assert.equal(Object.hasOwn(result.result.style, 'layoutGrids'), false);
  assert.equal(result.stdout.includes('null'), false);
});

test('Style Apply grid means Layout Guide style, never Auto Layout Grid mode', () => {
  const code = styleApplyCommandCode({ style: 'S:1', field: 'layout-guide', nodeIds: ['10:1'] });
  assert.match(code, /setGridStyleIdAsync/);
  assert.match(code, /gridStyleId/);
  assert.doesNotMatch(code, /layoutMode|gridRowCount|gridColumnCount|gridRowSizes|gridColumnSizes/);
});

test('Style Apply rolls back confirmed prior writes and reports uncertain residue', async () => {
  const calls = [];
  const first = node('10:1', calls);
  const second = node('10:2', calls, {
    setGridStyleIdAsync: async (styleId) => {
      calls.push(['10:2', styleId]);
      throw new Error('fixture failure');
    },
  });
  const request = { style: 'S:1', field: 'grid', nodeIds: ['10:1', '10:2'] };
  const serialized = await pluginResult(request, figmaFor(style(), new Map([
    [first.id, first], [second.id, second],
  ])));
  await assert.rejects(
    () => executeStyleApply(request, { evaluate: async () => serialized }),
    (error) => {
      assert.match(error.message, /1 prior change\(s\) restored/);
      assert.equal(error.outcome, 'unknown-after-dispatch');
      assert.deepEqual(error.mutationReport, {
        version: 1, outcome: 'partial-residue', attempted: 2,
        confirmedApplied: 1, restored: 1, residueCount: 1,
      });
      return true;
    },
  );
  assert.deepEqual(calls, [['10:1', 'S:1'], ['10:2', 'S:1'], ['10:1', 'S:old']]);
});

test('Style Apply rejects malformed or self-inconsistent Plugin outcomes', async () => {
  const calls = [];
  const request = { style: 'S:1', field: 'grid', nodeIds: ['10:1'] };
  const serialized = await pluginResult(request, figmaFor(style(), new Map([
    ['10:1', node('10:1', calls)],
  ])));
  const payload = JSON.parse(serialized);
  for (const malformed of [
    { ...payload, total: 2 },
    { ...payload, style: { ...payload.style, type: 'TEXT' } },
    { ...payload, applied: [{ ...payload.applied[0], future: true }] },
    { ...payload, residue: [payload.applied[0]] },
  ]) {
    await assert.rejects(
      () => executeStyleApply(request, { evaluate: async () => JSON.stringify(malformed) }),
      /invalid bounded result/,
    );
  }
});

test('Style Apply Plan owns one non-retrying policy-identical mutation', async () => {
  const argv = styleApplyPlanningArgvFromRequest({
    style: 'Columns/Auto', field: 'grid', nodeIds: ['10:1'],
  });
  const cli = planFigmaCommand(argv, { adapter: 'cli' });
  const mcp = planFigmaCommand([
    'style', 'apply', 'Columns/Auto', '10:1', '--field=GRID',
  ], { adapter: 'mcp' });
  assert.deepEqual(cli.argv, mcp.argv);
  assert.deepEqual(cli.effects, mcp.effects);
  assert.equal(cli.effects.figma, 'write');
  assert.equal(cli.execution.retry, 'never');
  assert.equal(styleApplyPlanRoute(cli), 'command-application');
  const calls = [];
  const serialized = await pluginResult({
    style: 'Columns/Auto', field: 'grid', nodeIds: ['10:1'],
  }, figmaFor(style(), new Map([['10:1', node('10:1', calls)]])));
  assert.equal((await executeStyleApplyPlan(cli, {
    evaluate: async () => serialized,
  })).result.status, 'applied');
  await assert.rejects(
    () => executeStyleApplyPlan({ ...cli }, { evaluate: async () => serialized }),
    /requires a Command Plan created by the Capability Catalog/,
  );
});

test('Style Apply generated Plugin code parses', () => {
  assert.doesNotThrow(() => new Function(`return ${styleApplyCommandCode({
    style: 'S:1', field: 'grid', nodeIds: ['10:1'],
  })}`));
});
