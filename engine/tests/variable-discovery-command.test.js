import assert from 'node:assert/strict';
import test from 'node:test';
import { planFigmaCommand } from '../../src/capability-catalog.js';
import {
  executeVariableDiscovery,
  executeVariableDiscoveryPlan,
  variableDiscoveryCode,
  variableDiscoveryPlanRoute,
} from '../src/application/variable-discovery-command.js';
import {
  acceptsVariableDiscoveryArgv,
  MAX_VARIABLE_DISCOVERY_RESULTS,
  parseVariableDiscoveryRequest,
  variableDiscoveryArgvFromRequest,
} from '../src/application/variable-discovery-request.js';

const collections = [
  { id: 'VariableCollectionId:2', name: 'Semantic' },
  { id: 'VariableCollectionId:1', name: 'Primitives' },
];

const variables = [
  { id: 'VariableID:2', name: 'space/12px', resolvedType: 'FLOAT', variableCollectionId: collections[0].id },
  { id: 'VariableID:1', name: 'space/12px', resolvedType: 'FLOAT', variableCollectionId: collections[1].id },
  { id: 'VariableID:3', name: 'color/brand', resolvedType: 'COLOR', variableCollectionId: collections[1].id },
];

async function pluginResult(request, variableValues = variables, collectionValues = collections) {
  const figma = { variables: {
    async getLocalVariablesAsync() { return variableValues; },
    async getLocalVariableCollectionsAsync() { return collectionValues; },
  } };
  return new Function('figma', `return ${variableDiscoveryCode(request)};`)(figma);
}

test('Variable Discovery request closes and canonicalizes list and wildcard find', () => {
  assert.deepEqual(parseVariableDiscoveryRequest(['var', 'list']), {
    action: 'list', pattern: null, limit: 500, json: false,
  });
  assert.deepEqual(parseVariableDiscoveryRequest(['var', 'find', '--json', '-l2', '--', '--space*']), {
    action: 'find', pattern: '--space*', limit: 2, json: true,
  });
  assert.deepEqual(variableDiscoveryArgvFromRequest({ action: 'find', pattern: 'space/*' }),
    ['var', 'find', '--limit', '500', 'space/*']);
  assert.deepEqual(variableDiscoveryArgvFromRequest({ action: 'list', json: true, limit: 3 }),
    ['var', 'list', '--limit', '3', '--json']);
  for (const argv of [
    ['var', 'find'],
    ['var', 'find', 'one', 'two'],
    ['var', 'list', 'payload'],
    ['var', 'list', '--limit', '0'],
    ['var', 'list', '--limit', String(MAX_VARIABLE_DISCOVERY_RESULTS + 1)],
    ['var', 'find', '--future', 'value'],
    ['var', 'find', '--limit', '1', '-l2', 'space'],
    ['var', 'find', '--json', '--json', 'space'],
  ]) assert.equal(acceptsVariableDiscoveryArgv(argv), false, argv.join(' '));
});

test('Variable Discovery returns deterministic bounded identity while preserving legacy text', async () => {
  const serialized = await pluginResult({ action: 'find', pattern: 'space/*', limit: 10 });
  const result = await executeVariableDiscovery({ action: 'find', pattern: 'space/*', limit: 10 }, {
    evaluate: async () => serialized,
  });
  assert.equal(result.stdout, 'space/12px\nspace/12px');
  assert.deepEqual(result.result.variables.map((variable) => variable.collection.name),
    ['Primitives', 'Semantic']);
  assert.equal(result.result.complete, true);

  const listSerialized = await pluginResult({ action: 'list', pattern: null, limit: 2 });
  const list = await executeVariableDiscovery({ action: 'list', limit: 2 }, {
    evaluate: async () => listSerialized,
  });
  assert.match(list.stdout, /^color\/brand \(COLOR\)\nspace\/12px \(FLOAT\)/);
  assert.match(list.stdout, /1 more variable\(s\) omitted/);
  assert.equal(list.result.total, 3);
  assert.equal(list.result.complete, false);
});

test('Variable Discovery treats regex syntax as text and keeps generated input inert', async () => {
  const literal = await pluginResult({ action: 'find', pattern: 'color/(brand)', limit: 10 }, [
    { ...variables[2], name: 'color/(brand)' },
    { ...variables[0], id: 'VariableID:4', name: 'color/brand' },
  ]);
  assert.deepEqual(JSON.parse(literal).variables.map((variable) => variable.name), ['color/(brand)']);
  const payload = '");figma.closePlugin();//*';
  const code = variableDiscoveryCode({ action: 'find', pattern: payload, limit: 10 });
  assert.doesNotThrow(() => new Function('figma', `return ${code};`));
  assert.doesNotMatch(code, /new RegExp/);
  assert.doesNotMatch(code, /figma\.closePlugin\(\);\/\/\*';/);
});

test('Variable Discovery validates closed Plugin results and exposes safe JSON', async () => {
  const serialized = await pluginResult({ action: 'list', pattern: null, limit: 10 }, [
    { ...variables[2], name: 'color\u202ebrand' },
  ]);
  const result = await executeVariableDiscovery({ action: 'list', limit: 10, json: true }, {
    evaluate: async () => serialized,
  });
  assert.match(result.stdout, /\\u202e/);
  assert.doesNotMatch(result.stdout, /\u202e/);
  const payload = JSON.parse(serialized);
  for (const malformed of [
    { ...payload, future: true },
    { ...payload, total: payload.total + 1 },
    { ...payload, variables: [{ ...payload.variables[0], resolvedType: 'FUTURE' }] },
    { ...payload, variables: [{ ...payload.variables[0], collection: { name: 'Missing id' } }] },
  ]) {
    await assert.rejects(() => executeVariableDiscovery({ action: 'list', limit: 10 }, {
      evaluate: async () => JSON.stringify(malformed),
    }), /invalid bounded result/);
  }
});

test('Variable Discovery Plans are safe-read and authentic across CLI and MCP', async () => {
  const cli = planFigmaCommand(['var', 'find', 'space/*', '--limit', '2'], { adapter: 'cli' });
  const mcp = planFigmaCommand(['var', 'find', '-l2', '--', 'space/*'], { adapter: 'mcp' });
  assert.deepEqual(cli.argv, mcp.argv);
  assert.deepEqual(cli.effects, mcp.effects);
  assert.deepEqual(cli.execution, mcp.execution);
  assert.equal(cli.execution.retry, 'safe-read');
  assert.equal(variableDiscoveryPlanRoute(cli), 'command-application');
  const serialized = await pluginResult({ action: 'find', pattern: 'space/*', limit: 2 });
  assert.equal((await executeVariableDiscoveryPlan(cli, {
    evaluate: async () => serialized,
  })).result.returned, 2);
  await assert.rejects(() => executeVariableDiscoveryPlan({ ...cli }, {
    evaluate: async () => serialized,
  }), /requires a Command Plan created by the Capability Catalog/);
  assert.equal(variableDiscoveryPlanRoute(
    planFigmaCommand(['var', 'show', 'space/12px'], { adapter: 'mcp' }),
  ), 'not-variable-discovery');
});
