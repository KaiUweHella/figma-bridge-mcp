import assert from 'node:assert/strict';
import test from 'node:test';
import { planFigmaCommand } from '../../src/capability-catalog.js';
import {
  executeSlidesDuplicate,
  executeSlidesDuplicatePlan,
  slidesDuplicateArgvFromRequest,
  slidesDuplicateCode,
  slidesDuplicatePlanRoute,
} from '../src/application/slides-duplicate-command.js';
import {
  acceptsSlidesDuplicateArgv,
  parseSlidesDuplicateRequest,
  slidesDuplicateFigmaUrlFileKeyFromArgv,
  slidesDuplicatePlanningArgvFromRequest,
} from '../src/application/slides-duplicate-request.js';

const TRANSITION = Object.freeze({
  style: 'DISSOLVE', duration: 0.3, curve: 'EASE_IN_AND_OUT', timing: { type: 'ON_CLICK' },
});

function runtime({
  cloneFailure = null, moveFailure = null, labelFailure = null, removeFailure = null,
} = {}) {
  let next = 3;
  let grid = [];
  const registry = new Map();
  const labels = new Map();
  const makeSlide = (id, name, { label = '', childCount = 2, skipped = false } = {}) => {
    if (label) labels.set(id, label);
    const slide = {
      id, name, type: 'SLIDE',
      children: Array.from({ length: childCount }, (_, index) => ({ id: `${id}:${index}` })),
      isSkippedSlide: skipped,
      getSlideTransition() { return structuredClone(TRANSITION); },
      getPluginData(key) { return key === 'bridge-slide-label' ? labels.get(id) || '' : ''; },
      setPluginData(key, value) {
        if (labelFailure === 'before') throw new Error('label setter failed');
        if (key === 'bridge-slide-label') labels.set(id, value);
        if (labelFailure === 'after') throw new Error('label setter acknowledgement failed');
      },
      clone() {
        if (cloneFailure === 'before') throw new Error('clone failed');
        const copy = makeSlide(`1:${next}`, `Slide ${next++}`, {
          label: labels.get(id) || '', childCount: slide.children.length,
          skipped: slide.isSkippedSlide,
        });
        grid[grid.length - 1].push(copy);
        if (cloneFailure === 'after') throw new Error('clone acknowledgement failed');
        return copy;
      },
      remove() {
        if (removeFailure === 'before') throw new Error('remove failed');
        grid = grid.map((row) => row.filter((node) => node.id !== id)).filter((row) => row.length);
        registry.delete(id);
        if (removeFailure === 'after') throw new Error('remove acknowledgement failed');
      },
    };
    registry.set(id, slide);
    return slide;
  };
  const intro = makeSlide('1:1', 'Intro', { label: 'Opening', childCount: 1 });
  const details = makeSlide('1:2', 'Details', { label: 'Body', childCount: 3, skipped: true });
  grid = [[intro, details]];
  const page = { id: '0:1', focusedSlide: intro, selection: [details] };
  const figma = {
    editorType: 'slides', currentPage: page,
    getCanvasGrid() { return grid; },
    async getNodeByIdAsync(id) { return registry.get(id) || null; },
    moveNodesToCoord(ids, row, col) {
      if (moveFailure === 'before') throw new Error('move failed');
      const nodes = ids.map((id) => registry.get(id));
      grid = grid.map((source) => source.filter((node) => !ids.includes(node.id)))
        .filter((source) => source.length);
      if (row === undefined) grid[grid.length - 1].push(...nodes);
      else grid[row].splice(col === undefined ? grid[row].length : col, 0, ...nodes);
      if (moveFailure === 'after') throw new Error('move acknowledgement failed');
    },
  };
  return {
    figma, page, intro, details, labels, registry, makeSlide,
    getGrid: () => grid,
  };
}

const evaluate = (figma) => async (code) => new Function('figma', `return ${code}`)(figma);

