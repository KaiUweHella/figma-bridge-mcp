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

function fixture({ remote = false, type = 'COMPONENT', selection = true } = {}) {
  const component = {
    id: '2:1', type, name: 'Fixture component', remote,
    componentPropertyDefinitions: {
      'Label#2:0': { type: 'TEXT', defaultValue: 'Hello' },
      'Visible#2:1': { type: 'BOOLEAN', defaultValue: true },
      Mode: { type: 'VARIANT', defaultValue: 'Default', variantOptions: ['Default', 'Compact'] },
      'Slot#2:2': { type: 'SLOT', defaultValue: '' },
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

test('explicit-id read preserves every native type, default and Variant option', async () => {
  const live = fixture();
  const result = await executeComponentPropertyList({ componentId: '2:1', json: true }, {
    evaluate: evaluate(live.figma),
  });
  assert.equal(result.result.source, 'id');
  assert.deepEqual(result.result.properties, [
    { name: 'Label#2:0', type: 'TEXT', defaultValue: 'Hello', variantOptions: null },
    { name: 'Visible#2:1', type: 'BOOLEAN', defaultValue: true, variantOptions: null },
    { name: 'Mode', type: 'VARIANT', defaultValue: 'Default', variantOptions: ['Default', 'Compact'] },
    { name: 'Slot#2:2', type: 'SLOT', defaultValue: '', variantOptions: null },
  ]);
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
  assert.equal(componentPropertyListPlanRoute(plan), 'command-application');
  assert.throws(() => componentPropertyListPlanRoute({ ...plan }), /requires a Command Plan/);
  const live = fixture();
  let evaluations = 0;
  const result = await executeComponentPropertyListPlan(plan, {
    evaluate: async (code) => { evaluations += 1; return evaluate(live.figma)(code); },
  });
  assert.equal(result.result.status, 'listed');
  assert.equal(evaluations, 1);
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
