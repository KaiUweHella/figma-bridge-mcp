import assert from 'node:assert/strict';
import test from 'node:test';
import { planFigmaCommand } from '../../src/capability-catalog.js';
import {
  componentPropertyDeleteArgvFromRequest,
  componentPropertyDeleteCode,
  componentPropertyDeletePlanRoute,
  componentPropertyDeletePlanningArgvFromRequest,
  executeComponentPropertyDelete,
  executeComponentPropertyDeletePlan,
  formatComponentPropertyDeleteResult,
} from '../src/application/component-property-delete-command.js';
import { parseComponentPropertyDeleteRequest } from '../src/application/component-property-delete-request.js';

function fixture({
  remote = false,
  type = 'COMPONENT',
  throwAfterDelete = false,
  noEffect = false,
  cascade = false,
  failFreshRead = false,
} = {}) {
  let getCalls = 0;
  let deleteCalls = 0;
  const definitions = {
    'Delete me#2:0': { type: 'TEXT', defaultValue: 'Gone' },
    'Keep me#2:1': { type: 'BOOLEAN', defaultValue: true },
  };
  const component = {
    id: '2:1', type, name: 'Fixture component', remote,
    get componentPropertyDefinitions() { return definitions; },
    deleteComponentProperty(name) {
      deleteCalls += 1;
      if (!noEffect) delete definitions[name];
      if (cascade) delete definitions['Keep me#2:1'];
      if (throwAfterDelete) throw new Error('injected delete acknowledgement failure');
    },
  };
  return {
    definitions,
    component,
    figma: {
      getNodeByIdAsync: async (id) => {
        getCalls += 1;
        if (failFreshRead && getCalls > 1) throw new Error('injected fresh-read failure');
        return id === component.id ? component : null;
      },
    },
    deleteCalls: () => deleteCalls,
  };
}

const evaluate = (figma) => async (code) => new Function('figma', `return ${code};`)(figma);
const request = (overrides = {}) => ({
  componentId: '2:1', propName: 'Delete me#2:0', json: false, ...overrides,
});

test('Component Property Delete request closes exact names, literals and URL targeting', () => {
  assert.deepEqual(parseComponentPropertyDeleteRequest([
    'component', 'prop', 'delete', '2-1', 'Delete me#2:0', '--json',
  ]), { componentId: '2:1', propName: 'Delete me#2:0', json: true });
  assert.deepEqual(componentPropertyDeleteArgvFromRequest(request({
    propName: '--private-name', json: true,
  })), ['component', 'prop', 'delete', '2:1', '--json', '--', '--private-name']);

  const url = 'https://www.figma.com/design/FILEA/Test?node-id=2-1';
  assert.deepEqual(componentPropertyDeletePlanningArgvFromRequest(request({ componentId: url })), [
    'component', 'prop', 'delete', url, 'Delete me#2:0',
  ]);
  const plan = planFigmaCommand([
    'component', 'prop', 'delete', url, 'Delete me#2:0',
  ], { adapter: 'mcp' });
  assert.equal(plan.target.fileKey, 'FILEA');
  assert.equal(plan.argv[3], '2:1');

  for (const argv of [
    ['component', 'prop', 'delete'],
    ['component', 'prop', 'delete', '2:1'],
    ['component', 'prop', 'delete', 'bad', 'Delete me#2:0'],
    ['component', 'prop', 'delete', '2:1', 'Delete me#2:0', 'extra'],
    ['component', 'prop', 'delete', '2:1', 'Delete me#2:0', '--future'],
  ]) assert.throws(() => parseComponentPropertyDeleteRequest(argv), /Invalid component prop delete command/);
});

test('exact deletion preserves every sibling definition and freshly verifies absence', async () => {
  const live = fixture();
  const result = await executeComponentPropertyDelete(request(), { evaluate: evaluate(live.figma) });
  assert.equal(result.result.status, 'deleted');
  assert.equal(result.result.outcome, 'verified');
  assert.deepEqual(result.result.property, {
    name: 'Delete me#2:0', type: 'TEXT', defaultValue: 'Gone',
  });
  assert.deepEqual(Object.keys(live.definitions), ['Keep me#2:1']);
  assert.equal(live.deleteCalls(), 1);
});

test('a thrown delete acknowledgement becomes success only after exact desired readback', async () => {
  const live = fixture({ throwAfterDelete: true });
  const result = await executeComponentPropertyDelete(request({ json: true }), {
    evaluate: evaluate(live.figma),
  });
  assert.equal(result.result.outcome, 'verified-after-error');
  assert.equal(result.result.warnings.length, 1);
  assert.equal(JSON.parse(result.stdout).status, 'deleted');
  assert.deepEqual(Object.keys(live.definitions), ['Keep me#2:1']);
});

