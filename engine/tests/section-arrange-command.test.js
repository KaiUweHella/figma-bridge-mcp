import assert from 'node:assert/strict';
import test from 'node:test';
import { planFigmaCommand } from '../../src/capability-catalog.js';
import {
  executeSectionArrange,
  executeSectionArrangePlan,
  MAX_SECTION_ARRANGE_CHILDREN,
  sectionArrangeCode,
  sectionArrangePlanRoute,
  sectionArrangePlanningArgvFromRequest,
} from '../src/application/section-arrange-command.js';
import {
  acceptsSectionArrangeArgv,
  parseSectionArrangeRequest,
  sectionArrangeArgvFromRequest,
  sectionArrangeFigmaUrlFileKeyFromArgv,
} from '../src/application/section-arrange-request.js';

const INITIAL_SECTION = Object.freeze({ x: 100, y: 200, width: 600, height: 600 });
const INITIAL_CHILDREN = Object.freeze([
  Object.freeze({ id: '1:2', name: 'Zebra', type: 'FRAME', x: 300, y: 200, width: 100, height: 50 }),
  Object.freeze({ id: '1:3', name: 'Button', type: 'COMPONENT', x: 20, y: 20, width: 80, height: 40 }),
  Object.freeze({ id: '1:4', name: 'Buttons', type: 'COMPONENT_SET', x: 200, y: 20, width: 160, height: 80 }),
  Object.freeze({ id: '1:5', name: 'Alpha', type: 'TEXT', x: 10, y: 400, width: 60, height: 30 }),
]);

