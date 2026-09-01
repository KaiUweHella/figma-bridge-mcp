import assert from 'node:assert/strict';
import test from 'node:test';
import { planFigmaCommand } from '../../src/capability-catalog.js';
import {
  executePin,
  executePinPlan,
  pinArgvFromRequest,
  pinCode,
  pinPlanRoute,
  pinPlanningArgvFromRequest,
} from '../src/application/pin-command.js';
import {
  acceptsPinArgv,
  parsePinRequest,
  pinFigmaUrlFileKeyFromArgv,
} from '../src/application/pin-request.js';

function fixture({
  nodes = [
    { id: '3:1', name: 'Card', x: 20, y: 30, width: 100, height: 50 },
  ],
  selection = null,
} = {}) {
  let writes = 0;
  const records = new Map(nodes.map((input) => {
    const initial = {
      x: input.x ?? 20,
      y: input.y ?? 30,
      width: input.width ?? 100,
      height: input.height ?? 50,
      constraints: input.constraints || { horizontal: 'MIN', vertical: 'MIN' },
    };
    const state = structuredClone(initial);
    const parent = {
      id: input.parentId || '2:1',
      width: input.parentWidth ?? 300,
      height: input.parentHeight ?? 200,
    };
    const node = {
      id: input.id,
      name: input.name,
      type: input.type || 'FRAME',
      parent,
      get x() { return state.x; },
      set x(value) {
        writes++;
        state.x = input.xMode === 'wrong-forward' && value !== initial.x ? value + 1 : value;
        if (input.xMode === 'throw-after' && value !== initial.x) {
          throw new Error('injected native acknowledgement failure');
        }
      },
      get y() { return state.y; },
      set y(value) { writes++; state.y = value; },
      get width() { return state.width; },
      get height() { return state.height; },
      get constraints() { return state.constraints; },
      set constraints(value) { writes++; state.constraints = { ...value }; },
      resize(width, height) { writes++; state.width = width; state.height = height; },
    };
    return [input.id, { node, state, initial }];
  }));
  const all = [...records.values()].map((entry) => entry.node);
  const selected = selection === null
    ? all
    : selection.map((id) => records.get(id)?.node).filter(Boolean);
  return {
    records,
    get writes() { return writes; },
    figma: {
      currentPage: {
        selection: selected,
        findAll(predicate) { return all.filter(predicate); },
      },
      async getNodeByIdAsync(id) { return records.get(id)?.node || null; },
    },
  };
}

const evaluate = (figma) => async (code) => new Function('figma', `return ${code};`)(figma);

test('Pin closes its selector grammar, metrics, aliases and URL target projection', () => {
  assert.deepEqual(parsePinRequest([
    'pin', '-n3-1,4:2', '--offset=-12', '--offset-y', '8', '--start', '10%', '--',
    'top-right',
  ]), {
    edge: 'top-right',
    selector: { kind: 'nodes', nodeIds: ['3:1', '4:2'] },
    offsetX: -12,
    offsetY: 8,
    start: '10%',
    end: null,
  });
  assert.deepEqual(pinArgvFromRequest({ edge: 'left', query: 'Card', offset: 4 }), [
    'pin', '--offset-x', '4', '--offset-y', '4', '--query', 'Card', '--', 'left',
  ]);
  const url = 'https://www.figma.com/design/FILEA/Pin-Lab?node-id=3-1';
  assert.equal(pinFigmaUrlFileKeyFromArgv(['pin', '--node', url, 'right']), 'FILEA');
  assert.equal(pinPlanningArgvFromRequest({ edge: 'right', node: url })[6], url);
  for (const argv of [
    ['pin'],
    ['pin', 'future-edge'],
    ['pin', '--node', '3:1', '--query', 'Card', 'left'],
    ['pin', '--offset', 'Infinity', 'left'],
    ['pin', '--start', 'calc(1px)', 'stretch-x'],
    ['pin', '--query', 'Frame', 'left'],
    ['pin', '--future', 'value', 'left'],
    ['pin', 'left', 'extra'],
  ]) assert.equal(acceptsPinArgv(argv), false, argv.join(' '));
  for (const request of [
    { edge: 'left', node: ['3:1'] },
    { edge: 'left', query: { private: true } },
    { edge: 'left', offset: { valueOf: () => 4 } },
    { edge: 'left', selector: { kind: 'selection', extra: true } },
    { edge: 'left', selector: { kind: 'nodes', nodeIds: [3] } },
  ]) assert.throws(() => pinArgvFromRequest(request), /Pin/);
});

