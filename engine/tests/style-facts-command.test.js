import assert from 'node:assert/strict';
import test from 'node:test';
import { planFigmaCommand } from '../../src/capability-catalog.js';
import {
  executeStyleFacts,
  executeStyleFactsPlan,
  MAX_STYLE_FACTS_CONTAINER_ENTRIES,
  styleFactsCode,
  styleFactsPlanRoute,
} from '../src/application/style-facts-command.js';
import {
  acceptsStyleFactsArgv,
  MAX_STYLE_FACTS_QUERY_CODE_UNITS,
  parseStyleFactsRequest,
  styleFactsArgvFromRequest,
} from '../src/application/style-facts-request.js';

const BASE = {
  schemaVersion: 1,
  resolution: 'id',
  id: 'S:10:2',
  key: 'STYLE_KEY',
  name: 'Foundation/Primary',
  description: 'Primary paint',
  descriptionMarkdown: '**Primary** paint',
  documentationLinks: [{ uri: 'https://example.test/design' }],
  type: 'PAINT',
  remote: false,
  boundVariables: {
    paints: [{ type: 'VARIABLE_ALIAS', id: 'VariableID:10:3' }],
  },
};

const PAINT = {
  ...BASE,
  paints: [{
    type: 'GRADIENT_LINEAR',
    gradientTransform: [[1, 0, 0], [0, 1, 0]],
    gradientStops: [{
      position: 0,
      color: { r: 1, g: 0, b: 0, a: 1 },
      boundVariables: { color: { type: 'VARIABLE_ALIAS', id: 'VariableID:10:4' } },
    }],
  }],
};

const TEXT = {
  ...BASE,
  id: 'S:10:5',
  name: 'Type/Body',
  type: 'TEXT',
  boundVariables: { fontSize: { type: 'VARIABLE_ALIAS', id: 'VariableID:10:6' } },
  fontName: { family: 'Inter', style: 'Regular' },
  fontSize: 16,
  textDecoration: 'NONE',
  textCase: 'ORIGINAL',
  letterSpacing: { unit: 'PIXELS', value: 0 },
  lineHeight: { unit: 'PIXELS', value: 24 },
  leadingTrim: 'NONE',
  paragraphIndent: 0,
  paragraphSpacing: 0,
  listSpacing: 0,
  hangingPunctuation: false,
  hangingList: false,
};

const EFFECT = {
  ...BASE,
  id: 'S:10:7',
  name: 'Effect/Card',
  type: 'EFFECT',
  boundVariables: { effects: [{ type: 'VARIABLE_ALIAS', id: 'VariableID:10:9' }] },
  effects: [{
    type: 'DROP_SHADOW',
    color: { r: 0, g: 0, b: 0, a: 0.2 },
    offset: { x: 0, y: 2 },
    radius: 8,
    spread: 0,
    visible: true,
    blendMode: 'NORMAL',
  }],
};

const GRID = {
  ...BASE,
  id: 'S:10:8',
  name: 'Grid/Auto',
  type: 'GRID',
  boundVariables: { layoutGrids: [{ type: 'VARIABLE_ALIAS', id: 'VariableID:10:10' }] },
  layoutGrids: [{
    pattern: 'COLUMNS',
    alignment: 'STRETCH',
    gutterSize: 16,
    count: { $figmaScalar: 'Infinity' },
  }],
};

function pluginStyle(payload) {
  const { schemaVersion: _schemaVersion, resolution: _resolution, ...style } = structuredClone(payload);
  if (style.type === 'GRID') {
    style.layoutGrids = style.layoutGrids.map((grid) => (
      grid.count?.$figmaScalar === 'Infinity' ? { ...grid, count: Infinity } : grid
    ));
  }
  return style;
}

async function runGeneratedStyleFacts(request, figma) {
  return JSON.parse(await new Function('figma', `return ${styleFactsCode(request)}`)(figma));
}

