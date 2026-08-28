import assert from 'node:assert/strict';
import test from 'node:test';
import { planFigmaCommand } from '../../src/capability-catalog.js';
import {
  componentOverridesArgvFromRequest,
  componentOverridesCode,
  componentOverridesPlanRoute,
  componentOverridesPlanningArgvFromRequest,
  executeComponentOverrides,
  executeComponentOverridesPlan,
  formatComponentOverridesResult,
} from '../src/application/component-overrides-command.js';
import { parseComponentOverridesRequest } from '../src/application/component-overrides-request.js';

function fixture({
  instanceType = 'INSTANCE',
  overrideCount = 2,
  noEffect = false,
  partial = false,
  throwAfterRemoval = false,
  failFreshRead = false,
  removeInstance = false,
  changeMain = false,
} = {}) {
  let getCalls = 0;
  let removeCalls = 0;
  const main = { id: '2:1', type: 'COMPONENT', name: 'Main' };
  const otherMain = { id: '2:2', type: 'COMPONENT', name: 'Other' };
  const parent = { id: '1:1', type: 'FRAME' };
  let present = true;
  const directOverrides = Array.from({ length: overrideCount }, (_, index) => ({
    id: `4:${index + 1}`,
    overriddenFields: index % 2 === 0 ? ['characters', 'visible'] : ['fills'],
  }));
  const instance = {
    id: '3:1', type: instanceType, name: 'Fixture instance', parent,
    overrides: directOverrides,
    async getMainComponentAsync() { return changeMain && removeCalls > 0 ? otherMain : main; },
    removeOverrides() {
      removeCalls += 1;
      if (removeInstance) present = false;
      else if (partial) this.overrides = this.overrides.slice(-1);
      else if (!noEffect) this.overrides = [];
      if (throwAfterRemoval) throw new Error('injected remove acknowledgement failure');
    },
  };
  return {
    figma: {
      getNodeByIdAsync: async (id) => {
        getCalls += 1;
        if (failFreshRead && getCalls > 1) throw new Error('injected fresh-read failure');
        return id === instance.id && present ? instance : null;
      },
    },
    instance,
    removeCalls: () => removeCalls,
  };
}

const evaluate = (figma) => async (code) => new Function('figma', `return ${code};`)(figma);
const request = (overrides = {}) => ({
  instanceId: '3:1', action: 'remove', json: false, ...overrides,
});

test('Component Overrides request closes URL target, both actions and output mode', () => {
  assert.deepEqual(parseComponentOverridesRequest([
    'component', 'overrides', '3-1', 'RESET', '--json',
  ]), { instanceId: '3:1', action: 'reset', json: true });
  assert.deepEqual(componentOverridesArgvFromRequest(request({ action: 'REMOVE', json: true })), [
    'component', 'overrides', '3:1', 'remove', '--json',
  ]);
  const url = 'https://www.figma.com/design/FILEA/Test?node-id=3-1';
  assert.deepEqual(componentOverridesPlanningArgvFromRequest(request({ instanceId: url })), [
    'component', 'overrides', url, 'remove',
  ]);
  const plan = planFigmaCommand([
    'component', 'overrides', url, 'reset',
  ], { adapter: 'mcp' });
  assert.equal(plan.target.fileKey, 'FILEA');
  assert.equal(plan.argv[2], '3:1');
  for (const argv of [
    ['component', 'overrides'],
    ['component', 'overrides', 'bad', 'reset'],
    ['component', 'overrides', '3:1'],
    ['component', 'overrides', '3:1', 'clear'],
    ['component', 'overrides', '3:1', 'remove', 'extra'],
    ['component', 'overrides', '3:1', 'remove', '--future'],
    ['component', 'overrides', '3:1', 'remove', '--json', '--json'],
  ]) assert.throws(() => parseComponentOverridesRequest(argv), /Invalid component overrides command/);
});

for (const action of ['reset', 'remove']) {
  test(`${action} preserves the public alias and clears all direct overrides once`, async () => {
    const live = fixture();
    const result = await executeComponentOverrides(request({ action }), {
      evaluate: evaluate(live.figma),
    });
    assert.equal(result.result.action, action);
    assert.equal(result.result.status, 'cleared');
    assert.equal(result.result.previous.overrideCount, 2);
    assert.equal(result.result.current.overrideCount, 0);
    assert.equal(result.result.attempted, 1);
    assert.equal(live.removeCalls(), 1);
  });
}

