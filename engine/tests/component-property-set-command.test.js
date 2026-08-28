import assert from 'node:assert/strict';
import test from 'node:test';
import { planFigmaCommand } from '../../src/capability-catalog.js';
import {
  componentPropertySetArgvFromRequest,
  componentPropertySetCode,
  componentPropertySetPlanRoute,
  componentPropertySetPlanningArgvFromRequest,
  executeComponentPropertySet,
  executeComponentPropertySetPlan,
  formatComponentPropertySetResult,
} from '../src/application/component-property-set-command.js';
import { parseComponentPropertySetRequest } from '../src/application/component-property-set-request.js';

function fixture({ setter = null, readback = null } = {}) {
  const values = new Map([
    ['Label#1:1', 'Before'],
    ['Visible#1:1', true],
    ['Mode', 'Default'],
    ['Swap#1:1', '3:1'],
  ]);
  const definitions = {
    'Label#1:1': { type: 'TEXT', defaultValue: 'Before' },
    'Visible#1:1': { type: 'BOOLEAN', defaultValue: true },
    Mode: { type: 'VARIANT', defaultValue: 'Default', variantOptions: ['Default', 'Compact'] },
    'Swap#1:1': { type: 'INSTANCE_SWAP', defaultValue: '3:1' },
  };
  const owner = { id: '2:1', type: 'COMPONENT', componentPropertyDefinitions: definitions };
  let calls = 0;
  const instance = {
    id: '4:1', type: 'INSTANCE', name: 'Fixture instance',
    get componentProperties() {
      const record = {};
      for (const [name, value] of values) {
        record[name] = { type: definitions[name]?.type || 'TEXT', value };
      }
      return readback ? readback({ record, values, calls }) : record;
    },
    getMainComponentAsync: async () => owner,
    setProperties(update) {
      calls += 1;
      if (setter) return setter({ update, values, calls });
      for (const [name, value] of Object.entries(update)) values.set(name, value);
    },
  };
  const swap = { id: '3:1', type: 'COMPONENT', name: 'Swap default' };
  const alternate = { id: '3:2', type: 'COMPONENT', name: 'Swap alternate' };
  const set = { id: '3:3', type: 'COMPONENT_SET', children: [alternate], defaultVariant: alternate };
  const nodes = new Map([[instance.id, instance], [swap.id, swap], [alternate.id, alternate], [set.id, set]]);
  return {
    values, definitions, instance, nodes,
    figma: { getNodeByIdAsync: async (id) => nodes.get(id) || null },
    calls: () => calls,
  };
}

const evaluate = (figma) => async (code) => new Function('figma', `return ${code};`)(figma);

test('Component Property Set request closes arity, options, literals and URL targeting', () => {
  assert.deepEqual(parseComponentPropertySetRequest([
    'component', 'prop', 'set', '4-1', 'Label', 'After', '--json',
  ]), { instanceId: '4:1', name: 'Label', value: 'After', json: true });
  assert.deepEqual(componentPropertySetArgvFromRequest({
    instanceId: '4:1', name: 'Label', value: '--help', json: true,
  }), ['component', 'prop', 'set', '--json', '4:1', '--', 'Label', '--help']);
  assert.deepEqual(componentPropertySetArgvFromRequest({
    instanceId: '4:1', name: 'Label', value: '', json: false,
  }), ['component', 'prop', 'set', '4:1', '--', 'Label', '']);
  const url = 'https://www.figma.com/design/FILEA/Test?node-id=4-1';
  assert.deepEqual(componentPropertySetPlanningArgvFromRequest({
    instanceId: url, name: 'Label', value: 'After', json: false,
  }), ['component', 'prop', 'set', url, 'Label', 'After']);
  const payloadUrl = 'https://www.figma.com/design/FILEB/Payload?node-id=9-9';
  const targetPlan = planFigmaCommand([
    'component', 'prop', 'set', url, 'Label', payloadUrl,
  ], { adapter: 'mcp' });
  assert.equal(targetPlan.target.fileKey, 'FILEA');
  assert.equal(targetPlan.argv[5], payloadUrl);
  for (const argv of [
    ['component', 'prop', 'set'],
    ['component', 'prop', 'set', '4:1', 'Label'],
    ['component', 'prop', 'set', 'bad', 'Label', 'After'],
    ['component', 'prop', 'set', '4:1', 'Label', 'After', 'extra'],
    ['component', 'prop', 'set', '4:1', 'Label', '--future'],
    ['component', 'prop', 'set', '4:1', 'Label', 'After', '--json', '--json'],
  ]) assert.throws(() => parseComponentPropertySetRequest(argv), /Invalid component prop set command/);
});

