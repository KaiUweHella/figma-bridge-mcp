import assert from 'node:assert/strict';
import test from 'node:test';
import { planFigmaCommand } from '../../src/capability-catalog.js';
import {
  executeStyleCreate,
  executeStyleCreatePlan,
  styleCreateCommandCode,
  styleCreatePlanRoute,
  styleCreatePlanningArgvFromRequest,
} from '../src/application/style-create-command.js';
import {
  acceptsStyleCreateArgv,
  parseStyleCreateRequest,
  styleCreateArgvFromRequest,
} from '../src/application/style-create-request.js';

function localStyle(type, overrides = {}) {
  return {
    id: `S:${type}`, key: `${type}_KEY`, name: '', description: '', type, remote: false,
    remove() { this.removed = true; },
    ...overrides,
  };
}

async function pluginResult(request, figma) {
  return new Function('figma', `return ${styleCreateCommandCode(request)}`)(figma);
}

test('Style Create request closes options, bounds inputs, and canonicalizes property JSON', () => {
  const grid = '{"layoutGrids":[{"pattern":"COLUMNS","alignment":"MIN","gutterSize":16,"count":{"$figmaScalar":"Infinity"},"sectionSize":80,"offset":64}]}';
  const parsed = parseStyleCreateRequest([
    'style', 'create', '--properties', grid, '--description=Fixture', '--', 'grid', '-Columns',
  ]);
  assert.equal(parsed.type, 'GRID');
  assert.equal(parsed.name, '-Columns');
  assert.deepEqual(parsed.properties.layoutGrids[0].count, { $figmaScalar: 'Infinity' });
  assert.deepEqual(styleCreateArgvFromRequest(parsed), [
    'style', 'create', '--description', 'Fixture', '--properties',
    '{"layoutGrids":[{"alignment":"MIN","count":{"$figmaScalar":"Infinity"},"gutterSize":16,"offset":64,"pattern":"COLUMNS","sectionSize":80}]}',
    '--', 'GRID', '-Columns',
  ]);
  for (const argv of [
    ['style', 'create', 'PAINT'],
    ['style', 'create', 'FUTURE', 'Name'],
    ['style', 'create', 'PAINT', 'Name', '--description'],
    ['style', 'create', 'PAINT', 'Name', '--properties', '[]'],
    ['style', 'create', 'PAINT', 'Name', '--properties', '{"paints":[{"type":"FUTURE"}]}'],
    ['style', 'create', 'TEXT', 'Name', '--properties', '{"fontSize":"48"}'],
    ['style', 'create', 'GRID', 'Name', '--properties', '{"layoutGrids":[{"pattern":"GRID","sectionSize":null}]}'],
    ['style', 'create', 'PAINT', 'Name', '--properties', '{"paints":[{"count":{"$figmaScalar":"Infinity"}}]}'],
  ]) assert.equal(acceptsStyleCreateArgv(argv), false, argv.join(' '));
});

test('Style Create loads a requested font before creating and returns compact identity', async () => {
  const calls = [];
  const style = localStyle('TEXT');
  const request = {
    type: 'TEXT', name: 'Heading', description: 'Hero',
    properties: { fontName: { family: 'Inter', style: 'Bold' }, fontSize: 48 },
  };
  const serialized = await pluginResult(request, {
    loadFontAsync: async (font) => calls.push(['font', font]),
    createTextStyle: () => { calls.push(['create']); return style; },
  });
  const result = await executeStyleCreate(request, { evaluate: async () => serialized });
  assert.deepEqual(calls, [['font', { family: 'Inter', style: 'Bold' }], ['create']]);
  assert.equal(result.result.status, 'created');
  assert.equal(result.result.style.name, 'Heading');
  assert.equal(Object.hasOwn(result.result.style, 'fontName'), false);
  assert.equal(Object.hasOwn(result.result.style, 'fontSize'), false);
});

test('Style Create decodes only the explicit GRID Auto scalar before assignment', async () => {
  let assigned;
  const style = localStyle('GRID');
  Object.defineProperty(style, 'layoutGrids', {
    set(value) { assigned = value; }, configurable: true,
  });
  const request = {
    type: 'GRID', name: 'Columns/Auto',
    properties: { layoutGrids: [{
      pattern: 'COLUMNS', alignment: 'MIN', gutterSize: 16,
      count: { $figmaScalar: 'Infinity' }, sectionSize: 80, offset: 64,
    }] },
  };
  const serialized = await pluginResult(request, { createGridStyle: () => style });
  const result = await executeStyleCreate(request, { evaluate: async () => serialized });
  assert.equal(assigned[0].count, Infinity);
  assert.equal(result.stdout.includes('layoutGrids'), false);
  assert.equal(result.stdout.includes('null'), false);
});

