import assert from 'node:assert/strict';
import test from 'node:test';
import { planFigmaCommand } from '../../src/capability-catalog.js';
import {
  executeSectionFit,
  executeSectionFitPlan,
  MAX_SECTION_FIT_CHILDREN,
  sectionFitCode,
  sectionFitPlanRoute,
  sectionFitPlanningArgvFromRequest,
} from '../src/application/section-fit-command.js';
import {
  acceptsSectionFitArgv,
  parseSectionFitRequest,
  sectionFitArgvFromRequest,
  sectionFitFigmaUrlFileKeyFromArgv,
} from '../src/application/section-fit-request.js';

const INITIAL_SECTION = Object.freeze({ x: 100, y: 200, width: 500, height: 400 });
const INITIAL_CHILDREN = Object.freeze([
  Object.freeze({ id: '1:2', x: 80, y: 100, width: 120, height: 60 }),
  Object.freeze({ id: '1:3', x: 260, y: 220, width: 80, height: 100 }),
]);

function runtime({
  childCount = 2,
  mode = 'normal',
  rollbackMode = 'normal',
  getFailures = [],
} = {}) {
  const sectionState = { ...INITIAL_SECTION };
  const childStates = Array.from({ length: childCount }, (_, index) => ({
    ...(INITIAL_CHILDREN[index] || {
      id: `${index + 2}:1`, x: index * 2, y: index * 3, width: 10, height: 10,
    }),
  }));
  let phase = 'forward';
  let writes = 0;
  let operationWrites = 0;
  let gets = 0;
  const behavior = () => (phase === 'rollback' ? rollbackMode : mode);
  const assign = (target, field, value) => {
    writes += 1;
    operationWrites += 1;
    if (behavior() === 'no-effect') return;
    if (behavior() === 'partial' && target !== sectionState) return;
    target[field] = value;
    if (behavior() === 'throw-after' && operationWrites === 7) {
      throw new Error('injected native acknowledgement');
    }
  };
  const children = childStates.map((state) => ({
    get id() { return state.id; },
    get x() { return state.x; },
    set x(value) { assign(state, 'x', value); },
    get y() { return state.y; },
    set y(value) { assign(state, 'y', value); },
    get width() { return state.width; },
    get height() { return state.height; },
  }));
  const section = {
    id: '1:1', name: 'Components', type: 'SECTION', children,
    get x() { return sectionState.x; },
    set x(value) {
      phase = value === INITIAL_SECTION.x ? 'rollback' : 'forward';
      operationWrites = 0;
      assign(sectionState, 'x', value);
    },
    get y() { return sectionState.y; },
    set y(value) { assign(sectionState, 'y', value); },
    get width() { return sectionState.width; },
    get height() { return sectionState.height; },
    resizeWithoutConstraints(width, height) {
      assign(sectionState, 'width', width);
      if (behavior() !== 'no-effect') sectionState.height = height;
    },
  };
  return {
    section,
    writes: () => writes,
    snapshot: () => ({
      section: { ...sectionState }, children: childStates.map((child) => ({ ...child })),
    }),
    figma: {
      async getNodeByIdAsync(id) {
        gets += 1;
        if (getFailures.includes(gets)) throw new Error('injected readback failure');
        return id === '1:1' ? section : null;
      },
    },
  };
}

const evaluate = (figma) => async (code) => new Function('figma', `return ${code};`)(figma);

