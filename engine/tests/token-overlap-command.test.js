import assert from 'node:assert/strict';
import test from 'node:test';
import { planFigmaCommand } from '../../src/capability-catalog.js';
import {
  executeTokenOverlap,
  executeTokenOverlapPlan,
  tokenOverlapCommandCode,
  tokenOverlapPlanRoute,
} from '../src/application/token-overlap-command.js';
import {
  acceptsTokenOverlapArgv,
  parseTokenOverlapRequest,
  tokenOverlapArgvFromRequest,
} from '../src/application/token-overlap-request.js';

function fixture() {
  const collections = [];
  const variables = [];
  const reads = [];
  let collectionSequence = 0;
  let variableSequence = 0;
  const addCollection = (name) => {
    const collection = {
      id: `VariableCollectionId:${++collectionSequence}`, name, remote: false, variableIds: [],
    };
    collections.push(collection);
    return collection;
  };
  const addVariable = (collection, name) => {
    const variable = {
      id: `VariableID:${++variableSequence}`, name, remote: false,
      variableCollectionId: collection.id,
    };
    variables.push(variable);
    collection.variableIds.push(variable.id);
    return variable;
  };
  const figma = { variables: {
    getLocalVariableCollectionsAsync: async () => collections,
    getVariableByIdAsync: async (id) => {
      reads.push(id);
      return variables.find((variable) => variable.id === id) || null;
    },
  } };
  return { collections, variables, reads, addCollection, addVariable, figma };
}

async function runCode(request, figma) {
  return new Function('figma', `return ${tokenOverlapCommandCode(request)};`)(figma);
}

test('Token Overlap request closes arity, options, bounds and literal queries', () => {
  assert.deepEqual(parseTokenOverlapRequest([
    'tokens', 'overlap', 'One', '--json', '-l3', 'Two',
  ]), { queries: ['One', 'Two'], limit: 3, json: true });
  assert.deepEqual(tokenOverlapArgvFromRequest({ queries: ['-One', 'Two'] }), [
    'tokens', 'overlap', '--limit', '200', '--', '-One', 'Two',
  ]);
  for (const args of [
    ['tokens', 'overlap', 'One'], ['tokens', 'overlap', 'One', 'one'],
    ['tokens', 'overlap', '--limit', 'One', 'Two'],
    ['tokens', 'overlap', '-l2', '--limit=3', 'One', 'Two'],
    ['tokens', 'overlap', '--json', '--json', 'One', 'Two'],
    ['tokens', 'overlap', '--future', 'private-value', 'One', 'Two'],
  ]) assert.equal(acceptsTokenOverlapArgv(args), false, args.join(' '));
  assert.throws(() => tokenOverlapArgvFromRequest({ queries: ['One\n', 'Two'] }), /controls/);
  assert.throws(() => tokenOverlapArgvFromRequest({ queries: Array(33).fill(0)
    .map((_, index) => `C${index}`) }), /at most 32/);
});

test('Token Overlap resolves exact and unique partial Collections with targeted reads', async () => {
  const target = fixture();
  const alpha = target.addCollection('Alpha Theme');
  const beta = target.addCollection('Beta Theme');
  const other = target.addCollection('Unrelated');
  for (const name of ['common', 'alpha-only', 'duplicate', 'duplicate']) {
    target.addVariable(alpha, name);
  }
  for (const name of ['common', 'beta-only', 'duplicate']) target.addVariable(beta, name);
  target.addVariable(other, 'private-other');

  const request = { queries: [alpha.id, 'beta'], limit: 200, json: false };
  const serialized = await runCode(request, target.figma);
  const result = await executeTokenOverlap(request, { evaluate: async () => serialized });
  assert.deepEqual(result.result.collections, ['Alpha Theme', 'Beta Theme']);
  assert.deepEqual(result.result.commonCore.items, ['common']);
  assert.deepEqual(result.result.perCollection[0].ambiguous_here.items,
    [{ name: 'duplicate', count: 2 }]);
  assert.deepEqual(result.result.perCollection[0].only_here.items, ['alpha-only']);
  assert.deepEqual(result.result.perCollection[0].missing_here.items, ['beta-only']);
  assert.deepEqual(result.result.perCollection[1].missing_here.items, ['alpha-only']);
  assert.equal(result.result.perCollection[0].total, 3);
  assert.equal(result.result.perCollection[0].variableCount, 4);
  assert.equal(result.result.perCollection[0].duplicateNameCount, 1);
  assert.equal(target.reads.includes(other.variableIds[0]), false);
  assert.match(result.stdout, /ambiguous here/);
});

