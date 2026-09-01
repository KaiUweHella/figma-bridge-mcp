import assert from 'node:assert/strict';
import test from 'node:test';
import { planFigmaCommand } from '../../src/capability-catalog.js';
import {
  executeNodeResize,
  executeNodeResizePlan,
  nodeResizeArgvFromRequest,
  nodeResizeCode,
  nodeResizePlanRoute,
  nodeResizePlanningArgvFromRequest,
} from '../src/application/node-resize-command.js';
import { parseNodeResizeRequest } from '../src/application/node-resize-request.js';

function fixture({
  width = 100, height = 50, sizingHorizontal = 'FIXED', sizingVertical = 'FIXED',
  layoutMode = 'NONE', parentLayoutMode = 'NONE', resizeMode = 'normal',
  rollbackMode = 'normal', missing = false, readFailures = [],
} = {}) {
  const state = { width, height, sizingHorizontal, sizingVertical };
  let resizeCalls = 0;
  let reads = 0;
  const node = {
    id: '3:1', type: 'FRAME', name: 'Card', layoutMode,
    parent: { id: '2:1', layoutMode: parentLayoutMode },
    get width() { return state.width; },
    get height() { return state.height; },
    get layoutSizingHorizontal() { return state.sizingHorizontal; },
    set layoutSizingHorizontal(value) { state.sizingHorizontal = value; },
    get layoutSizingVertical() { return state.sizingVertical; },
    set layoutSizingVertical(value) { state.sizingVertical = value; },
    resize(nextWidth, nextHeight) {
      resizeCalls += 1;
      const rollback = nextWidth === width && nextHeight === height;
      if (rollback && rollbackMode === 'no-effect') return;
      if (!rollback && resizeMode === 'no-effect') return;
      state.width = nextWidth;
      state.height = !rollback && resizeMode === 'wrong-height' ? nextHeight + 1 : nextHeight;
      if (!rollback && resizeMode === 'throw-after') throw new Error('injected acknowledgement failure');
    },
  };
  return {
    node, state, get resizeCalls() { return resizeCalls; },
    figma: { async getNodeByIdAsync(id) {
      reads += 1;
      if (readFailures.includes(reads)) throw new Error('injected read failure');
      return id === '3:1' && !missing ? node : null;
    } },
  };
}

const evaluate = (figma) => async (code) => new Function('figma', `return ${code};`)(figma);

test('Node Resize closes arity, signed dimensions, keywords and URL targets', () => {
  assert.deepEqual(parseNodeResizeRequest(['node', 'resize', '3-1', '--', '-10', 'hug']), {
    nodeId: '3:1', width: -10, height: 'hug',
  });
  assert.deepEqual(nodeResizeArgvFromRequest({ nodeId: '3:1', width: 200, height: 'keep' }), [
    'node', 'resize', '3:1', '--', '200', 'keep',
  ]);
  const url = 'https://www.figma.com/design/FILEA/Test?node-id=3-1';
  assert.deepEqual(nodeResizePlanningArgvFromRequest({ nodeId: url, width: 'fill', height: 40 }), [
    'node', 'resize', url, '--', 'fill', '40',
  ]);
  const plan = planFigmaCommand(['node', 'resize', url, '200', 'keep'], { adapter: 'mcp' });
  assert.equal(plan.target.fileKey, 'FILEA');
  assert.deepEqual(plan.argv, ['node', 'resize', '3:1', '--', '200', 'keep']);
  for (const args of [
    ['node', 'resize'], ['node', 'resize', '3:1', '20'],
    ['node', 'resize', '3:1', '20', '30', 'extra'],
    ['node', 'resize', '3:1', 'wide', '30'], ['node', 'resize', 'bad', '20', '30'],
  ]) assert.throws(() => parseNodeResizeRequest(args));
});

test('numeric resize fixes both axes and verifies fresh dimensions', async () => {
  const live = fixture();
  const result = await executeNodeResize({ nodeId: '3:1', width: 200, height: 80 }, {
    evaluate: evaluate(live.figma),
  });
  assert.deepEqual(live.state, {
    width: 200, height: 80, sizingHorizontal: 'FIXED', sizingVertical: 'FIXED',
  });
  assert.equal(result.result.attempted, 1);
  assert.deepEqual(result.result.requested, { width: 200, height: 80 });
  assert.equal(live.resizeCalls, 2);
});

test('fill, hug and keep remain distinct axis intents', async () => {
  const live = fixture({ layoutMode: 'VERTICAL', parentLayoutMode: 'VERTICAL' });
  const result = await executeNodeResize({ nodeId: '3:1', width: 'fill', height: 'hug' }, {
    evaluate: evaluate(live.figma),
  });
  assert.equal(result.result.actual.sizingHorizontal, 'FILL');
  assert.equal(result.result.actual.sizingVertical, 'HUG');
  assert.equal(live.resizeCalls, 0);

  const noOp = fixture();
  const kept = await executeNodeResize({ nodeId: '3:1', width: 'keep', height: 'keep' }, {
    evaluate: evaluate(noOp.figma),
  });
  assert.equal(kept.result.attempted, 0);
  assert.equal(noOp.resizeCalls, 0);
});

