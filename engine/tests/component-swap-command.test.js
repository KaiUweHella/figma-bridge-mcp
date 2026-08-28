import assert from 'node:assert/strict';
import test from 'node:test';
import { planFigmaCommand } from '../../src/capability-catalog.js';
import {
  componentSwapArgvFromRequest,
  componentSwapCode,
  componentSwapPlanRoute,
  componentSwapPlanningArgvFromRequest,
  executeComponentSwap,
  executeComponentSwapPlan,
  formatComponentSwapResult,
} from '../src/application/component-swap-command.js';
import { parseComponentSwapRequest } from '../src/application/component-swap-request.js';

function fixture({
  instanceType = 'INSTANCE',
  componentType = 'COMPONENT',
  targetRemote = true,
  currentId = '2:1',
  noEffect = false,
  unexpected = false,
  throwAfterSwap = false,
  failFreshRead = false,
} = {}) {
  let getCalls = 0;
  let swapCalls = 0;
  const previous = { id: '2:1', type: 'COMPONENT', name: 'Previous', remote: false };
  const target = { id: '2:2', type: componentType, name: 'Target', remote: targetRemote };
  const other = { id: '2:3', type: 'COMPONENT', name: 'Unexpected', remote: false };
  let main = currentId === target.id ? target : previous;
  const instance = {
    id: '3:1', type: instanceType, name: 'Fixture instance',
    async getMainComponentAsync() { return main; },
    swapComponent(component) {
      swapCalls += 1;
      if (!noEffect) main = unexpected ? other : component;
      if (throwAfterSwap) throw new Error('injected swap acknowledgement failure');
    },
  };
  return {
    figma: {
      getNodeByIdAsync: async (id) => {
        getCalls += 1;
        if (failFreshRead && getCalls > 2 && id === instance.id) {
          throw new Error('injected fresh-read failure');
        }
        if (id === instance.id) return instance;
        if (id === target.id) return target;
        return null;
      },
    },
    swapCalls: () => swapCalls,
    main: () => main,
  };
}

const evaluate = (figma) => async (code) => new Function('figma', `return ${code};`)(figma);
const request = (overrides = {}) => ({
  instanceId: '3:1', componentId: '2:2', json: false, ...overrides,
});

test('Component Swap request closes both references, output mode and same-file URL targeting', () => {
  assert.deepEqual(parseComponentSwapRequest([
    'component', 'swap', '3-1', '2-2', '--json',
  ]), { instanceId: '3:1', componentId: '2:2', json: true });
  assert.deepEqual(componentSwapArgvFromRequest(request({ json: true })), [
    'component', 'swap', '3:1', '2:2', '--json',
  ]);

  const instanceUrl = 'https://www.figma.com/design/FILEA/Test?node-id=3-1';
  const componentUrl = 'https://www.figma.com/design/FILEA/Test?node-id=2-2';
  assert.deepEqual(componentSwapPlanningArgvFromRequest(request({
    instanceId: instanceUrl, componentId: componentUrl,
  })), ['component', 'swap', instanceUrl, componentUrl]);
  const plan = planFigmaCommand(['component', 'swap', instanceUrl, componentUrl], { adapter: 'mcp' });
  assert.equal(plan.target.fileKey, 'FILEA');
  assert.deepEqual(plan.argv, ['component', 'swap', '3:1', '2:2']);

  assert.throws(() => componentSwapPlanningArgvFromRequest(request({
    instanceId: instanceUrl,
    componentId: 'https://www.figma.com/design/FILEB/Test?node-id=2-2',
  })), /multiple Figma files/);
  for (const argv of [
    ['component', 'swap'],
    ['component', 'swap', '3:1'],
    ['component', 'swap', 'bad', '2:2'],
    ['component', 'swap', '3:1', 'bad'],
    ['component', 'swap', '3:1', '2:2', 'extra'],
    ['component', 'swap', '3:1', '2:2', '--future'],
    ['component', 'swap', '3:1', '2:2', '--json', '--json'],
  ]) assert.throws(() => parseComponentSwapRequest(argv), /Invalid component swap command/);
});

test('one native swap accepts a library-backed target and freshly verifies it', async () => {
  const live = fixture({ targetRemote: true });
  const result = await executeComponentSwap(request(), { evaluate: evaluate(live.figma) });
  assert.equal(result.result.status, 'swapped');
  assert.equal(result.result.outcome, 'verified');
  assert.equal(result.result.component.remote, true);
  assert.equal(live.main().id, '2:2');
  assert.equal(live.swapCalls(), 1);
});

