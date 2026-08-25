import assert from 'node:assert/strict';
import test from 'node:test';
import { planFigmaCommand } from '../../src/capability-catalog.js';
import {
  executeStyleConsumer,
  executeStyleConsumerPlan,
  MAX_STYLE_CONSUMER_CANDIDATES,
  styleConsumerCode,
  styleConsumerPlanRoute,
  styleConsumerPlanningArgvFromRequest,
} from '../src/application/style-consumer-command.js';
import {
  acceptsStyleConsumerArgv,
  decodeStyleConsumerCursor,
  encodeStyleConsumerCursor,
  parseStyleConsumerRequest,
  styleConsumerArgvFromRequest,
} from '../src/application/style-consumer-request.js';

const consumer = (id, name, fields = ['fillStyleId']) => ({
  node: { id, name, type: 'FRAME' }, fields,
});

function style(consumers, overrides = {}) {
  return {
    id: 'S:1', key: 'STYLE_KEY', name: 'Surface', type: 'PAINT', remote: false,
    getStyleConsumersAsync: async () => consumers,
    ...overrides,
  };
}

function figmaFor(target, calls = []) {
  return {
    getStyleByIdAsync: async (query) => query === target.id ? target : null,
    getLocalPaintStylesAsync: async () => { calls.push('PAINT'); return [target]; },
    getLocalTextStylesAsync: async () => { calls.push('TEXT'); return []; },
    getLocalEffectStylesAsync: async () => { calls.push('EFFECT'); return []; },
    getLocalGridStylesAsync: async () => { calls.push('GRID'); return []; },
  };
}

async function pluginResult(request, target, calls = []) {
  return new Function('figma', `return ${styleConsumerCode(request)}`)(figmaFor(target, calls));
}

test('Style Consumer request closes query, family, limit, and cursor options', () => {
  assert.deepEqual(parseStyleConsumerRequest([
    'style', 'consumers', '--type=paint', '--limit', '2', '--', 'Surface',
  ]), {
    style: 'Surface', type: 'PAINT', limit: 2, cursor: null, after: null,
  });
  assert.deepEqual(styleConsumerArgvFromRequest({ style: 'Surface' }),
    ['style', 'consumers', '--limit', '100', '--', 'Surface']);
  for (const argv of [
    ['style', 'consumers'],
    ['style', 'consumers', 'A', 'B'],
    ['style', 'consumers', '--future', 'private-value'],
    ['style', 'consumers', '--limit', '0', 'Surface'],
    ['style', 'consumers', '--cursor', 'not/base64', 'Surface'],
  ]) assert.equal(acceptsStyleConsumerArgv(argv), false, argv.join(' '));
});

test('Style Consumer cursor is canonical and bound to query plus family', () => {
  const anchor = { nodeId: '10:1', fields: ['fillStyleId', 'strokeStyleId'] };
  const cursor = encodeStyleConsumerCursor('Surface', 'PAINT', anchor);
  assert.deepEqual(decodeStyleConsumerCursor(cursor, 'Surface', 'PAINT').after, anchor);
  assert.throws(() => decodeStyleConsumerCursor(cursor, 'Other', 'PAINT'), /does not match/);
  assert.throws(() => decodeStyleConsumerCursor(cursor, 'Surface', 'TEXT'), /does not match/);
  assert.throws(() => encodeStyleConsumerCursor('Surface', 'PAINT', {
    nodeId: '10:1', fields: ['futureStyleId'],
  }), /anchor is invalid/);
});

test('Style Consumer resolves one typed family and returns a truthful complete scan page', async () => {
  const target = style([consumer('10:2', 'Card'), consumer('10:1', 'Button')]);
  const calls = [];
  const serialized = await pluginResult({ style: 'Surface', type: 'PAINT', limit: 10 }, target, calls);
  assert.deepEqual(calls, ['PAINT']);
  const result = await executeStyleConsumer({ style: 'Surface', type: 'PAINT', limit: 10 }, {
    evaluate: async () => serialized,
  });
  assert.equal(result.result.resolution, 'exact-name');
  assert.deepEqual(result.result.consumers.map(({ node }) => node.id), ['10:1', '10:2']);
  assert.deepEqual(result.result.scan, {
    api: 'getStyleConsumersAsync', complete: true, interruptible: false,
  });
  assert.equal(result.result.total, 2);
  assert.equal(result.result.complete, true);
  assert.equal(result.result.next, null);
});

