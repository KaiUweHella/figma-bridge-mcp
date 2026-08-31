import assert from 'node:assert/strict';
import test from 'node:test';
import { planFigmaCommand } from '../../src/capability-catalog.js';
import {
  executeLibraryImport,
  executeLibraryImportPlan,
  libraryImportCode,
  libraryImportPlanRoute,
} from '../src/application/library-import-command.js';
import {
  acceptsLibraryImportArgv,
  libraryImportArgvFromRequest,
  parseLibraryImportRequest,
} from '../src/application/library-import-request.js';

function fixture({ mismatch = false, throws = false, longDescription = false } = {}) {
  const calls = [];
  const resources = {
    variable: { id: 'V:1', key: 'VARIABLE_KEY', name: 'space/md', resolvedType: 'FLOAT', remote: true, variableCollectionId: 'C:1' },
    style: { id: 'S:1', key: 'STYLE_KEY', name: 'Brand', type: 'PAINT', remote: true, description: longDescription ? 'x'.repeat(100_000) : 'Brand paint' },
    component: { id: 'N:1', key: 'COMPONENT_KEY', name: 'Button', type: 'COMPONENT', remote: true, description: '' },
    'component-set': { id: 'N:2', key: 'SET_KEY', name: 'Button', type: 'COMPONENT_SET', remote: true, description: '' },
  };
  const imported = (kind) => async (key) => {
    calls.push([kind, key]);
    if (throws) throw new Error('native import failed');
    return resources[kind];
  };
  const fresh = (resource) => mismatch ? { ...resource, key: 'DIFFERENT_KEY' } : resource;
  const figma = {
    variables: {
      importVariableByKeyAsync: imported('variable'),
      getVariableByIdAsync: async () => fresh(resources.variable),
      getVariableCollectionByIdAsync: async () => ({ id: 'C:1', key: 'COLLECTION_KEY', name: 'Primitives', remote: true }),
    },
    importStyleByKeyAsync: imported('style'),
    importComponentByKeyAsync: imported('component'),
    importComponentSetByKeyAsync: imported('component-set'),
    getStyleByIdAsync: async () => fresh(resources.style),
    getNodeByIdAsync: async (id) => fresh(id === 'N:2' ? resources['component-set'] : resources.component),
  };
  return { calls, figma };
}

const plugin = (request, figma) => new Function('figma', `return ${libraryImportCode(request)}`)(figma);

test('Library Import closes and canonicalizes all four published-resource actions', () => {
  const cases = [
    [['library', 'import-variable', ' VARIABLE_KEY '], { action: 'variable', key: 'VARIABLE_KEY' }],
    [['library', 'import-style', '--', 'STYLE_KEY'], { action: 'style', key: 'STYLE_KEY' }],
    [['library', 'import-component', 'COMPONENT_KEY'], { action: 'component', key: 'COMPONENT_KEY' }],
    [['library', 'import-component-set', 'SET_KEY'], { action: 'component-set', key: 'SET_KEY' }],
  ];
  for (const [argv, request] of cases) {
    assert.deepEqual(parseLibraryImportRequest(argv), request);
    assert.deepEqual(parseLibraryImportRequest(libraryImportArgvFromRequest(request)), request);
  }
  for (const argv of [
    ['library', 'import-variable'],
    ['library', 'import-style', 'KEY', 'EXTRA'],
    ['library', 'import-component', '--future', 'private-value'],
    ['library', 'import-component-set', '\u202eKEY'],
  ]) assert.equal(acceptsLibraryImportArgv(argv), false, argv.join(' '));
});

test('Library Import invokes each native materialization once and freshly verifies identity', async () => {
  const cases = [
    { action: 'variable', key: 'VARIABLE_KEY' },
    { action: 'style', key: 'STYLE_KEY' },
    { action: 'component', key: 'COMPONENT_KEY' },
    { action: 'component-set', key: 'SET_KEY' },
  ];
  for (const request of cases) {
    const source = fixture();
    const result = await executeLibraryImport(request, {
      evaluate: async () => plugin(request, source.figma),
    });
    assert.equal(result.result.status, 'imported');
    assert.equal(result.result.resource.key, request.key);
    assert.deepEqual(source.calls, [[request.action, request.key]]);
  }
});

test('Library Import reports irreversible mismatch, unknown native failure and bounded descriptions', async () => {
  const mismatch = fixture({ mismatch: true });
  await assert.rejects(() => executeLibraryImport({ action: 'style', key: 'STYLE_KEY' }, {
    evaluate: async () => plugin({ action: 'style', key: 'STYLE_KEY' }, mismatch.figma),
  }), (error) => error.mutationOutcome === 'partial-residue' && error.mutationReport.residueCount === 1);

  const failed = fixture({ throws: true });
  await assert.rejects(() => executeLibraryImport({ action: 'component', key: 'COMPONENT_KEY' }, {
    evaluate: async () => plugin({ action: 'component', key: 'COMPONENT_KEY' }, failed.figma),
  }), (error) => error.mutationOutcome === 'verification-unavailable'
    && error.mutationReport.attempted === 1 && failed.calls.length === 1);

  const oversized = fixture({ longDescription: true });
  const bounded = await executeLibraryImport({ action: 'style', key: 'STYLE_KEY' }, {
    evaluate: async () => plugin({ action: 'style', key: 'STYLE_KEY' }, oversized.figma),
  });
  assert.equal(bounded.result.status, 'imported');
  assert.equal(bounded.result.resource.description.length, 4096);
  assert.equal(bounded.result.warnings.length, 1);
});

test('Library Import refuses an unsupported native API before materialization', async () => {
  const source = fixture();
  delete source.figma.importStyleByKeyAsync;
  await assert.rejects(() => executeLibraryImport({ action: 'style', key: 'STYLE_KEY' }, {
    evaluate: async () => plugin({ action: 'style', key: 'STYLE_KEY' }, source.figma),
  }), (error) => error.mutationOutcome === 'no-mutation'
    && error.mutationReport.attempted === 0 && source.calls.length === 0);
});

test('Library Import has one non-retrying Plan and one evaluation in both Adapters', async () => {
  const requests = [
    { action: 'variable', key: 'VARIABLE_KEY' }, { action: 'style', key: 'STYLE_KEY' },
    { action: 'component', key: 'COMPONENT_KEY' }, { action: 'component-set', key: 'SET_KEY' },
  ];
  for (const request of requests) {
    for (const adapter of ['cli', 'mcp']) {
      const plan = planFigmaCommand(libraryImportArgvFromRequest(request), { adapter });
      assert.equal(plan.allowed, true); assert.equal(plan.execution.retry, 'never');
      assert.equal(libraryImportPlanRoute(plan), 'command-application');
      const source = fixture(); let evaluations = 0;
      const result = await executeLibraryImportPlan(plan, {
        evaluate: async (code) => { evaluations += 1; return new Function('figma', `return ${code}`)(source.figma); },
      });
      assert.equal(result.result.status, 'imported'); assert.equal(evaluations, 1);
    }
  }
});
