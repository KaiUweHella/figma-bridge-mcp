// Scoped token export (scoped-token regression): `export css/dtcg <node>`
// must deliver the variables BOUND in that subtree — library tokens included —
// instead of whatever local collections the open file happens to carry
// (the plant-care-vs-DLS wrong-token bug).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { usedVariablesCode } from '../src/design-extract.js';
import { normalizeTokenImportSource } from '../src/application/token-import-source.js';
import { buildDtcgTree, formatCssTokens, projectVariableModes } from '../src/lib/css-tokens.js';
import { canonicalMotionEasing } from '../src/lib/motion-easing.js';

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

const stubFigma = (root, { variables = VARS, collections = COLLECTIONS } = {}) => ({
  mixed: Symbol('mixed'),
  root: { name: 'Untitled' },
  getNodeByIdAsync: async (id) => (id === root.id ? root : null),
  getStyleByIdAsync: async (id) => (id === 's:label'
    ? { name: 'label/small', boundVariables: { fontSize: [{ type: 'VARIABLE_ALIAS', id: 'v:fontsize' }] } }
    : null),
  variables: {
    getVariableByIdAsync: async (id) => variables[id] || null,
    getVariableCollectionByIdAsync: async (id) => collections[id] || null,
  },
});
const run = (root, registry) => new Function('figma', `return ${usedVariablesCode(root.id)}`)(stubFigma(root, registry));

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
    m1: { value: '#060914', ref: 'palette/navy/900', refId: 'v:navy' },
    m2: { value: '#e6ebf2', ref: 'palette/navy/900', refId: 'v:navy' },
  });
  assert.ok(!names.includes('color/bg'), 'the plant-care local collection does not leak in');
});

test('scoped collector: unknown node reports the open file', async () => {
  const result = JSON.parse(await new Function('figma', `return ${usedVariablesCode('nope')}`)(stubFigma(makeTree())));
  assert.match(result.error, /nope/);
  assert.match(result.error, /Untitled/);
});

test('scoped collector composes every nested color Alias opacity and preserves authored metadata', async () => {
  const root = {
    id: 'n:composed', name: 'composed screen', type: 'FRAME', visible: true,
    boundVariables: { fills: [{ type: 'VARIABLE_ALIAS', id: 'v:top' }] }, children: [],
  };
  const variables = {
    'v:top': {
      id: 'v:top', name: 'color/role/top', resolvedType: 'COLOR', variableCollectionId: 'c:theme',
      valuesByMode: { mode: {
        type: 'VARIABLE_EXPRESSION', expressionFunction: 'COMPOSE_COLOR',
        expressionArguments: [{ type: 'VARIABLE_ALIAS', id: 'v:mid' }, 50],
      } },
    },
    'v:mid': {
      id: 'v:mid', name: 'color/role/mid', resolvedType: 'COLOR', variableCollectionId: 'c:theme',
      valuesByMode: { mode: {
        type: 'VARIABLE_EXPRESSION', expressionFunction: 'COMPOSE_COLOR',
        expressionArguments: [{ type: 'VARIABLE_ALIAS', id: 'v:base' }, 50],
      } },
    },
    'v:base': {
      id: 'v:base', name: 'color/palette/base', resolvedType: 'COLOR', variableCollectionId: 'c:theme',
      valuesByMode: { mode: { r: 1, g: 0, b: 0, a: 0.5 } },
    },
  };
  const collections = {
    'c:theme': {
      id: 'c:theme', name: 'Theme', defaultModeId: 'mode',
      modes: [{ modeId: 'mode', name: 'Mode' }],
    },
  };

  const result = JSON.parse(await run(root, { variables, collections }));
  const top = result.vars.find((variable) => variable.id === 'v:top');
  const mid = result.vars.find((variable) => variable.id === 'v:mid');
  assert.deepEqual(top.valuesByMode.mode, {
    value: '#ff000020', ref: 'color/role/mid', refId: 'v:mid', opacity: 50,
  });
  assert.deepEqual(mid.valuesByMode.mode, {
    value: '#ff000040', ref: 'color/palette/base', refId: 'v:base', opacity: 50,
  });
});

