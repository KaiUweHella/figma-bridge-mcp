import assert from 'node:assert/strict';
import test from 'node:test';
import { planFigmaCommand } from '../../src/capability-catalog.js';
import {
  executeNodeDiscovery,
  executeNodeDiscoveryPlan,
  MAX_NODE_DISCOVERY_RESULTS,
  MAX_NODE_DISCOVERY_VISITS,
  nodeDiscoveryCode,
  nodeDiscoveryPlanRoute,
} from '../src/application/node-discovery-command.js';
import {
  acceptsNodeDiscoveryArgv,
  nodeDiscoveryArgvFromRequest,
  parseNodeDiscoveryRequest,
} from '../src/application/node-discovery-request.js';

test('Node Discovery request closes and canonicalizes query, type and limit', () => {
  assert.deepEqual(parseNodeDiscoveryRequest(['find', '--type=frame', '-l7', 'Card']), {
    query: 'Card', type: 'FRAME', limit: 7,
  });
  assert.deepEqual(parseNodeDiscoveryRequest(['find', '--', '--help']), {
    query: '--help', type: null, limit: 20,
  });
  assert.deepEqual(nodeDiscoveryArgvFromRequest({ query: 'Card' }),
    ['find', '--limit', '20', 'Card']);
  assert.deepEqual(nodeDiscoveryArgvFromRequest({
    query: '--help', type: 'text', limit: 5,
  }), ['find', '--type', 'TEXT', '--limit', '5', '--', '--help']);

  for (const argv of [
    ['find'],
    ['find', 'One', 'Two'],
    ['find', '--future', 'private-value'],
    ['find', '--type'],
    ['find', '--type', 'FRAME', '-tTEXT', 'Card'],
    ['find', '--type', 'FRAME;globalThis.secret', 'Card'],
    ['find', '--limit', '0', 'Card'],
    ['find', '--limit', String(MAX_NODE_DISCOVERY_RESULTS + 1), 'Card'],
    ['find', '--limit', 'globalThis.secret', 'Card'],
    ['find', '--limit', '1', '-l2', 'Card'],
  ]) assert.equal(acceptsNodeDiscoveryArgv(argv), false, argv.join(' '));
});

test('Node Discovery loads the current page and preserves depth-first partial matching', async () => {
  let loaded = false;
  const currentPage = {
    id: '0:1', type: 'PAGE', name: 'Components',
    async loadAsync() { loaded = true; },
    children: [
      {
        id: '1:1', type: 'FRAME', name: 'Card group', children: [
          { id: '1:2', type: 'TEXT', name: 'Card title', children: [] },
        ],
      },
      { id: '2:1', type: 'FRAME', name: 'Other', children: [] },
    ],
  };
  const figma = { currentPage };
  const value = await new Function('figma', `return ${nodeDiscoveryCode({
    query: 'card', type: null, limit: 20,
  })};`)(figma);
  assert.equal(loaded, true);
  assert.deepEqual(value.matches.map((match) => match.id), ['1:1', '1:2']);
  assert.equal(value.visitedNodes, 4);
  assert.equal(value.limitReached, false);
  assert.equal(value.traversalTruncated, false);
});

test('Node Discovery applies an inert type filter and stops at the result limit', async () => {
  const figma = {
    currentPage: {
      id: '0:1', type: 'PAGE', name: 'Page', async loadAsync() {},
      children: [
        { id: '1:1', type: 'FRAME', name: 'Card one', children: [] },
        { id: '1:2', type: 'TEXT', name: 'Card two', children: [] },
        { id: '1:3', type: 'FRAME', name: 'Card three', children: [] },
      ],
    },
  };
  const value = await new Function('figma', `return ${nodeDiscoveryCode({
    query: 'Card', type: 'FRAME', limit: 1,
  })};`)(figma);
  assert.deepEqual(value.matches, [{
    id: '1:1', type: 'FRAME', name: 'Card one', nameTruncated: false,
  }]);
  assert.equal(value.limitReached, true);
  assert.ok(value.visitedNodes < 4, 'result limit must stop traversal instead of slicing later');
});

test('Node Discovery keeps query text inert in generated Plugin code', async () => {
  let closeCalled = false;
  const figma = {
    closePlugin() { closeCalled = true; },
    currentPage: {
      id: '0:1', type: 'PAGE', name: 'Page', async loadAsync() {}, children: [],
    },
  };
  const query = '");figma.closePlugin();//';
  const value = await new Function('figma', `return ${nodeDiscoveryCode({
    query, type: null, limit: 20,
  })};`)(figma);
  assert.equal(closeCalled, false);
  assert.deepEqual(value.matches, []);
});