test('Style Create removes its created Style after assignment failure', async () => {
  const style = localStyle('GRID');
  Object.defineProperty(style, 'layoutGrids', {
    set() { throw new Error('runtime write-shape rejection'); }, configurable: true,
  });
  const request = {
    type: 'GRID', name: 'Rejected/Grid',
    properties: { layoutGrids: [{
      pattern: 'COLUMNS', alignment: 'STRETCH', gutterSize: 16,
      count: 12, sectionSize: 80, offset: 0,
    }] },
  };
  const serialized = await pluginResult(request, { createGridStyle: () => style });
  await assert.rejects(
    () => executeStyleCreate(request, { evaluate: async () => serialized }),
    (error) => {
      assert.equal(error.dispatchState, 'failed');
      assert.equal(error.mutationOutcome, 'rolled-back');
      assert.deepEqual(error.mutationReport, {
        version: 1, outcome: 'rolled-back', created: 1, removed: 1,
        residueCount: 0, residue: [], residueTruncated: false,
      });
      return true;
    },
  );
  assert.equal(style.removed, true);
});

test('Style Create reports bounded typed residue when cleanup fails', async () => {
  const style = localStyle('EFFECT', {
    remove() { throw new Error('remove failed'); },
  });
  Object.defineProperty(style, 'effects', {
    set() { throw new Error('assignment failed'); }, configurable: true,
  });
  const request = { type: 'EFFECT', name: 'Residue', properties: { effects: [] } };
  const serialized = await pluginResult(request, { createEffectStyle: () => style });
  await assert.rejects(
    () => executeStyleCreate(request, { evaluate: async () => serialized }),
    (error) => {
      assert.equal(error.mutationOutcome, 'partial-residue');
      assert.deepEqual(error.mutationReport.residue, [{
        kind: 'effect-style', handle: 'S:EFFECT', reason: 'remove-failed',
      }]);
      return true;
    },
  );
});

test('Style Create rejects malformed Plugin outcomes', async () => {
  const request = { type: 'PAINT', name: 'Surface', properties: { paints: [] } };
  const serialized = await pluginResult(request, { createPaintStyle: () => localStyle('PAINT') });
  const payload = JSON.parse(serialized);
  for (const malformed of [
    { ...payload, future: true },
    { ...payload, style: { ...payload.style, type: 'GRID' } },
    { ...payload, residue: [payload.style] },
  ]) await assert.rejects(
    () => executeStyleCreate(request, { evaluate: async () => JSON.stringify(malformed) }),
    /invalid bounded result/,
  );
});

test('Style Create Plan owns one policy-identical non-retrying write', async () => {
  const argv = styleCreatePlanningArgvFromRequest({
    type: 'PAINT', name: 'Surface', properties: { paints: [] },
  });
  const cli = planFigmaCommand(argv, { adapter: 'cli' });
  const mcp = planFigmaCommand([
    'style', 'create', 'paint', 'Surface', '--properties={"paints":[]}',
  ], { adapter: 'mcp' });
  assert.deepEqual(cli.argv, mcp.argv);
  assert.deepEqual(cli.effects, mcp.effects);
  assert.equal(cli.effects.figma, 'write');
  assert.equal(cli.execution.retry, 'never');
  assert.equal(styleCreatePlanRoute(cli), 'command-application');
  const serialized = await pluginResult({
    type: 'PAINT', name: 'Surface', properties: { paints: [] },
  }, { createPaintStyle: () => localStyle('PAINT') });
  assert.equal((await executeStyleCreatePlan(cli, {
    evaluate: async () => serialized,
  })).result.status, 'created');
  await assert.rejects(
    () => executeStyleCreatePlan({ ...cli }, { evaluate: async () => serialized }),
    /requires a Command Plan created by the Capability Catalog/,
  );
});

test('Style Create generated Plugin code parses', () => {
  assert.doesNotThrow(() => new Function(`return ${styleCreateCommandCode({
    type: 'PAINT', name: 'Surface', properties: { paints: [] },
  })}`));
});