test('Section Fit closes pad grammar, canonical defaults, and URL identity', () => {
  assert.deepEqual(parseSectionFitRequest([
    'section', 'fit', '--pad=0', '1-1',
  ]), { sectionId: '1:1', pad: 0 });
  assert.deepEqual(sectionFitArgvFromRequest({ sectionId: '1-1', pad: 64 }),
    ['section', 'fit', '1:1']);
  assert.deepEqual(sectionFitArgvFromRequest({ sectionId: '1:1', pad: 24.5 }),
    ['section', 'fit', '1:1', '--pad=24.5']);
  for (const argv of [
    ['section', 'fit'],
    ['section', 'fit', '1:1', '1:2'],
    ['section', 'fit', '1:1', '--pad=-1'],
    ['section', 'fit', '1:1', '--pad='],
    ['section', 'fit', '1:1', '--pad=NaN'],
    ['section', 'fit', '1:1', '--pad=1', '--pad=2'],
    ['section', 'fit', '1:1', '--future'],
  ]) assert.equal(acceptsSectionFitArgv(argv), false, argv.join(' '));

  const url = 'https://www.figma.com/design/FILEA/Test?node-id=1-1';
  const planning = sectionFitPlanningArgvFromRequest({ sectionId: url, pad: 32 });
  assert.equal(sectionFitFigmaUrlFileKeyFromArgv(planning), 'FILEA');
  assert.equal(planFigmaCommand(planning, { adapter: 'mcp' }).target.fileKey, 'FILEA');
});

test('Section Fit preserves every child absolute position and verifies complete geometry', async () => {
  const live = runtime();
  const before = live.snapshot();
  const result = await executeSectionFit({ sectionId: '1:1', pad: 64 }, {
    evaluate: evaluate(live.figma),
  });
  assert.equal(result.result.outcome, 'verified');
  assert.equal(result.result.attempted, 1);
  assert.equal(result.stdout, '✓ Fitted "Components" to 388×388');
  const after = live.snapshot();
  assert.deepEqual(after.section, { x: 116, y: 196, width: 388, height: 388 });
  before.children.forEach((child, index) => {
    assert.equal(before.section.x + child.x, after.section.x + after.children[index].x);
    assert.equal(before.section.y + child.y, after.section.y + after.children[index].y);
  });
});

test('empty and already fitted Sections are verified no-ops', async () => {
  const empty = runtime({ childCount: 0 });
  const emptyResult = await executeSectionFit({ sectionId: '1:1' }, {
    evaluate: evaluate(empty.figma),
  });
  assert.equal(emptyResult.result.outcome, 'no-mutation');
  assert.equal(emptyResult.result.attempted, 0);
  assert.equal(empty.writes(), 0);
  assert.equal(emptyResult.stdout, '⚠ Section "Components" is empty — nothing to fit');

  const fitted = runtime();
  await executeSectionFit({ sectionId: '1:1' }, { evaluate: evaluate(fitted.figma) });
  const writes = fitted.writes();
  const second = await executeSectionFit({ sectionId: '1:1' }, {
    evaluate: evaluate(fitted.figma),
  });
  assert.equal(second.result.outcome, 'no-mutation');
  assert.equal(second.result.attempted, 0);
  assert.equal(fitted.writes(), writes);
});

test('a thrown native acknowledgement succeeds only after complete fresh readback', async () => {
  const live = runtime({ mode: 'throw-after' });
  const result = await executeSectionFit({ sectionId: '1:1' }, {
    evaluate: evaluate(live.figma),
  });
  assert.equal(result.result.outcome, 'verified-after-error');
  assert.equal(result.result.warnings.length, 1);
  assert.match(result.stderr, /injected native acknowledgement/);
});

test('no-effect, rollback, residue, and unavailable verification stay distinct', async () => {
  const unchanged = runtime({ mode: 'no-effect' });
  await assert.rejects(() => executeSectionFit({ sectionId: '1:1' }, {
    evaluate: evaluate(unchanged.figma),
  }), (error) => error.mutationOutcome === 'unchanged'
    && error.mutationReport.residueCount === 1);
  assert.deepEqual(unchanged.snapshot(), {
    section: INITIAL_SECTION, children: INITIAL_CHILDREN,
  });

  const rolledBack = runtime({ mode: 'partial' });
  await assert.rejects(() => executeSectionFit({ sectionId: '1:1' }, {
    evaluate: evaluate(rolledBack.figma),
  }), (error) => error.mutationOutcome === 'rolled-back'
    && error.mutationReport.restored === 1);
  assert.deepEqual(rolledBack.snapshot(), {
    section: INITIAL_SECTION, children: INITIAL_CHILDREN,
  });

  const residue = runtime({ mode: 'partial', rollbackMode: 'no-effect' });
  await assert.rejects(() => executeSectionFit({ sectionId: '1:1' }, {
    evaluate: evaluate(residue.figma),
  }), (error) => error.mutationOutcome === 'partial-residue'
    && error.mutationReport.residueCount > 0);

  const unavailable = runtime({ mode: 'partial', getFailures: [5] });
  await assert.rejects(() => executeSectionFit({ sectionId: '1:1' }, {
    evaluate: evaluate(unavailable.figma),
  }), (error) => error.mutationOutcome === 'verification-unavailable'
    && error.mutationReport.residueCount === 1);
});

