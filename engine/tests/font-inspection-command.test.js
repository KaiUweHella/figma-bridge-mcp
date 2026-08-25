import assert from 'node:assert/strict';
import test from 'node:test';
import { planFigmaCommand } from '../../src/capability-catalog.js';
import {
  executeFontInspection,
  executeFontInspectionPlan,
  fontInspectionCode,
  fontInspectionPlanRoute,
} from '../src/application/font-inspection-command.js';
import {
  acceptsFontInspectionArgv,
  fontInspectionArgvFromRequest,
  fontInspectionPlanningArgvFromRequest,
  parseFontInspectionRequest,
} from '../src/application/font-inspection-request.js';
import { FONT_AXIS_METADATA_KEY, fontInspectCode } from '../src/lib/font-introspection.js';

function fixture({ characters = 'Hello', segments, metadata } = {}) {
  const node = {
    id: '12:34',
    type: 'TEXT',
    name: 'Label',
    characters,
    getStyledTextSegments: (_fields, start = 0, end = characters.length) => segments || [{
      start,
      end,
      characters: characters.slice(start, end),
      fontName: { family: 'Roboto Flex', style: 'Regular' },
      fontSize: 16,
      fontWeight: 357,
      openTypeFeatures: { LIGA: true, SS01: false },
      boundVariables: { fontWeight: { id: 'VariableID:1:2' } },
    }],
    getPluginData: (key) => key === FONT_AXIS_METADATA_KEY
      ? JSON.stringify(metadata || {
        schemaVersion: 1,
        ranges: [{ start: 0, end: characters.length, axes: { wght: 357 } }],
      }) : '',
  };
  const figma = {
    getNodeByIdAsync: async (id) => id === node.id ? node : null,
    variables: {
      getVariableByIdAsync: async (id) => id === 'VariableID:1:2'
        ? { id, name: 'type/weight' } : null,
    },
  };
  return { node, figma };
}

async function captured(request, source = fixture()) {
  return new Function('figma', `return ${fontInspectionCode(request)};`)(source.figma);
}

test('Font Inspection request closes ranges, options and semantic node targeting', () => {
  assert.deepEqual(parseFontInspectionRequest([
    'font', 'inspect', '--end=5', '--all-open-type', '12-34', '--start', '0',
  ]), { nodeId: '12:34', start: 0, end: 5, allOpenType: true });
  assert.deepEqual(fontInspectionArgvFromRequest({
    nodeId: '12:34', start: 0, end: 5, allOpenType: true,
  }), ['font', 'inspect', '12:34', '--start', '0', '--end', '5', '--all-open-type']);

  const url = 'https://www.figma.com/design/FILEA/Type?node-id=12-34';
  assert.deepEqual(fontInspectionPlanningArgvFromRequest({ nodeId: url, end: 5 }),
    ['font', 'inspect', url, '--end', '5']);
  for (const args of [
    ['font', 'inspect'],
    ['font', 'inspect', '12:34', '56:78'],
    ['font', 'inspect', 'bad-node'],
    ['font', 'inspect', '12:34', '--start'],
    ['font', 'inspect', '12:34', '--start', '-1'],
    ['font', 'inspect', '12:34', '--start', '6', '--end', '5'],
    ['font', 'inspect', '12:34', '--all-open-type', '--all-open-type'],
    ['font', 'inspect', '12:34', '--future'],
  ]) assert.equal(acceptsFontInspectionArgv(args), false, args.join(' '));
});

test('Font Inspection captures exact typography, binding and honest axis facts', async () => {
  const serialized = await captured({ nodeId: '12:34' });
  const execution = await executeFontInspection({ nodeId: '12:34' }, {
    evaluate: async () => serialized,
  });
  assert.deepEqual(execution.result, {
    schemaVersion: 1,
    id: '12:34',
    name: 'Label',
    characters: 'Hello',
    range: { start: 0, end: 5 },
    segments: [{
      start: 0,
      end: 5,
      characters: 'Hello',
      fontName: { family: 'Roboto Flex', style: 'Regular' },
      fontSize: 16,
      fontWeight: 357,
      enabledOpenTypeFeatures: ['LIGA'],
      boundVariables: {
        fontWeight: { id: 'VariableID:1:2', name: 'type/weight' },
      },
    }],
    axisMetadata: {
      schemaVersion: 1,
      ranges: [{ start: 0, end: 5, axes: { wght: 357 } }],
      source: 'plugin-data',
      appliedToFont: false,
    },
    apiLimits: {
      exactVariationAxes: false,
      fontWeight: 'read-only Figma value; not a general variation-axis tuple',
      openTypeFeatures: 'read-only',
    },
  });
  const { schemaVersion: _schemaVersion, ...projection } = execution.result;
  assert.deepEqual(JSON.parse(execution.stdout), projection);

  const rangeSerialized = await captured({ nodeId: '12:34', start: 1, end: 4 });
  const rangeExecution = await executeFontInspection({ nodeId: '12:34', start: 1, end: 4 }, {
    evaluate: async () => rangeSerialized,
  });
  assert.deepEqual(rangeExecution.result.range, { start: 1, end: 4 });
  assert.equal(rangeExecution.result.segments[0].characters, 'ell');
});

