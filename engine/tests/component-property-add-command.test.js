import assert from 'node:assert/strict';
import test from 'node:test';
import { planFigmaCommand } from '../../src/capability-catalog.js';
import {
  componentPropertyAddArgvFromRequest,
  componentPropertyAddCode,
  componentPropertyAddPlanRoute,
  componentPropertyAddPlanningArgvFromRequest,
  executeComponentPropertyAdd,
  executeComponentPropertyAddPlan,
  formatComponentPropertyAddResult,
} from '../src/application/component-property-add-command.js';
import { parseComponentPropertyAddRequest } from '../src/application/component-property-add-request.js';

function fixture({
  remote = false,
  type = 'COMPONENT',
  throwAfterAdd = false,
  mismatchAfterAdd = false,
  deleteThrows = false,
} = {}) {
  let next = 1;
  let addCalls = 0;
  let deleteCalls = 0;
  const definitions = { 'Existing#2:0': { type: 'TEXT', defaultValue: 'Kept' } };
  const component = {
    id: '2:1', type, name: 'Fixture component', remote,
    get componentPropertyDefinitions() { return definitions; },
    addComponentProperty(name, propertyType, defaultValue, options) {
      addCalls += 1;
      const propertyName = `${name}#2:${next++}`;
      definitions[propertyName] = {
        type: propertyType,
        defaultValue: mismatchAfterAdd ? 'Unexpected' : defaultValue,
        ...(options?.preferredValues ? { preferredValues: options.preferredValues } : {}),
      };
      if (throwAfterAdd) throw new Error('injected add failure after mutation');
      return propertyName;
    },
    deleteComponentProperty(name) {
      deleteCalls += 1;
      if (deleteThrows) throw new Error('injected delete failure');
      delete definitions[name];
    },
  };
  const swap = { id: '3:1', type: 'COMPONENT', name: 'Swap component', key: 'SWAP_KEY' };
  const variant = { id: '3:2', type: 'COMPONENT', name: 'Mode=Default', key: 'VARIANT_KEY' };
  const set = { id: '3:3', type: 'COMPONENT_SET', children: [variant], defaultVariant: variant, key: 'SET_KEY' };
  const nodes = new Map([[component.id, component], [swap.id, swap], [variant.id, variant], [set.id, set]]);
  return {
    definitions, component, nodes,
    figma: { getNodeByIdAsync: async (id) => nodes.get(id) || null },
    addCalls: () => addCalls,
    deleteCalls: () => deleteCalls,
  };
}

const evaluate = (figma) => async (code) => new Function('figma', `return ${code};`)(figma);

test('Component Property Add request closes types, options, literals and URL targeting', () => {
  assert.deepEqual(parseComponentPropertyAddRequest([
    'component', 'prop', 'add', '2-1', 'Label', 'text', 'Hello', '--json',
  ]), {
    componentId: '2:1', name: 'Label', type: 'TEXT', defaultValue: 'Hello', options: null, preferred: null, json: true,
  });
  assert.deepEqual(parseComponentPropertyAddRequest([
    'component', 'prop', 'add', '-oOne,Two', '2:1', 'Label', 'BOOLEAN', 'false',
  ]).options, 'One,Two');
  assert.deepEqual(parseComponentPropertyAddRequest([
    'component', 'prop', 'add', '2:1', 'Icon', 'instance-swap', '3:1',
    '--preferred', '3:1,3:3',
  ]).preferred, ['3:1', '3:3']);
  assert.deepEqual(componentPropertyAddArgvFromRequest({
    componentId: '2:1', name: 'Label', type: 'text', defaultValue: '', options: '', preferred: null, json: true,
  }), ['component', 'prop', 'add', '2:1', '--json', '--options', '', '--', 'Label', 'TEXT', '']);

  const url = 'https://www.figma.com/design/FILEA/Test?node-id=2-1';
  assert.deepEqual(componentPropertyAddPlanningArgvFromRequest({
    componentId: url, name: 'Label', type: 'text', defaultValue: 'Hello', options: null, preferred: null, json: false,
  }), ['component', 'prop', 'add', url, 'Label', 'TEXT', 'Hello']);
  const payloadUrl = 'https://www.figma.com/design/FILEB/Payload?node-id=9-9';
  const plan = planFigmaCommand([
    'component', 'prop', 'add', url, 'Label', 'text', payloadUrl,
  ], { adapter: 'mcp' });
  assert.equal(plan.target.fileKey, 'FILEA');
  assert.equal(plan.argv[6], payloadUrl);

  for (const argv of [
    ['component', 'prop', 'add'],
    ['component', 'prop', 'add', '2:1', 'Label', 'text'],
    ['component', 'prop', 'add', 'bad', 'Label', 'text', 'Hello'],
    ['component', 'prop', 'add', '2:1', 'Label', 'unknown', 'Hello'],
    ['component', 'prop', 'add', '2:1', 'Mode', 'variant', 'Default'],
    ['component', 'prop', 'add', '2:1', 'Label', 'text', 'Hello', 'extra'],
    ['component', 'prop', 'add', '2:1', 'Label', 'text', 'Hello', '--future'],
    ['component', 'prop', 'add', '2:1', 'Label', 'text', 'Hello', '--preferred', '3:1'],
    ['component', 'prop', 'add', '2:1', 'Icon', 'instance-swap', '3:1', '--preferred', '3:1,3:1'],
  ]) assert.throws(() => parseComponentPropertyAddRequest(argv), /Invalid component prop add command/);
});

