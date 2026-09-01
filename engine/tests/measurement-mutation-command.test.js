import assert from 'node:assert/strict';
import test from 'node:test';
import { planFigmaCommand } from '../../src/capability-catalog.js';
import {
  executeMeasurementMutation,
  executeMeasurementMutationPlan,
  measurementMutationArgvFromRequest,
  measurementMutationPlanRoute,
  measurementMutationPlanningArgvFromRequest,
} from '../src/application/measurement-mutation-command.js';
import { parseMeasurementMutationRequest } from '../src/application/measurement-mutation-request.js';

function fixture({ editorType = 'dev', wrongAdd = false, wrongEdit = false, deleteNoEffect = false } = {}) {
  const start = { id: '1:2', name: 'Start', type: 'RECTANGLE', x: 0 };
  const end = { id: '3:4', name: 'End', type: 'FRAME', x: 100 };
  const registry = new Map([[start.id, start], [end.id, end]]);
  let measurements = [{
    id: 'm:1', start: { node: start, side: 'LEFT' }, end: { node: end, side: 'RIGHT' },
    offset: { type: 'OUTER', fixed: 4 }, freeText: 'Existing',
  }];
  const page = {
    id: '0:1', type: 'PAGE',
    getMeasurements: () => measurements,
    addMeasurement(from, to, options) {
      const value = {
        id: 'm:2', start: from, end: to,
        offset: options.offset || { type: 'OUTER', fixed: 0 },
        freeText: wrongAdd ? `${options.freeText || ''}!` : options.freeText || '',
      };
      measurements = [...measurements, value]; return value;
    },
    editMeasurement(id, patch) {
      const current = measurements.find((item) => item.id === id);
      if (!current) throw new Error('missing');
      const updated = { ...current, ...patch };
      if (wrongEdit && patch.freeText === 'Updated') updated.freeText = `${patch.freeText}!`;
      measurements = measurements.map((item) => item.id === id ? updated : item); return updated;
    },
    deleteMeasurement(id) { if (!deleteNoEffect) measurements = measurements.filter((item) => item.id !== id); },
  };
  return {
    figma: { editorType, currentPage: page, getNodeByIdAsync: async (id) => registry.get(id) || null },
    measurements: () => measurements,
  };
}

const evaluate = (figma) => async (code) => new Function('figma', `return ${code};`)(figma);

test('Measurement Mutation closes action-specific endpoints, patches and URL targets', () => {
  const url = 'https://www.figma.com/design/FILEA/Test?node-id=1-2';
  assert.deepEqual(parseMeasurementMutationRequest([
    'measure', 'add', `${url}:right`, '3-4:left', '--relative', '0.5', '--text', 'Gap',
  ]), {
    action: 'add', from: { nodeId: '1:2', side: 'RIGHT' },
    to: { nodeId: '3:4', side: 'LEFT' }, offset: { type: 'INNER', relative: 0.5 },
    text: 'Gap', id: null,
  });
  assert.deepEqual(parseMeasurementMutationRequest([
    'measure', 'edit', 'm:1', '--offset=-8', '--text', '',
  ]), { action: 'edit', from: null, to: null, offset: { type: 'OUTER', fixed: -8 }, text: '', id: 'm:1' });
  assert.equal(parseMeasurementMutationRequest(['measure', 'delete', 'm:1']).action, 'delete');
  const plan = planFigmaCommand(measurementMutationPlanningArgvFromRequest({
    action: 'add', from: `${url}:right`, to: '3:4:left', text: 'Gap',
  }), { adapter: 'mcp' });
  assert.equal(plan.target.fileKey, 'FILEA'); assert.equal(plan.argv.includes('1:2:right'), true);
  for (const argv of [
    ['measure', 'add', '1:2:right', '3:4:left', '--offset', '1', '--relative', '0.5'],
    ['measure', 'edit', 'm:1'],
    ['measure', 'delete'],
    ['measure', 'add', '1:2:center', '3:4:left'],
  ]) assert.throws(() => parseMeasurementMutationRequest(argv), /Invalid measurement mutation command/);
});

