import assert from 'node:assert/strict';
import test from 'node:test';
import { planFigmaCommand } from '../../src/capability-catalog.js';
import {
  executeNodeSet,
  executeNodeSetPlan,
  nodeSetPlanRoute,
  nodeSetPlanningArgvFromRequest,
} from '../src/application/node-set-command.js';
import { parseNodeSetRequest, parseSetRequest } from '../src/application/node-set-request.js';

function fixture({ failField = null, ignoreRollbackField = null, duplicateVariable = false, readFailures = [], extended = false } = {}) {
  let reads = 0;
  let writing = false;
  let restoring = false;
  let writes = 0;
  const state = {
    name: 'Before', opacity: 1, visible: true, x: 10, y: 20, width: 100, height: 80,
    paddingTop: 1, paddingRight: 2, paddingBottom: 3, paddingLeft: 4,
    constraints: { horizontal: 'MIN', vertical: 'MIN' },
    fills: [{ type: 'SOLID', color: { r: 1, g: 0, b: 0 } }],
    ...(extended ? {
      strokes: [], visible: true, dashPattern: [], effects: [],
      topLeftRadius: 0, topRightRadius: 0, bottomRightRadius: 0, bottomLeftRadius: 0,
    } : {}),
  };
  const node = { id: '1:2', type: 'FRAME', resize(width, height) { this.width = width; this.height = height; } };
  for (const field of Object.keys(state)) {
    Object.defineProperty(node, field, {
      enumerable: true,
      configurable: true,
      get() { return state[field]; },
      set(value) {
        writes++;
        if (writing && field === failField) throw new Error(`${field} rejected`);
        if (restoring && field === ignoreRollbackField) return;
        state[field] = value;
      },
    });
  }
  const variables = [
    { id: 'VariableID:1', name: 'brand/base', resolvedType: 'COLOR', remote: false, variableCollectionId: 'CollectionID:1' },
    ...(duplicateVariable ? [{ id: 'VariableID:2', name: 'brand/base', resolvedType: 'COLOR', remote: false, variableCollectionId: 'CollectionID:2' }] : []),
  ];
  const collections = [
    { id: 'CollectionID:1', name: 'Tokens' },
    { id: 'CollectionID:2', name: 'Other' },
  ];
  const figma = {
    mixed: Symbol('mixed'),
    async getNodeByIdAsync(id) {
      reads++;
      if (readFailures.includes(reads)) throw new Error('read failed');
      return id === node.id ? node : null;
    },
    variables: {
      async getLocalVariablesAsync() { return variables; },
      async getLocalVariableCollectionsAsync() { return collections; },
      setBoundVariableForPaint(paint, _field, variable) {
        return { ...paint, boundVariables: { color: { type: 'VARIABLE_ALIAS', id: variable.id } } };
      },
    },
  };
  return {
    figma, node, state,
    beginWrite() { writing = true; },
    beginRestore() { restoring = true; writing = false; },
    get writes() { return writes; },
  };
}

function evaluating(live) {
  return async (code) => {
    const instrumented = code
      .replace('const apply = async () => {', 'const apply = async () => { __beginWrite();')
      .replace('const restore = async () => {', 'const restore = async () => { __beginRestore();');
    return new Function('figma', '__beginWrite', '__beginRestore', `return ${instrumented};`)(
      live.figma, () => live.beginWrite(), () => live.beginRestore(),
    );
  };
}

test('Node Set closes aliases, option order, URL identity, and typed values', () => {
  assert.deepEqual(parseSetRequest({
    node: '1-2', w: '120', h: 80, newName: 'Card', visible: 'false',
  }), { nodeId: '1:2', props: { width: 120, height: 80, name: 'Card', visible: false }, collection: null });
  const url = 'https://www.figma.com/design/FILEA/Set-Lab?node-id=1-2';
  const argv = nodeSetPlanningArgvFromRequest({
    nodeId: url,
    props: { name: '-Card', x: -20, fill: 'var:brand/base', radii: [1, 2, 3, 4] },
    collection: 'Tokens',
  });
  assert.equal(argv[2], url);
  assert.deepEqual(parseNodeSetRequest(argv), {
    nodeId: '1:2',
    props: { fill: 'var:brand/base', radii: [1, 2, 3, 4], x: -20, name: '-Card' },
    collection: 'Tokens',
  });
});

test('one execution applies and freshly verifies paints, scalars, padding, constraints, and size', async () => {
  const live = fixture();
  const result = await executeNodeSet({
    nodeId: '1:2',
    props: {
      fill: '#336699', name: 'After', opacity: 0.5, padding: 8,
      constraintsHorizontal: 'CENTER', width: 120, height: 90,
    },
    collection: null,
  }, { evaluate: evaluating(live) });
  assert.deepEqual(result.result.applied, ['fill', 'opacity', 'name', 'padding', 'constraints', 'size']);
  assert.equal(live.node.name, 'After');
  assert.equal(live.node.width, 120);
  assert.equal(live.node.height, 90);
  assert.deepEqual(live.node.fills[0].color, { r: 0.2, g: 0.4, b: 0.6 });
  assert.deepEqual(live.node.constraints, { horizontal: 'CENTER', vertical: 'MIN' });
});

