import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  executeTokenRebind,
  executeTokenRebindPlan,
  tokenRebindCommandCode,
  tokenRebindPlanRoute,
} from '../src/application/token-rebind-command.js';
import {
  acceptsTokenRebindArgv,
  parseTokenRebindRequest,
  tokenRebindArgvFromRequest,
} from '../src/application/token-rebind-request.js';
import { planFigmaCommand } from '../../src/capability-catalog.js';

function fixture({ failOnce = false, rootType = 'FRAME' } = {}) {
  const sourceColor = { id: 'v1', name: 'color/bg', remote: false,
    variableCollectionId: 'c1', resolvedType: 'COLOR' };
  const targetColor = { id: 'v2', name: 'color/bg', remote: false,
    variableCollectionId: 'c2', resolvedType: 'COLOR' };
  const sourceSpace = { id: 'v3', name: 'space/md', remote: false,
    variableCollectionId: 'c1', resolvedType: 'FLOAT' };
  const targetSpace = { id: 'v4', name: 'space/md', remote: false,
    variableCollectionId: 'c2', resolvedType: 'FLOAT' };
  const variables = new Map([sourceColor, targetColor, sourceSpace, targetSpace]
    .map((variable) => [variable.id, variable]));
  let failed = false;
  let writes = 0;
  const root = {
    id: '1:2', name: 'Card', type: rootType, children: [],
    fills: [{ type: 'SOLID', boundVariables: { color: { id: sourceColor.id } } }],
    strokes: [], boundVariables: { itemSpacing: { id: sourceSpace.id } },
    setBoundVariable(field, variable) {
      writes++; this.boundVariables[field] = { id: variable.id };
      if (failOnce && !failed && variable.id === targetSpace.id) {
        failed = true; throw new Error('setter failed after mutation');
      }
    },
  };
  const figma = {
    currentPage: { children: [root] },
    variables: {
      getLocalVariableCollectionsAsync: async () => [
        { id: 'c1', name: 'Source', remote: false, variableIds: ['v1', 'v3'] },
        { id: 'c2', name: 'Target', remote: false, variableIds: ['v2', 'v4'] },
      ],
      getVariableByIdAsync: async (id) => variables.get(id) || null,
      setBoundVariableForPaint(paint, _field, variable) {
        writes++; return { ...paint, boundVariables: { ...paint.boundVariables,
          color: { id: variable.id } } };
      },
    },
    getNodeByIdAsync: async (id) => id === root.id ? root : null,
  };
  return { figma, root, writes: () => writes };
}

const evaluate = (figma) => async (code) =>
  new Function('figma', `return ${code};`)(figma);

test('closed request canonicalizes node ids and rejects unsafe shapes', () => {
  assert.deepEqual(parseTokenRebindRequest(['tokens', 'rebind', 'Target', '--node', '12-34']), {
    collection: 'Target', nodeId: '12:34', page: false, apply: false,
  });
  assert.deepEqual(tokenRebindArgvFromRequest({ collection: '-Target', page: true }),
    ['tokens', 'rebind', '--page', '--', '-Target']);
  for (const argv of [
    ['tokens', 'rebind', 'Target'],
    ['tokens', 'rebind', 'Target', '--node', '1:2', '--page'],
    ['tokens', 'rebind', 'Target', '--page', '--apply'],
    ['tokens', 'rebind', 'Target', '--wat'],
  ]) assert.equal(acceptsTokenRebindArgv(argv), false, argv.join(' '));
});

test('dry-run and apply share exact targeted resolution but only apply writes', async () => {
  const dry = fixture();
  const request = { collection: 'Target', nodeId: '1:2', apply: false };
  const planned = await executeTokenRebind(request, { evaluate: evaluate(dry.figma) });
  assert.equal(planned.result.status, 'planned');
  assert.equal(planned.result.rebindings, 2);
  assert.equal(dry.writes(), 0);
  assert.equal(dry.root.fills[0].boundVariables.color.id, 'v1');

  const live = fixture();
  const applied = await executeTokenRebind({ ...request, apply: true },
    { evaluate: evaluate(live.figma) });
  assert.equal(applied.result.status, 'applied');
  assert.equal(live.root.fills[0].boundVariables.color.id, 'v2');
  assert.equal(live.root.boundVariables.itemSpacing.id, 'v4');
});

test('a setter that mutates before throwing is fully rolled back', async () => {
  const live = fixture({ failOnce: true });
  const result = await executeTokenRebind({ collection: 'Target', nodeId: '1:2', apply: true },
    { evaluate: evaluate(live.figma) });
  assert.equal(result.result.status, 'rolled-back');
  assert.equal(result.result.rollback.residue, 0);
  assert.equal(live.root.boundVariables.itemSpacing.id, 'v3');
  assert.equal(live.root.fills[0].boundVariables.color.id, 'v1');
});

test('PAGE cannot bypass the page-wide apply gate through --node', async () => {
  const live = fixture({ rootType: 'PAGE' });
  await assert.rejects(() => executeTokenRebind({ collection: 'Target', nodeId: '1:2', apply: true },
    { evaluate: evaluate(live.figma) }), /scoped SceneNode/);
  assert.equal(live.writes(), 0);
});

test('ambiguous Collections and duplicate target Variable names fail before writes', async () => {
  const live = fixture();
  live.figma.variables.getLocalVariableCollectionsAsync = async () => [
    { id: 'c2', name: 'Target One', remote: false, variableIds: [] },
    { id: 'c3', name: 'Target Two', remote: false, variableIds: [] },
  ];
  await assert.rejects(() => executeTokenRebind({ collection: 'Target', nodeId: '1:2' },
    { evaluate: evaluate(live.figma) }), /ambiguous/);
  assert.equal(live.writes(), 0);
});

test('a bound remote source Variable can rebind into the exact local target', async () => {
  const live = fixture();
  const original = live.figma.variables.getVariableByIdAsync;
  live.figma.variables.getVariableByIdAsync = async (id) => {
    const variable = await original(id);
    return id === 'v3' ? { ...variable, remote: true, variableCollectionId: 'remote-source' } : variable;
  };
  const result = await executeTokenRebind({ collection: 'Target', nodeId: '1:2', apply: true },
    { evaluate: evaluate(live.figma) });
  assert.equal(result.result.status, 'applied');
  assert.equal(live.root.boundVariables.itemSpacing.id, 'v4');
});

test('Command Plan routes dry-run as safe-read and apply as non-retrying write', async () => {
  const dry = planFigmaCommand(['tokens', 'rebind', 'Target', '--node', '1:2'], { adapter: 'mcp' });
  const apply = planFigmaCommand(['tokens', 'rebind', 'Target', '--node', '1:2', '--apply'], { adapter: 'cli' });
  assert.equal(dry.effects.figma, 'read');
  assert.equal(dry.execution.retry, 'safe-read');
  assert.equal(apply.effects.figma, 'write');
  assert.equal(apply.execution.retry, 'never');
  assert.equal(tokenRebindPlanRoute(apply), 'command-application');
  const live = fixture();
  assert.equal((await executeTokenRebindPlan(apply, { evaluate: evaluate(live.figma) })).result.status, 'applied');
  assert.match(tokenRebindCommandCode({ collection: 'Target', page: true }), /currentPage\.children/);
});