function runtime({
  childCount = 4,
  mode = 'normal',
  rollbackMode = 'normal',
  getFailures = [],
} = {}) {
  const sectionState = { ...INITIAL_SECTION };
  const childStates = Array.from({ length: childCount }, (_, index) => ({
    ...(INITIAL_CHILDREN[index] || {
      id: `${index + 2}:1`, name: `Child ${index}`, type: 'FRAME',
      x: index * 2, y: index * 3, width: 10, height: 10,
    }),
  }));
  let phase = 'forward';
  let writes = 0;
  let gets = 0;
  const behavior = () => (phase === 'rollback' ? rollbackMode : mode);
  const assign = (target, field, value) => {
    writes += 1;
    if (behavior() === 'no-effect') return;
    target[field] = value;
  };
  const children = childStates.map((state, index) => ({
    get id() { return state.id; },
    get name() { return state.name; },
    get type() { return state.type; },
    get x() { return state.x; },
    set x(value) {
      if (index === 0) phase = value === INITIAL_CHILDREN[0]?.x ? 'rollback' : 'forward';
      assign(state, 'x', value);
    },
    get y() { return state.y; },
    set y(value) { assign(state, 'y', value); },
    get width() { return state.width; },
    get height() { return state.height; },
  }));
  const section = {
    id: '1:1', name: 'Components', type: 'SECTION', children,
    get x() { return sectionState.x; },
    get y() { return sectionState.y; },
    get width() { return sectionState.width; },
    get height() { return sectionState.height; },
    resizeWithoutConstraints(width, height) {
      writes += 1;
      if (behavior() !== 'no-effect' && behavior() !== 'partial') {
        sectionState.width = width;
        sectionState.height = height;
      }
      if (behavior() === 'throw-after') throw new Error('injected native acknowledgement');
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

test('Section Arrange closes options, canonical defaults, and URL identity', () => {
  assert.deepEqual(parseSectionArrangeRequest([
    'section', 'arrange', '--group-rows', '-c2', '--gap=0', '--pad', '20', '1-1',
  ]), { sectionId: '1:1', cols: 2, gap: 0, pad: 20, groupRows: true });
  assert.deepEqual(sectionArrangeArgvFromRequest({ sectionId: '1-1' }),
    ['section', 'arrange', '1:1']);
  assert.deepEqual(sectionArrangeArgvFromRequest({
    sectionId: '1:1', cols: 2, gap: 10, pad: 20, groupRows: true,
  }), ['section', 'arrange', '1:1', '--cols=2', '--gap=10', '--pad=20', '--group-rows']);
  for (const argv of [
    ['section', 'arrange'],
    ['section', 'arrange', '1:1', '1:2'],
    ['section', 'arrange', '1:1', '--cols=0'],
    ['section', 'arrange', '1:1', '--cols=1.5'],
    ['section', 'arrange', '1:1', '--gap=-1'],
    ['section', 'arrange', '1:1', '--pad='],
    ['section', 'arrange', '1:1', '--group-rows', '--group-rows'],
    ['section', 'arrange', '1:1', '--future'],
  ]) assert.equal(acceptsSectionArrangeArgv(argv), false, argv.join(' '));

  const url = 'https://www.figma.com/design/FILEA/Test?node-id=1-1';
  const planning = sectionArrangePlanningArgvFromRequest({ sectionId: url, cols: 2 });
  assert.equal(sectionArrangeFigmaUrlFileKeyFromArgv(planning), 'FILEA');
  assert.equal(planFigmaCommand(planning, { adapter: 'mcp' }).target.fileKey, 'FILEA');
});

test('Section Arrange reproduces reading-order grid geometry and verifies every child', async () => {
  const live = runtime();
  const result = await executeSectionArrange({
    sectionId: '1:1', cols: 2, gap: 10, pad: 20,
  }, { evaluate: evaluate(live.figma) });
  assert.equal(result.result.outcome, 'verified');
  assert.equal(result.stdout, '✓ Arranged 4 children in "Components" (290×220)');
  assert.deepEqual(live.snapshot(), {
    section: { x: 100, y: 200, width: 290, height: 220 },
    children: [
      { ...INITIAL_CHILDREN[0], x: 20, y: 150 },
      { ...INITIAL_CHILDREN[1], x: 20, y: 60 },
      { ...INITIAL_CHILDREN[2], x: 110, y: 60 },
      { ...INITIAL_CHILDREN[3], x: 130, y: 150 },
    ],
  });
});

test('group rows use deterministic type ranks and one row per node type', async () => {
  const live = runtime();
  const result = await executeSectionArrange({
    sectionId: '1:1', cols: 4, gap: 10, pad: 20, groupRows: true,
  }, { evaluate: evaluate(live.figma) });
  assert.equal(result.result.actual.section.width, 200);
  assert.equal(result.result.actual.section.height, 310);
  assert.deepEqual(live.snapshot().children.map(({ type, x, y }) => ({ type, x, y })), [
    { type: 'FRAME', x: 20, y: 200 },
    { type: 'COMPONENT', x: 20, y: 150 },
    { type: 'COMPONENT_SET', x: 20, y: 60 },
    { type: 'TEXT', x: 20, y: 260 },
  ]);
});

test('empty and already arranged Sections are verified no-ops', async () => {
  const empty = runtime({ childCount: 0 });
  const emptyResult = await executeSectionArrange({ sectionId: '1:1' }, {
    evaluate: evaluate(empty.figma),
  });
  assert.equal(emptyResult.result.outcome, 'no-mutation');
  assert.equal(emptyResult.result.attempted, 0);
  assert.equal(empty.writes(), 0);
  assert.equal(emptyResult.stdout, '⚠ Section "Components" is empty — nothing to arrange');

  const arranged = runtime();
  const request = { sectionId: '1:1', cols: 2, gap: 10, pad: 20 };
  await executeSectionArrange(request, { evaluate: evaluate(arranged.figma) });
  const writes = arranged.writes();
  const second = await executeSectionArrange(request, { evaluate: evaluate(arranged.figma) });
  assert.equal(second.result.outcome, 'no-mutation');
  assert.equal(arranged.writes(), writes);
});

test('native acknowledgement errors require complete fresh geometry', async () => {
  const live = runtime({ mode: 'throw-after' });
  const result = await executeSectionArrange({ sectionId: '1:1' }, {
    evaluate: evaluate(live.figma),
  });
  assert.equal(result.result.outcome, 'verified-after-error');
  assert.match(result.stderr, /injected native acknowledgement/);
});

test('no-effect, rollback, residue, and unavailable verification stay distinct', async () => {
  const unchanged = runtime({ mode: 'no-effect' });
  await assert.rejects(() => executeSectionArrange({ sectionId: '1:1' }, {
    evaluate: evaluate(unchanged.figma),
  }), (error) => error.mutationOutcome === 'unchanged');

  const rolledBack = runtime({ mode: 'partial' });
  await assert.rejects(() => executeSectionArrange({ sectionId: '1:1' }, {
    evaluate: evaluate(rolledBack.figma),
  }), (error) => error.mutationOutcome === 'rolled-back'
    && error.mutationReport.restored === 1);
  assert.deepEqual(rolledBack.snapshot(), {
    section: INITIAL_SECTION, children: INITIAL_CHILDREN,
  });

  const residue = runtime({ mode: 'partial', rollbackMode: 'no-effect' });
  await assert.rejects(() => executeSectionArrange({ sectionId: '1:1' }, {
    evaluate: evaluate(residue.figma),
  }), (error) => error.mutationOutcome === 'partial-residue'
    && error.mutationReport.residueCount > 0);

  const unavailable = runtime({ mode: 'partial', getFailures: [5] });
  await assert.rejects(() => executeSectionArrange({ sectionId: '1:1' }, {
    evaluate: evaluate(unavailable.figma),
  }), (error) => error.mutationOutcome === 'verification-unavailable');
});

test('invalid or excessive child facts refuse before geometry mutation', async () => {
  const malformed = runtime();
  Object.defineProperty(malformed.section.children[0], 'name', { value: 42 });
  await assert.rejects(() => executeSectionArrange({ sectionId: '1:1' }, {
    evaluate: evaluate(malformed.figma),
  }), (error) => error.mutationOutcome === 'no-mutation');
  assert.equal(malformed.writes(), 0);

  const excessive = runtime({ childCount: MAX_SECTION_ARRANGE_CHILDREN + 1 });
  await assert.rejects(() => executeSectionArrange({ sectionId: '1:1' }, {
    evaluate: evaluate(excessive.figma),
  }), (error) => error.mutationOutcome === 'no-mutation');
  assert.equal(excessive.writes(), 0);
});

test('one non-retrying Section Arrange Plan owns identical CLI and MCP policy', async () => {
  const cli = planFigmaCommand([
    'section', 'arrange', '1-1', '--cols=2', '--gap=10', '--pad=20',
  ], { adapter: 'cli' });
  const mcp = planFigmaCommand([
    'section', 'arrange', '--pad', '20', '-g10', '-c2', '1:1',
  ], { adapter: 'mcp' });
  assert.equal(cli.allowed, true);
  assert.deepEqual(cli.argv, mcp.argv);
  assert.deepEqual(cli.effects, mcp.effects);
  assert.deepEqual(cli.execution, mcp.execution);
  assert.equal(cli.effects.figma, 'write');
  assert.equal(cli.effects.editor, 'none');
  assert.equal(cli.execution.retry, 'never');
  assert.equal(sectionArrangePlanRoute(cli), 'command-application');
  const live = runtime();
  assert.equal((await executeSectionArrangePlan(cli, {
    evaluate: evaluate(live.figma),
  })).result.status, 'arranged');
});

test('malformed and forged Plugin results cannot become successful Section Arranges', async () => {
  for (const value of [null, {}, 'not-json', JSON.stringify({ status: 'arranged' })]) {
    await assert.rejects(() => executeSectionArrange({ sectionId: '1:1' }, {
      evaluate: async () => value,
    }), /invalid/i);
  }
  const live = runtime();
  const serialized = await evaluate(live.figma)(sectionArrangeCode({ sectionId: '1:1' }));
  const payload = JSON.parse(serialized);
  const forged = structuredClone(payload);
  forged.actual.children[0].x += 8;
  await assert.rejects(() => executeSectionArrange({ sectionId: '1:1' }, {
    evaluate: async () => JSON.stringify(forged),
  }), /invalid bounded result/);
});

test('Section Arrange generated Plugin code parses', () => {
  assert.doesNotThrow(() => new Function(
    `return ${sectionArrangeCode({ sectionId: '1:1' })}`));
});
