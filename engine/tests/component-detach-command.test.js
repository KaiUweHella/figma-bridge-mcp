import assert from 'node:assert/strict';
import test from 'node:test';
import { planFigmaCommand } from '../../src/capability-catalog.js';
import {
  componentDetachArgvFromRequest,
  componentDetachCode,
  componentDetachPlanRoute,
  componentDetachPlanningArgvFromRequest,
  executeComponentDetach,
  executeComponentDetachPlan,
  formatComponentDetachResult,
} from '../src/application/component-detach-command.js';
import { parseComponentDetachRequest } from '../src/application/component-detach-request.js';

function fixture({
  instanceType = 'INSTANCE',
  noEffect = false,
  throwAfterDetach = false,
  failFreshRead = false,
  replacementId = null,
  ignoreName = false,
} = {}) {
  let getCalls = 0;
  let detachCalls = 0;
  const main = { id: '2:1', type: 'COMPONENT', name: 'Main' };
  const parent = { id: '1:1', type: 'FRAME', children: [] };
  const instance = {
    id: '3:1', type: instanceType, name: 'Fixture instance', parent,
    overrides: [{ id: '4:1', overriddenFields: ['characters'] }],
    async getMainComponentAsync() { return main; },
    detachInstance() {
      detachCalls += 1;
      if (noEffect) {
        if (throwAfterDetach) throw new Error('injected detach failure');
        return instance;
      }
      const frame = replacementId ? {
        id: replacementId, type: 'FRAME', name: instance.name, parent, children: [{ id: '4:1' }],
      } : instance;
      if (!replacementId) {
        frame.type = 'FRAME';
        frame.children = [{ id: '4:1' }];
      } else {
        parent.children.splice(parent.children.indexOf(instance), 1, frame);
      }
      if (ignoreName) {
        Object.defineProperty(frame, 'name', { value: frame.name, writable: false, configurable: true });
      }
      if (throwAfterDetach) throw new Error('injected detach acknowledgement failure');
      return frame;
    },
  };
  parent.children.push(instance);
  const nodeById = (id) => {
    if (id === parent.id) return parent;
    return parent.children.find((node) => node.id === id) || null;
  };
  return {
    figma: {
      getNodeByIdAsync: async (id) => {
        getCalls += 1;
        if (failFreshRead && getCalls > 1) throw new Error('injected fresh-read failure');
        return nodeById(id);
      },
    },
    detachCalls: () => detachCalls,
    parent,
  };
}

const evaluate = (figma) => async (code) => new Function('figma', `return ${code};`)(figma);
const request = (overrides = {}) => ({
  instanceId: '3:1', name: 'Detached frame', json: false, ...overrides,
});

test('Component Detach request closes URL target, optional name and output mode', () => {
  assert.deepEqual(parseComponentDetachRequest([
    'component', 'detach', '3-1', '--name=Detached frame', '--json',
  ]), { instanceId: '3:1', name: 'Detached frame', json: true });
  assert.deepEqual(componentDetachArgvFromRequest(request({ name: '', json: true })), [
    'component', 'detach', '3:1', '--json',
  ]);
  const url = 'https://www.figma.com/design/FILEA/Test?node-id=3-1';
  assert.deepEqual(componentDetachPlanningArgvFromRequest(request({ instanceId: url })), [
    'component', 'detach', url, '--name=Detached frame',
  ]);
  const plan = planFigmaCommand([
    'component', 'detach', url, '--name=Detached frame',
  ], { adapter: 'mcp' });
  assert.equal(plan.target.fileKey, 'FILEA');
  assert.equal(plan.argv[2], '3:1');
  for (const argv of [
    ['component', 'detach'],
    ['component', 'detach', 'bad'],
    ['component', 'detach', '3:1', 'extra'],
    ['component', 'detach', '3:1', '--name'],
    ['component', 'detach', '3:1', '--future'],
    ['component', 'detach', '3:1', '--json', '--json'],
  ]) assert.throws(() => parseComponentDetachRequest(argv), /Invalid component detach command/);
});

test('native same-identity detach is freshly verified with parent membership and rename', async () => {
  const live = fixture();
  const result = await executeComponentDetach(request(), { evaluate: evaluate(live.figma) });
  assert.equal(result.result.status, 'detached');
  assert.equal(result.result.frame.id, '3:1');
  assert.equal(result.result.frame.name, 'Detached frame');
  assert.equal(result.result.previous.overrideCount, 1);
  assert.equal(live.detachCalls(), 1);
});

