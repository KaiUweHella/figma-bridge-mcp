import assert from 'node:assert/strict';
import test from 'node:test';
import { planFigmaCommand } from '../../src/capability-catalog.js';
import {
  componentPropertyListArgvFromRequest,
  componentPropertyListCode,
  componentPropertyListPlanRoute,
  componentPropertyListPlanningArgvFromRequest,
  executeComponentPropertyList,
  executeComponentPropertyListPlan,
  formatComponentPropertyListResult,
} from '../src/application/component-property-list-command.js';
import { parseComponentPropertyListRequest } from '../src/application/component-property-list-request.js';
import { COMPONENT_PROPERTY_LIST_TYPED_READ } from '../src/lib/typed-read-operations.js';

function fixture({ remote = false, type = 'COMPONENT', selection = true } = {}) {
  const text = {
    id: '2:2', type: 'TEXT', name: 'Label',
    componentPropertyReferences: { characters: 'Label#2:0' },
  };
  const badge = {
    id: '2:3', type: 'FRAME', name: 'Badge', children: [],
    componentPropertyReferences: { visible: 'Visible#2:1' },
  };
  const icon = {
    id: '2:4', type: 'INSTANCE', name: 'Icon', isExposedInstance: true,
    children: [{
      id: '9:9', type: 'TEXT', name: 'Inherited label',
      componentPropertyReferences: { characters: 'Nested label#9:8' },
    }],
    componentPropertyReferences: { mainComponent: 'Icon#2:3' },
  };
  const slot = {
    id: '2:5', type: 'SLOT', name: 'Content', componentPropertyReferences: null,
    children: [{
      id: '2:6', type: 'INSTANCE', name: 'Default content', isExposedInstance: false,
      componentPropertyReferences: { visible: 'Slotted visibility#8:8' }, children: [],
    }],
    limitViolations: [],
  };
  const component = {
    id: '2:1', type, name: 'Fixture component', remote,
    children: [text, badge, icon, slot],
    componentPropertyDefinitions: {
      'Label#2:0': {
        type: 'TEXT', defaultValue: 'Hello',
        boundVariables: { defaultValue: { type: 'VARIABLE_ALIAS', id: 'VariableID:7:7' } },
      },
      'Visible#2:1': { type: 'BOOLEAN', defaultValue: true },
      Mode: { type: 'VARIANT', defaultValue: 'Default', variantOptions: ['Default', 'Compact'] },
      'Slot#2:2': {
        type: 'SLOT', description: 'Flexible content',
        preferredValues: [{ type: 'COMPONENT', key: 'CARD_KEY' }],
        slotSettings: { minChildren: 1, maxChildren: 3, stretchChildOnInsert: true },
      },
      'Icon#2:3': {
        type: 'INSTANCE_SWAP', defaultValue: '3:1',
        preferredValues: [{ type: 'COMPONENT_SET', key: 'ICON_SET_KEY' }],
      },
    },
  };
  return {
    component,
    figma: {
      currentPage: { selection: selection ? [component] : [] },
      getNodeByIdAsync: async (id) => id === component.id ? component : null,
    },
  };
}

const evaluate = (figma) => async (code) => new Function('figma', `return ${code};`)(figma);

test('Component Property List request closes optional id, URL and output mode', () => {
  assert.deepEqual(parseComponentPropertyListRequest([
    'component', 'prop', 'list', '2-1', '--json',
  ]), { componentId: '2:1', json: true });
  assert.deepEqual(parseComponentPropertyListRequest([
    'component', 'prop', 'list', '--json',
  ]), { componentId: null, json: true });
  assert.deepEqual(componentPropertyListArgvFromRequest({ componentId: null, json: true }), [
    'component', 'prop', 'list', '--json',
  ]);

  const url = 'https://www.figma.com/design/FILEA/Test?node-id=2-1';
  assert.deepEqual(componentPropertyListPlanningArgvFromRequest({ componentId: url, json: false }), [
    'component', 'prop', 'list', url,
  ]);
  const plan = planFigmaCommand(['component', 'prop', 'list', url], { adapter: 'mcp' });
  assert.equal(plan.target.fileKey, 'FILEA');
  assert.equal(plan.argv[3], '2:1');

  for (const argv of [
    ['component', 'prop', 'list', 'bad'],
    ['component', 'prop', 'list', '2:1', '3:1'],
    ['component', 'prop', 'list', '--future'],
    ['component', 'prop', 'list', '--json', '--json'],
  ]) assert.throws(() => parseComponentPropertyListRequest(argv), /Invalid component prop list command/);
});