test('TEXT, BOOLEAN, VARIANT and INSTANCE_SWAP keep the full useful legacy behavior', async () => {
  const live = fixture();
  const text = await executeComponentPropertySet({
    instanceId: '4:1', name: 'Label', value: 'After', json: false,
  }, { evaluate: evaluate(live.figma) });
  assert.equal(text.result.property, 'Label#1:1');
  assert.equal(text.result.type, 'TEXT');
  assert.equal(text.result.before, 'Before');
  assert.equal(text.result.value, 'After');

  const bool = await executeComponentPropertySet({
    instanceId: '4:1', name: 'Visible', value: '0', json: false,
  }, { evaluate: evaluate(live.figma) });
  assert.equal(bool.result.value, false);

  const variant = await executeComponentPropertySet({
    instanceId: '4:1', name: 'Mode', value: 'Compact', json: false,
  }, { evaluate: evaluate(live.figma) });
  assert.equal(variant.result.value, 'Compact');

  const swap = await executeComponentPropertySet({
    instanceId: '4:1', name: 'Swap', value: '3:3', json: false,
  }, { evaluate: evaluate(live.figma) });
  assert.equal(swap.result.value, '3:2');
  assert.equal(live.calls(), 4);
});

test('same-value writes succeed without dispatching a redundant Figma mutation', async () => {
  const live = fixture();
  const result = await executeComponentPropertySet({
    instanceId: '4:1', name: 'Label', value: 'Before', json: true,
  }, { evaluate: evaluate(live.figma) });
  assert.equal(result.result.status, 'unchanged');
  assert.equal(result.result.attempted, 0);
  assert.equal(live.calls(), 0);
  assert.equal(JSON.parse(result.stdout).status, 'unchanged');
});

test('invalid BOOLEAN, unknown and ambiguous names refuse before mutation', async () => {
  for (const configure of ['boolean', 'unknown', 'ambiguous']) {
    const live = fixture();
    let name = 'Visible';
    let value = 'maybe';
    if (configure === 'unknown') name = 'Missing';
    if (configure === 'ambiguous') {
      live.definitions['Label#2:2'] = { type: 'TEXT', defaultValue: 'Other' };
      live.values.set('Label#2:2', 'Other');
      name = 'Label';
      value = 'After';
    }
    await assert.rejects(() => executeComponentPropertySet({
      instanceId: '4:1', name, value, json: false,
    }, { evaluate: evaluate(live.figma) }), (error) => {
      assert.equal(error.mutationOutcome, 'no-mutation');
      assert.deepEqual(error.mutationReport, {
        version: 1, outcome: 'no-mutation', attempted: 0, restored: 0, residueCount: 0,
      });
      return true;
    });
    assert.equal(live.calls(), 0);
  }
});

test('a setter or fresh-read failure restores the exact prior value', async () => {
  for (const mode of ['throw-after-write', 'bad-readback']) {
    const live = fixture({
      setter: mode === 'throw-after-write'
        ? ({ update, values, calls }) => {
          for (const [name, value] of Object.entries(update)) values.set(name, value);
          if (calls === 1) throw new Error('injected setter failure');
        } : null,
      readback: mode === 'bad-readback'
        ? ({ record, calls }) => {
          if (calls === 1) record['Label#1:1'].value = 'Unexpected';
          return record;
        } : null,
    });
    await assert.rejects(() => executeComponentPropertySet({
      instanceId: '4:1', name: 'Label', value: 'After', json: false,
    }, { evaluate: evaluate(live.figma) }), (error) => {
      assert.equal(error.mutationOutcome, 'rolled-back');
      assert.deepEqual(error.mutationReport, {
        version: 1, outcome: 'rolled-back', attempted: 1, restored: 1, residueCount: 0,
      });
      return true;
    });
    assert.equal(live.values.get('Label#1:1'), 'Before');
  }
});