test('Style Facts request closes and canonicalizes one bounded style reference', () => {
  assert.deepEqual(parseStyleFactsRequest(['style', 'show', 'Type/Body']), {
    style: 'Type/Body', type: null,
  });
  assert.deepEqual(parseStyleFactsRequest(['style', 'show', '-tTEXT', '--', '-private']), {
    style: '-private', type: 'TEXT',
  });
  assert.deepEqual(styleFactsArgvFromRequest({ style: '-private', type: 'text' }),
    ['style', 'show', '--type', 'TEXT', '--', '-private']);
  for (const argv of [
    ['style', 'show'],
    ['style', 'show', 'A', 'B'],
    ['style', 'show', '--future', 'Private'],
    ['style', 'show', '--type', 'FUTURE', 'Private'],
    ['style', 'show', '--type', 'TEXT', '--type', 'PAINT', 'Private'],
    ['style', 'show', `x\u202e${'y'.repeat(4)}`],
    ['style', 'show', 'x'.repeat(MAX_STYLE_FACTS_QUERY_CODE_UNITS + 1)],
  ]) assert.equal(acceptsStyleFactsArgv(argv), false, argv.join(' '));
});

test('Style Facts preserve metadata, union structure and binding topology', async () => {
  for (const payload of [PAINT, TEXT, EFFECT, GRID]) {
    let result;
    try {
      result = await executeStyleFacts({ style: payload.id }, {
        evaluate: async () => JSON.stringify(payload),
      });
    } catch (error) {
      throw new Error(`${payload.type} fixture failed: ${error.message}`, { cause: error });
    }
    const projection = JSON.parse(result.stdout);
    assert.equal(Object.hasOwn(projection, 'schemaVersion'), false);
    assert.equal(projection.descriptionMarkdown, payload.descriptionMarkdown);
    assert.deepEqual(projection.documentationLinks, payload.documentationLinks);
    assert.deepEqual(result.result, payload);
  }
  assert.ok(Array.isArray(JSON.parse((await executeStyleFacts({ style: PAINT.id }, {
    evaluate: async () => JSON.stringify(PAINT),
  })).stdout).boundVariables.paints));
  assert.equal(Array.isArray(JSON.parse((await executeStyleFacts({ style: TEXT.id }, {
    evaluate: async () => JSON.stringify(TEXT),
  })).stdout).boundVariables.fontSize), false);
  assert.deepEqual(JSON.parse((await executeStyleFacts({ style: GRID.id }, {
    evaluate: async () => JSON.stringify(GRID),
  })).stdout).layoutGrids[0].count, { $figmaScalar: 'Infinity' });
});

test('Style Facts generated capture owns exact resolution and Plugin-side bounds', () => {
  const code = styleFactsCode({ style: 'Type/Body' });
  assert.match(code, /getStyleByIdAsync/);
  assert.match(code, /Promise\.all/);
  assert.match(code, /requestedType/);
  assert.match(code, /descriptionMarkdown/);
  assert.match(code, /documentationLinks/);
  assert.match(code, /\$figmaScalar/);
  assert.match(code, /serialized-size limit exceeded/);
  assert.doesNotThrow(() => new Function(`return ${code}`));
});

test('Style Facts generated capture executes id and type-narrowed name resolution', async () => {
  const direct = pluginStyle(GRID);
  const noList = () => { throw new Error('unrelated style loader called'); };
  const directResult = await runGeneratedStyleFacts({ style: direct.id }, {
    getStyleByIdAsync: async (id) => id === direct.id ? direct : null,
    getLocalPaintStylesAsync: noList,
    getLocalTextStylesAsync: noList,
    getLocalEffectStylesAsync: noList,
    getLocalGridStylesAsync: noList,
  });
  assert.equal(directResult.resolution, 'id');
  assert.deepEqual(directResult.layoutGrids[0].count, { $figmaScalar: 'Infinity' });

  const text = pluginStyle(TEXT);
  let textLoads = 0;
  const exactResult = await runGeneratedStyleFacts({ style: text.name, type: 'TEXT' }, {
    getStyleByIdAsync: async () => null,
    getLocalTextStylesAsync: async () => { textLoads++; return [text]; },
    getLocalPaintStylesAsync: noList,
    getLocalEffectStylesAsync: noList,
    getLocalGridStylesAsync: noList,
  });
  assert.equal(textLoads, 1);
  assert.equal(exactResult.resolution, 'exact-name');
  assert.equal(exactResult.id, text.id);

  const runtimeDriftText = { ...text };
  delete runtimeDriftText.description;
  delete runtimeDriftText.descriptionMarkdown;
  const runtimeDriftSerialized = await new Function(
    'figma',
    `return ${styleFactsCode({ style: runtimeDriftText.id, type: 'TEXT' })}`,
  )({ getStyleByIdAsync: async () => runtimeDriftText });
  const runtimeDriftResult = await executeStyleFacts(
    { style: runtimeDriftText.id, type: 'TEXT' },
    { evaluate: async () => runtimeDriftSerialized },
  );
  assert.equal(runtimeDriftResult.result.description, null);
  assert.equal(runtimeDriftResult.result.descriptionMarkdown, null);

  const partialResult = await runGeneratedStyleFacts({ style: 'Body', type: 'TEXT' }, {
    getStyleByIdAsync: async () => null,
    getLocalTextStylesAsync: async () => [text],
  });
  assert.equal(partialResult.resolution, 'partial-name');
  assert.equal(partialResult.name, text.name);

  await assert.rejects(
    () => runGeneratedStyleFacts({ style: 'Type', type: 'TEXT' }, {
      getStyleByIdAsync: async () => null,
      getLocalTextStylesAsync: async () => [text, { ...text, id: 'S:other', name: 'Type/Title' }],
    }),
    /ambiguous \(2 matches\)/,
  );
});

