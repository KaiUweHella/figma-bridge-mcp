import assert from 'node:assert/strict';
import test from 'node:test';
import { planFigmaCommand } from '../../src/capability-catalog.js';
import {
  executeSlotConfiguration,
  executeSlotConfigurationPlan,
  slotConfigurationCode,
  slotConfigurationPlanRoute,
} from '../src/application/slot-configuration-command.js';
import {
  acceptsSlotConfigurationArgv,
  parseSlotConfigurationRequest,
  slotConfigurationArgvFromRequest,
  slotConfigurationFigmaUrlFileKeyFromArgv,
  slotConfigurationPlanningArgvFromRequest,
} from '../src/application/slot-configuration-request.js';

function fixture({ createMode = 'apply', editMode = 'apply' } = {}) {
  const definitions = {
    'Keep#1:0': { type: 'TEXT', defaultValue: 'Keep' },
    'Content#1:1': {
      type: 'SLOT', defaultValue: '', preferredValues: [], description: '',
      slotSettings: { minChildren: 0 },
    },
  };
  const slots = [{
    id: '2:1', name: 'Content', type: 'SLOT', children: [], limitViolations: [],
    parent: null, remove() { const index = slots.indexOf(this); if (index >= 0) slots.splice(index, 1); },
  }];
  let createCalls = 0; let editCalls = 0; let deleteCalls = 0;
  const component = {
    id: '1:1', name: 'Card', type: 'COMPONENT', remote: false,
    get componentPropertyDefinitions() { return definitions; },
    findAll(predicate) { return slots.filter(predicate); },
    createSlot() {
      createCalls += 1;
      const slot = {
        id: `2:${slots.length + 1}`, name: 'Slot', type: 'SLOT', children: [],
        limitViolations: [], parent: component,
        remove() { const index = slots.indexOf(this); if (index >= 0) slots.splice(index, 1); },
      };
      slots.push(slot); definitions[`Slot#1:${slots.length}`] = { type: 'SLOT', defaultValue: '' };
      if (createMode === 'throw-after-apply') throw new Error('create failed');
      return slot;
    },
    editComponentProperty(propertyName, update) {
      editCalls += 1;
      const before = definitions[propertyName];
      const suffix = propertyName.includes('#') ? propertyName.slice(propertyName.lastIndexOf('#')) : '';
      const nextName = update.name === undefined ? propertyName : `${update.name}${suffix}`;
      const next = {
        ...before,
        ...(update.preferredValues === undefined ? {} : { preferredValues: structuredClone(update.preferredValues) }),
        ...(update.description === undefined ? {} : { description: update.description }),
        ...(update.slotSettings === undefined ? {} : {
          slotSettings: { ...(before.slotSettings || {}), ...structuredClone(update.slotSettings) },
        }),
      };
      if (nextName !== propertyName) delete definitions[propertyName];
      definitions[nextName] = ['wrong', 'rollback-fails'].includes(editMode) && editCalls === 1
        ? { ...next, description: 'wrong' } : next;
      if (editMode === 'throw-after-apply' && editCalls === 1) throw new Error('edit failed');
      if (editMode === 'rollback-fails' && editCalls > 1) definitions[nextName].description = 'residue';
      return nextName;
    },
    deleteComponentProperty(propertyName) { deleteCalls += 1; delete definitions[propertyName]; },
  };
  slots[0].parent = component;
  const figma = {
    getNodeByIdAsync: async (id) => id === component.id ? component
      : slots.find((slot) => slot.id === id) || null,
  };
  return {
    figma, component, definitions, slots,
    createCalls: () => createCalls, editCalls: () => editCalls, deleteCalls: () => deleteCalls,
  };
}

const evaluate = (figma) => async (code) => new Function('figma', `return ${code}`)(figma);

test('Slot Configuration closes create/edit requests and projects only the Component URL', () => {
  const url = 'https://www.figma.com/design/PLACEHOLDERFILEKEY/FILE_NAME?node-id=1-1';
  assert.deepEqual(parseSlotConfigurationRequest([
    'slot', 'create', url, 'Content', '--settings', '{"minChildren":1,"maxChildren":2}',
  ]), {
    action: 'create', componentId: '1:1', propertyName: null, name: 'Content',
    settings: { minChildren: 1, maxChildren: 2 }, preferredValues: null, description: null,
  });
  assert.deepEqual(parseSlotConfigurationRequest([
    'slot', 'edit', '1:1', 'Content#1:1', '--name=Body', '--preferred', '[]',
  ]), {
    action: 'edit', componentId: '1:1', propertyName: 'Content#1:1', name: 'Body',
    settings: null, preferredValues: [], description: null,
  });
  assert.equal(slotConfigurationFigmaUrlFileKeyFromArgv([
    'slot', 'create', url, 'Content',
  ]), 'PLACEHOLDERFILEKEY');
  assert.deepEqual(parseSlotConfigurationRequest(slotConfigurationArgvFromRequest({
    action: 'edit', componentId: '1:1', propertyName: 'Content#1:1', name: null,
    settings: null, preferredValues: null, description: '',
  })).description, '');
  for (const argv of [
    ['slot', 'create', '1:1'],
    ['slot', 'create', '1:1', 'Content', '--settings', '{"future":true}'],
    ['slot', 'edit', '1:1', 'Content#1:1'],
    ['slot', 'edit', '1:1', 'Content#1:1', '--future', 'private-value'],
  ]) assert.equal(acceptsSlotConfigurationArgv(argv), false, argv.join(' '));
});

