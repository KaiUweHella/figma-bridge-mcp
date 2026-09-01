import assert from 'node:assert/strict';
import test from 'node:test';
import { planFigmaCommand } from '../../src/capability-catalog.js';
import {
  executeSectionInventory,
  executeSectionInventoryPlan,
  MAX_SECTION_INVENTORY_ITEMS,
  sectionInventoryCode,
  sectionInventoryPlanRoute,
} from '../src/application/section-inventory-command.js';
import {
  acceptsSectionInventoryArgv,
  parseSectionInventoryRequest,
  sectionInventoryArgvFromRequest,
} from '../src/application/section-inventory-request.js';

const PAYLOAD = Object.freeze({
  schemaVersion: 1,
  page: { id: '0:1', name: 'Components' },
  sections: [
    { id: '1:2', name: 'Buttons', count: 3 },
    { id: '1:3', name: 'Inputs', count: 2 },
  ],
});

function runtime(sections = PAYLOAD.sections) {
  return {
    currentPage: {
      id: '0:1', name: 'Components', type: 'PAGE',
      findAll: (predicate) => sections.map((section) => ({
        id: section.id,
        name: section.name,
        type: 'SECTION',
        children: Array(section.count).fill({}),
      })).filter(predicate),
    },
  };
}

test('Section Inventory request accepts only the exact no-input action', () => {
  assert.deepEqual(parseSectionInventoryRequest(['section', 'list']), {});
  assert.deepEqual(sectionInventoryArgvFromRequest({}), ['section', 'list']);
  assert.equal(acceptsSectionInventoryArgv(['section', 'list', '--']), true);
  for (const argv of [
    ['section', 'list', 'private'],
    ['section', 'list', '--future'],
    ['section', 'list', '--', 'private'],
    ['section', 'list', '--', '--'],
  ]) assert.equal(acceptsSectionInventoryArgv(argv), false, argv.join(' '));
});

test('Section Inventory returns a bounded current-page projection and legacy-readable output', async () => {
  const result = await executeSectionInventory({}, {
    evaluate: async (code) => new Function('figma', `return ${code};`)(runtime()),
  });
  assert.deepEqual(result.result, PAYLOAD);
  assert.equal(result.stdout, [
    '  Buttons  (1:2)  3 children',
    '  Inputs  (1:3)  2 children',
  ].join('\n'));

  const empty = await executeSectionInventory({}, {
    evaluate: async (code) => new Function('figma', `return ${code};`)(runtime([])),
  });
  assert.equal(empty.stdout, '(no sections on this page)');
});

test('Section Inventory refuses incompatible pages and unbounded native results', async () => {
  await assert.rejects(
    () => new Function('figma', `return ${sectionInventoryCode()};`)({ currentPage: null }),
    /compatible current Page/,
  );
  const sections = Array(MAX_SECTION_INVENTORY_ITEMS + 1).fill({
    id: '1:2', name: 'Section', count: 0,
  });
  await assert.rejects(
    () => new Function('figma', `return ${sectionInventoryCode()};`)(runtime(sections)),
    /bounded item limit/,
  );
});

test('Section Inventory rejects malformed, drifting, duplicate, and oversized claims', async () => {
  for (const malformed of [
    { ...PAYLOAD, privateFutureFact: true },
    { ...PAYLOAD, page: { id: 'bad', name: 'Components' } },
    { ...PAYLOAD, sections: [{ ...PAYLOAD.sections[0], privateFutureFact: true }] },
    { ...PAYLOAD, sections: [PAYLOAD.sections[0], PAYLOAD.sections[0]] },
    { ...PAYLOAD, sections: [{ ...PAYLOAD.sections[0], count: -1 }] },
  ]) {
    await assert.rejects(
      () => executeSectionInventory({}, { evaluate: async () => JSON.stringify(malformed) }),
      /invalid bounded result/,
    );
  }
  await assert.rejects(
    () => executeSectionInventory({}, { evaluate: async () => '{' }),
    (error) => error.phase === 'plugin-response' && error.outcome === 'unknown-after-dispatch',
  );
});

test('Section Inventory owns one policy-identical safe read with an explicit editor effect', async () => {
  const cli = planFigmaCommand(['section', 'list'], { adapter: 'cli' });
  const mcp = planFigmaCommand(['section', 'list', '--'], { adapter: 'mcp' });
  assert.equal(cli.allowed, true);
  assert.deepEqual(cli.argv, mcp.argv);
  assert.deepEqual(cli.effects, mcp.effects);
  assert.deepEqual(cli.execution, mcp.execution);
  assert.equal(cli.execution.retry, 'safe-read');
  assert.deepEqual(cli.effects, {
    figma: 'read', editor: 'read', workspace: 'none', shared: 'none', network: 'none',
  });
  assert.equal(sectionInventoryPlanRoute(cli), 'command-application');
  assert.deepEqual((await executeSectionInventoryPlan(cli, {
    evaluate: async () => JSON.stringify(PAYLOAD),
  })).result, PAYLOAD);
  assert.equal(sectionInventoryPlanRoute(
    planFigmaCommand(['section', 'fit', '1:2'], { adapter: 'mcp' }),
  ), 'not-section-inventory');
});

test('Section Inventory generated Plugin code parses', () => {
  assert.doesNotThrow(() => new Function(`return ${sectionInventoryCode()}`));
});