test('TEXT, permissive legacy BOOLEAN and INSTANCE_SWAP defaults remain available', async () => {
  const live = fixture();
  const text = await executeComponentPropertyAdd({
    componentId: '2:1', name: 'Label', type: 'text', defaultValue: 'Hello', options: null, json: false,
  }, { evaluate: evaluate(live.figma) });
  assert.deepEqual(text.result.property, {
    name: 'Label#2:1', type: 'TEXT', defaultValue: 'Hello', preferredValues: null,
  });

  const bool = await executeComponentPropertyAdd({
    componentId: '2:1', name: 'Visible', type: 'boolean', defaultValue: 'not-true', options: null, json: false,
  }, { evaluate: evaluate(live.figma) });
  assert.equal(bool.result.property.defaultValue, false);

  const directSwap = await executeComponentPropertyAdd({
    componentId: '2:1', name: 'Icon', type: 'instance-swap', defaultValue: '3:1', options: null, json: false,
  }, { evaluate: evaluate(live.figma) });
  assert.equal(directSwap.result.property.defaultValue, '3:1');

  const setSwap = await executeComponentPropertyAdd({
    componentId: '2:1', name: 'Set icon', type: 'instance-swap', defaultValue: '3:3', options: null, json: false,
  }, { evaluate: evaluate(live.figma) });
  assert.equal(setSwap.result.property.defaultValue, '3:2');
  const preferredSwap = await executeComponentPropertyAdd({
    componentId: '2:1', name: 'Preferred icon', type: 'instance-swap', defaultValue: '3:1',
    options: null, preferred: ['3:1', '3:3'], json: false,
  }, { evaluate: evaluate(live.figma) });
  assert.deepEqual(preferredSwap.result.property.preferredValues, [
    { type: 'COMPONENT', key: 'SWAP_KEY' },
    { type: 'COMPONENT_SET', key: 'SET_KEY' },
  ]);
  assert.equal(live.addCalls(), 5);
});

test('legacy --options remains accepted and becomes an explicit compatibility warning', async () => {
  const live = fixture();
  const result = await executeComponentPropertyAdd({
    componentId: '2:1', name: 'Label', type: 'text', defaultValue: 'Hello',
    options: 'One,Two', json: true,
  }, { evaluate: evaluate(live.figma) });
  assert.equal(result.result.warnings.length, 1);
  assert.match(result.result.warnings[0], /accepted for compatibility/);
  assert.equal(JSON.parse(result.stdout).status, 'created');
});

test('remote and non-component targets refuse before mutation', async () => {
  for (const live of [fixture({ remote: true }), fixture({ type: 'FRAME' })]) {
    await assert.rejects(() => executeComponentPropertyAdd({
      componentId: '2:1', name: 'Label', type: 'text', defaultValue: 'Hello', options: null, json: false,
    }, { evaluate: evaluate(live.figma) }), (error) => {
      assert.equal(error.mutationOutcome, 'no-mutation');
      assert.equal(error.mutationReport.attempted, 0);
      return true;
    });
    assert.equal(live.addCalls(), 0);
  }
});