test('scoped collector emits deterministic alpha bytes for composed opacity 0 and 100', async () => {
  for (const [opacity, expected] of [[0, '#33669900'], [100, '#336699ff']]) {
    const root = {
      id: `n:${opacity}`, name: `opacity ${opacity}`, type: 'FRAME', visible: true,
      boundVariables: { fills: [{ type: 'VARIABLE_ALIAS', id: 'v:role' }] }, children: [],
    };
    const variables = {
      'v:role': {
        id: 'v:role', name: 'color/role', resolvedType: 'COLOR', variableCollectionId: 'c:theme',
        valuesByMode: { mode: {
          type: 'VARIABLE_EXPRESSION', expressionFunction: 'COMPOSE_COLOR',
          expressionArguments: [{ type: 'VARIABLE_ALIAS', id: 'v:base' }, opacity],
        } },
      },
      'v:base': {
        id: 'v:base', name: 'color/base', resolvedType: 'COLOR', variableCollectionId: 'c:theme',
        valuesByMode: { mode: { r: 0.2, g: 0.4, b: 0.6 } },
      },
    };
    const collections = {
      'c:theme': {
        id: 'c:theme', name: 'Theme', defaultModeId: 'mode',
        modes: [{ modeId: 'mode', name: 'Mode' }],
      },
    };
    const result = JSON.parse(await run(root, { variables, collections }));
    assert.equal(result.vars.find((variable) => variable.id === 'v:role').value, expected);
  }
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

test('buildDtcgTree preserves a token that is also a group through standard $root', () => {
  const rootFirst = buildDtcgTree([
    { name: 'space', type: 'FLOAT', value: 8 },
    { name: 'space/lg', type: 'FLOAT', value: 16 },
  ]);
  const childFirst = buildDtcgTree([
    { name: 'space/lg', type: 'FLOAT', value: 16 },
    { name: 'space', type: 'FLOAT', value: 8 },
  ]);
  for (const tree of [rootFirst, childFirst]) {
    assert.equal(tree.space.$root.$value, '8px');
    assert.equal(tree.space.lg.$value, '16px');
    assert.deepEqual(normalizeTokenImportSource(tree)
      .map(({ name, type, value }) => ({ name, type, value }))
      .sort((a, b) => a.name.localeCompare(b.name)), [
        { name: 'space', type: 'FLOAT', value: 8 },
        { name: 'space/lg', type: 'FLOAT', value: 16 },
      ]);
  }
  assert.throws(() => buildDtcgTree([
    { name: 'space/$root', type: 'FLOAT', value: 8 },
  ]), /reserved \$root/);
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

test('TIMING exports use Figma seconds in CSS and DTCG duration values', () => {
  const variable = {
    name: 'motion/duration/fast', type: 'TIMING', value: 0.23999999463558197,
  };
  assert.match(formatCssTokens([variable]), /--motion-duration-fast: 0\.24s;/);
  assert.equal(buildDtcgTree([variable]).motion.duration.fast.$value, '0.24s');
  assert.deepEqual(buildDtcgTree([variable], { dialect: '2025' }).motion.duration.fast, {
    $type: 'duration', $value: { value: 0.24, unit: 's' },
  });
});

test('EASING exports exact CSS where representable and native DTCG extensions everywhere', () => {
  const variables = [
    { id: 'ease-in', name: 'motion/ease-in', type: 'EASING', value: { type: 'EASE_IN' } },
    {
      id: 'custom-cubic', name: 'motion/custom-cubic', type: 'EASING',
      value: {
        type: 'CUSTOM_CUBIC_BEZIER',
        easingFunctionCubicBezier: { x1: 0.1, y1: -0.2, x2: 0.7, y2: 1.2 },
      },
    },
    { id: 'gentle', name: 'motion/gentle', type: 'EASING', value: { type: 'GENTLE' } },
    {
      id: 'spring', name: 'motion/spring', type: 'EASING',
      value: { type: 'CUSTOM_SPRING', easingFunctionSpring: { bounce: 0.4 } },
    },
    { id: 'hold', name: 'motion/hold', type: 'EASING', value: { type: 'HOLD' } },
  ];
  const css = formatCssTokens(variables);
  assert.match(css, /--motion-ease-in: ease-in;/);
  assert.match(css, /--motion-custom-cubic: cubic-bezier\(0\.1, -0\.2, 0\.7, 1\.2\);/);
  assert.match(css, /--motion-hold: steps\(1, jump-end\);/);
  assert.match(css, /--motion-gentle: Figma EASING GENTLE \(spring bounce 0\.25\) has no exact CSS/);
  assert.match(css, /--motion-spring: Figma EASING CUSTOM_SPRING \(spring bounce 0\.4\) has no exact CSS/);
  assert.doesNotMatch(css, /\[object Object\]/);

  const tree = buildDtcgTree(variables, { dialect: '2025' });
  assert.equal(tree.motion['ease-in'].$type, 'cubicBezier');
  assert.deepEqual(tree.motion['ease-in'].$value, [0.42, 0, 1, 1]);
  assert.equal(tree.motion.gentle.$type, 'string');
  assert.equal(tree.motion.gentle.$value, 'GENTLE');
  assert.equal(tree.motion.hold.$value, 'HOLD');
  assert.deepEqual(
    tree.motion.spring.$extensions['figma-bridge-mcp'].easing.value,
    { type: 'CUSTOM_SPRING', easingFunctionSpring: { bounce: 0.4 } },
  );
});

test('named spring canonicalization is stable across Figma float readback and repeated projection', () => {
  for (const value of [
    { type: 'GENTLE', easingFunctionSpring: { bounce: 0.25 } },
    { type: 'QUICK', easingFunctionSpring: { bounce: 0.42264973081037427 } },
    { type: 'BOUNCY', easingFunctionSpring: { bounce: 0.6938137821521027 } },
    { type: 'SLOW', easingFunctionSpring: { bounce: 0 } },
  ]) {
    const canonical = canonicalMotionEasing(value);
    assert.deepEqual(canonicalMotionEasing(canonical), canonical);
  }
});

test('single-mode DTCG EASING export imports its original native type and Alias', () => {
  const tree = buildDtcgTree([
    { id: 'base', name: 'motion/base', type: 'EASING', value: { type: 'EASE_IN_BACK' } },
    {
      id: 'semantic', name: 'motion/semantic', type: 'EASING',
      value: { type: 'EASE_IN_BACK' }, ref: 'motion/base', refId: 'base',
    },
  ], { dialect: '2025' });
  const items = normalizeTokenImportSource(tree);
  assert.deepEqual(items[0], {
    name: 'motion/base', type: 'EASING',
    value: {
      type: 'EASE_IN_BACK',
      easingFunctionCubicBezier: { x1: 0.3, y1: -0.05, x2: 0.7, y2: -0.5 },
    },
  });
  assert.deepEqual(items[1], {
    name: 'motion/semantic', type: 'EASING', alias: 'motion/base',
  });
});

test('standard DTCG cubicBezier imports as a native custom Figma EASING', () => {
  assert.deepEqual(normalizeTokenImportSource({
    motion: {
      emphasis: { $type: 'cubicBezier', $value: [0.2, -0.1, 0.8, 1.1] },
    },
  }), [{
    name: 'motion/emphasis', type: 'EASING',
    value: {
      type: 'CUSTOM_CUBIC_BEZIER',
      easingFunctionCubicBezier: { x1: 0.2, y1: -0.1, x2: 0.8, y2: 1.1 },
    },
  }]);
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
    light: { value: '#ffffff', ref: 'palette/surface', refId: 'primitive' },
    dark: { value: '#1a1a1a', ref: 'palette/surface', refId: 'primitive' },
  });
});

test('duplicate names across Collections remain distinct in CSS and DTCG', () => {
  const variables = [
    { id: 'Variable:a', name: 'radius/sm', collection: 'Primitives', type: 'FLOAT', value: 4 },
    { id: 'Variable:b', name: 'radius/sm', collection: 'Components', type: 'FLOAT', value: 8 },
    {
      id: 'Variable:c', name: 'radius/button', collection: 'Components', type: 'FLOAT', value: 8,
      ref: 'radius/sm', refId: 'Variable:b',
    },
  ];
  const css = formatCssTokens(variables);
  assert.match(css, /--figma-primitives-radius-sm: 4px;/);
  assert.match(css, /--figma-components-radius-sm: 8px;/);
  assert.match(css, /--radius-button: 8px;/);
  assert.doesNotMatch(css, /kept .* above/);

  const tree = buildDtcgTree(variables, { dialect: '2025' });
  assert.deepEqual(
    tree['figma-collections'].Primitives.radius.sm.$value,
    { value: 4, unit: 'px' },
  );
  assert.deepEqual(
    tree['figma-collections'].Components.radius.sm.$value,
    { value: 8, unit: 'px' },
  );
  assert.equal(tree.radius.button.$value, '{figma-collections.Components.radius.sm}');
  assert.equal(
    tree['figma-collections'].Components.radius.sm.$extensions['figma-bridge-mcp'].sourceName,
    'radius/sm',
  );
});

test('formatCssTokens consumes the scoped list unchanged', () => {
  const css = formatCssTokens([
    { name: 'color/surface', type: 'COLOR', value: '#060914' },
    { name: 'spacing/s', type: 'FLOAT', value: 16 },
  ]);
  assert.match(css, /--color-surface: #060914;/);
  assert.match(css, /--spacing-s: 16px;/);
});

test('scoped collector attributes composed opacity to its owner only and matches the file-wide bytes', async () => {
  const root = {
    id: 'n:inherit', name: 'inherit screen', type: 'FRAME', visible: true,
    boundVariables: { fills: [{ type: 'VARIABLE_ALIAS', id: 'v:plain' }, { type: 'VARIABLE_ALIAS', id: 'v:top' }] },
    children: [],
  };
  const variables = {
    'v:plain': {
      id: 'v:plain', name: 'color/role/plain', resolvedType: 'COLOR', variableCollectionId: 'c:theme',
      valuesByMode: { mode: { type: 'VARIABLE_ALIAS', id: 'v:mid' } },
    },
    'v:top': {
      id: 'v:top', name: 'color/role/top', resolvedType: 'COLOR', variableCollectionId: 'c:theme',
      valuesByMode: { mode: {
        type: 'VARIABLE_EXPRESSION', expressionFunction: 'COMPOSE_COLOR',
        expressionArguments: [{ type: 'VARIABLE_ALIAS', id: 'v:mid' }, 70],
      } },
    },
    'v:mid': {
      id: 'v:mid', name: 'color/role/mid', resolvedType: 'COLOR', variableCollectionId: 'c:theme',
      valuesByMode: { mode: {
        type: 'VARIABLE_EXPRESSION', expressionFunction: 'COMPOSE_COLOR',
        expressionArguments: [{ type: 'VARIABLE_ALIAS', id: 'v:base' }, 50],
      } },
    },
    'v:base': {
      id: 'v:base', name: 'color/palette/red', resolvedType: 'COLOR', variableCollectionId: 'c:theme',
      valuesByMode: { mode: { r: 1, g: 0, b: 0 } },
    },
  };
  const collections = {
    'c:theme': {
      id: 'c:theme', name: 'Theme', defaultModeId: 'mode',
      modes: [{ modeId: 'mode', name: 'Mode' }],
    },
  };

  const result = JSON.parse(await run(root, { variables, collections }));
  const scoped = new Map(result.vars.map((variable) => [variable.name, variable.valuesByMode.mode]));
  /* A plain Alias keeps its reference and inherits the visual value, but the
     50 % belongs to color/role/mid — it is not the plain Alias's own authorship. */
  assert.deepEqual(scoped.get('color/role/plain'), {
    value: '#ff000080', ref: 'color/role/mid', refId: 'v:mid',
  });
  assert.deepEqual(scoped.get('color/role/mid'), {
    value: '#ff000080', ref: 'color/palette/red', refId: 'v:base', opacity: 50,
  });
  /* Per-layer alpha bytes: 0x80/255 × 0.7 × 255 = 89.6 → 0x5a, never 0x59. */
  assert.deepEqual(scoped.get('color/role/top'), {
    value: '#ff00005a', ref: 'color/role/mid', refId: 'v:mid', opacity: 70,
  });

  const fileWide = projectVariableModes(Object.values(variables), Object.values(collections));
  for (const name of ['color/role/plain', 'color/role/mid', 'color/role/top']) {
    const projected = fileWide.find((variable) => variable.name === name).valuesByMode.mode;
    assert.deepEqual(scoped.get(name), projected, `${name}: scoped and file-wide projections agree`);
  }
});
