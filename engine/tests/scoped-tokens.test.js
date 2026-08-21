// Scoped token export (scoped-token regression): `export css/dtcg <node>`
// must deliver the variables BOUND in that subtree — library tokens included —
// instead of whatever local collections the open file happens to carry
// (the plant-care-vs-DLS wrong-token bug).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { usedVariablesCode } from '../src/design-extract.js';
import { buildDtcgTree, formatCssTokens, projectVariableModes } from '../src/lib/css-tokens.js';

// Variable registry stub: DLS tokens (as if from a library) + an unrelated
// local plant-care collection that must NOT leak into the scoped export.
const VARS = {
  'v:surface': { id: 'v:surface', name: 'color/surface', resolvedType: 'COLOR', variableCollectionId: 'c:dls', valuesByMode: { m1: { type: 'VARIABLE_ALIAS', id: 'v:navy' }, m2: { type: 'VARIABLE_ALIAS', id: 'v:navy' } }, scopes: ['ALL_FILLS'], codeSyntax: { WEB: '--color-surface' } },
  'v:navy': { id: 'v:navy', name: 'palette/navy/900', resolvedType: 'COLOR', variableCollectionId: 'c:dls', valuesByMode: { m1: { r: 0x06 / 255, g: 0x09 / 255, b: 0x14 / 255 }, m2: { r: 0.9, g: 0.92, b: 0.95 } } },
  'v:spacing-s': { id: 'v:spacing-s', name: 'spacing/s', resolvedType: 'FLOAT', variableCollectionId: 'c:dls', valuesByMode: { m1: 16, m2: 20 } },
  'v:fontsize': { id: 'v:fontsize', name: 'fonts/fontsize/2xs', resolvedType: 'FLOAT', variableCollectionId: 'c:dls', valuesByMode: { m1: 14, m2: 14 } },
  'v:sage': { id: 'v:sage', name: 'color/bg', resolvedType: 'COLOR', variableCollectionId: 'c:plant', valuesByMode: { m1: { r: 0.5, g: 0.7, b: 0.5 } } },
};

const COLLECTIONS = {
  'c:dls': {
    id: 'c:dls', name: 'DLS Tokens', defaultModeId: 'm1',
    modes: [{ modeId: 'm1', name: 'Light' }, { modeId: 'm2', name: 'Dark' }],
  },
  'c:plant': { id: 'c:plant', name: 'plant-care', defaultModeId: 'm1', modes: [{ modeId: 'm1', name: 'Default' }] },
};

const makeTree = () => {
  const root = {
    id: 'n:1', name: 'screen', type: 'FRAME', visible: true,
    boundVariables: { fills: [{ type: 'VARIABLE_ALIAS', id: 'v:surface' }], itemSpacing: { type: 'VARIABLE_ALIAS', id: 'v:spacing-s' } },
    children: [
      {
        id: 'n:2', name: 'label', type: 'TEXT', visible: true,
        textStyleId: 's:label', boundVariables: {}, children: [],
      },
      { id: 'n:3', name: 'hidden', type: 'FRAME', visible: false, boundVariables: { fills: [{ type: 'VARIABLE_ALIAS', id: 'v:sage' }] }, children: [] },
    ],
  };
  return root;
};

const stubFigma = (root) => ({
  mixed: Symbol('mixed'),
  root: { name: 'Untitled' },
  getNodeByIdAsync: async (id) => (id === root.id ? root : null),
  getStyleByIdAsync: async (id) => (id === 's:label'
    ? { name: 'label/small', boundVariables: { fontSize: [{ type: 'VARIABLE_ALIAS', id: 'v:fontsize' }] } }
    : null),
  variables: {
    getVariableByIdAsync: async (id) => VARS[id] || null,
    getVariableCollectionByIdAsync: async (id) => COLLECTIONS[id] || null,
  },
});
const run = (root) => new Function('figma', `return ${usedVariablesCode(root.id)}`)(stubFigma(root));

test('scoped collector: bound variables + style bindings + alias targets; hidden subtrees and unrelated collections stay out', async () => {
  const result = JSON.parse(await run(makeTree()));
  assert.equal(result.file, 'Untitled');
  assert.equal(result.node, 'screen');
  const names = result.vars.map((v) => v.name).sort();
  assert.deepEqual(names, ['color/surface', 'fonts/fontsize/2xs', 'palette/navy/900', 'spacing/s'],
    'node bindings + text-style binding + alias target — nothing else');
  const surface = result.vars.find((v) => v.name === 'color/surface');
  assert.equal(surface.value, '#060914', 'alias chain resolved to the concrete hex');
  assert.equal(surface.ref, 'palette/navy/900', 'alias target recorded for DTCG refs');
  assert.equal(surface.collection, 'DLS Tokens');
  assert.equal(surface.id, 'v:surface');
  assert.deepEqual(surface.scopes, ['ALL_FILLS']);
  assert.deepEqual(surface.codeSyntax, { WEB: '--color-surface' });
  assert.equal(surface.defaultModeId, 'm1');
  assert.deepEqual(surface.modes, [{ modeId: 'm1', name: 'Light' }, { modeId: 'm2', name: 'Dark' }]);
  assert.deepEqual(surface.valuesByMode, {
    m1: { value: '#060914', ref: 'palette/navy/900' },
    m2: { value: '#e6ebf2', ref: 'palette/navy/900' },
  });
  assert.ok(!names.includes('color/bg'), 'the plant-care local collection does not leak in');
});

test('scoped collector: unknown node reports the open file', async () => {
  const result = JSON.parse(await new Function('figma', `return ${usedVariablesCode('nope')}`)(stubFigma(makeTree())));
  assert.match(result.error, /nope/);
  assert.match(result.error, /Untitled/);
});