test('Slides Duplicate closes references, labels, coordinates and canonical argv', () => {
  const url = 'https://www.figma.com/design/TARGETPLACEHOLDERKEY/FILE_NAME?node-id=1-2';
  const input = parseSlidesDuplicateRequest([
    'slides', 'duplicate', `node:${url}`, '--col', '0', '--row=1', '--label=Copy',
  ]);
  assert.deepEqual(
    { kind: input.reference.kind, value: input.reference.value, label: input.label,
      row: input.row, col: input.col },
    { kind: 'node', value: '1:2', label: 'Copy', row: 1, col: 0 },
  );
  assert.equal(input.reference.fileKey, 'TARGETPLACEHOLDERKEY');
  assert.deepEqual(slidesDuplicateArgvFromRequest({
    reference: 'label:Body', label: 'Copy', row: 0, col: 1,
  }), ['slides', 'duplicate', 'label:Body', '--label=Copy', '--row=0', '--col=1']);
  const planning = slidesDuplicatePlanningArgvFromRequest({ reference: `node:${url}` });
  assert.equal(slidesDuplicateFigmaUrlFileKeyFromArgv(planning), 'TARGETPLACEHOLDERKEY');
  for (const argv of [
    ['slides', 'duplicate'],
    ['slides', 'duplicate', 'Details', '--col=1'],
    ['slides', 'duplicate', 'Details', '--row=-1'],
    ['slides', 'duplicate', 'Details', '--row=1', '--row=2'],
    ['slides', 'duplicate', 'one', 'two'],
    ['slides', 'duplicate', 'Details', '--future'],
  ]) assert.equal(acceptsSlidesDuplicateArgv(argv), false, argv.join(' '));
  assert.throws(() => slidesDuplicateArgvFromRequest({
    reference: 'Details', future: true,
  }), /unknown field/);
});

test('Slides Duplicate clones one exact source and freshly verifies copied facts', async () => {
  const live = runtime();
  const result = await executeSlidesDuplicate({
    reference: 'label:Body', label: 'Details alt', row: 0, col: 0,
  }, { evaluate: evaluate(live.figma) });
  assert.equal(result.result.outcome, 'verified');
  assert.deepEqual(result.result.actual.slide, {
    id: '1:3', name: 'Slide 3', label: 'Details alt', row: 0, col: 0,
    skipped: true, transition: TRANSITION, childCount: 3,
  });
  assert.equal(result.result.actual.source.id, '1:2');
  assert.deepEqual(live.getGrid().map((row) => row.map((node) => node.id)), [
    ['1:3', '1:1', '1:2'],
  ]);
  assert.equal(live.page.focusedSlide.id, '1:3');
  assert.deepEqual(live.page.selection.map((node) => node.id), ['1:3']);
  assert.equal(result.stdout, '✓ Slide 1:2 duplicated as 1:3 [Details alt]');
});

test('default duplicate placement and label preserve the legacy Slides contract', async () => {
  const live = runtime();
  const result = await executeSlidesDuplicate({ reference: 'name:Intro' }, {
    evaluate: evaluate(live.figma),
  });
  assert.deepEqual(
    { label: result.result.actual.slide.label,
      row: result.result.actual.slide.row, col: result.result.actual.slide.col },
    { label: 'Opening copy', row: 0, col: 2 },
  );
});

test('ambiguous sources and invalid coordinates refuse before cloning', async () => {
  for (const request of [
    { reference: 'name:Same' },
    { reference: 'Details', row: 4, col: 0 },
    { reference: 'Details', row: 0, col: 3 },
  ]) {
    const live = runtime();
    if (request.reference === 'name:Same') {
      live.intro.name = 'Same';
      live.details.name = 'Same';
    }
    await assert.rejects(() => executeSlidesDuplicate(request, {
      evaluate: evaluate(live.figma),
    }), (error) => {
      assert.equal(error.mutationOutcome, 'no-mutation');
      assert.equal(error.mutationReport.attempted, 0);
      return true;
    });
    assert.equal(live.getGrid()[0].length, 2);
  }
});

test('a final acknowledgement error succeeds only after exact fresh readback', async () => {
  const live = runtime({ labelFailure: 'after' });
  const result = await executeSlidesDuplicate({ reference: 'Details', label: 'Copy' }, {
    evaluate: evaluate(live.figma),
  });
  assert.equal(result.result.outcome, 'verified-after-error');
  assert.match(result.stderr, /fresh Slides readback verified/);
  assert.equal(live.getGrid()[0].length, 3);
});

test('clone, move and label failures remove the attributed copy and restore editor state', async () => {
  for (const options of [
    { cloneFailure: 'after' }, { moveFailure: 'before' },
    { moveFailure: 'after' }, { labelFailure: 'before' },
  ]) {
    const live = runtime(options);
    await assert.rejects(() => executeSlidesDuplicate({
      reference: 'Details', label: 'Copy', row: 0, col: 0,
    }, { evaluate: evaluate(live.figma) }), (error) => {
      assert.equal(error.mutationOutcome, 'rolled-back');
      assert.deepEqual(error.mutationReport, {
        version: 1, outcome: 'rolled-back', attempted: 1, restored: 1, residueCount: 0,
      });
      return true;
    });
    assert.deepEqual(live.getGrid().map((row) => row.map((node) => node.id)), [
      ['1:1', '1:2'],
    ]);
    assert.equal(live.page.focusedSlide.id, '1:1');
    assert.deepEqual(live.page.selection.map((node) => node.id), ['1:2']);
  }
});

