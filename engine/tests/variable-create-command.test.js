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

function fixture({
  existing = [], setFails = false, setIgnored = false, freshIdentityMismatch = false,
  removeFails = false, retainRemovedReadback = false, normalizeValue = (value) => value,
  nativeValuesByMode = {}, collectionModes = null,
} = {}) {
  const modes = collectionModes || [{ modeId: 'ModeId:default', name: 'Default' }];
  const collection = {
    id: 'VariableCollectionId:1', key: 'collection-key', name: 'Tokens', remote: false,
    defaultModeId: 'ModeId:default', modes,
    variableIds: existing.map((variable) => variable.id),
  };
  const created = [];
  const byId = new Map(existing.map((variable) => [variable.id, variable]));
  const figma = {
    variables: {
      getLocalVariableCollectionsAsync: async () => [collection],
      getLocalVariablesAsync: async () => { throw new Error('global Variable scan is forbidden'); },
      getVariableCollectionByIdAsync: async (id) => id === collection.id ? collection : null,
      getVariableByIdAsync: async (id) => {
        const variable = byId.get(id) || null;
        if (!variable || !freshIdentityMismatch || !created.includes(variable)) return variable;
        return { ...variable, name: `${variable.name}-stale` };
      },
      createVariable(name, target, type) {
        const id = `VariableID:new:${created.length}`;
        const variable = {
          id, key: '', name, resolvedType: type, remote: false,
          variableCollectionId: target.id,
          valuesByMode: structuredClone(nativeValuesByMode), removed: false,
          scopes: ['ALL_SCOPES'], hiddenFromPublishing: false,
          setValueForMode(modeId, value) {
            if (setFails) throw new Error('set failed');
            if (!setIgnored) this.valuesByMode[modeId] = normalizeValue(value);
          },
          remove() {
            if (removeFails) throw new Error('remove failed');
            this.removed = true;
            if (!retainRemovedReadback) byId.delete(id);
            target.variableIds = target.variableIds.filter((candidate) => candidate !== id);
          },
        };
        created.push(variable);
        byId.set(id, variable);
        target.variableIds.push(id);
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
  const existing = [{
    id: 'VariableID:existing', name: 'space/md', remote: false,
    variableCollectionId: 'VariableCollectionId:1',
  }];
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

test('Variable Create uses exact Collection membership and fresh normalized value readback', async () => {
  const target = fixture({
    existing: [{
      id: 'VariableID:other', name: 'space/other', remote: false,
      variableCollectionId: 'VariableCollectionId:1',
    }],
    normalizeValue: (value) => typeof value === 'number' ? Math.fround(value) : value,
  });
  const serialized = await runCode({
    name: 'opacity/subtle', collection: 'Tokens', type: 'FLOAT', value: 0.1,
  }, target.figma);
  const payload = JSON.parse(serialized);
  assert.equal(payload.status, 'created');
  assert.equal(payload.duplicateCountBefore, 0);
  assert.equal(target.created[0].valuesByMode['ModeId:default'], Math.fround(0.1));
});

test('Variable Create accepts and reports a native default without treating it as requested intent', async () => {
  const target = fixture({ nativeValuesByMode: { 'ModeId:default': 0 } });
  const serialized = await runCode({
    name: 'space/native', collection: 'Tokens', type: 'FLOAT',
  }, target.figma);
  const result = await executeVariableCreate({
    name: 'space/native', collection: 'Tokens', type: 'FLOAT',
  }, { evaluate: async () => serialized });

  assert.equal(result.result.initialValueSet, false);
  assert.deepEqual(result.result.modeValue, {
    modeId: 'ModeId:default', source: 'native-default', stored: true, value: 0,
  });
  assert.equal(result.result.observedModeCount, 1);
  assert.equal(target.created[0].removed, false);
});

test('Variable Create preserves native defaults for all Variable types and unrelated modes', async () => {
  const defaults = new Map([
    ['BOOLEAN', false],
    ['COLOR', { r: 0, g: 0, b: 0 }],
    ['EASING', { type: 'EASE_IN_AND_OUT' }],
    ['FLOAT', 0],
    ['STRING', ''],
    ['TIMING', 0],
  ]);
  for (const [type, nativeDefault] of defaults) {
    const target = fixture({
      collectionModes: [
        { modeId: 'ModeId:default', name: 'Light' },
        { modeId: 'ModeId:dark', name: 'Dark' },
      ],
      nativeValuesByMode: {
        'ModeId:default': nativeDefault,
        'ModeId:dark': structuredClone(nativeDefault),
      },
    });
    const request = {
      name: `native/${type.toLowerCase()}`, collection: 'Tokens', type,
    };
    const serialized = await runCode(request, target.figma);
    const result = await executeVariableCreate(request, { evaluate: async () => serialized });
    assert.equal(result.result.modeValue.source, 'native-default', type);
    assert.deepEqual(result.result.modeValue.value, nativeDefault, type);
    assert.equal(result.result.observedModeCount, 2, type);
    assert.equal(target.created[0].removed, false, type);
  }
});

test('Variable Create verifies explicit intent while retaining an unrelated native mode default', async () => {
  const target = fixture({
    collectionModes: [
      { modeId: 'ModeId:default', name: 'Light' },
      { modeId: 'ModeId:dark', name: 'Dark' },
    ],
    nativeValuesByMode: { 'ModeId:default': 0, 'ModeId:dark': 0 },
  });
  const request = {
    name: 'space/explicit', collection: 'Tokens', type: 'FLOAT', value: 12,
  };
  const serialized = await runCode(request, target.figma);
  const result = await executeVariableCreate(request, { evaluate: async () => serialized });
  assert.deepEqual(result.result.modeValue, {
    modeId: 'ModeId:default', source: 'requested-initial', stored: true, value: 12,
  });
  assert.equal(result.result.observedModeCount, 2);
  assert.equal(target.created[0].valuesByMode['ModeId:dark'], 0);
});

test('Variable Create accepts Figma canonical parameters for a named EASING preset', async () => {
  const target = fixture({
    normalizeValue: (value) => value?.type === 'GENTLE'
      ? { type: 'GENTLE', easingFunctionSpring: { bounce: 0.25 } }
      : value,
  });
  const request = {
    name: 'motion/gentle', collection: 'Tokens', type: 'EASING', value: 'gentle',
  };
  const serialized = await runCode(request, target.figma);
  const result = await executeVariableCreate(request, { evaluate: async () => serialized });
  assert.deepEqual(result.result.modeValue.value, {
    type: 'GENTLE', easingFunctionSpring: { bounce: 0.25 },
  });
});

test('Variable Create rejects malformed native parameters for a named EASING preset', async () => {
  const target = fixture({
    normalizeValue: (value) => value?.type === 'GENTLE'
      ? { type: 'GENTLE', easingFunctionSpring: { bounce: 2 } }
      : value,
  });
  const serialized = await runCode({
    name: 'motion/invalid', collection: 'Tokens', type: 'EASING', value: 'gentle',
  }, target.figma);
  const payload = JSON.parse(serialized);
  assert.equal(payload.status, 'mutation-failed');
  assert.equal(payload.cleanup, 'removed');
  assert.equal(target.created[0].removed, true);
});

test('Variable Create rolls back an ignored setter or incompatible fresh identity', async () => {
  for (const target of [
    fixture({ setIgnored: true, retainRemovedReadback: true }),
    fixture({ freshIdentityMismatch: true }),
  ]) {
    const serialized = await runCode({
      name: 'space/lg', collection: 'Tokens', type: 'FLOAT', value: 16,
    }, target.figma);
    const payload = JSON.parse(serialized);
    assert.equal(payload.status, 'mutation-failed');
    assert.equal(payload.cleanup, 'removed');
    assert.equal(target.created[0].removed, true);
  }
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

  const residue = fixture({ freshIdentityMismatch: true, removeFails: true });
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