test('edge and stretch pinning apply and freshly verify complete geometry', async () => {
  const corner = fixture();
  const result = await executePin({ edge: 'top-right', node: '3:1', offsetX: 16, offsetY: 12 }, {
    evaluate: evaluate(corner.figma),
  });
  assert.equal(result.stdout, 'Pinned 1 element(s) to top-right');
  assert.deepEqual(corner.records.get('3:1').state, {
    x: 184,
    y: 12,
    width: 100,
    height: 50,
    constraints: { horizontal: 'MAX', vertical: 'MIN' },
  });
  assert.equal(result.result.outcome, 'verified');

  const stretch = fixture();
  const stretched = await executePin({ edge: 'stretch-x', node: '3:1', start: '10', end: '20' }, {
    evaluate: evaluate(stretch.figma),
  });
  assert.equal(stretched.result.nodes[0].actual.x, 10);
  assert.equal(stretched.result.nodes[0].actual.width, 270);
  assert.equal(stretched.result.nodes[0].actual.constraints.horizontal, 'STRETCH');

  const scale = fixture();
  const scaled = await executePin({ edge: 'scale-y', node: '3:1', start: '25%', end: '10%' }, {
    evaluate: evaluate(scale.figma),
  });
  assert.equal(scaled.result.nodes[0].actual.y, 50);
  assert.equal(scaled.result.nodes[0].actual.height, 130);
  assert.equal(scaled.result.nodes[0].actual.constraints.vertical, 'SCALE');
});

test('selection and query selectors remain distinct bounded execution modes', async () => {
  const live = fixture({
    nodes: [
      { id: '3:1', name: 'Card / Primary', x: 20 },
      { id: '3:2', name: 'Label', x: 30 },
    ],
    selection: ['3:2'],
  });
  const selected = await executePin({ edge: 'left' }, { evaluate: evaluate(live.figma) });
  assert.equal(selected.result.nodes[0].id, '3:2');
  assert.equal(live.records.get('3:1').state.x, 20);

  const queried = await executePin({ edge: 'right', query: 'primary' }, {
    evaluate: evaluate(live.figma),
  });
  assert.equal(queried.result.nodes[0].id, '3:1');

  const unchanged = await executePin({ edge: 'top', query: 'Missing' }, {
    evaluate: evaluate(live.figma),
  });
  assert.equal(unchanged.result.status, 'unchanged');
  assert.equal(unchanged.stdout, 'No node found');
});

test('complete preflight refuses invalid target sets without any write', async () => {
  const live = fixture({ nodes: [
    { id: '3:1', name: 'Card' },
    { id: '3:2', name: 'Broken', parentWidth: Number.NaN },
  ] });
  await assert.rejects(() => executePin({ edge: 'left', node: '3:1,3:2' }, {
    evaluate: evaluate(live.figma),
  }), (error) => {
    assert.equal(error.mutationOutcome, 'no-mutation');
    assert.deepEqual(error.mutationReport, {
      version: 1, outcome: 'no-mutation', attempted: 0, restored: 0, residueCount: 0,
    });
    return true;
  });
  assert.equal(live.writes, 0);
});

test('a failed fresh postcondition rolls every attempted target back', async () => {
  const live = fixture({ nodes: [
    { id: '3:1', name: 'First', x: 20 },
    { id: '3:2', name: 'Second', x: 30, xMode: 'wrong-forward' },
  ] });
  await assert.rejects(() => executePin({ edge: 'left', node: '3:1,3:2', offsetX: 12 }, {
    evaluate: evaluate(live.figma),
  }), (error) => {
    assert.equal(error.mutationOutcome, 'rolled-back');
    assert.deepEqual(error.mutationReport, {
      version: 1, outcome: 'rolled-back', attempted: 2, restored: 2, residueCount: 0,
    });
    return true;
  });
  assert.equal(live.records.get('3:1').state.x, 20);
  assert.equal(live.records.get('3:2').state.x, 30);
  assert.deepEqual(live.records.get('3:1').state.constraints, { horizontal: 'MIN', vertical: 'MIN' });
});

