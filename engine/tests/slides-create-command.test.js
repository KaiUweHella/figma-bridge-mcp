import assert from 'node:assert/strict';
import test from 'node:test';
import { planFigmaCommand } from '../../src/capability-catalog.js';
import {
  executeSlidesCreate,
  executeSlidesCreatePlan,
  slidesCreateArgvFromRequest,
  slidesCreateCode,
  slidesCreatePlanRoute,
} from '../src/application/slides-create-command.js';
import {
  acceptsSlidesCreateArgv,
  parseSlidesCreateRequest,
} from '../src/application/slides-create-request.js';

function runtime({
  labelFailure = null, factoryFailure = false, removeFailure = null, gridDelayReads = 0,
  gridNeverLists = false,
} = {}) {
  let next = 3;
  let grid = [];
  let orphans = [];
  let staleGrid = null;
  let pendingGridReads = 0;
  const registry = new Map();
  const labels = new Map();
  const makeSlide = (id, name) => {
    const slide = {
      id, name, type: 'SLIDE', children: [], isSkippedSlide: false,
      getPluginData(key) { return key === 'bridge-slide-label' ? labels.get(id) || '' : ''; },
      setPluginData(key, value) {
        if (labelFailure === 'before') throw new Error('label setter failed');
        if (key === 'bridge-slide-label') labels.set(id, value);
        if (labelFailure === 'after') throw new Error('label setter acknowledgement failed');
      },
      remove() {
        if (removeFailure === 'before') throw new Error('remove failed');
        grid = grid.map((row) => row.filter((node) => node.id !== id)).filter((row) => row.length);
        orphans = orphans.filter((node) => node.id !== id);
        registry.delete(id);
        if (removeFailure === 'after') throw new Error('remove acknowledgement failed');
      },
    };
    registry.set(id, slide);
    return slide;
  };
  const intro = makeSlide('1:1', 'Intro');
  const details = makeSlide('1:2', 'Details');
  grid = [[intro, details]];
  const page = {
    id: '0:1', focusedSlide: intro, selection: [details],
    get children() { return [{ type: 'SLIDE_ROW', children: [...grid.flat(), ...orphans] }]; },
  };
  const figma = {
    editorType: 'slides', currentPage: page,
    getCanvasGrid() {
      if (pendingGridReads > 0) {
        pendingGridReads -= 1;
        return staleGrid;
      }
      return grid;
    },
    async getNodeByIdAsync(id) { return registry.get(id) || null; },
    createSlide(row, col) {
      staleGrid = grid.map((currentRow) => [...currentRow]);
      const slide = makeSlide(`1:${next}`, `Slide ${next++}`);
      if (gridNeverLists) orphans.push(slide);
      else if (row === undefined) grid[grid.length - 1].push(slide);
      else {
        while (grid.length <= row) grid.push([]);
        grid[row].splice(col === undefined ? grid[row].length : col, 0, slide);
      }
      pendingGridReads = gridDelayReads;
      if (factoryFailure) throw new Error('factory acknowledgement failed');
      return slide;
    },
  };
  return { figma, page, intro, details, labels, getGrid: () => grid };
}

const evaluate = (figma) => async (code) => new Function('figma', `return ${code}`)(figma);

test('Slides Create closes labels, coordinates, option multiplicity and canonical argv', () => {
  assert.deepEqual(parseSlidesCreateRequest([
    'slides', 'create', '--row=2', '--col', '3', 'Agenda',
  ]), { label: 'Agenda', row: 2, col: 3 });
  assert.deepEqual(slidesCreateArgvFromRequest({ label: '-Agenda', row: 1, col: 0 }), [
    'slides', 'create', '--row=1', '--col=0', '--', '-Agenda',
  ]);
  assert.deepEqual(slidesCreateArgvFromRequest({}), ['slides', 'create']);
  for (const argv of [
    ['slides', 'create', '--col=1'],
    ['slides', 'create', '--row=-1'],
    ['slides', 'create', '--row=1.5'],
    ['slides', 'create', '--row=1', '--row=2'],
    ['slides', 'create', 'one', 'two'],
    ['slides', 'create', '--future'],
  ]) assert.equal(acceptsSlidesCreateArgv(argv), false, argv.join(' '));
  assert.throws(() => slidesCreateArgvFromRequest({ future: true }), /unknown field/);
});

