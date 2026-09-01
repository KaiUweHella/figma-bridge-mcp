import assert from 'node:assert/strict';
import test from 'node:test';
import {
  BRIDGE_HEALTH_TYPED_READ,
  COMPONENT_PROPERTY_LIST_TYPED_READ,
  executeTypedReadOperation,
  NODE_BINDINGS_TYPED_READ,
  STYLE_CONSUMERS_TYPED_READ,
  TOKEN_OVERLAP_TYPED_READ,
  typedReadRequestValidationError,
} from '../src/lib/typed-read-operations.js';

const consumer = (id) => ({ node: { id, name: `Node ${id}`, type: 'FRAME' }, fields: ['fillStyleId'] });
function figmaFor(consumers = []) {
  const style = {
    id: 'S:1', key: 'KEY', name: 'Surface', type: 'PAINT', remote: false,
    getStyleConsumersAsync: async () => consumers,
  };
  return {
    getStyleByIdAsync: async (id) => id === style.id ? style : null,
    getLocalPaintStylesAsync: async () => [style],
    getLocalTextStylesAsync: async () => [],
    getLocalEffectStylesAsync: async () => [],
    getLocalGridStylesAsync: async () => [],
  };
}

test('typed-read contract accepts only the closed Style Consumer request', () => {
  const request = { style: 'Surface', type: 'PAINT', limit: 2, after: null };
  assert.equal(typedReadRequestValidationError(STYLE_CONSUMERS_TYPED_READ, request), null);
  assert.match(typedReadRequestValidationError('future', request), /unsupported/);
  assert.match(typedReadRequestValidationError(STYLE_CONSUMERS_TYPED_READ, { ...request, code: 'write()' }), /unknown/);
  assert.match(typedReadRequestValidationError(STYLE_CONSUMERS_TYPED_READ, { ...request, limit: 501 }), /1-500/);
});

test('Bridge health is a closed identity-free main-thread read', async () => {
  assert.equal(typedReadRequestValidationError(BRIDGE_HEALTH_TYPED_READ, {}), null);
  assert.match(typedReadRequestValidationError(BRIDGE_HEALTH_TYPED_READ, { code: 'write()' }), /unknown/);
  const serialized = await executeTypedReadOperation(
    { editorType: 'figma', currentPage: { id: '1:2' } },
    BRIDGE_HEALTH_TYPED_READ,
    {},
  );
  assert.deepEqual(JSON.parse(serialized), {
    schemaVersion: 1,
    responsive: true,
    editorType: 'figma',
  });
});

test('typed Style Consumer returns one bounded deterministic page', async () => {
  const request = { style: 'Surface', type: 'PAINT', limit: 1, after: null };
  const serialized = await executeTypedReadOperation(figmaFor([consumer('2:1'), consumer('1:1')]),
    STYLE_CONSUMERS_TYPED_READ, request);
  const result = JSON.parse(serialized);
  assert.deepEqual(result.consumers.map((item) => item.node.id), ['1:1']);
  assert.equal(result.total, 2);
  assert.equal(result.omittedAfter, 1);
  assert.deepEqual(result.nextAnchor, { nodeId: '1:1', fields: ['fillStyleId'] });
});

test('typed Style Consumer rejects malformed native facts before projection', async () => {
  const request = { style: 'S:1', type: null, limit: 10, after: null };
  await assert.rejects(() => executeTypedReadOperation(figmaFor([
    { node: { id: '1:1', name: 'Node', type: 'FRAME' }, fields: ['futureStyleId'] },
  ]), STYLE_CONSUMERS_TYPED_READ, request), /incompatible inherited style field/);
});

test('typed Node Binding Facts accepts only one closed optional Node identity', async () => {
  assert.equal(typedReadRequestValidationError(NODE_BINDINGS_TYPED_READ, { nodeId: null }), null);
  assert.equal(typedReadRequestValidationError(NODE_BINDINGS_TYPED_READ, { nodeId: '12:34' }), null);
  assert.match(
    typedReadRequestValidationError(NODE_BINDINGS_TYPED_READ, { nodeId: '12:34', code: 'write()' }),
    /unknown or missing field/,
  );
  assert.match(
    typedReadRequestValidationError(NODE_BINDINGS_TYPED_READ, { nodeId: 'not-a-node' }),
    /nodeId is invalid/,
  );

  const node = {
    id: '12:34', name: 'Typed fixture', type: 'FRAME',
    boundVariables: { itemSpacing: { type: 'VARIABLE_ALIAS', id: 'VariableID:1' } },
  };
  const serialized = await executeTypedReadOperation({
    currentPage: { selection: [] },
    getNodeByIdAsync: async () => node,
    variables: {
      getLocalVariablesAsync: async () => [{
        id: 'VariableID:1', name: 'space/md', resolvedType: 'FLOAT', remote: false,
        variableCollectionId: 'VariableCollectionId:1',
      }],
      getLocalVariableCollectionsAsync: async () => [{
        id: 'VariableCollectionId:1', name: 'Tokens', remote: false,
      }],
    },
  }, NODE_BINDINGS_TYPED_READ, { nodeId: node.id });
  const result = JSON.parse(serialized);
  assert.equal(result.nodes[0].bindings[0].variable.name, 'space/md');
  assert.equal(result.nodes[0].bindings[0].variable.collection.name, 'Tokens');
});

