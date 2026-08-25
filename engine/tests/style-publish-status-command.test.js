import assert from 'node:assert/strict';
import test from 'node:test';
import { planFigmaCommand } from '../../src/capability-catalog.js';
import {
  executeStylePublishStatus,
  executeStylePublishStatusPlan,
  MAX_STYLE_PUBLISH_STATUS_CANDIDATES,
  stylePublishStatusCode,
  stylePublishStatusPlanRoute,
  stylePublishStatusPlanningArgvFromRequest,
} from '../src/application/style-publish-status-command.js';
import {
  acceptsStylePublishStatusArgv,
  parseStylePublishStatusRequest,
  stylePublishStatusArgvFromRequest,
} from '../src/application/style-publish-status-request.js';

function style(overrides = {}) {
  return {
    id: 'S:1',
    key: 'STYLE_KEY',
    name: 'Body',
    type: 'TEXT',
    remote: false,
    getPublishStatusAsync: async () => 'CURRENT',
    ...overrides,
  };
}

function figmaFor(target, calls = []) {
  return {
    getStyleByIdAsync: async (query) => (query === target.id ? target : null),
    getLocalPaintStylesAsync: async () => {
      calls.push('PAINT');
      return [];
    },
    getLocalTextStylesAsync: async () => {
      calls.push('TEXT');
      return [target];
    },
    getLocalEffectStylesAsync: async () => {
      calls.push('EFFECT');
      return [];
    },
    getLocalGridStylesAsync: async () => {
      calls.push('GRID');
      return [];
    },
  };
}

async function pluginResult(request, target, calls = []) {
  return new Function('figma', `return ${stylePublishStatusCode(request)}`)(
    figmaFor(target, calls),
  );
}

test('Style Publish Status request closes query and optional family', () => {
  assert.deepEqual(
    parseStylePublishStatusRequest(['style', 'publish-status', '--type=text', '--', 'Body']),
    { style: 'Body', type: 'TEXT' },
  );
  assert.deepEqual(stylePublishStatusArgvFromRequest({ style: 'Body' }), [
    'style',
    'publish-status',
    '--',
    'Body',
  ]);
  assert.deepEqual(stylePublishStatusArgvFromRequest({ style: 'Body', type: 'grid' }), [
    'style',
    'publish-status',
    '--type',
    'GRID',
    '--',
    'Body',
  ]);
  for (const argv of [
    ['style', 'publish-status'],
    ['style', 'publish-status', 'A', 'B'],
    ['style', 'publish-status', '--future', 'private-value'],
    ['style', 'publish-status', '--type', 'FUTURE', 'Body'],
  ])
    assert.equal(acceptsStylePublishStatusArgv(argv), false, argv.join(' '));
});

test('Style Publish Status resolves one typed family and projects compact official facts', async () => {
  const target = style();
  const calls = [];
  const serialized = await pluginResult({ style: 'Body', type: 'TEXT' }, target, calls);
  assert.deepEqual(calls, ['TEXT']);
  const result = await executeStylePublishStatus(
    { style: 'Body', type: 'TEXT' },
    {
      evaluate: async () => serialized,
    },
  );
  assert.equal(result.result.resolution, 'exact-name');
  assert.equal(result.result.publishStatus, 'CURRENT');
  assert.deepEqual(result.result.style, {
    id: 'S:1',
    key: 'STYLE_KEY',
    name: 'Body',
    type: 'TEXT',
    remote: false,
  });
  assert.equal(Object.hasOwn(result.result.style, 'fontName'), false);
});

test('Style Publish Status resolves ids without scanning and retains every official status', async () => {
  for (const publishStatus of ['UNPUBLISHED', 'CURRENT', 'CHANGED']) {
    const calls = [];
    const target = style({ getPublishStatusAsync: async () => publishStatus });
    const serialized = await pluginResult({ style: 'S:1' }, target, calls);
    const result = await executeStylePublishStatus(
      { style: 'S:1' },
      {
        evaluate: async () => serialized,
      },
    );
    assert.deepEqual(calls, []);
    assert.equal(result.result.resolution, 'id');
    assert.equal(result.result.publishStatus, publishStatus);
  }
});

test('Style Publish Status rejects ambiguity, overflow, and incompatible Plugin facts', async () => {
  const ambiguous = style();
  const second = style({ id: 'S:2', name: 'Body' });
  const figma = figmaFor(ambiguous);
  figma.getLocalTextStylesAsync = async () => [ambiguous, second];
  await assert.rejects(
    () => new Function('figma', `return ${stylePublishStatusCode({ style: 'Body' })}`)(figma),
    /ambiguous/,
  );
  const overflowFigma = figmaFor(ambiguous);
  overflowFigma.getLocalTextStylesAsync = async () =>
    Array.from({ length: MAX_STYLE_PUBLISH_STATUS_CANDIDATES + 1 }, () => ambiguous);
  await assert.rejects(
    () =>
      new Function('figma', `return ${stylePublishStatusCode({ style: 'Missing' })}`)(
        overflowFigma,
      ),
    /candidate limit exceeded/,
  );
  await assert.rejects(
    () =>
      pluginResult(
        { style: 'S:1' },
        style({
          getPublishStatusAsync: async () => 'FUTURE',
        }),
      ),
    /unsupported Figma status/,
  );
});

test('Style Publish Status rejects malformed and self-inconsistent results', async () => {
  const serialized = await pluginResult({ style: 'S:1' }, style());
  const payload = JSON.parse(serialized);
  for (const malformed of [
    { ...payload, publishStatus: 'FUTURE' },
    { ...payload, resolution: 'exact-name' },
    { ...payload, style: { ...payload.style, remote: 'false' } },
    { ...payload, future: 'private' },
  ]) {
    await assert.rejects(
      () =>
        executeStylePublishStatus(
          { style: 'S:1' },
          {
            evaluate: async () => JSON.stringify(malformed),
          },
        ),
      /invalid bounded result/,
    );
  }
});

test('Style Publish Status Plan owns one policy-identical safe read', async () => {
  const argv = stylePublishStatusPlanningArgvFromRequest({
    style: 'Body',
    type: 'TEXT',
  });
  const cli = planFigmaCommand(argv, { adapter: 'cli' });
  const mcp = planFigmaCommand(['style', 'publish-status', '-tTEXT', 'Body'], {
    adapter: 'mcp',
  });
  assert.deepEqual(cli.argv, mcp.argv);
  assert.deepEqual(cli.effects, mcp.effects);
  assert.deepEqual(cli.execution, mcp.execution);
  assert.equal(cli.execution.retry, 'safe-read');
  assert.equal(stylePublishStatusPlanRoute(cli), 'command-application');
  const serialized = await pluginResult({ style: 'Body', type: 'TEXT' }, style());
  assert.equal(
    (
      await executeStylePublishStatusPlan(cli, {
        evaluate: async () => serialized,
      })
    ).result.publishStatus,
    'CURRENT',
  );
  await assert.rejects(
    () => executeStylePublishStatusPlan({ ...cli }, { evaluate: async () => serialized }),
    /requires a Command Plan created by the Capability Catalog/,
  );
  assert.equal(
    stylePublishStatusPlanRoute(planFigmaCommand(['style', 'show', 'Body'], { adapter: 'mcp' })),
    'not-style-publish-status',
  );
});

test('Style Publish Status generated Plugin code parses', () => {
  assert.doesNotThrow(() => new Function(`return ${stylePublishStatusCode({ style: 'S:1' })}`));
});