test('Slides Create waits for Figma to publish a freshly created Slide into the native grid', async () => {
  const live = runtime({ gridDelayReads: 2 });
  const result = await executeSlidesCreate({ label: 'Agenda' }, {
    evaluate: evaluate(live.figma),
  });
  assert.equal(result.result.outcome, 'verified');
  assert.deepEqual(result.result.actual.slide, {
    id: '1:3', name: 'Slide 3', label: 'Agenda', row: 0, col: 2,
  });
});

test('Slides Create appends, labels, focuses and selects one freshly verified Slide', async () => {
  const live = runtime();
  const result = await executeSlidesCreate({ label: 'Agenda' }, {
    evaluate: evaluate(live.figma),
  });
  const slide = result.result.actual.slide;
  assert.deepEqual(slide, {
    id: '1:3', name: 'Slide 3', label: 'Agenda', row: 0, col: 2,
  });
  assert.equal(result.result.outcome, 'verified');
  assert.deepEqual(live.getGrid().map((row) => row.map((node) => node.id)), [
    ['1:1', '1:2', '1:3'],
  ]);
  assert.equal(live.page.focusedSlide.id, '1:3');
  assert.deepEqual(live.page.selection.map((node) => node.id), ['1:3']);
  assert.equal(result.stdout, '✓ Slide 1:3 [Agenda] at 0,2 (Figma name: "Slide 3")');
});

test('explicit row and column use native createSlide positioning and preserve prior membership', async () => {
  const live = runtime();
  const result = await executeSlidesCreate({ label: null, row: 1, col: 0 }, {
    evaluate: evaluate(live.figma),
  });
  assert.deepEqual(result.result.actual.slide, {
    id: '1:3', name: 'Slide 3', label: null, row: 1, col: 0,
  });
  assert.deepEqual(live.getGrid().map((row) => row.map((node) => node.id)), [
    ['1:1', '1:2'], ['1:3'],
  ]);
});

test('an acknowledgement error succeeds only when fresh readback proves the exact creation', async () => {
  const live = runtime({ labelFailure: 'after' });
  const result = await executeSlidesCreate({ label: 'Agenda' }, {
    evaluate: evaluate(live.figma),
  });
  assert.equal(result.result.outcome, 'verified-after-error');
  assert.match(result.stderr, /fresh Slides readback verified/);
  assert.equal(live.getGrid()[0].length, 3);
});

