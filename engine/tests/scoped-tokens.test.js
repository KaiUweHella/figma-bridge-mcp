// Scoped token export (scoped-token regression): `export css/dtcg <node>`
// must deliver the variables BOUND in that subtree — library tokens included —
// instead of whatever local collections the open file happens to carry
// (the plant-care-vs-DLS wrong-token bug).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { usedVariablesCode } from '../src/design-extract.js';
import { buildDtcgTree, formatCssTokens } from '../src/lib/css-tokens.js';

// Variable registry stub: DLS tokens (as if from a library) + an unrelated
// local plant-care collection that must NOT leak into the scoped export.
const VARS = {
  'v:surface': { id: 'v:surface', name: 'color/surface', resolvedType: 'COLOR', variableCollectionId: 'c:dls', valuesByMode: { m1: { type: 'VARIABLE_ALIAS', id: 'v:navy' } } },
  'v:navy': { id: 'v:navy', name: 'palette/navy/900', resolvedType: 'COLOR', variableCollectionId: 'c:dls', valuesByMode: { m1: { r: 0x06 / 255, g: 0x09 / 255, b: 0x14 / 255 } } },
  'v:spacing-s': { id: 'v:spacing-s', name: 'spacing/s', resolvedType: 'FLOAT', variableCollectionId: 'c:dls', valuesByMode: { m1: 16 } },
  'v:fontsize': { id: 'v:fontsize', name: 'fonts/fontsize/2xs', resolvedType: 'FLOAT', variableCollectionId: 'c:dls', valuesByMode: { m1: 14 } },
  'v:sage': { id: 'v:sage', name: 'color/bg', resolvedType: 'COLOR', variableCollectionId: 'c:plant', valuesByMode: { m1: { r: 0.5, g: 0.7, b: 0.5 } } },
};

const COLLECTIONS = { 'c:dls': { name: 'DLS Tokens' }, 'c:plant': { name: 'plant-care' } };

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

test('formatCssTokens consumes the scoped list unchanged', () => {
  const css = formatCssTokens([
    { name: 'color/surface', type: 'COLOR', value: '#060914' },
    { name: 'spacing/s', type: 'FLOAT', value: 16 },
  ]);
  assert.match(css, /--color-surface: #060914;/);
  assert.match(css, /--spacing-s: 16px;/);
});
