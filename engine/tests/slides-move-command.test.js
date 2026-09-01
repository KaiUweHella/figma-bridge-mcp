import assert from 'node:assert/strict';
import test from 'node:test';
import { planFigmaCommand } from '../../src/capability-catalog.js';
import {
  executeSlidesMove,
  executeSlidesMovePlan,
  slidesMoveArgvFromRequest,
  slidesMoveCode,
  slidesMovePlanRoute,
} from '../src/application/slides-move-command.js';
import {
  acceptsSlidesMoveArgv,
  parseSlidesMoveRequest,
  slidesMoveFigmaUrlFileKeyFromArgv,
  slidesMovePlanningArgvFromRequest,
} from '../src/application/slides-move-request.js';

const TRANSITION = Object.freeze({
  style: 'DISSOLVE', duration: 0.3, curve: 'EASE_IN_AND_OUT', timing: { type: 'ON_CLICK' },
});

function runtime({ firstMove = 'exact', rollbackMove = 'exact' } = {}) {
  let calls = 0;
  let grid = [];
  const registry = new Map();
  const labels = new Map();
  const makeSlide = (id, name, { label = '', childCount = 1, skipped = false } = {}) => {
    labels.set(id, label);
    const slide = {
      id, name, type: 'SLIDE', isSkippedSlide: skipped,
      children: Array.from({ length: childCount }, (_, index) => ({ id: `${id}:${index}` })),
      getSlideTransition() { return structuredClone(TRANSITION); },
      getPluginData(key) { return key === 'bridge-slide-label' ? labels.get(id) || '' : ''; },
    };
    registry.set(id, slide);
    return slide;
  };
  const intro = makeSlide('1:1', 'Intro', { label: 'Opening' });
  const details = makeSlide('1:2', 'Details', { label: 'Body', childCount: 3, skipped: true });
  const end = makeSlide('1:3', 'End', { label: 'Closing' });
  grid = [[intro, details], [end]];
  const page = { id: '0:1', focusedSlide: intro, selection: [details] };
  const figma = {
    editorType: 'slides', currentPage: page,
    getCanvasGrid() { return grid; },
    async getNodeByIdAsync(id) { return registry.get(id) || null; },
    moveNodesToCoord(ids, row, col) {
      calls += 1;
      const behavior = calls === 1 ? firstMove : rollbackMove;
      if (behavior === 'throw-before') throw new Error('move failed');
      const nodes = ids.map((id) => registry.get(id));
      grid = grid.map((source) => source.filter((node) => !ids.includes(node.id)))
        .filter((source) => source.length);
      const targetCol = behavior === 'wrong' ? 0 : col;
      grid[row].splice(targetCol, 0, ...nodes);
      if (behavior === 'throw-after') throw new Error('move acknowledgement failed');
    },
  };
  return { figma, page, intro, details, end, getGrid: () => grid, calls: () => calls };
}

const evaluate = (figma) => async (code) => new Function('figma', `return ${code}`)(figma);

test('Slides Move closes typed references and exact zero-based coordinates', () => {
  const url = 'https://www.figma.com/design/TARGETPLACEHOLDERKEY/FILE_NAME?node-id=1-2';
  const parsed = parseSlidesMoveRequest(['slides', 'move', `node:${url}`, '1', '0']);
  assert.deepEqual(
    { kind: parsed.reference.kind, value: parsed.reference.value, row: parsed.row, col: parsed.col },
    { kind: 'node', value: '1:2', row: 1, col: 0 },
  );
  assert.equal(parsed.reference.fileKey, 'TARGETPLACEHOLDERKEY');
  assert.deepEqual(slidesMoveArgvFromRequest({
    reference: 'label:Body', row: 0, col: 1,
  }), ['slides', 'move', 'label:Body', '0', '1']);
  const planning = slidesMovePlanningArgvFromRequest({
    reference: `node:${url}`, row: 1, col: 0,
  });
  assert.equal(slidesMoveFigmaUrlFileKeyFromArgv(planning), 'TARGETPLACEHOLDERKEY');
  for (const argv of [
    ['slides', 'move', 'Details', '0'],
    ['slides', 'move', 'Details', '-1', '0'],
    ['slides', 'move', 'Details', '0', '1.5'],
    ['slides', 'move', 'Details', '0', '1', 'extra'],
    ['slides', 'move', 'Details', '--row=0', '1'],
  ]) assert.equal(acceptsSlidesMoveArgv(argv), false, argv.join(' '));
  assert.throws(() => slidesMoveArgvFromRequest({
    reference: 'Details', row: 0, col: 1, future: true,
  }), /unknown field/);
});