test('Style Consumer pagination exposes native completeness without mislabeling partial pages', async () => {
  const target = style([
    consumer('10:3', 'Third'), consumer('10:1', 'First'), consumer('10:2', 'Second'),
  ]);
  const firstSerialized = await pluginResult({ style: 'S:1', limit: 2 }, target);
  const first = await executeStyleConsumer({ style: 'S:1', limit: 2 }, {
    evaluate: async () => firstSerialized,
  });
  assert.equal(first.result.scan.complete, true, 'native API returned the complete candidate array');
  assert.equal(first.result.complete, false, 'the projected page is incomplete');
  assert.equal(first.result.omittedAfter, 1);
  assert.equal(typeof first.result.next, 'string');

  const secondRequest = { style: 'S:1', limit: 2, cursor: first.result.next };
  const secondSerialized = await pluginResult(secondRequest, target);
  const second = await executeStyleConsumer(secondRequest, {
    evaluate: async () => secondSerialized,
  });
  assert.deepEqual(second.result.consumers.map(({ node }) => node.id), ['10:3']);
  assert.equal(second.result.omittedBefore, 2);
  assert.equal(second.result.omittedAfter, 0);
  assert.equal(second.result.complete, false);
  assert.equal(second.result.next, null);
});

test('Style Consumer rejects stale cursors, unknown fields, duplicates, and candidate overflow', async () => {
  const cursor = encodeStyleConsumerCursor('S:1', null, {
    nodeId: '99:1', fields: ['fillStyleId'],
  });
  await assert.rejects(
    () => pluginResult({ style: 'S:1', limit: 2, cursor }, style([consumer('10:1', 'Card')])),
    /cursor is stale/,
  );
  await assert.rejects(
    () => pluginResult({ style: 'S:1', limit: 2 }, style([
      consumer('10:1', 'Card', ['futureStyleId']),
    ])),
    /incompatible inherited style field/,
  );
  await assert.rejects(
    () => pluginResult({ style: 'S:1', limit: 2 }, style([
      consumer('10:1', 'Card'), consumer('10:1', 'Card'),
    ])),
    /duplicate node\/field identity/,
  );
  await assert.rejects(
    () => pluginResult({ style: 'S:1', limit: 2 }, style(
      new Array(MAX_STYLE_CONSUMER_CANDIDATES + 1),
    )),
    /candidate limit exceeded/,
  );
});

test('Style Consumer rejects malformed and self-inconsistent Plugin results', async () => {
  const serialized = await pluginResult({ style: 'S:1', limit: 2 }, style([
    consumer('10:1', 'Card'),
  ]));
  const payload = JSON.parse(serialized);
  for (const malformed of [
    { ...payload, total: 2 },
    { ...payload, scan: { ...payload.scan, interruptible: true } },
    { ...payload, style: { ...payload.style, remote: 'false' } },
    { ...payload, consumers: [{ ...payload.consumers[0], future: 'private' }] },
  ]) {
    await assert.rejects(
      () => executeStyleConsumer({ style: 'S:1', limit: 2 }, {
        evaluate: async () => JSON.stringify(malformed),
      }),
      /invalid bounded result/,
    );
  }
});

test('Style Consumer Plan owns a longer policy-identical safe read', async () => {
  const argv = styleConsumerPlanningArgvFromRequest({
    style: 'Surface', type: 'PAINT', limit: 25,
  });
  const cli = planFigmaCommand(argv, { adapter: 'cli' });
  const mcp = planFigmaCommand([
    'style', 'consumers', '--limit=25', '-tPAINT', 'Surface',
  ], { adapter: 'mcp' });
  assert.deepEqual(cli.argv, mcp.argv);
  assert.deepEqual(cli.effects, mcp.effects);
  assert.equal(cli.execution.retry, 'safe-read');
  assert.equal(cli.execution.timeout, 'long');
  assert.equal(styleConsumerPlanRoute(cli), 'command-application');
  const serialized = await pluginResult({ style: 'Surface', type: 'PAINT', limit: 25 }, style([]));
  assert.equal((await executeStyleConsumerPlan(cli, {
    evaluate: async () => serialized,
  })).result.total, 0);
  await assert.rejects(
    () => executeStyleConsumerPlan({ ...cli }, { evaluate: async () => serialized }),
    /requires a Command Plan created by the Capability Catalog/,
  );
  assert.equal(styleConsumerPlanRoute(
    planFigmaCommand(['style', 'list'], { adapter: 'mcp' }),
  ), 'not-style-consumer');
});

test('Style Consumer generated Plugin code parses', () => {
  assert.doesNotThrow(() => new Function(`return ${styleConsumerCode({ style: 'S:1' })}`));
});