test('Font Inspection preserves complete feature state only when requested and escapes controls', async () => {
  const source = fixture({ characters: 'A\u202eB' });
  const serialized = await captured({
    nodeId: '12:34', start: 0, end: 3, allOpenType: true,
  }, source);
  const execution = await executeFontInspection({
    nodeId: '12:34', start: 0, end: 3, allOpenType: true,
  }, { evaluate: async () => serialized });
  assert.deepEqual(execution.result.segments[0].openTypeFeatures,
    { LIGA: true, SS01: false });
  assert.doesNotMatch(execution.stdout, /\u202e/);
  assert.match(execution.stdout, /\\u202e/);
  assert.equal(JSON.parse(execution.stdout).characters, 'A\u202eB');
});

test('Font Inspection rejects plugin-side excess and malformed host results', async () => {
  const source = fixture();
  const boundedCode = fontInspectCode({
    nodeId: '12:34',
    bounds: { maxCharacters: 4, maxSegments: 10, maxFacts: 10, maxString: 100 },
  });
  await assert.rejects(
    () => new Function('figma', `return ${boundedCode};`)(source.figma),
    /bounded character contract/,
  );

  const longCharacters = 'a'.repeat(70_000);
  const longSerialized = await captured({ nodeId: '12:34' }, fixture({
    characters: longCharacters,
  }));
  assert.equal((await executeFontInspection({ nodeId: '12:34' }, {
    evaluate: async () => longSerialized,
  })).result.characters.length, 70_000,
  'one legitimate long uniform segment must use the aggregate character budget');

  await assert.rejects(() => captured({ nodeId: '12:34' }, fixture({
    segments: [{
      start: 0, end: 5, characters: 'Hello',
      fontName: { family: 'Inter', style: 'Regular' },
      fontSize: 16, fontWeight: 400, openTypeFeatures: {},
      boundVariables: { fontWeight: [{ id: 'VariableID:1:2' }] },
    }],
  })), /unsupported binding topology/);

  const valid = JSON.parse(await captured({ nodeId: '12:34' }));
  for (const malformed of [
    { not: 'serialized' },
    JSON.stringify({ ...valid, schemaVersion: 2 }),
    JSON.stringify({
      ...valid,
      segments: [{ ...valid.segments[0], start: 1 }],
    }),
    JSON.stringify({
      ...valid,
      segments: [{ ...valid.segments[0], enabledOpenTypeFeatures: ['BAD'] }],
    }),
  ]) {
    await assert.rejects(
      () => executeFontInspection({ nodeId: '12:34' }, { evaluate: async () => malformed }),
      /invalid bounded result/,
    );
  }
});

test('Font Inspection Plan route accepts only its authentic safe-read Plan', async () => {
  const url = 'https://www.figma.com/design/FILEA/Type?node-id=12-34';
  const plan = planFigmaCommand([
    'font', 'inspect', '--all-open-type', url, '--end=5',
  ], { adapter: 'mcp' });
  assert.equal(plan.allowed, true);
  assert.equal(plan.id, 'font.inspect');
  assert.equal(plan.execution.retry, 'safe-read');
  assert.equal(plan.target.fileKey, 'FILEA');
  assert.deepEqual(plan.argv,
    ['font', 'inspect', '12:34', '--end', '5', '--all-open-type']);
  assert.equal(fontInspectionPlanRoute(plan), 'command-application');
  const cliPlan = planFigmaCommand([
    'font', 'inspect', url, '--end', '5', '--all-open-type',
  ], { adapter: 'cli' });
  assert.equal(cliPlan.allowed, true);
  assert.deepEqual(cliPlan.argv, plan.argv);
  assert.deepEqual(cliPlan.effects, plan.effects);
  assert.deepEqual(cliPlan.execution, plan.execution);

  const serialized = await captured({ nodeId: '12:34', end: 5, allOpenType: true });
  assert.equal((await executeFontInspectionPlan(plan, {
    evaluate: async () => serialized,
  })).result.segments[0].fontWeight, 357);
  await assert.rejects(
    () => executeFontInspectionPlan({ ...plan }, { evaluate: async () => serialized }),
    /requires a Command Plan created by the Capability Catalog/,
  );
  assert.equal(fontInspectionPlanRoute(planFigmaCommand(['font', 'axes', '12:34'])),
    'not-font-inspection');
});