test('Style Facts accept every current Plugin API union discriminant', async () => {
  const alias = { type: 'VARIABLE_ALIAS', id: 'VariableID:fixture' };
  const rgba = { r: 0, g: 0, b: 0, a: 1 };
  const gradient = (type) => ({
    type,
    gradientTransform: [[1, 0, 0], [0, 1, 0]],
    gradientStops: [{ position: 0, color: rgba }],
  });
  const paintPayload = {
    ...PAINT,
    paints: [
      { type: 'SOLID', color: { r: 0, g: 0, b: 0 }, boundVariables: { color: alias } },
      ...['GRADIENT_LINEAR', 'GRADIENT_RADIAL', 'GRADIENT_ANGULAR', 'GRADIENT_DIAMOND']
        .map(gradient),
      { type: 'IMAGE', scaleMode: 'FILL', imageHash: null },
      { type: 'VIDEO', scaleMode: 'FIT', videoHash: null },
      {
        type: 'PATTERN', sourceNodeId: '10:20', tileType: 'RECTANGULAR',
        scalingFactor: 1, spacing: { x: 0, y: 0 }, horizontalAlignment: 'CENTER',
      },
      { type: 'SHADER', id: 'shader:paint', properties: { enabled: true, point: { x: 1, y: 2 } } },
    ],
  };
  const effectPayload = {
    ...EFFECT,
    effects: [
      EFFECT.effects[0],
      {
        type: 'INNER_SHADOW', color: rgba, offset: { x: 0, y: 1 }, radius: 2,
        visible: true, blendMode: 'NORMAL',
      },
      { type: 'LAYER_BLUR', radius: 4, visible: true, blurType: 'NORMAL' },
      {
        type: 'BACKGROUND_BLUR', radius: 8, visible: true, blurType: 'PROGRESSIVE',
        startRadius: 0, startOffset: { x: 0, y: 0 }, endOffset: { x: 1, y: 1 },
      },
      {
        type: 'NOISE', color: rgba, visible: true, blendMode: 'NORMAL', noiseSize: 1,
        density: 0.5, noiseType: 'MONOTONE',
      },
      {
        type: 'NOISE', color: rgba, visible: true, blendMode: 'NORMAL', noiseSize: 1,
        density: 0.5, noiseType: 'DUOTONE', secondaryColor: rgba,
      },
      {
        type: 'NOISE', color: rgba, visible: true, blendMode: 'NORMAL', noiseSize: 1,
        density: 0.5, noiseType: 'MULTITONE', opacity: 0.5,
      },
      { type: 'TEXTURE', visible: true, noiseSize: 1, radius: 2, clipToShape: true },
      {
        type: 'GLASS', visible: true, lightIntensity: 0.5, lightAngle: 45,
        refraction: 0.5, depth: 1, dispersion: 0.2, radius: 4,
      },
      { type: 'SHADER', visible: true, id: 'shader:effect', properties: { amount: 0.5 } },
    ],
  };
  const gridPayload = {
    ...GRID,
    layoutGrids: [
      GRID.layoutGrids[0],
      { pattern: 'ROWS', alignment: 'MIN', gutterSize: 8, count: 4, sectionSize: 12 },
      { pattern: 'GRID', sectionSize: 8, boundVariables: { sectionSize: alias } },
    ],
  };
  for (const payload of [paintPayload, effectPayload, gridPayload]) {
    await assert.doesNotReject(() => executeStyleFacts({ style: payload.id }, {
      evaluate: async () => JSON.stringify(payload),
    }));
  }

  const withoutBindings = pluginStyle(EFFECT);
  delete withoutBindings.boundVariables;
  const generated = await runGeneratedStyleFacts({ style: withoutBindings.id }, {
    getStyleByIdAsync: async () => withoutBindings,
  });
  assert.equal(Object.hasOwn(generated, 'boundVariables'), false);
});

