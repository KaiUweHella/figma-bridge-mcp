import assert from 'node:assert/strict';
import test from 'node:test';
import { planFigmaCommand } from '../../src/capability-catalog.js';
import {
  executeJamStickies,
  executeJamStickiesPlan,
  jamStickiesCode,
  jamStickiesPlanRoute,
} from '../src/application/jam-stickies-command.js';
import {
  acceptsJamStickiesArgv,
  jamStickiesArgvFromRequest,
  parseJamStickiesRequest,
} from '../src/application/jam-stickies-request.js';

function runtime({
  editorType = 'figjam', wrongPositionAt = 0, removeNoEffect = false,
  throwAfterSelection = false, factoryThrowsAt = 0, switchPageDuringFontLoad = false,
} = {}) {
  const registry = new Map();
  let selection = [];
  const page = {
    id: '0:1', type: 'PAGE', children: [],
    get selection() { return selection; },
    set selection(value) {
      selection = value;
      if (throwAfterSelection && value.some((node) => node.id?.startsWith('9:'))) {
        throw new Error('injected acknowledgement');
      }
    },
  };
  const existing = [
    { id: '1:1', type: 'SHAPE_WITH_TEXT', x: 10, y: 40, width: 50, height: 20, parent: page },
    { id: '1:2', type: 'STICKY', x: 200, y: -10, width: 30, height: 40, parent: page },
  ];
  page.children.push(...existing);
  selection = [existing[0]];
  const otherPage = { id: '0:2', type: 'PAGE', children: [], selection: [] };
  registry.set(page.id, page);
  registry.set(otherPage.id, otherPage);
  for (const node of existing) registry.set(node.id, node);
  let creates = 0;
  let fontLoads = 0;
  const figma = {
    editorType, currentPage: page, mixed: Symbol('mixed'),
    async loadFontAsync() {
      fontLoads += 1;
      if (switchPageDuringFontLoad) this.currentPage = otherPage;
    },
    async getNodeByIdAsync(id) { return registry.get(id) || null; },
    createSticky() {
      creates += 1;
      let x = 0; let y = 0;
      const text = { characters: '', fontName: { family: 'Inter', style: 'Medium' } };
      const node = {
        id: `9:${creates}`, type: 'STICKY', parent: page, text,
        fills: [{ type: 'SOLID', color: { r: 1, g: 1, b: 0 } }],
        width: 100 + creates * 10, height: 80 + creates * 5,
        get x() { return x; },
        set x(value) { x = wrongPositionAt === creates ? value + 1 : value; },
        get y() { return y; },
        set y(value) { y = value; },
        remove() {
          if (removeNoEffect) return;
          const index = page.children.indexOf(this);
          if (index !== -1) page.children.splice(index, 1);
          registry.delete(this.id); this.parent = null;
        },
      };
      page.children.push(node); registry.set(node.id, node);
      if (factoryThrowsAt === creates) throw new Error('injected factory failure');
      return node;
    },
  };
  return {
    figma, page, otherPage, existing,
    creates: () => creates,
    fontLoads: () => fontLoads,
  };
}

const evaluate = (figma) => async (code) => new Function('figma', `return ${code};`)(figma);

