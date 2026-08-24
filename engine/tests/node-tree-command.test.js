import assert from 'node:assert/strict';
import test from 'node:test';
import { planFigmaCommand } from '../../src/capability-catalog.js';
import { MAX_PROTOCOL_VALUE_BYTES } from '../src/lib/protocol-contract.js';
import {
  executeNodeTree,
  executeNodeTreePlan,
  MAX_NODE_TREE_LINES,
  nodeTreeCode,
  nodeTreePlanRoute,
  nodeTreePlanningArgvFromRequest,
} from '../src/application/node-tree-command.js';
import {
  acceptsNodeTreeArgv,
  nodeTreeArgvFromRequest,
  parseNodeTreeRequest,
} from '../src/application/node-tree-request.js';

const RESULT = {
  schemaVersion: 1,
  lines: [
    'FRAME: Card (320x180) [1:2]',
    '  TEXT: Title (120x24) [1:3] "Hello"',
  ],
  hiddenByDepth: 2,
  outputTruncated: false,
};

test('Node Tree request closes and canonicalizes the complete CLI surface', () => {
  assert.deepEqual(parseNodeTreeRequest(['node', 'tree']), {
    nodeId: null, depth: 3, withIds: false, warning: '',
  });
  assert.deepEqual(parseNodeTreeRequest(['node', 'tree', '--ids', '-d=0', '1-2']), {
    nodeId: '1:2', depth: 0, withIds: true, warning: '',
  });
  assert.deepEqual(nodeTreeArgvFromRequest({ nodeId: '1-2', depth: 5, withIds: true }),
    ['node', 'tree', '1:2', '--depth', '5', '--ids']);
  assert.equal(acceptsNodeTreeArgv(['node', 'tree', '--depth=64']), true);
  for (const argv of [
    ['node', 'tree', '1:2', '3:4'],
    ['node', 'tree', '--future', 'private-value'],
    ['node', 'tree', '--depth'],
    ['node', 'tree', '--depth', '-1'],
    ['node', 'tree', '--depth', '65'],
    ['node', 'tree', 'not-a-node'],
  ]) assert.equal(acceptsNodeTreeArgv(argv), false, argv.join(' '));
});

test('Node Tree Command Application returns bounded truthful output through one evaluate adapter', async () => {
  let code = '';
  const result = await executeNodeTree({ nodeId: '1-2', depth: 3, withIds: true }, {
    evaluate: async (value) => { code = value; return RESULT; },
  });

  assert.match(code, /const targetId = "1:2"/);
  assert.match(code, /getNodeByIdAsync\(targetId\)/);
  assert.match(code, /MAX_LINES/);
  assert.match(result.stdout, /FRAME: Card/);
  assert.match(result.stdout, /2 child\(ren\) hidden by depth limit/);
  assert.deepEqual(result.result, RESULT);
  assert.doesNotThrow(() => new Function(`return ${nodeTreeCode({ nodeId: '1:2', depth: 3, withIds: true })};`));
});

test('Node Tree rejects malformed Plugin results instead of formatting success', async () => {
  await assert.rejects(
    () => executeNodeTree({ depth: 3 }, { evaluate: async () => 'Tree failed: private-value' }),
    /invalid bounded result/,
  );
  await assert.rejects(
    () => executeNodeTree({ depth: 3 }, {
      evaluate: async () => ({ ...RESULT, lines: Array(MAX_NODE_TREE_LINES + 1).fill('x') }),
    }),
    /invalid bounded result/,
  );
});

test('Node Tree runtime sanitizes hostile labels and marks every truncation truthfully', async () => {
  const children = Array.from({ length: MAX_NODE_TREE_LINES }, (_, index) => ({
    id: `2:${index}`,
    type: 'TEXT',
    name: index === 0 ? `Control\u001b\u202e${'x'.repeat(200)}` : `Child ${index}`,
    width: 20,
    height: 10,
    characters: index === 0 ? `first\nsecond\u0000${'y'.repeat(80)}` : 'text',
    children: [],
  }));
  const root = {
    id: '1:2', type: 'FRAME', name: 'Root', width: 320, height: 180, children,
    async loadAsync() {},
  };
  const figma = { currentPage: root, getNodeByIdAsync: async () => root };
  const result = await new Function('figma', `return ${nodeTreeCode({ depth: 1, withIds: true })};`)(figma);

  assert.equal(result.lines.length, MAX_NODE_TREE_LINES);
  assert.equal(result.outputTruncated, true);
  assert.doesNotMatch(result.lines[1], /[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/);
  assert.match(result.lines[1], /…/);
  assert.doesNotMatch(result.lines[1], /……/);
  assert.ok(MAX_NODE_TREE_LINES * 512 * 4 + 64_000 < MAX_PROTOCOL_VALUE_BYTES,
    'worst-case UTF-8 plus JSON framing must remain below the Plugin value cap');
});

test('Node Tree not-found failure is target-neutral and never reflects a document name', async () => {
  const figma = {
    currentPage: null,
    root: { name: 'Private Document Name' },
    getNodeByIdAsync: async () => null,
  };
  await assert.rejects(
    () => new Function('figma', `return ${nodeTreeCode({ nodeId: '1:2', depth: 0 })};`)(figma),
    (error) => {
      assert.match(error.message, /targeted Figma document/);
      assert.doesNotMatch(error.message, /Private Document Name|currently open file/);
      return true;
    },
  );
});

test('Node Tree Plan route accepts only its authentic policy-owned Plan', async () => {
  const plan = planFigmaCommand(['node', 'tree', '1-2', '--ids'], { adapter: 'cli' });
  assert.equal(plan.allowed, true);
  assert.equal(plan.execution.retry, 'safe-read');
  assert.equal(nodeTreePlanRoute(plan), 'command-application');
  assert.deepEqual(plan.argv, ['node', 'tree', '1:2', '--depth', '3', '--ids']);
  const result = await executeNodeTreePlan(plan, { evaluate: async () => RESULT });
  assert.match(result.stdout, /FRAME: Card/);
  await assert.rejects(
    () => executeNodeTreePlan({ ...plan }, { evaluate: async () => RESULT }),
    /requires a Command Plan created by the Capability Catalog/,
  );
  assert.equal(nodeTreePlanRoute(planFigmaCommand(['node', 'bindings'], { adapter: 'mcp' })), 'not-node-tree');
});

test('Node Tree planning keeps URL target identity separate from canonical argv', () => {
  const url = 'https://www.figma.com/design/FILEA/Tree-Lab?node-id=12-34';
  const planningArgv = nodeTreePlanningArgvFromRequest({ nodeId: url, depth: 4, withIds: true });
  assert.equal(planningArgv[2], url);
  const mcp = planFigmaCommand(planningArgv, { adapter: 'mcp' });
  const cli = planFigmaCommand(planningArgv, { adapter: 'cli' });
  assert.equal(mcp.target.fileKey, 'FILEA');
  assert.equal(mcp.target.source, 'figma-url');
  assert.deepEqual(cli.argv, mcp.argv);
  assert.deepEqual(mcp.argv, ['node', 'tree', '12:34', '--depth', '4', '--ids']);

  const optionFirst = planFigmaCommand(['node', 'tree', '--ids', url], { adapter: 'mcp' });
  assert.equal(optionFirst.target.fileKey, 'FILEA');
  assert.deepEqual(optionFirst.argv, ['node', 'tree', '12:34', '--depth', '3', '--ids']);
});
