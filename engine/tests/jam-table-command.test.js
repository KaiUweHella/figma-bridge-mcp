import assert from 'node:assert/strict';
import test from 'node:test';
import { planFigmaCommand } from '../../src/capability-catalog.js';
import {
  executeJamTable,
  executeJamTablePlan,
  jamTableCode,
  jamTablePlanRoute,
} from '../src/application/jam-table-command.js';
import {
  acceptsJamTableArgv,
  jamTableArgvFromRequest,
  parseJamTableRequest,
} from '../src/application/jam-table-request.js';

function runtime({
  editorType = 'figjam', wrongCell = false, wrongDimensions = false,
  removeNoEffect = false, throwAfterSelection = false, factoryThrows = false,
  switchPageDuringFontLoad = false,
} = {}) {
  const registry = new Map();
  let selection = [];
  const page = {
    id: '0:1', type: 'PAGE', children: [],
    get selection() { return selection; },
    set selection(value) {
      selection = value;
      if (throwAfterSelection && value[0]?.type === 'TABLE') {
        throw new Error('injected acknowledgement');
      }
    },
  };
  const existing = {
    id: '1:1', type: 'STICKY', parent: page, x: 10, y: 20, width: 100, height: 80,
  };
  page.children.push(existing);
  page.selection = [existing];
  const otherPage = { id: '0:2', type: 'PAGE', children: [], selection: [] };
  for (const node of [page, otherPage, existing]) registry.set(node.id, node);
  let creates = 0;
  let fontLoads = 0;
  const figma = {
    editorType, currentPage: page, mixed: Symbol('mixed'),
    async loadFontAsync() {
      fontLoads += 1;
      if (switchPageDuringFontLoad) this.currentPage = otherPage;
    },
    async getNodeByIdAsync(id) { return registry.get(id) || null; },
    createTable(rows, columns) {
      creates += 1;
      const actualRows = wrongDimensions ? rows + 1 : rows;
      const table = {
        id: `9:${creates}`, type: 'TABLE', parent: page, x: 0, y: 0,
        numRows: actualRows, numColumns: columns,
        cellAt(row, column) { return cells[row][column]; },
        remove() {
          if (removeNoEffect) return;
          const index = page.children.indexOf(this);
          if (index !== -1) page.children.splice(index, 1);
          registry.delete(this.id); this.parent = null;
        },
      };
      const cells = Array.from({ length: actualRows }, (_, row) => (
        Array.from({ length: columns }, (_, column) => {
          let characters = '';
          const text = {
            fontName: { family: 'Inter', style: 'Medium' },
            get characters() { return characters; },
            set characters(value) {
              characters = wrongCell ? `${value}!` : value;
            },
          };
          return { type: 'TABLE_CELL', rowIndex: row, columnIndex: column, parent: table, text };
        })
      ));
      page.children.push(table); registry.set(table.id, table);
      if (factoryThrows) throw new Error('injected factory failure');
      return table;
    },
  };
  return {
    figma, page, otherPage, existing,
    creates: () => creates, fontLoads: () => fontLoads,
  };
}

const evaluate = (figma) => async (code) => new Function('figma', `return ${code};`)(figma);

test('Jam Table closes dimensions, data coercion, placement, and excess input', () => {
  assert.deepEqual(parseJamTableRequest([
    'jam', 'table', '2rest', '3', '--data=[[1,null,true],"ignored",[9]]', '--at=10,-20',
  ]), {
    rows: 2, columns: 3, data: [['1', '', 'true'], []], x: 10, y: -20,
  });
  assert.deepEqual(parseJamTableRequest([
    'jam', 'table', '--data=', '--at=bad', '--', '-2', '0',
  ]), { rows: 1, columns: 1, data: [], x: null, y: null });
  assert.deepEqual(jamTableArgvFromRequest({
    rows: 2, cols: 2, data: [[{ label: 'x' }, ['a', 'b']]], x: 5, y: 6,
  }), [
    'jam', 'table', '2', '2', '--data=[["[object Object]","a,b"]]', '--at=5,6',
  ]);
  for (const value of [
    ['jam', 'table'],
    ['jam', 'table', '2'],
    ['jam', 'table', '2', '3', '4'],
    ['jam', 'table', '1000', '1000'],
    ['jam', 'table', '1001', '1'],
    ['jam', 'table', '2', '2', '--data={}'],
    ['jam', 'table', '2', '2', '--data'],
    ['jam', 'table', '2', '2', '--future'],
    ['jam', 'table', '2', '2', '--at=1,2', '--at=3,4'],
  ]) assert.equal(acceptsJamTableArgv(value), false, value.join(' '));
});

test('Jam Table creates and freshly verifies exact native cells, placement, and selection', async () => {
  const live = runtime();
  const result = await executeJamTable({
    rows: 2, columns: 3, data: [['A', 1], ['B', null, true]],
  }, { evaluate: evaluate(live.figma) });
  assert.equal(result.result.outcome, 'verified');
  assert.deepEqual(result.result.actual.node.data, [
    ['A', '1', ''], ['B', '', 'true'],
  ]);
  assert.equal(result.result.actual.node.x, 190);
  assert.equal(result.result.actual.node.y, 20);
  assert.equal(result.stdout, '✓ Table 9:1 (2×3)');
  assert.deepEqual(live.page.selection.map((node) => node.id), ['9:1']);
  assert.equal(live.fontLoads(), 2);
});

