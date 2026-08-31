import assert from 'node:assert/strict';
import test from 'node:test';
import { planFigmaCommand } from '../../src/capability-catalog.js';
import {
  componentPropertyBindArgvFromRequest,
  componentPropertyBindPlanRoute,
  componentPropertyBindPlanningArgvFromRequest,
  executeComponentPropertyBind,
  executeComponentPropertyBindPlan,
} from '../src/application/component-property-bind-command.js';
import { parseComponentPropertyBindRequest } from '../src/application/component-property-bind-request.js';

function fixture({ throwAfterSet = false, canonicalizeReferences = false } = {}) {
  const component = {
    id: '2:1', type: 'COMPONENT', name: 'Card', remote: false,
    componentPropertyDefinitions: {
      'Title#2:0': { type: 'TEXT', defaultValue: 'Title' },
      'Show badge#2:1': { type: 'BOOLEAN', defaultValue: true },
      'Icon#2:2': { type: 'INSTANCE_SWAP', defaultValue: '3:1' },
      State: { type: 'VARIANT', defaultValue: 'Default' },
      'Content#2:3': { type: 'SLOT', defaultValue: '' },
    },
  };
  let writes = 0;
  let references = null;
  const text = {
    id: '2:2', type: 'TEXT', name: 'Title', parent: component,
    get componentPropertyReferences() { return references; },
    set componentPropertyReferences(value) {
      references = canonicalizeReferences && value
        ? Object.fromEntries(['visible', 'characters', 'mainComponent']
          .filter((field) => Object.prototype.hasOwnProperty.call(value, field))
          .map((field) => [field, value[field]]))
        : value;
      writes += 1;
      if (throwAfterSet && writes === 1) throw new Error('injected setter failure');
    },
  };
  const badge = {
    id: '2:3', type: 'FRAME', name: 'Badge', parent: component,
    componentPropertyReferences: null,
  };
  const icon = {
    id: '2:4', type: 'INSTANCE', name: 'Icon', parent: component,
    componentPropertyReferences: null,
  };
  const outside = {
    id: '9:9', type: 'TEXT', name: 'Outside', parent: null,
    componentPropertyReferences: null,
  };
  const nodes = new Map([[component.id, component], [text.id, text], [badge.id, badge], [icon.id, icon], [outside.id, outside]]);
  return {
    component, text, badge, icon, outside,
    figma: { getNodeByIdAsync: async (id) => nodes.get(id) || null },
    writes: () => writes,
    references: () => references,
  };
}

const evaluate = (figma) => async (code) => new Function('figma', `return ${code};`)(figma);

test('Component Property Bind request closes flags, literals and same-file URLs', () => {
  assert.deepEqual(parseComponentPropertyBindRequest([
    'component', 'prop', 'bind', '2-1', 'Title', '2-2', '--replace', '--json',
  ]), {
    componentId: '2:1', propertyName: 'Title', nodeId: '2:2',
    remove: false, replace: true, json: true,
  });
  assert.deepEqual(componentPropertyBindArgvFromRequest({
    componentId: '2:1', propertyName: '-Title', nodeId: '2:2', remove: true, replace: false, json: true,
  }), ['component', 'prop', 'bind', '2:1', '--json', '--remove', '--', '-Title', '2:2']);
  const componentUrl = 'https://www.figma.com/design/FILEA/Test?node-id=2-1';
  const nodeUrl = 'https://www.figma.com/design/FILEA/Test?node-id=2-2';
  assert.deepEqual(componentPropertyBindPlanningArgvFromRequest({
    componentId: componentUrl, propertyName: 'Title', nodeId: nodeUrl,
    remove: false, replace: false, json: false,
  }), ['component', 'prop', 'bind', componentUrl, 'Title', nodeUrl]);
  assert.throws(() => parseComponentPropertyBindRequest([
    'component', 'prop', 'bind', componentUrl, 'Title',
    'https://www.figma.com/design/FILEB/Test?node-id=2-2',
  ]), /same Figma file/);
  for (const argv of [
    ['component', 'prop', 'bind'],
    ['component', 'prop', 'bind', '2:1', 'Title'],
    ['component', 'prop', 'bind', 'bad', 'Title', '2:2'],
    ['component', 'prop', 'bind', '2:1', 'Title', 'bad'],
    ['component', 'prop', 'bind', '2:1', 'Title', '2:2', '--remove', '--replace'],
    ['component', 'prop', 'bind', '2:1', 'Title', '2:2', '--future'],
  ]) assert.throws(() => parseComponentPropertyBindRequest(argv), /Invalid component prop bind command/);
});