test('explicit-id read preserves all five native types, bindings, Slots and nested exposure', async () => {
  const live = fixture();
  const result = await executeComponentPropertyList({ componentId: '2:1', json: true }, {
    evaluate: evaluate(live.figma),
  });
  assert.equal(result.result.source, 'id');
  assert.deepEqual(result.result.properties, [
    {
      name: 'Label#2:0', type: 'TEXT', defaultValue: 'Hello', variantOptions: null,
      preferredValues: null, description: null, slotSettings: null,
      defaultValueVariable: { type: 'VARIABLE_ALIAS', id: 'VariableID:7:7' },
      bindings: [{ nodeId: '2:2', nodeName: 'Label', nodeType: 'TEXT', field: 'characters' }],
      bindingStatus: 'wired',
    },
    {
      name: 'Visible#2:1', type: 'BOOLEAN', defaultValue: true, variantOptions: null,
      preferredValues: null, description: null, slotSettings: null,
      defaultValueVariable: null,
      bindings: [{ nodeId: '2:3', nodeName: 'Badge', nodeType: 'FRAME', field: 'visible' }],
      bindingStatus: 'wired',
    },
    {
      name: 'Mode', type: 'VARIANT', defaultValue: 'Default', variantOptions: ['Default', 'Compact'],
      preferredValues: null, description: null, slotSettings: null, bindings: [], bindingStatus: 'native-axis',
      defaultValueVariable: null,
    },
    {
      name: 'Slot#2:2', type: 'SLOT', defaultValue: null, variantOptions: null,
      preferredValues: [{ type: 'COMPONENT', key: 'CARD_KEY' }], description: 'Flexible content',
      slotSettings: { minChildren: 1, maxChildren: 3, stretchChildOnInsert: true },
      defaultValueVariable: null,
      bindings: [], bindingStatus: 'native-slot',
    },
    {
      name: 'Icon#2:3', type: 'INSTANCE_SWAP', defaultValue: '3:1', variantOptions: null,
      preferredValues: [{ type: 'COMPONENT_SET', key: 'ICON_SET_KEY' }],
      description: null, slotSettings: null,
      defaultValueVariable: null,
      bindings: [{ nodeId: '2:4', nodeName: 'Icon', nodeType: 'INSTANCE', field: 'mainComponent' }],
      bindingStatus: 'wired',
    },
  ]);
  assert.deepEqual(result.result.nestedInstances, [{ id: '2:4', name: 'Icon', exposed: true }]);
  assert.deepEqual(result.result.slots, [{
    id: '2:5', name: 'Content', childCount: 1, limitViolations: [], property: 'Slot#2:2',
  }]);
  assert.deepEqual(JSON.parse(result.stdout), result.result);
});

test('selection mode returns the same structured facts without requiring an id', async () => {
  const live = fixture();
  const byId = await executeComponentPropertyList({ componentId: '2:1', json: true }, {
    evaluate: evaluate(live.figma),
  });
  const selected = await executeComponentPropertyList({ componentId: null, json: true }, {
    evaluate: evaluate(live.figma),
  });
  assert.equal(selected.result.source, 'selection');
  assert.deepEqual(selected.result.component, byId.result.component);
  assert.deepEqual(selected.result.properties, byId.result.properties);
});