test('selection acknowledgement errors require exact fresh Table readback', async () => {
  const live = runtime({ throwAfterSelection: true });
  const result = await executeJamTable({ rows: 1, columns: 1, data: [['Ack']] }, {
    evaluate: evaluate(live.figma),
  });
  assert.equal(result.result.outcome, 'verified-after-error');
  assert.match(result.stderr, /fresh FigJam readback/);
});

test('cell mismatch rolls back the Table or reports exact residue', async () => {
  const rollback = runtime({ wrongCell: true });
  await assert.rejects(() => executeJamTable({ rows: 1, columns: 1, data: [['A']] }, {
    evaluate: evaluate(rollback.figma),
  }), (error) => error.mutationOutcome === 'rolled-back');
  assert.deepEqual(rollback.page.children.map((node) => node.id), ['1:1']);
  assert.deepEqual(rollback.page.selection.map((node) => node.id), ['1:1']);

  const residue = runtime({ wrongCell: true, removeNoEffect: true });
  await assert.rejects(() => executeJamTable({ rows: 1, columns: 1, data: [['A']] }, {
    evaluate: evaluate(residue.figma),
  }), (error) => error.mutationOutcome === 'partial-residue'
    && error.mutationReport.residueCount > 0);
});

test('page switches, dimension drift, and factory failures stay explicit', async () => {
  const switched = runtime({ switchPageDuringFontLoad: true });
  await assert.rejects(() => executeJamTable({
    rows: 1, columns: 1, data: [['A']],
  }, { evaluate: evaluate(switched.figma) }), (error) => error.mutationOutcome === 'rolled-back');
  assert.deepEqual(switched.page.children.map((node) => node.id), ['1:1']);
  assert.deepEqual(switched.otherPage.children, []);

  const drift = runtime({ wrongDimensions: true });
  await assert.rejects(() => executeJamTable({ rows: 1, columns: 1 }, {
    evaluate: evaluate(drift.figma),
  }), (error) => error.mutationOutcome === 'rolled-back');

  const factory = runtime({ factoryThrows: true });
  await assert.rejects(() => executeJamTable({ rows: 1, columns: 1 }, {
    evaluate: evaluate(factory.figma),
  }), (error) => error.mutationOutcome === 'verification-unavailable');
});

test('wrong editor and oversized snapshots refuse before Table creation', async () => {
  const wrong = runtime({ editorType: 'figma' });
  await assert.rejects(() => executeJamTable({ rows: 1, columns: 1 }, {
    evaluate: evaluate(wrong.figma),
  }), (error) => error.mutationOutcome === 'no-mutation');
  assert.equal(wrong.creates(), 0);

  const oversized = runtime();
  oversized.page.children = [oversized.existing,
    ...Array.from({ length: 1_500 }, (_, index) => ({
      id: `2:${String(index).padStart(4, '0')}${'9'.repeat(495)}`,
      x: index, y: 0, width: 10, height: 10, parent: oversized.page,
    }))];
  await assert.rejects(() => executeJamTable({ rows: 1, columns: 1 }, {
    evaluate: evaluate(oversized.figma),
  }), (error) => error.mutationOutcome === 'no-mutation'
    && /preflight snapshot exceeded/.test(error.message));
  assert.equal(oversized.creates(), 0);
});

test('one non-retrying Jam Table Plan owns equivalent CLI and MCP policy', async () => {
  const cli = planFigmaCommand([
    'jam', 'table', '2rest', '2', '--data=[["A",1]]', '--at=10,-20',
  ], { adapter: 'cli' });
  const mcp = planFigmaCommand([
    'jam', 'table', '2', '2', '--at', '10,-20', '--data', '[["A","1"]]',
  ], { adapter: 'mcp' });
  assert.equal(cli.allowed, true);
  assert.deepEqual(cli.argv, mcp.argv);
  assert.deepEqual(cli.effects, mcp.effects);
  assert.deepEqual(cli.execution, mcp.execution);
  assert.equal(cli.effects.figma, 'write');
  assert.equal(cli.effects.editor, 'write');
  assert.equal(cli.execution.retry, 'never');
  assert.equal(jamTablePlanRoute(cli), 'command-application');
  const live = runtime();
  assert.equal((await executeJamTablePlan(cli, {
    evaluate: evaluate(live.figma),
  })).result.status, 'created');
});

test('malformed and forged Plugin results cannot become successful Jam Tables', async () => {
  const request = { rows: 1, columns: 1, data: [['A']] };
  for (const value of [null, {}, 'not-json', JSON.stringify({ status: 'created' })]) {
    await assert.rejects(() => executeJamTable(request, { evaluate: async () => value }), /invalid/i);
  }
  const live = runtime();
  const serialized = await evaluate(live.figma)(jamTableCode(request));
  const forged = JSON.parse(serialized);
  forged.actual.node.data[0][0] = 'forged';
  await assert.rejects(() => executeJamTable(request, {
    evaluate: async () => JSON.stringify(forged),
  }), /invalid bounded result/);
});

test('Jam Table generated Plugin code parses with hostile cell text inert', () => {
  const text = '`; figma.currentPage.remove(); //';
  const code = jamTableCode({ rows: 1, columns: 1, data: [[text]] });
  assert.doesNotThrow(() => new Function(`return ${code}`));
  assert.ok(code.includes(JSON.stringify(text)));
});
