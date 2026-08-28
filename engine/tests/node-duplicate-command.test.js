import assert from 'node:assert/strict';
import test from 'node:test';
import { planFigmaCommand } from '../../src/capability-catalog.js';
import {
  executeNodeDuplicate,
  executeNodeDuplicatePlan,
  formatNodeDuplicateResult,
  nodeDuplicateArgvFromRequest,
  nodeDuplicateCode,
  nodeDuplicatePlanRoute,
  nodeDuplicatePlanningArgvFromRequest,
} from '../src/application/node-duplicate-command.js';
import { parseNodeDuplicateRequest } from '../src/application/node-duplicate-request.js';

function fixture({
  cloneable = true,
  removeNoEffect = false,
  throwClone = false,
  wrongPosition = false,
  managedPosition = false,
} = {}) {
  const registry = new Map();
  const attach = (parent, index, node) => {
    if (node.parent?.children) {
      const oldIndex = node.parent.children.indexOf(node);
      if (oldIndex !== -1) node.parent.children.splice(oldIndex, 1);
    }
    parent.children.splice(index, 0, node);
    node.parent = parent;
  };
  const container = (id, name, children = []) => ({
    id, type: 'FRAME', name, remote: false, parent: null, children,
    appendChild(node) { attach(this, this.children.length, node); },
    insertChild(index, node) { attach(this, index, node); },
  });
  const before = { id: '4:1', type: 'RECTANGLE', parent: null };
  const after = { id: '4:2', type: 'TEXT', parent: null };
  const sourceParent = container('2:1', 'Source parent', [before]);
  const targetFirst = { id: '5:1', type: 'RECTANGLE', parent: null };
  const targetSecond = { id: '5:2', type: 'TEXT', parent: null };
  const targetParent = container('2:2', 'Target parent', [targetFirst, targetSecond]);
  let clones = 0;
  const source = {
    id: '3:1', type: 'FRAME', name: 'Source frame', x: 10, y: 20,
    parent: sourceParent,
  };
  if (cloneable) {
    source.clone = () => {
      clones += 1;
      if (throwClone) throw new Error('injected clone failure');
      let storedX = source.x;
      let storedY = source.y;
      const copy = {
        id: `9:${clones}`, type: source.type, name: source.name, parent: null,
        get x() { return storedX; },
        set x(value) {
          if (!managedPosition) storedX = wrongPosition ? value + 1 : value;
        },
        get y() { return storedY; },
        set y(value) { if (!managedPosition) storedY = value; },
        layoutPositioning: 'AUTO',
        remove() {
          if (removeNoEffect) return;
          if (this.parent?.children) {
            const ownIndex = this.parent.children.indexOf(this);
            if (ownIndex !== -1) this.parent.children.splice(ownIndex, 1);
          }
          this.parent = null;
          registry.delete(this.id);
        },
      };
      registry.set(copy.id, copy);
      const sourceIndex = sourceParent.children.indexOf(source);
      sourceParent.insertChild(sourceIndex + 1, copy);
      return copy;
    };
  }
  sourceParent.children.push(source, after);
  for (const child of sourceParent.children) child.parent = sourceParent;
  for (const child of targetParent.children) child.parent = targetParent;
  for (const node of [sourceParent, targetParent, source, before, after, targetFirst, targetSecond]) {
    registry.set(node.id, node);
  }
  return {
    source,
    sourceParent,
    targetParent,
    registry,
    clones: () => clones,
    figma: { getNodeByIdAsync: async (id) => registry.get(id) || null },
  };
}

const evaluate = (figma) => async (code) => new Function('figma', `return ${code};`)(figma);
const request = (overrides = {}) => ({
  nodeId: '3:1', parentId: '2:2', index: 1, name: 'Copied frame',
  offsetX: -12.5, offsetY: 24, json: false, ...overrides,
});