test('Style Facts reject malformed, drifted and unbounded Plugin results', async () => {
  for (const payload of [
    { ...PAINT, type: 'FUTURE' },
    { ...PAINT, paints: [{ type: 'FUTURE' }] },
    { ...PAINT, paints: [{ type: 'SOLID', private: true }] },
    {
      ...PAINT,
      paints: [{
        type: 'SOLID', color: { r: 0, g: 0, b: 0 },
        opacity: { $figmaScalar: 'NaN' },
      }],
    },
    { ...PAINT, boundVariables: { future: [] } },
    { ...GRID, layoutGrids: [{ pattern: 'COLUMNS', count: null }] },
    { ...TEXT, boundVariables: { fontSize: [{ type: 'VARIABLE_ALIAS', id: 'x' }] } },
    { ...PAINT, documentationLinks: [{ uri: 'x', private: true }] },
    { ...PAINT, id: 'S:other' },
    {
      ...PAINT,
      paints: Array.from({ length: MAX_STYLE_FACTS_CONTAINER_ENTRIES + 1 }, () => ({
        type: 'SOLID', color: { r: 0, g: 0, b: 0 },
      })),
    },
  ]) {
    await assert.rejects(
      () => executeStyleFacts({ style: PAINT.id }, {
        evaluate: async () => JSON.stringify(payload),
      }),
      /invalid bounded result/,
    );
  }
  await assert.rejects(
    () => executeStyleFacts({ style: PAINT.id }, { evaluate: async () => PAINT }),
    /invalid bounded result/,
  );
});

test('Style Facts Plan route accepts only its authentic safe-read Plan', async () => {
  const plan = planFigmaCommand(['style', 'show', TEXT.id], { adapter: 'cli' });
  assert.equal(plan.allowed, true);
  assert.equal(plan.id, 'style.show');
  assert.equal(plan.effects.figma, 'read');
  assert.equal(plan.confirmation, 'none');
  assert.equal(plan.execution.retry, 'safe-read');
  assert.deepEqual(plan.argv, ['style', 'show', '--', TEXT.id]);
  assert.equal(styleFactsPlanRoute(plan), 'command-application');
  assert.deepEqual((await executeStyleFactsPlan(plan, {
    evaluate: async () => JSON.stringify(TEXT),
  })).result, TEXT);
  await assert.rejects(
    () => executeStyleFactsPlan({ ...plan }, { evaluate: async () => JSON.stringify(TEXT) }),
    /requires a Command Plan created by the Capability Catalog/,
  );
  assert.equal(styleFactsPlanRoute(
    planFigmaCommand(['style', 'list'], { adapter: 'mcp' }),
  ), 'not-style-facts');
});

test('Style Facts type narrowing is canonical and rejects mismatched results', async () => {
  const plan = planFigmaCommand(
    ['style', 'show', '--type=text', 'Type/Body'],
    { adapter: 'mcp' },
  );
  assert.deepEqual(plan.argv, ['style', 'show', '--type', 'TEXT', '--', 'Type/Body']);
  assert.equal(plan.execution.retry, 'safe-read');
  await assert.rejects(
    () => executeStyleFacts({ style: PAINT.id, type: 'TEXT' }, {
      evaluate: async () => JSON.stringify(PAINT),
    }),
    /invalid bounded result/,
  );
});