test('ambiguous Variables and all-unsupported requests refuse before the first write', async () => {
  const ambiguous = fixture({ duplicateVariable: true });
  await assert.rejects(
    () => executeNodeSet({ nodeId: '1:2', props: { fill: 'var:brand/base' }, collection: null }, { evaluate: evaluating(ambiguous) }),
    (error) => error.mutationOutcome === 'no-mutation',
  );
  assert.equal(ambiguous.writes, 0);
  const unsupported = fixture();
  await assert.rejects(
    () => executeNodeSet({ nodeId: '1:2', props: { pointCount: 5 }, collection: null }, { evaluate: evaluating(unsupported) }),
    (error) => error.mutationOutcome === 'no-mutation',
  );
  assert.equal(unsupported.writes, 0);
});

test('unsupported fields stay explicit while supported fields still apply', async () => {
  const live = fixture();
  const result = await executeNodeSet({
    nodeId: '1:2', props: { name: 'After', pointCount: 5 }, collection: null,
  }, { evaluate: evaluating(live) });
  assert.deepEqual(result.result.applied, ['name']);
  assert.equal(result.result.skipped.length, 1);
  assert.match(result.result.skipped[0], /pointCount/);
});

test('Paint bindings and compound arrays retain the legacy deterministic order', async () => {
  const live = fixture({ extended: true });
  const result = await executeNodeSet({
    nodeId: '1:2',
    props: {
      stroke: 'var:brand/base', visible: false, radii: [1, 2, 3, 4],
      dashPattern: [4, 2], effects: [{ type: 'LAYER_BLUR', radius: 4, visible: true }],
    },
    collection: 'Tokens',
  }, { evaluate: evaluating(live) });
  assert.deepEqual(result.result.applied, ['stroke', 'visible', 'radii', 'dashPattern', 'effects']);
  assert.equal(live.node.strokes[0].boundVariables.color.id, 'VariableID:1');
  assert.deepEqual(live.node.dashPattern, [4, 2]);
  assert.deepEqual(live.node.effects, [{ type: 'LAYER_BLUR', radius: 4, visible: true }]);
  assert.deepEqual([
    live.node.topLeftRadius, live.node.topRightRadius,
    live.node.bottomRightRadius, live.node.bottomLeftRadius,
  ], [1, 2, 3, 4]);
});

test('a later setter failure restores every earlier field or reports exact residue', async () => {
  const restored = fixture({ failField: 'name' });
  await assert.rejects(
    () => executeNodeSet({
      nodeId: '1:2', props: { name: 'After', opacity: 0.5 }, collection: null,
    }, { evaluate: evaluating(restored) }),
    (error) => error.mutationOutcome === 'rolled-back',
  );
  assert.equal(restored.node.name, 'Before');
  assert.equal(restored.node.opacity, 1);

  const residue = fixture({ failField: 'name', ignoreRollbackField: 'opacity' });
  await assert.rejects(
    () => executeNodeSet({
      nodeId: '1:2', props: { name: 'After', opacity: 0.5 }, collection: null,
    }, { evaluate: evaluating(residue) }),
    (error) => error.mutationOutcome === 'partial-residue'
      && error.mutationReport.residueCount === 1,
  );
  assert.equal(residue.node.opacity, 0.5);
});

test('authentic CLI/MCP Plans dispatch once and malformed Plugin results fail closed', async () => {
  const url = 'https://www.figma.com/design/FILEA/Set-Lab?node-id=1-2';
  const mcp = planFigmaCommand(['node', 'set', url, '--name=After'], { adapter: 'mcp' });
  const cli = planFigmaCommand(['node', 'set', url, '--name', 'After'], { adapter: 'cli' });
  assert.deepEqual(cli.argv, mcp.argv);
  assert.equal(mcp.id, 'node.set');
  assert.equal(mcp.target.fileKey, 'FILEA');
  assert.equal(mcp.execution.pluginDispatch, 'serialized');
  assert.equal(mcp.execution.retry, 'never');
  assert.equal(nodeSetPlanRoute(mcp), 'command-application');
  assert.throws(() => nodeSetPlanRoute({ ...mcp }), /requires a Command Plan/);
  const live = fixture();
  let dispatches = 0;
  await executeNodeSetPlan(mcp, {
    evaluate: async (code) => { dispatches++; return evaluating(live)(code); },
  });
  assert.equal(dispatches, 1);
  for (const value of [null, {}, 'bad', JSON.stringify({ status: 'applied' })]) {
    await assert.rejects(
      () => executeNodeSet({ nodeId: '1:2', props: { name: 'After' }, collection: null }, { evaluate: async () => value }),
      /invalid/i,
    );
  }
});
