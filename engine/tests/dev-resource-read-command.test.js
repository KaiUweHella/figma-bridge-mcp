import assert from 'node:assert/strict';
import test from 'node:test';
import { planFigmaCommand } from '../../src/capability-catalog.js';
import {
  devResourceReadCode,
  devResourceReadPlanRoute,
  devResourceReadPlanningArgvFromRequest,
  executeDevResourceRead,
  executeDevResourceReadPlan,
  MAX_DEV_RESOURCE_READ_ITEMS,
} from '../src/application/dev-resource-read-command.js';
import {
  acceptsDevResourceReadArgv,
  devResourceReadArgvFromRequest,
  devResourceReadFigmaUrlFileKeyFromArgv,
  parseDevResourceReadRequest,
} from '../src/application/dev-resource-read-request.js';

const RESOURCE = Object.freeze({
  name: 'Storybook',
  url: 'https://example.test/storybook/card',
  nodeId: '1:2',
  inheritedNodeId: null,
});

function payload(overrides = {}) {
  return {
    schemaVersion: 1,
    source: 'node',
    node: { id: '1:2', name: 'Card', type: 'FRAME' },
    resources: [RESOURCE],
    ...overrides,
  };
}

function runtime({ selected = false, resources = [RESOURCE] } = {}) {
  const node = {
    id: '1:2',
    name: 'Card',
    type: 'FRAME',
    getDevResourcesAsync: async () => resources.map((resource) => ({
      ...resource,
      ...(resource.inheritedNodeId === null ? { inheritedNodeId: undefined } : {}),
    })),
  };
  return {
    currentPage: { selection: selected ? [node] : [] },
    getNodeByIdAsync: async (nodeId) => nodeId === node.id ? node : null,
  };
}

test('Dev Resource Read closes optional node references and URL target identity', () => {
  assert.deepEqual(parseDevResourceReadRequest(['dev', 'list']), {
    nodeId: null, warning: '',
  });
  assert.deepEqual(parseDevResourceReadRequest(['dev', 'list', '--', '1-2']), {
    nodeId: '1:2', warning: '',
  });
  assert.deepEqual(devResourceReadArgvFromRequest({ nodeId: '1-2' }), [
    'dev', 'list', '--', '1:2',
  ]);
  for (const argv of [
    ['dev', 'list', '1:2', '1:3'],
    ['dev', 'list', '--future'],
    ['dev', 'list', 'not-a-node'],
  ]) assert.equal(acceptsDevResourceReadArgv(argv), false, argv.join(' '));

  const url = 'https://www.figma.com/design/FILEA/Dev-Lab?node-id=1-2';
  const planning = devResourceReadPlanningArgvFromRequest({ nodeId: url });
  assert.equal(devResourceReadFigmaUrlFileKeyFromArgv(planning), 'FILEA');
  const plan = planFigmaCommand(planning, { adapter: 'mcp' });
  assert.equal(plan.target.fileKey, 'FILEA');
  assert.deepEqual(plan.argv, ['dev', 'list', '--', '1:2']);
});

test('Dev Resource Read projects exact direct and inherited Plugin facts', async () => {
  const resources = [
    RESOURCE,
    {
      name: 'Inherited docs',
      url: 'https://example.test/docs/card',
      nodeId: '1:2',
      inheritedNodeId: '9:8',
    },
  ];
  const result = await executeDevResourceRead({ nodeId: '1:2' }, {
    evaluate: async (code) => new Function('figma', `return ${code};`)(runtime({ resources })),
  });
  assert.deepEqual(result.result.resources, resources);
  assert.equal(result.result.source, 'node');
  assert.equal(result.stdout, [
    'Card (1:2)',
    '  1. Storybook',
    '     https://example.test/storybook/card',
    '  2. Inherited docs',
    '     https://example.test/docs/card',
  ].join('\n'));
});

