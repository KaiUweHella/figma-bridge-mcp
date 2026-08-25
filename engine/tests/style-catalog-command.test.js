import assert from 'node:assert/strict';
import test from 'node:test';
import { planFigmaCommand } from '../../src/capability-catalog.js';
import {
  executeStyleCatalog,
  executeStyleCatalogPlan,
  MAX_STYLE_CATALOG_CANDIDATES,
  styleCatalogCode,
  styleCatalogPlanRoute,
  styleCatalogPlanningArgvFromRequest,
} from '../src/application/style-catalog-command.js';
import {
  acceptsStyleCatalogArgv,
  decodeStyleCatalogCursor,
  encodeStyleCatalogCursor,
  parseStyleCatalogRequest,
  styleCatalogArgvFromRequest,
} from '../src/application/style-catalog-request.js';

const style = (id, name, type = 'TEXT') => ({
  id, key: `KEY_${id}`, name, type, remote: false,
});

function figmaWith({ PAINT = [], TEXT = [], EFFECT = [], GRID = [] } = {}, calls = []) {
  return {
    getLocalPaintStylesAsync: async () => { calls.push('PAINT'); return PAINT; },
    getLocalTextStylesAsync: async () => { calls.push('TEXT'); return TEXT; },
    getLocalEffectStylesAsync: async () => { calls.push('EFFECT'); return EFFECT; },
    getLocalGridStylesAsync: async () => { calls.push('GRID'); return GRID; },
  };
}

async function pluginResult(request, catalog, calls = []) {
  return new Function('figma', `return ${styleCatalogCode(request)}`)(figmaWith(catalog, calls));
}

test('Style Catalog request closes options and canonicalizes the default limit', () => {
  assert.deepEqual(parseStyleCatalogRequest(['style', 'list', '--type=text', '--limit', '2']), {
    type: 'TEXT', limit: 2, cursor: null, after: null,
  });
  assert.deepEqual(styleCatalogArgvFromRequest({}),
    ['style', 'list', '--limit', '100']);
  assert.deepEqual(styleCatalogArgvFromRequest({ type: 'grid', limit: 25 }),
    ['style', 'list', '--type', 'GRID', '--limit', '25']);
  for (const argv of [
    ['style', 'list', 'private-value'],
    ['style', 'list', '--future', 'private-value'],
    ['style', 'list', '--limit', '0'],
    ['style', 'list', '--limit', '501'],
    ['style', 'list', '--type', 'TEXT', '--type', 'GRID'],
    ['style', 'list', '--cursor', 'not/base64'],
  ]) assert.equal(acceptsStyleCatalogArgv(argv), false, argv.join(' '));
});

test('Style Catalog cursor is canonical, scope-bound, and topology-checked', () => {
  const anchor = { type: 'TEXT', name: 'Body', id: 'S:1' };
  const cursor = encodeStyleCatalogCursor('TEXT', anchor);
  assert.deepEqual(decodeStyleCatalogCursor(cursor, 'TEXT').after, anchor);
  assert.throws(() => decodeStyleCatalogCursor(cursor, 'GRID'), /does not match/);
  assert.throws(
    () => encodeStyleCatalogCursor('TEXT', { ...anchor, future: 'private' }),
    /anchor is invalid/,
  );
});

test('typed Style Catalog loads only one requested family', async () => {
  const calls = [];
  const serialized = await pluginResult({ type: 'TEXT', limit: 10 }, {
    TEXT: [style('S:2', 'Caption'), style('S:1', 'Body')],
  }, calls);
  assert.deepEqual(calls, ['TEXT']);
  const result = await executeStyleCatalog({ type: 'TEXT', limit: 10 }, {
    evaluate: async () => serialized,
  });
  assert.deepEqual(result.result.styles.map(({ name }) => name), ['Body', 'Caption']);
  assert.equal(result.result.total, 2);
  assert.equal(result.result.complete, true);
  assert.equal(result.result.next, null);
});

test('untyped Style Catalog loads four families concurrently and sorts compact identities', async () => {
  const calls = [];
  const resolvers = {};
  const values = {
    PAINT: [style('S:4', 'Brand', 'PAINT')],
    TEXT: [style('S:2', 'Body', 'TEXT')],
    EFFECT: [style('S:3', 'Shadow', 'EFFECT')],
    GRID: [style('S:1', 'Columns', 'GRID')],
  };
  const figma = Object.fromEntries(['PAINT', 'TEXT', 'EFFECT', 'GRID'].map((type) => [
    `getLocal${type[0]}${type.slice(1).toLowerCase()}StylesAsync`,
    () => {
      calls.push(type);
      return new Promise((resolve) => { resolvers[type] = resolve; });
    },
  ]));
  const evaluation = new Function(
    'figma', `return ${styleCatalogCode({ limit: 10 })}`,
  )(figma);
  await Promise.resolve();
  assert.deepEqual(new Set(calls), new Set(['PAINT', 'TEXT', 'EFFECT', 'GRID']));
  for (const type of calls) resolvers[type](values[type]);
  const serialized = await evaluation;
  const result = await executeStyleCatalog({ limit: 10 }, {
    evaluate: async () => serialized,
  });
  assert.deepEqual(result.result.styles.map(({ type }) => type),
    ['EFFECT', 'GRID', 'PAINT', 'TEXT']);
  assert.deepEqual(Object.keys(result.result.styles[0]).sort(),
    ['id', 'key', 'name', 'remote', 'type']);
});

