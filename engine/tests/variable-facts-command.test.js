import assert from 'node:assert/strict';
import test from 'node:test';
import { planFigmaCommand } from '../../src/capability-catalog.js';
import {
  executeVariableFacts,
  executeVariableFactsPlan,
  MAX_VARIABLE_FACTS_CONTAINER_ENTRIES,
  variableFactsCode,
  variableFactsPlanRoute,
} from '../src/application/variable-facts-command.js';
import {
  acceptsVariableFactsArgv,
  parseVariableFactsRequest,
  variableFactsArgvFromRequest,
} from '../src/application/variable-facts-request.js';

function fixture(overrides = {}) {
  const collection = {
    id: 'VariableCollectionId:1:1', name: 'Primitives',
    modes: [{ modeId: '1:0', name: 'Light' }, { modeId: '1:1', name: 'Dark' }],
  };
  const variable = {
    id: 'VariableID:1:2', key: 'published-key', name: 'space/md',
    description: 'Medium spacing', resolvedType: 'FLOAT', remote: false,
    variableCollectionId: collection.id, hiddenFromPublishing: false,
    scopes: ['GAP'], codeSyntax: { WEB: 'var(--space-md)' },
    valuesByMode: { '1:0': 12, '1:1': { type: 'VARIABLE_ALIAS', id: 'VariableID:1:3' } },
    getPublishStatusAsync: async () => 'CURRENT',
    ...overrides,
  };
  const variables = overrides.variables || [variable];
  const collections = overrides.collections || [collection];
  const figma = {
    variables: {
      getLocalVariableCollectionsAsync: async () => collections,
      getLocalVariablesAsync: async () => variables,
      getVariableByIdAsync: async (id) => variables.find((item) => item.id === id) || null,
      getVariableCollectionByIdAsync: async (id) => collections.find((item) => item.id === id) || null,
    },
  };
  return { collection, variable, figma };
}

test('Variable Facts request closes and canonicalizes one query and optional collection', () => {
  assert.deepEqual(parseVariableFactsRequest([
    'var', 'show', '--collection=Primitives', 'space/md',
  ]), { variable: 'space/md', collection: 'Primitives' });
  assert.deepEqual(variableFactsArgvFromRequest({ variable: 'space/md', collection: 'Primitives' }),
    ['var', 'show', 'space/md', '--collection', 'Primitives']);
  assert.deepEqual(parseVariableFactsRequest(['var', 'show', '-cPrimitives', 'space/md']),
    { variable: 'space/md', collection: 'Primitives' });
  assert.deepEqual(parseVariableFactsRequest(['var', 'show', ' space/md ']),
    { variable: ' space/md ', collection: null });

  for (const args of [
    ['var', 'show'],
    ['var', 'show', 'space/md', 'other'],
    ['var', 'show', 'space/md', '--collection'],
    ['var', 'show', 'space/md', '-c', 'One', '-c', 'Two'],
    ['var', 'show', 'space/md', '--future', 'private-value'],
  ]) assert.equal(acceptsVariableFactsArgv(args), false, args.join(' '));
});

test('Variable Facts captures exact mode, alias, scope, syntax and collection facts', async () => {
  const { figma } = fixture();
  const serialized = await new Function('figma', `return ${variableFactsCode({
    variable: 'space/md', collection: 'Primitives',
  })};`)(figma);
  const execution = await executeVariableFacts({ variable: 'space/md', collection: 'Primitives' }, {
    evaluate: async () => serialized,
  });
  assert.deepEqual(execution.result, {
    schemaVersion: 1,
    id: 'VariableID:1:2', key: 'published-key', name: 'space/md',
    description: 'Medium spacing', resolvedType: 'FLOAT', remote: false,
    variableCollectionId: 'VariableCollectionId:1:1',
    collection: { id: 'VariableCollectionId:1:1', name: 'Primitives' },
    hiddenFromPublishing: false, scopes: ['GAP'],
    codeSyntax: { WEB: 'var(--space-md)' },
    valuesByMode: { '1:0': 12, '1:1': { type: 'VARIABLE_ALIAS', id: 'VariableID:1:3' } },
    modes: [{ modeId: '1:0', name: 'Light' }, { modeId: '1:1', name: 'Dark' }],
    publishStatus: 'CURRENT',
  });
  const { schemaVersion: _schemaVersion, ...legacyProjection } = execution.result;
  assert.deepEqual(JSON.parse(execution.stdout), legacyProjection,
    'legacy stdout stays the unversioned facts object');
});