test('Slot Create invokes one factory and freshly verifies its Slot and definition', async () => {
  const live = fixture();
  const result = await executeSlotConfiguration({
    action: 'create', componentId: '1:1', name: 'Body',
    settings: { minChildren: 1 }, preferredValues: [{ type: 'COMPONENT', key: 'KEY' }],
    description: 'Body content',
  }, { evaluate: evaluate(live.figma) });
  assert.equal(result.result.status, 'created');
  assert.equal(result.result.outcome, 'verified');
  assert.equal(result.result.slot.name, 'Body');
  assert.equal(result.result.definition.slotSettings.minChildren, 1);
  assert.equal(live.createCalls(), 1); assert.equal(live.editCalls(), 1);
});

test('Slot Edit verifies requested changes, preserves unspecified facts and handles setter errors', async () => {
  const live = fixture({ editMode: 'throw-after-apply' });
  const result = await executeSlotConfiguration({
    action: 'edit', componentId: '1:1', propertyName: 'Content#1:1', name: 'Body',
    settings: { maxChildren: 3 }, preferredValues: null, description: null,
  }, { evaluate: evaluate(live.figma) });
  assert.equal(result.result.status, 'edited');
  assert.equal(result.result.outcome, 'verified-after-error');
  assert.equal(result.result.propertyName, 'Body#1:1');
  assert.equal(result.result.definition.slotSettings.minChildren, 0);
  assert.equal(result.result.definition.slotSettings.maxChildren, 3);
  assert.deepEqual(result.result.definition.preferredValues, []);
  assert.equal(live.editCalls(), 1);
});

test('Slot Configuration rolls back failed create/edit and reports exact residue', async () => {
  const failedCreate = fixture({ createMode: 'throw-after-apply' });
  await assert.rejects(() => executeSlotConfiguration({
    action: 'create', componentId: '1:1', name: 'Body', settings: null,
    preferredValues: null, description: null,
  }, { evaluate: evaluate(failedCreate.figma) }), (error) =>
    error.mutationOutcome === 'rolled-back' && error.mutationReport.residueCount === 0);
  assert.equal(failedCreate.createCalls(), 1);

  const failedEdit = fixture({ editMode: 'wrong' });
  await assert.rejects(() => executeSlotConfiguration({
    action: 'edit', componentId: '1:1', propertyName: 'Content#1:1', name: null,
    settings: null, preferredValues: null, description: 'next',
  }, { evaluate: evaluate(failedEdit.figma) }), (error) =>
    error.mutationOutcome === 'rolled-back' && error.mutationReport.residueCount === 0);
  assert.equal(failedEdit.editCalls(), 2);

  const residue = fixture({ editMode: 'rollback-fails' });
  await assert.rejects(() => executeSlotConfiguration({
    action: 'edit', componentId: '1:1', propertyName: 'Content#1:1', name: null,
    settings: null, preferredValues: null, description: 'next',
  }, { evaluate: evaluate(residue.figma) }), (error) =>
    error.mutationOutcome === 'partial-residue' && error.mutationReport.residueCount === 1);
});

test('Slot Configuration uses one non-retrying canonical Plan in both Adapters', async () => {
  const requests = [
    { action: 'create', componentId: '1:1', name: 'Body', settings: null, preferredValues: null, description: null },
    { action: 'edit', componentId: '1:1', propertyName: 'Content#1:1', name: null, settings: null, preferredValues: [], description: null },
  ];
  for (const request of requests) {
    const cli = planFigmaCommand(slotConfigurationArgvFromRequest(request), { adapter: 'cli' });
    const mcp = planFigmaCommand(slotConfigurationPlanningArgvFromRequest(request), { adapter: 'mcp' });
    assert.equal(cli.allowed, true); assert.equal(mcp.allowed, true);
    assert.deepEqual(cli.effects, mcp.effects); assert.equal(mcp.execution.retry, 'never');
    assert.equal(slotConfigurationPlanRoute(mcp), 'command-application');
    const live = fixture(); let evaluations = 0;
    await executeSlotConfigurationPlan(mcp, {
      evaluate: async (code) => { evaluations += 1; return evaluate(live.figma)(code); },
    });
    assert.equal(evaluations, 1);
  }
});

test('Slot Configuration rejects malformed Plugin responses after dispatch', async () => {
  for (const payload of [null, {}, 'not-json', JSON.stringify({ status: 'created' })]) {
    await assert.rejects(() => executeSlotConfiguration({
      action: 'create', componentId: '1:1', name: 'Body', settings: null,
      preferredValues: null, description: null,
    }, { evaluate: async () => payload }), /invalid/i);
  }
});