test('Token Overlap fails closed on ambiguous, missing and repeated resolved identities', async () => {
  const ambiguous = fixture();
  ambiguous.addCollection('Alpha Light'); ambiguous.addCollection('Alpha Dark');
  ambiguous.addCollection('Beta');
  await assert.rejects(() => runCode({ queries: ['Alpha', 'Beta'] }, ambiguous.figma),
    /query is ambiguous/);
  await assert.rejects(() => runCode({ queries: ['Missing', 'Beta'] }, ambiguous.figma),
    /not found/);

  const repeated = fixture();
  const theme = repeated.addCollection('Theme'); repeated.addCollection('Other');
  await assert.rejects(() => runCode({ queries: [theme.id, 'Theme'] }, repeated.figma),
    /same Collection/);
});

test('Token Overlap projects deterministic bounded list facts and JSON completeness', async () => {
  const target = fixture();
  const alpha = target.addCollection('Alpha'); const beta = target.addCollection('Beta');
  for (const name of ['a', 'b', 'c']) target.addVariable(alpha, name);
  for (const name of ['d', 'e', 'f']) target.addVariable(beta, name);
  const request = { queries: ['Alpha', 'Beta'], limit: 1, json: true };
  const serialized = await runCode(request, target.figma);
  const result = await executeTokenOverlap(request, { evaluate: async () => serialized });
  assert.equal(result.result.complete, false);
  assert.deepEqual(result.result.perCollection[0].only_here, {
    total: 3, returned: 1, omitted: 2, complete: false, items: ['a'],
  });
  const json = JSON.parse(result.stdout);
  assert.equal(json.resolved, undefined);
  assert.equal(json.complete, false);
});

test('Token Overlap rejects malformed native and forged Adapter facts', async () => {
  const target = fixture();
  const alpha = target.addCollection('Alpha'); const beta = target.addCollection('Beta');
  target.addVariable(alpha, 'common'); target.addVariable(beta, 'common');
  const request = { queries: ['Alpha', 'Beta'], limit: 200 };
  const authentic = JSON.parse(await runCode(request, target.figma));
  const forged = structuredClone(authentic);
  forged.perCollection[0].variableCount = 99;
  await assert.rejects(() => executeTokenOverlap(request, {
    evaluate: async () => JSON.stringify(forged),
  }), /invalid bounded result/);
  beta.variableIds.push(alpha.variableIds[0]);
  await assert.rejects(() => runCode(request, target.figma), /identity reuse/);
});

test('Token Overlap accepts only authentic safe-read Plans', async () => {
  const cli = planFigmaCommand(['tokens', 'overlap', '-l20', 'Alpha', 'Beta'], {
    adapter: 'cli',
  });
  const mcp = planFigmaCommand(tokenOverlapArgvFromRequest({
    queries: ['Alpha', 'Beta'], limit: 20,
  }), { adapter: 'mcp' });
  assert.equal(cli.allowed, true); assert.equal(mcp.allowed, true);
  assert.deepEqual(cli.argv, mcp.argv); assert.equal(cli.execution.retry, 'safe-read');
  assert.equal(cli.execution.timeout, 'long'); assert.equal(cli.confirmation, 'none');
  assert.equal(tokenOverlapPlanRoute(cli), 'command-application');
  const target = fixture();
  const alpha = target.addCollection('Alpha'); const beta = target.addCollection('Beta');
  target.addVariable(alpha, 'common'); target.addVariable(beta, 'common');
  const serialized = await runCode({ queries: ['Alpha', 'Beta'], limit: 20 }, target.figma);
  assert.deepEqual((await executeTokenOverlapPlan(cli, { evaluate: async () => serialized }))
    .result.commonCore.items, ['common']);
  await assert.rejects(() => executeTokenOverlapPlan({ ...cli }, { evaluate: async () => serialized }),
    /requires a Command Plan created by the Capability Catalog/);
});