test('buildDtcgTree: aliases become {dot.path} refs, floats px, colors hex', () => {
  const tree = buildDtcgTree([
    { name: 'color/surface', type: 'COLOR', value: '#060914', ref: 'palette/navy/900' },
    { name: 'palette/navy/900', type: 'COLOR', value: '#060914', ref: null },
    { name: 'spacing/s', type: 'FLOAT', value: 16, ref: null },
  ]);
  assert.equal(tree.color.surface.$value, '{palette.navy.900}');
  assert.equal(tree.palette.navy['900'].$value, '#060914');
  assert.equal(tree.spacing.s.$value, '16px');
  assert.equal(tree.spacing.s.$type, 'dimension');
});

test('buildDtcgTree: 2025 values and Figma metadata round-trip through extensions', () => {
  const tree = buildDtcgTree([
    {
      id: 'v:surface', name: 'color/surface', type: 'COLOR', value: '#0d7c7480',
      collection: 'DLS Tokens', scopes: ['FRAME_FILL', 'ALL_FILLS'],
      codeSyntax: { WEB: '--color-surface' }, description: 'Default surface',
    },
    { id: 'v:s', name: 'spacing/s', type: 'FLOAT', value: 16 },
  ], { dialect: '2025' });
  assert.deepEqual(tree.color.surface.$value, {
    colorSpace: 'srgb', components: [0.05098, 0.48627, 0.4549], alpha: 0.50196, hex: '#0d7c7480',
  });
  assert.deepEqual(tree.spacing.s.$value, { value: 16, unit: 'px' });
  assert.equal(tree.color.surface.$description, 'Default surface');
  assert.deepEqual(tree.color.surface.$extensions['figma-bridge-mcp'], {
    variableId: 'v:surface', collection: 'DLS Tokens',
    scopes: ['ALL_FILLS', 'FRAME_FILL'], codeSyntax: { WEB: '--color-surface' },
  });
});

test('buildDtcgTree rejects unknown dialects', () => {
  assert.throws(() => buildDtcgTree([], { dialect: 'future' }), /legacy or 2025/);
});

test('multi-mode DTCG preserves every mode value and per-mode alias', () => {
  const tree = buildDtcgTree([{
    id: 'v:surface', name: 'color/surface', type: 'COLOR', collection: 'Theme',
    defaultModeId: 'm:light',
    modes: [{ modeId: 'm:light', name: 'Light' }, { modeId: 'm:dark', name: 'Dark' }],
    valuesByMode: {
      'm:light': { value: '#ffffff', ref: 'palette/white' },
      'm:dark': { value: '#111111', ref: 'palette/gray/950' },
    },
  }], { dialect: '2025' });
  const extension = tree.color.surface.$extensions['figma-bridge-mcp'];
  assert.equal(tree.color.surface.$value, '{palette.white}');
  assert.equal(extension.defaultModeId, 'm:light');
  assert.deepEqual(extension.modes, [
    { modeId: 'm:light', name: 'Light' },
    { modeId: 'm:dark', name: 'Dark' },
  ]);
  assert.deepEqual(extension.valuesByMode, {
    'm:light': { modeName: 'Light', value: '{palette.white}' },
    'm:dark': { modeName: 'Dark', value: '{palette.gray.950}' },
  });
});

test('multi-mode CSS emits named scopes and never invents clamp semantics', () => {
  const css = formatCssTokens([{
    name: 'space/fluid', type: 'FLOAT', defaultModeId: 'm:compact',
    modes: [{ modeId: 'm:compact', name: 'Compact' }, { modeId: 'm:comfortable', name: 'Comfortable' }],
    valuesByMode: {
      'm:compact': { value: 12, ref: null },
      'm:comfortable': { value: 20, ref: null },
    },
  }]);
  assert.match(css, /:root \{[\s\S]*--space-fluid: 12px;/);
  assert.match(css, /\[data-figma-mode="Comfortable"\] \{[\s\S]*--space-fluid: 20px;/);
  assert.doesNotMatch(css, /clamp\(/);
});

test('raw local variables resolve aliases by matching collection mode', () => {
  const projected = projectVariableModes([
    {
      id: 'semantic', name: 'color/surface', resolvedType: 'COLOR', variableCollectionId: 'theme',
      valuesByMode: { light: { type: 'VARIABLE_ALIAS', id: 'primitive' }, dark: { type: 'VARIABLE_ALIAS', id: 'primitive' } },
    },
    {
      id: 'primitive', name: 'palette/surface', resolvedType: 'COLOR', variableCollectionId: 'theme',
      valuesByMode: {
        light: { r: 1, g: 1, b: 1 }, dark: { r: 0.1, g: 0.1, b: 0.1 },
      },
    },
  ], [{
    id: 'theme', name: 'Theme', defaultModeId: 'light',
    modes: [{ modeId: 'light', name: 'Light' }, { modeId: 'dark', name: 'Dark' }],
  }]);
  assert.deepEqual(projected[0].valuesByMode, {
    light: { value: '#ffffff', ref: 'palette/surface' },
    dark: { value: '#1a1a1a', ref: 'palette/surface' },
  });
});

test('formatCssTokens consumes the scoped list unchanged', () => {
  const css = formatCssTokens([
    { name: 'color/surface', type: 'COLOR', value: '#060914' },
    { name: 'spacing/s', type: 'FLOAT', value: 16 },
  ]);
  assert.match(css, /--color-surface: #060914;/);
  assert.match(css, /--spacing-s: 16px;/);
});
