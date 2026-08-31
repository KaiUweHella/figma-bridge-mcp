import assert from 'node:assert/strict';
import test from 'node:test';
import { planFigmaCommand } from '../../src/capability-catalog.js';
import {
  createCanvasNodeArgvFromRequest,
  createCanvasNodePlanRoute,
  createCanvasNodePlanningArgvFromRequest,
  executeCreateCanvasNode,
  executeCreateCanvasNodePlan,
} from '../src/application/create-canvas-node-command.js';
import { parseCreateCanvasNodeRequest } from '../src/application/create-canvas-node-request.js';

function fixture({ wrongWidth = false, wrongNetwork = false, removeNoEffect = false } = {}) {
  const registry = new Map();
  const attach = (parent, index, node) => {
    const old = node.parent?.children?.indexOf(node) ?? -1;
    if (old !== -1) node.parent.children.splice(old, 1);
    parent.children.splice(index, 0, node); node.parent = parent;
  };
  const container = (id, type, children = []) => ({
    id, type, name: type, remote: false, parent: null, children, x: 0, width: 50,
    appendChild(node) { attach(this, this.children.length, node); },
    insertChild(index, node) { attach(this, index, node); },
  });
  const existing = { id: '2:1', type: 'RECTANGLE', name: 'Existing', x: 20, width: 30, parent: null };
  const page = container('0:1', 'PAGE', [existing]);
  const child = { id: '4:1', type: 'TEXT', name: 'Child', parent: null };
  const parent = container('3:1', 'FRAME', [child]); page.appendChild(parent);
  const figma = { currentPage: { ...page, selection: [existing] }, getNodeByIdAsync: async (id) => registry.get(id) || null };
  registry.set(figma.currentPage.id, figma.currentPage);
  for (const node of [existing, parent, child]) registry.set(node.id, node);
  for (const node of figma.currentPage.children) node.parent = figma.currentPage;
  let creates = 0;
  const base = (type) => {
    creates += 1; let width = 100; let height = 100;
    const node = {
      id: `9:${creates}`, type, name: type, parent: null, x: 0, y: 0,
      get width() { return width; }, get height() { return height; },
      resize(w, h) { width = wrongWidth ? w + 1 : w; height = h; },
      remove() {
        if (removeNoEffect) return;
        const index = this.parent?.children?.indexOf(this) ?? -1;
        if (index !== -1) this.parent.children.splice(index, 1);
        this.parent = null; registry.delete(this.id);
      },
    };
    registry.set(node.id, node); figma.currentPage.appendChild(node); return node;
  };
  figma.createSlice = () => base('SLICE');
  figma.createVector = () => {
    const node = base('VECTOR'); node.vectorNetwork = { vertices: [], segments: [], regions: [] };
    node.setVectorNetworkAsync = async (network) => {
      node.vectorNetwork = wrongNetwork ? { vertices: [], segments: [], regions: [] } : network;
    };
    return node;
  };
  return { figma, parent, existing, creates: () => creates };
}

const evaluate = (figma) => async (code) => new Function('figma', `return ${code};`)(figma);
const network = { vertices: [{ x: 0, y: 0 }, { x: 10, y: 10 }], segments: [{ start: 0, end: 1 }], regions: [] };