test('missing, remote and non-component targets refuse before deletion', async () => {
  const cases = [
    [fixture(), request({ propName: 'Missing#2:9' })],
    [fixture({ remote: true }), request()],
    [fixture({ type: 'FRAME' }), request()],
  ];
  for (const [live, input] of cases) {
    await assert.rejects(() => executeComponentPropertyDelete(input, {
      evaluate: evaluate(live.figma),
    }), (error) => {
      assert.equal(error.mutationOutcome, 'no-mutation');
      assert.equal(error.mutationReport.attempted, 0);
      return true;
    });
    assert.equal(live.deleteCalls(), 0);
  }
});

test('a retained target reports unchanged rather than pretending deletion', async () => {
  const live = fixture({ noEffect: true });
  await assert.rejects(() => executeComponentPropertyDelete(request(), {
    evaluate: evaluate(live.figma),
  }), (error) => {
    assert.equal(error.mutationOutcome, 'unchanged');
    assert.deepEqual(error.mutationReport, {
      version: 1, outcome: 'unchanged', attempted: 1, restored: 0, residueCount: 1,
    });
    return true;
  });
  assert.equal(live.deleteCalls(), 1);
});

test('unexpected sibling loss reports irreversible partial residue', async () => {
  const live = fixture({ cascade: true });
  await assert.rejects(() => executeComponentPropertyDelete(request(), {
    evaluate: evaluate(live.figma),
  }), (error) => {
    assert.equal(error.mutationOutcome, 'partial-residue');
    assert.equal(error.mutationReport.residueCount, 1);
    return true;
  });
  assert.deepEqual(Object.keys(live.definitions), []);
});

test('failed fresh read reports verification unavailable without retrying', async () => {
  const live = fixture({ failFreshRead: true });
  await assert.rejects(() => executeComponentPropertyDelete(request(), {
    evaluate: evaluate(live.figma),
  }), (error) => {
    assert.equal(error.mutationOutcome, 'verification-unavailable');
    assert.equal(error.mutationReport.attempted, 1);
    return true;
  });
  assert.equal(live.deleteCalls(), 1);
});

test('generated deletion code keeps hostile full names as data', async () => {
  const live = fixture();
  const propName = '__proto__`); globalThis.COMPONENT_DELETE_INJECTED = true; //#2:0';
  live.definitions[propName] = { type: 'TEXT', defaultValue: 'private payload' };
  const code = componentPropertyDeleteCode(request({ propName }));
  assert.doesNotThrow(() => new Function('figma', `return ${code};`));
  delete globalThis.COMPONENT_DELETE_INJECTED;
  const result = await executeComponentPropertyDelete(request({ propName }), {
    evaluate: evaluate(live.figma),
  });
  assert.equal(result.result.status, 'deleted');
  assert.equal(globalThis.COMPONENT_DELETE_INJECTED, undefined);
});

test('only one authentic component.prop.delete plan crosses the Application Seam', async () => {
  const plan = planFigmaCommand([
    'component', 'prop', 'delete', '2:1', 'Delete me#2:0', '--json',
  ], { adapter: 'mcp', fileKey: 'FILEA' });
  assert.equal(plan.id, 'component.prop.delete');
  assert.equal(plan.allowed, true);
  assert.equal(componentPropertyDeletePlanRoute(plan), 'command-application');
  assert.throws(() => componentPropertyDeletePlanRoute({ ...plan }), /requires a Command Plan/);
  const live = fixture();
  let evaluations = 0;
  const result = await executeComponentPropertyDeletePlan(plan, {
    evaluate: async (code) => { evaluations += 1; return evaluate(live.figma)(code); },
  });
  assert.equal(result.result.status, 'deleted');
  assert.equal(evaluations, 1);
});

test('malformed Plugin results cannot become successful deletion', async () => {
  for (const value of [null, {}, 'not-json', JSON.stringify({ status: 'deleted' })]) {
    await assert.rejects(() => executeComponentPropertyDelete(request(), {
      evaluate: async () => value,
    }), /invalid/i);
  }
});

test('human formatting escapes control-bearing component and property names', () => {
  const text = formatComponentPropertyDeleteResult({
    component: { id: '2:1', name: 'Component\u202e' },
    property: { name: 'Label\u0000', type: 'TEXT', defaultValue: 'Value' },
    warnings: [],
  });
  assert.doesNotMatch(text, /\u202e|\u0000/u);
  assert.match(text, /\\u202e|\\u0000/);
});
