import { test } from 'node:test';
import assert from 'node:assert/strict';
import { planFigmaCommand } from '../../src/capability-catalog.js';
import {
  MAX_NODE_REFERENCE_CODE_UNITS,
  NodeReferenceError,
  parseNodeReference,
} from '../src/application/node-reference.js';
import {
  nodeTextArgvFromRequest,
  nodeTextPlanningArgvFromRequest,
  parseNodeTextRequest,
} from '../src/application/node-text-request.js';
import {
  nodeTreeArgvFromRequest,
  nodeTreePlanningArgvFromRequest,
  parseNodeTreeRequest,
} from '../src/application/node-tree-request.js';
import {
  nodeCssArgvFromRequest,
  nodeCssPlanningArgvFromRequest,
  parseNodeCssRequest,
} from '../src/application/node-css-request.js';
import {
  nodeBindingsArgvFromRequest,
  nodeBindingsPlanningArgvFromRequest,
  parseNodeBindingsRequest,
} from '../src/application/node-bindings-request.js';
import {
  parsePrototypeInspectionRequest,
  prototypeInspectionArgvFromRequest,
  prototypeInspectionPlanningArgvFromRequest,
} from '../src/application/prototype-inspection-request.js';

const FILE_URL = 'https://www.figma.com/design/FILEA/Reference-Lab?node-id=I12-34%3B56-78';

const commands = [
  {
    name: 'node set-text',
    argv: (nodeId) => ['node', 'set-text', nodeId, 'Hello'],
    request: (nodeId) => ({ nodeId, text: 'Hello' }),
    parse: parseNodeTextRequest,
    canonical: nodeTextArgvFromRequest,
    planning: nodeTextPlanningArgvFromRequest,
    nodeIndex: 2,
  },
  {
    name: 'node tree',
    argv: (nodeId) => ['node', 'tree', nodeId],
    request: (nodeId) => ({ nodeId }),
    parse: parseNodeTreeRequest,
    canonical: nodeTreeArgvFromRequest,
    planning: nodeTreePlanningArgvFromRequest,
    nodeIndex: 2,
  },
  {
    name: 'node css',
    argv: (nodeId) => ['node', 'css', nodeId],
    request: (nodeId) => ({ nodeId }),
    parse: parseNodeCssRequest,
    canonical: nodeCssArgvFromRequest,
    planning: nodeCssPlanningArgvFromRequest,
    nodeIndex: 2,
  },
  {
    name: 'node bindings',
    argv: (nodeId) => ['node', 'bindings', nodeId],
    request: (nodeId) => ({ nodeId }),
    parse: parseNodeBindingsRequest,
    canonical: nodeBindingsArgvFromRequest,
    planning: nodeBindingsPlanningArgvFromRequest,
    nodeIndex: 2,
  },
  {
    name: 'prototype inspect',
    argv: (nodeId) => ['prototype', 'inspect', nodeId],
    request: (nodeId) => ({ nodeId }),
    parse: parsePrototypeInspectionRequest,
    canonical: prototypeInspectionArgvFromRequest,
    planning: prototypeInspectionPlanningArgvFromRequest,
    nodeIndex: 2,
  },
];

test('Node Reference owns canonical identity, URL target facts and planning value', () => {
  assert.deepEqual(parseNodeReference('  12-34  '), {
    nodeId: '12:34', fileKey: null, warning: '', planningValue: '12:34',
  });
  assert.deepEqual(parseNodeReference('I12-34;56-78'), {
    nodeId: 'I12:34;56:78', fileKey: null, warning: '', planningValue: 'I12:34;56:78',
  });
  const url = parseNodeReference(`  ${FILE_URL}  `);
  assert.equal(url.nodeId, 'I12:34;56:78');
  assert.equal(url.fileKey, 'FILEA');
  assert.match(url.warning, /Figma file FILEA/);
  assert.equal(url.planningValue, FILE_URL);
});

test('every migrated request accepts equivalent Node Reference spellings', () => {
  const forms = [
    ['12:34', '12:34'],
    ['12-34', '12:34'],
    ['I12:34;56:78', 'I12:34;56:78'],
    ['I12-34;56-78', 'I12:34;56:78'],
    [FILE_URL, 'I12:34;56:78'],
  ];
  for (const command of commands) {
    for (const [input, expected] of forms) {
      assert.equal(command.parse(command.argv(input)).nodeId, expected, `${command.name}: ${input}`);
      assert.equal(command.canonical(command.request(input))[command.nodeIndex], expected,
        `${command.name} canonical: ${input}`);
    }
  }
});

test('URL target identity stays outside canonical argv for every migrated request', () => {
  for (const command of commands) {
    const request = command.request(FILE_URL);
    assert.equal(command.canonical(request)[command.nodeIndex], 'I12:34;56:78', command.name);
    assert.equal(command.planning(request)[command.nodeIndex], FILE_URL, command.name);
    const plan = planFigmaCommand(command.planning(request), { adapter: 'mcp' });
    assert.equal(plan.allowed, true, command.name);
    assert.equal(plan.target.fileKey, 'FILEA', command.name);
    assert.equal(plan.argv[command.nodeIndex], 'I12:34;56:78', command.name);
  }
});

test('malformed Node References stop in request planning before dispatch', () => {
  const malformed = [
    '',
    'not-a-node',
    'https://www.figma.com/design/FILEA/Reference-Lab',
    `1:${'2'.repeat(MAX_NODE_REFERENCE_CODE_UNITS)}`,
  ];
  for (const command of commands) {
    for (const value of malformed) {
      assert.throws(() => command.parse(command.argv(value)), undefined, `${command.name}: ${value}`);
      assert.throws(() => command.planning(command.request(value)), undefined, `${command.name}: ${value}`);
    }
  }
  assert.throws(() => parseNodeReference(null), (error) => (
    error instanceof NodeReferenceError && error.code === 'type'
  ));
});
