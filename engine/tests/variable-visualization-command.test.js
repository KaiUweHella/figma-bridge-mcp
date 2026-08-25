import assert from 'node:assert/strict';
import test from 'node:test';
import { planFigmaCommand } from '../../src/capability-catalog.js';
import {
  executeVariableVisualization,
  executeVariableVisualizationPlan,
  MAX_VARIABLE_VISUALIZATION_NODES,
  variableVisualizationCommandCode,
  variableVisualizationPlanRoute,
} from '../src/application/variable-visualization-command.js';
import {
  acceptsVariableVisualizationArgv,
  parseVariableVisualizationRequest,
  variableVisualizationArgvFromRequest,
} from '../src/application/variable-visualization-request.js';

function fixture({
  bindFailsAt = null,
  bindingMissingAt = null,
  removeFailsAt = null,
  fontFails = false,
  invalidValue = false,
  uninitialized = false,
  duplicateModeIds = false,
  ambiguousCollection = false,
  ambiguousMode = false,
  factoryFailsAt = null,
  extraVariableCount = 0,
  uniqueExtraGroups = false,
} = {}) {
  const collection = {
    id: 'VariableCollectionId:1', name: 'Semantic Colors', remote: false,
    defaultModeId: 'ModeId:light', modes: [
      { modeId: 'ModeId:dark', name: 'Dark' },
      { modeId: duplicateModeIds ? 'ModeId:dark' : 'ModeId:light', name: 'Light' },
      ...(ambiguousMode ? [
        { modeId: 'ModeId:theme-one', name: 'Theme One' },
        { modeId: 'ModeId:theme-two', name: 'Theme Two' },
      ] : []),
    ],
  };
  const collections = [collection];
  if (ambiguousCollection) collections.push({
    ...collection, id: 'VariableCollectionId:2', name: 'Semantic Foundation',
    modes: collection.modes.map((mode) => ({ ...mode })),
  });
  const variables = [
    { id: 'VariableID:1', name: 'background', remote: false, resolvedType: 'COLOR',
      variableCollectionId: collection.id, valuesByMode: {
        'ModeId:light': { r: 1, g: 1, b: 1 }, 'ModeId:dark': { r: 0, g: 0, b: 0 },
      } },
    { id: 'VariableID:2', name: 'primary/500', remote: false, resolvedType: 'COLOR',
      variableCollectionId: collection.id, valuesByMode: {
        ...(!uninitialized ? {
          'ModeId:light': invalidValue ? 'bad' : { type: 'VARIABLE_ALIAS', id: 'VariableID:1' },
        } : {}),
        'ModeId:dark': { r: 0.1, g: 0.2, b: 0.3, a: 1 },
      } },
  ];
  for (let index = 0; index < extraVariableCount; index++) variables.push({
    id: `VariableID:extra-${index}`,
    name: uniqueExtraGroups ? `scale-${index}/500` : `scale/${index}`,
    remote: false,
    resolvedType: 'COLOR', variableCollectionId: collection.id,
    valuesByMode: { 'ModeId:light': { r: 0, g: 0, b: 0 } },
  });
  const nodes = [];
  let bindCalls = 0;
  let factoryCalls = 0;
  let nodeSequence = 0;
  const viewportNodes = [];
  const page = { children: [] };
  function node(type) {
    factoryCalls++;
    if (factoryCalls === factoryFailsAt) throw new Error('factory failed');
    const value = {
      id: `NodeID:${++nodeSequence}`, type, name: type === 'TEXT' ? '' : 'Frame',
      x: 0, y: 0, width: type === 'TEXT' ? 10 : 100, height: type === 'TEXT' ? 16 : 100,
      fills: [], children: [], parent: page, removed: false, explicitVariableModes: {},
      appendChild(child) {
        const current = child.parent?.children;
        if (Array.isArray(current)) current.splice(current.indexOf(child), 1);
        child.parent = this; this.children.push(child);
      },
      resize(width, height) { this.width = width; this.height = height; },
      setExplicitVariableModeForCollection(owner, modeId) {
        this.explicitVariableModes[owner.id] = modeId;
      },
      remove() {
        if (this.id === removeFailsAt) throw new Error('remove failed');
        this.removed = true;
        const current = this.parent?.children;
        if (Array.isArray(current)) current.splice(current.indexOf(this), 1);
        for (const child of this.children) child.removed = true;
      },
    };
    Object.defineProperty(value, 'characters', {
      get() { return this._characters || ''; },
      set(characters) { this._characters = characters; this.width = Math.max(10, characters.length * 8); },
    });
    nodes.push(value); page.children.push(value); return value;
  }
  const figma = {
    currentPage: page,
    viewport: { scrollAndZoomIntoView(items) { viewportNodes.push(...items); } },
    loadFontAsync: async () => { if (fontFails) throw new Error('font failed'); },
    createFrame: () => node('FRAME'),
    createText: () => node('TEXT'),
    getNodeById: (id) => nodes.find((item) => item.id === id && !item.removed) || null,
    variables: {
      getLocalVariableCollectionsAsync: async () => collections,
      getLocalVariablesAsync: async () => variables,
      setBoundVariableForPaint(paint, field, variable) {
        bindCalls++;
        if (bindCalls === bindFailsAt) throw new Error('bind failed');
        if (bindCalls === bindingMissingAt) return paint;
        return { ...paint, boundVariables: { [field]: { type: 'VARIABLE_ALIAS', id: variable.id } } };
      },
    },
  };
  return { collection, collections, variables, nodes, page, viewportNodes, figma };
}

