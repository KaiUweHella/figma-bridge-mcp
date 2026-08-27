import assert from 'node:assert/strict';
import test from 'node:test';
import { planFigmaCommand } from '../../src/capability-catalog.js';
import { MAX_PROTOCOL_VALUE_BYTES } from '../src/lib/protocol-contract.js';
import {
  executeNodeBindings,
  executeNodeBindingsPlan,
  formatNodeBindingsResult,
  MAX_NODE_BINDING_FACTS,
  MAX_NODE_BINDING_LABEL_CODE_UNITS,
  MAX_NODE_BINDING_RESOURCES,
  NODE_BINDING_LOOKUP_TIMEOUT_MS,
  nodeBindingsCode,
  nodeBindingsPlanRoute,
  nodeBindingsPlanningArgvFromRequest,
} from '../src/application/node-bindings-command.js';
import {
  acceptsNodeBindingsArgv,
  nodeBindingsArgvFromRequest,
  parseNodeBindingsRequest,
} from '../src/application/node-bindings-request.js';
import {
  executeTypedReadOperation,
  NODE_BINDINGS_TYPED_READ,
} from '../src/lib/typed-read-operations.js';

const alias = (id) => ({ type: 'VARIABLE_ALIAS', id });

test('Node Bindings request closes and canonicalizes optional node and JSON output', () => {
  assert.deepEqual(parseNodeBindingsRequest(['node', 'bindings']), {
    nodeId: null, json: false, warning: '',
  });
  assert.deepEqual(parseNodeBindingsRequest(['node', 'bindings', '--json', '12-34']), {
    nodeId: '12:34', json: true, warning: '',
  });
  assert.deepEqual(nodeBindingsArgvFromRequest({ nodeId: '12-34', json: true }),
    ['node', 'bindings', '12:34', '--json']);
  for (const argv of [
    ['node', 'bindings', '1:2', '3:4'],
    ['node', 'bindings', '--future'],
    ['node', 'bindings', '--json', '--json'],
    ['node', 'bindings', 'not-a-node'],
  ]) assert.equal(acceptsNodeBindingsArgv(argv), false, argv.join(' '));
});

test('Node Binding Facts preserve scalar, array and component-property topology', async () => {
  const variables = {
    'VariableID:1': {
      id: 'VariableID:1', name: 'space/12px', resolvedType: 'FLOAT',
      variableCollectionId: 'VariableCollectionId:1',
    },
    'VariableID:2': {
      id: 'VariableID:2', name: 'color/surface', resolvedType: 'COLOR',
      variableCollectionId: 'VariableCollectionId:1',
    },
    'VariableID:3': {
      id: 'VariableID:3', name: 'color/accent', resolvedType: 'COLOR',
      variableCollectionId: 'VariableCollectionId:2',
    },
    'VariableID:4': {
      id: 'VariableID:4', name: 'state/default', resolvedType: 'STRING',
      variableCollectionId: 'VariableCollectionId:2',
    },
  };
  const collections = {
    'VariableCollectionId:1': { id: 'VariableCollectionId:1', name: 'Tokens' },
    'VariableCollectionId:2': { id: 'VariableCollectionId:2', name: 'Theme\u202e' },
  };
  const node = {
    id: '1:2', name: 'Card\nInjected', type: 'FRAME',
    boundVariables: {
      itemSpacing: alias('VariableID:1'),
      fills: [alias('VariableID:2'), null, alias('VariableID:3')],
      componentProperties: { State: alias('VariableID:4') },
    },
  };
  const figma = {
    currentPage: { selection: [node] },
    getNodeByIdAsync: async (id) => (id === node.id ? node : null),
    variables: {
      getVariableByIdAsync: async (id) => variables[id] || null,
      getVariableCollectionByIdAsync: async (id) => collections[id] || null,
    },
  };
  const result = await new Function('figma', `return ${nodeBindingsCode({ nodeId: node.id })};`)(figma);
  const typedResult = JSON.parse(await executeTypedReadOperation(
    figma,
    NODE_BINDINGS_TYPED_READ,
    { nodeId: node.id },
  ));
  assert.deepEqual(typedResult, result, 'closed typed-read and legacy fallback must project identical facts');
  assert.deepEqual(result.nodes[0].bindings.map(({ field, index, propertyName }) => ({
    field, index, propertyName,
  })), [
    { field: 'itemSpacing', index: null, propertyName: null },
    { field: 'fills', index: 0, propertyName: null },
    { field: 'fills', index: 2, propertyName: null },
    { field: 'componentProperties', index: null, propertyName: 'State' },
  ]);
  assert.equal(result.nodes[0].name, 'Card Injected');
  assert.equal(result.nodes[0].bindings[2].variable.collection.name, 'Theme ');
  const text = formatNodeBindingsResult(result);
  assert.match(text, /itemSpacing: space\/12px \[Tokens\] · FLOAT/);
  assert.match(text, /fills\.2: color\/accent \[Theme \] · COLOR/);
  assert.match(text, /componentProperties\["State"\]: state\/default/);
  assert.deepEqual(JSON.parse(formatNodeBindingsResult(result, { json: true })), result);
});

