import assert from 'node:assert/strict';
import test from 'node:test';
import { planFigmaCommand } from '../../src/capability-catalog.js';
import {
  executeSlotRead,
  executeSlotReadPlan,
  MAX_SLOT_READ_ITEMS,
  slotReadCode,
  slotReadPlanRoute,
  slotReadPlanningArgvFromRequest,
} from '../src/application/slot-read-command.js';
import { acceptsSlotReadArgv, parseSlotReadRequest } from '../src/application/slot-read-request.js';

const slot = {
  id: '2:1', name: 'Content', type: 'SLOT', children: [{ id: '2:2' }],
  limitViolations: ['HAS_NON_PREFERRED'],
};
const definition = {
  type: 'SLOT',
  preferredValues: [{ type: 'COMPONENT', key: 'published-key' }],
  description: 'Content area',
  slotSettings: { minChildren: 1, maxChildren: 3, allowPreferredValuesOnly: true },
  boundVariables: { defaultValue: { type: 'VARIABLE_ALIAS', id: 'VariableID:1' } },
};
const component = {
  id: '1:1', name: 'Card', type: 'COMPONENT',
  componentPropertyDefinitions: { 'Content#2:1': definition },
};
const page = {
  id: '0:1', name: 'Page', type: 'PAGE',
  findAll: (predicate) => [slot].filter(predicate),
};
const figma = {
  currentPage: page,
  getNodeByIdAsync: async (id) => new Map([[slot.id, slot], [component.id, component], [page.id, page]]).get(id) || null,
};
const SLOT_FACT = {
  id: '2:1', name: 'Content', type: 'SLOT', childCount: 1,
  limitViolations: ['HAS_NON_PREFERRED'],
};
const VALIDATION_FACT = {
  valid: false,
  slots: [{ id: '2:1', name: 'Content', childCount: 1, limitViolations: ['HAS_NON_PREFERRED'] }],
};

test('Slot Read closes both actions and canonicalizes optional URL targets', () => {
  assert.deepEqual(parseSlotReadRequest(['slot', 'inspect', '2-1']), {
    action: 'inspect', nodeId: '2:1', warning: '',
  });
  assert.deepEqual(parseSlotReadRequest(['slot', 'validate']), {
    action: 'validate', nodeId: null, warning: '',
  });
  assert.deepEqual(parseSlotReadRequest(['slot', 'validate', '--', '1-1']), {
    action: 'validate', nodeId: '1:1', warning: '',
  });
  for (const argv of [
    ['slot', 'inspect'],
    ['slot', 'inspect', '1:1', '2:1'],
    ['slot', 'validate', '--future'],
    ['slot', 'validate', 'not-a-node'],
  ]) assert.equal(acceptsSlotReadArgv(argv), false, argv.join(' '));

  const url = 'https://www.figma.com/design/FILEA/Slot-Lab?node-id=2-1';
  const plan = planFigmaCommand(slotReadPlanningArgvFromRequest({ action: 'inspect', nodeId: url }), {
    adapter: 'mcp',
  });
  assert.equal(plan.target.fileKey, 'FILEA');
  assert.deepEqual(plan.argv, ['slot', 'inspect', '--', '2:1']);
});

test('Slot Read preserves Slot, Component definition, and validation report shapes', async () => {
  const inspectSlot = await executeSlotRead({ action: 'inspect', nodeId: '2:1' }, {
    evaluate: async (code) => new Function('figma', `return ${code};`)(figma),
  });
  assert.deepEqual(inspectSlot.result, SLOT_FACT);

  const inspectComponent = await executeSlotRead({ action: 'inspect', nodeId: '1:1' }, {
    evaluate: async (code) => new Function('figma', `return ${code};`)(figma),
  });
  assert.deepEqual(inspectComponent.result, {
    id: '1:1', name: 'Card', type: 'COMPONENT',
    slots: [{ name: 'Content#2:1', definition: { ...definition, defaultValue: null } }],
  });

  for (const request of [{ action: 'validate' }, { action: 'validate', nodeId: '0:1' }]) {
    const validation = await executeSlotRead(request, {
      evaluate: async (code) => new Function('figma', `return ${code};`)(figma),
    });
    assert.deepEqual(validation.result, VALIDATION_FACT);
  }
});

test('Slot Read rejects malformed, inconsistent, duplicate, and oversized Plugin facts', async () => {
  for (const [request, value] of [
    [{ action: 'inspect', nodeId: '2:1' }, 'not-json'],
    [{ action: 'inspect', nodeId: '2:1' }, JSON.stringify({ ...SLOT_FACT, privateField: true })],
    [{ action: 'inspect', nodeId: '2:1' }, JSON.stringify({ ...SLOT_FACT, id: '9:9' })],
    [{ action: 'validate' }, JSON.stringify({ valid: true, slots: VALIDATION_FACT.slots })],
    [{ action: 'validate' }, JSON.stringify({ valid: false, slots: [VALIDATION_FACT.slots[0], VALIDATION_FACT.slots[0]] })],
    [{ action: 'validate' }, JSON.stringify({ valid: true, slots: Array(MAX_SLOT_READ_ITEMS + 1).fill({ id: '2:1', name: 'Content', childCount: 0, limitViolations: [] }) })],
  ]) {
    await assert.rejects(
      () => executeSlotRead(request, { evaluate: async () => value }),
      /invalid (?:JSON|bounded result)/,
    );
  }
});

test('Slot Read uses one safe-read Application and declares current-page effects', async () => {
  for (const argv of [['slot', 'inspect', '2:1'], ['slot', 'validate'], ['slot', 'validate', '1:1']]) {
    const mcp = planFigmaCommand(argv, { adapter: 'mcp' });
    const cli = planFigmaCommand(mcp.argv, { adapter: 'cli' });
    assert.equal(mcp.allowed, true);
    assert.equal(mcp.execution.retry, 'safe-read');
    assert.deepEqual(mcp.effects, cli.effects);
    assert.equal(slotReadPlanRoute(mcp), 'command-application');
    assert.equal(mcp.effects.editor, argv[1] === 'validate' ? 'read' : 'none');
    const result = await executeSlotReadPlan(mcp, {
      evaluate: async () => JSON.stringify(argv[1] === 'inspect' ? SLOT_FACT : { valid: true, slots: [] }),
    });
    assert.ok(result.stdout.length > 0);
  }
});

test('Slot Read owns the Plan deadline and performs no mutation', () => {
  for (const request of [{ action: 'inspect', nodeId: '2:1' }, { action: 'validate' }]) {
    const source = slotReadCode(request);
    assert.doesNotMatch(source, /setTimeout|createSlot\(|editComponentProperty\(|resetSlot\(/);
  }
});