async function runCode(request, figma) {
  return new Function('figma', `return ${variableVisualizationCommandCode(request)};`)(figma);
}

test('Variable Visualization request closes optional Collection and mode', () => {
  assert.deepEqual(parseVariableVisualizationRequest([
    'variables', 'visualize', '-mDark', '--', '-Semantic Colors',
  ]), { collection: '-Semantic Colors', mode: 'Dark' });
  assert.deepEqual(variableVisualizationArgvFromRequest({ collection: 'Tokens', mode: 'Light' }),
    ['var', 'visualize', '--mode=Light', '--', 'Tokens']);
  for (const args of [
    ['var', 'visualize', 'One', 'Two'],
    ['var', 'visualize', '--mode'],
    ['var', 'visualize', '-mLight', '-mDark'],
    ['var', 'visualize', '--future', 'private-value'],
  ]) assert.equal(acceptsVariableVisualizationArgv(args), false, args.join(' '));
});

test('Variable Visualization preserves semantic aliases, explicit modes and editable bindings', async () => {
  const target = fixture();
  const request = { collection: 'Semantic Colors', mode: 'Light' };
  const serialized = await runCode(request, target.figma);
  const result = await executeVariableVisualization(request, { evaluate: async () => serialized });
  assert.equal(result.stdout, 'Created 2 color swatches');
  assert.equal(result.result.targets[0].modeId, 'ModeId:light');
  assert.equal(result.result.unresolvedCount, 0);
  assert.equal(result.result.containers[0].swatchCount, 2);
  const container = target.nodes.find((item) => item.name === 'Semantic Colors');
  assert.equal(container.explicitVariableModes[target.collection.id], 'ModeId:light');
  const swatches = target.nodes.filter((item) => ['background', 'primary/500'].includes(item.name));
  assert.deepEqual(swatches.map((item) => item.fills[0].boundVariables.color.id).sort(),
    ['VariableID:1', 'VariableID:2']);
  assert.deepEqual(target.viewportNodes, [container]);
});

test('Variable Visualization finishes resource preflight before canvas mutation', async () => {
  const font = fixture({ fontFails: true });
  await assert.rejects(() => runCode({ collection: 'Semantic Colors' }, font.figma), /font failed/);
  assert.equal(font.nodes.length, 0);
  const value = fixture({ invalidValue: true });
  await assert.rejects(() => runCode({ collection: 'Semantic Colors' }, value.figma), /invalid COLOR mode value/);
  assert.equal(value.nodes.length, 0);
});

test('Variable Visualization resolves identities and declared defaults before mutation', async () => {
  const defaultMode = fixture();
  const serialized = await runCode({ collection: 'Semantic Colors' }, defaultMode.figma);
  const result = await executeVariableVisualization({ collection: 'Semantic Colors' }, {
    evaluate: async () => serialized,
  });
  assert.equal(result.result.targets[0].modeId, 'ModeId:light');
  assert.notEqual(defaultMode.collection.modes[0].modeId, defaultMode.collection.defaultModeId);

  for (const [target, request, message] of [
    [fixture({ ambiguousCollection: true }), { collection: 'Semantic' }, /Collection is ambiguous/],
    [fixture({ ambiguousMode: true }), { collection: 'Semantic Colors', mode: 'Theme' }, /mode is ambiguous/],
    [fixture({ duplicateModeIds: true }), { collection: 'Semantic Colors' }, /invalid Collection metadata/],
  ]) {
    await assert.rejects(() => runCode(request, target.figma), message);
    assert.equal(target.nodes.length, 0);
  }
});

test('Variable Visualization keeps uninitialized mode values editable and reports them', async () => {
  const target = fixture({ uninitialized: true });
  const request = { collection: 'Semantic Colors' };
  const serialized = await runCode(request, target.figma);
  const result = await executeVariableVisualization(request, { evaluate: async () => serialized });
  assert.equal(result.result.unresolvedCount, 1);
  assert.equal(result.result.targets[0].unresolvedCount, 1);
  const unresolved = target.nodes.find((item) => item.name === 'primary/500');
  assert.equal(unresolved.fills[0].boundVariables.color.id, 'VariableID:2');
});

