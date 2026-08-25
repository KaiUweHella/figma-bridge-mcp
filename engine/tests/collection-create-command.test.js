import assert from 'node:assert/strict';
import test from 'node:test';
import { planFigmaCommand } from '../../src/capability-catalog.js';
import {
  collectionCreateCode,
  collectionCreatePlanRoute,
  executeCollectionCreate,
  executeCollectionCreatePlan,
} from '../src/application/collection-create-command.js';
import {
  acceptsCollectionCreateArgv,
  collectionCreateArgvFromRequest,
  parseCollectionCreateRequest,
} from '../src/application/collection-create-request.js';

function fixture({ existing = [], invalidIdentity = false, removeFails = false } = {}) {
  const created = [];
  const figma = {
    variables: {
      getLocalVariableCollectionsAsync: async () => existing,
      createVariableCollection(name) {
        let idReads = 0;
        const collection = {
          key: '', name, remote: false, defaultModeId: 'new:0', removed: false,
          remove() {
            if (removeFails) throw new Error('remove failed');
            this.removed = true;
          },
        };
        Object.defineProperty(collection, 'id', {
          enumerable: true,
          get() {
            idReads++;
            return invalidIdentity && idReads === 1
              ? '' : `VariableCollectionId:new:${created.length}`;
          },
        });
        created.push(collection);
        return collection;
      },
    },
  };
  return { figma, created };
}

async function runCode(request, figma) {
  return new Function('figma', `return ${collectionCreateCode(request)};`)(figma);
}

test('Collection Create request closes options and preserves a literal name', () => {
  assert.deepEqual(parseCollectionCreateRequest([
    'collections', 'create', '--allow-duplicate', '--', '-Theme',
  ]), { name: '-Theme', allowDuplicate: true });
  assert.deepEqual(collectionCreateArgvFromRequest({ name: '-Theme', allowDuplicate: true }), [
    'col', 'create', '--allow-duplicate', '--', '-Theme',
  ]);
  for (const args of [
    ['col', 'create'], ['col', 'create', 'One', 'Two'],
    ['col', 'create', '--allow-duplicate', '--allow-duplicate', 'Theme'],
    ['col', 'create', '--future', 'private-value'],
  ]) assert.equal(acceptsCollectionCreateArgv(args), false, args.join(' '));
});

test('Collection Create preflights duplicates and preserves intentional duplicate utility', async () => {
  const existing = [{ name: 'Theme' }];
  const blocked = fixture({ existing });
  await assert.rejects(
    () => runCode({ name: 'Theme' }, blocked.figma),
    /exact name already exists.*--allow-duplicate/,
  );
  assert.equal(blocked.created.length, 0);

  const allowed = fixture({ existing });
  const serialized = await runCode({ name: 'Theme', allowDuplicate: true }, allowed.figma);
  const result = await executeCollectionCreate({ name: 'Theme', allowDuplicate: true }, {
    evaluate: async () => serialized,
  });
  assert.equal(result.stdout, '✓ Created collection: Theme');
  assert.equal(result.result.status, 'created');
  assert.equal(result.result.duplicateCountBefore, 1);
  assert.equal(allowed.created.length, 1);
});

test('Collection Create journals immediately and reports cleanup or bounded residue', async () => {
  const cleaned = fixture({ invalidIdentity: true });
  const cleanedPayload = await runCode({ name: 'Theme' }, cleaned.figma);
  await assert.rejects(
    () => executeCollectionCreate({ name: 'Theme' }, { evaluate: async () => cleanedPayload }),
    (error) => error.mutationOutcome === 'rolled-back'
      && error.mutationReport.removed === 1,
  );
  assert.equal(cleaned.created[0].removed, true);

  const residue = fixture({ invalidIdentity: true, removeFails: true });
  const residuePayload = await runCode({ name: 'Theme' }, residue.figma);
  await assert.rejects(
    () => executeCollectionCreate({ name: 'Theme' }, { evaluate: async () => residuePayload }),
    (error) => error.mutationOutcome === 'partial-residue'
      && error.mutationReport.residueCount === 1,
  );
});

test('Collection Create rejects malformed results and accepts only authentic non-retrying Plans', async () => {
  await assert.rejects(
    () => executeCollectionCreate({ name: 'Theme' }, { evaluate: async () => '{}' }),
    /invalid bounded result/,
  );
  const cli = planFigmaCommand(['col', 'create', 'Theme'], { adapter: 'cli' });
  const mcp = planFigmaCommand(['col', 'create', '--', 'Theme'], { adapter: 'mcp' });
  assert.equal(cli.allowed, true);
  assert.equal(mcp.allowed, true);
  assert.deepEqual(cli.argv, mcp.argv);
  assert.equal(cli.execution.retry, 'never');
  assert.equal(cli.confirmation, 'configured');
  assert.equal(collectionCreatePlanRoute(cli), 'command-application');
  const { figma } = fixture();
  const serialized = await runCode({ name: 'Theme' }, figma);
  assert.equal((await executeCollectionCreatePlan(cli, {
    evaluate: async () => serialized,
  })).result.collection.name, 'Theme');
  await assert.rejects(
    () => executeCollectionCreatePlan({ ...cli }, { evaluate: async () => serialized }),
    /requires a Command Plan created by the Capability Catalog/,
  );
  assert.equal(collectionCreatePlanRoute(planFigmaCommand(['col', 'show', 'Theme'])),
    'not-collection-create');
});
