import test from 'node:test';
import assert from 'node:assert/strict';
import { planFigmaCommand } from '../../src/capability-catalog.js';
import {
  executeLibraryRead,
  executeLibraryReadPlan,
  libraryReadCode,
  libraryReadPlanRoute,
} from '../src/application/library-read-command.js';
import {
  libraryReadArgvFromRequest,
  parseLibraryReadRequest,
} from '../src/application/library-read-request.js';

const collections = [
  { key: 'COL:B', name: 'Primitives', libraryName: 'Zeta' },
  { key: 'COL:A', name: 'Brand', libraryName: 'Alpha' },
];
const variables = {
  'COL:A': [
    { key: 'VAR:2', name: 'space/sm', resolvedType: 'FLOAT' },
    { key: 'VAR:1', name: 'brand/base', resolvedType: 'COLOR' },
  ],
  'COL:B': [{ key: 'VAR:3', name: 'primitive/blue', resolvedType: 'COLOR' }],
};
function fixture(overrides = {}) {
  let collectionReads = 0; let variableReads = 0;
  const figma = { teamLibrary: {
    getAvailableLibraryVariableCollectionsAsync: async () => { collectionReads += 1; return overrides.collections ?? collections; },
    getVariablesInLibraryCollectionAsync: async (key) => { variableReads += 1; return overrides.variables ?? variables[key] ?? []; },
  } };
  return { figma, collectionReads: () => collectionReads, variableReads: () => variableReads };
}
const plugin = (request, figma) => new Function('figma', `return ${libraryReadCode(request)}`)(figma);

test('Library Read request closes and canonicalizes both actions', () => {
  assert.deepEqual(parseLibraryReadRequest(['library', 'collections']), {
    action: 'collections', collection: null, type: null,
  });
  assert.deepEqual(parseLibraryReadRequest(['library', 'variables', ' Brand ', '-tcolor']), {
    action: 'variables', collection: 'Brand', type: 'COLOR',
  });
  assert.deepEqual(libraryReadArgvFromRequest({ action: 'variables', collection: '--foundation', type: 'float' }), [
    'library', 'variables', '--type', 'FLOAT', '--', '--foundation',
  ]);
  for (const args of [
    ['library', 'collections', 'extra'],
    ['library', 'collections', '--future', 'secret'],
    ['library', 'variables'],
    ['library', 'variables', 'Brand', '--type', 'NUMBER'],
    ['library', 'variables', 'Brand', '--type', 'COLOR', '-t', 'FLOAT'],
  ]) assert.throws(() => parseLibraryReadRequest(args), /Invalid Library Read command/);
});

test('Library collection discovery is bounded, canonical, and deterministic', async () => {
  const live = fixture();
  const result = await executeLibraryRead({ action: 'collections' }, {
    evaluate: async () => plugin({ action: 'collections' }, live.figma),
  });
  assert.deepEqual(result.result.map((item) => item.key), ['COL:A', 'COL:B']);
  assert.equal(live.collectionReads(), 1);
  assert.equal(live.variableReads(), 0);
  assert.equal(result.stderr, '');
});

test('Library Variable discovery preserves exact-first resolution and optional type filtering', async () => {
  const live = fixture();
  const result = await executeLibraryRead({ action: 'variables', collection: 'Brand', type: 'color' }, {
    evaluate: async () => plugin({ action: 'variables', collection: 'Brand', type: 'color' }, live.figma),
  });
  assert.equal(result.result.collection.key, 'COL:A');
  assert.deepEqual(result.result.variables, [
    { key: 'VAR:1', name: 'brand/base', resolvedType: 'COLOR' },
  ]);
  assert.equal(live.collectionReads(), 1);
  assert.equal(live.variableReads(), 1);
});

test('Library Variable discovery refuses ambiguous queries before a Variable read', async () => {
  const live = fixture({ collections: [
    { key: 'COL:1', name: 'Brand', libraryName: 'Alpha' },
    { key: 'COL:2', name: 'Brand', libraryName: 'Beta' },
  ] });
  await assert.rejects(() => executeLibraryRead({ action: 'variables', collection: 'Brand' }, {
    evaluate: async () => plugin({ action: 'variables', collection: 'Brand' }, live.figma),
  }), /ambiguous/);
  assert.equal(live.variableReads(), 0);
});

test('Library Read rejects malformed or oversized Plugin facts', async () => {
  const malformed = fixture({ collections: [{ key: '', name: 'Broken', libraryName: 'Library' }] });
  await assert.rejects(() => executeLibraryRead({ action: 'collections' }, {
    evaluate: async () => plugin({ action: 'collections' }, malformed.figma),
  }), /Library collection facts are invalid/);
  await assert.rejects(() => executeLibraryRead({ action: 'collections' }, {
    evaluate: async () => JSON.stringify([{ key: 'COL:1', name: 'A', libraryName: 'B', secret: true }]),
  }), /invalid bounded result/);
  await assert.rejects(() => executeLibraryRead({ action: 'variables', collection: 'Brand' }, {
    evaluate: async () => JSON.stringify({ collection: { key: 'COL:X', name: 'Other', libraryName: 'Elsewhere' }, variables: [] }),
  }), /invalid bounded result/);
});

test('CLI and MCP Library reads resolve the same safe-read Plans and Application', async () => {
  for (const request of [
    { action: 'collections' },
    { action: 'variables', collection: 'Brand', type: 'COLOR' },
  ]) {
    const argv = libraryReadArgvFromRequest(request);
    const cli = planFigmaCommand(argv, { adapter: 'cli' });
    const mcp = planFigmaCommand(argv, { adapter: 'mcp' });
    assert.equal(cli.id, `library.${request.action}`);
    assert.deepEqual(mcp.effects, cli.effects);
    assert.equal(mcp.execution.retry, 'safe-read');
    assert.equal(mcp.confirmation, 'none');
    assert.equal(libraryReadPlanRoute(mcp), 'command-application');
    const live = fixture();
    const result = await executeLibraryReadPlan(mcp, { evaluate: async () => plugin(request, live.figma) });
    assert.ok(result.stdout.length > 0);
  }
});

test('Library Read owns the Plan deadline instead of embedding a private timer', () => {
  assert.doesNotMatch(libraryReadCode({ action: 'collections' }), /setTimeout|18000|18s/);
});