test('Measurement Mutation adds, edits and deletes with fresh facts', async () => {
  const add = fixture();
  const added = await executeMeasurementMutation({
    action: 'add', from: '1:2:right', to: '3:4:left', offset: { type: 'INNER', relative: 0.5 }, text: 'Gap',
  }, { evaluate: evaluate(add.figma) });
  assert.equal(added.result.measurement.id, 'm:2'); assert.equal(added.result.measurement.freeText, 'Gap');

  const edit = fixture();
  const edited = await executeMeasurementMutation({ action: 'edit', id: 'm:1', text: 'Updated' }, {
    evaluate: evaluate(edit.figma),
  });
  assert.equal(edited.result.measurement.freeText, 'Updated');

  const remove = fixture();
  const deleted = await executeMeasurementMutation({ action: 'delete', id: 'm:1' }, {
    evaluate: evaluate(remove.figma),
  });
  assert.equal(deleted.result.status, 'deleted'); assert.equal(remove.measurements().length, 0);
});

test('Measurement Mutation preflights and distinguishes rollback from irreversible unchanged state', async () => {
  const wrongEditor = fixture({ editorType: 'figma' });
  await assert.rejects(() => executeMeasurementMutation({
    action: 'add', from: '1:2:right', to: '3:4:left',
  }, { evaluate: evaluate(wrongEditor.figma) }), (error) => error.mutationOutcome === 'no-mutation');

  const badAdd = fixture({ wrongAdd: true });
  await assert.rejects(() => executeMeasurementMutation({
    action: 'add', from: '1:2:right', to: '3:4:left', text: 'Gap',
  }, { evaluate: evaluate(badAdd.figma) }), (error) => error.mutationOutcome === 'rolled-back'
    && error.mutationReport.residueCount === 0 && badAdd.measurements().length === 1);

  const badEdit = fixture({ wrongEdit: true });
  await assert.rejects(() => executeMeasurementMutation({ action: 'edit', id: 'm:1', text: 'Updated' }, {
    evaluate: evaluate(badEdit.figma),
  }), (error) => error.mutationOutcome === 'rolled-back' && badEdit.measurements()[0].freeText === 'Existing');

  const unchangedDelete = fixture({ deleteNoEffect: true });
  await assert.rejects(() => executeMeasurementMutation({ action: 'delete', id: 'm:1' }, {
    evaluate: evaluate(unchangedDelete.figma),
  }), (error) => error.mutationOutcome === 'unchanged' && error.mutationReport.residueCount === 1);
});

test('Measurement Mutation has one non-retrying Plan and one evaluation in both Adapters', async () => {
  const requests = [
    { action: 'add', from: '1:2:right', to: '3:4:left' },
    { action: 'edit', id: 'm:1', text: 'Updated' },
    { action: 'delete', id: 'm:1' },
  ];
  for (const request of requests) {
    const argv = measurementMutationArgvFromRequest(request);
    const mcp = planFigmaCommand(argv, { adapter: 'mcp', fileKey: 'FILEA' });
    const cli = planFigmaCommand(argv, { adapter: 'cli', fileKey: 'FILEA' });
    assert.equal(mcp.allowed, true); assert.equal(cli.allowed, true);
    assert.equal(measurementMutationPlanRoute(mcp), 'command-application');
    assert.deepEqual(mcp.effects, cli.effects); assert.equal(mcp.execution.retry, 'never');
    const live = fixture(); let evaluations = 0;
    const result = await executeMeasurementMutationPlan(mcp, {
      evaluate: async (code) => { evaluations += 1; return evaluate(live.figma)(code); },
    });
    assert.equal(['created', 'updated', 'deleted'].includes(result.result.status), true);
    assert.equal(evaluations, 1);
  }
});