test('Create Canvas Node closes Vector/Slice options and URL parent identity', () => {
  assert.deepEqual(parseCreateCanvasNodeRequest([
    'create', 'vector', 'Path', '-x', '-4', '-y=8', '--network', JSON.stringify(network),
    '--parent', '3-1', '--index=0',
  ]), {
    kind: 'vector', name: 'Path', width: null, height: null, x: -4, y: 8,
    network, parentId: '3:1', index: 0,
  });
  assert.deepEqual(parseCreateCanvasNodeRequest([
    'create', 'slice', 'Export', '-w', '320', '-h=180', '-x', '12', '-y', '24',
  ]), {
    kind: 'slice', name: 'Export', width: 320, height: 180, x: 12, y: 24,
    network: null, parentId: null, index: null,
  });
  const url = 'https://www.figma.com/design/FILEA/Test?node-id=3-1';
  const plan = planFigmaCommand(createCanvasNodePlanningArgvFromRequest({
    kind: 'slice', parentId: url,
  }), { adapter: 'mcp' });
  assert.equal(plan.target.fileKey, 'FILEA');
  assert.equal(plan.argv.includes('3:1'), true);
  for (const argv of [
    ['create', 'vector', '--network', '{}'],
    ['create', 'vector', '--width', '10'],
    ['create', 'slice', '--network', JSON.stringify(network)],
    ['create', 'slice', '--height', '0'],
    ['create', 'slice', '--future'],
  ]) assert.throws(() => parseCreateCanvasNodeRequest(argv), /Invalid create canvas node command/);
});

test('Create Canvas Node applies and freshly verifies Vector and Slice', async () => {
  const vector = fixture();
  const vectorResult = await executeCreateCanvasNode({
    kind: 'vector', name: 'Path', network, parentId: '3:1', index: 0, x: -4, y: 8,
  }, { evaluate: evaluate(vector.figma) });
  assert.equal(vectorResult.result.node.type, 'VECTOR');
  assert.equal(vectorResult.result.networkApplied, true);
  assert.deepEqual(vector.parent.children.map((node) => node.id), ['9:1', '4:1']);

  const slice = fixture();
  const sliceResult = await executeCreateCanvasNode({
    kind: 'slice', name: 'Export', width: 320, height: 180, x: null,
  }, { evaluate: evaluate(slice.figma) });
  assert.equal(sliceResult.result.node.type, 'SLICE');
  assert.equal(sliceResult.result.node.x, 150);
  assert.equal(sliceResult.result.node.width, 320);
  assert.equal(sliceResult.result.node.height, 180);
});

test('Create Canvas Node rolls back postcondition mismatch and reports residue', async () => {
  for (const [live, input] of [
    [fixture({ wrongNetwork: true }), { kind: 'vector', network }],
    [fixture({ wrongWidth: true }), { kind: 'slice', width: 200, height: 100 }],
  ]) {
    await assert.rejects(() => executeCreateCanvasNode(input, { evaluate: evaluate(live.figma) }), (error) => {
      assert.equal(error.mutationOutcome, 'rolled-back');
      assert.equal(error.mutationReport.residueCount, 0);
      return true;
    });
    assert.deepEqual(live.figma.currentPage.selection.map((node) => node.id), ['2:1']);
  }
  const residue = fixture({ wrongWidth: true, removeNoEffect: true });
  await assert.rejects(() => executeCreateCanvasNode({ kind: 'slice' }, {
    evaluate: evaluate(residue.figma),
  }), (error) => error.mutationOutcome === 'partial-residue'
    && error.mutationReport.residueCount === 1);
});

test('Create Canvas Node has one non-retrying Plan and one evaluation in both Adapters', async () => {
  for (const kind of ['vector', 'slice']) {
    const argv = createCanvasNodeArgvFromRequest({ kind, ...(kind === 'vector' ? { network } : {}) });
    const mcp = planFigmaCommand(argv, { adapter: 'mcp', fileKey: 'FILEA' });
    const cli = planFigmaCommand(argv, { adapter: 'cli', fileKey: 'FILEA' });
    assert.equal(mcp.allowed, true); assert.equal(cli.allowed, true);
    assert.equal(createCanvasNodePlanRoute(mcp), 'command-application');
    assert.deepEqual(mcp.effects, cli.effects); assert.equal(mcp.execution.retry, 'never');
    const live = fixture(); let evaluations = 0;
    const result = await executeCreateCanvasNodePlan(mcp, {
      evaluate: async (code) => { evaluations += 1; return evaluate(live.figma)(code); },
    });
    assert.equal(result.result.status, 'created'); assert.equal(evaluations, 1);
  }
});