test('typed Component Property Facts bypass opaque eval and preserve native wiring', async () => {
  assert.equal(typedReadRequestValidationError(
    COMPONENT_PROPERTY_LIST_TYPED_READ, { componentId: '12:34' },
  ), null);
  assert.match(typedReadRequestValidationError(
    COMPONENT_PROPERTY_LIST_TYPED_READ, { componentId: '12:34', code: 'write()' },
  ), /unknown or missing field/);
  const component = {
    id: '12:34', name: 'Typed card', type: 'COMPONENT', remote: false,
    componentPropertyDefinitions: {
      'Title#12:35': { type: 'TEXT', defaultValue: 'Action impacts' },
      'Show trend#12:36': { type: 'BOOLEAN', defaultValue: true },
      'Content#12:39': {
        type: 'SLOT', description: 'Flexible content',
        slotSettings: { minChildren: 0, maxChildren: 3 },
      },
    },
    children: [
      {
        id: '12:37', name: 'Title', type: 'TEXT',
        componentPropertyReferences: { characters: 'Title#12:35' },
      },
      {
        id: '12:38', name: 'Trend', type: 'FRAME', children: [],
        componentPropertyReferences: { visible: 'Show trend#12:36' },
      },
      {
        id: '12:39', name: 'Content', type: 'SLOT', children: [],
        componentPropertyReferences: null, limitViolations: [],
      },
    ],
  };
  const serialized = await executeTypedReadOperation({
    currentPage: { selection: [] },
    getNodeByIdAsync: async (id) => id === component.id ? component : null,
  }, COMPONENT_PROPERTY_LIST_TYPED_READ, { componentId: component.id });
  const result = JSON.parse(serialized);
  assert.deepEqual(result.properties.map((property) => [property.type, property.bindingStatus]), [
    ['TEXT', 'wired'], ['BOOLEAN', 'wired'], ['SLOT', 'native-slot'],
  ]);
  assert.equal(result.properties[2].defaultValue, null);
  assert.deepEqual(result.properties[0].bindings, [{
    nodeId: '12:37', nodeName: 'Title', nodeType: 'TEXT', field: 'characters',
  }]);
});

test('typed Token Overlap accepts only bounded Collection queries and returns exact facts', async () => {
  const request = { queries: ['Alpha', 'Beta'], limit: 20 };
  assert.equal(typedReadRequestValidationError(TOKEN_OVERLAP_TYPED_READ, request), null);
  assert.match(
    typedReadRequestValidationError(TOKEN_OVERLAP_TYPED_READ, { ...request, code: 'write()' }),
    /unknown or missing field/,
  );
  assert.match(
    typedReadRequestValidationError(TOKEN_OVERLAP_TYPED_READ, { queries: ['Alpha'], limit: 20 }),
    /2-32/,
  );
  assert.match(
    typedReadRequestValidationError(TOKEN_OVERLAP_TYPED_READ, { queries: ['Alpha', 'alpha'], limit: 20 }),
    /unique/,
  );

  const collections = [
    { id: 'VariableCollectionId:1', name: 'Alpha', remote: false, variableIds: ['VariableID:1'] },
    { id: 'VariableCollectionId:2', name: 'Beta', remote: false, variableIds: ['VariableID:2'] },
  ];
  const variables = [
    { id: 'VariableID:1', name: 'common', remote: false, variableCollectionId: collections[0].id },
    { id: 'VariableID:2', name: 'common', remote: false, variableCollectionId: collections[1].id },
  ];
  const serialized = await executeTypedReadOperation({ variables: {
    getLocalVariableCollectionsAsync: async () => collections,
    getVariableByIdAsync: async (id) => variables.find((variable) => variable.id === id) || null,
  } }, TOKEN_OVERLAP_TYPED_READ, request);
  const result = JSON.parse(serialized);
  assert.deepEqual(result.commonCore.items, ['common']);
  assert.equal(result.complete, true);
});