test('Variable Facts accepts every official VariableValue family and escapes terminal controls', async () => {
  const families = [
    ['BOOLEAN', true],
    ['STRING', 'hold\u202ename'],
    ['FLOAT', 12.5],
    ['TIMING', 0.25],
    ['COLOR', { r: 0.1, g: 0.2, b: 0.3 }],
    ['COLOR', { r: 0.1, g: 0.2, b: 0.3, a: 0.4 }],
    ['FLOAT', { type: 'VARIABLE_ALIAS', id: 'VariableID:2:1' }],
    ['EASING', { type: 'CUSTOM_CUBIC_BEZIER', easingFunctionCubicBezier: {
      x1: 0.1, y1: -0.2, x2: 0.8, y2: 1.2,
    } }],
    ['EASING', { type: 'CUSTOM_SPRING', easingFunctionSpring: { bounce: 0.5 } }],
  ];
  for (const [resolvedType, value] of families) {
    const payload = JSON.stringify({
      schemaVersion: 1,
      id: 'VariableID:1:2', key: null, name: 'token/value', description: '',
      resolvedType, remote: false, variableCollectionId: 'VariableCollectionId:1:1',
      collection: { id: 'VariableCollectionId:1:1', name: 'Tokens' },
      hiddenFromPublishing: false, scopes: ['ALL_SCOPES'], codeSyntax: {},
      valuesByMode: { mode: value }, modes: [{ modeId: 'mode', name: 'Mode' }],
      publishStatus: 'UNPUBLISHED',
    });
    const result = await executeVariableFacts({ variable: 'token/value' }, {
      evaluate: async () => payload,
    });
    assert.deepEqual(result.result.valuesByMode.mode, value);
    if (resolvedType === 'STRING') {
      assert.doesNotMatch(result.stdout, /\u202e/);
      assert.match(result.stdout, /\\u202e/);
      assert.equal(JSON.parse(result.stdout).valuesByMode.mode, value);
    }
  }
});

test('Variable Facts rejects ambiguity instead of choosing a duplicate name', async () => {
  const first = fixture().variable;
  const second = { ...first, id: 'VariableID:2:2', variableCollectionId: 'VariableCollectionId:2:1' };
  const { figma } = fixture({
    variables: [first, second],
    collections: [
      { id: 'VariableCollectionId:1:1', name: 'Tokens', modes: [] },
      { id: 'VariableCollectionId:2:1', name: 'Brand', modes: [] },
    ],
  });
  await assert.rejects(
    () => new Function('figma', `return ${variableFactsCode({ variable: 'space/md' })};`)(figma),
    /Ambiguous variable.*2 matches/,
  );
});

test('Variable Facts rejects excessive collections and malformed Plugin results', async () => {
  const { variable, figma } = fixture({
    valuesByMode: Object.fromEntries(Array.from(
      { length: MAX_VARIABLE_FACTS_CONTAINER_ENTRIES + 1 },
      (_, index) => [`mode-${index}`, index],
    )),
  });
  variable.valuesByMode = Object.fromEntries(Array.from(
    { length: MAX_VARIABLE_FACTS_CONTAINER_ENTRIES + 1 },
    (_, index) => [`mode-${index}`, index],
  ));
  await assert.rejects(
    () => new Function('figma', `return ${variableFactsCode({ variable: variable.id })};`)(figma),
    /object limit/,
  );

  for (const malformed of [
    { not: 'serialized' },
    JSON.stringify({ schemaVersion: 2 }),
    JSON.stringify({
      schemaVersion: 1,
      id: 'VariableID:1:2', key: null, name: 'bad', description: '',
      resolvedType: 'COLOR', remote: false, variableCollectionId: 'VariableCollectionId:1:1',
      collection: { id: 'VariableCollectionId:1:1', name: 'Tokens' },
      hiddenFromPublishing: false, scopes: [], codeSyntax: {},
      valuesByMode: { mode: { r: 2, g: 0, b: 0 } },
      modes: [{ modeId: 'mode', name: 'Mode' }], publishStatus: 'CURRENT',
    }),
  ]) {
    await assert.rejects(
      () => executeVariableFacts({ variable: 'bad' }, { evaluate: async () => malformed }),
      /invalid bounded result/,
    );
  }
});

test('Variable Facts Plan route accepts only its authentic safe-read Plan', async () => {
  const plan = planFigmaCommand([
    'var', 'show', '--collection=Primitives', 'space/md',
  ], { adapter: 'mcp' });
  assert.equal(plan.allowed, true);
  assert.equal(plan.id, 'var.show');
  assert.equal(plan.execution.retry, 'safe-read');
  assert.deepEqual(plan.argv, ['var', 'show', 'space/md', '--collection', 'Primitives']);
  assert.equal(variableFactsPlanRoute(plan), 'command-application');

  const { figma } = fixture();
  const serialized = await new Function('figma', `return ${variableFactsCode({
    variable: 'space/md', collection: 'Primitives',
  })};`)(figma);
  assert.equal((await executeVariableFactsPlan(plan, {
    evaluate: async () => serialized,
  })).result.name, 'space/md');
  await assert.rejects(
    () => executeVariableFactsPlan({ ...plan }, { evaluate: async () => serialized }),
    /requires a Command Plan created by the Capability Catalog/,
  );
  assert.equal(variableFactsPlanRoute(planFigmaCommand(['var', 'update', 'space/md'])),
    'not-variable-facts');

  const urlShapedName = 'https://www.figma.com/design/FILEA/Payload?node-id=12-34';
  const cli = planFigmaCommand(['var', 'show', urlShapedName], { adapter: 'cli' });
  const mcp = planFigmaCommand(['var', 'show', urlShapedName], { adapter: 'mcp' });
  assert.notEqual(mcp.target.source, 'figma-url');
  assert.deepEqual(mcp.argv, ['var', 'show', urlShapedName]);
  const { adapter: _cliAdapter, allowed: _cliAllowed, ...cliPolicy } = cli;
  const { adapter: _mcpAdapter, allowed: _mcpAllowed, ...mcpPolicy } = mcp;
  assert.deepEqual(cliPolicy, mcpPolicy);
});
