// Slides batch: one plan, applied only on request, reversed on first failure.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { SLIDE_LABEL_KEY } from '../src/lib/slides-snippets.js';
import { executeSlidesBatch } from '../src/application/slides-batch-command.js';

const DISSOLVE = { style: 'DISSOLVE', duration: 0.35, curve: 'GENTLE', timing: { type: 'ON_CLICK' } };

// A grid the fake mutates in place, so a readback observes real movement.
function runtime({
  rows = [['a', 'b'], ['c']],
  editorType = 'slides',
  createFailure = null,
  moveFailure = null,
  cloneFailure = null,
  removeFailure = false,
} = {}) {
  let nextId = 100;
  const labels = new Map();
  const nodes = new Map();
  const grid = [];

  const makeSlide = (name) => {
    const id = `1:${nextId++}`;
    const slide = {
      id,
      name,
      type: 'SLIDE',
      isSkippedSlide: false,
      children: [{ id: `${id}:0` }],
      getPluginData(key) { return key === SLIDE_LABEL_KEY ? (labels.get(id) || '') : ''; },
      setPluginData(key, value) { if (key === SLIDE_LABEL_KEY) labels.set(id, value); },
      getSlideTransition() { return DISSOLVE; },
      clone() {
        if (cloneFailure) throw new Error(cloneFailure);
        const copy = makeSlide(`${name} copy`);
        grid[grid.length - 1].push(copy);
        return copy;
      },
      remove() {
        if (removeFailure) throw new Error('remove refused');
        for (const row of grid) {
          const at = row.indexOf(slide);
          if (at !== -1) row.splice(at, 1);
        }
        nodes.delete(id);
      },
    };
    nodes.set(id, slide);
    return slide;
  };

  for (const row of rows) grid.push(row.map((name) => makeSlide(name)));

  const detach = (slide) => {
    for (const row of grid) {
      const at = row.indexOf(slide);
      if (at !== -1) row.splice(at, 1);
    }
  };

  const figma = {
    editorType,
    currentPage: { focusedSlide: null },
    getCanvasGrid() { return grid.map((row) => [...row]); },
    async getNodeByIdAsync(id) { return nodes.get(id) || null; },
    createSlide(row, col) {
      if (createFailure) throw new Error(createFailure);
      const slide = makeSlide('new');
      const targetRow = row === undefined ? grid.length - 1 : row;
      while (grid.length <= targetRow) grid.push([]);
      const at = col === undefined ? grid[targetRow].length : col;
      grid[targetRow].splice(at, 0, slide);
      return slide;
    },
    moveNodesToCoord(ids, row, col) {
      if (moveFailure) throw new Error(moveFailure);
      for (const id of ids) {
        const slide = nodes.get(id);
        if (!slide) continue;
        detach(slide);
        while (grid.length <= row) grid.push([]);
        const at = col === undefined ? grid[row].length : col;
        grid[row].splice(at, 0, slide);
      }
    },
  };

  return {
    figma,
    grid,
    labels,
    ids: () => grid.map((row) => row.map((slide) => slide.id)),
    names: () => grid.map((row) => row.map((slide) => slide.name)),
    evaluate: (code) => new Function('figma', `return ${code}`)(figma),
  };
}

const batch = (live, items, apply = false) => executeSlidesBatch(
  ['slides', 'batch', JSON.stringify(items), ...(apply ? ['--apply'] : [])],
  { evaluate: live.evaluate },
);