test('failed rollback reports exact residue and never retries the requested value', async () => {
  const live = fixture({
    setter: ({ update, values, calls }) => {
      if (calls === 1) {
        for (const [name, value] of Object.entries(update)) values.set(name, value);
        throw new Error('injected mutation failure');
      }
      throw new Error('injected rollback failure');
    },
  });
  await assert.rejects(() => executeComponentPropertySet({
    instanceId: '4:1', name: 'Label', value: 'After', json: false,
  }, { evaluate: evaluate(live.figma) }), (error) => {
    assert.equal(error.mutationOutcome, 'partial-residue');
    assert.deepEqual(error.mutationReport, {
      version: 1, outcome: 'partial-residue', attempted: 1, restored: 0, residueCount: 1,
    });
    return true;
  });
  assert.equal(live.values.get('Label#1:1'), 'After');
  assert.equal(live.calls(), 2);
});

test('generated code is injection-safe and magic property names use own semantics', async () => {
  const live = fixture();
  const magic = '__proto__#1:1';
  live.definitions[magic] = { type: 'TEXT', defaultValue: 'Before' };
  live.values.set(magic, 'Before');
  const value = '`; globalThis.COMPONENT_PROPERTY_INJECTED = true; //\n\u2028';
  const code = componentPropertySetCode({ instanceId: '4:1', name: magic, value, json: false });
  assert.doesNotThrow(() => new Function('figma', `return ${code};`));
  delete globalThis.COMPONENT_PROPERTY_INJECTED;
  const result = await executeComponentPropertySet({
    instanceId: '4:1', name: magic, value, json: false,
  }, { evaluate: evaluate(live.figma) });
  assert.equal(globalThis.COMPONENT_PROPERTY_INJECTED, undefined);
  assert.equal(result.result.value, value);
  assert.equal(live.values.get(magic), value);
});

test('only one authentic component.prop.set plan can cross the Application Seam', async () => {
  const plan = planFigmaCommand(['component', 'prop', 'set', '4:1', 'Label', 'After'], {
    adapter: 'mcp', fileKey: 'FILEA',
  });
  assert.equal(plan.id, 'component.prop.set');
  assert.equal(plan.allowed, true);
  assert.equal(componentPropertySetPlanRoute(plan), 'command-application');
  assert.throws(() => componentPropertySetPlanRoute({ ...plan }), /requires a Command Plan/);
  const live = fixture();
  let evaluations = 0;
  const result = await executeComponentPropertySetPlan(plan, {
    evaluate: async (code) => { evaluations += 1; return evaluate(live.figma)(code); },
  });
  assert.equal(result.result.value, 'After');
  assert.equal(evaluations, 1);
  const literalPlan = planFigmaCommand(componentPropertySetArgvFromRequest({
    instanceId: '4:1', name: 'Label', value: '--help', json: true,
  }), { adapter: 'mcp', fileKey: 'FILEA' });
  assert.equal(literalPlan.id, 'component.prop.set');
  assert.equal(literalPlan.allowed, true);
});

test('malformed post-dispatch results are never accepted as success', async () => {
  for (const value of [
    null,
    {},
    'not-json',
    JSON.stringify({ status: 'updated' }),
    JSON.stringify({
      schemaVersion: 1, status: 'updated',
      instance: { id: '4:1', name: 'Fixture instance' },
      property: 'Other#1:1', type: 'TEXT', before: 'Before', value: 'After',
      attempted: 1, residue: [],
    }),
    JSON.stringify({
      schemaVersion: 1, status: 'updated',
      instance: { id: '4:1', name: 'Fixture instance' },
      property: 'Label#1:1', type: 'BOOLEAN', before: 'Before', value: 'After',
      attempted: 1, residue: [],
    }),
  ]) {
    await assert.rejects(() => executeComponentPropertySet({
      instanceId: '4:1', name: 'Label', value: 'After', json: false,
    }, { evaluate: async () => value }), /invalid/i);
  }
});

test('human formatting escapes control-bearing property data', () => {
  const text = formatComponentPropertySetResult({
    status: 'updated', instance: { id: '4:1', name: 'Instance\u202e' },
    property: 'Label\u0000', value: 'After\u2028',
  });
  assert.doesNotMatch(text, /\u202e|\u0000|\u2028/u);
  assert.match(text, /\\u202e|\\u0000|\\u2028/);
});
