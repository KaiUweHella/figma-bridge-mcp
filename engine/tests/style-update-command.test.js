import assert from 'node:assert/strict';
import test from 'node:test';
import { planFigmaCommand } from '../../src/capability-catalog.js';
import {
  executeStyleUpdate,
  executeStyleUpdatePlan,
  styleUpdateCommandCode,
  styleUpdatePlanRoute,
  styleUpdatePlanningArgvFromRequest,
} from '../src/application/style-update-command.js';
import {
  acceptsStyleUpdateArgv,
  parseStyleUpdateRequest,
  styleUpdateArgvFromRequest,
} from '../src/application/style-update-request.js';

function localStyle(type = 'GRID', overrides = {}) {
  return {
    id: 'S:1', key: 'STYLE_KEY', name: 'Columns/Auto', description: 'Original',
    type, remote: false, layoutGrids: [{ pattern: 'COLUMNS', count: 12 }],
    ...overrides,
  };
}

function figmaFor(style, calls = []) {
  return {
    getStyleByIdAsync: async (query) => query === style.id ? style : null,
    getLocalPaintStylesAsync: async () => style.type === 'PAINT' ? [style] : [],
    getLocalTextStylesAsync: async () => style.type === 'TEXT' ? [style] : [],
    getLocalEffectStylesAsync: async () => style.type === 'EFFECT' ? [style] : [],
    getLocalGridStylesAsync: async () => style.type === 'GRID' ? [style] : [],
    loadFontAsync: async (font) => calls.push(['font', font]),
  };
}

async function pluginResult(request, figma) {
  return new Function('figma', `return ${styleUpdateCommandCode(request)}`)(figma);
}

test('Style Update request closes optional mutations and canonicalizes shared property values', () => {
  const parsed = parseStyleUpdateRequest([
    'style', 'update', '--properties',
    '{"layoutGrids":[{"pattern":"COLUMNS","alignment":"MIN","gutterSize":16,"count":{"$figmaScalar":"Infinity"},"sectionSize":80,"offset":64}]}',
    '-nColumns/Responsive', '-tgrid', '--description=', '--', '-Columns',
  ]);
  assert.equal(parsed.style, '-Columns');
  assert.equal(parsed.type, 'GRID');
  assert.equal(parsed.description, '');
  assert.deepEqual(styleUpdateArgvFromRequest(parsed), [
    'style', 'update', '--type', 'GRID', '--name', 'Columns/Responsive',
    '--description', '', '--properties',
    '{"layoutGrids":[{"alignment":"MIN","count":{"$figmaScalar":"Infinity"},"gutterSize":16,"offset":64,"pattern":"COLUMNS","sectionSize":80}]}',
    '--', '-Columns',
  ]);
  for (const argv of [
    ['style', 'update', 'Columns'],
    ['style', 'update', 'Columns', '--type', 'GRID'],
    ['style', 'update', 'Columns', '--properties', '{"layoutGrids":[]}'],
    ['style', 'update', 'Columns', '--type', 'GRID', '--properties', '{}'],
    ['style', 'update', 'Columns', '--type', 'GRID', '--properties', '{"layoutGrids":[{"pattern":"GRID","sectionSize":null}]}'],
    ['style', 'update', 'Columns', '--name', 'Next', '--name', 'Again'],
    ['style', 'update', 'Columns', '--future', 'Next'],
  ]) assert.equal(acceptsStyleUpdateArgv(argv), false, argv.join(' '));
});

test('Style Update loads Text font before the first mutation and returns compact identity', async () => {
  const calls = [];
  let name = 'Body';
  let fontName = { family: 'Inter', style: 'Regular' };
  const style = localStyle('TEXT', { id: 'S:T', layoutGrids: undefined });
  Object.defineProperties(style, {
    name: { get: () => name, set: (value) => { calls.push(['name', value]); name = value; }, configurable: true },
    fontName: { get: () => fontName, set: (value) => { calls.push(['fontName', value]); fontName = value; }, configurable: true },
  });
  const request = {
    style: 'S:T', type: 'TEXT', name: 'Body/Strong',
    properties: { fontName: { family: 'Inter', style: 'Bold' }, fontSize: 18 },
  };
  const serialized = await pluginResult(request, figmaFor(style, calls));
  const result = await executeStyleUpdate(request, { evaluate: async () => serialized });
  assert.equal(calls[0][0], 'font');
  assert.deepEqual(calls.slice(1, 3).map(([kind]) => kind), ['name', 'fontName']);
  assert.equal(result.result.style.name, 'Body/Strong');
  assert.deepEqual(result.result.fields, ['name', 'fontName', 'fontSize']);
  assert.equal(Object.hasOwn(result.result.style, 'fontName'), false);
  assert.equal(Object.hasOwn(result.result.style, 'fontSize'), false);
});

test('Style Update decodes GRID Auto only for assignment and omits raw Layout Guides from output', async () => {
  let assigned;
  let current = [{ pattern: 'COLUMNS', count: 12 }];
  const style = localStyle();
  Object.defineProperty(style, 'layoutGrids', {
    get: () => current,
    set(value) { assigned = value; current = value; },
    configurable: true,
  });
  const request = {
    style: 'S:1', type: 'GRID', properties: { layoutGrids: [{
      pattern: 'COLUMNS', alignment: 'MIN', gutterSize: 16,
      count: { $figmaScalar: 'Infinity' }, sectionSize: 80, offset: 64,
    }] },
  };
  const serialized = await pluginResult(request, figmaFor(style));
  const result = await executeStyleUpdate(request, { evaluate: async () => serialized });
  assert.equal(assigned[0].count, Infinity);
  assert.equal(result.stdout.includes('layoutGrids'), true, 'updated field names remain visible');
  assert.equal(result.stdout.includes('"count"'), false, 'raw Layout Guide values do not cross the seam');
  assert.equal(result.stdout.includes('null'), false);
});