test('Node Binding Facts resolve local aliases from one bounded catalog before exact remote lookup', async () => {
  const node = {
    id: '1:2', name: 'Local binding fixture', type: 'TEXT',
    boundVariables: { fontSize: [alias('VariableID:local')] },
  };
  let directVariableLookups = 0;
  let directCollectionLookups = 0;
  const figma = {
    currentPage: { selection: [] },
    getNodeByIdAsync: async () => node,
    variables: {
      getLocalVariablesAsync: async () => [{
        id: 'VariableID:local', name: 'type/size', resolvedType: 'FLOAT', remote: false,
        variableCollectionId: 'VariableCollectionId:local',
      }],
      getLocalVariableCollectionsAsync: async () => [{
        id: 'VariableCollectionId:local', name: 'Local tokens', remote: false,
      }],
      getVariableByIdAsync: async () => {
        directVariableLookups++;
        throw new Error('direct lookup unavailable');
      },
      getVariableCollectionByIdAsync: async () => {
        directCollectionLookups++;
        throw new Error('direct lookup unavailable');
      },
    },
  };

  const result = await new Function('figma',
    `return ${nodeBindingsCode({ nodeId: node.id })};`)(figma);

  assert.equal(result.nodes[0].bindings[0].variable.resolved, true);
  assert.equal(result.nodes[0].bindings[0].variable.name, 'type/size');
  assert.equal(result.nodes[0].bindings[0].variable.collection.name, 'Local tokens');
  assert.equal(directVariableLookups, 0);
  assert.equal(directCollectionLookups, 0);
});

test('Node Binding Facts keep an unavailable non-local alias explicit and unresolved', async () => {
  const node = {
    id: '1:2', name: 'Remote binding fixture', type: 'FRAME',
    boundVariables: { itemSpacing: alias('VariableID:remote') },
  };
  const figma = {
    currentPage: { selection: [] },
    getNodeByIdAsync: async () => node,
    variables: {
      getLocalVariablesAsync: async () => [],
      getLocalVariableCollectionsAsync: async () => [],
      getVariableByIdAsync: async () => { throw new Error('remote lookup unavailable'); },
      getVariableCollectionByIdAsync: async () => { throw new Error('remote lookup unavailable'); },
    },
  };

  const result = await new Function('figma',
    `return ${nodeBindingsCode({ nodeId: node.id })};`)(figma);
  assert.deepEqual(result.nodes[0].bindings[0].variable, {
    id: 'VariableID:remote', name: null, resolvedType: null, collection: null, resolved: false,
  });
});

test('Node Binding Facts reject an oversized local resource catalog', async () => {
  const node = {
    id: '1:2', name: 'Bounded fixture', type: 'FRAME',
    boundVariables: { itemSpacing: alias('VariableID:1') },
  };
  const figma = {
    currentPage: { selection: [] },
    getNodeByIdAsync: async () => node,
    variables: {
      getLocalVariablesAsync: async () => Array(MAX_NODE_BINDING_RESOURCES + 1).fill(null),
      getVariableByIdAsync: async () => null,
    },
  };

  await assert.rejects(
    () => new Function('figma', `return ${nodeBindingsCode({ nodeId: node.id })};`)(figma),
    /local Variable catalog exceeds the bounded Node Binding Facts contract/,
  );
});

test('Node Bindings preserve empty selection and reject missing explicit nodes', async () => {
  const emptyFigma = {
    currentPage: { selection: [] },
    getNodeByIdAsync: async () => null,
    variables: { getVariableByIdAsync: async () => null },
  };
  const selection = await new Function('figma',
    `return ${nodeBindingsCode({ nodeId: null })};`)(emptyFigma);
  assert.equal(formatNodeBindingsResult(selection), 'No node selected');
  await assert.rejects(
    () => new Function('figma', `return ${nodeBindingsCode({ nodeId: '9:9' })};`)(emptyFigma),
    /Node not found in the targeted Figma document/,
  );
});

test('Node Bindings keep an in-Plugin lookup deadline below the transport deadline', () => {
  assert.ok(NODE_BINDING_LOOKUP_TIMEOUT_MS > 0);
  assert.ok(NODE_BINDING_LOOKUP_TIMEOUT_MS < 10_000);
  const code = nodeBindingsCode({ nodeId: '9:9' });
  assert.match(code, /Promise\.race/);
  assert.match(code, /Figma node lookup timed out before the bounded read/);
  assert.match(code, /clearTimeout\(timeoutHandle\)/);
});