test('Jam Stickies closes JSON and delimited sources while preserving legacy normalization', () => {
  assert.deepEqual(parseJamStickiesRequest([
    'jam', 'stickies', ' First\nSecond ; ; Third ', '--color=green', '--columns=3rest',
  ]), {
    items: [
      { text: 'First', color: '#A8E6A1' },
      { text: 'Second', color: '#A8E6A1' },
      { text: 'Third', color: '#A8E6A1' },
    ],
    columns: 3, x: null, y: null,
  });
  assert.deepEqual(parseJamStickiesRequest([
    'jam', 'stickies', '["Raw",{"text":"Own","color":"red"},42,{"color":"bad"}]',
    '--color=blue', '--at=10px,-20.5rest',
  ]), {
    items: [
      { text: 'Raw', color: '#A6D8FF' },
      { text: 'Own', color: '#FF9B9B' },
      { text: '', color: '#A6D8FF' },
      { text: '', color: null },
    ],
    columns: 4, x: 10, y: -20.5,
  });
  assert.deepEqual(jamStickiesArgvFromRequest({
    items: ['One', { text: 'Two', color: '#ff00aa' }], columns: -2, x: 0, y: 10,
  }), [
    'jam', 'stickies', '--columns=1', '--at=0,10', '--',
    '[{"text":"One","color":null},{"text":"Two","color":"#FF00AA"}]',
  ]);
  for (const argv of [
    ['jam', 'stickies'],
    ['jam', 'stickies', ''],
    ['jam', 'stickies', '[]'],
    ['jam', 'stickies', '['],
    ['jam', 'stickies', 'one', 'two'],
    ['jam', 'stickies', 'one', '--color'],
    ['jam', 'stickies', 'one', '--future'],
    ['jam', 'stickies', 'one', '--columns=2', '--columns=3'],
  ]) assert.equal(acceptsJamStickiesArgv(argv), false, argv.join(' '));
});

test('Jam Stickies creates one verified native batch with legacy per-node grid geometry', async () => {
  const live = runtime();
  const result = await executeJamStickies({
    items: [
      { text: 'One', color: 'blue' },
      { text: 'Two', color: null },
      { text: 'Three', color: '#ff00aa' },
    ],
    columns: 2,
  }, { evaluate: evaluate(live.figma) });
  assert.equal(result.result.status, 'created');
  assert.equal(result.result.outcome, 'verified');
  assert.equal(result.result.attempted, 3);
  assert.equal(result.stdout, '✓ 3 stickies added');
  assert.deepEqual(result.result.actual.nodes.map(({ text, color, x, y }) => ({ text, color, x, y })), [
    { text: 'One', color: '#A6D8FF', x: 310, y: -10 },
    { text: 'Two', color: null, x: 454, y: -10 },
    { text: 'Three', color: '#FF00AA', x: 310, y: 109 },
  ]);
  assert.deepEqual(live.page.selection.map((node) => node.id), ['9:1', '9:2', '9:3']);
  assert.equal(live.fontLoads(), 2);
  assert.deepEqual(live.page.children[3].fills, [{
    type: 'SOLID', color: { r: 1, g: 1, b: 0 },
  }]);
});

test('acknowledgement errors require exact whole-batch readback', async () => {
  const live = runtime({ throwAfterSelection: true });
  const result = await executeJamStickies({ items: ['One', 'Two'] }, {
    evaluate: evaluate(live.figma),
  });
  assert.equal(result.result.outcome, 'verified-after-error');
  assert.match(result.stderr, /fresh FigJam readback/);
});

test('partial batch failure rolls every attributed Sticky back in reverse', async () => {
  const rollback = runtime({ wrongPositionAt: 2 });
  await assert.rejects(() => executeJamStickies({ items: ['One', 'Two', 'Three'] }, {
    evaluate: evaluate(rollback.figma),
  }), (error) => error.mutationOutcome === 'rolled-back'
    && error.mutationReport.attempted === 3
    && error.mutationReport.restored === 3);
  assert.deepEqual(rollback.page.children.map((node) => node.id), ['1:1', '1:2']);
  assert.deepEqual(rollback.page.selection.map((node) => node.id), ['1:1']);

  const residue = runtime({ wrongPositionAt: 2, removeNoEffect: true });
  await assert.rejects(() => executeJamStickies({ items: ['One', 'Two'] }, {
    evaluate: evaluate(residue.figma),
  }), (error) => error.mutationOutcome === 'partial-residue'
    && error.mutationReport.residueCount > 0);
});

