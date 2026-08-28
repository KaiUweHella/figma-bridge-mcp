import { test } from 'node:test';
import assert from 'node:assert/strict';
import { planFigmaCommand } from '../../src/capability-catalog.js';
import {
  componentInventoryArgvFromRequest,
  executeComponentInventory,
  executeComponentInventoryPlan,
  formatComponentInventoryResult,
} from '../src/application/component-inventory-command.js';
import { parseComponentInventoryRequest } from '../src/application/component-inventory-request.js';

function inventory(scope = 'CURRENT_PAGE') {
  return {
    schemaVersion: 1,
    scope,
    visited: 4,
    pagesScanned: scope === 'ALL_PAGES' ? 2 : 1,
    fileName: 'Library',
    componentSets: [{
      id: '2:1',
      name: 'Button',
      page: 'Components',
      key: 'set-key',
      defaultVariantId: '2:2',
      variantAxes: { State: { values: ['Default', 'Hover'] } },
      variants: [
        { id: '2:2', name: 'State=Default', key: 'default-key' },
        { id: '2:3', name: 'State=Hover', key: 'hover-key' },
      ],
    }],
    standaloneComponents: [{ id: '2:4', name: 'Icon', page: 'Components', key: null }],
  };
}

test('Component Inventory request closes scope and output before readiness', () => {
  assert.deepEqual(parseComponentInventoryRequest(['component', 'list']), {
    allPages: false,
    json: false,
  });
  assert.deepEqual(parseComponentInventoryRequest([
    'component', 'list', '--json', '--all-pages',
  ]), { allPages: true, json: true });
  assert.deepEqual(componentInventoryArgvFromRequest({ allPages: true, json: true }), [
    'component', 'list', '--all-pages', '--json',
  ]);
  for (const argv of [
    ['component', 'list', '--future'],
    ['component', 'list', '--json', '--json'],
    ['component', 'list', 'payload'],
  ]) assert.throws(() => parseComponentInventoryRequest(argv), /invalid component list/i);
});

test('Component Inventory validates and formats complete current-page facts', async () => {
  let calls = 0;
  const result = await executeComponentInventory({ allPages: false }, {
    evaluate: async (code) => {
      calls++;
      assert.match(code, /const scope = 'CURRENT_PAGE'/);
      assert.doesNotMatch(code, /loadAllPagesAsync/);
      return inventory();
    },
  });
  assert.equal(calls, 1);
  assert.equal(result.result.scope, 'CURRENT_PAGE');
  assert.match(result.stdout, /Component sets:/);
  assert.match(result.stdout, /"Button" \(2:1\)/);
  assert.match(result.stdout, /"State": "Default" \| "Hover"/);
  assert.match(result.stdout, /Standalone components:/);
});

test('Component Inventory preserves all-page facts and JSON output', async () => {
  const payload = inventory('ALL_PAGES');
  const result = await executeComponentInventory({ allPages: true, json: true }, {
    evaluate: async (code) => {
      assert.match(code, /await figma\.loadAllPagesAsync\(\)/);
      return payload;
    },
  });
  assert.deepEqual(JSON.parse(result.stdout), payload);
  assert.match(formatComponentInventoryResult(payload), /page: "Components"/);
});

test('Component Inventory reports an empty scope without inventing components', async () => {
  const empty = { ...inventory(), visited: 0, componentSets: [], standaloneComponents: [] };
  const current = await executeComponentInventory({}, { evaluate: async () => empty });
  assert.equal(current.stdout, 'No components on the current page. Try --all-pages.');
  const all = { ...empty, scope: 'ALL_PAGES', pagesScanned: 2 };
  assert.equal(formatComponentInventoryResult(all), 'No components in this file.');
});

test('Component Inventory rejects mismatched scope and malformed Plugin facts', async () => {
  await assert.rejects(
    executeComponentInventory({ allPages: false }, { evaluate: async () => inventory('ALL_PAGES') }),
    /mismatched scan scope/i,
  );
  await assert.rejects(
    executeComponentInventory({}, { evaluate: async () => ({ ...inventory(), extra: true }) }),
    /invalid bounded result/i,
  );
  await assert.rejects(
    executeComponentInventory({}, { evaluate: async () => ({
      ...inventory(), standaloneComponents: [{ id: '2:2', name: 'duplicate', page: 'Components', key: null }],
    }) }),
    /duplicate component identities/i,
  );
});

test('one authentic safe-read component.list Plan crosses the Application Seam', async () => {
  const plan = planFigmaCommand(['component', 'list', '--all-pages', '--json'], { adapter: 'mcp' });
  assert.equal(plan.allowed, true);
  assert.equal(plan.id, 'component.list');
  assert.equal(plan.effects.figma, 'read');
  assert.equal(plan.execution.retry, 'safe-read');
  assert.equal(plan.execution.timeout, 'long');
  const result = await executeComponentInventoryPlan(plan, {
    evaluate: async () => inventory('ALL_PAGES'),
  });
  assert.equal(JSON.parse(result.stdout).scope, 'ALL_PAGES');
  await assert.rejects(
    executeComponentInventoryPlan(planFigmaCommand(['component', 'main', '2:1']), {
      evaluate: async () => inventory(),
    }),
    /not owned/i,
  );
});
