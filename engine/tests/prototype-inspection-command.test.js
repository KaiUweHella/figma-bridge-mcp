import assert from 'node:assert/strict';
import test from 'node:test';
import { planFigmaCommand } from '../../src/capability-catalog.js';
import {
  executePrototypeInspection,
  executePrototypeInspectionPlan,
  MAX_PROTOTYPE_INSPECTION_CONTAINER_ENTRIES,
  MAX_PROTOTYPE_INSPECTION_DEPTH,
  MAX_PROTOTYPE_INSPECTION_STRING_CODE_UNITS,
  prototypeInspectionCode,
  prototypeInspectionPlanRoute,
} from '../src/application/prototype-inspection-command.js';
import {
  acceptsPrototypeInspectionArgv,
  parsePrototypeInspectionRequest,
  prototypeInspectionArgvFromRequest,
  prototypeInspectionPlanningArgvFromRequest,
} from '../src/application/prototype-inspection-request.js';

const FILE_URL = 'https://www.figma.com/design/FILEA/Prototype-Lab?node-id=12-34';

function fixture(reactions = []) {
  const node = {
    id: '12:34', name: 'Prototype Frame', type: 'FRAME', reactions,
    async setReactionsAsync() {},
  };
  return { node, figma: { getNodeByIdAsync: async (id) => id === node.id ? node : null } };
}

test('Prototype Inspection request closes and canonicalizes one Node Reference', () => {
  assert.deepEqual(parsePrototypeInspectionRequest(['prototype', 'inspect', '12-34']), {
    nodeId: '12:34', warning: '',
  });
  assert.deepEqual(prototypeInspectionArgvFromRequest({ nodeId: FILE_URL }),
    ['prototype', 'inspect', '12:34']);
  assert.deepEqual(prototypeInspectionPlanningArgvFromRequest({ nodeId: FILE_URL }),
    ['prototype', 'inspect', FILE_URL]);

  for (const argv of [
    ['prototype', 'inspect'],
    ['prototype', 'inspect', '12:34', '56:78'],
    ['prototype', 'inspect', '--future', 'private-value'],
    ['prototype', 'inspect', 'not-a-node'],
  ]) assert.equal(acceptsPrototypeInspectionArgv(argv), false, argv.join(' '));
});

test('Prototype Inspection preserves exact nested reaction and action facts', async () => {
  const reactions = [{
    trigger: { type: 'ON_CLICK' },
    actions: [{
      type: 'CONDITIONAL',
      conditionalBlocks: [{
        condition: { type: 'EXPRESSION', expression: { type: 'VARIABLE_ALIAS', id: 'V:1' } },
        actions: [{
          type: 'NODE', destinationId: '20:30', navigation: 'NAVIGATE',
          transition: { type: 'SMART_ANIMATE', duration: 0.3, easing: { type: 'EASE_IN_AND_OUT' } },
        }],
      }],
    }],
  }];
  const { figma } = fixture(reactions);
  const serialized = await new Function('figma', `return ${prototypeInspectionCode({
    nodeId: '12:34',
  })};`)(figma);
  assert.equal(typeof serialized, 'string');
  const result = await executePrototypeInspection({ nodeId: '12:34' }, {
    evaluate: async () => serialized,
  });
  assert.deepEqual(result.result.reactions, reactions);
  assert.deepEqual(JSON.parse(result.stdout).reactions, reactions);
  assert.deepEqual(JSON.parse(result.stdout), {
    id: '12:34', name: 'Prototype Frame', type: 'FRAME', reactions,
  });
});

test('Prototype Inspection escapes terminal controls without changing JSON facts', async () => {
  const payload = JSON.stringify({
    schemaVersion: 1,
    id: '12:34',
    name: 'Frame\u202eName',
    type: 'FRAME',
    reactions: [{ trigger: { type: 'ON_CLICK' }, actions: [] }],
  });
  const result = await executePrototypeInspection({ nodeId: '12:34' }, {
    evaluate: async () => payload,
  });
  assert.doesNotMatch(result.stdout, /\u202e/);
  assert.match(result.stdout, /\\u202e/);
  assert.equal(JSON.parse(result.stdout).name, 'Frame\u202eName');
});

test('Prototype Inspection rejects excessive depth before returning partial facts', async () => {
  let nested = { type: 'BACK' };
  for (let index = 0; index <= MAX_PROTOTYPE_INSPECTION_DEPTH; index++) {
    nested = { nested };
  }
  const { figma } = fixture([{ trigger: { type: 'ON_CLICK' }, actions: [nested] }]);
  await assert.rejects(
    () => new Function('figma', `return ${prototypeInspectionCode({ nodeId: '12:34' })};`)(figma),
    /depth limit/,
  );
});