test('an add throw or fresh postcondition failure deletes the attributable property', async () => {
  for (const live of [fixture({ throwAfterAdd: true }), fixture({ mismatchAfterAdd: true })]) {
    await assert.rejects(() => executeComponentPropertyAdd({
      componentId: '2:1', name: 'Label', type: 'text', defaultValue: 'Hello', options: null, json: false,
    }, { evaluate: evaluate(live.figma) }), (error) => {
      assert.equal(error.mutationOutcome, 'rolled-back');
      assert.deepEqual(error.mutationReport, {
        version: 1, outcome: 'rolled-back', attempted: 1, restored: 1, residueCount: 0,
      });
      return true;
    });
    assert.deepEqual(Object.keys(live.definitions), ['Existing#2:0']);
    assert.equal(live.deleteCalls(), 1);
  }
});

test('a failed delete reports the exact created-definition residue', async () => {
  const live = fixture({ throwAfterAdd: true, deleteThrows: true });
  await assert.rejects(() => executeComponentPropertyAdd({
    componentId: '2:1', name: 'Label', type: 'text', defaultValue: 'Hello', options: null, json: false,
  }, { evaluate: evaluate(live.figma) }), (error) => {
    assert.equal(error.mutationOutcome, 'partial-residue');
    assert.deepEqual(error.mutationReport, {
      version: 1, outcome: 'partial-residue', attempted: 1, restored: 0, residueCount: 1,
    });
    return true;
  });
  assert.ok(live.definitions['Label#2:1']);
  assert.equal(live.addCalls(), 1);
  assert.equal(live.deleteCalls(), 1);
});

test('generated code preserves hostile and magic property names as data', async () => {
  const live = fixture();
  const name = '__proto__`); globalThis.COMPONENT_ADD_INJECTED = true; //';
  const value = 'line\n\u2028${globalThis.COMPONENT_ADD_INJECTED = true}';
  const code = componentPropertyAddCode({
    componentId: '2:1', name, type: 'text', defaultValue: value, options: null, json: false,
  });
  assert.doesNotThrow(() => new Function('figma', `return ${code};`));
  delete globalThis.COMPONENT_ADD_INJECTED;
  const result = await executeComponentPropertyAdd({
    componentId: '2:1', name, type: 'text', defaultValue: value, options: null, json: false,
  }, { evaluate: evaluate(live.figma) });
  assert.equal(globalThis.COMPONENT_ADD_INJECTED, undefined);
  assert.equal(result.result.property.defaultValue, value);
});

test('only one authentic component.prop.add plan crosses the Application Seam', async () => {
  const plan = planFigmaCommand([
    'component', 'prop', 'add', '2:1', 'Label', 'text', 'Hello', '--json',
  ], { adapter: 'mcp', fileKey: 'FILEA' });
  assert.equal(plan.id, 'component.prop.add');
  assert.equal(plan.allowed, true);
  assert.equal(componentPropertyAddPlanRoute(plan), 'command-application');
  assert.throws(() => componentPropertyAddPlanRoute({ ...plan }), /requires a Command Plan/);
  const live = fixture();
  let evaluations = 0;
  const result = await executeComponentPropertyAddPlan(plan, {
    evaluate: async (code) => { evaluations += 1; return evaluate(live.figma)(code); },
  });
  assert.equal(result.result.status, 'created');
  assert.equal(evaluations, 1);
});

test('malformed Plugin results cannot become successful property creation', async () => {
  for (const value of [null, {}, 'not-json', JSON.stringify({ status: 'created' })]) {
    await assert.rejects(() => executeComponentPropertyAdd({
      componentId: '2:1', name: 'Label', type: 'text', defaultValue: 'Hello', options: null, json: false,
    }, { evaluate: async () => value }), /invalid/i);
  }
});

test('human formatting escapes control-bearing names', () => {
  const text = formatComponentPropertyAddResult({
    component: { id: '2:1', name: 'Component\u202e' },
    property: { name: 'Label\u0000', type: 'TEXT' }, warnings: [],
  });
  assert.doesNotMatch(text, /\u202e|\u0000/u);
  assert.match(text, /\\u202e|\\u0000/);
});