test('Style Catalog pagination exposes omission and never calls a partial page complete', async () => {
  const catalog = {
    TEXT: [style('S:3', 'Title'), style('S:1', 'Body'), style('S:2', 'Caption')],
  };
  const firstSerialized = await pluginResult({ type: 'TEXT', limit: 2 }, catalog);
  const first = await executeStyleCatalog({ type: 'TEXT', limit: 2 }, {
    evaluate: async () => firstSerialized,
  });
  assert.equal(first.result.returned, 2);
  assert.equal(first.result.omitted, 1);
  assert.equal(first.result.omittedBefore, 0);
  assert.equal(first.result.omittedAfter, 1);
  assert.equal(first.result.complete, false);
  assert.equal(typeof first.result.next, 'string');
  assert.equal(JSON.parse(first.stdout).next, first.result.next);

  const secondRequest = { type: 'TEXT', limit: 2, cursor: first.result.next };
  const secondSerialized = await pluginResult(secondRequest, catalog);
  const second = await executeStyleCatalog(secondRequest, {
    evaluate: async () => secondSerialized,
  });
  assert.deepEqual(second.result.styles.map(({ name }) => name), ['Title']);
  assert.equal(second.result.omittedBefore, 2);
  assert.equal(second.result.omittedAfter, 0);
  assert.equal(second.result.omitted, 2);
  assert.equal(second.result.complete, false,
    'one continuation page is not the complete catalog by itself');
  assert.equal(second.result.next, null);
});

test('Style Catalog rejects stale cursors, incompatible metadata, and candidate overflow', async () => {
  const cursor = encodeStyleCatalogCursor('TEXT', {
    type: 'TEXT', name: 'Missing', id: 'S:missing',
  });
  await assert.rejects(
    () => pluginResult({ type: 'TEXT', limit: 2, cursor }, {
      TEXT: [style('S:1', 'Body')],
    }),
    /cursor is stale/,
  );
  await assert.rejects(
    () => pluginResult({ type: 'TEXT', limit: 2 }, {
      TEXT: [{ ...style('S:1', 'Body'), key: undefined }],
    }),
    /incompatible publishable metadata/,
  );
  await assert.rejects(
    () => pluginResult({ type: 'TEXT', limit: 2 }, {
      TEXT: Array.from({ length: MAX_STYLE_CATALOG_CANDIDATES + 1 }, (_, index) => (
        style(`S:${index}`, `Style ${index}`)
      )),
    }),
    /candidate limit exceeded/,
  );
});

test('Style Catalog rejects malformed or self-inconsistent Plugin results', async () => {
  const serialized = await pluginResult({ type: 'TEXT', limit: 2 }, {
    TEXT: [style('S:1', 'Body')],
  });
  const payload = JSON.parse(serialized);
  for (const malformed of [
    { ...payload, total: 2 },
    { ...payload, returned: 2 },
    { ...payload, complete: false },
    { ...payload, styles: [{ ...payload.styles[0], future: 'private' }] },
    { ...payload, styles: [{ ...payload.styles[0], type: 'GRID' }] },
  ]) {
    await assert.rejects(
      () => executeStyleCatalog({ type: 'TEXT', limit: 2 }, {
        evaluate: async () => JSON.stringify(malformed),
      }),
      /invalid bounded result/,
    );
  }
});

test('Style Catalog Plan owns one policy-identical safe read', async () => {
  const plan = planFigmaCommand(['style', 'list', '--type', 'text', '--limit', '2'], {
    adapter: 'cli',
  });
  assert.equal(plan.allowed, true);
  assert.equal(plan.execution.retry, 'safe-read');
  assert.equal(plan.effects.figma, 'read');
  assert.equal(styleCatalogPlanRoute(plan), 'command-application');
  assert.deepEqual(plan.argv, ['style', 'list', '--type', 'TEXT', '--limit', '2']);
  const serialized = await pluginResult({ type: 'TEXT', limit: 2 }, {
    TEXT: [style('S:1', 'Body')],
  });
  assert.equal((await executeStyleCatalogPlan(plan, {
    evaluate: async () => serialized,
  })).result.total, 1);
  await assert.rejects(
    () => executeStyleCatalogPlan({ ...plan }, { evaluate: async () => serialized }),
    /requires a Command Plan created by the Capability Catalog/,
  );
  assert.equal(styleCatalogPlanRoute(
    planFigmaCommand(['style', 'show', 'Body'], { adapter: 'mcp' }),
  ), 'not-style-catalog');
});

test('Style Catalog canonical planning keeps CLI and MCP identical', () => {
  const argv = styleCatalogPlanningArgvFromRequest({ type: 'text', limit: 25 });
  const cli = planFigmaCommand(argv, { adapter: 'cli' });
  const mcp = planFigmaCommand(['style', 'list', '--limit=25', '-tTEXT'], { adapter: 'mcp' });
  assert.deepEqual(cli.argv, mcp.argv);
  assert.deepEqual(cli.effects, mcp.effects);
  assert.deepEqual(cli.execution, mcp.execution);
});

test('Style Catalog generated Plugin code parses', () => {
  assert.doesNotThrow(() => new Function(`return ${styleCatalogCode({ limit: 10 })}`));
});