test('Node Discovery bounds traversal even when nothing matches', async () => {
  const leaf = { id: '1:1', type: 'RECTANGLE', name: 'No match', children: [] };
  const figma = {
    currentPage: {
      id: '0:1', type: 'PAGE', name: 'Page', async loadAsync() {},
      children: Array(MAX_NODE_DISCOVERY_VISITS).fill(leaf),
    },
  };
  const value = await new Function('figma', `return ${nodeDiscoveryCode({
    query: 'absent', type: null, limit: 20,
  })};`)(figma);
  assert.equal(value.matches.length, 0);
  assert.equal(value.visitedNodes, MAX_NODE_DISCOVERY_VISITS);
  assert.equal(value.traversalTruncated, true);
});

test('Node Discovery validates and control-sanitizes bounded output', async () => {
  const result = await executeNodeDiscovery({ query: 'Card\u202e', type: null, limit: 2 }, {
    evaluate: async () => ({
      schemaVersion: 1,
      matches: [{
        id: '1:2', type: 'TEXT', name: `Card\u001b${'x'.repeat(500)}`, nameTruncated: true,
      }],
      visitedNodes: 4,
      limitReached: false,
      traversalTruncated: false,
    }),
  });
  assert.match(result.stdout, /^1:2 \[TEXT\] Card�/);
  assert.doesNotMatch(result.stdout, /[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/);
  assert.ok(result.stdout.length < 700);

  const noMatch = await executeNodeDiscovery({ query: 'Card\u202e', limit: 2 }, {
    evaluate: async () => ({
      schemaVersion: 1, matches: [], visitedNodes: MAX_NODE_DISCOVERY_VISITS,
      limitReached: false, traversalTruncated: true,
    }),
  });
  assert.match(noMatch.stdout, /No nodes found matching "Card�"/);
  assert.match(noMatch.stdout, /truncated after/);

  await assert.rejects(
    () => executeNodeDiscovery({ query: 'Card' }, {
      evaluate: async () => ({
        schemaVersion: 1,
        matches: Array(MAX_NODE_DISCOVERY_RESULTS + 1).fill({
          id: '1:2', type: 'TEXT', name: 'Card', nameTruncated: false,
        }),
        visitedNodes: 2,
        limitReached: false,
        traversalTruncated: false,
      }),
    }),
    /invalid bounded result/,
  );
});

test('Node Discovery Plan route accepts only its authentic safe-read Plan', async () => {
  const plan = planFigmaCommand(['find', 'Card', '--type=frame', '-l7'], { adapter: 'cli' });
  assert.equal(plan.allowed, true);
  assert.equal(plan.id, 'find');
  assert.equal(plan.execution.retry, 'safe-read');
  assert.deepEqual(plan.argv, ['find', '--type', 'FRAME', '--limit', '7', 'Card']);
  assert.equal(nodeDiscoveryPlanRoute(plan), 'command-application');
  const value = {
    schemaVersion: 1, matches: [], visitedNodes: 1,
    limitReached: false, traversalTruncated: false,
  };
  assert.match((await executeNodeDiscoveryPlan(plan, { evaluate: async () => value })).stdout,
    /No nodes found/);
  await assert.rejects(
    () => executeNodeDiscoveryPlan({ ...plan }, { evaluate: async () => value }),
    /requires a Command Plan created by the Capability Catalog/,
  );
  assert.equal(nodeDiscoveryPlanRoute(planFigmaCommand(['canvas', 'info'])),
    'not-node-discovery');
});

test('Node Discovery resolves policy-identical CLI and MCP Plans', () => {
  const input = ['find', '--type=frame', 'Card', '--limit=25'];
  const cli = planFigmaCommand(input, { adapter: 'cli', fileKey: 'FILEPLACEHOLDER' });
  const mcp = planFigmaCommand(input, { adapter: 'mcp', fileKey: 'FILEPLACEHOLDER' });
  assert.equal(cli.allowed, true);
  assert.equal(mcp.allowed, true);
  const { adapter: _cliAdapter, allowed: _cliAllowed, ...cliPolicy } = cli;
  const { adapter: _mcpAdapter, allowed: _mcpAllowed, ...mcpPolicy } = mcp;
  assert.deepEqual(cliPolicy, mcpPolicy);
});