test('Node Duplicate request closes options, signed offsets and URL targets', () => {
  assert.deepEqual(parseNodeDuplicateRequest([
    'node', 'duplicate', '3-1', '--parent=2-2', '--index', '1',
    '--name=Copied frame', '--offset-x=-12.5', '--offset-y', '24', '--json',
  ]), request({ json: true }));
  assert.deepEqual(nodeDuplicateArgvFromRequest(request()), [
    'node', 'duplicate', '3:1', '--parent', '2:2', '--index', '1',
    '--name=Copied frame', '--offset-x=-12.5', '--offset-y=24',
  ]);

  const sourceUrl = 'https://www.figma.com/design/FILEA/Test?node-id=3-1';
  const parentUrl = 'https://www.figma.com/design/FILEA/Test?node-id=2-2';
  assert.deepEqual(nodeDuplicatePlanningArgvFromRequest(request({
    nodeId: sourceUrl,
    parentId: parentUrl,
  })), [
    'node', 'duplicate', sourceUrl, '--parent', parentUrl, '--index', '1',
    '--name=Copied frame', '--offset-x=-12.5', '--offset-y=24',
  ]);
  const plan = planFigmaCommand(nodeDuplicatePlanningArgvFromRequest(request({
    nodeId: sourceUrl,
    parentId: parentUrl,
  })), { adapter: 'mcp' });
  assert.equal(plan.target.fileKey, 'FILEA');
  assert.deepEqual(plan.argv, nodeDuplicateArgvFromRequest(request()));

  for (const argv of [
    ['node', 'duplicate'],
    ['node', 'duplicate', 'bad'],
    ['node', 'duplicate', '3:1', '4:1'],
    ['node', 'duplicate', '3:1', '--index', '-1'],
    ['node', 'duplicate', '3:1', '--offset-x', 'nan'],
    ['node', 'duplicate', '3:1', '--future'],
    ['node', 'duplicate', sourceUrl, '--parent',
      'https://www.figma.com/design/FILEB/Test?node-id=2-2'],
  ]) assert.throws(() => parseNodeDuplicateRequest(argv), /Invalid node duplicate command/);
});

test('default duplication stays beside the source with the existing 40px offsets', async () => {
  const live = fixture();
  const result = await executeNodeDuplicate({ nodeId: '3:1', json: true }, {
    evaluate: evaluate(live.figma),
  });
  assert.equal(result.result.status, 'duplicated');
  assert.deepEqual(result.result.copy, {
    id: '9:1', name: 'Source frame', type: 'FRAME', parentId: '2:1',
    index: 2, x: 50, y: 60, positioning: 'explicit-offset',
  });
  assert.deepEqual(live.sourceParent.children.map((node) => node.id), [
    '4:1', '3:1', '9:1', '4:2',
  ]);
  assert.deepEqual(JSON.parse(result.stdout), result.result);
  assert.equal(live.clones(), 1);
});

test('explicit parent, index, empty name and signed offsets remain available', async () => {
  const live = fixture();
  const result = await executeNodeDuplicate(request({ name: '' }), {
    evaluate: evaluate(live.figma),
  });
  assert.deepEqual(result.result.copy, {
    id: '9:1', name: '', type: 'FRAME', parentId: '2:2',
    index: 1, x: -2.5, y: 44, positioning: 'explicit-offset',
  });
  assert.deepEqual(live.sourceParent.children.map((node) => node.id), ['4:1', '3:1', '4:2']);
  assert.deepEqual(live.targetParent.children.map((node) => node.id), ['5:1', '9:1', '5:2']);
});

test('Auto Layout keeps duplication useful while reporting managed positioning', async () => {
  const live = fixture({ managedPosition: true });
  live.targetParent.layoutMode = 'VERTICAL';
  const result = await executeNodeDuplicate(request(), {
    evaluate: evaluate(live.figma),
  });
  assert.equal(result.result.copy.positioning, 'auto-layout-managed');
  assert.equal(result.result.copy.parentId, '2:2');
  assert.equal(result.result.copy.index, 1);
  assert.equal(result.result.copy.name, 'Copied frame');
  assert.deepEqual([result.result.copy.x, result.result.copy.y], [10, 20]);
  assert.equal(live.clones(), 1);
});