test('replacement-identity detach is accepted only at the exact parent index', async () => {
  const live = fixture({ replacementId: '3:2' });
  const result = await executeComponentDetach(request({ name: null }), {
    evaluate: evaluate(live.figma),
  });
  assert.equal(result.result.frame.id, '3:2');
  assert.equal(result.result.frame.index, 0);
  assert.deepEqual(live.parent.children.map((node) => node.id), ['3:2']);
});

test('a thrown detach acknowledgement becomes success only after exact desired readback', async () => {
  const live = fixture({ throwAfterDetach: true });
  const result = await executeComponentDetach(request({ name: null }), {
    evaluate: evaluate(live.figma),
  });
  assert.equal(result.result.outcome, 'verified-after-error');
  assert.equal(result.result.warnings.length, 1);
  assert.equal(live.detachCalls(), 1);
});

test('wrong target refuses before native detach', async () => {
  const live = fixture({ instanceType: 'FRAME' });
  await assert.rejects(() => executeComponentDetach(request(), {
    evaluate: evaluate(live.figma),
  }), (error) => {
    assert.equal(error.mutationOutcome, 'no-mutation');
    assert.equal(error.mutationReport.attempted, 0);
    return true;
  });
  assert.equal(live.detachCalls(), 0);
});

test('an ineffective detach reports unchanged without retrying', async () => {
  const live = fixture({ noEffect: true });
  await assert.rejects(() => executeComponentDetach(request(), {
    evaluate: evaluate(live.figma),
  }), (error) => {
    assert.equal(error.mutationOutcome, 'unchanged');
    assert.equal(error.mutationReport.attempted, 1);
    return true;
  });
  assert.equal(live.detachCalls(), 1);
});

test('a detached Frame with an unfulfilled rename reports irreversible residue', async () => {
  const live = fixture({ ignoreName: true });
  await assert.rejects(() => executeComponentDetach(request(), {
    evaluate: evaluate(live.figma),
  }), (error) => {
    assert.equal(error.mutationOutcome, 'partial-residue');
    assert.equal(error.mutationReport.residueCount, 1);
    return true;
  });
  assert.equal(live.detachCalls(), 1);
  assert.equal(live.parent.children[0].type, 'FRAME');
});

test('failed fresh read reports verification unavailable without retrying', async () => {
  const live = fixture({ failFreshRead: true });
  await assert.rejects(() => executeComponentDetach(request(), {
    evaluate: evaluate(live.figma),
  }), (error) => {
    assert.equal(error.mutationOutcome, 'verification-unavailable');
    return true;
  });
  assert.equal(live.detachCalls(), 1);
});

test('generated detach code keeps hostile names inert and never recreates an Instance', () => {
  const name = '`); globalThis.DETACH_INJECTED = true; //\u202e';
  const code = componentDetachCode(request({ name }));
  assert.doesNotThrow(() => new Function('figma', `return ${code};`));
  assert.doesNotMatch(code, /createInstance\(/);
});

test('an explicitly requested control-bearing Figma name stays exact but formats safely', async () => {
  const name = 'Detached\u202e frame';
  const live = fixture();
  const result = await executeComponentDetach(request({ name }), { evaluate: evaluate(live.figma) });
  assert.equal(result.result.frame.name, name);
  assert.doesNotMatch(result.stdout, /\u202e/u);
  assert.match(result.stdout, /\\u202e/);
});

test('only one authentic component.detach Plan crosses the Application Seam', async () => {
  const plan = planFigmaCommand([
    'component', 'detach', '3:1', '--name=Detached frame', '--json',
  ], { adapter: 'mcp', fileKey: 'FILEA' });
  assert.equal(plan.id, 'component.detach');
  assert.equal(plan.allowed, true);
  assert.equal(plan.execution.retry, 'never');
  assert.equal(componentDetachPlanRoute(plan), 'command-application');
  assert.throws(() => componentDetachPlanRoute({ ...plan }), /requires a Command Plan/);
  const live = fixture();
  let evaluations = 0;
  const result = await executeComponentDetachPlan(plan, {
    evaluate: async (code) => { evaluations += 1; return evaluate(live.figma)(code); },
  });
  assert.equal(result.result.status, 'detached');
  assert.equal(evaluations, 1);
});

test('malformed Plugin results cannot become successful detach results', async () => {
  for (const value of [null, {}, 'not-json', JSON.stringify({ status: 'detached' })]) {
    await assert.rejects(() => executeComponentDetach(request(), {
      evaluate: async () => value,
    }), /invalid/i);
  }
});

test('human formatting escapes control-bearing names', () => {
  const text = formatComponentDetachResult({
    frame: { id: '3:1', name: 'Detached\u202e', parentId: '1:1', index: 0 },
    warnings: [],
  });
  assert.doesNotMatch(text, /\u202e/u);
  assert.match(text, /\\u202e/);
});
