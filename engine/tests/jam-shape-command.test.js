import assert from 'node:assert/strict';
import test from 'node:test';
import { planFigmaCommand } from '../../src/capability-catalog.js';
import {
  executeJamShape,
  executeJamShapePlan,
  jamShapeCode,
  jamShapePlanRoute,
} from '../src/application/jam-shape-command.js';
import {
  acceptsJamShapeArgv,
  jamShapeArgvFromRequest,
  parseJamShapeRequest,
} from '../src/application/jam-shape-request.js';

function runtime({
  editorType = 'figjam', wrongSize = false, removeNoEffect = false,
  throwAfterSelection = false, factoryThrows = false, switchPageDuringFontLoad = false,
} = {}) {
  const registry = new Map();
  let selection = [];
  const page = {
    id: '0:1', type: 'PAGE', children: [],
    get selection() { return selection; },
    set selection(value) {
      selection = value;
      if (throwAfterSelection && value[0]?.id?.startsWith('9:')) throw new Error('injected acknowledgement');
    },
  };
  const existing = [
    { id: '1:1', type: 'STICKY', x: 10, y: 40, width: 50, height: 20, parent: page },
    { id: '1:2', type: 'SHAPE_WITH_TEXT', x: 200, y: -10, width: 30, height: 40, parent: page },
  ];
  page.children.push(...existing);
  selection = [existing[0]];
  const otherPage = { id: '0:2', type: 'PAGE', children: [], selection: [] };
  registry.set(page.id, page); registry.set(otherPage.id, otherPage);
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
    createShapeWithText() {
      creates += 1;
      let x = 0; let y = 0; let width = 100; let height = 100;
      const text = { characters: '', fontName: { family: 'Inter', style: 'Medium' } };
      const node = {
        id: `9:${creates}`, type: 'SHAPE_WITH_TEXT', parent: page,
        shapeType: 'ROUNDED_RECTANGLE', text,
        get x() { return x; }, set x(value) { x = value; },
        get y() { return y; }, set y(value) { y = value; },
        get width() { return width; }, get height() { return height; },
        resize(nextWidth, nextHeight) {
          width = wrongSize ? nextWidth + 1 : nextWidth;
          height = nextHeight;
        },
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
  return { figma, page, otherPage, creates: () => creates, fontLoads: () => fontLoads };
}

const evaluate = (figma) => async (code) => new Function('figma', `return ${code};`)(figma);

test('Jam Shape closes and canonicalizes legacy type, size, and placement semantics', () => {
  assert.deepEqual(parseJamShapeRequest([
    'jam', 'shape', 'Decision', '--type=diamond', '--size=120px,bad', '--at=10px,-20rest',
  ]), {
    text: 'Decision', type: 'DIAMOND', width: 120, height: 140, x: 10, y: -20,
  });
  assert.deepEqual(jamShapeArgvFromRequest({
    text: '- Decision', type: 'ellipse', width: 80, height: 60, x: 0, y: 10,
  }), ['jam', 'shape', '--type=ELLIPSE', '--size=80,60', '--at=0,10', '--', '- Decision']);
  for (const argv of [
    ['jam', 'shape'],
    ['jam', 'shape', 'one', 'two'],
    ['jam', 'shape', 'one', '--type=STAR'],
    ['jam', 'shape', 'one', '--size=-1,20'],
    ['jam', 'shape', 'one', '--type'],
    ['jam', 'shape', 'one', '--future'],
    ['jam', 'shape', 'one', '--size=10,20', '--size=20,30'],
  ]) assert.equal(acceptsJamShapeArgv(argv), false, argv.join(' '));
});

test('Jam Shape creates and freshly verifies exact native Shape facts', async () => {
  const live = runtime();
  const result = await executeJamShape({
    text: 'Decision', type: 'DIAMOND', width: 120, height: 80,
  }, { evaluate: evaluate(live.figma) });
  assert.equal(result.result.outcome, 'verified');
  assert.equal(result.result.actual.node.shapeType, 'DIAMOND');
  assert.equal(result.result.actual.node.text, 'Decision');
  assert.equal(result.result.actual.node.x, 310);
  assert.equal(result.result.actual.node.y, -10);
  assert.equal(result.result.actual.node.width, 120);
  assert.equal(result.result.actual.node.height, 80);
  assert.equal(result.stdout, '✓ Shape 9:1');
  assert.deepEqual(live.page.selection.map((node) => node.id), ['9:1']);
  assert.equal(live.fontLoads(), 2);
});

test('acknowledgement errors require exact fresh Shape readback', async () => {
  const live = runtime({ throwAfterSelection: true });
  const result = await executeJamShape({ text: 'Ack', x: 10, y: 20 }, {
    evaluate: evaluate(live.figma),
  });
  assert.equal(result.result.outcome, 'verified-after-error');
  assert.match(result.stderr, /fresh FigJam readback/);
});

test('postcondition mismatch rolls back the Shape and selection or reports residue', async () => {
  const rollback = runtime({ wrongSize: true });
  await assert.rejects(() => executeJamShape({ text: 'Rollback' }, {
    evaluate: evaluate(rollback.figma),
  }), (error) => error.mutationOutcome === 'rolled-back');
  assert.deepEqual(rollback.page.children.map((node) => node.id), ['1:1', '1:2']);
  assert.deepEqual(rollback.page.selection.map((node) => node.id), ['1:1']);

  const residue = runtime({ wrongSize: true, removeNoEffect: true });
  await assert.rejects(() => executeJamShape({ text: 'Residue' }, {
    evaluate: evaluate(residue.figma),
  }), (error) => error.mutationOutcome === 'partial-residue'
    && error.mutationReport.residueCount > 0);
});

test('page switching cannot redirect selection and unattributed factories stay explicit', async () => {
  const switched = runtime({ switchPageDuringFontLoad: true });
  await assert.rejects(() => executeJamShape({ text: 'Bound page' }, {
    evaluate: evaluate(switched.figma),
  }), (error) => error.mutationOutcome === 'rolled-back');
  assert.deepEqual(switched.page.children.map((node) => node.id), ['1:1', '1:2']);
  assert.deepEqual(switched.page.selection.map((node) => node.id), ['1:1']);
  assert.deepEqual(switched.otherPage.selection, []);

  const factory = runtime({ factoryThrows: true });
  await assert.rejects(() => executeJamShape({ text: 'Unknown' }, {
    evaluate: evaluate(factory.figma),
  }), (error) => error.mutationOutcome === 'verification-unavailable');
});

test('wrong editor and oversized snapshots refuse before Shape creation', async () => {
  const wrong = runtime({ editorType: 'figma' });
  await assert.rejects(() => executeJamShape({ text: 'No' }, {
    evaluate: evaluate(wrong.figma),
  }), (error) => error.mutationOutcome === 'no-mutation');
  assert.equal(wrong.creates(), 0);

  const oversized = runtime();
  oversized.page.children = Array.from({ length: 700 }, (_, index) => ({
    id: `2:${String(index).padStart(4, '0')}${'9'.repeat(495)}`,
  }));
  await assert.rejects(() => executeJamShape({ text: 'Bounded', x: 0, y: 0 }, {
    evaluate: evaluate(oversized.figma),
  }), (error) => error.mutationOutcome === 'no-mutation'
    && /preflight snapshot exceeded/.test(error.message));
  assert.equal(oversized.creates(), 0);
});

test('one non-retrying Jam Shape Plan owns identical CLI and MCP policy', async () => {
  const cli = planFigmaCommand([
    'jam', 'shape', '--type=diamond', '--size=120,80', '--', '- Decision',
  ], { adapter: 'cli' });
  const mcp = planFigmaCommand([
    'jam', 'shape', '--size', '120,80', '--type', 'DIAMOND', '--', '- Decision',
  ], { adapter: 'mcp' });
  assert.equal(cli.allowed, true);
  assert.deepEqual(cli.argv, mcp.argv);
  assert.deepEqual(cli.effects, mcp.effects);
  assert.deepEqual(cli.execution, mcp.execution);
  assert.equal(cli.effects.figma, 'write');
  assert.equal(cli.effects.editor, 'write');
  assert.equal(cli.execution.retry, 'never');
  assert.equal(jamShapePlanRoute(cli), 'command-application');
  const live = runtime();
  assert.equal((await executeJamShapePlan(cli, {
    evaluate: evaluate(live.figma),
  })).result.status, 'created');
});

test('malformed and forged Plugin results cannot become successful Jam Shapes', async () => {
  for (const value of [null, {}, 'not-json', JSON.stringify({ status: 'created' })]) {
    await assert.rejects(() => executeJamShape({ text: 'Safe' }, {
      evaluate: async () => value,
    }), /invalid/i);
  }
  const live = runtime();
  const serialized = await evaluate(live.figma)(jamShapeCode({ text: 'Safe' }));
  const forged = JSON.parse(serialized);
  forged.actual.node.width += 8;
  await assert.rejects(() => executeJamShape({ text: 'Safe' }, {
    evaluate: async () => JSON.stringify(forged),
  }), /invalid bounded result/);
});

test('Jam Shape generated Plugin code parses with hostile text inert', () => {
  const text = '`; figma.currentPage.remove(); //';
  const code = jamShapeCode({ text });
  assert.doesNotThrow(() => new Function(`return ${code}`));
  assert.ok(code.includes(JSON.stringify(text)));
});