test('Dev Resource Read owns current-selection semantics without changing output shape', async () => {
  const result = await executeDevResourceRead({ nodeId: null }, {
    evaluate: async (code) => new Function('figma', `return ${code};`)(runtime({ selected: true })),
  });
  assert.equal(result.result.source, 'selection');
  assert.match(result.stdout, /^Card \(1:2\)$/m);

  const empty = await executeDevResourceRead({ nodeId: '1:2' }, {
    evaluate: async (code) => new Function('figma', `return ${code};`)(runtime({ resources: [] })),
  });
  assert.match(empty.stdout, /\(no dev resources\)$/);
});

test('Dev Resource Read fails closed on missing targets and unsupported nodes', async () => {
  await assert.rejects(
    () => new Function('figma', `return ${devResourceReadCode({ nodeId: '9:9' })};`)(runtime()),
    /target was not found/,
  );
  await assert.rejects(
    () => new Function('figma', `return ${devResourceReadCode({ nodeId: null })};`)(runtime()),
    /requires one selected node/,
  );
  await assert.rejects(
    () => new Function('figma', `return ${devResourceReadCode({ nodeId: '1:2' })};`)({
      currentPage: { selection: [] },
      getNodeByIdAsync: async () => ({ id: '1:2', name: 'Page', type: 'PAGE' }),
    }),
    /does not support dev resources/,
  );
});

test('Dev Resource Read rejects malformed, drifting, and unbounded Plugin results', async () => {
  for (const malformed of [
    { ...payload(), privateFutureFact: true },
    payload({ node: { id: '1:3', name: 'Card', type: 'FRAME' } }),
    payload({ resources: [{ ...RESOURCE, privateFutureFact: true }] }),
    payload({ resources: [{ ...RESOURCE, url: '' }] }),
    payload({ resources: Array(MAX_DEV_RESOURCE_READ_ITEMS + 1).fill(RESOURCE) }),
  ]) {
    await assert.rejects(
      () => executeDevResourceRead({ nodeId: '1:2' }, {
        evaluate: async () => JSON.stringify(malformed),
      }),
      /invalid bounded result/,
    );
  }
  await assert.rejects(
    () => executeDevResourceRead({ nodeId: '1:2' }, { evaluate: async () => '{' }),
    (error) => error.phase === 'plugin-response' && error.outcome === 'unknown-after-dispatch',
  );
});

test('Dev Resource Read plans one policy-identical safe-read Application for CLI and MCP', async () => {
  const cli = planFigmaCommand(['dev', 'list', '1-2'], { adapter: 'cli' });
  const mcp = planFigmaCommand(['dev', 'list', '--', '1:2'], { adapter: 'mcp' });
  assert.equal(cli.allowed, true);
  assert.deepEqual(cli.argv, mcp.argv);
  assert.deepEqual(cli.effects, mcp.effects);
  assert.deepEqual(cli.execution, mcp.execution);
  assert.equal(cli.execution.retry, 'safe-read');
  assert.deepEqual(cli.effects, {
    figma: 'read', editor: 'none', workspace: 'none', shared: 'none', network: 'none',
  });
  assert.equal(devResourceReadPlanRoute(cli), 'command-application');
  assert.deepEqual((await executeDevResourceReadPlan(cli, {
    evaluate: async () => JSON.stringify(payload()),
  })).result, payload());

  const selection = planFigmaCommand(['dev', 'list'], { adapter: 'mcp' });
  assert.equal(selection.effects.editor, 'read');
  assert.equal(devResourceReadPlanRoute(
    planFigmaCommand(['dev', 'link', '1:2', 'https://example.test'], { adapter: 'mcp' }),
  ), 'not-dev-resource-read');
});

test('Dev Resource Read generated Plugin code parses', () => {
  assert.doesNotThrow(() => new Function(`return ${devResourceReadCode({ nodeId: '1:2' })}`));
  assert.doesNotThrow(() => new Function(`return ${devResourceReadCode({ nodeId: null })}`));
});