test('TEXT, BOOLEAN and INSTANCE_SWAP bind to their only compatible native fields', async () => {
  const live = fixture();
  const text = await executeComponentPropertyBind({
    componentId: '2:1', propertyName: 'Title', nodeId: '2:2', remove: false, replace: false, json: false,
  }, { evaluate: evaluate(live.figma) });
  assert.equal(text.result.field, 'characters');
  assert.deepEqual(live.text.componentPropertyReferences, { characters: 'Title#2:0' });

  const bool = await executeComponentPropertyBind({
    componentId: '2:1', propertyName: 'Show badge', nodeId: '2:3', remove: false, replace: false, json: false,
  }, { evaluate: evaluate(live.figma) });
  assert.equal(bool.result.field, 'visible');
  assert.deepEqual(live.badge.componentPropertyReferences, { visible: 'Show badge#2:1' });

  const swap = await executeComponentPropertyBind({
    componentId: '2:1', propertyName: 'Icon', nodeId: '2:4', remove: false, replace: false, json: false,
  }, { evaluate: evaluate(live.figma) });
  assert.equal(swap.result.field, 'mainComponent');
  assert.deepEqual(live.icon.componentPropertyReferences, { mainComponent: 'Icon#2:2' });
});

test('one layer can retain multiple compatible property references when Figma reorders their keys', async () => {
  const live = fixture({ canonicalizeReferences: true });
  live.text.componentPropertyReferences = { characters: 'Title#2:0' };

  const result = await executeComponentPropertyBind({
    componentId: '2:1', propertyName: 'Show badge', nodeId: '2:2',
    remove: false, replace: false, json: false,
  }, { evaluate: evaluate(live.figma) });

  assert.equal(result.result.status, 'bound');
  assert.deepEqual(live.text.componentPropertyReferences, {
    visible: 'Show badge#2:1',
    characters: 'Title#2:0',
  });
});

test('binding refuses incompatible targets and native VARIANT or SLOT definitions', async () => {
  const live = fixture();
  for (const request of [
    { componentId: '2:1', propertyName: 'Title', nodeId: '2:3' },
    { componentId: '2:1', propertyName: 'Icon', nodeId: '2:2' },
    { componentId: '2:1', propertyName: 'Title', nodeId: '9:9' },
    { componentId: '2:1', propertyName: 'State', nodeId: '2:2' },
    { componentId: '2:1', propertyName: 'Content', nodeId: '2:3' },
  ]) {
    await assert.rejects(() => executeComponentPropertyBind({
      ...request, remove: false, replace: false, json: false,
    }, { evaluate: evaluate(live.figma) }), (error) => error.mutationOutcome === 'no-mutation');
  }
});

test('replacement is explicit, removal targets the same property and failures roll back', async () => {
  const live = fixture();
  live.text.componentPropertyReferences = { characters: 'Other#9:9' };
  await assert.rejects(() => executeComponentPropertyBind({
    componentId: '2:1', propertyName: 'Title', nodeId: '2:2', remove: false, replace: false, json: false,
  }, { evaluate: evaluate(live.figma) }), /--replace/);
  const replaced = await executeComponentPropertyBind({
    componentId: '2:1', propertyName: 'Title', nodeId: '2:2', remove: false, replace: true, json: false,
  }, { evaluate: evaluate(live.figma) });
  assert.equal(replaced.result.before, 'Other#9:9');
  const removed = await executeComponentPropertyBind({
    componentId: '2:1', propertyName: 'Title', nodeId: '2:2', remove: true, replace: false, json: false,
  }, { evaluate: evaluate(live.figma) });
  assert.equal(removed.result.status, 'unbound');
  assert.equal(live.text.componentPropertyReferences, null);

  const failing = fixture({ throwAfterSet: true });
  await assert.rejects(() => executeComponentPropertyBind({
    componentId: '2:1', propertyName: 'Title', nodeId: '2:2', remove: false, replace: false, json: false,
  }, { evaluate: evaluate(failing.figma) }), (error) => {
    assert.equal(error.mutationOutcome, 'rolled-back');
    assert.equal(error.mutationReport.residueCount, 0);
    return true;
  });
  assert.equal(failing.references(), null);
  assert.equal(failing.writes(), 2);
});

test('one authentic non-retrying component.prop.bind plan crosses the Application Seam', async () => {
  const plan = planFigmaCommand([
    'component', 'prop', 'bind', '2:1', 'Title', '2:2', '--json',
  ], { adapter: 'mcp', fileKey: 'FILEA' });
  assert.equal(plan.id, 'component.prop.bind');
  assert.equal(plan.allowed, true);
  assert.equal(plan.effects.figma, 'write');
  assert.equal(plan.execution.retry, 'never');
  assert.equal(componentPropertyBindPlanRoute(plan), 'command-application');
  assert.throws(() => componentPropertyBindPlanRoute({ ...plan }), /requires a Command Plan/);
  const live = fixture();
  let evaluations = 0;
  const result = await executeComponentPropertyBindPlan(plan, {
    evaluate: async (code) => { evaluations += 1; return evaluate(live.figma)(code); },
  });
  assert.equal(result.result.status, 'bound');
  assert.equal(evaluations, 1);
});