test('Slides Move changes only exact grid position and freshly verifies full Slide facts', async () => {
  const live = runtime();
  const result = await executeSlidesMove({ reference: 'label:Body', row: 1, col: 1 }, {
    evaluate: evaluate(live.figma),
  });
  assert.equal(result.result.outcome, 'verified');
  assert.deepEqual(result.result.actual.slide, {
    id: '1:2', name: 'Details', label: 'Body', row: 1, col: 1,
    skipped: true, transition: TRANSITION, childCount: 3,
  });
  assert.deepEqual(live.getGrid().map((row) => row.map((node) => node.id)), [
    ['1:1'], ['1:3', '1:2'],
  ]);
  assert.equal(live.page.focusedSlide.id, '1:1');
  assert.deepEqual(live.page.selection.map((node) => node.id), ['1:2']);
  assert.equal(result.stdout, '✓ Slide 1:2 moved to 1,1');
});

test('ambiguous references and unreachable coordinates refuse before mutation', async () => {
  for (const request of [
    { reference: 'name:Same', row: 1, col: 0 },
    { reference: 'Details', row: 4, col: 0 },
    { reference: 'Details', row: 0, col: 2 },
  ]) {
    const live = runtime();
    if (request.reference === 'name:Same') {
      live.intro.name = 'Same'; live.details.name = 'Same';
    }
    await assert.rejects(() => executeSlidesMove(request, {
      evaluate: evaluate(live.figma),
    }), (error) => {
      assert.equal(error.mutationOutcome, 'no-mutation');
      assert.equal(error.mutationReport.attempted, 0);
      return true;
    });
    assert.equal(live.calls(), 0);
  }
});

test('a move acknowledgement error succeeds only after exact fresh readback', async () => {
  const live = runtime({ firstMove: 'throw-after' });
  const result = await executeSlidesMove({ reference: 'Details', row: 1, col: 1 }, {
    evaluate: evaluate(live.figma),
  });
  assert.equal(result.result.outcome, 'verified-after-error');
  assert.match(result.stderr, /fresh Slides readback verified/);
  assert.equal(live.calls(), 1);
});

test('failed and wrong moves restore the exact grid and editor state', async () => {
  for (const firstMove of ['throw-before', 'wrong']) {
    const live = runtime({ firstMove });
    await assert.rejects(() => executeSlidesMove({ reference: 'Details', row: 1, col: 1 }, {
      evaluate: evaluate(live.figma),
    }), (error) => {
      assert.equal(error.mutationOutcome, 'rolled-back');
      assert.deepEqual(error.mutationReport, {
        version: 1, outcome: 'rolled-back', attempted: 1, restored: 1, residueCount: 0,
      });
      return true;
    });
    assert.deepEqual(live.getGrid().map((row) => row.map((node) => node.id)), [
      ['1:1', '1:2'], ['1:3'],
    ]);
    assert.equal(live.page.focusedSlide.id, '1:1');
    assert.deepEqual(live.page.selection.map((node) => node.id), ['1:2']);
  }
});