test('an already active Component is a proven no-op', async () => {
  const live = fixture({ currentId: '2:2' });
  const result = await executeComponentSwap(request({ json: true }), {
    evaluate: evaluate(live.figma),
  });
  assert.equal(result.result.status, 'unchanged');
  assert.equal(result.result.attempted, 0);
  assert.equal(JSON.parse(result.stdout).component.id, '2:2');
  assert.equal(live.swapCalls(), 0);
});

test('a thrown swap acknowledgement becomes success only after exact desired readback', async () => {
  const live = fixture({ throwAfterSwap: true });
  const result = await executeComponentSwap(request(), { evaluate: evaluate(live.figma) });
  assert.equal(result.result.outcome, 'verified-after-error');
  assert.equal(result.result.warnings.length, 1);
  assert.equal(live.swapCalls(), 1);
});

test('invalid Instance or Component targets refuse before mutation', async () => {
  for (const live of [fixture({ instanceType: 'FRAME' }), fixture({ componentType: 'FRAME' })]) {
    await assert.rejects(() => executeComponentSwap(request(), {
      evaluate: evaluate(live.figma),
    }), (error) => {
      assert.equal(error.mutationOutcome, 'no-mutation');
      assert.equal(error.mutationReport.attempted, 0);
      return true;
    });
    assert.equal(live.swapCalls(), 0);
  }
});

test('an ineffective swap reports unchanged without retrying', async () => {
  const live = fixture({ noEffect: true });
  await assert.rejects(() => executeComponentSwap(request(), {
    evaluate: evaluate(live.figma),
  }), (error) => {
    assert.equal(error.mutationOutcome, 'unchanged');
    assert.deepEqual(error.mutationReport, {
      version: 1, outcome: 'unchanged', attempted: 1, restored: 0, residueCount: 1,
    });
    return true;
  });
  assert.equal(live.swapCalls(), 1);
});

test('an unexpected main Component reports partial residue without swap-back', async () => {
  const live = fixture({ unexpected: true });
  await assert.rejects(() => executeComponentSwap(request(), {
    evaluate: evaluate(live.figma),
  }), (error) => {
    assert.equal(error.mutationOutcome, 'partial-residue');
    assert.equal(error.mutationReport.residueCount, 1);
    return true;
  });
  assert.equal(live.main().id, '2:3');
  assert.equal(live.swapCalls(), 1);
});

test('failed fresh read reports verification unavailable without retrying', async () => {
  const live = fixture({ failFreshRead: true });
  await assert.rejects(() => executeComponentSwap(request(), {
    evaluate: evaluate(live.figma),
  }), (error) => {
    assert.equal(error.mutationOutcome, 'verification-unavailable');
    assert.equal(error.mutationReport.attempted, 1);
    return true;
  });
  assert.equal(live.swapCalls(), 1);
});

test('generated swap code keeps hostile ids as inert data', () => {
  const code = componentSwapCode(request());
  assert.doesNotThrow(() => new Function('figma', `return ${code};`));
  assert.doesNotMatch(code, /instance\.mainComponent\s*=/);
});

test('only one authentic component.swap Plan crosses the Application Seam', async () => {
  const plan = planFigmaCommand([
    'component', 'swap', '3:1', '2:2', '--json',
  ], { adapter: 'mcp', fileKey: 'FILEA' });
  assert.equal(plan.id, 'component.swap');
  assert.equal(plan.allowed, true);
  assert.equal(plan.execution.retry, 'never');
  assert.equal(componentSwapPlanRoute(plan), 'command-application');
  assert.throws(() => componentSwapPlanRoute({ ...plan }), /requires a Command Plan/);
  const live = fixture();
  let evaluations = 0;
  const result = await executeComponentSwapPlan(plan, {
    evaluate: async (code) => { evaluations += 1; return evaluate(live.figma)(code); },
  });
  assert.equal(result.result.status, 'swapped');
  assert.equal(evaluations, 1);
});

test('malformed Plugin results cannot become successful swaps', async () => {
  for (const value of [null, {}, 'not-json', JSON.stringify({ status: 'swapped' })]) {
    await assert.rejects(() => executeComponentSwap(request(), {
      evaluate: async () => value,
    }), /invalid/i);
  }
});

test('human formatting escapes control-bearing names', () => {
  const text = formatComponentSwapResult({
    status: 'swapped',
    instance: { id: '3:1', name: 'Instance\u202e', type: 'INSTANCE' },
    component: { id: '2:2', name: 'Target\u0000', remote: false },
    warnings: [],
  });
  assert.doesNotMatch(text, /\u202e|\u0000/u);
  assert.match(text, /\\u202e|\\u0000/);
});
