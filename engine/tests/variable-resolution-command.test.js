import assert from 'node:assert/strict';
import test from 'node:test';
import { planFigmaCommand } from '../../src/capability-catalog.js';
import {
  executeVariableResolution,
  executeVariableResolutionPlan,
  variableResolutionCode,
  variableResolutionPlanRoute,
} from '../src/application/variable-resolution-command.js';
import {
  acceptsVariableResolutionArgv,
  parseVariableResolutionRequest,
  variableResolutionArgvFromRequest,
  variableResolutionPlanningArgvFromRequest,
} from '../src/application/variable-resolution-request.js';

function fixture({ resolvedType = 'FLOAT', value = 12, variables, collections } = {}) {
  const collection = {
    id: 'VariableCollectionId:1:1', name: 'Primitives',
    modes: [{ modeId: '1:0', name: 'Light' }],
  };
  const variable = {
    id: 'VariableID:1:2', name: 'space/md', resolvedType,
    variableCollectionId: collection.id,
    resolveForConsumer: () => ({ value, resolvedType }),
  };
  const allVariables = variables || [variable];
  const allCollections = collections || [collection];
  const figma = {
    variables: {
      getLocalVariableCollectionsAsync: async () => allCollections,
      getLocalVariablesAsync: async () => allVariables,
      getVariableByIdAsync: async (id) => allVariables.find((item) => item.id === id) || null,
      getVariableCollectionByIdAsync: async (id) => allCollections.find((item) => item.id === id) || null,
    },
    getNodeByIdAsync: async (id) => id === '12:34'
      ? { id, name: 'Card', type: 'FRAME' } : null,
  };
  return { collection, variable, figma };
}

async function captured(request, source = fixture()) {
  return new Function('figma', `return ${variableResolutionCode(request)};`)(source.figma);
}

test('Variable Resolution request owns arity, collection options and semantic node targeting', () => {
  assert.deepEqual(parseVariableResolutionRequest([
    'var', 'resolve', '--collection=Primitives', 'space/md', '12-34',
  ]), { variable: 'space/md', nodeId: '12:34', collection: 'Primitives' });
  assert.deepEqual(parseVariableResolutionRequest([
    'var', 'resolve', '-cPrimitives', 'space/md', '12:34',
  ]), { variable: 'space/md', nodeId: '12:34', collection: 'Primitives' });
  assert.deepEqual(variableResolutionArgvFromRequest({
    variable: 'space/md', nodeId: '12:34', collection: 'Primitives',
  }), ['var', 'resolve', 'space/md', '12:34', '--collection', 'Primitives']);
  assert.deepEqual(variableResolutionArgvFromRequest({
    variable: '-space/md', nodeId: '12:34', collection: '-Tokens',
  }), ['var', 'resolve', '--collection=-Tokens', '--', '-space/md', '12:34']);
  assert.deepEqual(parseVariableResolutionRequest(variableResolutionArgvFromRequest({
    variable: '-space/md', nodeId: '12:34', collection: '-Tokens',
  })), { variable: '-space/md', nodeId: '12:34', collection: '-Tokens' });

  const url = 'https://www.figma.com/design/FILEA/Doc?node-id=12-34';
  assert.deepEqual(variableResolutionPlanningArgvFromRequest({ variable: 'space/md', nodeId: url }),
    ['var', 'resolve', 'space/md', url]);
  assert.deepEqual(variableResolutionPlanningArgvFromRequest({
    variable: '-space/md', nodeId: url, collection: '-Tokens',
  }), ['var', 'resolve', '--collection=-Tokens', '--', '-space/md', url]);
  for (const args of [
    ['var', 'resolve'],
    ['var', 'resolve', 'space/md'],
    ['var', 'resolve', 'space/md', '12:34', 'extra'],
    ['var', 'resolve', 'space/md', 'bad-node'],
    ['var', 'resolve', 'space/md', '12:34', '--collection'],
    ['var', 'resolve', 'space/md', '12:34', '-cOne', '-cTwo'],
    ['var', 'resolve', 'space/md', '12:34', '--future'],
  ]) assert.equal(acceptsVariableResolutionArgv(args), false, args.join(' '));
});