test('factory and label failures remove the attributed Slide and restore focus and selection', async () => {
  for (const options of [{ factoryFailure: true }, { labelFailure: 'before' }]) {
    const live = runtime(options);
    await assert.rejects(() => executeSlidesCreate({ label: 'Agenda' }, {
      evaluate: evaluate(live.figma),
    }), (error) => {
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
  await assert.rejects(() => executeSlidesCreate({ label: 'Agenda' }, {
    evaluate: evaluate(residue.figma),
  }), (error) => {
    assert.equal(error.mutationOutcome, 'partial-residue');
    assert.equal(error.mutationReport.residueCount, 2);
    return true;
  });
  assert.equal(residue.getGrid()[0].length, 3);

  const removed = runtime({ labelFailure: 'before', removeFailure: 'after' });
  await assert.rejects(() => executeSlidesCreate({ label: 'Agenda' }, {
    evaluate: evaluate(removed.figma),
  }), (error) => {
    assert.equal(error.mutationOutcome, 'rolled-back');
    return true;
  });
  assert.equal(removed.getGrid()[0].length, 2);
});

test('wrong editors refuse before mutation and write Plans never retry', async () => {
  const live = runtime();
  live.figma.editorType = 'figma';
  await assert.rejects(() => executeSlidesCreate({ label: null }, {
    evaluate: evaluate(live.figma),
  }), (error) => {
    assert.equal(error.mutationOutcome, 'no-mutation');
    assert.equal(error.mutationReport.attempted, 0);
    return true;
  });
  assert.equal(live.getGrid()[0].length, 2);

  const cli = planFigmaCommand(['slides', 'create', '--row=1', 'Agenda'], { adapter: 'cli' });
  const mcp = planFigmaCommand(['slides', 'create', 'Agenda', '--row', '1'], { adapter: 'mcp' });
  assert.equal(cli.allowed, true);
  assert.equal(mcp.allowed, true);
  assert.deepEqual(cli.argv, ['slides', 'create', '--row=1', 'Agenda']);
  assert.deepEqual(cli.argv, mcp.argv);
  assert.deepEqual(cli.effects, mcp.effects);
  assert.deepEqual(cli.execution, mcp.execution);
  assert.deepEqual(cli.effects, {
    figma: 'write', editor: 'write', workspace: 'none', network: 'none', shared: 'none',
  });
  assert.equal(cli.confirmation, 'configured');
  assert.equal(cli.execution.retry, 'never');
  assert.equal(slidesCreatePlanRoute(cli), 'command-application');
  assert.throws(() => slidesCreatePlanRoute({ ...cli }), /requires a Command Plan/);

  const execution = runtime();
  let calls = 0;
  const result = await executeSlidesCreatePlan(cli, { evaluate: async (code) => {
    calls += 1;
    return evaluate(execution.figma)(code);
  } });
  assert.equal(result.result.actual.slide.row, 1);
  assert.equal(calls, 1);
});

test('malformed and forged Plugin results cannot claim a successful Slide creation', async () => {
  for (const value of [null, {}, 'not-json', JSON.stringify({ status: 'created' })]) {
    await assert.rejects(() => executeSlidesCreate({ label: null }, {
      evaluate: async () => value,
    }), /invalid/i);
  }
  const live = runtime();
  const serialized = await evaluate(live.figma)(slidesCreateCode({ label: 'Agenda' }));
  const payload = JSON.parse(serialized);
  for (const forged of [
    { ...payload, future: true },
    { ...payload, request: { ...payload.request, label: 'Other' } },
    { ...payload, actual: { ...payload.actual, focusedId: '1:1' } },
    { ...payload, actual: { ...payload.actual, rows: payload.before.rows } },
    { ...payload, actual: { ...payload.actual, slide: {
      ...payload.actual.slide, row: 9,
    } } },
  ]) {
    await assert.rejects(() => executeSlidesCreate({ label: 'Agenda' }, {
      evaluate: async () => JSON.stringify(forged),
    }), /invalid bounded result/);
  }
});

test('Slides Create generated Plugin code parses', () => {
  assert.doesNotThrow(() => new Function(`return ${slidesCreateCode({ label: null })}`));
  assert.doesNotThrow(() => new Function(`return ${slidesCreateCode({
    label: 'Agenda', row: 1, col: 0,
  })}`));
});

test('a created slide the grid never lists is verified by existence and reported as unobserved', async () => {
  const live = runtime({ gridNeverLists: true });
  const result = await executeSlidesCreate({ label: 'Agenda' }, { evaluate: evaluate(live.figma) });
  assert.equal(result.result.status, 'created');
  assert.equal(result.result.outcome, 'verified');
  assert.equal(result.result.gridObserved, false);
  assert.deepEqual(result.result.actual.slide, {
    id: '1:3', name: 'Slide 3', label: 'Agenda', row: null, col: null,
  });
  assert.deepEqual(result.result.actual.unlisted, ['1:3']);
  assert.deepEqual(live.getGrid().map((row) => row.map((node) => node.id)), [['1:1', '1:2']]);
  assert.equal(live.page.focusedSlide.id, '1:3');
  assert.match(result.stdout, /Slide 1:3 \[Agenda\] created; the canvas grid has not listed/);
  assert.match(result.stderr, /Run slides manifest/);

  // A label failure on such a slide still removes it: attribution by existence.
  const failing = runtime({ gridNeverLists: true, labelFailure: 'before' });
  await assert.rejects(
    () => executeSlidesCreate({ label: 'Agenda' }, { evaluate: evaluate(failing.figma) }),
    /rolled-back/,
  );
  assert.equal(failing.page.children[0].children.length, 2, 'the orphan was removed again');
});

test('a focus resting on a slide the grid has not listed yet does not refuse creation', async () => {
  const live = runtime();
  const ghost = { id: '1:9', name: 'Ghost', type: 'SLIDE' };
  const listed = live.page.children;
  Object.defineProperty(live.page, 'children', {
    get: () => [{ type: 'SLIDE_ROW', children: [...listed[0].children, ghost] }],
  });
  live.page.focusedSlide = ghost;
  const result = await executeSlidesCreate({ label: 'Fresh' }, { evaluate: evaluate(live.figma) });
  assert.equal(result.result.status, 'created');
  assert.equal(result.result.before.focusedId, '1:9');
  assert.deepEqual(result.result.before.unlisted, ['1:9']);
});