test('zero direct overrides are a verified no-op without native dispatch', async () => {
  const live = fixture({ overrideCount: 0 });
  const result = await executeComponentOverrides(request({ action: 'reset' }), {
    evaluate: evaluate(live.figma),
  });
  assert.equal(result.result.attempted, 0);
  assert.equal(result.result.previous.overrideCount, 0);
  assert.equal(live.removeCalls(), 0);
});

test('a thrown acknowledgement becomes success only after fresh zero-override proof', async () => {
  const live = fixture({ throwAfterRemoval: true });
  const result = await executeComponentOverrides(request(), {
    evaluate: evaluate(live.figma),
  });
  assert.equal(result.result.outcome, 'verified-after-error');
  assert.equal(result.result.warnings.length, 1);
  assert.equal(live.removeCalls(), 1);
});

test('wrong target refuses before native dispatch', async () => {
  const live = fixture({ instanceType: 'FRAME' });
  await assert.rejects(() => executeComponentOverrides(request(), {
    evaluate: evaluate(live.figma),
  }), (error) => {
    assert.equal(error.mutationOutcome, 'no-mutation');
    assert.equal(error.mutationReport.attempted, 0);
    return true;
  });
  assert.equal(live.removeCalls(), 0);
});

test('an ineffective native call reports unchanged without retrying', async () => {
  const live = fixture({ noEffect: true });
  await assert.rejects(() => executeComponentOverrides(request(), {
    evaluate: evaluate(live.figma),
  }), (error) => {
    assert.equal(error.mutationOutcome, 'unchanged');
    assert.equal(error.mutationReport.attempted, 1);
    assert.equal(error.mutationReport.residueCount, 2);
    return true;
  });
  assert.equal(live.removeCalls(), 1);
});

test('remaining overrides and changed identity relations report partial residue', async () => {
  for (const options of [
    { partial: true },
    { removeInstance: true },
    { changeMain: true },
  ]) {
    const live = fixture(options);
    await assert.rejects(() => executeComponentOverrides(request(), {
      evaluate: evaluate(live.figma),
    }), (error) => {
      assert.equal(error.mutationOutcome, 'partial-residue');
      assert.equal(error.mutationReport.residueCount, 1);
      return true;
    });
    assert.equal(live.removeCalls(), 1);
  }
});

test('failed fresh read reports verification unavailable without retrying', async () => {
  const live = fixture({ failFreshRead: true });
  await assert.rejects(() => executeComponentOverrides(request(), {
    evaluate: evaluate(live.figma),
  }), (error) => {
    assert.equal(error.mutationOutcome, 'verification-unavailable');
    return true;
  });
  assert.equal(live.removeCalls(), 1);
});

test('generated code uses only current removeOverrides and bounds snapshots and result', () => {
  const code = componentOverridesCode(request({ action: 'reset' }));
  assert.match(code, /instance\.removeOverrides\(\)/);
  assert.doesNotMatch(code, /resetOverrides/);
  assert.match(code, /Instance overrides exceed their bounded count/);
  assert.match(code, /Component Overrides result exceeded the bounded response limit/);
});

test('formatting safely preserves bounded Figma names and JSON action evidence', async () => {
  const live = fixture();
  live.instance.name = 'Name\u001b[31m';
  const result = await executeComponentOverrides(request({ action: 'reset', json: true }), {
    evaluate: evaluate(live.figma),
  });
  assert.match(result.stdout, /"action": "reset"/);
  assert.doesNotMatch(result.stdout, /\u001b/);
  assert.match(formatComponentOverridesResult(result.result), /Reset direct overrides/);
});

test('Component Overrides plan route requires one authentic Plan and never retries', async () => {
  const plan = planFigmaCommand([
    'component', 'overrides', '3:1', 'remove', '--json',
  ], { adapter: 'mcp', fileKey: 'FILEA' });
  assert.equal(componentOverridesPlanRoute(plan), 'command-application');
  assert.equal(plan.id, 'component.overrides');
  assert.equal(plan.effects.figma, 'write');
  assert.equal(plan.execution.retry, 'never');
  const live = fixture();
  const result = await executeComponentOverridesPlan(plan, { evaluate: evaluate(live.figma) });
  assert.equal(result.result.status, 'cleared');
  assert.throws(() => componentOverridesPlanRoute({ id: 'component.overrides' }), /Command Plan/);
});

test('invalid and oversized result envelopes are rejected after dispatch', async () => {
  await assert.rejects(() => executeComponentOverrides(request(), {
    evaluate: async () => '{bad',
  }), /invalid JSON/);
  await assert.rejects(() => executeComponentOverrides(request(), {
    evaluate: async () => 'x'.repeat(32_769),
  }), (error) => error.outcome === 'unknown-after-dispatch');
});
