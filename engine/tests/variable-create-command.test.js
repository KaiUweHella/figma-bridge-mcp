import assert from 'node:assert/strict';
import test from 'node:test';
import { planFigmaCommand } from '../../src/capability-catalog.js';
import {
  executeVariableCreate,
  executeVariableCreatePlan,
  variableCreateCode,
  variableCreatePlanRoute,
} from '../src/application/variable-create-command.js';
import {
  acceptsVariableCreateArgv,
  parseVariableCreateRequest,
  variableCreateArgvFromRequest,
} from '../src/application/variable-create-request.js';

function fixture({ existing = [], setFails = false, invalidIdentity = false, removeFails = false } = {}) {
  const collection = {
    id: 'VariableCollectionId:1', key: 'collection-key', name: 'Tokens', remote: false,
    defaultModeId: 'ModeId:default', modes: [{ modeId: 'ModeId:default', name: 'Default' }],
  };
  const created = [];
  const figma = {
    variables: {
      getLocalVariableCollectionsAsync: async () => [collection],
      getLocalVariablesAsync: async () => existing,
      createVariable(name, target, type) {
        let idReads = 0;
        const variable = {
          key: '', name, resolvedType: type, remote: false,
          variableCollectionId: target.id, valuesByMode: {}, removed: false,
          setValueForMode(modeId, value) {
            if (setFails) throw new Error('set failed');
            this.valuesByMode[modeId] = value;
          },
          remove() {
            if (removeFails) throw new Error('remove failed');
            this.removed = true;
          },
        };
        Object.defineProperty(variable, 'id', {
          enumerable: true,
          get() {
            idReads++;
            return invalidIdentity && idReads === 1 ? '' : `VariableID:new:${created.length}`;
          },
        });
        created.push(variable);
        return variable;
      },
    },
  };
  return { collection, created, figma };
}

async function runCode(request, figma) {
  return new Function('figma', `return ${variableCreateCode(request)};`)(figma);
}

test('Variable Create request closes options and canonicalizes every typed value family', () => {
  assert.deepEqual(parseVariableCreateRequest([
    'variables', 'create', '-cTokens', '-tcolor', '-v#abc', '--', '-brand/accent',
  ]), {
    name: '-brand/accent', collection: 'Tokens', type: 'COLOR',
    value: { r: 170 / 255, g: 187 / 255, b: 204 / 255 }, allowDuplicate: false,
  });
  assert.deepEqual(variableCreateArgvFromRequest({
    name: 'motion/standard', collection: 'Tokens', type: 'easing',
    value: { type: 'CUSTOM_SPRING', easingFunctionSpring: { bounce: 0.4 } },
    allowDuplicate: true,
  }), [
    'var', 'create', '--collection', 'Tokens', '--type', 'EASING',
    '--value', '{"type":"CUSTOM_SPRING","easingFunctionSpring":{"bounce":0.4}}',
    '--allow-duplicate', '--', 'motion/standard',
  ]);
  for (const args of [
    ['var', 'create', 'Name'],
    ['var', 'create', '-c', 'Tokens', '-t', 'FUTURE', 'Name'],
    ['var', 'create', '-c', 'Tokens', '-c', 'Other', '-t', 'FLOAT', 'Name'],
    ['var', 'create', '-c', 'Tokens', '-t', 'FLOAT', 'One', 'Two'],
    ['var', 'create', '-c', 'Tokens', '-t', 'EASING', '-v', '{"type":"CUSTOM_SPRING","easingFunctionSpring":{"bounce":2}}', 'Name'],
  ]) assert.equal(acceptsVariableCreateArgv(args), false, args.join(' '));
});

test('Variable Create resolves one exact Collection and preserves intentional duplicate utility', async () => {
  const existing = [{ name: 'space/md', variableCollectionId: 'VariableCollectionId:1' }];
  const blocked = fixture({ existing });
  await assert.rejects(
    () => runCode({ name: 'space/md', collection: 'Tokens', type: 'FLOAT' }, blocked.figma),
    /exact name already exists.*--allow-duplicate/,
  );
  assert.equal(blocked.created.length, 0);

  const allowed = fixture({ existing });
  const serialized = await runCode({
    name: 'space/md', collection: 'Tokens', type: 'FLOAT', value: 12,
    allowDuplicate: true,
  }, allowed.figma);
  const result = await executeVariableCreate({
    name: 'space/md', collection: 'Tokens', type: 'FLOAT', value: 12,
    allowDuplicate: true,
  }, { evaluate: async () => serialized });
  assert.equal(result.stdout, 'Created float variable: space/md');
  assert.equal(result.result.initialValueSet, true);
  assert.equal(result.result.duplicateCountBefore, 1);
  assert.equal(allowed.created[0].valuesByMode['ModeId:default'], 12);
});

test('Variable Create journals before initialization and reports cleanup or bounded residue', async () => {
  const cleaned = fixture({ setFails: true });
  const cleanedPayload = await runCode({
    name: 'space/lg', collection: 'Tokens', type: 'FLOAT', value: 16,
  }, cleaned.figma);
  await assert.rejects(
    () => executeVariableCreate({
      name: 'space/lg', collection: 'Tokens', type: 'FLOAT', value: 16,
    }, { evaluate: async () => cleanedPayload }),
    (error) => error.mutationOutcome === 'rolled-back'
      && error.mutationReport.removed === 1,
  );
  assert.equal(cleaned.created[0].removed, true);

  const residue = fixture({ invalidIdentity: true, removeFails: true });
  const residuePayload = await runCode({
    name: 'space/xl', collection: 'Tokens', type: 'FLOAT',
  }, residue.figma);
  await assert.rejects(
    () => executeVariableCreate({
      name: 'space/xl', collection: 'Tokens', type: 'FLOAT',
    }, { evaluate: async () => residuePayload }),
    (error) => error.mutationOutcome === 'partial-residue'
      && error.mutationReport.residueCount === 1,
  );
});

test('Variable Create rejects malformed results and accepts only authentic non-retrying Plans', async () => {
  await assert.rejects(
    () => executeVariableCreate({
      name: 'space/md', collection: 'Tokens', type: 'FLOAT',
    }, { evaluate: async () => '{}' }),
    /invalid bounded result/,
  );
  const cli = planFigmaCommand([
    'var', 'create', '-c', 'Tokens', '-t', 'FLOAT', '-v', '12', 'space/md',
  ], { adapter: 'cli' });
  const mcp = planFigmaCommand([
    'var', 'create', '--collection=Tokens', '--type=FLOAT', '--value=12', '--', 'space/md',
  ], { adapter: 'mcp' });
  assert.equal(cli.allowed, true);
  assert.equal(mcp.allowed, true);
  assert.deepEqual(cli.argv, mcp.argv);
  assert.equal(cli.execution.retry, 'never');
  assert.equal(cli.confirmation, 'configured');
  assert.equal(variableCreatePlanRoute(cli), 'command-application');
  const { figma } = fixture();
  const serialized = await runCode({
    name: 'space/md', collection: 'Tokens', type: 'FLOAT', value: 12,
  }, figma);
  assert.equal((await executeVariableCreatePlan(cli, {
    evaluate: async () => serialized,
  })).result.variable.name, 'space/md');
  await assert.rejects(
    () => executeVariableCreatePlan({ ...cli }, { evaluate: async () => serialized }),
    /requires a Command Plan created by the Capability Catalog/,
  );
  assert.equal(variableCreatePlanRoute(planFigmaCommand(['var', 'show', 'space/md'])),
    'not-variable-create');
});