test('Style Update restores the failing field and all confirmed prior fields in reverse order', async () => {
  const calls = [];
  let grids = [{ pattern: 'COLUMNS', count: 12 }];
  const rejected = [{
    pattern: 'COLUMNS', alignment: 'STRETCH', gutterSize: 16,
    count: 12, sectionSize: 80, offset: 0,
  }];
  const style = localStyle();
  Object.defineProperty(style, 'layoutGrids', {
    get: () => grids,
    set(value) {
      calls.push(['layoutGrids', value]);
      if (value[0]?.alignment === 'STRETCH') {
        grids = value;
        throw new Error('setter mutated before runtime write-shape rejection');
      }
      grids = value;
    },
    configurable: true,
  });
  let name = style.name;
  Object.defineProperty(style, 'name', {
    get: () => name,
    set(value) { calls.push(['name', value]); name = value; },
    configurable: true,
  });
  const request = { style: 'S:1', type: 'GRID', name: 'Temporary', properties: { layoutGrids: rejected } };
  const serialized = await pluginResult(request, figmaFor(style));
  await assert.rejects(
    () => executeStyleUpdate(request, { evaluate: async () => serialized }),
    (error) => {
      assert.equal(error.dispatchState, 'failed');
      assert.equal(error.mutationOutcome, 'rolled-back');
      assert.deepEqual(error.styleMutationReport, {
        version: 1, outcome: 'rolled-back', attempted: 2, confirmed: 1,
        restored: 2, failedRestoreFields: [], residueCount: 0,
      });
      return true;
    },
  );
  assert.equal(name, 'Columns/Auto');
  assert.equal(grids[0].count, 12);
  assert.deepEqual(calls.map(([field]) => field), ['name', 'layoutGrids', 'layoutGrids', 'name']);
});

test('Style Update reports bounded residue when an existing field cannot be restored', async () => {
  let writes = 0;
  const style = localStyle('EFFECT', { id: 'S:E', name: 'Effects', effects: [] });
  Object.defineProperty(style, 'effects', {
    get: () => [],
    set() { writes++; throw new Error('setter and restore fail'); },
    configurable: true,
  });
  const request = { style: 'S:E', type: 'EFFECT', properties: { effects: [{ type: 'DROP_SHADOW' }] } };
  const serialized = await pluginResult(request, figmaFor(style));
  await assert.rejects(
    () => executeStyleUpdate(request, { evaluate: async () => serialized }),
    (error) => {
      assert.equal(error.mutationOutcome, 'partial-residue');
      assert.deepEqual(error.styleMutationReport.failedRestoreFields, ['effects']);
      assert.equal(error.styleMutationReport.residueCount, 1);
      return true;
    },
  );
  assert.equal(writes, 2, 'the failing field itself must receive a rollback attempt');
});

test('Style Update rejects malformed Plugin outcomes', async () => {
  const request = { style: 'S:1', description: 'Updated' };
  const serialized = await pluginResult(request, figmaFor(localStyle()));
  const payload = JSON.parse(serialized);
  for (const malformed of [
    { ...payload, future: true },
    { ...payload, style: { ...payload.style, remote: true } },
    { ...payload, fields: ['name'] },
    { ...payload, residue: [payload.style] },
  ]) await assert.rejects(
    () => executeStyleUpdate(request, { evaluate: async () => JSON.stringify(malformed) }),
    /invalid bounded result/,
  );
});

test('Style Update Plan owns one policy-identical non-retrying mutation', async () => {
  const argv = styleUpdatePlanningArgvFromRequest({
    style: 'Columns/Auto', type: 'GRID', description: 'Responsive',
    properties: { layoutGrids: [] },
  });
  const cli = planFigmaCommand(argv, { adapter: 'cli' });
  const mcp = planFigmaCommand([
    'style', 'update', '--properties={"layoutGrids":[]}', '-dResponsive', '-tgrid', '--', 'Columns/Auto',
  ], { adapter: 'mcp' });
  assert.deepEqual(cli.argv, mcp.argv);
  assert.deepEqual(cli.effects, mcp.effects);
  assert.equal(cli.effects.figma, 'write');
  assert.equal(cli.execution.retry, 'never');
  assert.equal(styleUpdatePlanRoute(cli), 'command-application');
  const serialized = await pluginResult({
    style: 'Columns/Auto', type: 'GRID', description: 'Responsive', properties: { layoutGrids: [] },
  }, figmaFor(localStyle()));
  assert.equal((await executeStyleUpdatePlan(cli, {
    evaluate: async () => serialized,
  })).result.status, 'updated');
  await assert.rejects(
    () => executeStyleUpdatePlan({ ...cli }, { evaluate: async () => serialized }),
    /requires a Command Plan created by the Capability Catalog/,
  );
});

test('Style Update generated Plugin code parses', () => {
  assert.doesNotThrow(() => new Function(`return ${styleUpdateCommandCode({
    style: 'S:1', description: '',
  })}`));
});