test('page switching cannot redirect later factories or selection writes', async () => {
  const live = runtime({ switchPageDuringFontLoad: true });
  await assert.rejects(() => executeJamStickies({ items: ['One', 'Two'] }, {
    evaluate: evaluate(live.figma),
  }), (error) => error.mutationOutcome === 'rolled-back'
    && error.mutationReport.attempted === 1);
  assert.equal(live.creates(), 1);
  assert.deepEqual(live.page.children.map((node) => node.id), ['1:1', '1:2']);
  assert.deepEqual(live.page.selection.map((node) => node.id), ['1:1']);
  assert.deepEqual(live.otherPage.children, []);
  assert.deepEqual(live.otherPage.selection, []);
});

test('wrong editor refuses while an unattributed factory failure stays explicit', async () => {
  const wrong = runtime({ editorType: 'figma' });
  await assert.rejects(() => executeJamStickies({ items: ['No'] }, {
    evaluate: evaluate(wrong.figma),
  }), (error) => error.mutationOutcome === 'no-mutation');
  assert.equal(wrong.creates(), 0);

  const factory = runtime({ factoryThrowsAt: 2 });
  await assert.rejects(() => executeJamStickies({ items: ['One', 'Unknown'] }, {
    evaluate: evaluate(factory.figma),
  }), (error) => error.mutationOutcome === 'verification-unavailable'
    && error.mutationReport.attempted === 2);
});

test('an oversized preflight snapshot refuses before creating a Sticky', async () => {
  const live = runtime();
  live.page.children = Array.from({ length: 1_500 }, (_, index) => ({
    id: `2:${String(index).padStart(4, '0')}${'9'.repeat(495)}`,
  }));
  await assert.rejects(() => executeJamStickies({ items: ['Bounded'], x: 0, y: 0 }, {
    evaluate: evaluate(live.figma),
  }), (error) => error.mutationOutcome === 'no-mutation'
    && /preflight snapshot exceeded/.test(error.message));
  assert.equal(live.creates(), 0);
});

test('one non-retrying Jam Stickies Plan owns identical CLI and MCP policy', async () => {
  const cli = planFigmaCommand([
    'jam', 'stickies', '--color=green', '--columns=2', '--', 'One;Two',
  ], { adapter: 'cli' });
  const mcp = planFigmaCommand([
    'jam', 'stickies', '--columns', '2', '--',
    '[{"text":"One","color":"#A8E6A1"},{"text":"Two","color":"green"}]',
  ], { adapter: 'mcp' });
  assert.equal(cli.allowed, true);
  assert.deepEqual(cli.argv, mcp.argv);
  assert.deepEqual(cli.effects, mcp.effects);
  assert.deepEqual(cli.execution, mcp.execution);
  assert.equal(cli.effects.figma, 'write');
  assert.equal(cli.effects.editor, 'write');
  assert.equal(cli.execution.retry, 'never');
  assert.equal(jamStickiesPlanRoute(cli), 'command-application');
  const live = runtime();
  assert.equal((await executeJamStickiesPlan(cli, {
    evaluate: evaluate(live.figma),
  })).result.status, 'created');
});

test('malformed and forged Plugin results cannot become successful Jam Stickies batches', async () => {
  for (const value of [null, {}, 'not-json', JSON.stringify({ status: 'created' })]) {
    await assert.rejects(() => executeJamStickies({ items: ['Safe'] }, {
      evaluate: async () => value,
    }), /invalid/i);
  }
  const live = runtime();
  const serialized = await evaluate(live.figma)(jamStickiesCode({ items: ['Safe'] }));
  const forged = JSON.parse(serialized);
  forged.actual.nodes[0].x += 8;
  await assert.rejects(() => executeJamStickies({ items: ['Safe'] }, {
    evaluate: async () => JSON.stringify(forged),
  }), /invalid bounded result/);
});

test('Jam Stickies generated Plugin code parses with hostile item text inert', () => {
  const text = '`; figma.currentPage.remove(); //';
  const code = jamStickiesCode({ items: [text] });
  assert.doesNotThrow(() => new Function(`return ${code}`));
  assert.ok(code.includes(JSON.stringify(text)));
});