test('empty definitions retain the useful human no-properties result', async () => {
  const live = fixture();
  live.component.componentPropertyDefinitions = {};
  live.component.children = [];
  const result = await executeComponentPropertyList({ componentId: '2:1', json: false }, {
    evaluate: evaluate(live.figma),
  });
  assert.match(result.stdout, /no component properties/);
});

test('missing selection, remote and non-component targets fail explicitly', async () => {
  for (const [live, input] of [
    [fixture({ selection: false }), { componentId: null, json: false }],
    [fixture({ remote: true }), { componentId: '2:1', json: false }],
    [fixture({ type: 'FRAME' }), { componentId: '2:1', json: false }],
  ]) {
    await assert.rejects(() => executeComponentPropertyList(input, {
      evaluate: evaluate(live.figma),
    }), /Component|Select/);
  }
});

test('oversized or malformed native definition metadata fails rather than truncating', async () => {
  const live = fixture();
  live.component.componentPropertyDefinitions['Bad#2:9'] = {
    type: 'VARIANT', defaultValue: 'Default', variantOptions: new Array(10_001).fill('Value'),
  };
  await assert.rejects(() => executeComponentPropertyList({ componentId: '2:1', json: false }, {
    evaluate: evaluate(live.figma),
  }), /Variant options/);
});

test('generated code keeps selection and explicit targets closed as data', () => {
  const code = componentPropertyListCode({ componentId: '2:1', json: false });
  assert.doesNotThrow(() => new Function('figma', `return ${code};`));
  assert.match(code, /const componentId = "2:1"/);
  const selection = componentPropertyListCode({ componentId: null, json: false });
  assert.match(selection, /const componentId = null/);
});

test('only one authentic safe-read component.prop.list plan crosses the Application Seam', async () => {
  const plan = planFigmaCommand([
    'component', 'prop', 'list', '2:1', '--json',
  ], { adapter: 'mcp', fileKey: 'FILEA' });
  assert.equal(plan.id, 'component.prop.list');
  assert.equal(plan.allowed, true);
  assert.equal(plan.effects.figma, 'read');
  assert.equal(plan.confirmation, 'none');
  assert.equal(plan.execution.retry, 'safe-read');
  assert.equal(plan.execution.pluginDispatch, 'typed-read');
  assert.equal(componentPropertyListPlanRoute(plan), 'command-application');
  assert.throws(() => componentPropertyListPlanRoute({ ...plan }), /requires a Command Plan/);
  const live = fixture();
  let evaluations = 0;
  let typedReads = 0;
  const result = await executeComponentPropertyListPlan(plan, {
    typedRead: async (operation, request, fallbackCode) => {
      typedReads += 1;
      assert.equal(operation, COMPONENT_PROPERTY_LIST_TYPED_READ);
      assert.deepEqual(request, { componentId: '2:1' });
      return evaluate(live.figma)(fallbackCode);
    },
    evaluate: async () => { evaluations += 1; throw new Error('typed read must win'); },
  });
  assert.equal(result.result.status, 'listed');
  assert.equal(typedReads, 1);
  assert.equal(evaluations, 0);
});

test('malformed Plugin results cannot become successful property facts', async () => {
  for (const value of [null, {}, 'not-json', JSON.stringify({ status: 'listed' })]) {
    await assert.rejects(() => executeComponentPropertyList({ componentId: '2:1', json: false }, {
      evaluate: async () => value,
    }), /invalid/i);
  }
});

test('human formatting escapes controls and retains Variant options', () => {
  const text = formatComponentPropertyListResult({
    component: { id: '2:1', name: 'Component\u202e', type: 'COMPONENT' },
    properties: [{
      name: 'Mode\u0000', type: 'VARIANT', defaultValue: 'Default',
      variantOptions: ['Default', 'Compact'],
    }],
  });
  assert.doesNotMatch(text, /\u202e|\u0000/u);
  assert.match(text, /\\u202e|\\u0000/);
  assert.match(text, /Compact/);
});
