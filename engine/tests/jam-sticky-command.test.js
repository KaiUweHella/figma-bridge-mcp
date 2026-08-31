import assert from 'node:assert/strict';
import test from 'node:test';
import { planFigmaCommand } from '../../src/capability-catalog.js';
import {
  executeJamSticky,
  executeJamStickyPlan,
  jamStickyCode,
  jamStickyPlanRoute,
} from '../src/application/jam-sticky-command.js';
import {
  acceptsJamStickyArgv,
  jamStickyArgvFromRequest,
  parseJamStickyRequest,
} from '../src/application/jam-sticky-request.js';

function runtime({
  editorType = 'figjam', wrongPosition = false, removeNoEffect = false,
  throwAfter = false, factoryThrows = false, switchPageDuringFontLoad = false,
} = {}) {
  const registry = new Map();
  let selection = [];
  const page = {
    id: '0:1', type: 'PAGE', children: [],
    get selection() { return selection; },
    set selection(value) {
      selection = value;
      if (throwAfter && value[0]?.id?.startsWith('9:')) throw new Error('injected acknowledgement');
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
        width: 240, height: 240,
        get x() { return x; },
        set x(value) { x = wrongPosition ? value + 1 : value; },
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
      if (factoryThrows) throw new Error('injected factory failure');
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

test('Jam Sticky closes text while preserving legacy color and placement fallback semantics', () => {
  assert.deepEqual(parseJamStickyRequest([
    'jam', 'sticky', '--color', 'green', '--at=10px, -20.5rest', '--', '- Decision',
  ]), { text: '- Decision', color: '#A8E6A1', x: 10, y: -20.5 });
  assert.deepEqual(parseJamStickyRequest([
    'jam', 'sticky', 'Idea', '--color=not-a-color', '--at=nonsense',
  ]), { text: 'Idea', color: null, x: null, y: null });
  assert.deepEqual(jamStickyArgvFromRequest({
    text: '- Decision', color: '#ff00aa', x: -10, y: 20,
  }), ['jam', 'sticky', '--color=#FF00AA', '--at=-10,20', '--', '- Decision']);
  for (const argv of [
    ['jam', 'sticky'],
    ['jam', 'sticky', 'one', 'two'],
    ['jam', 'sticky', 'one', '--color'],
    ['jam', 'sticky', 'one', '--at'],
    ['jam', 'sticky', 'one', '--color=red', '--color=blue'],
    ['jam', 'sticky', 'one', '--future'],
  ]) assert.equal(acceptsJamStickyArgv(argv), false, argv.join(' '));
});

test('Jam Sticky creates one native Sticky at legacy auto-placement and verifies exact facts', async () => {
  const live = runtime();
  const result = await executeJamSticky({ text: 'Decision', color: 'blue' }, {
    evaluate: evaluate(live.figma),
  });
  assert.equal(result.result.status, 'created');
  assert.equal(result.result.outcome, 'verified');
  assert.equal(result.result.actual.node.text, 'Decision');
  assert.equal(result.result.actual.node.color, '#A6D8FF');
  assert.equal(result.result.actual.node.x, 310);
  assert.equal(result.result.actual.node.y, -10);
  assert.equal(result.stdout, '✓ Sticky 9:1 at 310,-10');
  assert.deepEqual(live.page.selection.map((node) => node.id), ['9:1']);
  assert.equal(live.fontLoads(), 2);
  assert.deepEqual(live.page.children.at(-1).fills, [{
    type: 'SOLID', color: { r: 166 / 255, g: 216 / 255, b: 255 / 255 },
  }]);
});

test('explicit placement wins and unknown color retains the native default fill', async () => {
  const live = runtime();
  const result = await executeJamSticky({
    text: 'Placed', color: 'chartreuse', at: '-12.5,30',
  }, { evaluate: evaluate(live.figma) });
  assert.equal(result.result.actual.node.x, -12.5);
  assert.equal(result.result.actual.node.y, 30);
  assert.equal(result.result.actual.node.color, null);
  assert.deepEqual(live.page.children.at(-1).fills, [{
    type: 'SOLID', color: { r: 1, g: 1, b: 0 },
  }]);
});

test('acknowledgement errors require exact fresh readback', async () => {
  const live = runtime({ throwAfter: true });
  const result = await executeJamSticky({ text: 'Ack', x: 10, y: 20 }, {
    evaluate: evaluate(live.figma),
  });
  assert.equal(result.result.outcome, 'verified-after-error');
  assert.match(result.stderr, /fresh FigJam readback/);
});

test('postcondition mismatch rolls back node and selection while residue remains explicit', async () => {
  const rollback = runtime({ wrongPosition: true });
  await assert.rejects(() => executeJamSticky({ text: 'Rollback' }, {
    evaluate: evaluate(rollback.figma),
  }), (error) => error.mutationOutcome === 'rolled-back'
    && error.mutationReport.restored === 1);
  assert.deepEqual(rollback.page.children.map((node) => node.id), ['1:1', '1:2']);
  assert.deepEqual(rollback.page.selection.map((node) => node.id), ['1:1']);

  const residue = runtime({ wrongPosition: true, removeNoEffect: true });
  await assert.rejects(() => executeJamSticky({ text: 'Residue' }, {
    evaluate: evaluate(residue.figma),
  }), (error) => error.mutationOutcome === 'partial-residue'
    && error.mutationReport.residueCount > 0);
});

test('a page switch during font loading cannot redirect selection writes', async () => {
  const live = runtime({ switchPageDuringFontLoad: true });
  await assert.rejects(() => executeJamSticky({ text: 'Bound page' }, {
    evaluate: evaluate(live.figma),
  }), (error) => error.mutationOutcome === 'rolled-back');
  assert.deepEqual(live.page.children.map((node) => node.id), ['1:1', '1:2']);
  assert.deepEqual(live.page.selection.map((node) => node.id), ['1:1']);
  assert.deepEqual(live.otherPage.selection, []);
});

test('wrong editor refuses and unattributed factory failure stays verification-unavailable', async () => {
  const wrong = runtime({ editorType: 'figma' });
  await assert.rejects(() => executeJamSticky({ text: 'No' }, {
    evaluate: evaluate(wrong.figma),
  }), (error) => error.mutationOutcome === 'no-mutation');
  assert.equal(wrong.creates(), 0);

  const factory = runtime({ factoryThrows: true });
  await assert.rejects(() => executeJamSticky({ text: 'Unknown' }, {
    evaluate: evaluate(factory.figma),
  }), (error) => error.mutationOutcome === 'verification-unavailable');
});

test('an oversized preflight snapshot refuses before creating a Sticky', async () => {
  const live = runtime();
  live.page.children = Array.from({ length: 700 }, (_, index) => ({
    id: `2:${String(index).padStart(4, '0')}${'9'.repeat(495)}`,
  }));
  await assert.rejects(() => executeJamSticky({ text: 'Bounded', x: 0, y: 0 }, {
    evaluate: evaluate(live.figma),
  }), (error) => error.mutationOutcome === 'no-mutation'
    && /preflight snapshot exceeded/.test(error.message));
  assert.equal(live.creates(), 0);
});

test('one non-retrying Jam Sticky Plan owns identical CLI and MCP policy', async () => {
  const cli = planFigmaCommand([
    'jam', 'sticky', '--color=red', '--at=-10,20', '--', '- Decision',
  ], { adapter: 'cli' });
  const mcp = planFigmaCommand([
    'jam', 'sticky', '--at', '-10,20', '--color', '#FF9B9B', '--', '- Decision',
  ], { adapter: 'mcp' });
  assert.equal(cli.allowed, true);
  assert.deepEqual(cli.argv, mcp.argv);
  assert.deepEqual(cli.effects, mcp.effects);
  assert.deepEqual(cli.execution, mcp.execution);
  assert.equal(cli.effects.figma, 'write');
  assert.equal(cli.effects.editor, 'write');
  assert.equal(cli.execution.retry, 'never');
  assert.equal(jamStickyPlanRoute(cli), 'command-application');
  const live = runtime();
  assert.equal((await executeJamStickyPlan(cli, {
    evaluate: evaluate(live.figma),
  })).result.status, 'created');
});

test('malformed and forged Plugin results cannot become successful Jam Stickies', async () => {
  for (const value of [null, {}, 'not-json', JSON.stringify({ status: 'created' })]) {
    await assert.rejects(() => executeJamSticky({ text: 'Safe' }, {
      evaluate: async () => value,
    }), /invalid/i);
  }
  const live = runtime();
  const serialized = await evaluate(live.figma)(jamStickyCode({ text: 'Safe' }));
  const forged = JSON.parse(serialized);
  forged.actual.node.text = 'Forged';
  await assert.rejects(() => executeJamSticky({ text: 'Safe' }, {
    evaluate: async () => JSON.stringify(forged),
  }), /invalid bounded result/);
});

test('Jam Sticky generated Plugin code parses with hostile text inert', () => {
  const code = jamStickyCode({ text: '`; figma.currentPage.remove(); //', color: 'red' });
  assert.doesNotThrow(() => new Function(`return ${code}`));
  assert.ok(code.includes(JSON.stringify('`; figma.currentPage.remove(); //')));
});
