import assert from 'node:assert/strict';
import test from 'node:test';
import { planFigmaCommand } from '../../src/capability-catalog.js';
import {
  executeJamArrange,
  executeJamArrangePlan,
  jamArrangeCode,
  jamArrangePlanRoute,
} from '../src/application/jam-arrange-command.js';
import {
  acceptsJamArrangeArgv,
  jamArrangeArgvFromRequest,
  parseJamArrangeRequest,
} from '../src/application/jam-arrange-request.js';

const INITIAL = Object.freeze([
  Object.freeze({ id: '1:1', type: 'SHAPE_WITH_TEXT', x: 300, y: 100, width: 100, height: 50 }),
  Object.freeze({ id: '1:2', type: 'CONNECTOR', x: 0, y: 0, width: 20, height: 20 }),
  Object.freeze({ id: '1:3', type: 'STICKY', x: 20, y: 20, width: 80, height: 40 }),
  Object.freeze({ id: '1:4', type: 'TABLE', x: 200, y: 200, width: 60, height: 80 }),
]);

function runtime({ mode = 'normal', rollbackMode = 'normal', editorType = 'figjam' } = {}) {
  const states = INITIAL.map((item) => ({ ...item }));
  let phase = 'forward';
  let writes = 0;
  const page = { id: '0:1', type: 'PAGE', children: [], selection: [] };
  const behavior = () => (phase === 'rollback' ? rollbackMode : mode);
  const nodes = states.map((state, index) => ({
    get id() { return state.id; },
    get type() { return state.type; },
    get parent() { return page; },
    get x() { return state.x; },
    set x(value) {
      writes += 1;
      if (value === INITIAL[index].x && state.x !== value) phase = 'rollback';
      if (behavior() !== 'no-effect') state.x = value;
    },
    get y() { return state.y; },
    set y(value) {
      writes += 1;
      const active = behavior();
      if (active !== 'no-effect' && !(active === 'partial' && index === 3)) state.y = value;
      if (active === 'throw-after' && index === 3) throw new Error('injected acknowledgement');
    },
    get width() { return state.width; },
    get height() { return state.height; },
  }));
  page.children = nodes;
  page.selection = [...nodes];
  return {
    figma: {
      editorType,
      currentPage: page,
      async getNodeByIdAsync(id) { return nodes.find((node) => node.id === id) || null; },
    },
    page,
    nodes,
    writes: () => writes,
    snapshot: () => states.map((state) => ({ ...state })),
  };
}

const evaluate = (figma) => async (code) => new Function('figma', `return ${code};`)(figma);

test('Jam Arrange closes and canonicalizes selection, ids, and page scopes', () => {
  assert.deepEqual(parseJamArrangeRequest([
    'jam', 'arrange', '--gap=-20', '--columns', '3', '--ids', '1-1, 1:3',
  ]), {
    columns: 3, gap: -20, ids: ['1:1', '1:3'], all: false, scope: 'ids',
  });
  assert.deepEqual(jamArrangeArgvFromRequest({}), ['jam', 'arrange']);
  assert.deepEqual(jamArrangeArgvFromRequest({ columns: 2, gap: 0, all: true }), [
    'jam', 'arrange', '--columns=2', '--gap=0', '--all',
  ]);
  for (const argv of [
    ['jam', 'arrange', 'payload'],
    ['jam', 'arrange', '--columns=0'],
    ['jam', 'arrange', '--columns=1.5'],
    ['jam', 'arrange', '--gap=Infinity'],
    ['jam', 'arrange', '--ids='],
    ['jam', 'arrange', '--ids=1:1,1-1'],
    ['jam', 'arrange', '--ids=1:1', '--all'],
    ['jam', 'arrange', '--all', '--all'],
    ['jam', 'arrange', '--future'],
  ]) assert.equal(acceptsJamArrangeArgv(argv), false, argv.join(' '));
});

test('Jam Arrange preserves candidate order, ignores connectors, and verifies grid geometry', async () => {
  const live = runtime();
  const result = await executeJamArrange({ columns: 2, gap: 10 }, {
    evaluate: evaluate(live.figma),
  });
  assert.equal(result.result.status, 'arranged');
  assert.equal(result.result.outcome, 'verified');
  assert.equal(result.result.moved, 3);
  assert.equal(result.result.ignored, 1);
  assert.equal(result.stdout, '✓ 3 node(s) arranged (selection)');
  assert.deepEqual(live.snapshot(), [
    { ...INITIAL[0], x: 20, y: 20 },
    INITIAL[1],
    { ...INITIAL[2], x: 130, y: 20 },
    { ...INITIAL[3], x: 20, y: 110 },
  ]);
});

test('explicit ids and page scope retain legacy scope semantics', async () => {
  const byIds = runtime();
  const explicit = await executeJamArrange({ ids: ['1:4', '1:1'], columns: 1, gap: 5 }, {
    evaluate: evaluate(byIds.figma),
  });
  assert.equal(explicit.result.scope, 'ids');
  assert.deepEqual(byIds.snapshot().filter((node) => ['1:1', '1:4'].includes(node.id))
    .map(({ id, x, y }) => ({ id, x, y })), [
    { id: '1:1', x: 200, y: 185 },
    { id: '1:4', x: 200, y: 100 },
  ]);

  const all = runtime();
  all.page.selection = [];
  const page = await executeJamArrange({ all: true }, { evaluate: evaluate(all.figma) });
  assert.equal(page.result.scope, 'page');
  assert.equal(page.result.moved, 3);
});