test('invalid source, parent and index refuse before clone', async () => {
  const cases = [
    [fixture({ cloneable: false }), request()],
    [fixture(), request({ parentId: '8:8' })],
    [fixture(), request({ index: 3 })],
  ];
  for (const [live, input] of cases) {
    await assert.rejects(() => executeNodeDuplicate(input, {
      evaluate: evaluate(live.figma),
    }), (error) => {
      assert.equal(error.mutationOutcome, 'no-mutation');
      assert.equal(error.mutationReport.attempted, 0);
      return true;
    });
    assert.equal(live.clones(), 0);
  }
});

test('failed postcondition removes only the new copy and restores both parents', async () => {
  const live = fixture({ wrongPosition: true });
  await assert.rejects(() => executeNodeDuplicate(request(), {
    evaluate: evaluate(live.figma),
  }), (error) => {
    assert.equal(error.mutationOutcome, 'rolled-back');
    assert.deepEqual(error.mutationReport, {
      version: 1, outcome: 'rolled-back', attempted: 1, restored: 1, residueCount: 0,
    });
    return true;
  });
  assert.deepEqual(live.sourceParent.children.map((node) => node.id), ['4:1', '3:1', '4:2']);
  assert.deepEqual(live.targetParent.children.map((node) => node.id), ['5:1', '5:2']);
  assert.equal(live.registry.has('9:1'), false);
});

test('failed rollback reports exact copy and parent residue without retry', async () => {
  const live = fixture({ wrongPosition: true, removeNoEffect: true });
  await assert.rejects(() => executeNodeDuplicate(request(), {
    evaluate: evaluate(live.figma),
  }), (error) => {
    assert.equal(error.mutationOutcome, 'partial-residue');
    assert.equal(error.mutationReport.attempted, 1);
    assert.equal(error.mutationReport.residueCount, 2);
    return true;
  });
  assert.deepEqual(live.targetParent.children.map((node) => node.id), ['5:1', '9:1', '5:2']);
});

test('clone failure without an attributable id is verification-unavailable', async () => {
  const live = fixture({ throwClone: true });
  await assert.rejects(() => executeNodeDuplicate(request(), {
    evaluate: evaluate(live.figma),
  }), (error) => {
    assert.equal(error.mutationOutcome, 'verification-unavailable');
    assert.equal(error.mutationReport.attempted, 1);
    return true;
  });
  assert.equal(live.clones(), 1);
});

test('generated code keeps names as inert data', () => {
  const name = '`); globalThis.NODE_DUPLICATE_INJECTED = true; //';
  const code = nodeDuplicateCode(request({ name }));
  assert.doesNotThrow(() => new Function('figma', `return ${code};`));
  assert.equal(globalThis.NODE_DUPLICATE_INJECTED, undefined);
});

test('one authentic non-retrying node.duplicate plan crosses the Application Seam', async () => {
  const plan = planFigmaCommand(nodeDuplicateArgvFromRequest(request({ json: true })), {
    adapter: 'mcp', fileKey: 'FILEA',
  });
  assert.equal(plan.id, 'node.duplicate');
  assert.equal(plan.allowed, true);
  assert.equal(plan.effects.figma, 'write');
  assert.equal(plan.execution.retry, 'never');
  assert.equal(nodeDuplicatePlanRoute(plan), 'command-application');
  assert.throws(() => nodeDuplicatePlanRoute({ ...plan }), /requires a Command Plan/);
  const live = fixture();
  let evaluations = 0;
  const result = await executeNodeDuplicatePlan(plan, {
    evaluate: async (code) => { evaluations += 1; return evaluate(live.figma)(code); },
  });
  assert.equal(result.result.status, 'duplicated');
  assert.equal(evaluations, 1);
});

test('malformed Plugin results cannot become successful duplicates', async () => {
  for (const value of [null, {}, 'not-json', JSON.stringify({ status: 'duplicated' })]) {
    await assert.rejects(() => executeNodeDuplicate(request(), {
      evaluate: async () => value,
    }), /invalid/i);
  }
});

test('human formatting escapes control-bearing native names', () => {
  const text = formatNodeDuplicateResult({
    source: { id: '3:1', name: 'Source\u202e' },
    copy: { id: '9:1', name: 'Copy\u0000', parentId: '2:2', index: 0, x: 1, y: 2 },
  });
  assert.doesNotMatch(text, /\u202e|\u0000/u);
  assert.match(text, /\\u202e|\\u0000/);
});