test('Node Bindings reject malformed or oversized Plugin results', async () => {
  const base = { schemaVersion: 1, source: 'selection', nodes: [] };
  await assert.rejects(
    () => executeNodeBindings({}, { evaluate: async () => ({ ...base, source: 'private-value' }) }),
    /invalid bounded result/,
  );
  await assert.rejects(
    () => executeNodeBindings({ json: true }, {
      evaluate: async () => ({ ...base, privatePayload: 'must-not-cross-the-boundary' }),
    }),
    /invalid bounded result/,
  );
  const binding = {
    field: 'fills', index: 0, propertyName: null,
    variable: {
      id: 'VariableID:1', name: 'color/surface', resolvedType: 'COLOR',
      collection: null, resolved: true,
    },
  };
  await assert.rejects(
    () => executeNodeBindings({}, { evaluate: async () => ({
      schemaVersion: 1,
      source: 'selection',
      nodes: [{
        id: '1:2', name: 'Node', type: 'FRAME',
        bindings: Array(MAX_NODE_BINDING_FACTS + 1).fill(binding),
      }],
    }) }),
    /invalid bounded result/,
  );
  assert.ok(
    MAX_NODE_BINDING_FACTS * (128 + 512 * 5 + 64) * 4
      + 128 * (96 + MAX_NODE_BINDING_LABEL_CODE_UNITS + 64) * 4
      + 128_000 < MAX_PROTOCOL_VALUE_BYTES,
    'worst-case UTF-8 plus structured framing must remain below the Plugin value cap',
  );
});

test('Node Bindings Plan route accepts only its authentic safe-read Plan', async () => {
  const plan = planFigmaCommand(['node', 'bindings', '1-2', '--json'], { adapter: 'cli' });
  assert.equal(plan.allowed, true);
  assert.equal(plan.execution.retry, 'safe-read');
  assert.equal(plan.execution.pluginDispatch, 'typed-read');
  assert.equal(nodeBindingsPlanRoute(plan), 'command-application');
  assert.deepEqual(plan.argv, ['node', 'bindings', '1:2', '--json']);
  const result = { schemaVersion: 1, source: 'node', nodes: [{
    id: '1:2', name: 'Card', type: 'FRAME', bindings: [],
  }] };
  assert.deepEqual((await executeNodeBindingsPlan(plan, { evaluate: async () => result })).result, result);
  await assert.rejects(
    () => executeNodeBindingsPlan({ ...plan }, { evaluate: async () => result }),
    /requires a Command Plan created by the Capability Catalog/,
  );
  assert.equal(nodeBindingsPlanRoute(planFigmaCommand(['node', 'css', '1:2'], { adapter: 'mcp' })),
    'not-node-bindings');
});

test('Node Bindings prefers the closed typed-read Adapter with bounded eval fallback', async () => {
  const result = { schemaVersion: 1, source: 'node', nodes: [{
    id: '1:2', name: 'Card', type: 'FRAME', bindings: [],
  }] };
  const calls = [];
  const projected = await executeNodeBindings({ nodeId: '1:2', json: true }, {
    typedRead: async (operation, request, fallbackCode) => {
      calls.push({ operation, request, fallbackCode });
      return JSON.stringify(result);
    },
    evaluate: async () => { throw new Error('must not use eval when typed-read is available'); },
  });
  assert.deepEqual(projected.result, result);
  assert.equal(calls[0].operation, 'node-bindings-v1');
  assert.deepEqual(calls[0].request, { nodeId: '1:2' });
  assert.match(calls[0].fallbackCode, /getNodeByIdAsync/);
  assert.doesNotMatch(calls[0].fallbackCode, /nodeBindingsCode/);
});

test('Node Bindings planning keeps option-first URL target separate from canonical argv', () => {
  const url = 'https://www.figma.com/design/FILEA/Binding-Lab?node-id=12-34';
  const planningArgv = nodeBindingsPlanningArgvFromRequest({ nodeId: url, json: true });
  assert.equal(planningArgv[2], url);
  const typed = planFigmaCommand(planningArgv, { adapter: 'mcp' });
  const optionFirst = planFigmaCommand(['node', 'bindings', '--json', url], { adapter: 'mcp' });
  assert.equal(typed.target.fileKey, 'FILEA');
  assert.equal(optionFirst.target.fileKey, 'FILEA');
  assert.deepEqual(optionFirst.argv, ['node', 'bindings', '12:34', '--json']);
});