test('rollback residue and post-rollback acknowledgement remain distinct', async () => {
  const residue = runtime({ firstMove: 'wrong', rollbackMove: 'throw-before' });
  await assert.rejects(() => executeSlidesMove({ reference: 'Details', row: 1, col: 1 }, {
    evaluate: evaluate(residue.figma),
  }), (error) => {
    assert.equal(error.mutationOutcome, 'partial-residue');
    assert.ok(error.mutationReport.residueCount >= 1);
    return true;
  });

  const restored = runtime({ firstMove: 'wrong', rollbackMove: 'throw-after' });
  await assert.rejects(() => executeSlidesMove({ reference: 'Details', row: 1, col: 1 }, {
    evaluate: evaluate(restored.figma),
  }), (error) => {
    assert.equal(error.mutationOutcome, 'rolled-back');
    return true;
  });
});

test('CLI and MCP share target identity, policy and one non-retrying execution', async () => {
  const url = 'https://www.figma.com/design/TARGETPLACEHOLDERKEY/FILE_NAME?node-id=1-2';
  const cli = planFigmaCommand(['slides', 'move', `node:${url}`, '1', '1'], { adapter: 'cli' });
  const mcp = planFigmaCommand(['slides', 'move', `node:${url}`, '1', '1'], { adapter: 'mcp' });
  assert.equal(cli.allowed, true);
  assert.deepEqual(cli.argv, mcp.argv);
  assert.deepEqual(cli.effects, mcp.effects);
  assert.deepEqual(cli.execution, mcp.execution);
  assert.equal(cli.target.fileKey, 'TARGETPLACEHOLDERKEY');
  assert.equal(cli.confirmation, 'configured');
  assert.equal(cli.execution.retry, 'never');
  assert.equal(slidesMovePlanRoute(cli), 'command-application');
  assert.throws(() => slidesMovePlanRoute({ ...cli }), /requires a Command Plan/);
  const live = runtime();
  let calls = 0;
  const result = await executeSlidesMovePlan(cli, { evaluate: async (code) => {
    calls += 1; return evaluate(live.figma)(code);
  } });
  assert.equal(result.result.actual.slide.id, '1:2');
  assert.equal(calls, 1);
});

test('wrong editors and forged Plugin results cannot claim a move', async () => {
  const wrong = runtime(); wrong.figma.editorType = 'figma';
  await assert.rejects(() => executeSlidesMove({ reference: 'Details', row: 1, col: 1 }, {
    evaluate: evaluate(wrong.figma),
  }), (error) => { assert.equal(error.mutationOutcome, 'no-mutation'); return true; });
  assert.equal(wrong.calls(), 0);
  for (const value of [null, {}, 'not-json', JSON.stringify({ status: 'moved' })]) {
    await assert.rejects(() => executeSlidesMove({ reference: 'Details', row: 1, col: 1 }, {
      evaluate: async () => value,
    }), /invalid/i);
  }
  const live = runtime();
  const serialized = await evaluate(live.figma)(slidesMoveCode({
    reference: 'Details', row: 1, col: 1,
  }));
  const payload = JSON.parse(serialized);
  for (const forged of [
    { ...payload, future: true },
    { ...payload, request: { ...payload.request, col: 0 } },
    { ...payload, actual: { ...payload.actual, focusedId: '1:2' } },
    { ...payload, actual: { ...payload.actual, rows: payload.before.rows } },
    { ...payload, actual: { ...payload.actual, slide: {
      ...payload.actual.slide, childCount: payload.actual.slide.childCount + 1,
    } } },
  ]) {
    await assert.rejects(() => executeSlidesMove({ reference: 'Details', row: 1, col: 1 }, {
      evaluate: async () => JSON.stringify(forged),
    }), /invalid bounded result/);
  }
});

test('Slides Move generated Plugin code parses', () => {
  assert.doesNotThrow(() => new Function(`return ${slidesMoveCode({
    reference: 'label:Body', row: 1, col: 0,
  })}`));
});