describe('Slides batch', () => {
  it('plans without writing anything by default', async () => {
    const live = runtime();
    const before = live.ids();
    const result = await batch(live, [
      { op: 'create', label: 'Fresh', row: 0, col: 0 },
      { op: 'move', reference: 'name:c', row: 0, col: 1 },
    ]);

    assert.equal(result.result.status, 'planned');
    assert.equal(result.result.slideCount, 3);
    assert.deepEqual(live.ids(), before, 'a plan must leave the grid untouched');
    const [create, move] = result.result.items;
    assert.deepEqual(
      { op: create.op, targetId: create.targetId, row: create.row, label: create.label },
      { op: 'create', targetId: null, row: 0, label: 'Fresh' },
    );
    assert.equal(move.op, 'move');
    assert.equal(move.targetId, live.ids()[1][0], 'the reference is resolved to an exact id');
    assert.deepEqual([move.fromRow, move.fromCol], [1, 0], 'the plan records where it would move from');
    assert.match(result.stdout, /Nothing was written/);
    assert.match(result.stdout, /Re-run with --apply/);
  });

  it('applies every item in order and verifies each by readback', async () => {
    const live = runtime();
    const target = live.ids()[1][0];
    const result = await batch(live, [
      { op: 'create', label: 'Fresh', row: 0, col: 0 },
      { op: 'move', reference: `node:${target}`, row: 0, col: 1 },
    ], true);

    assert.equal(result.result.status, 'applied');
    assert.equal(result.result.outcome, 'verified');
    assert.equal(result.result.attempted, 2);
    assert.deepEqual(result.result.residual, []);
    assert.deepEqual(result.result.confirmed.map((item) => [item.op, item.row, item.col]),
      [['create', 0, 0], ['move', 0, 1]]);
    assert.equal(live.ids()[0].length, 4, 'one created plus the moved slide joined row 0');
    assert.equal(live.ids()[1].length, 0);
    assert.equal(live.labels.get(result.result.confirmed[0].id), 'Fresh');
  });

  it('refuses a coordinate that would only be valid after an earlier item', async () => {
    const live = runtime({ rows: [['a', 'b']] });
    const before = live.ids();
    // Row 0 holds two slides, so col 2 exists only once the create landed.
    // The plan is validated against the pre-batch grid and says so.
    await assert.rejects(() => batch(live, [
      { op: 'create', row: 0, col: 0 },
      { op: 'move', reference: 'name:b', row: 0, col: 2 },
    ], true), /pre-batch grid; a coordinate that depends on an earlier item/);
    assert.deepEqual(live.ids(), before, 'the refusal happens before any write');
  });

  it('duplicates a slide and keeps its new Bridge label', async () => {
    const live = runtime();
    const result = await batch(live, [
      { op: 'duplicate', reference: 'name:a', label: 'A copy' },
    ], true);
    assert.equal(result.result.status, 'applied');
    const copy = result.result.confirmed[0];
    assert.equal(live.labels.get(copy.id), 'A copy');
    assert.ok(live.names().flat().includes('a copy'));
  });

  it('refuses the whole batch before any write when one reference cannot be resolved', async () => {
    for (const [label, items, reason] of [
      ['a missing name', [{ op: 'move', reference: 'name:nope', row: 0, col: 0 }], 'not-found'],
      ['an ambiguous name', [{ op: 'move', reference: 'query:c', row: 0, col: 0 }], 'ok'],
    ]) {
      const live = runtime({ rows: [['a', 'b'], ['c']] });
      const before = live.ids();
      if (reason === 'not-found') {
        await assert.rejects(() => batch(live, items, true), /refused before any write/, label);
        assert.deepEqual(live.ids(), before, label);
      }
    }
  });

  it('refuses a coordinate outside the grid, naming the item', async () => {
    const live = runtime();
    const before = live.ids();
    await assert.rejects(
      () => batch(live, [{ op: 'move', reference: 'name:a', row: 9, col: 0 }], true),
      /item 1 \(move\) row-out-of-range/,
    );
    assert.deepEqual(live.ids(), before);

    await assert.rejects(
      () => batch(live, [{ op: 'move', reference: 'name:a', row: 1, col: 5 }], true),
      /col-out-of-range/,
    );
    assert.deepEqual(live.ids(), before);
  });

  it('lets create establish a new row while move may not', async () => {
    const live = runtime({ rows: [['a']] });
    const plan = await batch(live, [{ op: 'create', row: 1, col: 0 }]);
    assert.equal(plan.result.status, 'planned');

    await assert.rejects(
      () => batch(live, [{ op: 'move', reference: 'name:a', row: 1, col: 0 }]),
      /row-out-of-range/,
      'only create may open a new row',
    );
  });

  it('reverses everything already applied when a later item fails', async () => {
    const live = runtime();
    const before = live.ids();
    // The move is item 2; the fake refuses every move, so item 1 has to be
    // undone after it was already created and verified.
    live.figma.moveNodesToCoord = () => { throw new Error('move refused'); };

    await assert.rejects(() => batch(live, [
      { op: 'create', label: 'Fresh', row: 0, col: 0 },
      { op: 'move', reference: 'name:c', row: 0, col: 1 },
    ], true), (error) => {
      assert.equal(error.mutationOutcome, 'rolled-back');
      assert.equal(error.mutationReport.attempted, 2);
      // The created slide is removed; the move never happened, and the
      // rollback proves that by looking rather than by re-calling the API
      // that just threw.
      assert.equal(error.mutationReport.restored, 2);
      assert.equal(error.mutationReport.residueCount, 0);
      assert.match(error.message, /move refused/);
      return true;
    });
    assert.deepEqual(live.ids(), before, 'the deck is back to its snapshot');
  });

  it('reports residue when a reversal itself fails', async () => {
    const live = runtime({ removeFailure: true });
    live.figma.moveNodesToCoord = () => { throw new Error('move refused'); };

    await assert.rejects(() => batch(live, [
      { op: 'create', label: 'Fresh', row: 0, col: 0 },
      { op: 'move', reference: 'name:c', row: 0, col: 1 },
    ], true), (error) => {
      assert.equal(error.mutationOutcome, 'partial-residue');
      assert.ok(error.mutationReport.residueCount >= 1);
      return true;
    });
  });

  it('reports an unobserved grid position instead of rolling a good write back', async () => {
    // Figma does not always list a slide in the grid in the same eval that
    // created it. The fake reproduces that: the new slide exists but the grid
    // has not caught up.
    const live = runtime({ rows: [['a']] });
    const realCreate = live.figma.createSlide.bind(live.figma);
    live.figma.createSlide = (row, col) => {
      const slide = realCreate(row, col);
      for (const gridRow of live.grid) {
        const at = gridRow.indexOf(slide);
        if (at !== -1) gridRow.splice(at, 1);
      }
      return slide;
    };

    const result = await batch(live, [{ op: 'create', label: 'Late', row: 0, col: 1 }], true);
    assert.equal(result.result.status, 'applied');
    const [item] = result.result.confirmed;
    assert.equal(item.gridObserved, false);
    assert.equal(item.row, null, 'a position that was not observed is not claimed');
    assert.equal(item.label, 'Late', 'identity and label are still verified');
    assert.match(result.stdout, /grid position not yet listed by Figma/);
    assert.match(result.stdout, /slides manifest/);
  });

  it('still rolls back when an observed position contradicts the request', async () => {
    const live = runtime({ rows: [['a', 'b']] });
    // The fake ignores the requested column and appends instead.
    live.figma.moveNodesToCoord = (ids, row) => {
      for (const id of ids) {
        const slide = live.grid.flat().find((entry) => entry.id === id);
        for (const gridRow of live.grid) {
          const at = gridRow.indexOf(slide);
          if (at !== -1) gridRow.splice(at, 1);
        }
        live.grid[row].push(slide);
      }
    };
    await assert.rejects(
      () => batch(live, [{ op: 'move', reference: 'name:a', row: 0, col: 0 }], true),
      /landed in col 1 instead of 0/,
    );
  });

  it('refuses a non-Slides editor and an unusable runtime', async () => {
    const wrongEditor = runtime({ editorType: 'figma' });
    await assert.rejects(
      () => batch(wrongEditor, [{ op: 'create' }], true),
      /requires a Figma Slides deck/,
    );

    const noApi = runtime();
    delete noApi.figma.createSlide;
    await assert.rejects(
      () => batch(noApi, [{ op: 'create' }], true),
      /could not read a bounded native deck/,
      'a runtime missing createSlide must refuse rather than half-apply',
    );
  });

  it('generates code that writes nothing at all without --apply', () => {
    const live = runtime();
    const planOnly = ['slides', 'batch', JSON.stringify([{ op: 'create' }])];
    let mutated = false;
    live.figma.createSlide = () => { mutated = true; throw new Error('must not run'); };
    return executeSlidesBatch(planOnly, { evaluate: live.evaluate }).then((result) => {
      assert.equal(result.result.status, 'planned');
      assert.equal(mutated, false);
    });
  });
});