test('Prototype Inspection rejects excessive collections, strings, size and cycles exactly', async () => {
  const oversizedCollection = fixture(Array.from(
    { length: MAX_PROTOTYPE_INSPECTION_CONTAINER_ENTRIES + 1 },
    () => ({ trigger: null, actions: [] }),
  ));
  await assert.rejects(
    () => new Function('figma', `return ${prototypeInspectionCode({ nodeId: '12:34' })};`)(oversizedCollection.figma),
    /array limit/,
  );

  const oversizedString = fixture([{
    trigger: { type: 'ON_CLICK' },
    actions: [{ type: 'URL', url: 'x'.repeat(MAX_PROTOTYPE_INSPECTION_STRING_CODE_UNITS + 1) }],
  }]);
  await assert.rejects(
    () => new Function('figma', `return ${prototypeInspectionCode({ nodeId: '12:34' })};`)(oversizedString.figma),
    /string limit/,
  );

  const serializedSize = fixture([{
    trigger: { type: 'ON_CLICK' },
    actions: Array.from({ length: 8 }, (_, index) => ({
      type: 'URL', url: `${index}${'x'.repeat(MAX_PROTOTYPE_INSPECTION_STRING_CODE_UNITS - 1)}`,
    })),
  }]);
  await assert.rejects(
    () => new Function('figma', `return ${prototypeInspectionCode({ nodeId: '12:34' })};`)(serializedSize.figma),
    /serialized-size limit/,
  );

  const cyclicReaction = { trigger: { type: 'ON_CLICK' }, actions: [] };
  cyclicReaction.self = cyclicReaction;
  const cyclic = fixture([cyclicReaction]);
  await assert.rejects(
    () => new Function('figma', `return ${prototypeInspectionCode({ nodeId: '12:34' })};`)(cyclic.figma),
    /cycle/,
  );
});

test('Prototype Inspection rejects malformed or non-exact Plugin results', async () => {
  for (const value of [
    { schemaVersion: 1, id: '12:34', name: 'Frame', type: 'FRAME', reactions: [] },
    JSON.stringify({ schemaVersion: 2, id: '12:34', name: 'Frame', type: 'FRAME', reactions: [] }),
    JSON.stringify({ schemaVersion: 1, id: '', name: 'Frame', type: 'FRAME', reactions: [] }),
    JSON.stringify({ schemaVersion: 1, id: '12:34', name: 'Frame', type: 'FRAME', reactions: [undefined] }),
  ]) {
    await assert.rejects(
      () => executePrototypeInspection({ nodeId: '12:34' }, { evaluate: async () => value }),
      /invalid bounded result/,
    );
  }
});

test('Prototype Inspection Plan route accepts only its authentic safe-read Plan', async () => {
  const plan = planFigmaCommand(['prototype', 'inspect', '12-34'], { adapter: 'cli' });
  assert.equal(plan.allowed, true);
  assert.equal(plan.id, 'prototype.inspect');
  assert.equal(plan.execution.retry, 'safe-read');
  assert.deepEqual(plan.argv, ['prototype', 'inspect', '12:34']);
  assert.equal(prototypeInspectionPlanRoute(plan), 'command-application');

  const payload = JSON.stringify({
    schemaVersion: 1, id: '12:34', name: 'Frame', type: 'FRAME', reactions: [],
  });
  assert.deepEqual((await executePrototypeInspectionPlan(plan, {
    evaluate: async () => payload,
  })).result.reactions, []);
  await assert.rejects(
    () => executePrototypeInspectionPlan({ ...plan }, { evaluate: async () => payload }),
    /requires a Command Plan created by the Capability Catalog/,
  );
  assert.equal(prototypeInspectionPlanRoute(planFigmaCommand(['prototype', 'clear', '12:34'])),
    'not-prototype-inspection');
});

test('Prototype Inspection resolves URL-targeted policy-identical CLI and MCP Plans', () => {
  const planning = prototypeInspectionPlanningArgvFromRequest({ nodeId: FILE_URL });
  const cli = planFigmaCommand(planning, { adapter: 'cli' });
  const mcp = planFigmaCommand(planning, { adapter: 'mcp' });
  assert.equal(cli.allowed, true);
  assert.equal(mcp.allowed, true);
  assert.equal(mcp.target.fileKey, 'FILEA');
  assert.equal(mcp.target.source, 'figma-url');
  assert.deepEqual(mcp.argv, ['prototype', 'inspect', '12:34']);
  const { adapter: _cliAdapter, allowed: _cliAllowed, ...cliPolicy } = cli;
  const { adapter: _mcpAdapter, allowed: _mcpAllowed, ...mcpPolicy } = mcp;
  assert.deepEqual(cliPolicy, mcpPolicy);
});