test('invalid or excessive child facts refuse before geometry mutation', async () => {
  const malformed = runtime();
  Object.defineProperty(malformed.section.children[0], 'id', { value: 'not-a-node' });
  await assert.rejects(() => executeSectionFit({ sectionId: '1:1' }, {
    evaluate: evaluate(malformed.figma),
  }), (error) => error.mutationOutcome === 'no-mutation');
  assert.equal(malformed.writes(), 0);

  const excessive = runtime({ childCount: MAX_SECTION_FIT_CHILDREN + 1 });
  await assert.rejects(() => executeSectionFit({ sectionId: '1:1' }, {
    evaluate: evaluate(excessive.figma),
  }), (error) => error.mutationOutcome === 'no-mutation');
  assert.equal(excessive.writes(), 0);
});

test('one non-retrying Section Fit Plan owns identical CLI and MCP policy', async () => {
  const cli = planFigmaCommand(['section', 'fit', '1-1', '--pad=32'], { adapter: 'cli' });
  const mcp = planFigmaCommand(['section', 'fit', '--pad', '32', '1:1'], { adapter: 'mcp' });
  assert.equal(cli.allowed, true);
  assert.deepEqual(cli.argv, mcp.argv);
  assert.deepEqual(cli.effects, mcp.effects);
  assert.deepEqual(cli.execution, mcp.execution);
  assert.equal(cli.effects.figma, 'write');
  assert.equal(cli.effects.editor, 'none');
  assert.equal(cli.execution.retry, 'never');
  assert.equal(sectionFitPlanRoute(cli), 'command-application');
  const live = runtime();
  assert.equal((await executeSectionFitPlan(cli, {
    evaluate: evaluate(live.figma),
  })).result.status, 'fitted');
  assert.equal(sectionFitPlanRoute(
    planFigmaCommand(['section', 'list'], { adapter: 'mcp' }),
  ), 'not-section-fit');
});

test('malformed Plugin results cannot become successful Section Fits', async () => {
  for (const value of [null, {}, 'not-json', JSON.stringify({ status: 'fitted' })]) {
    await assert.rejects(() => executeSectionFit({ sectionId: '1:1' }, {
      evaluate: async () => value,
    }), /invalid/i);
  }
});

test('host validation rejects forged complete-geometry success claims', async () => {
  const live = runtime();
  const serialized = await evaluate(live.figma)(sectionFitCode({ sectionId: '1:1', pad: 64 }));
  const payload = JSON.parse(serialized);
  const forgedActual = structuredClone(payload.actual);
  forgedActual.children[0].x += 8;
  for (const forged of [
    { ...payload, actual: forgedActual },
    { ...payload, residueCount: 1 },
    { ...payload, outcome: 'verified', warnings: ['unearned warning'] },
    { ...payload, futureField: 'private' },
  ]) {
    await assert.rejects(() => executeSectionFit({ sectionId: '1:1', pad: 64 }, {
      evaluate: async () => JSON.stringify(forged),
    }), /invalid bounded result/);
  }
});

test('Section Fit generated Plugin code parses', () => {
  assert.doesNotThrow(() => new Function(
    `return ${sectionFitCode({ sectionId: '1:1', pad: 64 })}`));
});