test('empty, ignored-only, and already-arranged scopes are verified no-ops', async () => {
  const empty = runtime();
  empty.page.selection = [];
  const emptyResult = await executeJamArrange({}, { evaluate: evaluate(empty.figma) });
  assert.equal(emptyResult.result.outcome, 'no-mutation');
  assert.equal(emptyResult.stdout, '✓ Nothing to arrange (selection)');
  assert.equal(empty.writes(), 0);

  const ignored = runtime();
  ignored.page.selection = [ignored.nodes[1]];
  const ignoredResult = await executeJamArrange({}, { evaluate: evaluate(ignored.figma) });
  assert.equal(ignoredResult.result.moved, 0);
  assert.equal(ignoredResult.result.ignored, 1);
  assert.equal(ignored.writes(), 0);

  const arranged = runtime();
  const request = { columns: 2, gap: 10 };
  await executeJamArrange(request, { evaluate: evaluate(arranged.figma) });
  const writes = arranged.writes();
  const second = await executeJamArrange(request, { evaluate: evaluate(arranged.figma) });
  assert.equal(second.result.outcome, 'no-mutation');
  assert.equal(arranged.writes(), writes);
});

test('acknowledgement errors, no effect, rollback, and residue stay distinct', async () => {
  const acknowledged = runtime({ mode: 'throw-after' });
  const success = await executeJamArrange({ columns: 2, gap: 10 }, {
    evaluate: evaluate(acknowledged.figma),
  });
  assert.equal(success.result.outcome, 'verified-after-error');
  assert.match(success.stderr, /fresh FigJam readback/);

  const unchanged = runtime({ mode: 'no-effect' });
  await assert.rejects(() => executeJamArrange({ columns: 2, gap: 10 }, {
    evaluate: evaluate(unchanged.figma),
  }), (error) => error.mutationOutcome === 'unchanged'
    && error.mutationReport.residueCount === 0);

  const rolledBack = runtime({ mode: 'partial' });
  await assert.rejects(() => executeJamArrange({ columns: 2, gap: 10 }, {
    evaluate: evaluate(rolledBack.figma),
  }), (error) => error.mutationOutcome === 'rolled-back'
    && error.mutationReport.restored > 0);
  assert.deepEqual(rolledBack.snapshot(), INITIAL);

  const residue = runtime({ mode: 'partial', rollbackMode: 'no-effect' });
  await assert.rejects(() => executeJamArrange({ columns: 2, gap: 10 }, {
    evaluate: evaluate(residue.figma),
  }), (error) => error.mutationOutcome === 'partial-residue'
    && error.mutationReport.residueCount > 0);
});

test('wrong editor and missing explicit targets refuse before mutation', async () => {
  const wrong = runtime({ editorType: 'figma' });
  await assert.rejects(() => executeJamArrange({}, { evaluate: evaluate(wrong.figma) }),
    (error) => error.mutationOutcome === 'no-mutation');
  assert.equal(wrong.writes(), 0);

  const missing = runtime();
  await assert.rejects(() => executeJamArrange({ ids: ['9:9'] }, {
    evaluate: evaluate(missing.figma),
  }), (error) => error.mutationOutcome === 'no-mutation');
  assert.equal(missing.writes(), 0);

  const malformedIgnored = runtime();
  malformedIgnored.page.selection = [{
    id: '1:9', type: 'CONNECTOR', parent: null,
    x: 0, y: 0, width: 10, height: 10,
  }];
  await assert.rejects(() => executeJamArrange({}, {
    evaluate: evaluate(malformedIgnored.figma),
  }), (error) => error.mutationOutcome === 'no-mutation');
  assert.equal(malformedIgnored.writes(), 0);
});

test('one non-retrying Jam Arrange Plan owns identical CLI and MCP policy', async () => {
  const cli = planFigmaCommand([
    'jam', 'arrange', '--columns=2', '--gap=10', '--ids=1-1,1:3',
  ], { adapter: 'cli' });
  const mcp = planFigmaCommand([
    'jam', 'arrange', '--ids', '1:1 1-3', '--gap', '10', '--columns', '2',
  ], { adapter: 'mcp' });
  assert.equal(cli.allowed, true);
  assert.deepEqual(cli.argv, mcp.argv);
  assert.deepEqual(cli.effects, mcp.effects);
  assert.deepEqual(cli.execution, mcp.execution);
  assert.equal(cli.effects.figma, 'write');
  assert.equal(cli.effects.editor, 'read');
  assert.equal(cli.execution.retry, 'never');
  assert.equal(jamArrangePlanRoute(cli), 'command-application');
  const live = runtime();
  assert.equal((await executeJamArrangePlan(cli, {
    evaluate: evaluate(live.figma),
  })).result.status, 'arranged');
});

test('malformed and forged Plugin results cannot become successful Jam Arranges', async () => {
  for (const value of [null, {}, 'not-json', JSON.stringify({ status: 'arranged' })]) {
    await assert.rejects(() => executeJamArrange({}, { evaluate: async () => value }), /invalid/i);
  }
  const live = runtime();
  const serialized = await evaluate(live.figma)(jamArrangeCode({ columns: 2, gap: 10 }));
  const forged = JSON.parse(serialized);
  forged.actual.nodes[0].x += 8;
  await assert.rejects(() => executeJamArrange({ columns: 2, gap: 10 }, {
    evaluate: async () => JSON.stringify(forged),
  }), /invalid bounded result/);
});

test('Jam Arrange generated Plugin code parses', () => {
  assert.doesNotThrow(() => new Function(`return ${jamArrangeCode({})}`));
});
