import assert from 'node:assert/strict';
import test from 'node:test';
import { planFigmaCommand } from '../../src/capability-catalog.js';
import {
  annotationCategoryInventoryCode,
  annotationCategoryInventoryPlanRoute,
  executeAnnotationCategoryInventory,
  executeAnnotationCategoryInventoryPlan,
  MAX_ANNOTATION_CATEGORY_INVENTORY_ITEMS,
} from '../src/application/annotation-category-inventory-command.js';
import {
  acceptsAnnotationCategoryInventoryArgv,
  annotationCategoryInventoryArgvFromRequest,
  parseAnnotationCategoryInventoryRequest,
} from '../src/application/annotation-category-inventory-request.js';

const CATEGORIES = Object.freeze([
  { id: 'preset-ready', label: 'Ready', color: 'green', isPreset: true },
  { id: 'custom-review', label: 'Review', color: 'orange', isPreset: false },
]);
const PAYLOAD = Object.freeze({ schemaVersion: 1, categories: CATEGORIES });

function runtime(categories = CATEGORIES) {
  return {
    annotations: {
      getAnnotationCategoriesAsync: async () => categories.map((category) => ({ ...category })),
    },
  };
}

test('Annotation Category Inventory request accepts only the exact no-input action', () => {
  assert.deepEqual(parseAnnotationCategoryInventoryRequest(['annotate', 'categories']), {});
  assert.deepEqual(annotationCategoryInventoryArgvFromRequest({}), ['annotate', 'categories']);
  assert.equal(acceptsAnnotationCategoryInventoryArgv(['annotate', 'categories', '--']), true);
  for (const argv of [
    ['annotate', 'categories', 'private'],
    ['annotate', 'categories', '--future'],
    ['annotate', 'categories', '--', 'private'],
    ['annotate', 'categories', '--', '--'],
  ]) assert.equal(acceptsAnnotationCategoryInventoryArgv(argv), false, argv.join(' '));
});

test('Annotation Category Inventory projects exact native category facts and JSON output', async () => {
  const result = await executeAnnotationCategoryInventory({}, {
    evaluate: async (code) => new Function('figma', `return ${code};`)(runtime()),
  });
  assert.deepEqual(result.result, PAYLOAD);
  assert.deepEqual(JSON.parse(result.stdout), CATEGORIES);
});

test('Annotation Category Inventory rejects unavailable APIs and unbounded native inventories', async () => {
  await assert.rejects(
    () => new Function('figma', `return ${annotationCategoryInventoryCode()};`)({}),
    /native Annotations API/,
  );
  const categories = Array(MAX_ANNOTATION_CATEGORY_INVENTORY_ITEMS + 1).fill(CATEGORIES[0]);
  await assert.rejects(
    () => new Function('figma', `return ${annotationCategoryInventoryCode()};`)(runtime(categories)),
    /bounded item limit/,
  );
});

test('Annotation Category Inventory rejects malformed, drifting, and duplicate claims', async () => {
  for (const malformed of [
    { ...PAYLOAD, privateFutureFact: true },
    { ...PAYLOAD, categories: [{ ...CATEGORIES[0], privateFutureFact: true }] },
    { ...PAYLOAD, categories: [{ ...CATEGORIES[0], color: 'purple' }] },
    { ...PAYLOAD, categories: [CATEGORIES[0], CATEGORIES[0]] },
    { ...PAYLOAD, categories: [{ ...CATEGORIES[0], isPreset: 'yes' }] },
  ]) {
    await assert.rejects(
      () => executeAnnotationCategoryInventory({}, {
        evaluate: async () => JSON.stringify(malformed),
      }),
      /invalid bounded result/,
    );
  }
  await assert.rejects(
    () => executeAnnotationCategoryInventory({}, { evaluate: async () => '{' }),
    (error) => error.phase === 'plugin-response' && error.outcome === 'unknown-after-dispatch',
  );
});

test('Annotation Category Inventory owns one policy-identical file read without editor effects', async () => {
  const cli = planFigmaCommand(['annotate', 'categories'], { adapter: 'cli' });
  const mcp = planFigmaCommand(['annotate', 'categories', '--'], { adapter: 'mcp' });
  assert.equal(cli.allowed, true);
  assert.deepEqual(cli.argv, mcp.argv);
  assert.deepEqual(cli.effects, mcp.effects);
  assert.deepEqual(cli.execution, mcp.execution);
  assert.equal(cli.execution.retry, 'safe-read');
  assert.deepEqual(cli.effects, {
    figma: 'read', editor: 'none', workspace: 'none', shared: 'none', network: 'none',
  });
  assert.equal(annotationCategoryInventoryPlanRoute(cli), 'command-application');
  assert.deepEqual((await executeAnnotationCategoryInventoryPlan(cli, {
    evaluate: async () => JSON.stringify(PAYLOAD),
  })).result, PAYLOAD);
  assert.equal(annotationCategoryInventoryPlanRoute(
    planFigmaCommand(['annotate', 'list', '1:2'], { adapter: 'mcp' }),
  ), 'not-annotation-category-inventory');
});

test('Annotation Category Inventory generated Plugin code parses', () => {
  assert.doesNotThrow(() => new Function(`return ${annotationCategoryInventoryCode()}`));
});