test('Variable Visualization bounds planned nodes and first-factory failure remains undispatched evidence', async () => {
  const oversized = fixture({ extraVariableCount: 4_095 });
  await assert.rejects(() => runCode({ collection: 'Semantic Colors' }, oversized.figma), /swatch limit exceeded/);
  assert.equal(oversized.nodes.length, 0);

  const tooManyNodes = fixture({ extraVariableCount: 3_000, uniqueExtraGroups: true });
  await assert.rejects(() => runCode({ collection: 'Semantic Colors' }, tooManyNodes.figma),
    /node limit exceeded/);
  assert.equal(tooManyNodes.nodes.length, 0);

  const factory = fixture({ factoryFailsAt: 1 });
  await assert.rejects(() => runCode({ collection: 'Semantic Colors' }, factory.figma), /factory failed/);
  assert.equal(factory.nodes.length, 0);
});

test('Variable Visualization removes the complete node journal after a later failure', async () => {
  const cleaned = fixture({ bindFailsAt: 2 });
  const request = { collection: 'Semantic Colors' };
  const payload = await runCode(request, cleaned.figma);
  await assert.rejects(
    () => executeVariableVisualization(request, { evaluate: async () => payload }),
    (error) => error.mutationOutcome === 'rolled-back'
      && error.mutationReport.created > 0 && error.mutationReport.residueCount === 0,
  );
  assert.ok(cleaned.nodes.every((item) => item.removed));

  const residueFixture = fixture({ bindFailsAt: 2, removeFailsAt: 'NodeID:1' });
  const residue = await runCode(request, residueFixture.figma);
  await assert.rejects(
    () => executeVariableVisualization(request, { evaluate: async () => residue }),
    (error) => error.mutationOutcome === 'partial-residue'
      && error.mutationReport.residueCount === 1,
  );

  const missingBinding = fixture({ bindingMissingAt: 2 });
  const missingPayload = await runCode(request, missingBinding.figma);
  await assert.rejects(
    () => executeVariableVisualization(request, { evaluate: async () => missingPayload }),
    (error) => error.mutationOutcome === 'rolled-back' && error.mutationReport.residueCount === 0,
  );
  assert.ok(missingBinding.nodes.every((item) => item.removed));
});

test('Variable Visualization rejects forged results and accepts only its authentic Plan', async () => {
  await assert.rejects(() => executeVariableVisualization({ collection: 'Semantic Colors' }, {
    evaluate: async () => '{}',
  }), /invalid bounded result/);
  const cli = planFigmaCommand(['var', 'visualize', '-mDark', 'Semantic Colors'], { adapter: 'cli' });
  const mcp = planFigmaCommand(['var', 'visualize', '--mode=Dark', '--', 'Semantic Colors'], { adapter: 'mcp' });
  assert.equal(cli.allowed, true); assert.equal(mcp.allowed, true);
  assert.deepEqual(cli.argv, mcp.argv); assert.equal(cli.execution.retry, 'never');
  assert.equal(variableVisualizationPlanRoute(cli), 'command-application');
  const target = fixture();
  const serialized = await runCode({ collection: 'Semantic Colors', mode: 'Dark' }, target.figma);
  assert.equal((await executeVariableVisualizationPlan(cli, { evaluate: async () => serialized })).result.swatchCount, 2);
  await assert.rejects(() => executeVariableVisualizationPlan({ ...cli }, { evaluate: async () => serialized }),
    /requires a Command Plan created by the Capability Catalog/);
  assert.equal(cli.execution.timeout, 'long');

  for (const forged of [
    { schemaVersion: 1, status: 'failed', outcome: 'partial-residue', attemptedCount: 2,
      removedCount: 0, residue: [
        { id: 'NodeID:1', type: 'FRAME' }, { id: 'NodeID:1', type: 'FRAME' },
      ], residueTruncated: false },
    { schemaVersion: 1, status: 'failed', outcome: 'rolled-back',
      attemptedCount: MAX_VARIABLE_VISUALIZATION_NODES + 1,
      removedCount: MAX_VARIABLE_VISUALIZATION_NODES + 1, residue: [], residueTruncated: false },
  ]) await assert.rejects(() => executeVariableVisualization({ collection: 'Semantic Colors' }, {
    evaluate: async () => JSON.stringify(forged),
  }), /invalid bounded result/);

  const allTarget = fixture();
  const allSerialized = await runCode({}, allTarget.figma);
  const duplicateMapping = JSON.parse(allSerialized);
  duplicateMapping.targets.push({
    ...duplicateMapping.targets[0], id: 'VariableCollectionId:2', name: 'Other Colors',
  });
  duplicateMapping.containers.push({
    ...duplicateMapping.containers[0], id: 'NodeID:other',
  });
  duplicateMapping.swatchCount *= 2;
  duplicateMapping.unresolvedCount *= 2;
  await assert.rejects(() => executeVariableVisualization({}, {
    evaluate: async () => JSON.stringify(duplicateMapping),
  }), /invalid bounded result/);
});