test('a native acknowledgement error succeeds only when fresh state proves the request', async () => {
  const live = fixture({ nodes: [
    { id: '3:1', name: 'First', x: 20 },
    { id: '3:2', name: 'Second', x: 30, xMode: 'throw-after' },
    { id: '3:3', name: 'Already pinned', x: 12 },
  ] });
  const result = await executePin({ edge: 'left', node: '3:1,3:2,3:3', offsetX: 12 }, {
    evaluate: evaluate(live.figma),
  });
  assert.equal(result.result.outcome, 'verified-after-error');
  assert.equal(result.result.attempted, 3);
  assert.deepEqual(result.result.nodes.map((node) => node.actual.x), [12, 12, 12]);
  assert.match(result.stderr, /reported an error/);
});

test('Pin Plan owns identical CLI and MCP semantics without retries', async () => {
  const url = 'https://www.figma.com/design/FILEA/Pin-Lab?node-id=3-1';
  for (const adapter of ['cli', 'mcp']) {
    const plan = planFigmaCommand(pinPlanningArgvFromRequest({
      edge: 'bottom-right', node: url, offsetX: 5, offsetY: 7,
    }), { adapter });
    assert.equal(plan.id, 'pin');
    assert.equal(plan.allowed, true);
    assert.equal(plan.target.fileKey, 'FILEA');
    assert.equal(plan.effects.figma, 'write');
    assert.equal(plan.effects.editor, 'none');
    assert.equal(plan.execution.retry, 'never');
    assert.equal(pinPlanRoute(plan), 'command-application');
    const live = fixture();
    const result = await executePinPlan(plan, { evaluate: evaluate(live.figma) });
    assert.equal(result.result.nodes[0].actual.x, 195);
    assert.equal(result.result.nodes[0].actual.y, 143);
  }
  const selection = planFigmaCommand(['pin', 'left'], { adapter: 'mcp' });
  assert.equal(selection.effects.editor, 'read');
  assert.throws(() => pinPlanRoute({ ...selection }), /requires a Command Plan/);
});

test('malformed Plugin claims cannot become successful pin mutations', async () => {
  const forged = JSON.stringify({
    schemaVersion: 1,
    status: 'pinned',
    outcome: 'verified',
    attempted: 1,
    edge: 'left',
    nodes: [{
      id: '3:1', name: 'Card', type: 'FRAME',
      parent: { id: '2:1', width: 300, height: 200 },
      before: { x: 20, y: 30, width: 100, height: 50, constraints: { horizontal: 'MIN', vertical: 'MIN' } },
      actual: { x: 99, y: 30, width: 100, height: 50, constraints: { horizontal: 'MIN', vertical: 'MIN' } },
    }],
    residue: [], warnings: [],
  });
  const forgedResidue = JSON.stringify({
    schemaVersion: 1, status: 'failed', outcome: 'partial-residue', attempted: 2,
    restored: 1, failure: 'forged', residue: ['9:9'],
  });
  for (const value of [
    null, {}, 'not-json', JSON.stringify({ status: 'pinned' }), forged, forgedResidue,
  ]) {
    await assert.rejects(() => executePin({ edge: 'left', node: '3:1' }, {
      evaluate: async () => value,
    }), /invalid/i);
  }
});

test('generated Pin code stays bounded and contains no timer-based mutation window', () => {
  const code = pinCode({ edge: 'left', node: '3:1' });
  assert.doesNotThrow(() => new Function(`return ${code};`));
  assert.doesNotMatch(code, /setTimeout|setInterval/);
  assert.match(code, /fresh readback/);
  assert.ok(code.length < 50_000);
});