test('rollback residue and post-remove acknowledgement are distinguished by fresh state', async () => {
  const residue = runtime({ labelFailure: 'before', removeFailure: 'before' });
  await assert.rejects(() => executeSlidesDuplicate({ reference: 'Details', label: 'Copy' }, {
    evaluate: evaluate(residue.figma),
  }), (error) => {
    assert.equal(error.mutationOutcome, 'partial-residue');
    assert.equal(error.mutationReport.residueCount, 2);
    return true;
  });
  assert.equal(residue.getGrid()[0].length, 3);

  const removed = runtime({ labelFailure: 'before', removeFailure: 'after' });
  await assert.rejects(() => executeSlidesDuplicate({ reference: 'Details', label: 'Copy' }, {
    evaluate: evaluate(removed.figma),
  }), (error) => {
    assert.equal(error.mutationOutcome, 'rolled-back');
    return true;
  });
  assert.equal(removed.getGrid()[0].length, 2);
});

test('CLI and MCP share one authentic non-retrying write Plan and one execution', async () => {
  const url = 'https://www.figma.com/design/TARGETPLACEHOLDERKEY/FILE_NAME?node-id=1-2';
  const cli = planFigmaCommand([
    'slides', 'duplicate', `node:${url}`, '--row=0', '--label=Copy',
  ], { adapter: 'cli' });
  const mcp = planFigmaCommand([
    'slides', 'duplicate', '--label', 'Copy', '--row', '0', `node:${url}`,
  ], { adapter: 'mcp' });
  assert.equal(cli.allowed, true);
  assert.deepEqual(cli.argv, mcp.argv);
  assert.deepEqual(cli.effects, mcp.effects);
  assert.deepEqual(cli.execution, mcp.execution);
  assert.equal(cli.target.fileKey, 'TARGETPLACEHOLDERKEY');
  assert.equal(cli.confirmation, 'configured');
  assert.equal(cli.execution.retry, 'never');
  assert.equal(slidesDuplicatePlanRoute(cli), 'command-application');
  assert.throws(() => slidesDuplicatePlanRoute({ ...cli }), /requires a Command Plan/);

  const live = runtime();
  let calls = 0;
  const result = await executeSlidesDuplicatePlan(cli, { evaluate: async (code) => {
    calls += 1;
    return evaluate(live.figma)(code);
  } });
  assert.equal(result.result.actual.source.id, '1:2');
  assert.equal(calls, 1);
});

test('wrong editors and forged Plugin results cannot claim a duplicate', async () => {
  const wrong = runtime();
  wrong.figma.editorType = 'figma';
  await assert.rejects(() => executeSlidesDuplicate({ reference: 'Details' }, {
    evaluate: evaluate(wrong.figma),
  }), (error) => {
    assert.equal(error.mutationOutcome, 'no-mutation');
    return true;
  });
  assert.equal(wrong.getGrid()[0].length, 2);

  for (const value of [null, {}, 'not-json', JSON.stringify({ status: 'duplicated' })]) {
    await assert.rejects(() => executeSlidesDuplicate({ reference: 'Details' }, {
      evaluate: async () => value,
    }), /invalid/i);
  }
  const live = runtime();
  const serialized = await evaluate(live.figma)(slidesDuplicateCode({
    reference: 'Details', label: 'Copy',
  }));
  const payload = JSON.parse(serialized);
  for (const forged of [
    { ...payload, future: true },
    { ...payload, request: { ...payload.request, label: 'Other' } },
    { ...payload, actual: { ...payload.actual, focusedId: '1:1' } },
    { ...payload, actual: { ...payload.actual, rows: payload.before.rows } },
    { ...payload, actual: { ...payload.actual, slide: {
      ...payload.actual.slide, childCount: payload.actual.slide.childCount + 1,
    } } },
  ]) {
    await assert.rejects(() => executeSlidesDuplicate({
      reference: 'Details', label: 'Copy',
    }, { evaluate: async () => JSON.stringify(forged) }), /invalid bounded result/);
  }
});

test('Slides Duplicate generated Plugin code parses', () => {
  assert.doesNotThrow(() => new Function(`return ${slidesDuplicateCode({
    reference: 'Details',
  })}`));
  assert.doesNotThrow(() => new Function(`return ${slidesDuplicateCode({
    reference: 'label:Body', label: 'Copy', row: 0, col: 1,
  })}`));
});
