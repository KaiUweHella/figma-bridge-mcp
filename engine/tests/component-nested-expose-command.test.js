import assert from 'node:assert/strict';
import test from 'node:test';
import { planFigmaCommand } from '../../src/capability-catalog.js';
import {
  componentNestedExposeArgvFromRequest,
  componentNestedExposePlanRoute,
  componentNestedExposePlanningArgvFromRequest,
  executeComponentNestedExpose,
  executeComponentNestedExposePlan,
} from '../src/application/component-nested-expose-command.js';
import { parseComponentNestedExposeRequest } from '../src/application/component-nested-expose-request.js';

function fixture({ inherited = false, throwAfterSet = false } = {}) {
  const owner = { id: '2:1', type: 'COMPONENT', name: 'Wrapper', remote: false, parent: null };
  const frame = { id: '2:2', type: 'FRAME', name: 'Content', parent: owner };
  const inheritedParent = { id: '2:9', type: 'INSTANCE', name: 'Outer instance', parent: owner };
  let value = false;
  let writes = 0;
  const instance = {
    id: '2:3', type: 'INSTANCE', name: 'Nested card', parent: inherited ? inheritedParent : frame,
    get isExposedInstance() { return value; },
    set isExposedInstance(next) {
      value = next; writes += 1;
      if (throwAfterSet && writes === 1) throw new Error('injected exposure failure');
    },
  };
  const nodes = new Map([[owner.id, owner], [frame.id, frame], [inheritedParent.id, inheritedParent], [instance.id, instance]]);
  return {
    owner, frame, instance,
    figma: { getNodeByIdAsync: async (id) => nodes.get(id) || null },
    value: () => value, writes: () => writes,
  };
}

const evaluate = (figma) => async (code) => new Function('figma', `return ${code};`)(figma);

test('Component Nested Expose request closes Boolean values and URL targeting', () => {
  assert.deepEqual(parseComponentNestedExposeRequest([
    'component', 'nested', 'expose', '2-3', '1', '--json',
  ]), { instanceId: '2:3', exposed: true, json: true });
  assert.deepEqual(componentNestedExposeArgvFromRequest({
    instanceId: '2:3', exposed: false, json: true,
  }), ['component', 'nested', 'expose', '2:3', 'false', '--json']);
  const url = 'https://www.figma.com/design/FILEA/Test?node-id=2-3';
  assert.deepEqual(componentNestedExposePlanningArgvFromRequest({
    instanceId: url, exposed: true, json: false,
  }), ['component', 'nested', 'expose', url, 'true']);
  for (const argv of [
    ['component', 'nested', 'expose'],
    ['component', 'nested', 'expose', '2:3'],
    ['component', 'nested', 'expose', 'bad', 'true'],
    ['component', 'nested', 'expose', '2:3', 'yes'],
    ['component', 'nested', 'expose', '2:3', 'true', '--future'],
  ]) assert.throws(() => parseComponentNestedExposeRequest(argv), /Invalid component nested expose command/);
});
test('primary nested instances expose, hide and skip same-value writes', async () => {
  const live = fixture();
  const exposed = await executeComponentNestedExpose({ instanceId: '2:3', exposed: true, json: false }, {
    evaluate: evaluate(live.figma),
  });
  assert.equal(exposed.result.status, 'exposed');
  assert.equal(live.value(), true);
  const unchanged = await executeComponentNestedExpose({ instanceId: '2:3', exposed: true, json: false }, {
    evaluate: evaluate(live.figma),
  });
  assert.equal(unchanged.result.status, 'unchanged');
  const hidden = await executeComponentNestedExpose({ instanceId: '2:3', exposed: false, json: false }, {
    evaluate: evaluate(live.figma),
  });
  assert.equal(hidden.result.status, 'hidden');
  assert.equal(live.value(), false);
  assert.equal(live.writes(), 2);
});

test('inherited instances refuse and setter failures roll back', async () => {
  const inherited = fixture({ inherited: true });
  await assert.rejects(() => executeComponentNestedExpose({ instanceId: '2:3', exposed: true, json: false }, {
    evaluate: evaluate(inherited.figma),
  }), (error) => error.mutationOutcome === 'no-mutation');
  assert.equal(inherited.writes(), 0);

  const failing = fixture({ throwAfterSet: true });
  await assert.rejects(() => executeComponentNestedExpose({ instanceId: '2:3', exposed: true, json: false }, {
    evaluate: evaluate(failing.figma),
  }), (error) => {
    assert.equal(error.mutationOutcome, 'rolled-back');
    assert.equal(error.mutationReport.residueCount, 0);
    return true;
  });
  assert.equal(failing.value(), false);
  assert.equal(failing.writes(), 2);
});

test('one authentic non-retrying component.nested.expose plan crosses the Application Seam', async () => {
  const plan = planFigmaCommand([
    'component', 'nested', 'expose', '2:3', 'true', '--json',
  ], { adapter: 'mcp', fileKey: 'FILEA' });
  assert.equal(plan.id, 'component.nested.expose');
  assert.equal(plan.allowed, true);
  assert.equal(plan.effects.figma, 'write');
  assert.equal(plan.execution.retry, 'never');
  assert.equal(componentNestedExposePlanRoute(plan), 'command-application');
  assert.throws(() => componentNestedExposePlanRoute({ ...plan }), /requires a Command Plan/);
  const live = fixture();
  let evaluations = 0;
  const result = await executeComponentNestedExposePlan(plan, {
    evaluate: async (code) => { evaluations += 1; return evaluate(live.figma)(code); },
  });
  assert.equal(result.result.status, 'exposed');
  assert.equal(evaluations, 1);
});