test('a thrown resize acknowledgement succeeds when fresh geometry matches', async () => {
  const live = fixture({ resizeMode: 'throw-after' });
  const result = await executeNodeResize({ nodeId: '3:1', width: 200, height: 'keep' }, {
    evaluate: evaluate(live.figma),
  });
  assert.equal(result.result.status, 'resized');
  assert.equal(live.state.width, 200);
});

test('mismatched postcondition restores dimensions and sizing modes', async () => {
  const live = fixture({
    sizingHorizontal: 'FILL', sizingVertical: 'HUG',
    layoutMode: 'VERTICAL', parentLayoutMode: 'VERTICAL', resizeMode: 'wrong-height',
  });
  await assert.rejects(() => executeNodeResize({ nodeId: '3:1', width: 200, height: 80 }, {
    evaluate: evaluate(live.figma),
  }), (error) => {
    assert.equal(error.mutationOutcome, 'rolled-back');
    assert.deepEqual(error.mutationReport, {
      version: 1, outcome: 'rolled-back', attempted: 1, restored: 1, residueCount: 0,
    });
    return true;
  });
  assert.deepEqual(live.state, {
    width: 100, height: 50, sizingHorizontal: 'FILL', sizingVertical: 'HUG',
  });
});

test('failed rollback and unavailable verification stay explicit', async () => {
  const residue = fixture({ resizeMode: 'wrong-height', rollbackMode: 'no-effect' });
  await assert.rejects(() => executeNodeResize({ nodeId: '3:1', width: 200, height: 80 }, {
    evaluate: evaluate(residue.figma),
  }), (error) => {
    assert.equal(error.mutationOutcome, 'partial-residue');
    assert.equal(error.mutationReport.residueCount, 1);
    return true;
  });

  const unknown = fixture({ resizeMode: 'wrong-height', readFailures: [4] });
  await assert.rejects(() => executeNodeResize({ nodeId: '3:1', width: 200, height: 80 }, {
    evaluate: evaluate(unknown.figma),
  }), (error) => error.mutationOutcome === 'verification-unavailable');
});

test('invalid native sizing intent refuses before mutation', async () => {
  for (const [input, live] of [
    [{ nodeId: '3:1', width: 0, height: 20 }, fixture()],
    [{ nodeId: '3:1', width: 'fill', height: 20 }, fixture()],
    [{ nodeId: '3:1', width: 20, height: 'hug' }, fixture()],
    [{ nodeId: '3:1', width: 20, height: 30 }, fixture({ missing: true })],
  ]) {
    await assert.rejects(() => executeNodeResize(input, { evaluate: evaluate(live.figma) }),
      (error) => error.mutationOutcome === 'no-mutation');
    assert.equal(live.resizeCalls, 0);
  }
});

test('one authentic non-retrying node.resize plan crosses the Application Seam', async () => {
  const plan = planFigmaCommand(['node', 'resize', '3:1', '200', '80'], {
    adapter: 'mcp', fileKey: 'FILEA',
  });
  assert.equal(plan.id, 'node.resize');
  assert.equal(plan.allowed, true);
  assert.equal(plan.effects.figma, 'write');
  assert.equal(plan.execution.retry, 'never');
  assert.equal(nodeResizePlanRoute(plan), 'command-application');
  assert.throws(() => nodeResizePlanRoute({ ...plan }), /requires a Command Plan/);
  const live = fixture();
  let evaluations = 0;
  const result = await executeNodeResizePlan(plan, {
    evaluate: async (code) => { evaluations += 1; return evaluate(live.figma)(code); },
  });
  assert.equal(result.result.status, 'resized');
  assert.equal(evaluations, 1);
});

test('malformed Plugin results cannot become successful resizes', async () => {
  const forged = JSON.stringify({
    schemaVersion: 1, status: 'resized',
    node: { id: '3:1', name: 'Card', type: 'FRAME' },
    requested: { width: 20, height: 30 },
    before: { width: 100, height: 50, sizingHorizontal: 'FIXED', sizingVertical: 'FIXED' },
    actual: { width: 19, height: 30, sizingHorizontal: 'FIXED', sizingVertical: 'FIXED' },
    attempted: 1, residue: [],
  });
  for (const value of [null, {}, 'not-json', JSON.stringify({ status: 'resized' }), forged]) {
    await assert.rejects(() => executeNodeResize({ nodeId: '3:1', width: 20, height: 30 }, {
      evaluate: async () => value,
    }), /invalid/i);
  }
});
