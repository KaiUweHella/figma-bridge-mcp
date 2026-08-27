import { test } from 'node:test';
import assert from 'node:assert/strict';
import { planFigmaCommand } from '../../src/capability-catalog.js';
import {
  executeNodeMove,
  executeNodeMovePlan,
  formatNodeMoveResult,
  nodeMoveArgvFromRequest,
  nodeMoveCode,
  nodeMovePlanningArgvFromRequest,
  nodeMovePlanRoute,
  nodeMoveRequestFromArgv,
} from '../src/application/node-move-command.js';

async function evaluateCode(code, figma) {
  return new Function('figma', `return ${code}`)(figma);
}

function movableNode({ id = '1:2', name = 'Fixture', parentX = 100, parentY = 100 } = {}) {
  return {
    id,
    name,
    type: 'FRAME',
    x: 10,
    y: 20,
    parent: { id: '0:1', type: 'FRAME' },
    get absoluteBoundingBox() {
      return { x: parentX + this.x, y: parentY + this.y, width: 40, height: 30 };
    },
  };
}

test('Node Move parses signed coordinates without confusing unknown options', () => {
  assert.deepEqual(nodeMoveRequestFromArgv(['node', 'move', '1:2', '-3600', '400']), {
    nodeId: '1:2', x: -3600, y: 400, page: null,
  });
  assert.deepEqual(nodeMoveRequestFromArgv([
    'node', 'move', '--page=Review', '12-34', '-12.5', '-2e2',
  ]), {
    nodeId: '12:34', x: -12.5, y: -200, page: 'Review',
  });
  assert.deepEqual(nodeMoveRequestFromArgv([
    'node', 'move', '1:2', '--page', 'Review', '--', '-1', '-2',
  ]), {
    nodeId: '1:2', x: -1, y: -2, page: 'Review',
  });

  for (const args of [
    ['node', 'move', '1:2', '--future', '2', '3'],
    ['node', 'move', '1:2', '--page'],
    ['node', 'move', '1:2', '--page', 'A', '--page', 'B', '1', '2'],
    ['node', 'move', '1:2', 'Infinity', '2'],
    ['node', 'move', '1:2', '1', 'NaN'],
    ['node', 'move', '1:2', '1', '2', 'extra'],
  ]) {
    assert.throws(() => nodeMoveRequestFromArgv(args), /Invalid node move command/, args.join(' '));
  }
  assert.throws(
    () => nodeMoveRequestFromArgv(['node', 'move', '1:2', '--future', '2', '3']),
    /unknown option --future/,
  );
});

test('Node Move canonicalizes CLI and MCP planning input without losing URL targeting', () => {
  const url = 'https://www.figma.com/design/FILEA/Move-Lab?node-id=12-34';
  assert.deepEqual(nodeMoveArgvFromRequest({ nodeId: '12-34', x: -3600, y: 400 }), [
    'node', 'move', '12:34', '--', '-3600', '400',
  ]);
  assert.deepEqual(nodeMovePlanningArgvFromRequest({
    nodeId: url, x: -3600, y: 400, page: 'Review',
  }), [
    'node', 'move', url, '--page', 'Review', '--', '-3600', '400',
  ]);

  const mcp = planFigmaCommand(['node', 'move', url, '-3600', '400'], { adapter: 'mcp' });
  const cli = planFigmaCommand(['node', 'move', url, '-3600', '400'], { adapter: 'cli' });
  assert.equal(mcp.allowed, true);
  assert.equal(cli.allowed, true);
  assert.deepEqual(mcp.argv, ['node', 'move', '12:34', '--', '-3600', '400']);
  assert.deepEqual(cli.argv, mcp.argv);
  assert.equal(mcp.target.fileKey, 'FILEA');
  assert.equal(mcp.effects.figma, 'write');
  assert.equal(mcp.execution.retry, 'never');

  const optionFirst = planFigmaCommand([
    'node', 'move', '--page', 'Review', url, '-10', '20',
  ], { adapter: 'mcp' });
  assert.equal(optionFirst.target.fileKey, 'FILEA');
  assert.deepEqual(optionFirst.argv, [
    'node', 'move', '12:34', '--page', 'Review', '--', '-10', '20',
  ]);
});

test('Node Move applies a nested absolute-canvas target and freshly verifies it', async () => {
  const node = movableNode();
  const result = await executeNodeMove({ nodeId: node.id, x: -50, y: 75 }, {
    evaluate: (code) => evaluateCode(code, {
      getNodeByIdAsync: async () => node,
      root: { children: [] },
    }),
  });

  assert.equal(node.x, -150);
  assert.equal(node.y, -25);
  assert.deepEqual(result, {
    schemaVersion: 1,
    status: 'moved',
    node: { id: '1:2', name: 'Fixture', type: 'FRAME' },
    requested: { x: -50, y: 75, coordinateSpace: 'absolute-canvas' },
    actual: { x: -50, y: 75, coordinateSpace: 'absolute-canvas' },
    page: null,
  });
  assert.match(formatNodeMoveResult(result), /Moved "Fixture" \(1:2\) to -50, 75/);
});

test('Node Move preflights and loads an explicit page before reparenting', async () => {
  const node = movableNode({ parentX: 0, parentY: 0 });
  let loaded = 0;
  const page = {
    id: '0:9', name: 'Review', type: 'PAGE', children: [],
    async loadAsync() { loaded += 1; },
    appendChild(child) { child.parent = this; this.children.push(child); },
  };
  const result = await executeNodeMove({ nodeId: node.id, x: -20, y: 30, page: 'Rev' }, {
    evaluate: (code) => evaluateCode(code, {
      getNodeByIdAsync: async () => node,
      root: { children: [page] },
    }),
  });
  assert.equal(loaded, 1);
  assert.equal(node.parent, page);
  assert.equal(node.x, -20);
  assert.equal(node.y, 30);
  assert.deepEqual(result.page, { id: '0:9', name: 'Review' });
});

test('Node Move refuses mismatched readback and only authentic Plans cross the seam', async () => {
  const stuck = movableNode();
  Object.defineProperty(stuck, 'x', { value: 10, writable: false, configurable: true });
  await assert.rejects(
    () => executeNodeMove({ nodeId: stuck.id, x: 200, y: 220 }, {
      evaluate: (code) => evaluateCode(code, {
        getNodeByIdAsync: async () => stuck,
        root: { children: [] },
      }),
    }),
    /did not reach the requested absolute canvas position/,
  );

  const plan = planFigmaCommand(['node', 'move', '1:2', '-50', '75'], {
    adapter: 'mcp', fileKey: 'FILEA',
  });
  assert.equal(nodeMovePlanRoute(plan), 'command-application');
  assert.equal(nodeMovePlanRoute(planFigmaCommand(['inspect', '1:2'])), 'not-node-move');
  assert.throws(() => nodeMovePlanRoute({ ...plan }), /requires a Command Plan/);
  const node = movableNode();
  let evaluations = 0;
  await executeNodeMovePlan(plan, {
    evaluate: async (code) => {
      evaluations += 1;
      return evaluateCode(code, { getNodeByIdAsync: async () => node, root: { children: [] } });
    },
  });
  assert.equal(evaluations, 1);
});

test('Node Move generated evaluation is injection-safe and bounds returned labels', () => {
  const code = nodeMoveCode({ nodeId: '1:2', x: -1, y: 2, page: '"; globalThis.PWNED = true; //' });
  assert.doesNotThrow(() => new Function('figma', `return ${code}`));
  assert.doesNotMatch(code, /pageQuery = "; globalThis/);
});