test('Variable Resolution captures exact variable, collection, consumer and resolved value', async () => {
  const serialized = await captured({
    variable: 'space/md', nodeId: '12:34', collection: 'Primitives',
  });
  const execution = await executeVariableResolution({
    variable: 'space/md', nodeId: '12:34', collection: 'Primitives',
  }, { evaluate: async () => serialized });
  assert.deepEqual(execution.result, {
    schemaVersion: 1,
    variable: {
      id: 'VariableID:1:2', name: 'space/md', resolvedType: 'FLOAT',
      collection: { id: 'VariableCollectionId:1:1', name: 'Primitives' },
    },
    consumer: { id: '12:34', name: 'Card', type: 'FRAME' },
    resolved: { value: 12, resolvedType: 'FLOAT' },
  });
  const { schemaVersion: _schemaVersion, ...projection } = execution.result;
  assert.deepEqual(JSON.parse(execution.stdout), projection);
});

test('Variable Resolution accepts every official resolved VariableValue family', async () => {
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
    const source = fixture({ resolvedType, value });
    const serialized = await captured({ variable: 'space/md', nodeId: '12:34' }, source);
    const execution = await executeVariableResolution({
      variable: 'space/md', nodeId: '12:34',
    }, { evaluate: async () => serialized });
    assert.deepEqual(execution.result.resolved.value, value);
    if (resolvedType === 'STRING') {
      assert.doesNotMatch(execution.stdout, /\u202e/);
      assert.match(execution.stdout, /\\u202e/);
    }
  }
});

test('Variable Resolution rejects ambiguous lookup and malformed Plugin results', async () => {
  const first = fixture().variable;
  const second = { ...first, id: 'VariableID:2:2', variableCollectionId: 'VariableCollectionId:2:1' };
  const source = fixture({
    variables: [first, second],
    collections: [
      { id: 'VariableCollectionId:1:1', name: 'Tokens', modes: [] },
      { id: 'VariableCollectionId:2:1', name: 'Brand', modes: [] },
    ],
  });
  await assert.rejects(() => captured({ variable: 'space/md', nodeId: '12:34' }, source),
    /Ambiguous variable.*2 matches/);

  for (const malformed of [
    { not: 'serialized' },
    JSON.stringify({ schemaVersion: 2 }),
    JSON.stringify({
      schemaVersion: 1,
      variable: {
        id: 'VariableID:1:2', name: 'color/red', resolvedType: 'COLOR',
        collection: { id: 'VariableCollectionId:1:1', name: 'Tokens' },
      },
      consumer: { id: '12:34', name: 'Card', type: 'FRAME' },
      resolved: { value: { r: 2, g: 0, b: 0 }, resolvedType: 'COLOR' },
    }),
  ]) {
    await assert.rejects(() => executeVariableResolution({
      variable: 'space/md', nodeId: '12:34',
    }, { evaluate: async () => malformed }), /invalid bounded result/);
  }
});

test('Variable Resolution Plan route accepts only its authentic safe-read Plan', async () => {
  const url = 'https://www.figma.com/design/FILEA/Doc?node-id=12-34';
  const plan = planFigmaCommand([
    'var', 'resolve', '--collection=Primitives', 'space/md', url,
  ], { adapter: 'mcp' });
  assert.equal(plan.allowed, true);
  assert.equal(plan.id, 'var.resolve');
  assert.equal(plan.execution.retry, 'safe-read');
  assert.equal(plan.target.fileKey, 'FILEA');
  assert.deepEqual(plan.argv,
    ['var', 'resolve', 'space/md', '12:34', '--collection', 'Primitives']);
  assert.equal(variableResolutionPlanRoute(plan), 'command-application');

  const serialized = await captured({
    variable: 'space/md', nodeId: '12:34', collection: 'Primitives',
  });
  assert.equal((await executeVariableResolutionPlan(plan, {
    evaluate: async () => serialized,
  })).result.consumer.id, '12:34');
  await assert.rejects(() => executeVariableResolutionPlan({ ...plan }, {
    evaluate: async () => serialized,
  }), /requires a Command Plan created by the Capability Catalog/);
  assert.equal(variableResolutionPlanRoute(planFigmaCommand(['var', 'show', 'space/md'])),
    'not-variable-resolution');

  const payloadUrl = 'https://www.figma.com/design/FILEB/Doc?node-id=98-76';
  const payloadPlan = planFigmaCommand(['var', 'resolve', payloadUrl, '12:34']);
  assert.equal(payloadPlan.target.source, 'implicit-single-window');
});
